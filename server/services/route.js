import { getGoogleApiKey, googleJsonRequest } from './google.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const ROUTABLE_MODES = new Set(['WALK', 'TRANSIT', 'DRIVE', 'BICYCLE', 'RAIL']);
const TRANSIT_MODES = new Set(['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL']);
const ALL_TRANSIT_MODES = [...TRANSIT_MODES];
const ROUTING_PREFERENCES = new Set(['LESS_WALKING', 'FEWER_TRANSFERS']);
const TRANSIT_PAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSIT_FUTURE_WINDOW_MS = 100 * 24 * 60 * 60 * 1000;
const TRANSIT_WINDOW_SAFETY_MS = 5 * 60 * 1000;
export const GOOGLE_ROUTE_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.localizedValues',
  'routes.legs.steps.transitDetails.stopDetails',
  'routes.legs.steps.transitDetails.localizedValues',
  'routes.legs.steps.transitDetails.headsign',
  'routes.legs.steps.transitDetails.transitLine',
  'routes.legs.steps.transitDetails.stopCount',
  'routes.legs.steps.transitDetails.tripShortText',
].join(',');

function parseCoordinate(coordinate, limit) {
  if (coordinate == null || typeof coordinate === 'boolean') return null;
  if (typeof coordinate === 'string' && !coordinate.trim()) return null;
  const numeric = Number(coordinate);
  return Number.isFinite(numeric) && Math.abs(numeric) <= limit ? numeric : null;
}

function coordinatesOf(value) {
  const coordinates = value?.coordinates || value;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const lat = parseCoordinate(coordinates[0], 90);
    const lng = parseCoordinate(coordinates[1], 180);
    return lat !== null && lng !== null ? { lat, lng } : null;
  }
  const lat = parseCoordinate(coordinates?.lat, 90);
  const lng = parseCoordinate(coordinates?.lng, 180);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function placeIdOf(value) {
  const placeId = value?.place_id
    || value?.placeId
    || value?.coordinates?.place_id
    || value?.coordinates?.placeId;
  return typeof placeId === 'string' && placeId.trim() ? placeId.trim() : null;
}

function routeEndpoint(value) {
  const placeId = placeIdOf(value);
  const coordinates = coordinatesOf(value);
  if (!placeId) return coordinates;
  // Keep the historical top-level lat/lng provider contract while carrying the
  // stable Places identifier through to the Google waypoint builder.
  return coordinates ? { ...coordinates, placeId } : { placeId };
}

function countryOf(value) {
  return String(value?.country || value?.countryCode || value?.coordinates?.country || '').trim().toLowerCase();
}

function isJapanEndpoint(value) {
  return ['日本', '日本国', 'japan', 'jp', 'jpn'].includes(countryOf(value));
}

function mapsDirectionsUrl(from, to) {
  const originPlaceId = placeIdOf(from);
  const destinationPlaceId = placeIdOf(to);
  const originCoordinates = coordinatesOf(from);
  const destinationCoordinates = coordinatesOf(to);
  const origin = originPlaceId
    || (originCoordinates ? `${originCoordinates.lat},${originCoordinates.lng}` : null);
  const destination = destinationPlaceId
    || (destinationCoordinates ? `${destinationCoordinates.lat},${destinationCoordinates.lng}` : null);
  if (!origin || !destination) return null;
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'transit' });
  // Maps URLs officially support the dedicated *_place_id parameters. Keep the
  // required origin/destination values as well so the URL remains portable.
  if (originPlaceId) params.set('origin_place_id', originPlaceId);
  if (destinationPlaceId) params.set('destination_place_id', destinationPlaceId);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function asWaypoint(value) {
  const placeId = placeIdOf(value);
  if (placeId) return { placeId };
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

function locationCoordinates(location) {
  const latLng = location?.latLng || location?.location?.latLng;
  const lat = parseCoordinate(latLng?.latitude, 90);
  const lng = parseCoordinate(latLng?.longitude, 180);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function decodeGeometry(encoded) {
  return typeof encoded === 'string' && encoded ? decodePolyline(encoded) : null;
}

function appendGeometry(target, points) {
  if (!Array.isArray(points)) return target;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lat = parseCoordinate(point[0], 90);
    const lng = parseCoordinate(point[1], 180);
    if (lat === null || lng === null) continue;
    const normalized = [lat, lng];
    const last = target.at(-1);
    if (!last || last[0] !== normalized[0] || last[1] !== normalized[1]) target.push(normalized);
  }
  return target;
}

function normalizedGeometry(value) {
  if (!Array.isArray(value)) return null;
  const points = appendGeometry([], value);
  return points.length >= 2 ? points : null;
}

class RouteProviderResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteProviderResponseError';
    this.code = 'ROUTE_PROVIDER_RESPONSE_INVALID';
  }
}

