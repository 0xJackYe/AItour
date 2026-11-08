// 城市间交通（transfers）：把“换城市”变成行程里的一等公民。
//
// 1. 推断：模型在 plan.transfers 里给出车次 / 航班 / 自驾路线、出发与到达站、时刻、时长和票价；
//    模型没有给（或旧数据）时，按每天所在城市、住宿城市、车站类地点与交通说明推断，
//    保证每次换城市（包括一日游当天往返）都有一条记录。推断结果与模型结果按“到达城市 +
//    日期”合并：天数以每天的行程为准，缺失的字段互相补全。
// 2. 落地：端点优先用当天已定位的车站，其次 Google 搜索出发 / 到达站，再其次住宿与城市中心。
// 3. 路线：自驾和大巴走真实道路；火车和轮渡优先 Google 公共交通，该地区没有数据
//    （如日本）时画示意直线并明确标注；航班画大圆示意线。
//    出发站和到达站正好是当天相邻的两个地点时，这段交通直接作为当天的一段路程，
//    时间线显示车次而不是“打车参考”，排程也按列车时长计算。

import { mapWithConcurrency } from '../lib/async.js';
import { currentSignal } from '../lib/context.js';
import { isAbortError } from '../lib/errors.js';
import { decodePolyline, haversineKm } from '../lib/geo.js';
import { log } from '../lib/log.js';
import { findPlace, geocodeCity } from './geocode.js';
import { computeRoute, isGoogleConfigured } from './google.js';
import { cityKey, destinationForDay, sameCity, text } from './planSchema.js';
import { BASE_FIELDS, TRANSIT_FIELDS, parseDuration, requestBody, transitLines } from './route.js';

/** 未写明交通方式、直线距离超过该值时按航班处理。 */
export const FLIGHT_MIN_KM = 1000;
const DRIVE_FIELDS = `${BASE_FIELDS},routes.description`;
const FILLABLE = ['mode', 'service', 'from_place', 'to_place', 'depart_time', 'arrive_time', 'duration_minutes', 'cost', 'tips', 'via', 'notes'];

// ───────────────────────────── 文本解析 ─────────────────────────────

const NUMBER = '(\\d+(?:\\.\\d+)?)';
const RANGE = `${NUMBER}(?:\\s*[-~～至到]\\s*${NUMBER})?`;
const HOURS_RE = new RegExp(`${RANGE}\\s*(?:个)?\\s*(?:小时|钟头|h(?:ours?|rs?)?(?![a-z]))(?:\\s*(\\d{1,2})\\s*(?:分钟|分|min(?:utes?)?))?`, 'gi');
const MINUTES_RE = new RegExp(`${RANGE}\\s*(?:分钟|分(?!之)|min(?:utes?)?)`, 'gi');
const TOTAL_RE = /总耗时|全程|总共|共计|合计|总计|总时长/;

const midpoint = (low, high) => (Number(low) + (high ? Number(high) : Number(low))) / 2;
const roundTo5 = minutes => Math.max(5, Math.round(minutes / 5) * 5);

/** “约 2 小时 15 分”“约 3-4 小时”“全程约 10 小时”“约 45 分钟” → 分钟数。 */
export function parseDurationMinutes(value) {
  const source = String(value || '');
  if (!source) return null;
  const hours = [...source.matchAll(HOURS_RE)].map(match => ({
    index: match.index,
    minutes: midpoint(match[1], match[2]) * 60 + (match[3] ? Number(match[3]) : 0),
  })).filter(item => item.minutes > 0 && item.minutes <= 48 * 60);
  const totalAt = source.search(TOTAL_RE);
  if (totalAt >= 0) {
    const total = hours.find(item => item.index > totalAt && item.index - totalAt <= 12);
    if (total) return roundTo5(total.minutes);
  }
  if (hours.length) return roundTo5(Math.max(...hours.map(item => item.minutes)));
  const minutes = [...source.matchAll(MINUTES_RE)].map(match => midpoint(match[1], match[2]));
  const longest = Math.max(0, ...minutes);
  return longest >= 15 ? roundTo5(longest) : null;
}

const MODE_PATTERNS = [
  ['flight', /航班|飞机|飞往|乘机|登机|直飞|转机|flight|airline|\bfly\b/i],
  ['ferry', /轮渡|渡轮|渡船|乘船|坐船|ferry/i],
  ['train', /新干线|高铁|动车|火车|列车|特急|快车|铁路|JR|近铁|阪急|京阪|名铁|小田急|Shinkansen|TGV|\bICE\b|Eurostar|Frecciarossa|Italo|Railjet|train|\brail/i],
  ['bus', /大巴|巴士|长途汽车|长途车|客车|\bbus\b|coach|FlixBus/i],
  ['drive', /自驾|驾车|开车|租车|包车|\bdrive\b|driving/i],
];

