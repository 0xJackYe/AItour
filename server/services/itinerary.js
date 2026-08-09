import { createHash } from 'node:crypto';

function stableId(prefix, ...parts) {
  const value = parts.map(part => String(part ?? '')).join('|');
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 12)}`;
}

function coordinatesOf(value) {
  const coordinates = value?.coordinates || value;
  const parseCoordinate = (coordinate, limit) => {
    if (coordinate == null || typeof coordinate === 'boolean') return null;
    if (typeof coordinate === 'string' && !coordinate.trim()) return null;
    const numeric = Number(coordinate);
    return Number.isFinite(numeric) && Math.abs(numeric) <= limit ? numeric : null;
  };
  const lat = parseCoordinate(Array.isArray(coordinates) ? coordinates[0] : coordinates?.lat, 90);
  const lng = parseCoordinate(Array.isArray(coordinates) ? coordinates[1] : coordinates?.lng, 180);
  return lat !== null && lng !== null ? { ...coordinates, lat, lng } : null;
}

const CONNECTION_CONFIRMATION_NOTICE = '该方案仅作参考，具体线路、换乘和班次请在临近出发时通过 Google Maps 实时确认。';
const LOCATION_ALIAS_GROUPS = [
  ['大阪', 'osaka'],
  ['京都', 'kyoto'],
  ['富士山', '富士吉田', '富士河口湖', '河口湖', '忍野', 'fujisan', 'fujiyoshida', 'fujikawaguchiko', 'kawaguchiko', 'oshino'],
  ['东京', '東京', '新宿', 'tokyo', 'shinjuku'],
];

function normalizedLocationText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function aliasesForLocation(value) {
  const normalized = normalizedLocationText(value);
  const group = LOCATION_ALIAS_GROUPS.find(items => items.some(item => normalized.includes(normalizedLocationText(item))));
  return group || [value];
}

function noteReferencesLocation(note, value) {
  const text = normalizedLocationText(note);
  return aliasesForLocation(value).some(alias => text.includes(normalizedLocationText(alias)));
}

function isSpecificConnectionNote(note, fromCity, toCity) {
  const text = String(note || '').trim();
  if (!text || !noteReferencesLocation(text, fromCity) || !noteReferencesLocation(text, toCity)) return false;
  const hasStation = /(站|駅|station|机场|機場|airport|码头|碼頭|terminal)/i.test(text);
  const hasConcreteMode = /(?:\b(?:jr|shinkansen|rail|train|bus|metro|subway|flight|ferry|tram|line)\b|[A-Za-z0-9]{1,8}\s*(?:线|線)|新干线|新幹線|列车|列車|特急|铁路|鐵路|巴士|公交|地铁|地鐵|航班|轮渡|輪渡)/iu.test(text);
  return hasStation && hasConcreteMode;
}

function matchesLocation(value, candidates) {
  const aliases = aliasesForLocation(value).map(normalizedLocationText);
  return candidates.some(candidate => aliases.includes(normalizedLocationText(candidate)));
}

function withConfirmationNotice(note) {
  const text = String(note || '').trim();
  if (!text) return CONNECTION_CONFIRMATION_NOTICE;
  return /Google Maps|临近出发|臨近出發|实时确认|實時確認/i.test(text)
    ? text
    : `${text}${/[。！？.!?]$/.test(text) ? '' : '。'}${CONNECTION_CONFIRMATION_NOTICE}`;
}

function isJapanCountry(value) {
  return ['日本', 'jp', 'jpn', 'japan'].includes(normalizedLocationText(value));
}

function noteMatchesTransportPreference(note, mode, profile = {}) {
  const text = String(note || '');
  const normalizedMode = String(mode || '').toUpperCase();
  const mentionsRail = /(?:\b(?:jr|shinkansen|rail|train)\b|新干线|新幹線|列车|列車|特急|铁路|鐵路|富士急行)/iu.test(text);
  const mentionsBus = /(?:\bbus\b|巴士|公交)/iu.test(text);
  const mentionsSubway = /(?:\b(?:metro|subway)\b|地铁|地鐵)/iu.test(text);
  const mentionsLightRail = /(?:\b(?:light\s*rail|tram)\b|轻轨|輕軌|路面电车|路面電車)/iu.test(text);
  const mentionsFlight = /(?:\bflight\b|航班|飞机|飛機|机场|機場|airport)/iu.test(text);
  const mentionsDrive = /(?:\b(?:drive|car|taxi)\b|驾车|駕車|自驾|自駕|出租车|出租車|汽车|汽車)/iu.test(text);
  const mentionsWalk = /(?:\bwalk(?:ing)?\b|步行)/iu.test(text);
  const mentionsBicycle = /(?:\b(?:bicycle|bike|cycling)\b|骑行|騎行|自行车|自行車)/iu.test(text);
  const mentionsTransit = mentionsRail || mentionsBus || mentionsSubway || mentionsLightRail;

  if (normalizedMode === 'DRIVE') return mentionsDrive && !mentionsTransit && !mentionsFlight;
  if (normalizedMode === 'FLIGHT') return mentionsFlight;
  if (normalizedMode === 'WALK') return mentionsWalk && !mentionsTransit && !mentionsDrive;
  if (normalizedMode === 'BICYCLE') return mentionsBicycle && !mentionsTransit && !mentionsDrive;
  if (!['RAIL', 'TRANSIT'].includes(normalizedMode) || !mentionsTransit) return false;

  const configured = new Set((profile?.transport?.transitPreferences?.allowedModes || [])
    .map(item => String(item || '').toUpperCase()));
  if (!configured.size) return normalizedMode !== 'RAIL' || mentionsRail;
  const railAllowed = ['TRAIN', 'RAIL'].some(item => configured.has(item));
  if (mentionsRail && !railAllowed) return false;
  if (mentionsBus && !configured.has('BUS')) return false;
  if (mentionsSubway && !configured.has('SUBWAY') && !configured.has('RAIL')) return false;
  if (mentionsLightRail && !configured.has('LIGHT_RAIL') && !configured.has('RAIL')) return false;
  return normalizedMode !== 'RAIL' || mentionsRail;
}

function buildConnectionAdvisory(day, next, from, to, mode, profile = {}) {
  const currentNote = String(day?.connection_to_next_notes || '').trim();
  if (isSpecificConnectionNote(currentNote, day?.city, next?.city)
    && noteMatchesTransportPreference(currentNote, mode, profile)) return withConfirmationNotice(currentNote);

  const misplaced = String(next?.connection_to_next_notes || '').trim();
  if (isSpecificConnectionNote(misplaced, day?.city, next?.city)
    && noteMatchesTransportPreference(misplaced, mode, profile)) return withConfirmationNotice(misplaced);

  const fromCity = day?.city || '出发城市';
  const toCity = next?.city || '到达城市';
  const fromJapan = isJapanCountry(day?.country);
  const toJapan = isJapanCountry(next?.country);
  const transitMode = mode === 'RAIL' || mode === 'TRANSIT';
  const configuredSubModes = (profile?.transport?.transitPreferences?.allowedModes || [])
    .map(item => String(item || '').toUpperCase());
  const allowsAllTransit = configuredSubModes.length === 0;
  const supportsRail = transitMode && (mode === 'RAIL' || allowsAllTransit
    || configuredSubModes.some(item => ['TRAIN', 'RAIL', 'LIGHT_RAIL'].includes(item)));
  const supportsBus = transitMode && (allowsAllTransit || configuredSubModes.includes('BUS'));
  const isOsaka = matchesLocation(fromCity, ['大阪', 'osaka']);
  const isKyoto = matchesLocation(toCity, ['京都', 'kyoto']);
  const fromKyoto = matchesLocation(fromCity, ['京都', 'kyoto']);
  const toFuji = matchesLocation(toCity, ['富士山', '富士吉田', '富士河口湖', '河口湖', '忍野', 'fujisan', 'fujiyoshida', 'fujikawaguchiko', 'kawaguchiko', 'oshino']);
  const fromFuji = matchesLocation(fromCity, ['富士山', '富士吉田', '富士河口湖', '河口湖', '忍野', 'fujisan', 'fujiyoshida', 'fujikawaguchiko', 'kawaguchiko', 'oshino']);
  const toTokyo = matchesLocation(toCity, ['东京', '東京', '新宿', 'tokyo', 'shinjuku']);

  if (fromJapan && toJapan && supportsRail && isOsaka && isKyoto) {
    return `大阪→京都参考：从住宿先前往大阪站，优先乘 JR 京都线新快速直达京都站；若从新大阪站出发，也可核对东海道新干线。抵达京都站后再前往住宿。${CONNECTION_CONFIRMATION_NOTICE}`;
  }
  if (fromJapan && toJapan && supportsRail && supportsBus && fromKyoto && toFuji) {
    return `京都→富士山/河口湖参考：从京都站乘东海道新干线到三岛站，再换乘富士急巴士或高速巴士前往富士山站/河口湖站。${CONNECTION_CONFIRMATION_NOTICE}`;
  }
  if (fromJapan && toJapan && supportsBus && fromFuji && toTokyo) {
    const railAlternative = supportsRail ? '；铁路备选为乘富士急行线到大月站，再换乘 JR 中央线前往新宿/东京' : '';
    return `富士山/河口湖→东京参考：优先从河口湖站或富士山站乘新宿高速巴士到新宿${railAlternative}。${CONNECTION_CONFIRMATION_NOTICE}`;
  }

  const fromStop = from?.name || `${fromCity}主要交通枢纽`;
  const toStop = to?.name || `${toCity}主要交通枢纽`;
  const modeText = mode === 'FLIGHT' ? '航班及两端机场接驳'
    : mode === 'RAIL' ? '城际铁路及必要接驳'
      : mode === 'TRANSIT' ? '公共交通'
        : mode === 'DRIVE' ? '道路交通'
          : '可用交通方式';
  return `${fromCity}→${toCity}参考：从${fromStop}前往${toStop}，优先核对${modeText}的真实可用方案。${CONNECTION_CONFIRMATION_NOTICE}`;
}

function haversineKm(left, right) {
  const a = coordinatesOf(left);
  const b = coordinatesOf(right);
  if (!a || !b) return null;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function allowedModes(profile) {
  const configured = profile?.transport?.allowedModes || [];
  const avoided = new Set(profile?.transport?.avoidModes || []);
  const fallback = ['WALK', 'TRANSIT'];
  return (configured.length ? configured : fallback).filter(mode => !avoided.has(mode));
}

function distancePolicy(profile = {}) {
  const configured = profile?.transport?.distancePolicy || {};
  const walkMaxKm = Number.isFinite(Number(configured.walkMaxKm)) ? Number(configured.walkMaxKm) : 1;
  const localTransitMaxKm = Number.isFinite(Number(configured.localTransitMaxKm))
    ? Number(configured.localTransitMaxKm)
    : 30;
  const flightMinKm = Number.isFinite(Number(configured.flightMinKm)) ? Number(configured.flightMinKm) : 800;
  return { walkMaxKm, localTransitMaxKm, flightMinKm };
}

export function selectLegMode(from, to, profile = {}) {
  const allowed = allowedModes(profile);
  const crossCity = Boolean(from?.city && to?.city && from.city !== to.city);
  const priority = profile?.transport?.priority || 'balanced';
  const distanceKm = haversineKm(from, to);
  const policy = distancePolicy(profile);
  const longDistance = distanceKm !== null && distanceKm >= policy.flightMinKm;
  const localDistance = distanceKm !== null && distanceKm <= policy.localTransitMaxKm;

  const selectAllowed = ordered => ordered.find(item => allowed.includes(item)) || allowed[0] || 'UNKNOWN';

  if (crossCity) {
    const ordered = localDistance
      ? ['TRANSIT', 'RAIL', 'DRIVE', 'FLIGHT']
      : longDistance && ['time', 'comfort'].includes(priority)
        ? ['FLIGHT', 'RAIL', 'TRANSIT', 'DRIVE']
        : priority === 'time'
          ? ['RAIL', 'FLIGHT', 'TRANSIT', 'DRIVE']
          : priority === 'cost'
            ? ['RAIL', 'TRANSIT', 'DRIVE', 'FLIGHT']
            : priority === 'rail'
              ? ['RAIL', 'TRANSIT', 'DRIVE', 'FLIGHT']
              : ['RAIL', 'TRANSIT', 'FLIGHT', 'DRIVE'];
    const mode = selectAllowed(ordered);
    const distanceReason = localDistance ? `距离约 ${distanceKm.toFixed(1)}km，优先城际公共交通`
      : longDistance ? `距离约 ${distanceKm.toFixed(0)}km，已允许比较飞机与铁路`
        : distanceKm === null ? '跨城距离待路线服务确认' : `距离约 ${distanceKm.toFixed(0)}km，优先铁路衔接`;
    return { mode, reason: `${distanceReason}；按“${priority}”优先级选择`, distanceKm };
  }

  // maxWalkingKm 是全日上限；distancePolicy.walkMaxKm 是用户明确的单段距离规则。
  const dailyWalkingLimit = Number(profile?.maxWalkingKm) || 4.5;
  const normalSingleLegLimit = Math.min(policy.walkMaxKm, Math.max(0, dailyWalkingLimit / 3));
  const maxWalk = priority === 'walking' ? Math.min(0.3, normalSingleLegLimit) : normalSingleLegLimit;
  if (allowed.includes('WALK') && distanceKm !== null && distanceKm <= maxWalk) {
    return { mode: 'WALK', reason: `距离约 ${distanceKm.toFixed(1)}km，未超过单段步行偏好`, distanceKm };
  }
  const preferred = !localDistance && allowed.includes('RAIL') ? 'RAIL'
    : priority === 'walking' ? 'DRIVE'
    : priority === 'transit' || priority === 'cost' ? 'TRANSIT'
      : priority === 'time' || priority === 'comfort' ? 'DRIVE'
        : 'TRANSIT';
  const mode = selectAllowed([preferred, 'TRANSIT', 'RAIL', 'DRIVE', 'BICYCLE', 'WALK']);
  return {
    mode,
    reason: `${distanceKm === null ? '距离待路线服务确认' : `距离约 ${distanceKm.toFixed(1)}km`}；按“${priority}”优先级与距离规则选择`,
    distanceKm,
  };
}

function estimatedDurationSeconds(mode, distanceKm) {
  if (distanceKm === null) return 15 * 60;
  const speeds = { WALK: 4.5, BICYCLE: 14, TRANSIT: 20, DRIVE: 28, RAIL: 70, FLIGHT: 450 };
  const transferMinutes = mode === 'TRANSIT' ? 8 : mode === 'RAIL' ? 30 : mode === 'FLIGHT' ? 120 : 3;
  return Math.max(5 * 60, Math.round((distanceKm / (speeds[mode] || 20)) * 3600 + transferMinutes * 60));
}

function addDays(dateText, offset) {
  if (!dateText) return null;
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function timeToMinutes(value, fallback = 540) {
  const match = String(value || '').match(/^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function renderTime(date, minutes) {
  const normalized = Math.max(0, Math.round(minutes));
  const dayOffset = Math.floor(normalized / 1440);
  const clock = normalized % 1440;
  const time = `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
  const shiftedDate = date ? addDays(date, dayOffset) : null;
  return shiftedDate ? `${shiftedDate}T${time}:00` : time;
}