function invalidProviderResponse(message) {
  return new RouteProviderResponseError(message);
}

function normalizedTransitPreferences(value = {}, railOnly = false) {
  // A rail itinerary commonly needs a first/last-mile bus (for example Mishima
  // to Fujisan Station). Keeping BUS here still requires the recommended route
  // to contain rail; it avoids prematurely broadening the request to all modes.
  const rawModes = railOnly ? ['TRAIN', 'RAIL', 'BUS'] : value?.allowedModes;
  const allowedModes = [...new Set((Array.isArray(rawModes) ? rawModes : [])
    .map(item => String(item).trim().toUpperCase())
    .filter(item => TRANSIT_MODES.has(item)))];
  const routingPreference = String(value?.routingPreference || '').trim().toUpperCase();
  const result = {};
  if (allowedModes.length) result.allowedTravelModes = allowedModes;
  if (ROUTING_PREFERENCES.has(routingPreference)) result.routingPreference = routingPreference;
  return result;
}

function departureOffsetMinutes(value, parsed) {
  const source = String(value || '');
  if (/z$/i.test(source)) return 0;
  const explicit = source.match(/([+-])(\d{2}):?(\d{2})$/);
  if (explicit) {
    const minutes = Number(explicit[2]) * 60 + Number(explicit[3]);
    return explicit[1] === '-' ? -minutes : minutes;
  }
  return -parsed.getTimezoneOffset();
}

function representativeTransitDeparture(departureTime, now) {
  const parsed = new Date(departureTime);
  if (!Number.isFinite(parsed.getTime())) return null;
  const source = String(departureTime);
  const localParts = source.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  const offsetMinutes = departureOffsetMinutes(source, parsed);
  const requestedLocalDay = localParts
    ? new Date(Date.UTC(Number(localParts[1]), Number(localParts[2]) - 1, Number(localParts[3]))).getUTCDay()
    : new Date(parsed.getTime() + offsetMinutes * 60 * 1000).getUTCDay();
  const requestedHour = localParts?.[4] === undefined ? 10 : Number(localParts[4]);
  const requestedMinute = localParts?.[5] === undefined ? 0 : Number(localParts[5]);
  const representativeHour = Math.min(17, Math.max(9, requestedHour));

  // Pick the next occurrence of the same local weekday. This is close enough to
  // "now" for Google Transit's supported window while retaining weekday service
  // patterns. The returned instant is only a routing sample, never an asserted
  // service time for the user's future/past trip.
  const localNow = new Date(now + offsetMinutes * 60 * 1000);
  const candidateLocal = new Date(Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
    representativeHour, Number.isFinite(requestedMinute) ? requestedMinute : 0,
  ));
  let daysAhead = (requestedLocalDay - candidateLocal.getUTCDay() + 7) % 7;
  let candidate = candidateLocal.getTime() + daysAhead * 24 * 60 * 60 * 1000
    - offsetMinutes * 60 * 1000;
  if (candidate < now + TRANSIT_WINDOW_SAFETY_MS) candidate += 7 * 24 * 60 * 60 * 1000;
  const safeMax = now + TRANSIT_FUTURE_WINDOW_MS - TRANSIT_WINDOW_SAFETY_MS;
  return candidate <= safeMax ? new Date(candidate).toISOString() : null;
}

