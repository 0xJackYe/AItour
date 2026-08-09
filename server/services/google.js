const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

export function getGoogleApiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('未配置 GOOGLE_MAPS_API_KEY');
  return key;
}

function transientHttpStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function transientNetworkError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TypeError') return true;
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR_)/.test(code)
    || /fetch failed|network|socket|timed? ?out/i.test(String(error?.message || ''));
}

function wait(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function googleJsonRequest(url, options = {}) {
  const {
    timeoutMs = 15000,
    maxAttempts = 2,
    retryDelayMs = 100,
    ...fetchOptions
  } = options;
  const attempts = Math.max(1, Math.min(2, Number(maxAttempts) || 2));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Each attempt owns its controller/timer; a timed-out signal is never reused.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      const status = Number(data.error?.code) || response.status;
      if (!response.ok || data.error) {
        const error = new Error(data.error?.message || `Google Maps API 请求失败 (${response.status})`);
        error.httpStatus = status;
        error.retryable = transientHttpStatus(status);
        throw error;
      }
      return data;
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      const retryable = error?.retryable === true || transientNetworkError(error);
      lastError = timedOut ? new Error('Google Maps API 请求超时') : error;
      if (!retryable || attempt >= attempts) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
    await wait(retryDelayMs * attempt);
  }

  throw lastError || new Error('Google Maps API 请求失败');
}

export async function geocodeAddress(address, languageCode = 'zh-CN') {
  const url = new URL(GEOCODING_BASE);
  url.searchParams.set('address', address);
  url.searchParams.set('language', languageCode);
  url.searchParams.set('key', getGoogleApiKey());

  const data = await googleJsonRequest(url);
  if (data.status === 'ZERO_RESULTS') return [];
  if (data.status !== 'OK') {
    throw new Error(data.error_message || `Google Geocoding 返回 ${data.status}`);
  }
  return data.results || [];
}

export async function searchPlacesText(textQuery, {
  locationBias = null,
  locationRestriction = null,
  pageSize = 5,
  regionCode = null,
  languageCode = 'zh-CN',
} = {}) {
  const body = {
    textQuery,
    pageSize,
    languageCode,
  };
  // locationBias 只是排序偏好，可能被查询文本覆盖；需要阻止同名地点跨城时
  // 使用 locationRestriction，让 Google 只返回城市视口内的候选。
  if (locationRestriction) body.locationRestriction = { rectangle: locationRestriction };
  else if (locationBias) body.locationBias = { rectangle: locationBias };
  if (regionCode) body.regionCode = regionCode;

  const data = await googleJsonRequest(`${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getGoogleApiKey(),
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.viewport',
        'places.addressComponents',
        'places.types',
        'places.googleMapsUri',
      ].join(','),
    },
    body: JSON.stringify(body),
  });
  return data.places || [];
}

export async function searchNearbyTransit(center, radius = 2500) {
  const data = await googleJsonRequest(`${PLACES_BASE}/places:searchNearby`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getGoogleApiKey(),
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
    body: JSON.stringify({
      includedTypes: ['transit_station', 'train_station', 'bus_station'],
      maxResultCount: 3,
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: { latitude: center.lat, longitude: center.lng },
          radius,
        },
      },
      languageCode: 'zh-CN',
    }),
  });
  return data.places || [];
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