function accommodationForDay(plan, day) {
  const accommodations = Array.isArray(plan.accommodations) ? plan.accommodations : [];
  const scoped = accommodations.filter(item => item.city === day.city && (!item.country || !day.country || item.country === day.country));
  const dayNumber = Number(day.day);
  const scheduled = scoped.find(item => {
    const checkIn = Number(item.check_in_day ?? item.checkInDay);
    const checkOut = Number(item.check_out_day ?? item.checkOutDay);
    if (!Number.isFinite(checkIn) && !Number.isFinite(checkOut)) return false;
    return (!Number.isFinite(checkIn) || dayNumber >= checkIn)
      && (!Number.isFinite(checkOut) || dayNumber < checkOut);
  });
  return scheduled
    || scoped[0]
    || (plan.accommodation && (!plan.accommodation.city || plan.accommodation.city === day.city) ? plan.accommodation : null)
    || { city: day.city, country: day.country, area: '待确认住宿', landmark: '待确认住宿' };
}

function makeAnchor(tripId, day, accommodation, role) {
  const suffix = role === 'start' ? '当日住宿出发' : '返回当日住宿';
  const placeId = accommodation.place_id || accommodation.placeId
    || accommodation.coordinates?.place_id || accommodation.coordinates?.placeId || null;
  return {
    id: stableId('node', tripId, day.day, role, accommodation.landmark || accommodation.area),
    type: 'hotel',
    role: `${role}_anchor`,
    name: accommodation.landmark || accommodation.area || suffix,
    name_en: accommodation.landmark || '',
    city: day.city,
    country: day.country,
    duration_minutes: 0,
    description: suffix,
    locked: true,
    place_id: placeId,
    placeId,
    coordinates: coordinatesOf(accommodation),
  };
}

