const VALID_MODES = new Set([
  'WALK', 'TRANSIT', 'DRIVE', 'BICYCLE', 'RAIL', 'FLIGHT', 'TAXI', 'FERRY',
  'BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'HIGH_SPEED_RAIL', 'COACH',
]);
const MODE_ALIASES = Object.freeze({
  HIGH_SPEED_TRAIN: 'HIGH_SPEED_RAIL',
  LONG_DISTANCE_TRAIN: 'TRAIN',
  HEAVY_RAIL: 'TRAIN',
  COMMUTER_TRAIN: 'TRAIN',
  INTERCITY_BUS: 'COACH',
  TRAM: 'LIGHT_RAIL',
  METRO_RAIL: 'SUBWAY',
  OTHER: 'TRANSIT',
});

export const TRANSIT_MODE_OPTIONS = Object.freeze(['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL']);
export const DEFAULT_DISTANCE_POLICY = Object.freeze({
  walkMaxKm: 1,
  localTransitMaxKm: 30,
  flightMinKm: 800,
});

export const EMPTY_PROFILE = Object.freeze({
  days: '',
  startDate: '',
  budget: { level: '', amount: '', currency: 'CNY', basis: 'total', hardLimit: false },
  pace: '',
  transport: {
    priority: '',
    allowedModes: ['WALK', 'TRANSIT', 'RAIL'],
    avoidModes: [],
    transitPreferences: {
      allowedModes: [...TRANSIT_MODE_OPTIONS],
      routingPreference: '',
    },
    distancePolicy: { ...DEFAULT_DISTANCE_POLICY },
  },
  travelers: { adults: 1, children: 0, seniors: 0 },
  maxWalkingKm: 6,
  dailyStartTime: '09:00',
  dailyEndTime: '20:00',
  interests: [],
  accommodation: { style: 'hotel', locationPriority: 'transit' },
  dietaryNeeds: '',
  accessibilityNeeds: '',
  notes: '',
});

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

export function stableId(prefix, ...parts) {
  return `${prefix}_${hash(parts.filter(value => value !== undefined && value !== null).join('|'))}`;
}

export function cloneProfile(profile = {}) {
  const transport = profile.transport && typeof profile.transport === 'object' ? profile.transport : {};
  const transitPreferences = transport.transitPreferences && typeof transport.transitPreferences === 'object'
    ? transport.transitPreferences
    : {};
  const distancePolicy = transport.distancePolicy && typeof transport.distancePolicy === 'object'
    ? transport.distancePolicy
    : {};
  return {
    ...EMPTY_PROFILE,
    ...profile,
    budget: { ...EMPTY_PROFILE.budget, ...(profile.budget || {}) },
    transport: {
      ...EMPTY_PROFILE.transport,
      ...transport,
      allowedModes: Array.isArray(transport.allowedModes)
        ? [...transport.allowedModes]
        : [...EMPTY_PROFILE.transport.allowedModes],
      avoidModes: Array.isArray(transport.avoidModes)
        ? [...transport.avoidModes]
        : [...EMPTY_PROFILE.transport.avoidModes],
      transitPreferences: {
        ...EMPTY_PROFILE.transport.transitPreferences,
        ...transitPreferences,
        allowedModes: Array.isArray(transitPreferences.allowedModes)
          ? [...transitPreferences.allowedModes]
          : [...EMPTY_PROFILE.transport.transitPreferences.allowedModes],
      },
      distancePolicy: {
        ...EMPTY_PROFILE.transport.distancePolicy,
        ...distancePolicy,
      },
    },
    travelers: { ...EMPTY_PROFILE.travelers, ...(profile.travelers || {}) },
    accommodation: { ...EMPTY_PROFILE.accommodation, ...(profile.accommodation || {}) },
    interests: Array.isArray(profile.interests) ? [...profile.interests] : [],
  };
}

export function profileCompletion(profile = {}) {
  const checks = [
    Number(profile.days) > 0,
    Boolean(profile.budget?.level),
    Boolean(profile.pace),
    Boolean(profile.transport?.priority),
  ];
  const complete = checks.filter(Boolean).length;
  return {
    complete,
    total: checks.length,
    percentage: Math.round((complete / checks.length) * 100),
    ready: complete === checks.length,
  };
}

function finiteCoordinateValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

