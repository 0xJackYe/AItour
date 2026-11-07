// 当日地点顺序优化（保守策略）。
//
// 大模型的排序有时会来回折返。这里在“不破坏时段语义”的前提下重排：
//  - 固定不动：餐厅、住宿、未定位地点，以及描述里带时段要求的地点（夜景、日出等）；
//  - 其余地点在剩余位置上做全排列（每天地点很少，穷举可得最优且结果可复现）；
//  - 起点为当天所在城市的推荐住宿（若距离合理）；
//  - 只有节省 ≥ 20% 且 ≥ 1km 时才采用，避免为微小收益打乱模型的安排。

import { centroid, haversineKm } from '../lib/geo.js';

const TIME_SENSITIVE = /夜|晚上|傍晚|日落|黄昏|日出|清晨|早晨|早上|一早|早起|开门|闭馆|night|evening|sunset|sunrise|dusk|dawn|morning/i;
const MAX_MOVABLE = 7;
const MIN_SAVING_KM = 1;
const MIN_SAVING_RATIO = 0.2;
const START_ANCHOR_MAX_KM = 30;

export function isPinned(spot) {
  if (!spot?.coordinates) return true;
  if (spot.type === 'restaurant' || spot.type === 'hotel') return true;
  return TIME_SENSITIVE.test(`${spot.name || ''} ${spot.description || ''} ${spot.tips || ''}`);
}

export function pathLengthKm(spots, start = null) {
  const points = spots.filter(spot => spot?.coordinates).map(spot => spot.coordinates);
  if (start) points.unshift(start);
  let total = 0;
  for (let index = 1; index < points.length; index++) total += haversineKm(points[index - 1], points[index]);
  return total;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let index = 0; index < items.length; index++) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index], ...tail];
  }
}

export function optimizeDayOrder(spots, { start = null } = {}) {
  const list = Array.isArray(spots) ? spots : [];
  const movableSlots = list.map((spot, index) => (isPinned(spot) ? -1 : index)).filter(index => index >= 0);
  const unchanged = { spots: list, optimized: false, savedKm: 0 };
  if (movableSlots.length < 2 || movableSlots.length > MAX_MOVABLE) return unchanged;

  const original = pathLengthKm(list, start);
  let best = list;
  let bestLength = original;
  const movable = movableSlots.map(index => list[index]);
  for (const order of permutations(movable)) {
    const candidate = list.slice();
    movableSlots.forEach((slot, position) => {
      candidate[slot] = order[position];
    });
    const length = pathLengthKm(candidate, start);
    if (length < bestLength - 1e-9) {
      best = candidate;
      bestLength = length;
    }
  }

  const saved = original - bestLength;
  if (saved >= MIN_SAVING_KM && original > 0 && saved / original >= MIN_SAVING_RATIO) {
    return { spots: best, optimized: true, savedKm: Math.round(saved * 10) / 10 };
  }
  return unchanged;
}

function startAnchorForDay(plan, day) {
  const located = (day.spots || []).filter(spot => spot.coordinates).map(spot => spot.coordinates);
  const center = centroid(located);
  if (!center) return null;
  const candidates = (plan.accommodations || []).filter(item => item.coordinates);
  const sameCity = candidates.filter(item => item.city && item.city === day.city);
  const pool = sameCity.length ? sameCity : candidates;
  let best = null;
  let bestDistance = Infinity;
  for (const item of pool) {
    const distance = haversineKm(item.coordinates, center);
    if (distance < bestDistance) {
      best = item.coordinates;
      bestDistance = distance;
    }
  }
  return bestDistance <= START_ANCHOR_MAX_KM ? best : null;
}

/** 对整份计划逐日优化。返回新计划与每天的优化结果（Map<day, {optimized, savedKm}>）。 */
export function optimizePlanOrder(plan) {
  const results = new Map();
  const dailyPlans = (plan.daily_plans || []).map((day) => {
    const outcome = optimizeDayOrder(day.spots || [], { start: startAnchorForDay(plan, day) });
    results.set(day.day, { optimized: outcome.optimized, savedKm: outcome.savedKm });
    return outcome.optimized ? { ...day, spots: outcome.spots } : day;
  });
  return { plan: { ...plan, daily_plans: dailyPlans }, results };
}