function normalizeActivityNode(source, tripId, day, index) {
  const duration = Number(source.duration_minutes)
    || (Number(source.duration_hours) > 0 ? Number(source.duration_hours) * 60 : 90);
  return {
    ...source,
    id: source.id || stableId('node', tripId, day.day, source.place_id || source.name_en || source.name, index),
    type: source.type || 'attraction',
    city: source.city || day.city,
    country: source.country || day.country,
    duration_minutes: Math.max(0, Math.round(duration)),
    locked: source.locked === true,
    coordinates: coordinatesOf(source),
  };
}

function makeLeg(tripId, day, from, to, index, profile) {
  const selected = selectLegMode(from, to, profile);
  return {
    id: stableId('leg', tripId, day.day, from.id, to.id),
    from_node_id: from.id,
    to_node_id: to.id,
    mode: selected.mode,
    status: 'pending',
    reason: selected.reason,
    distance_meters: selected.distanceKm === null ? null : Math.round(selected.distanceKm * 1000),
    duration_seconds: estimatedDurationSeconds(selected.mode, selected.distanceKm),
    geometry: null,
    provider: null,
    sequence: index,
  };
}

export function scheduleDay(day, profile = {}) {
  const nodeById = new Map(day.nodes.map(node => [node.id, { ...node }]));
  const preferredStart = day.schedule_start_time || day.scheduleStartTime || profile.dailyStartTime;
  let cursor = timeToMinutes(preferredStart, 540);
  const first = nodeById.get(day.nodes[0]?.id);
  if (first) first.start_time = first.end_time = renderTime(day.date, cursor);

  for (const leg of day.legs) {
    const from = nodeById.get(leg.from_node_id);
    const to = nodeById.get(leg.to_node_id);
    if (!from || !to) continue;
    leg.departure_time = renderTime(day.date, cursor);
    cursor += Math.max(0, Number(leg.duration_seconds) || 0) / 60;
    leg.arrival_time = renderTime(day.date, cursor);
    to.start_time = renderTime(day.date, cursor);
    cursor += Math.max(0, Number(to.duration_minutes) || 0);
    to.end_time = renderTime(day.date, cursor);
  }

  return {
    ...day,
    nodes: day.nodes.map(node => nodeById.get(node.id) || node),
    spots: day.nodes.map(node => nodeById.get(node.id) || node).filter(node => !node.role),
    duration_minutes: Math.max(0, Math.round(cursor - timeToMinutes(preferredStart, 540))),
  };
}

