const VALID_MODES = new Set([
  'WALK', 'TRANSIT', 'DRIVE', 'BICYCLE', 'RAIL', 'FLIGHT', 'TAXI', 'FERRY',
]);

export const EMPTY_PROFILE = Object.freeze({
  days: '',
  startDate: '',
  budget: { level: '', amount: '', currency: 'CNY', basis: 'total', hardLimit: false },
  pace: '',
  transport: {
    priority: '',
    allowedModes: ['WALK', 'TRANSIT', 'RAIL'],
    avoidModes: [],
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
  return {
    ...EMPTY_PROFILE,
    ...profile,
    budget: { ...EMPTY_PROFILE.budget, ...(profile.budget || {}) },
    transport: { ...EMPTY_PROFILE.transport, ...(profile.transport || {}) },
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

export function validCoordinates(coordinates) {
  return Boolean(
    coordinates
      && Number.isFinite(Number(coordinates.lat))
      && Number.isFinite(Number(coordinates.lng))
      && Math.abs(Number(coordinates.lat)) <= 90
      && Math.abs(Number(coordinates.lng)) <= 180,
  );
}

export function formatDistance(meters) {
  const numeric = Number(meters);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)} km`;
  return `${Math.round(numeric)} m`;
}

export function formatDuration(seconds) {
  const numeric = Number(seconds);
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
  })[String(mode || '').toUpperCase()] || '交通待确认';
}

function normalizeMode(mode) {
  const normalized = String(mode || '').toUpperCase();
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

function normalizeLeg(leg, dayNumber, index, fallbackFrom, fallbackTo) {
  const geometry = Array.isArray(leg.geometry)
    ? leg.geometry.filter(point => Array.isArray(point)
      && Number.isFinite(Number(point[0]))
      && Number.isFinite(Number(point[1])))
      .map(([lat, lng]) => [Number(lat), Number(lng)])
    : null;
  const explicitStatus = leg.status || leg.route_status;
  const isVerifiedRoute = ['success', 'planned', 'available'].includes(explicitStatus);
  const status = explicitStatus || (leg.provider && geometry?.length >= 2 ? 'success' : 'unknown');
  return {
    ...leg,
    id: leg.id || leg.leg_id || stableId('leg', dayNumber, fallbackFrom, fallbackTo, index),
    from_node_id: leg.from_node_id || leg.fromNodeId || fallbackFrom || null,
    to_node_id: leg.to_node_id || leg.toNodeId || fallbackTo || null,
    mode: normalizeMode(leg.mode || leg.selected_mode || leg.travel_mode),
    status,
    distance_meters: Number.isFinite(Number(leg.distance_meters)) ? Number(leg.distance_meters) : null,
    duration_seconds: Number.isFinite(Number(leg.duration_seconds)) ? Number(leg.duration_seconds) : null,
    geometry: isVerifiedRoute || status === 'success' ? geometry : null,
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

  return {
    ...day,
    id: day.id || day.day_id || stableId('day', dayNumber, day.city, day.country),
    day: dayNumber,
    day_number: dayNumber,
    date: day.date || null,
    nodes,
    spots: nodes.filter(node => !['hotel', 'stay'].includes(node.type)),
    legs,
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