/** 文本中最先提到的城际交通方式。 */
export function inferTransferMode(value) {
  const source = String(value || '');
  let best = null;
  for (const [mode, pattern] of MODE_PATTERNS) {
    const index = source.search(pattern);
    if (index >= 0 && (!best || index < best.index)) best = { mode, index };
  }
  return best?.mode || null;
}

const SERVICE_RE = /(?:乘坐|搭乘|换乘|乘|坐)\s*(?:早班|晚班|夜班|首班|末班)?\s*([^，。,；;：:（）()、\s约\d][^，。,；;：:（）()、约\d]{1,23}?)\s*(?:前往|到达|抵达|直达|到|至|去|往|，|。|（|\(|约|\d|$)/;
const GENERIC_SERVICE = /^(?:火车|列车|巴士|大巴|飞机|航班|汽车|车|船|轮渡|渡轮|高铁|动车|公交|地铁|出租车|的士)$/;

/** “乘坐 JR 东海道新干线希望号前往京都” → “JR 东海道新干线希望号”。泛称返回空串。 */
export function extractService(value) {
  const match = SERVICE_RE.exec(String(value || ''));
  const service = match ? text(match[1], 40) : '';
  if (!service || GENERIC_SERVICE.test(service) || /或|步行/.test(service)) return '';
  return service;
}

const PLACE_SUFFIX = '(?:火车站|巴士站|客运站|汽车站|车站|机场|码头|港|站)';
const FROM_PLACE_RE = new RegExp(`从\\s*([^，。,；;\\s从至到乘坐驾经]{1,16}?${PLACE_SUFFIX})`);
const TO_PLACE_RE = new RegExp(`(?:至|到达|抵达|到)\\s*([^，。,；;\\s]{1,16}?${PLACE_SUFFIX})`);
const VIA_RE = /途经([^。；;，,（(]{2,30})/;

export function extractPlaces(value) {
  const source = String(value || '');
  return {
    from: text(FROM_PLACE_RE.exec(source)?.[1], 40),
    to: text(TO_PLACE_RE.exec(source)?.[1], 40),
    via: text(VIA_RE.exec(source)?.[1], 40),
  };
}

// ───────────────────────────── 推断与合并 ─────────────────────────────

function cityOfDay(plan, day) {
  return day.city || destinationForDay(plan.destinations, day.day)?.city || '';
}

/** 每天的“落脚城市”：一日游（只停一天、没有住宿的中途城市）当天仍住在前一个城市。 */
export function baseCities(plan) {
  const days = plan.daily_plans || [];
  const stays = new Set((plan.accommodations || []).map(item => cityKey(item.city)).filter(Boolean));
  const runs = [];
  for (const day of days) {
    const city = cityOfDay(plan, day);
    const last = runs[runs.length - 1];
    if (last && sameCity(last.city, city)) last.days.push(day);
    else runs.push({ city, days: [day] });
  }
  const result = new Map();
  let previousBase = null;
  runs.forEach((run, index) => {
    const dayTrip = Boolean(previousBase)
      && run.days.length === 1
      && stays.size > 0
      && !stays.has(cityKey(run.city))
      && index < runs.length - 1;
    const base = dayTrip ? previousBase : run.city;
    for (const day of run.days) result.set(day.day, { base, city: run.city, dayTrip });
    previousBase = base;
  });
  return result;
}

function enrichFromDay(transfer, day, { preference }) {
  const spots = day?.spots || [];
  const fromIndex = transfer.round_trip
    ? -1
    : spots.findIndex(spot => spot.type === 'transport' && sameCity(spot.city, transfer.from_city));
  const fromSpot = fromIndex >= 0 ? spots[fromIndex] : null;
  const toSpot = spots.slice(fromIndex + 1).find(spot => spot.type === 'transport' && sameCity(spot.city, transfer.to_city)) || null;
  const notes = text(day?.transport_notes, 160);
  const evidence = [fromSpot?.description, fromSpot?.tips, notes, toSpot?.description].filter(Boolean).join('。');
  const places = extractPlaces(notes);
  const mode = inferTransferMode(evidence) || (preference === 'drive' ? 'drive' : null);
  return {
    ...transfer,
    mode,
    // 自驾没有“车次”；说明里的“乘区间车进入景区”是景区内交通，不是这段路。
    service: mode === 'drive' ? '' : extractService(fromSpot?.description) || extractService(notes),
    from_place: fromSpot?.name || places.from,
    to_place: toSpot?.name || places.to,
    depart_time: fromSpot?.start_time || null,
    arrive_time: toSpot?.start_time || null,
    // 合并出发站介绍与当天交通说明一起解析：优先“全程 / 总耗时”，其次最长的小时数，
    // 避免把“步行约 20 分钟”当成列车时长。
    duration_minutes: parseDurationMinutes([fromSpot?.description, fromSpot?.tips, notes].filter(Boolean).join('。')),
    cost: fromSpot && /票|ticket|fare/i.test(fromSpot.cost || '') ? fromSpot.cost : '',
    tips: '',
    via: places.via,
    notes,
  };
}

/** 只根据每天的行程推断城市间交通（不依赖模型是否填写了 transfers）。 */
export function inferTransfers(plan, { preference = 'public_transit' } = {}) {
  const days = plan?.daily_plans || [];
  const bases = baseCities(plan);
  const transfers = [];
  days.forEach((day, index) => {
    const info = bases.get(day.day);
    const previous = index > 0 ? bases.get(days[index - 1].day) : null;
    if (previous?.base && info?.base && !sameCity(previous.base, info.base)) {
      transfers.push(enrichFromDay({ day: day.day, from_city: previous.base, to_city: info.base, round_trip: false }, day, { preference }));
    }
    if (info?.dayTrip) {
      transfers.push(enrichFromDay({ day: day.day, from_city: info.base, to_city: info.city, round_trip: true }, day, { preference }));
    }
  });
  return transfers;
}

function knownCities(plan) {
  const names = [
    ...(plan.destinations || []).map(item => item.city),
    ...(plan.accommodations || []).map(item => item.city),
    ...(plan.daily_plans || []).flatMap(day => [day.city, ...(day.spots || []).map(spot => spot.city)]),
  ];
  return new Set(names.map(cityKey).filter(Boolean));
}

/**
 * 模型给出的 transfers 与按行程推断的结果合并，返回带 id 的文字版列表。
 * 同一次换城市只保留一条；日期以每天的行程为准。
 */
export function reconcileTransfers(plan, { preference = 'public_transit' } = {}) {
  const known = knownCities(plan);
  const merged = (plan?.transfers || [])
    .filter(item => known.has(cityKey(item.from_city)) && known.has(cityKey(item.to_city)))
    .map(item => ({ ...item, source: 'model' }));
  for (const inferred of inferTransfers(plan, { preference })) {
    const match = merged.find(item => !item.matched
      && sameCity(item.to_city, inferred.to_city)
      && Math.abs(item.day - inferred.day) <= 1
      && (sameCity(item.from_city, inferred.from_city) || Boolean(item.round_trip) === Boolean(inferred.round_trip)));
    if (match) {
      match.matched = true;
      match.day = inferred.day;
      if (!sameCity(match.from_city, inferred.from_city) && inferred.round_trip) match.round_trip = true;
      for (const field of FILLABLE) if (!match[field] && inferred[field]) match[field] = inferred[field];
      continue;
    }
    merged.push({ ...inferred, source: 'inferred' });
  }
  return merged
    .sort((a, b) => a.day - b.day || String(a.depart_time || '').localeCompare(String(b.depart_time || '')))
    .slice(0, 40)
    .map(({ matched, ...item }, index) => ({
      id: `transfer:${index}`,
      day: item.day,
      from_city: item.from_city,
      to_city: item.to_city,
      mode: item.mode || null,
      service: item.service || '',
      from_place: item.from_place || '',
      to_place: item.to_place || '',
      depart_time: item.depart_time || null,
      arrive_time: item.arrive_time || null,
      duration_minutes: item.duration_minutes || null,
      cost: item.cost || '',
      tips: item.tips || '',
      via: item.via || '',
      // 没有具体车次时保留当天的交通说明，前端用它解释这段路怎么走。
      notes: item.service ? '' : item.notes || '',
      round_trip: Boolean(item.round_trip),
      source: item.source,
    }));
}

// ───────────────────────────── 落地与路线 ─────────────────────────────

const nameKey = value => String(value || '').toLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

function namesMatch(left, right) {
  const a = nameKey(left);
  const b = nameKey(right);
  return Boolean(a && b && (a === b || (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a)))));
}