function makeStages(tripId, days, accommodations) {
  const stages = [];
  for (const day of days) {
    const accommodation = accommodationForDay({ accommodations }, day);
    const last = stages.at(-1);
    if (last && last.city === day.city && last.country === day.country && last.accommodation === accommodation) {
      last.end_day = day.day;
      last.end_date = day.date;
      last.day_ids.push(day.id);
      continue;
    }
    stages.push({
      id: stableId('stage', tripId, day.city, day.country, day.day),
      city: day.city,
      country: day.country,
      start_day: day.day,
      end_day: day.day,
      start_date: day.date,
      end_date: day.date,
      day_ids: [day.id],
      accommodation,
    });
  }
  return stages;
}

export function buildBudgetSummary(plan, profile = {}) {
  const budgetCurrency = String(profile.budget?.currency || 'CNY').toUpperCase();
  const travelers = Math.max(1, (profile.travelers?.adults || 0) + (profile.travelers?.children || 0) + (profile.travelers?.seniors || 0));
  const costs = [];
  let invalidCostItems = 0;
  let currencyMismatchItems = 0;
  for (const day of plan.daily_plans || []) {
    for (const node of day.nodes || day.spots || []) {
      if (node.role) continue;
      const rawCost = node.cost && typeof node.cost === 'object'
        ? node.cost
        : node.estimated_cost && typeof node.estimated_cost === 'object'
          ? node.estimated_cost
          : null;
      if (!rawCost) continue;
      const rawAmount = rawCost.amount;
      if (rawAmount === null || rawAmount === undefined || rawAmount === '') continue;
      const amount = Number(rawAmount);
      const currency = String(rawCost.currency || '').toUpperCase();
      const basis = String(rawCost.basis || '').toLowerCase();
      if (!Number.isFinite(amount) || amount < 0 || !currency || !basis) {
        invalidCostItems++;
        continue;
      }
      if (currency !== budgetCurrency) {
        currencyMismatchItems++;
        continue;
      }
      const multiplier = ['per_person', 'person'].includes(basis) ? travelers
        : ['group_total', 'group', 'item_total', 'total'].includes(basis) ? 1
          : null;
      if (multiplier === null) {
        invalidCostItems++;
        continue;
      }
      costs.push({
        category: rawCost.category || 'activities',
        amount: amount * multiplier,
        source_amount: amount,
        basis,
        confidence: rawCost.confidence || 'estimate',
      });
    }
  }
  const knownTotal = costs.reduce((sum, item) => sum + item.amount, 0);
  const rawLimit = Number(profile.budget?.amount) || null;
  const days = profile.days || plan.days || 1;
  const limit = rawLimit === null ? null
    : profile.budget?.basis === 'per_day' ? rawLimit * days
      : profile.budget?.basis === 'per_person_total' ? rawLimit * travelers
        : profile.budget?.basis === 'per_person_day' ? rawLimit * travelers * days
          : rawLimit;
  const breakdown = costs.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + item.amount;
    return result;
  }, {});
  return {
    currency: budgetCurrency,
    basis: profile.budget?.basis || 'total',
    level: profile.budget?.level || null,
    limit,
    known_total: knownTotal,
    estimated_total: costs.length ? knownTotal : null,
    remaining: limit === null ? null : limit - knownTotal,
    costed_items: costs.length,
    invalid_cost_items: invalidCostItems,
    currency_mismatch_items: currencyMismatchItems,
    total_items: (plan.daily_plans || []).reduce((sum, day) => sum + (day.nodes || day.spots || []).filter(node => !node.role).length, 0),
    coverage: (plan.daily_plans || []).length && costs.length
      ? costs.length / Math.max(1, (plan.daily_plans || []).reduce((sum, day) => sum + (day.nodes || day.spots || []).filter(node => !node.role).length, 0))
      : 0,
    status: limit !== null && knownTotal > limit ? 'over_budget' : costs.length ? 'estimated' : 'unknown',
    breakdown,
  };
}