export function transitDepartureRequest(departureTime, now = Date.now()) {
  if (!departureTime) {
    return { departureTime: null, schedule_recheck_required: false, schedule_basis: null };
  }
  const requested = new Date(departureTime).getTime();
  if (!Number.isFinite(requested)
    || requested < now - TRANSIT_PAST_WINDOW_MS + TRANSIT_WINDOW_SAFETY_MS
    || requested > now + TRANSIT_FUTURE_WINDOW_MS - TRANSIT_WINDOW_SAFETY_MS) {
    return {
      departureTime: representativeTransitDeparture(departureTime, now),
      schedule_recheck_required: true,
      schedule_basis: 'representative',
    };
  }
  return {
    departureTime: new Date(requested).toISOString(),
    schedule_recheck_required: false,
    schedule_basis: 'requested',
  };
}

function transitLineOf(details) {
  const source = details?.transitLine || null;
  if (!source) return null;
  return {
    name: source.name || null,
    name_short: source.nameShort || null,
    color: source.color || null,
    text_color: source.textColor || null,
    uri: source.uri || null,
    icon_uri: source.iconUri || null,
    agencies: (source.agencies || []).map(agency => ({
      name: agency.name || null,
      phone_number: agency.phoneNumber || null,
      uri: agency.uri || null,
    })),
    vehicle: source.vehicle ? {
      type: source.vehicle.type || null,
      name: source.vehicle.name?.text || null,
      icon_uri: source.vehicle.iconUri || null,
      local_icon_uri: source.vehicle.localIconUri || null,
    } : null,
  };
}

function stopOf(stop) {
  if (!stop) return null;
  return { name: stop.name || null, coordinates: locationCoordinates(stop.location) };
}

function parseRouteSegments(route) {
  let sequence = 0;
  return (route.legs || []).flatMap((leg, legIndex) => (leg.steps || []).map(step => {
    const details = step.transitDetails || null;
    const line = transitLineOf(details);
    const travelMode = String(step.travelMode || (details ? 'TRANSIT' : 'UNKNOWN')).toUpperCase();
    const vehicleType = line?.vehicle?.type || (travelMode === 'TRANSIT' ? 'OTHER' : travelMode);
    const stopDetails = details?.stopDetails || {};
    const stepLocalizedValues = step.localizedValues || null;
    const transitLocalizedValues = details?.localizedValues || null;
    return {
      id: `route-segment-${++sequence}`,
      sequence: sequence - 1,
      leg_index: legIndex,
      travel_mode: travelMode,
      transit_vehicle_type: vehicleType,
      line,
      from_stop: stopOf(stopDetails.departureStop),
      to_stop: stopOf(stopDetails.arrivalStop),
      start_coordinates: locationCoordinates(step.startLocation),
      end_coordinates: locationCoordinates(step.endLocation),
      departure_time: stopDetails.departureTime || null,
      arrival_time: stopDetails.arrivalTime || null,
      localized_values: {
        step: stepLocalizedValues,
        transit: transitLocalizedValues,
      },
      localized_duration: stepLocalizedValues?.staticDuration || null,
      localized_departure_time: transitLocalizedValues?.departureTime || null,
      localized_arrival_time: transitLocalizedValues?.arrivalTime || null,
      headsign: details?.headsign || null,
      stop_count: details?.stopCount !== null && details?.stopCount !== undefined
        && Number.isFinite(Number(details.stopCount)) ? Number(details.stopCount) : null,
      trip_short_text: details?.tripShortText || null,
      distance_meters: Number.isFinite(Number(step.distanceMeters)) ? Number(step.distanceMeters) : null,
      duration_seconds: parseDuration(step.staticDuration || step.duration),
      geometry: decodeGeometry(step.polyline?.encodedPolyline),
    };
  }));
}

