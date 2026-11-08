// 当日地点顺序优化（保守策略）。
//
// 大模型的排序有时会来回折返。这里在“不破坏时段语义”的前提下重排：
//  - 固定不动：餐厅、住宿、车站、未定位地点；名称或介绍写明是夜景、日出、演出等
//    时段活动的地点；以及安排在 18:00 以后或 8:00 以前的地点。
//    （提示里“早上人少”“开门时间”这类建议不算时段要求，否则介绍写得越详细，
//    能优化的地点就越少。）
//  - 其余地点在剩余位置上做全排列（每天地点很少，穷举可得最优且结果可复现）；
//  - 起点为当天所在城市的推荐住宿（若距离合理）；
//  - 只有节省 ≥ 20% 且 ≥ 1km 时才采用，避免为微小收益打乱模型的安排。

import { centroid, haversineKm } from '../lib/geo.js';

const TIME_BOUND = /夜景|夜市|夜游|夜间|夜场|灯光秀|亮灯|点灯|日落|日出|晚霞|黄昏|看海上日出|演出|表演|剧场|音乐剧|歌剧|night|sunset|sunrise|show|concert|musical/i;
const PINNED_TYPES = new Set(['restaurant', 'hotel', 'transport']);
const EVENING_MINUTES = 18 * 60;
const EARLY_MINUTES = 8 * 60;
const AFTERNOON_MINUTES = 15 * 60;

function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
const MAX_MOVABLE = 7;
const MIN_SAVING_KM = 1;
const MIN_SAVING_RATIO = 0.2;
const START_ANCHOR_MAX_KM = 30;

export function isPinned(spot) {
  if (!spot?.coordinates) return true;
  if (PINNED_TYPES.has(spot.type)) return true;
  const minutes = clockMinutes(spot.start_time);
  if (minutes !== null && (minutes >= EVENING_MINUTES || minutes < EARLY_MINUTES)) return true;
  // 介绍里提到“夜景很美”但安排在上午的地点并没有时段要求，可以参与重排。
  if (minutes !== null && minutes < AFTERNOON_MINUTES) return false;
  return TIME_BOUND.test(`${spot.name || ''} ${spot.description || ''}`);
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
    // 时间跟着“时段”走而不是跟着地点走：午餐仍在 12:00，只是上午先去更近的景点。
    const reordered = best.map((spot, index) => (list[index].start_time ? { ...spot, start_time: list[index].start_time } : spot));
    return { spots: reordered, optimized: true, savedKm: Math.round(saved * 10) / 10 };
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