export function buildExecutableItinerary(sourcePlan, profile = {}) {
  const sourceDays = Array.isArray(sourcePlan?.daily_plans) ? sourcePlan.daily_plans : [];
  const tripId = sourcePlan.id || stableId('trip', sourcePlan.title, sourcePlan.city, sourcePlan.country, profile.startDate, profile.days || sourcePlan.days);
  const accommodations = Array.isArray(sourcePlan.accommodations) ? sourcePlan.accommodations : sourcePlan.accommodation ? [sourcePlan.accommodation] : [];

  let dailyPlans = sourceDays.map((sourceDay, index) => {
    const dayNumber = Number(sourceDay.day) || index + 1;
    const day = { ...sourceDay, day: dayNumber };
    const accommodation = accommodationForDay({ ...sourcePlan, accommodations }, day);
    const startAnchor = makeAnchor(tripId, day, accommodation, 'start');
    const endAnchor = makeAnchor(tripId, day, accommodation, 'end');
    const nodeSources = Array.isArray(sourceDay.nodes) && sourceDay.nodes.length
      ? sourceDay.nodes.filter(node => !node.role)
      : Array.isArray(sourceDay.spots) ? sourceDay.spots : [];
    const activities = nodeSources.map((node, nodeIndex) => normalizeActivityNode(node, tripId, day, nodeIndex));
    const nodes = [startAnchor, ...activities, endAnchor];
    const dayId = sourceDay.id || stableId('day', tripId, dayNumber);
    const legs = nodes.slice(0, -1).map((node, legIndex) => makeLeg(tripId, day, node, nodes[legIndex + 1], legIndex, profile));
    return scheduleDay({
      ...sourceDay,
      id: dayId,
      day: dayNumber,
      date: sourceDay.date || addDays(profile.startDate, dayNumber - 1),
      nodes,
      legs,
      start_anchor: startAnchor.id,
      end_anchor: endAnchor.id,
    }, profile);
  });

  dailyPlans = dailyPlans.map((day, index) => {
    const next = dailyPlans[index + 1];
    if (!next) return { ...day, connection_to_next: null };
    const sameCity = day.city === next.city && day.country === next.country;
    const from = day.nodes.find(node => node.id === day.end_anchor);
    const to = next.nodes.find(node => node.id === next.start_anchor);
    const selected = selectLegMode(from, to, profile);
    const departureTime = renderTime(next.date, timeToMinutes(profile.dailyStartTime, 540));
    const estimatedDuration = estimatedDurationSeconds(selected.mode, selected.distanceKm);
    return {
      ...day,
      connection_to_next: {
        id: stableId('connection', tripId, day.id, next.id),
        from_day_id: day.id,
        to_day_id: next.id,
        from_node_id: day.end_anchor,
        to_node_id: next.start_anchor,
        type: sameCity ? 'overnight' : 'intercity',
        mode: sameCity ? 'STAY' : selected.mode,
        status: sameCity ? 'planned' : 'needs_confirmation',
        reason: sameCity ? '当晚住宿连接次日出发点' : selected.reason,
        departure_time: sameCity ? null : departureTime,
        arrival_time: sameCity ? null : renderTime(
          next.date,
          timeToMinutes(departureTime, 540) + estimatedDuration / 60,
        ),
        duration_seconds: sameCity ? null : estimatedDuration,
        overnight_before_departure: true,
        advisory_text: sameCity
          ? null
          : buildConnectionAdvisory(day, next, from, to, selected.mode, profile),
      },
    };
  });

  const plan = {
    ...sourcePlan,
    id: tripId,
    schema_version: 2,
    days: Number(profile.days) || Number(sourcePlan.days) || dailyPlans.length,
    profile,
    accommodations,
    daily_plans: dailyPlans,
    stages: makeStages(tripId, dailyPlans, accommodations),
  };
  plan.budget_summary = buildBudgetSummary(plan, profile);
  return plan;
}