function segmentLabel(segment) {
  if (segment.travel_mode === 'WALK') return '步行';
  if (segment.line?.name_short || segment.line?.name) {
    return segment.line.name_short || segment.line.name;
  }
  const labels = {
    BUS: '巴士', INTERCITY_BUS: '长途巴士', SUBWAY: '地铁', METRO_RAIL: '地铁',
    TRAIN: '列车', RAIL: '铁路', HIGH_SPEED_TRAIN: '高速铁路', LONG_DISTANCE_TRAIN: '长途列车',
    COMMUTER_TRAIN: '通勤列车', LIGHT_RAIL: '轻轨', TRAM: '有轨电车', FERRY: '轮渡',
  };
  return labels[segment.transit_vehicle_type] || (segment.travel_mode === 'TRANSIT' ? '公共交通' : segment.travel_mode);
}

function routeSummary(segments, fallbackMode) {
  const transitSegments = segments.filter(segment => segment.travel_mode === 'TRANSIT');
  const significant = transitSegments.length ? transitSegments : segments;
  return significant.map(segmentLabel).filter(Boolean).filter((label, index, all) => all[index - 1] !== label).join(' → ')
    || (fallbackMode === 'RAIL' ? '铁路' : fallbackMode === 'TRANSIT' ? '公共交通' : fallbackMode);
}

function primaryVehicle(segments) {
  const candidates = segments.filter(segment => segment.travel_mode === 'TRANSIT');
  if (!candidates.length) return segments[0]?.travel_mode || null;
  return candidates.reduce((best, segment) => {
    const weight = Number(segment.duration_seconds) || Number(segment.distance_meters) || 0;
    const bestWeight = Number(best?.duration_seconds) || Number(best?.distance_meters) || -1;
    return weight > bestWeight ? segment : best;
  }, null)?.transit_vehicle_type || 'TRANSIT';
}

const RAIL_VEHICLE_TYPES = new Set([
  'TRAIN', 'RAIL', 'COMMUTER_TRAIN', 'HEAVY_RAIL', 'HIGH_SPEED_TRAIN',
  'LONG_DISTANCE_TRAIN', 'SUBWAY', 'METRO_RAIL', 'LIGHT_RAIL', 'TRAM', 'MONORAIL',
]);

function parseRouteCandidate(route, googleIndex) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw invalidProviderResponse(`Google Routes 第 ${googleIndex + 1} 个候选不是有效路线对象`);
  }
  try {
    const segments = parseRouteSegments(route);
    const geometry = normalizedGeometry(decodeGeometry(route.polyline?.encodedPolyline))
      || normalizedGeometry(segments.reduce((points, segment) => appendGeometry(points, segment.geometry), []));
    if (!geometry) {
      throw invalidProviderResponse(`Google Routes 第 ${googleIndex + 1} 个候选缺少有效几何`);
    }
    const transitSegments = segments.filter(segment => segment.travel_mode === 'TRANSIT');
    const transfers = Math.max(0, transitSegments.length - 1);
    let walkingDistanceMeters = 0;
    for (const segment of segments.filter(item => item.travel_mode === 'WALK')) {
      const distance = Number(segment.distance_meters);
      if (!Number.isFinite(distance) || distance < 0) {
        walkingDistanceMeters = Number.POSITIVE_INFINITY;
        break;
      }
      walkingDistanceMeters += distance;
    }
    const parsedDuration = parseDuration(route.duration);
    const segmentDuration = segments.reduce((sum, segment) => sum + (Number(segment.duration_seconds) || 0), 0);
    return {
      route,
      googleIndex,
      geometry,
      segments,
      transitSegments,
      transfers,
      walkingDistanceMeters,
      durationSeconds: parsedDuration ?? (segmentDuration > 0 ? segmentDuration : null),
    };
  } catch (error) {
    if (error?.code === 'ROUTE_PROVIDER_RESPONSE_INVALID') throw error;
    throw invalidProviderResponse(`Google Routes 第 ${googleIndex + 1} 个候选结构无法解析: ${error.message}`);
  }
}

