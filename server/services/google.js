// Google Maps Platform 服务端客户端：Places (New)、Geocoding、Routes。
//
// 可靠性设计：
//  - 每次调用有超时；429 / 5xx / OVER_QUERY_LIMIT / 网络错误自动退避重试；
//  - 全局并发闸门保护 QPS 配额，长行程不会瞬间打出上百个并发请求；
//  - TTL 缓存 + single-flight：相同城市、地点、路线在请求之间复用；
//  - 共享的缓存请求不绑定单个用户请求的取消信号，避免一个用户取消
//    影响到正在等待同一结果的其他用户（单次调用仍受超时约束）。

import { getConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { createDeadline, createLimiter, parseRetryAfter, throwIfAborted, withRetry } from '../lib/async.js';
import { TtlCache } from '../lib/cache.js';
import { currentSignal, recordStat } from '../lib/context.js';
import { log } from '../lib/log.js';

export const PLACES_BASE = 'https://places.googleapis.com/v1';
export const GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

let cache = null;
let limiter = null;

function getCache() {
  if (!cache) {
    const cfg = getConfig().google;
    cache = new TtlCache({ max: cfg.cacheMaxEntries, ttlMs: cfg.cacheTtlMs });
  }
  return cache;
}

function limit(task) {
  limiter ||= createLimiter(getConfig().google.maxConcurrency);
  return limiter(task);
}

/** 测试用：清空缓存与并发闸门。 */
export function resetGoogleClient() {
  cache = null;
  limiter = null;
}

export function googleCacheStats() {
  const current = getCache();
  return { size: current.size, hits: current.hits, misses: current.misses };
}

export function isGoogleConfigured() {
  return Boolean(getConfig().google.apiKey);
}

export function getGoogleApiKey() {
  const key = getConfig().google.apiKey;
  if (!key) throw new AppError('MAPS_NOT_CONFIGURED', '未配置 GOOGLE_MAPS_API_KEY', { status: 503 });
  return key;
}

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function googleHttpError(response, data) {
  const status = response.status;
  const message = data?.error?.message || `Google Maps API 请求失败 (${status})`;
  return new AppError(status === 403 || status === 401 ? 'MAPS_REQUEST_DENIED' : 'MAPS_ERROR', message, {
    status: 502,
    retryable: RETRYABLE_HTTP.has(status),
    retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
  });
}

/** 单次 Google JSON 请求：超时 + 可重试错误退避重试 + 全局并发闸门。 */
export async function googleJsonRequest(url, { method = 'GET', headers, body, timeoutMs, validate, retries = 2 } = {}) {
  const cfg = getConfig().google;
  return withRetry(() => limit(async () => {
    recordStat('google_calls');
    const deadline = createDeadline({
      timeoutMs: timeoutMs ?? cfg.timeoutMs,
      onTimeout: () => new AppError('MAPS_TIMEOUT', 'Google Maps API 请求超时', { status: 504, retryable: true }),
    });
    try {
      let response;
      try {
        response = await fetch(url, { method, headers, body, signal: deadline.signal });
      } catch (error) {
        if (deadline.signal.aborted && deadline.signal.reason instanceof Error) throw deadline.signal.reason;
        throw new AppError('MAPS_UNAVAILABLE', `Google Maps 网络错误: ${error?.cause?.code || error?.message}`, {
          status: 502,
          retryable: true,
          cause: error,
        });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.error) throw googleHttpError(response, data);
      validate?.(data);
      return data;
    } finally {
      deadline.dispose();
    }
  }), {
    retries,
    baseDelayMs: 300,
    maxDelayMs: 3000,
    onRetry: (error, attempt, delay) => log.warn('google.retry', { attempt, delay_ms: Math.round(delay), code: error.code, message: error.message }),
  });
}

async function cached(key, producer) {
  throwIfAborted(currentSignal());
  recordStat('google_requests');
  return getCache().wrap(key, producer, { ttlMs: getConfig().google.cacheTtlMs });
}

function validateGeocodingStatus(data) {
  if (data.status === 'OK' || data.status === 'ZERO_RESULTS') return;
  const retryable = data.status === 'OVER_QUERY_LIMIT' || data.status === 'UNKNOWN_ERROR';
  throw new AppError(
    data.status === 'REQUEST_DENIED' ? 'MAPS_REQUEST_DENIED' : 'MAPS_ERROR',
    data.error_message || `Google Geocoding 返回 ${data.status}`,
    { status: 502, retryable },
  );
}

export async function geocodeAddress(address, languageCode = 'zh-CN') {
  const key = getGoogleApiKey();
  return cached(`geocode|${languageCode}|${address}`, async () => {
    const url = new URL(GEOCODING_URL);
    url.searchParams.set('address', address);
    url.searchParams.set('language', languageCode);
    url.searchParams.set('key', key);
    const data = await googleJsonRequest(url, { validate: validateGeocodingStatus });
    return data.status === 'ZERO_RESULTS' ? [] : data.results || [];
  });
}

const PLACE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.viewport',
  'places.addressComponents',
  'places.types',
  'places.googleMapsUri',
].join(',');

export async function searchPlacesText(textQuery, {
  locationBias = null,
  locationRestriction = null,
  pageSize = 5,
  regionCode = null,
  languageCode = 'zh-CN',
} = {}) {
  const key = getGoogleApiKey();
  const body = { textQuery, pageSize, languageCode };
  // locationBias 只是排序偏好；需要阻止跨城同名地点时使用 locationRestriction。
  if (locationRestriction) body.locationRestriction = { rectangle: locationRestriction };
  else if (locationBias) body.locationBias = locationBias.circle ? { circle: locationBias.circle } : { rectangle: locationBias };
  if (regionCode) body.regionCode = regionCode;

  return cached(`places|${JSON.stringify(body)}`, async () => {
    const data = await googleJsonRequest(`${PLACES_BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACE_FIELDS,
      },
      body: JSON.stringify(body),
    });
    return data.places || [];
  });
}

export async function searchNearbyTransit(center, radius = 1500, maxResultCount = 3) {
  const key = getGoogleApiKey();
  const body = {
    includedTypes: ['subway_station', 'train_station', 'transit_station', 'light_rail_station', 'bus_station'],
    maxResultCount,
    rankPreference: 'DISTANCE',
    locationRestriction: {
      circle: {
        center: { latitude: Number(center.lat.toFixed(5)), longitude: Number(center.lng.toFixed(5)) },
        radius,
      },
    },
    languageCode: 'zh-CN',
  };
  return cached(`nearby|${JSON.stringify(body)}`, async () => {
    const data = await googleJsonRequest(`${PLACES_BASE}/places:searchNearby`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.types',
          'places.googleMapsUri',
        ].join(','),
      },
      body: JSON.stringify(body),
    });
    return data.places || [];
  });
}

/** Routes API computeRoutes（单段，起点 → 终点）。无可用路线时返回 null。 */
export async function computeRoute(body, fieldMask) {
  const key = getGoogleApiKey();
  const cacheKey = `route|${body.travelMode}|${JSON.stringify(body.origin)}|${JSON.stringify(body.destination)}`;
  return cached(cacheKey, async () => {
    const data = await googleJsonRequest(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    return data.routes?.[0] || null;
  });
}

export function placeToCoordinates(place) {
  if (!place?.location) return null;
  return {
    lat: place.location.latitude,
    lng: place.location.longitude,
    display_name: place.formattedAddress || place.displayName?.text || '',
    place_id: place.id || null,
    google_maps_uri: place.googleMapsUri || null,
  };
}