export function validGeometryPoint(point) {
  return Array.isArray(point)
    && point.length >= 2
    && finiteCoordinateValue(point[0])
    && finiteCoordinateValue(point[1])
    && Math.abs(Number(point[0])) <= 90
    && Math.abs(Number(point[1])) <= 180;
}

export function validCoordinates(coordinates) {
  return Boolean(
    coordinates
      && finiteCoordinateValue(coordinates.lat)
      && finiteCoordinateValue(coordinates.lng)
      && Math.abs(Number(coordinates.lat)) <= 90
      && Math.abs(Number(coordinates.lng)) <= 180,
  );
}

export function isActualIntercityTransition(stage, nextStage, connection) {
  if (String(connection?.type || '').toLowerCase() !== 'intercity') return false;
  const normalizePlace = value => String(value || '').trim().toLocaleLowerCase();
  const leftCity = normalizePlace(stage?.city);
  const rightCity = normalizePlace(nextStage?.city);
  const leftCountry = normalizePlace(stage?.country);
  const rightCountry = normalizePlace(nextStage?.country);
  const cityChanged = Boolean(leftCity && rightCity && leftCity !== rightCity);
  const countryChanged = Boolean(leftCountry && rightCountry && leftCountry !== rightCountry);
  return cityChanged || countryChanged;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const allowedOrigin = ['https://www.google.com', 'https://maps.google.com'].includes(url.origin.toLowerCase());
    const allowedPath = url.pathname === '/maps/dir/';
    const hasNoCredentials = !url.username && !url.password;
    return allowedOrigin && allowedPath && hasNoCredentials ? url.href : null;
  } catch {
    return null;
  }
}

export function externalDirectionsReference(leg) {
  if (String(leg?.status || leg?.route_status || '').toLowerCase() !== 'needs_confirmation') return null;
  if (!leg?.external_directions_url && !leg?.advisory_text && !leg?.provider_limit_code) return null;
  return {
    advisory: String(leg.advisory_text || leg.reason || '请在 Google Maps 核对实时公共交通方案。'),
    url: safeHttpUrl(leg.external_directions_url),
    providerLimitCode: leg.provider_limit_code || null,
  };
}

export function routeAdvisoryText(leg) {
  const value = leg?.advisory_text ?? leg?.connection_to_next_notes ?? null;
  return typeof value === 'string' ? value.trim() : '';
}

export function googleRouteCompliance(plan, routes = []) {
  const plannedRoutes = (plan?.daily_plans || []).flatMap(day => [
    ...(day.legs || []),
    ...(day.connection_to_next ? [day.connection_to_next] : []),
  ]);
  const googleRoutes = [...routes, ...plannedRoutes].filter(route => (
    String(route?.provider || '').toLowerCase() === 'google'
      || String(route?.attribution || '').toLowerCase().includes('google')
  ));
  const betaModes = new Set();
  googleRoutes.forEach(route => {
    const segments = Array.isArray(route.segments) && route.segments.length ? route.segments : [route];
    segments.forEach(segment => {
      const mode = String(segment.travel_mode || segment.mode || '').toUpperCase();
      if (['WALK', 'BICYCLE'].includes(mode)) betaModes.add(mode);
    });
  });
  return {
    usesGoogle: googleRoutes.length > 0,
    betaModes: [...betaModes],
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatDistance(meters) {
  const numeric = optionalNumber(meters);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)} km`;
  return `${Math.round(numeric)} m`;
}

export function formatDuration(seconds) {
  const numeric = optionalNumber(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const totalMinutes = Math.round(numeric / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}小时${minutes}分`;
  if (hours) return `${hours}小时`;
  return `${minutes}分钟`;
}

export function formatBudgetPreference(budget) {
  if (!budget) return null;
  if (typeof budget === 'string') return budget.trim() || null;
  if (typeof budget !== 'object') return String(budget);

  const levelLabels = {
    budget: '经济',
    moderate: '适中',
    luxury: '舒适 / 高端',
  };
  const basisLabels = {
    total: '全程总预算',
    daily: '全体每天',
    per_day: '全体每天',
    per_person: '每人全程',
    per_person_total: '每人全程',
    per_person_day: '每人每天',
  };
  const parts = [];
  if (budget.level) parts.push(levelLabels[budget.level] || budget.level);
  const amount = Number(budget.amount);
  if (Number.isFinite(amount) && amount > 0) {
    parts.push(`${basisLabels[budget.basis] || '预算'} ${amount.toLocaleString('zh-CN')} ${budget.currency || ''}`.trim());
  }
  return parts.join(' · ') || null;
}