function candidateMatchesMode(candidate, requestedMode, providerMode) {
  if (providerMode !== 'TRANSIT') return true;
  if (requestedMode === 'RAIL') {
    return candidate.transitSegments.some(segment =>
      RAIL_VEHICLE_TYPES.has(String(segment.transit_vehicle_type || '').toUpperCase()),
    );
  }
  return candidate.transitSegments.length > 0;
}

function compareRouteCandidates(left, right, routingPreference) {
  if (routingPreference === 'LESS_WALKING'
    && left.walkingDistanceMeters !== right.walkingDistanceMeters) {
    return left.walkingDistanceMeters - right.walkingDistanceMeters;
  }
  if (routingPreference === 'FEWER_TRANSFERS' && left.transfers !== right.transfers) {
    return left.transfers - right.transfers;
  }
  const leftDuration = left.durationSeconds ?? Number.POSITIVE_INFINITY;
  const rightDuration = right.durationSeconds ?? Number.POSITIVE_INFINITY;
  return leftDuration - rightDuration || left.googleIndex - right.googleIndex;
}

export function parseGoogleRouteResponse(data, {
  requestedMode = 'TRANSIT',
  providerMode = 'TRANSIT',
  scheduleRecheckRequired = false,
  scheduleBasis = null,
  transitPreferences = {},
} = {}) {
  // Google uses a missing/empty routes collection for a legitimate "no route"
  // result. Once a route object exists, however, a malformed shape or unusable
  // geometry is a provider-response failure and must never be treated as no-route.
  if (data?.routes === undefined || data?.routes === null) return null;
  if (!Array.isArray(data.routes)) throw invalidProviderResponse('Google Routes 响应中的 routes 不是数组');
  if (data.routes.length === 0) return null;
  const normalizedRequestedMode = String(requestedMode || '').toUpperCase();
  const normalizedProviderMode = String(providerMode || '').toUpperCase();
  const validCandidates = [];
  const invalidCandidates = [];
  // Google may return the primary route plus up to three additional routes.
  for (const [googleIndex, route] of data.routes.slice(0, 4).entries()) {
    try {
      validCandidates.push(parseRouteCandidate(route, googleIndex));
    } catch (error) {
      invalidCandidates.push(error?.code === 'ROUTE_PROVIDER_RESPONSE_INVALID'
        ? error
        : invalidProviderResponse(`Google Routes 候选无法解析: ${error.message}`));
    }
  }
  const matchingCandidates = validCandidates.filter(candidate =>
    candidateMatchesMode(candidate, normalizedRequestedMode, normalizedProviderMode),
  );
  if (!matchingCandidates.length) {
    // Valid geometry with only WALK (or BUS-only for a RAIL request) is a
    // legitimate mode mismatch/no-route, not a malformed response. If any of
    // the inspected candidates is structurally broken, retain that hard error.
    if (invalidCandidates.length) throw invalidCandidates[0];
    return null;
  }
  const routingPreference = String(transitPreferences?.routingPreference || '').trim().toUpperCase();
  matchingCandidates.sort((left, right) => compareRouteCandidates(left, right, routingPreference));
  const selected = matchingCandidates[0];
  const { route, segments, geometry, transitSegments } = selected;
  return {
    provider: 'google',
    distance_meters: route.distanceMeters ?? null,
    duration_seconds: selected.durationSeconds,
    geometry,
    segments,
    summary: routeSummary(segments, requestedMode),
    primary_vehicle: primaryVehicle(segments),
    transfers: selected.transfers,
    schedule_recheck_required: scheduleRecheckRequired,
    schedule_basis: scheduleBasis,
    provider_mode: normalizedProviderMode,
    google_route_index: selected.googleIndex,
    attribution: 'Google',
  };
}

