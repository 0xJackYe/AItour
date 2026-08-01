import { getGoogleApiKey, googleJsonRequest } from './google.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const ROUTABLE_MODES = new Set(['WALK', 'TRANSIT', 'DRIVE', 'BICYCLE']);

function coordinatesOf(value) {
  const coordinates = value?.coordinates || value;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    return { lat: Number(coordinates[0]), lng: Number(coordinates[1]) };
  }
  const lat = Number(coordinates?.lat);
  const lng = Number(coordinates?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function asWaypoint(value) {
  const coordinates = coordinatesOf(value);
  if (!coordinates) return null;
  return { location: { latLng: { latitude: coordinates.lat, longitude: coordinates.lng } } };
}

function haversineKm(left, right) {
  const a = coordinatesOf(left);
  const b = coordinatesOf(right);
  if (!a || !b) return null;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(value));
}

export function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function parseDuration(duration) {
  if (!duration) return null;
  const seconds = Number(String(duration).replace(/s$/, ''));
  return Number.isFinite(seconds) ? seconds : null;
}

export async function googleRouteProvider({ origin, destination, mode, departureTime = null }) {
  const body = {
    origin: asWaypoint(origin),
    destination: asWaypoint(destination),
    travelMode: mode,
    computeAlternativeRoutes: false,
    polylineQuality: 'OVERVIEW',
    polylineEncoding: 'ENCODED_POLYLINE',
    languageCode: 'zh-CN',
    units: 'METRIC',
  };
  if (mode === 'TRANSIT' && departureTime && new Date(departureTime).getTime() > Date.now()) {
    body.departureTime = new Date(departureTime).toISOString();
  }
  const data = await googleJsonRequest(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getGoogleApiKey(),
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
  });
  const route = data.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!route || !encoded) return null;
  return {
    provider: 'google',
    distance_meters: route.distanceMeters ?? null,
    duration_seconds: parseDuration(route.duration),
    geometry: decodePolyline(encoded),
  };
}

export async function getRouteForLeg(from, to, mode = 'WALK', {
  departureTime = null,
  routeProvider = googleRouteProvider,
} = {}) {
  const normalizedMode = String(mode || '').toUpperCase();
  const origin = coordinatesOf(from);
  const destination = coordinatesOf(to);
  if (!origin || !destination) {
    return {
      status: 'unavailable', provider: null, mode: normalizedMode || null,
      geometry: null, distance_meters: null, duration_seconds: null,
      reason: '路段起点或终点缺少已验证坐标', error_code: 'ROUTE_COORDINATES_MISSING',
    };
  }
  if (!ROUTABLE_MODES.has(normalizedMode)) {
    if (normalizedMode === 'RAIL' || normalizedMode === 'FLIGHT') {
      const distanceKm = haversineKm(origin, destination);
      const cruiseSpeed = normalizedMode === 'RAIL' ? 120 : 750;
      const terminalBufferSeconds = normalizedMode === 'RAIL' ? 45 * 60 : 180 * 60;
      return {
        status: 'needs_confirmation', provider: null, mode: normalizedMode,
        geometry: null,
        distance_meters: distanceKm === null ? null : Math.round(distanceKm * 1000),
        duration_seconds: distanceKm === null ? null : Math.round((distanceKm / cruiseSpeed) * 3600 + terminalBufferSeconds),
        estimated: true,
        reason: `${normalizedMode} 城际段需确认具体班次；当前仅保留确定性时长估算，不伪造地图路线`,
        error_code: 'INTERCITY_ROUTE_CONFIRMATION_REQUIRED',
      };
    }
    return {
      status: 'unavailable', provider: null, mode: normalizedMode,
      geometry: null, distance_meters: null, duration_seconds: null,
      reason: `Google Routes 不支持直接计算 ${normalizedMode} 路段`, error_code: 'ROUTE_MODE_UNSUPPORTED',
    };
  }

  try {
    const route = await routeProvider({ origin, destination, mode: normalizedMode, departureTime });
    if (!route || !Array.isArray(route.geometry) || route.geometry.length < 2) {
      return {
        status: 'unavailable', provider: null, mode: normalizedMode,
        geometry: null, distance_meters: null, duration_seconds: null,
        reason: '路线服务未返回可验证路线', error_code: 'ROUTE_NOT_FOUND',
      };
    }
    return {
      status: 'available',
      provider: route.provider || 'google',
      mode: normalizedMode,
      geometry: route.geometry,
      distance_meters: route.distance_meters ?? null,
      duration_seconds: route.duration_seconds ?? null,
      reason: `已按 ${normalizedMode} 获取真实逐段路线`,
      error_code: null,
    };
  } catch (error) {
    console.warn(`[Route] ${normalizedMode} 路段计算失败: ${error.message}`);
    return {
      status: 'unavailable', provider: null, mode: normalizedMode,
      geometry: null, distance_meters: null, duration_seconds: null,
      reason: '路线服务暂时不可用', error_code: 'ROUTE_PROVIDER_ERROR',
    };
  }
}

export async function getRouteForLegWithFallback(from, to, mode = 'WALK', {
  allowedModes = [],
  avoidModes = [],
  maxWalkingKm = null,
  ...options
} = {}) {
  const primaryMode = String(mode || 'UNKNOWN').toUpperCase();
  const avoided = new Set((avoidModes || []).map(item => String(item).toUpperCase()));
  const candidates = [primaryMode, ...(allowedModes || []).map(item => String(item).toUpperCase())]
    .filter((candidate, index, list) => !avoided.has(candidate) && list.indexOf(candidate) === index)
    .filter(candidate => candidate === primaryMode || ROUTABLE_MODES.has(candidate));
  let primaryFailure = null;

  for (const candidate of candidates.length ? candidates : [primaryMode]) {
    if (candidate === 'WALK' && candidate !== primaryMode) {
      const directDistanceKm = haversineKm(from, to);
      const hasWalkingLimit = maxWalkingKm !== null && maxWalkingKm !== undefined && maxWalkingKm !== '';
      const dailyLimit = hasWalkingLimit ? Number(maxWalkingKm) : null;
      const fallbackLegLimit = Number.isFinite(dailyLimit) && dailyLimit >= 0
        ? Math.min(1.5, Math.max(0.3, dailyLimit / 3))
        : null;
      if (fallbackLegLimit !== null && directDistanceKm !== null && directDistanceKm > fallbackLegLimit) {
        continue;
      }
    }
    const result = await getRouteForLeg(from, to, candidate, options);
    if (result.status !== 'unavailable') {
      if (candidate === primaryMode) return result;
      return {
        ...result,
        fallback_from_mode: primaryMode,
        reason: `${primaryMode} 路线不可用，已按允许的交通偏好改用 ${candidate}；${result.reason}`,
      };
    }
    primaryFailure ||= result;
    if (result.error_code === 'ROUTE_COORDINATES_MISSING') break;
  }

  return primaryFailure || {
    status: 'unavailable', provider: null, mode: primaryMode,
    geometry: null, distance_meters: null, duration_seconds: null,
    reason: '没有符合偏好的可用交通路线', error_code: 'ROUTE_NOT_FOUND',
  };
}

// 保留旧调用契约，但失败时只返回 null，绝不返回直线伪路线。
export async function getRouteGeometry(points, mode = 'WALK', options = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const result = await getRouteForLeg(points[0], points.at(-1), mode, options);
  if (result.status !== 'available') return null;
  return {
    provider: result.provider,
    travel_mode: result.mode,
    distance_meters: result.distance_meters,
    duration_seconds: result.duration_seconds,
    coordinates: result.geometry,
  };
}
