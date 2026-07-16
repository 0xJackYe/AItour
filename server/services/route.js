import { getGoogleApiKey, googleJsonRequest } from './google.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

function asWaypoint([lat, lng]) {
  return { location: { latLng: { latitude: lat, longitude: lng } } };
}

function decodePolyline(encoded) {
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
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
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

export async function getRouteGeometry(points) {
  if (!Array.isArray(points) || points.length < 2) return null;

  try {
    const data = await googleJsonRequest(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getGoogleApiKey(),
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: asWaypoint(points[0]),
        destination: asWaypoint(points[points.length - 1]),
        intermediates: points.slice(1, -1).map(asWaypoint),
        travelMode: 'WALK',
        computeAlternativeRoutes: false,
        // 地图总览只需要 Google 的简化折线。HIGH_QUALITY 会返回上千个点，
        // 浏览器缩放时需要逐帧重新投影，明显增加主线程和 GPU 压力。
        polylineQuality: 'OVERVIEW',
        polylineEncoding: 'ENCODED_POLYLINE',
        languageCode: 'zh-CN',
        units: 'METRIC',
      }),
    });
    const route = data.routes?.[0];
    if (!route?.polyline?.encodedPolyline) return null;
    return {
      provider: 'google',
      travel_mode: 'WALK',
      distance_meters: route.distanceMeters ?? null,
      duration_seconds: parseDuration(route.duration),
      coordinates: decodePolyline(route.polyline.encodedPolyline),
    };
  } catch (error) {
    console.warn(`[Route] Google Routes 失败，使用直线兜底: ${error.message}`);
    return null;
  }
}