export function applyLegRoutes(plan, routeResults = new Map(), profile = plan.profile || {}) {
  const mergeRoute = (leg, route) => {
    if (!route) return { ...leg };
    const retainedDuration = route.duration_seconds ?? leg.duration_seconds ?? null;
    const retainedDistance = route.distance_meters ?? leg.distance_meters ?? null;
    const retainedEstimate = route.estimated === true
      || (route.status !== 'available' && (route.duration_seconds == null || route.distance_meters == null));
    return {
      ...leg,
      ...route,
      duration_seconds: retainedDuration,
      distance_meters: retainedDistance,
      estimated: retainedEstimate,
      geometry: route.geometry || null,
      segments: Array.isArray(route.segments)
        ? route.segments.map((segment, index) => ({
            ...segment,
            id: `${leg.id}:segment:${index + 1}`,
            sequence: index,
          }))
        : [],
    };
  };
  const dailyPlans = (plan.daily_plans || []).map(day => {
    const legs = (day.legs || []).map(leg => mergeRoute(leg, routeResults.get(leg.id)));
    return scheduleDay({ ...day, legs }, profile);
  });

  for (let index = 0; index < dailyPlans.length - 1; index++) {
    const day = dailyPlans[index];
    const connection = day.connection_to_next;
    if (!connection) continue;
    const routedConnection = mergeRoute(connection, routeResults.get(connection.id));
    if (routedConnection.type === 'intercity') {
      const next = dailyPlans[index + 1];
      const departureTime = routedConnection.departure_time
        || renderTime(next.date, timeToMinutes(profile.dailyStartTime, 540));
      const departureMinutes = timeToMinutes(departureTime, 540);
      const durationMinutes = Math.max(0, Number(routedConnection.duration_seconds) || 0) / 60;
      routedConnection.departure_time = departureTime;
      routedConnection.arrival_time = renderTime(next.date, departureMinutes + durationMinutes);
      routedConnection.arrival_buffer_minutes = 45;
      dailyPlans[index + 1] = scheduleDay({
        ...next,
        schedule_start_time: renderTime(next.date, departureMinutes + durationMinutes + 45),
      }, profile);
    }
    dailyPlans[index] = { ...day, connection_to_next: routedConnection };
  }
  const result = { ...plan, daily_plans: dailyPlans };
  result.budget_summary = buildBudgetSummary(result, profile);
  return result;
}

