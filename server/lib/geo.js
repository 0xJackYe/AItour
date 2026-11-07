// 地理计算工具。坐标统一接受 {lat,lng}、{latitude,longitude} 或 [lat,lng]。

export function toLatLng(value) {
  if (!value) return null;
  if (Array.isArray(value)) return { lat: Number(value[0]), lng: Number(value[1]) };
  if (value.lat !== undefined && value.lng !== undefined) return { lat: Number(value.lat), lng: Number(value.lng) };
  if (value.latitude !== undefined && value.longitude !== undefined) {
    return { lat: Number(value.latitude), lng: Number(value.longitude) };
  }
  return null;
}

export function haversineKm(a, b) {
  const p = toLatLng(a);
  const q = toLatLng(b);
  if (!p || !q) return Infinity;
  const R = 6371;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(q.lat - p.lat);
  const dLng = toRad(q.lng - p.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function viewportDiagonalKm(viewport) {
  if (!viewport?.low || !viewport?.high) return Infinity;
  return haversineKm(viewport.low, viewport.high);
}

export function isInsideViewport(location, viewport, paddingRatio = 0.03) {
  const point = toLatLng(location);
  if (!point || !viewport?.low || !viewport?.high) return false;
  const latSpan = Math.abs(viewport.high.latitude - viewport.low.latitude);
  const lngSpan = Math.abs(viewport.high.longitude - viewport.low.longitude);
  const latPadding = Math.max(latSpan * paddingRatio, 0.005);
  const lngPadding = Math.max(lngSpan * paddingRatio, 0.005);
  const minLat = viewport.low.latitude - latPadding;
  const maxLat = viewport.high.latitude + latPadding;
  const minLng = viewport.low.longitude - lngPadding;
  const maxLng = viewport.high.longitude + lngPadding;
  // 视口跨越 180° 经线时 low.longitude > high.longitude。
  const longitudeMatches = minLng <= maxLng
    ? point.lng >= minLng && point.lng <= maxLng
    : point.lng >= minLng || point.lng <= maxLng;
  return point.lat >= minLat && point.lat <= maxLat && longitudeMatches;
}

export function centroid(points) {
  const list = points.map(toLatLng).filter(Boolean);
  if (list.length === 0) return null;
  return {
    lat: list.reduce((sum, p) => sum + p.lat, 0) / list.length,
    lng: list.reduce((sum, p) => sum + p.lng, 0) / list.length,
  };
}

/** Google encoded polyline 解码，返回 [[lat,lng], ...]。 */
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

/** 编码 polyline（测试与模拟上游使用）。 */
export function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let output = '';
  const encodeValue = (value) => {
    let current = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (current >= 0x20) {
      chunk += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
      current >>= 5;
    }
    return chunk + String.fromCharCode(current + 63);
  };
  for (const point of points) {
    const { lat, lng } = toLatLng(point);
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    output += encodeValue(latE5 - lastLat) + encodeValue(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return output;
}