const located = day => (day?.spots || []).filter(spot => spot.coordinates);

function point(coordinates) {
  return {
    lat: coordinates.lat,
    lng: coordinates.lng,
    ...(coordinates.place_id ? { place_id: coordinates.place_id } : {}),
  };
}

function spotEndpoint(spot) {
  return { name: spot.name, coordinates: point(spot.coordinates), spot_id: spot.location_id || null, kind: spot.type === 'transport' ? 'station' : 'spot' };
}

function countryOf(plan, city) {
  const destination = (plan.destinations || []).find(item => sameCity(item.city, city));
  if (destination?.country) return destination.country;
  const stay = (plan.accommodations || []).find(item => sameCity(item.city, city));
  if (stay?.country) return stay.country;
  for (const day of plan.daily_plans || []) {
    if (sameCity(day.city, city) && day.country) return day.country;
    const spot = (day.spots || []).find(item => sameCity(item.city, city) && item.country);
    if (spot) return spot.country;
  }
  return '';
}

async function searchEndpoint(plan, name, city) {
  if (!name || !isGoogleConfigured()) return null;
  const country = countryOf(plan, city);
  const context = await geocodeCity(city, country);
  const found = await findPlace(name, { city, country, context });
  return found.status === 'verified' ? { name, coordinates: point(found.coordinates), spot_id: null, kind: 'place' } : null;
}