export function flattenRoutes(plan) {
  const days = plan.daily_plans || [];
  return days.flatMap((day, dayIndex) => {
    const nodeMap = new Map((day.nodes || []).map(node => [node.id, node]));
    const routes = (day.legs || []).map(leg => {
      const from = nodeMap.get(leg.from_node_id);
      const to = nodeMap.get(leg.to_node_id);
      return {
        id: leg.id,
        day: day.day,
        provider: leg.provider,
        status: leg.status,
        travel_mode: leg.mode,
        points: [coordinatesOf(from), coordinatesOf(to)].filter(Boolean).map(point => [point.lat, point.lng]),
        geometry: leg.geometry,
        segments: leg.segments || [],
        summary: leg.summary || null,
        primary_vehicle: leg.primary_vehicle || null,
        transfers: leg.transfers ?? null,
        schedule_recheck_required: leg.schedule_recheck_required === true,
        schedule_basis: leg.schedule_basis || null,
        external_directions_url: leg.external_directions_url || null,
        provider_limit_code: leg.provider_limit_code || null,
        advisory_text: leg.advisory_text || null,
        attribution: leg.attribution || null,
        distance_meters: leg.distance_meters,
        duration_seconds: leg.duration_seconds,
        from_node_id: leg.from_node_id,
        to_node_id: leg.to_node_id,
      };
    });
    const connection = day.connection_to_next;
    const next = days[dayIndex + 1];
    if (connection?.type === 'intercity' && next) {
      const nextNodeMap = new Map((next.nodes || []).map(node => [node.id, node]));
      const from = nodeMap.get(connection.from_node_id);
      const to = nextNodeMap.get(connection.to_node_id);
      routes.push({
        id: connection.id,
        day: day.day,
        connection_to_day: next.day,
        provider: connection.provider,
        status: connection.status,
        travel_mode: connection.mode,
        points: [coordinatesOf(from), coordinatesOf(to)].filter(Boolean).map(point => [point.lat, point.lng]),
        geometry: connection.geometry,
        segments: connection.segments || [],
        summary: connection.summary || null,
        primary_vehicle: connection.primary_vehicle || null,
        transfers: connection.transfers ?? null,
        schedule_recheck_required: connection.schedule_recheck_required === true,
        schedule_basis: connection.schedule_basis || null,
        external_directions_url: connection.external_directions_url || null,
        provider_limit_code: connection.provider_limit_code || null,
        advisory_text: connection.advisory_text || null,
        attribution: connection.attribution || null,
        distance_meters: connection.distance_meters,
        duration_seconds: connection.duration_seconds,
        from_node_id: connection.from_node_id,
        to_node_id: connection.to_node_id,
      });
    }
    return routes;
  });
}