export function modeLabel(mode) {
  return ({
    WALK: '步行',
    TRANSIT: '公共交通',
    DRIVE: '驾车',
    BICYCLE: '骑行',
    RAIL: '铁路',
    FLIGHT: '飞机',
    TAXI: '出租车',
    FERRY: '轮渡',
    BUS: '公交车',
    COACH: '长途巴士',
    SUBWAY: '地铁',
    TRAIN: '火车',
    LIGHT_RAIL: '轻轨',
    HIGH_SPEED_RAIL: '高速铁路',
  })[String(mode || '').toUpperCase()] || '交通待确认';
}

function normalizeMode(mode) {
  const raw = String(mode || '').toUpperCase();
  const normalized = MODE_ALIASES[raw] || raw;
  return VALID_MODES.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeNode(node, dayNumber, index) {
  const coordinates = validCoordinates(node.coordinates)
    ? { ...node.coordinates, lat: Number(node.coordinates.lat), lng: Number(node.coordinates.lng) }
    : null;
  return {
    ...node,
    id: node.id || node.node_id || node.location_id
      || stableId('node', dayNumber, node.name, node.name_en, index),
    node_id: node.node_id || node.id,
    type: node.type || 'attraction',
    name: node.name || node.label || '未命名地点',
    duration_minutes: Number(node.duration_minutes)
      || (Number(node.duration_hours) ? Math.round(Number(node.duration_hours) * 60) : null),
    start_time: node.start_time || node.startTime || null,
    end_time: node.end_time || node.endTime || null,
    locked: node.locked === true,
    coordinates,
  };
}

function normalizeGeometry(value) {
  if (!Array.isArray(value)) return null;
  const geometry = value.filter(validGeometryPoint)
    .map(([lat, lng]) => [Number(lat), Number(lng)]);
  return geometry.length >= 2 ? geometry : null;
}

function normalizeStop(stop) {
  if (!stop || typeof stop !== 'object') return null;
  const rawCoordinates = stop.coordinates || stop.location;
  const coordinates = validCoordinates(rawCoordinates)
    ? { ...rawCoordinates, lat: Number(rawCoordinates.lat), lng: Number(rawCoordinates.lng) }
    : null;
  return {
    ...stop,
    name: stop.name || stop.stop_name || stop.label || '',
    coordinates,
  };
}

function normalizeSegment(segment, legId, index, routeVerified) {
  const rawMode = segment.transit_vehicle_type || segment.mode || segment.travel_mode || 'UNKNOWN';
  const mode = normalizeMode(rawMode);
  const geometry = routeVerified ? normalizeGeometry(segment.geometry) : null;
  return {
    ...segment,
    id: segment.id || stableId('segment', legId, index, rawMode),
    sequence: optionalNumber(segment.sequence) ?? index,
    travel_mode: String(segment.travel_mode || (mode === 'WALK' ? 'WALK' : 'TRANSIT')).toUpperCase(),
    mode,
    transit_vehicle_type: String(segment.transit_vehicle_type || (mode === 'TRANSIT' ? '' : mode)).toUpperCase() || null,
    line: segment.line && typeof segment.line === 'object' ? { ...segment.line } : null,
    from_stop: normalizeStop(segment.from_stop || segment.fromStop),
    to_stop: normalizeStop(segment.to_stop || segment.toStop),
    distance_meters: optionalNumber(segment.distance_meters),
    duration_seconds: optionalNumber(segment.duration_seconds),
    geometry,
  };
}

function normalizeLeg(leg, dayNumber, index, fallbackFrom, fallbackTo) {
  const explicitStatus = leg.status || leg.route_status;
  const isVerifiedRoute = ['success', 'planned', 'available'].includes(explicitStatus);
  const rawGeometry = normalizeGeometry(leg.geometry);
  const status = explicitStatus || (leg.provider && rawGeometry ? 'success' : 'unknown');
  const verified = isVerifiedRoute || status === 'success';
  const id = leg.id || leg.leg_id || stableId('leg', dayNumber, fallbackFrom, fallbackTo, index);
  const segments = (Array.isArray(leg.segments) ? leg.segments : [])
    .map((segment, segmentIndex) => normalizeSegment(segment, id, segmentIndex, verified))
    .sort((left, right) => left.sequence - right.sequence);
  return {
    ...leg,
    id,
    from_node_id: leg.from_node_id || leg.fromNodeId || fallbackFrom || null,
    to_node_id: leg.to_node_id || leg.toNodeId || fallbackTo || null,
    mode: normalizeMode(leg.mode || leg.selected_mode || leg.travel_mode),
    status,
    distance_meters: optionalNumber(leg.distance_meters),
    duration_seconds: optionalNumber(leg.duration_seconds),
    geometry: verified ? rawGeometry : null,
    segments,
    summary: leg.summary || '',
    advisory_text: routeAdvisoryText(leg) || null,
    primary_vehicle: String(leg.primary_vehicle || leg.primaryVehicle || '').toUpperCase() || null,
    transfers: optionalNumber(leg.transfers),
    departure_time: leg.departure_time || leg.departure_at || null,
    arrival_time: leg.arrival_time || leg.arrival_at || null,
    reason: leg.reason || leg.selection_reason || '',
  };
}

function makeLegacyLegs(nodes, dayNumber) {
  return nodes.slice(0, -1).map((node, index) => normalizeLeg({
    status: 'unknown',
    mode: 'UNKNOWN',
    reason: '旧版行程没有保存逐段路线，需要重新计算。',
  }, dayNumber, index, node.id, nodes[index + 1]?.id));
}

function normalizeDay(day, index, routes = []) {
  const dayNumber = Number(day.day ?? day.day_number ?? index + 1) || index + 1;
  const rawNodes = Array.isArray(day.nodes) && day.nodes.length ? day.nodes : (day.spots || []);
  const nodes = rawNodes.map((node, nodeIndex) => normalizeNode(node, dayNumber, nodeIndex));
  const dayRoutes = routes.filter(route => Number(route.day ?? route.day_number) === dayNumber);
  const rawLegs = Array.isArray(day.legs) && day.legs.length
    ? day.legs
    : dayRoutes.filter(route => route.from_node_id || route.to_node_id || route.leg_id);
  const legs = rawLegs.length
    ? rawLegs.map((leg, legIndex) => normalizeLeg(
        leg,
        dayNumber,
        legIndex,
        nodes[legIndex]?.id,
        nodes[legIndex + 1]?.id,
      ))
    : makeLegacyLegs(nodes, dayNumber);
  const rawConnection = day.connection_to_next || day.connectionToNext;
  const connection = rawConnection
    ? normalizeLeg({
        ...rawConnection,
        advisory_text: routeAdvisoryText(rawConnection) || String(day.connection_to_next_notes || '').trim() || null,
      }, dayNumber, legs.length, rawConnection.from_node_id, rawConnection.to_node_id)
    : null;

  return {
    ...day,
    id: day.id || day.day_id || stableId('day', dayNumber, day.city, day.country),
    day: dayNumber,
    day_number: dayNumber,
    date: day.date || null,
    nodes,
    spots: nodes.filter(node => !['hotel', 'stay'].includes(node.type)),
    legs,
    connection_to_next: connection,
  };
}

function normalizeStage(stage, index) {
  return {
    ...stage,
    id: stage.id || stage.stage_id || stableId('stage', stage.city, stage.country, stage.start_day, index),
    start_day: Number(stage.start_day) || 1,
    end_day: Number(stage.end_day) || Number(stage.start_day) || 1,
  };
}

function normalizeHealth(result, plan) {
  if (result.health || plan.health) {
    const source = result.health || plan.health;
    const blockers = source.blocking_issues || source.blocking || source.blockers || [];
    const warnings = source.warnings || [];
    const info = source.info || [];
    return {
      ...source,
      issues: Array.isArray(source.issues)
        ? source.issues
        : [
            ...blockers.map(issue => ({ ...issue, severity: issue.severity || 'blocking' })),
            ...warnings.map(issue => ({ ...issue, severity: issue.severity || 'warning' })),
            ...info.map(issue => ({ ...issue, severity: issue.severity || 'info' })),
          ],
    };
  }

  const issues = [];
  for (const warning of result.geocoding_warnings || []) {
    issues.push({
      id: stableId('issue', warning.name, warning.reason),
      severity: warning.removed ? 'blocking' : 'warning',
      code: warning.code || 'GEOCODING_WARNING',
      message: `${warning.name}：${warning.reason}`,
    });
  }
  for (const warning of result.verification?.warnings || []) {
    issues.push({ id: stableId('issue', warning), severity: 'warning', code: 'CONTENT_REVIEW', message: warning });
  }
  if (result.verification?.skipped || result.verification?.status === 'unknown') {
    issues.push({
      id: 'issue_review_unavailable',
      severity: 'warning',
      code: 'REVIEW_UNAVAILABLE',
      message: '内容审核暂不可用；地点和路线的确定性检查仍会单独显示。',
    });
  }
  return { status: issues.some(issue => issue.severity === 'blocking') ? 'blocked' : 'ready', issues };
}

export function normalizeSnapshot(result, { query = '', profile = EMPTY_PROFILE } = {}) {
  if (!result?.plan || typeof result.plan !== 'object') {
    throw new Error('生成结果缺少有效的旅行计划');
  }
  const rawPlan = result.plan;
  const routes = Array.isArray(result.routes) ? result.routes : [];
  const dailyPlans = (Array.isArray(rawPlan.daily_plans) ? rawPlan.daily_plans : [])
    .map((day, index) => normalizeDay(day, index, routes))
    .sort((left, right) => left.day - right.day);
  if (!dailyPlans.length) throw new Error('生成结果没有任何日程');

  const destinations = Array.isArray(rawPlan.stages) && rawPlan.stages.length
    ? rawPlan.stages
    : (rawPlan.destinations || []);
  const stages = destinations.map(normalizeStage);
  const plan = {
    ...rawPlan,
    id: rawPlan.id || rawPlan.trip_id || stableId('trip', rawPlan.title, query, rawPlan.days),
    schema_version: rawPlan.schema_version || 2,
    stages,
    daily_plans: dailyPlans,
    day_connections: rawPlan.day_connections || rawPlan.connections || [],
  };
  const dayRoutes = dailyPlans.flatMap(day => day.legs);
  const knownRouteIds = new Set(dayRoutes.map(route => route.id));
  const connectionRoutes = routes
    .filter(route => route.connection_to_day != null && !knownRouteIds.has(route.id || route.leg_id))
    .map((route, index) => normalizeLeg(
      route,
      Number(route.day) || 0,
      index,
      route.from_node_id,
      route.to_node_id,
    ));
  const normalizedRoutes = [...dayRoutes, ...connectionRoutes];

  return {
    id: result.id || result.revision?.id || stableId('revision', plan.id, Date.now()),
    query,
    profile: cloneProfile(result.profile || result.parsed_request?.profile || profile),
    plan,
    routes: normalizedRoutes,
    parsedRequest: result.parsed_request || result.parsedRequest || null,
    transitMarkers: Array.isArray(result.transit_markers)
      ? result.transit_markers
      : Array.isArray(result.transitMarkers) ? result.transitMarkers : [],
    verification: result.verification || null,
    geocodingWarnings: result.geocoding_warnings || result.geocodingWarnings || [],
    health: normalizeHealth(result, plan),
    createdAt: result.createdAt || Date.now(),
  };
}

export function snapshotFromHistory(item) {
  if (item?.snapshot?.plan) return normalizeSnapshot({
    ...item.snapshot,
    plan: item.snapshot.plan,
    routes: item.snapshot.routes,
    profile: item.profile || item.snapshot.profile,
    health: item.snapshot.health,
  }, { query: item.query, profile: item.profile });

  return normalizeSnapshot({
    plan: item.plan,
    routes: item.routes,
    parsed_request: item.plan?.__parsed_request,
    transit_markers: item.plan?.__transit_markers,
    verification: item.plan?.__verification,
    geocoding_warnings: item.plan?.__geocoding_warnings,
  }, { query: item.query, profile: item.profile });
}

export function firstDayNumber(snapshot) {
  return snapshot?.plan?.daily_plans?.[0]?.day ?? null;
}

export function findDay(plan, dayIdOrNumber) {
  return (plan?.daily_plans || []).find(day =>
    day.id === dayIdOrNumber || Number(day.day) === Number(dayIdOrNumber),
  );
}