async function cityEndpoint(plan, city) {
  if (!isGoogleConfigured()) return null;
  const context = await geocodeCity(city, countryOf(plan, city));
  return context ? { name: city, coordinates: { lat: context.lat, lng: context.lng }, spot_id: null, kind: 'city' } : null;
}

/** 解析出发（side=from）或到达（side=to）端点。 */
async function resolveEndpoint(plan, transfer, side) {
  const city = side === 'from' ? transfer.from_city : transfer.to_city;
  const placeName = side === 'from' ? transfer.from_place : transfer.to_place;
  const days = plan.daily_plans || [];
  const dayIndex = days.findIndex(day => day.day === transfer.day);
  const spots = located(days[dayIndex]);
  const roundTripOrigin = side === 'from' && transfer.round_trip;

  if (placeName && !roundTripOrigin) {
    const named = spots.find(spot => namesMatch(spot.name, placeName));
    if (named) return spotEndpoint(named);
  }
  if (!roundTripOrigin) {
    const station = spots.find(spot => spot.type === 'transport' && sameCity(spot.city, city));
    if (station) return spotEndpoint(station);
  }
  const searched = await searchEndpoint(plan, placeName, city);
  if (searched) return searched;
  const stay = (plan.accommodations || []).find(item => item.coordinates && sameCity(item.city, city));
  if (stay) return { name: stay.area || city, coordinates: point(stay.coordinates), spot_id: null, kind: 'stay' };
  if (side === 'to') {
    const first = spots.find(spot => sameCity(spot.city, city));
    if (first) return spotEndpoint(first);
  } else if (dayIndex > 0) {
    const last = located(days[dayIndex - 1]).filter(spot => sameCity(spot.city, city)).at(-1);
    if (last) return spotEndpoint(last);
  }
  return cityEndpoint(plan, city);
}

async function tryRoute(from, to, mode, fields) {
  try {
    const route = await computeRoute(requestBody(from, to, mode), fields);
    return route?.polyline?.encodedPolyline ? route : null;
  } catch (error) {
    if (isAbortError(error) || currentSignal()?.aborted) throw error;
    log.warn('transfer.route_failed', { mode, message: error.message });
    return null;
  }
}

/** 按交通方式计算两端之间的路线。 */
export async function routeBetween(from, to, transfer, { preference = 'public_transit' } = {}) {
  const km = haversineKm(from, to);
  const mode = transfer.mode || (preference === 'drive' ? 'drive' : km > FLIGHT_MIN_KM ? 'flight' : 'train');
  const modelSeconds = transfer.duration_minutes ? transfer.duration_minutes * 60 : null;
  const schematic = {
    mode,
    route_source: 'schematic',
    geometry: [[from.lat, from.lng], [to.lat, to.lng]],
    distance_meters: Math.round(km * 1000),
    duration_seconds: modelSeconds,
  };
  if (mode === 'flight' || km < 0.5) return schematic;

  if (mode === 'train' || mode === 'ferry' || mode === 'bus') {
    const route = await tryRoute(from, to, 'TRANSIT', TRANSIT_FIELDS);
    const lines = route ? transitLines(route) : [];
    if (route && lines.length) {
      return {
        mode,
        route_source: 'transit',
        geometry: decodePolyline(route.polyline.encodedPolyline),
        distance_meters: route.distanceMeters ?? schematic.distance_meters,
        duration_seconds: parseDuration(route.duration) ?? modelSeconds,
        transit_lines: lines,
      };
    }
  }
  if (mode === 'drive' || mode === 'bus') {
    const route = await tryRoute(from, to, 'DRIVE', DRIVE_FIELDS);
    if (route) {
      const apiSeconds = parseDuration(route.duration);
      return {
        mode,
        route_source: 'road',
        geometry: decodePolyline(route.polyline.encodedPolyline),
        distance_meters: route.distanceMeters ?? schematic.distance_meters,
        // 大巴比小汽车慢：优先采用模型给出的班车时长。
        duration_seconds: mode === 'bus' ? modelSeconds ?? apiSeconds : apiSeconds ?? modelSeconds,
        road: text(route.description, 60),
      };
    }
  }
  return schematic;
}

