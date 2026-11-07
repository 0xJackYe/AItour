// 地点落地（grounding）：把大模型给出的地点名解析为 Google 上真实存在的地点，
// 并拦截“外地同名地点”。
//
// 判定规则（isInTargetCity）：
//  1. 国家必须一致；
//  2. 距城市中心在“都市圈半径”内直接通过（半径由城市视口推算，40–80km），
//     这样凡尔赛宫（巴黎）、东京迪士尼（千叶县浦安）等近郊地点不会被误删；
//  3. 超出半径时，普通大小的城市允许位于视口内；超大视口（如东京都含远海
//     岛屿）必须行政区名称匹配（如北京市怀柔区的慕田峪长城）；
//  4. 超过 150km 一律拒绝（静冈的同名神社不会混入东京行程）。
//
// 地点处理策略：
//  - verified：名称与位置都通过，进入地图与路线；
//  - unverified：Google 找不到或名称对不上，保留在行程里但不上图，并给出提示；
//  - removed：Google 确认该名称的地点位于其他城市，从行程中剔除并给出原因。

import { isAbortError } from '../lib/errors.js';
import { mapWithConcurrency } from '../lib/async.js';
import { currentSignal } from '../lib/context.js';
import { haversineKm, isInsideViewport, viewportDiagonalKm } from '../lib/geo.js';
import { log } from '../lib/log.js';
import { geocodeAddress, isGoogleConfigured, placeToCoordinates, searchPlacesText } from './google.js';
import { destinationForDay, isMultiCityLabel, singleCountry } from './planSchema.js';

export const DEFAULT_METRO_RADIUS_KM = 40;
const MAX_METRO_RADIUS_KM = 80;
const LARGE_VIEWPORT_KM = 120;
const LARGE_VIEWPORT_RADIUS_KM = 60;
const ADMINISTRATIVE_MAX_KM = 150;
export const DAY_TRIP_MAX_KM = 150;
export const MULTI_CITY_MAX_KM = 500;

export function metroRadiusKm(viewport) {
  const diagonal = viewportDiagonalKm(viewport);
  if (!Number.isFinite(diagonal)) return DEFAULT_METRO_RADIUS_KM;
  if (diagonal > LARGE_VIEWPORT_KM) return LARGE_VIEWPORT_RADIUS_KM;
  return Math.min(MAX_METRO_RADIUS_KM, Math.max(DEFAULT_METRO_RADIUS_KM, diagonal * 0.75));
}

function normalizeViewport(geometry) {
  const viewport = geometry?.bounds || geometry?.viewport;
  if (!viewport?.southwest || !viewport?.northeast) return null;
  return {
    low: { latitude: viewport.southwest.lat, longitude: viewport.southwest.lng },
    high: { latitude: viewport.northeast.lat, longitude: viewport.northeast.lng },
  };
}

function geocoderCountryCode(result) {
  return result?.address_components
    ?.find(component => component.types?.includes('country'))
    ?.short_name?.toUpperCase() || null;
}

function normalizeAdministrativeName(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(?:city|prefecture|province|county|district|metropolis)$/g, '')
    .replace(/(?:特别行政区|自治区|自治州|省|市|区|县|都|府|州)$/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function targetAdministrativeNames(city, result) {
  const firstAdministrative = result?.address_components?.find(component =>
    component.types?.some(type =>
      type === 'locality'
      || type === 'postal_town'
      || type.startsWith('administrative_area_level_')),
  );
  return [...new Set([
    city,
    firstAdministrative?.long_name,
    firstAdministrative?.short_name,
  ].map(normalizeAdministrativeName).filter(Boolean))];
}

function placeCountryCode(place) {
  return place?.addressComponents
    ?.find(component => component.types?.includes('country'))
    ?.shortText?.toUpperCase() || null;
}

/** true / false / null（无法判断）。 */
function administrativeMatch(place, cityContext) {
  const candidates = (place.addressComponents || [])
    .filter(component => component.types?.some(type =>
      type === 'locality'
      || type === 'postal_town'
      || type === 'sublocality'
      || type.startsWith('sublocality_level_')
      || type.startsWith('administrative_area_level_')))
    .flatMap(component => [component.longText, component.shortText])
    .map(normalizeAdministrativeName)
    .filter(Boolean);
  const targets = cityContext.targetAdministrativeNames || [];
  if (targets.length === 0 || candidates.length === 0) return null;
  return targets.some(target => candidates.some(candidate =>
    candidate === target
    || (Math.min(candidate.length, target.length) >= 4 && (candidate.includes(target) || target.includes(candidate)))));
}

export function isInTargetCity(place, cityContext) {
  if (!cityContext || !place?.location) return true;
  const candidateCountry = placeCountryCode(place);
  if (cityContext.countryCode && candidateCountry && candidateCountry !== cityContext.countryCode) return false;
  const distance = haversineKm(place.location, cityContext);
  const radius = cityContext.radiusKm ?? metroRadiusKm(cityContext.viewport);
  if (distance <= radius) return true;
  if (distance > ADMINISTRATIVE_MAX_KM) return false;
  if (viewportDiagonalKm(cityContext.viewport) <= LARGE_VIEWPORT_KM && isInsideViewport(place.location, cityContext.viewport)) {
    return true;
  }
  return administrativeMatch(place, cityContext) === true;
}

// ───────────────────────────── 名称匹配 ─────────────────────────────

const GENERIC_PLACE_WORDS = new Set([
  'the', 'of', 'and', 'in', 'at', 'old', 'new', 'saint', 'st',
  'museum', 'church', 'cathedral', 'basilica', 'palace', 'castle', 'fortress',
  'bridge', 'square', 'street', 'park', 'garden', 'gardens', 'station', 'center', 'centre',
  'mount', 'mountain', 'lake', 'river', 'island', 'tower', 'temple', 'shrine',
  'city', 'town', 'historic', 'historical', 'market', 'restaurant', 'hotel',
]);
const CJK_CHAR = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

function nameTokens(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function compactPlaceName(value = '') {
  return nameTokens(value).join('');
}

function tokenMatches(left, right) {
  return left === right
    || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)));
}

