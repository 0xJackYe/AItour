import test from 'node:test';
import assert from 'node:assert/strict';
import { isPinned, optimizeDayOrder, optimizePlanOrder, pathLengthKm } from '../services/optimize.js';

const at = (name, lat, lng, extra = {}) => ({ name, type: 'attraction', coordinates: { lat, lng }, ...extra });

// 一条东西向直线上的四个点：模型给出了来回折返的顺序 A → D → B → C。
const A = at('A', 35.0, 135.70);
const B = at('B', 35.0, 135.72);
const C = at('C', 35.0, 135.74);
const D = at('D', 35.0, 135.76);

test('来回折返的顺序会被优化，并报告节省的距离', () => {
  const original = [A, D, B, C];
  const result = optimizeDayOrder(original);
  assert.equal(result.optimized, true);
  assert.deepEqual(result.spots.map(spot => spot.name), ['A', 'B', 'C', 'D']);
  assert.ok(result.savedKm >= 1);
  assert.ok(pathLengthKm(result.spots) < pathLengthKm(original));
});

test('收益很小时保持模型原顺序（节省不足 1km）', () => {
  // 同样的折返形状，但缩小到街区尺度：只能节省约 180m。
  const a = at('a', 35.0, 135.700);
  const b = at('b', 35.0, 135.702);
  const c = at('c', 35.0, 135.704);
  const d = at('d', 35.0, 135.706);
  const result = optimizeDayOrder([a, b, d, c]);
  assert.equal(result.optimized, false);
  assert.deepEqual(result.spots.map(spot => spot.name), ['a', 'b', 'd', 'c']);
});

test('收益比例很小时保持模型原顺序（节省不足 20%）', () => {
  // 长距离路线末端的小绕路：节省超过 1km，但不到总长的 20%。
  const far = [at('p', 35.0, 135.0), at('q', 35.0, 135.5), at('r', 35.0, 136.0), at('t', 35.0, 136.03), at('s', 35.0, 136.015)];
  const result = optimizeDayOrder(far);
  assert.equal(result.optimized, false);
});

test('餐厅、未定位和有时段要求的地点固定在原位置', () => {
  const dinner = at('晚餐', 35.0, 135.76, { type: 'restaurant' });
  const nightView = at('夜景台', 35.0, 135.70, { tips: '适合傍晚看日落' });
  const unlocated = { name: '未定位', type: 'attraction', coordinates: null };
  assert.equal(isPinned(dinner), true);
  assert.equal(isPinned(nightView), true);
  assert.equal(isPinned(unlocated), true);
  assert.equal(isPinned(A), false);

  const result = optimizeDayOrder([A, D, unlocated, B, C, dinner]);
  assert.equal(result.spots[2].name, '未定位');
  assert.equal(result.spots[5].name, '晚餐');
});

test('以住宿为起点计算路线长度', () => {
  const hotel = { lat: 35.0, lng: 135.77 };
  const result = optimizeDayOrder([A, B, C, D], { start: hotel });
  assert.equal(result.optimized, true);
  assert.deepEqual(result.spots.map(spot => spot.name), ['D', 'C', 'B', 'A']);
});

test('整份计划逐日优化并返回每天的结果', () => {
  const plan = {
    accommodations: [],
    daily_plans: [{ day: 1, city: 'X', spots: [A, D, B, C] }, { day: 2, city: 'X', spots: [A] }],
  };
  const { plan: optimized, results } = optimizePlanOrder(plan);
  assert.equal(results.get(1).optimized, true);
  assert.equal(results.get(2).optimized, false);
  assert.deepEqual(optimized.daily_plans[0].spots.map(spot => spot.name), ['A', 'B', 'C', 'D']);
});
