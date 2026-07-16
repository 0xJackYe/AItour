const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODING_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

export function getGoogleApiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('未配置 GOOGLE_MAPS_API_KEY');
  return key;
}

export async function googleJsonRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const response = await fetch(url, {
      ...options,
      timeoutMs: undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const message = data.error?.message || `Google Maps API 请求失败 (${response.status})`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Google Maps API 请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