function cjkText(value = '') {
  return [...String(value)].filter(ch => CJK_CHAR.test(ch)).join('');
}

function stripLocationWords(value, words) {
  let result = value;
  for (const word of words) if (word.length >= 2) result = result.split(word).join('');
  return result;
}

function cjkNameMatches(expectedName, candidateName, city, country) {
  const locationWords = [cjkText(city), cjkText(country)];
  let expected = cjkText(expectedName);
  let candidate = cjkText(candidateName);
  // 去掉城市/国家名后两边都还有实质内容时才使用去除后的版本（“成都武侯祠” vs “武侯祠博物馆”）；
  // 否则保留原文比较（“东京塔” vs “东京铁塔”）。
  const strippedExpected = stripLocationWords(expected, locationWords);
  const strippedCandidate = stripLocationWords(candidate, locationWords);
  if (strippedExpected.length >= 2 && strippedCandidate.length >= 2) {
    expected = strippedExpected;
    candidate = strippedCandidate;
  }
  if (expected.length < 2 || candidate.length < 2) return expected === candidate;
  if (candidate.includes(expected) || (candidate.length >= 3 && expected.includes(candidate))) return true;
  // 字符覆盖率：兼容简繁 / 日文汉字差异（伏见 vs 伏見）。
  const candidateChars = new Set(candidate);
  const covered = [...expected].filter(ch => candidateChars.has(ch)).length;
  return covered / expected.length >= 0.75;
}

export function placeNameMatches(place, expectedName, city = '', country = '') {
  const candidateName = place?.displayName?.text || '';
  if (!candidateName || !expectedName) return true;
  if (CJK_CHAR.test(expectedName) && CJK_CHAR.test(candidateName)) {
    return cjkNameMatches(expectedName, candidateName, city, country);
  }

  const expectedCompact = compactPlaceName(expectedName);
  const candidateCompact = compactPlaceName(candidateName);
  if (expectedCompact.length >= 4 && candidateCompact.length >= 4
    && (expectedCompact.includes(candidateCompact) || candidateCompact.includes(expectedCompact))) {
    return true;
  }

  const locationWords = new Set([...nameTokens(city), ...nameTokens(country)]);
  const expectedTokens = nameTokens(expectedName).filter(token => token.length >= 3 && !locationWords.has(token));
  const candidateTokens = nameTokens(candidateName).filter(token => token.length >= 3);
  const distinctiveExpected = expectedTokens.filter(token => !GENERIC_PLACE_WORDS.has(token));
  const distinctiveCandidate = candidateTokens.filter(token => !GENERIC_PLACE_WORDS.has(token));

  if (distinctiveExpected.length > 0 && distinctiveCandidate.length > 0) {
    const matches = distinctiveExpected.filter(expected =>
      distinctiveCandidate.some(candidate => tokenMatches(expected, candidate)));
    if (matches.length / distinctiveExpected.length >= 0.5) return true;
    return distinctiveExpected.length <= 3 && matches.some(token => token.length >= 5);
  }
  // 只剩通用词（如 “Kyoto Tower”）时，要求通用词本身对得上，避免把京都站当成京都塔。
  if (expectedTokens.length === 0) return true;
  const genericMatches = expectedTokens.filter(expected => candidateTokens.some(candidate => tokenMatches(expected, candidate)));
  return genericMatches.length / expectedTokens.length >= 0.5;
}