export function buildGoogleRouteRequest({
  origin,
  destination,
  mode,
  requestedMode = mode,
  departureTime = null,
  transitPreferences = {},
}, now = Date.now()) {
  const normalizedRequestedMode = String(requestedMode || mode || '').toUpperCase();
  const providerMode = normalizedRequestedMode === 'RAIL' ? 'TRANSIT' : String(mode || '').toUpperCase();
  const body = {
    origin: asWaypoint(origin),
    destination: asWaypoint(destination),
    travelMode: providerMode,
    computeAlternativeRoutes: true,
    polylineQuality: 'HIGH_QUALITY',
    polylineEncoding: 'ENCODED_POLYLINE',
    languageCode: 'zh-CN',
    units: 'METRIC',
  };
  let scheduleRecheckRequired = false;
  let scheduleBasis = null;
  if (providerMode === 'TRANSIT') {
    const preferences = normalizedTransitPreferences(transitPreferences, normalizedRequestedMode === 'RAIL');
    if (Object.keys(preferences).length) body.transitPreferences = preferences;
    const departure = transitDepartureRequest(departureTime, now);
    if (departure.departureTime) body.departureTime = departure.departureTime;
    scheduleRecheckRequired = departure.schedule_recheck_required;
    scheduleBasis = departure.schedule_basis;
  }
  return { body, normalizedRequestedMode, providerMode, scheduleRecheckRequired, scheduleBasis };
}