function attachment(plan, transfer, from, to) {
  const day = (plan.daily_plans || []).find(item => item.day === transfer.day);
  const spots = located(day);
  const fromIndex = from?.spot_id ? spots.findIndex(spot => spot.location_id === from.spot_id) : -1;
  const attached = fromIndex >= 0 && to?.spot_id && spots[fromIndex + 1]?.location_id === to.spot_id;
  const touchesBoth = spots.some(spot => sameCity(spot.city, transfer.from_city)) && spots.some(spot => sameCity(spot.city, transfer.to_city));
  return {
    attached_leg: attached ? { from_id: from.spot_id, to_id: to.spot_id } : null,
    // 当天的逐段路线已经覆盖这次换城市时，单天视图不再重复画这条线。
    covered: Boolean(attached || touchesBoth),
  };
}

/** 为每条城市间交通解析端点并计算路线。没有 Google Key 时只返回文字信息。 */
export async function routeTransfers(plan, transfers, { preference = 'public_transit' } = {}) {
  if (!transfers?.length) return [];
  return mapWithConcurrency(transfers, 4, async (transfer) => {
    const empty = {
      ...transfer,
      from: null,
      to: null,
      route_source: null,
      geometry: [],
      distance_meters: null,
      duration_seconds: transfer.duration_minutes ? transfer.duration_minutes * 60 : null,
      attached_leg: null,
      covered: false,
    };
    try {
      const [from, to] = await Promise.all([resolveEndpoint(plan, transfer, 'from'), resolveEndpoint(plan, transfer, 'to')]);
      if (!from?.coordinates || !to?.coordinates) return { ...empty, from, to };
      const route = await routeBetween(from.coordinates, to.coordinates, transfer, { preference });
      return { ...empty, ...route, from, to, ...attachment(plan, transfer, from, to) };
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      log.warn('transfer.failed', { id: transfer.id, message: error.message });
      return empty;
    }
  });
}

/** 作为当天一段路程时的交通段（时间线与排程使用）。 */
export function transferLeg(transfer) {
  return {
    from_id: transfer.attached_leg.from_id,
    to_id: transfer.attached_leg.to_id,
    mode: 'TRANSFER',
    transfer_id: transfer.id,
    transfer_mode: transfer.mode,
    service: transfer.service || '',
    // 示意线只是直线距离，不计入当天里程。
    distance_meters: transfer.route_source === 'schematic' ? null : transfer.distance_meters,
    duration_seconds: transfer.duration_seconds,
    geometry: transfer.geometry,
    ...(transfer.route_source === 'schematic' ? { schematic: true } : {}),
    ...(transfer.transit_lines ? { transit_lines: transfer.transit_lines } : {}),
  };
}

const clock = value => {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const DEFAULT_DEPARTURE = 8 * 60;
const LATE_TOLERANCE_MINUTES = 20;

function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = Math.round(total % 60);
  return hours ? `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}` : `${minutes} 分钟`;
}

/**
 * 可行性检查：当天要先花几个小时换城市，但到达城市的第一站安排得太早。
 * 作为当天一段路程的城际交通已经由排程按列车时长顺延，这里只检查“独立”的那些。
 */
export function transferWarnings(plan, transfers = []) {
  const warnings = [];
  for (const transfer of transfers) {
    if (transfer.attached_leg || !Number.isFinite(transfer.duration_seconds)) continue;
    const day = (plan.daily_plans || []).find(item => item.day === transfer.day);
    const first = (day?.spots || []).find(spot => sameCity(spot.city, transfer.to_city) && clock(spot.start_time) !== null);
    if (!first) continue;
    const arrival = (clock(transfer.depart_time) ?? DEFAULT_DEPARTURE) + transfer.duration_seconds / 60;
    if (clock(first.start_time) < arrival - LATE_TOLERANCE_MINUTES) {
      warnings.push(`第 ${transfer.day} 天从${transfer.from_city}到${transfer.to_city}约需 ${formatMinutes(transfer.duration_seconds / 60)}，${first.start_time} 的“${first.name}”可能赶不上`);
    }
  }
  return warnings;
}