// ───────────────────────────── 城市锚点 ─────────────────────────────

export async function geocodeCity(city, country = '') {
  if (!city) return null;
  try {
    // 城市锚点用英文返回，才能稳定比较 Tokyo/Shizuoka、Roma/Firenze 等行政区名称。
    const results = await geocodeAddress([city, country].filter(Boolean).join(', '), 'en');
    const result = results[0];
    if (!result?.geometry?.location) return null;
    const viewport = normalizeViewport(result.geometry);
    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      display_name: result.formatted_address,
      viewport,
      radiusKm: metroRadiusKm(viewport),
      place_id: result.place_id || null,
      cityName: city,
      countryName: country,
      countryCode: geocoderCountryCode(result),
      targetAdministrativeNames: targetAdministrativeNames(city, result),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn('geocode.city_failed', { city, country, message: error.message });
    return null;
  }
}

// ───────────────────────────── 地点查找 ─────────────────────────────

const STATUS_RANK = { verified: 3, outside_target: 2, name_mismatch: 1, not_found: 0 };

function moreInformative(left, right) {
  if (!left) return right;
  if (!right) return left;
  return (STATUS_RANK[right.status] ?? -1) > (STATUS_RANK[left.status] ?? -1) ? right : left;
}

async function searchWithin(query, context, languageCode) {
  if (!context?.viewport) return [];
  try {
    return await searchPlacesText(query, {
      locationRestriction: context.viewport,
      pageSize: 5,
      regionCode: context.countryCode,
      languageCode,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn('geocode.restricted_search_failed', { message: error.message });
    return [];
  }
}

async function searchAround(query, context, languageCode) {
  return searchPlacesText(query, {
    locationBias: context
      ? {
          circle: {
            center: { latitude: context.lat, longitude: context.lng },
            radius: Math.min(50000, Math.round((context.radiusKm || DEFAULT_METRO_RADIUS_KM) * 1000)),
          },
        }
      : null,
    pageSize: 5,
    regionCode: context?.countryCode || null,
    languageCode,
  });
}

/** 在一个城市上下文中查找地点。返回 { status, coordinates, place?, reason? }。 */
export async function findPlace(query, { city = '', country = '', context = null } = {}) {
  const queryHasCity = city && query.toLowerCase().includes(city.toLowerCase());
  const fullQuery = [query, queryHasCity ? '' : city, country].filter(Boolean).join(', ');
  const languageCode = /[㐀-鿿]/u.test(query) ? 'zh-CN' : 'en';
  const accept = place => placeNameMatches(place, query, city, country) && isInTargetCity(place, context);

  const restricted = await searchWithin(fullQuery, context, languageCode);
  const restrictedMatch = restricted.find(accept);
  if (restrictedMatch) return { status: 'verified', coordinates: placeToCoordinates(restrictedMatch), place: restrictedMatch };

  // 第二轮：以城市中心为圆心的软偏好搜索，覆盖视口矩形之外的近郊地点；
  // 结果仍须通过同样的名称与位置校验。
  const around = await searchAround(fullQuery, context, languageCode);
  const aroundMatch = around.find(accept);
  if (aroundMatch) return { status: 'verified', coordinates: placeToCoordinates(aroundMatch), place: aroundMatch };

  const candidates = [...restricted, ...around];
  if (candidates.length === 0) {
    return { status: 'not_found', coordinates: null, reason: `Google 地图未在 ${city || '目标区域'} 找到该地点` };
  }
  const sameName = candidates.find(place => placeNameMatches(place, query, city, country));
  if (sameName && context) {
    const distance = Math.round(haversineKm(sameName.location, context));
    return {
      status: 'outside_target',
      coordinates: null,
      place: sameName,
      reason: Number.isFinite(distance)
        ? `Google 地图上的同名地点距 ${city} 约 ${distance}km，不在该城市`
        : `Google 地图上的同名地点不在 ${city}`,
    };
  }
  const nearby = candidates.find(place => isInTargetCity(place, context)) || candidates[0];
  return {
    status: 'name_mismatch',
    coordinates: null,
    place: nearby,
    reason: `Google 地图最接近的结果是“${nearby.displayName?.text || '未知地点'}”，与计划地点名称不一致`,
  };
}

async function findInContext(spot, { city, country, context }) {
  const queries = [...new Set([spot.name_en, spot.name].filter(Boolean))];
  let best = null;
  for (const query of queries) {
    const result = await findPlace(query, { city, country, context });
    if (result.status === 'verified') return result;
    best = moreInformative(best, result);
  }
  return best || { status: 'not_found', coordinates: null, reason: '没有可搜索的地点名称' };
}

/**
 * 解析单个地点：先在地点自身声明的城市查找；若该城市不是当天的基准城市，
 * 还要满足一日游距离上限；失败时回退到基准城市再找一次（纠正模型标错城市）。
 */
export async function locateSpot(spot, { spotTarget, spotContext, baseTarget, baseContext, dayTripLimitKm = DAY_TRIP_MAX_KM }) {
  const sameAsBase = !baseContext || spotContext === baseContext;
  let result = await findInContext(spot, { ...spotTarget, context: spotContext });

  if (result.status === 'verified' && !sameAsBase) {
    const distance = haversineKm(result.coordinates, baseContext);
    if (distance > dayTripLimitKm) {
      result = {
        status: 'outside_target',
        coordinates: null,
        place: result.place,
        reason: `位于 ${spotTarget.city}，距 ${baseTarget.city} 约 ${Math.round(distance)}km，超出当日可往返范围`,
      };
    }
  }
  if (result.status !== 'verified' && !sameAsBase) {
    const fallback = await findInContext(spot, { ...baseTarget, context: baseContext });
    if (fallback.status === 'verified') return { ...fallback, correctedCity: baseTarget };
    result = moreInformative(result, fallback);
  }
  return result;
}

export function spotLocationKey(dayIndex, spotIndex) {
  return `day:${dayIndex}:spot:${spotIndex}`;
}

function cityKey(city, country) {
  return `${city || ''}\u0000${country || ''}`;
}

function baseTargetForDay(plan, day) {
  const destination = destinationForDay(plan.destinations, day.day);
  if (destination) return { city: destination.city, country: destination.country || singleCountry(plan.country) };
  const planCity = isMultiCityLabel(plan.city) ? '' : plan.city;
  if (planCity) return { city: planCity, country: day.country || singleCountry(plan.country) };
  return { city: day.city, country: day.country };
}

function withoutCoordinates(plan) {
  return {
    ...plan,
    accommodations: (plan.accommodations || []).map(item => ({ ...item, coordinates: null })),
    daily_plans: (plan.daily_plans || []).map((day, dayIndex) => ({
      ...day,
      spots: (day.spots || []).map((spot, spotIndex) => ({
        ...spot,
        location_id: spotLocationKey(dayIndex, spotIndex),
        location_status: 'unverified',
        coordinates: null,
      })),
    })),
  };
}

function summarize(plan, extra = {}) {
  const spots = (plan.daily_plans || []).flatMap(day => day.spots || []);
  return {
    total: spots.length + (extra.removed || 0),
    verified: spots.filter(spot => spot.coordinates).length,
    unverified: spots.filter(spot => !spot.coordinates).length,
    removed: extra.removed || 0,
    maps_errors: extra.mapsErrors || 0,
  };
}

/** 为整份计划落地坐标。返回 { plan, warnings, rejectedSpots, geocodedCount, stats }。 */
export async function geocodeAllSpots(plan) {
  if (!isGoogleConfigured()) {
    const ungrounded = withoutCoordinates(plan);
    return {
      plan: { ...ungrounded, accommodation: ungrounded.accommodations[0] || null },
      warnings: [{ name: '地图服务', reason: '服务端未配置 Google Maps Key，地点暂未在地图上定位', code: 'maps_unavailable', removed: false }],
      rejectedSpots: [],
      geocodedCount: 0,
      stats: summarize(ungrounded),
    };
  }

  const warnings = [];
  const rejectedSpots = [];
  const singleDestination = (plan.destinations || []).length <= 1;
  const dayTripLimitKm = singleDestination ? DAY_TRIP_MAX_KM : MULTI_CITY_MAX_KM;
  const accommodations = plan.accommodations || [];

  const targets = new Map();
  const addTarget = (city, country) => {
    if (city) targets.set(cityKey(city, country), { city, country: country || '' });
  };
  for (const day of plan.daily_plans || []) {
    const base = baseTargetForDay(plan, day);
    addTarget(base.city, base.country);
    for (const spot of day.spots || []) addTarget(spot.city || base.city, spot.country || base.country);
  }
  for (const item of accommodations) addTarget(item.city, item.country);

  const contexts = new Map();
  await mapWithConcurrency([...targets.entries()], 6, async ([key, target]) => {
    const context = await geocodeCity(target.city, target.country);
    contexts.set(key, context);
    if (!context) {
      warnings.push({
        name: `${target.city}${target.country ? `, ${target.country}` : ''}`,
        reason: '未能确定城市范围，该城市的地点只接受名称完全匹配的结果',
        code: 'city_context_missing',
        removed: false,
      });
    }
  });

  const jobs = (plan.daily_plans || []).flatMap((day, dayIndex) => {
    const baseTarget = baseTargetForDay(plan, day);
    const baseContext = contexts.get(cityKey(baseTarget.city, baseTarget.country)) || null;
    return (day.spots || []).map((spot, spotIndex) => {
      const spotTarget = { city: spot.city || baseTarget.city, country: spot.country || baseTarget.country };
      const spotContext = contexts.get(cityKey(spotTarget.city, spotTarget.country)) || null;
      return { day, dayIndex, spot, spotIndex, spotTarget, spotContext, baseTarget, baseContext };
    });
  });

  let mapsErrors = 0;
  const results = await mapWithConcurrency(jobs, 8, async (job) => {
    try {
      return await locateSpot(job.spot, { ...job, dayTripLimitKm });
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      mapsErrors++;
      log.warn('geocode.spot_failed', { spot: job.spot.name, code: error.code, message: error.message });
      return { status: 'error', coordinates: null, reason: `地图服务暂时不可用：${error.message}` };
    }
  });

  const resultByKey = new Map();
  let geocodedCount = 0;
  jobs.forEach((job, index) => {
    const result = results[index];
    const key = spotLocationKey(job.dayIndex, job.spotIndex);
    resultByKey.set(key, result);
    if (result.status === 'verified') {
      geocodedCount++;
      return;
    }
    const removed = result.status === 'outside_target';
    const warning = {
      name: `Day ${job.day.day} · ${job.spot.name}`,
      city: job.spotTarget.city,
      country: job.spotTarget.country,
      reason: result.reason || 'Google 地图未找到该地点',
      code: result.status,
      removed,
    };
    if (result.status !== 'error') warnings.push(warning);
    if (removed) rejectedSpots.push({ ...warning, spot: job.spot, day: job.day.day });
  });
  if (mapsErrors > 0) {
    warnings.push({
      name: '地图服务',
      reason: `${mapsErrors} 个地点因 Google 地图服务异常暂未定位，可稍后重新生成`,
      code: 'maps_error',
      removed: false,
    });
  }

  const accommodationResults = await mapWithConcurrency(accommodations, 4, async (item) => {
    const context = contexts.get(cityKey(item.city, item.country)) || null;
    const queries = [...new Set([item.landmark, item.area].filter(Boolean))];
    let best = null;
    for (const query of queries) {
      try {
        const result = await findPlace(query, { city: item.city, country: item.country, context });
        if (result.status === 'verified') return result;
        best = moreInformative(best, result);
      } catch (error) {
        if (isAbortError(error) || currentSignal()?.aborted) throw error;
        best = { status: 'error', coordinates: null, reason: error.message };
      }
    }
    return best;
  });

  const enrichedAccommodations = accommodations.map((item, index) => {
    const result = accommodationResults[index];
    if (result?.status === 'verified') {
      geocodedCount++;
      return { ...item, coordinates: result.coordinates };
    }
    warnings.push({
      name: `住宿 · ${[item.city, item.landmark || item.area].filter(Boolean).join(' ')}`,
      city: item.city || '',
      country: item.country || '',
      reason: result?.reason || 'Google 地图未找到住宿地标',
      code: result?.status || 'not_found',
      removed: false,
    });
    return { ...item, coordinates: null };
  });

  const dailyPlans = (plan.daily_plans || []).map((day, dayIndex) => ({
    ...day,
    spots: (day.spots || []).flatMap((spot, spotIndex) => {
      const key = spotLocationKey(dayIndex, spotIndex);
      const result = resultByKey.get(key);
      if (result?.status === 'outside_target') return [];
      return [{
        ...spot,
        ...(result?.correctedCity ? { city: result.correctedCity.city, country: result.correctedCity.country || spot.country } : {}),
        location_id: key,
        location_status: result?.status === 'verified' ? 'verified' : 'unverified',
        coordinates: result?.coordinates || null,
      }];
    }),
  }));

  const enrichedPlan = {
    ...plan,
    accommodations: enrichedAccommodations,
    accommodation: enrichedAccommodations[0] || null,
    daily_plans: dailyPlans,
  };
  return {
    plan: enrichedPlan,
    warnings,
    rejectedSpots,
    geocodedCount,
    stats: summarize(enrichedPlan, { removed: rejectedSpots.length, mapsErrors }),
  };
}