export async function googleRouteProvider({
  origin,
  destination,
  mode,
  requestedMode = mode,
  departureTime = null,
  transitPreferences = {},
}) {
  const {
    body,
    normalizedRequestedMode,
    providerMode,
    scheduleRecheckRequired,
    scheduleBasis,
  } = buildGoogleRouteRequest({ origin, destination, mode, requestedMode, departureTime, transitPreferences });
  const data = await googleJsonRequest(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getGoogleApiKey(),
      'X-Goog-FieldMask': GOOGLE_ROUTE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  return parseGoogleRouteResponse(data, {
    requestedMode: normalizedRequestedMode,
    providerMode,
    scheduleRecheckRequired,
    scheduleBasis,
    transitPreferences,
  });
}

export async function getRouteForLeg(from, to, mode = 'WALK', {
  departureTime = null,
  transitPreferences = {},
  routeProvider = googleRouteProvider,
} = {}) {
  const normalizedMode = String(mode || '').toUpperCase();
  const origin = routeEndpoint(from);
  const destination = routeEndpoint(to);
  if (!origin || !destination) {
    return {
      status: 'unavailable', provider: null, mode: normalizedMode || null,
      geometry: null, distance_meters: null, duration_seconds: null,
      reason: '路段起点或终点缺少已验证坐标', error_code: 'ROUTE_COORDINATES_MISSING',
    };
  }
  if (!ROUTABLE_MODES.has(normalizedMode)) {
    if (normalizedMode === 'FLIGHT') {
      const distanceKm = haversineKm(origin, destination);
      const cruiseSpeed = 750;
      const terminalBufferSeconds = 180 * 60;
      return {
        status: 'needs_confirmation', provider: null, mode: normalizedMode,
        geometry: null,
        distance_meters: distanceKm === null ? null : Math.round(distanceKm * 1000),
        duration_seconds: distanceKm === null ? null : Math.round((distanceKm / cruiseSpeed) * 3600 + terminalBufferSeconds),
        estimated: true,
        reason: 'FLIGHT 城际段需使用航班数据源确认具体班次；当前仅保留确定性时长估算，不伪造地图路线',
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
    const providerMode = normalizedMode === 'RAIL' ? 'TRANSIT' : normalizedMode;
    const route = await routeProvider({
      origin,
      destination,
      mode: providerMode,
      requestedMode: normalizedMode,
      departureTime,
      transitPreferences: normalizedMode === 'RAIL'
        ? { ...transitPreferences, allowedModes: ['TRAIN', 'RAIL', 'BUS'] }
        : transitPreferences,
    });
    if (route === null) {
      return {
        status: 'unavailable', provider: null, mode: normalizedMode,
        geometry: null, distance_meters: null, duration_seconds: null,
        reason: '路线服务未返回可验证路线', error_code: 'ROUTE_NOT_FOUND',
      };
    }
    const geometry = route && typeof route === 'object' && !Array.isArray(route)
      ? normalizedGeometry(route.geometry)
      : null;
    if (!geometry) {
      return {
        status: 'unavailable', provider: null, mode: normalizedMode,
        geometry: null, distance_meters: null, duration_seconds: null,
        reason: '路线服务返回了无法验证的响应结构或几何', error_code: 'ROUTE_PROVIDER_RESPONSE_INVALID',
      };
    }
    return {
      status: 'available',
      provider: route.provider || 'google',
      mode: normalizedMode,
      provider_mode: route.provider_mode || providerMode,
      geometry,
      distance_meters: route.distance_meters ?? null,
      duration_seconds: route.duration_seconds ?? null,
      segments: Array.isArray(route.segments) ? route.segments : [],
      summary: route.summary || (normalizedMode === 'RAIL' ? '铁路' : normalizedMode),
      primary_vehicle: route.primary_vehicle || (normalizedMode === 'RAIL' ? 'RAIL' : normalizedMode),
      transfers: Number.isFinite(Number(route.transfers)) ? Number(route.transfers) : 0,
      schedule_recheck_required: route.schedule_recheck_required === true,
      schedule_basis: route.schedule_basis || null,
      attribution: route.attribution || null,
      reason: route.schedule_recheck_required
        ? `已按同星期白天代表性时刻获取 ${normalizedMode} 路线形态；该时刻不代表实际班次，需在临近出发时复核`
        : `已按 ${normalizedMode} 获取真实逐段路线`,
      error_code: null,
    };
  } catch (error) {
    console.warn(`[Route] ${normalizedMode} 路段计算失败: ${error.message}`);
    const responseInvalid = error?.code === 'ROUTE_PROVIDER_RESPONSE_INVALID';
    return {
      status: 'unavailable', provider: null, mode: normalizedMode,
      geometry: null, distance_meters: null, duration_seconds: null,
      reason: responseInvalid ? '路线服务返回了无法验证的响应结构或几何' : '路线服务调用失败或暂时不可用',
      error_code: responseInvalid ? 'ROUTE_PROVIDER_RESPONSE_INVALID' : 'ROUTE_PROVIDER_ERROR',
    };
  }
}

export async function getRouteForLegWithFallback(from, to, mode = 'WALK', {
  allowedModes = [],
  avoidModes = [],
  maxWalkingKm = null,
  distancePolicy = {},
  ...options
} = {}) {
  const primaryMode = String(mode || 'UNKNOWN').toUpperCase();
  const avoided = new Set((avoidModes || []).map(item => String(item).toUpperCase()));
  const candidates = [primaryMode, ...(allowedModes || []).map(item => String(item).toUpperCase())]
    .filter((candidate, index, list) => !avoided.has(candidate) && list.indexOf(candidate) === index)
    .filter(candidate => candidate === primaryMode || ROUTABLE_MODES.has(candidate));
  let primaryFailure = null;
  let hardFailure = null;
  let providerHardFailure = null;
  const transitFailures = [];

  const walkingLegLimitKm = () => {
    const hasWalkingLimit = maxWalkingKm !== null && maxWalkingKm !== undefined && maxWalkingKm !== '';
    const dailyLimit = hasWalkingLimit ? Number(maxWalkingKm) : null;
    const dailyLegLimit = Number.isFinite(dailyLimit) && dailyLimit >= 0
      ? dailyLimit === 0 ? 0 : Math.min(1.5, Math.max(0.3, dailyLimit / 3))
      : null;
    const policyLimit = Number(distancePolicy?.walkMaxKm);
    return Number.isFinite(policyLimit) && policyLimit >= 0
      ? dailyLegLimit === null ? policyLimit : Math.min(policyLimit, dailyLegLimit)
      : dailyLegLimit;
  };

  for (const candidate of candidates.length ? candidates : [primaryMode]) {
    if (candidate === 'WALK' && candidate !== primaryMode) {
      const directDistanceKm = haversineKm(from, to);
      const fallbackLegLimit = walkingLegLimitKm();
      if (fallbackLegLimit !== null && directDistanceKm !== null && directDistanceKm > fallbackLegLimit) {
        continue;
      }
    }
    const candidateOptions = candidate === 'TRANSIT' && primaryMode === 'RAIL'
      ? {
          ...options,
          transitPreferences: {
            ...(options.transitPreferences || {}),
            allowedModes: ALL_TRANSIT_MODES,
          },
        }
      : options;
    let result = await getRouteForLeg(from, to, candidate, candidateOptions);
    if (candidate === 'WALK' && result.status === 'available') {
      const limitKm = walkingLegLimitKm();
      const actualMeters = Number(result.distance_meters);
      if (limitKm !== null && (!Number.isFinite(actualMeters) || actualMeters < 0)) {
        result = {
          ...result,
          status: 'unavailable',
          geometry: null,
          segments: [],
          reason: '步行路线缺少可验证的真实距离，无法确认是否符合单段步行上限',
          error_code: 'ROUTE_PROVIDER_RESPONSE_INVALID',
        };
      } else if (limitKm !== null && actualMeters > limitKm * 1000) {
        result = {
          ...result,
          status: 'unavailable',
          geometry: null,
          segments: [],
          reason: `Google 返回的真实步行距离约 ${(actualMeters / 1000).toFixed(1)}km，超过单段步行上限 ${limitKm}km`,
          error_code: 'ROUTE_WALKING_LIMIT_EXCEEDED',
        };
      }
    }
    if (result.status !== 'unavailable') {
      if (candidate === primaryMode) return result;
      return {
        ...result,
        fallback_from_mode: primaryMode,
        reason: `${primaryMode} 路线不可用，已按允许的交通偏好改用 ${candidate}；${result.reason}`,
      };
    }
    if (['RAIL', 'TRANSIT'].includes(candidate)) transitFailures.push(result);
    primaryFailure ||= result;
    if (result.error_code !== 'ROUTE_NOT_FOUND') hardFailure ||= result;
    if (['ROUTE_PROVIDER_ERROR', 'ROUTE_PROVIDER_RESPONSE_INVALID'].includes(result.error_code)) {
      providerHardFailure ||= result;
    }
    if (result.error_code === 'ROUTE_COORDINATES_MISSING') break;
  }

  const walkingPolicyRejected = hardFailure?.error_code === 'ROUTE_WALKING_LIMIT_EXCEEDED';
  const japanFallbackMode = ['RAIL', 'TRANSIT'].includes(primaryMode)
    ? primaryMode
    : primaryMode === 'WALK' && walkingPolicyRejected ? 'TRANSIT' : null;
  if (japanFallbackMode
    && isJapanEndpoint(from) && isJapanEndpoint(to)
    && !providerHardFailure
    && (!hardFailure || walkingPolicyRejected)
    && transitFailures.length > 0
    && transitFailures.every(result => result.error_code === 'ROUTE_NOT_FOUND')) {
    const distanceKm = haversineKm(from, to);
    const railLike = japanFallbackMode === 'RAIL' || (distanceKm !== null && distanceKm > 30);
    const durationSeconds = distanceKm === null ? null : Math.round(
      (distanceKm / (railLike ? 100 : 25)) * 3600 + (railLike ? 45 : 15) * 60,
    );
    return {
      status: 'needs_confirmation',
      provider: null,
      mode: japanFallbackMode,
      geometry: null,
      segments: [],
      distance_meters: distanceKm === null ? null : Math.round(distanceKm * 1000),
      duration_seconds: durationSeconds,
      estimated: true,
      summary: '日本公共交通 · Google Maps 实时确认',
      primary_vehicle: japanFallbackMode,
      transfers: null,
      provider_limit_code: 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED',
      external_directions_url: mapsDirectionsUrl(from, to),
      reason: 'Google Routes API 当前不提供日本公共交通路线；距离与时长仅为估算，请通过 Google Maps 官方实时路线确认具体线路、换乘和班次',
      error_code: null,
      ...(primaryMode === 'WALK' ? { fallback_from_mode: 'WALK' } : {}),
    };
  }

  return providerHardFailure || hardFailure || primaryFailure || {
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
