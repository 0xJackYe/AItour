import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicWarnings, findMissingDays, mergeDays, normalizePlan } from '../services/planSchema.js';

test('规范化：类型、枚举、时长和字符串长度', () => {
  const plan = normalizePlan({
    title: '  京都   三日游 ',
    city: '京都',
    country: '日本',
    preferences: { pace: '轻松', budget: 'Luxury', transport: '自驾', interests: ['文化', 42, ''] },
    daily_plans: [{
      day: '1',
      spots: [
        { name: '清水寺', type: '景点', duration_hours: '2.4' },
        { name: '锦市场', type: 'food', duration_hours: 99 },
        { name: '', name_en: '' },
        null,
      ],
    }],
  });
  assert.equal(plan.title, '京都 三日游');
  assert.deepEqual(plan.preferences, { pace: 'relaxed', budget: 'luxury', transport: 'drive', interests: ['文化'] });
  assert.equal(plan.daily_plans[0].day, 1);
  assert.equal(plan.daily_plans[0].spots.length, 2);
  assert.equal(plan.daily_plans[0].spots[0].type, 'attraction');
  assert.equal(plan.daily_plans[0].spots[0].duration_hours, 2.5);
  assert.equal(plan.daily_plans[0].spots[1].type, 'restaurant');
  assert.equal(plan.daily_plans[0].spots[1].duration_hours, 12);
  // 缺失的 city/country 由当天/计划继承。
  assert.equal(plan.daily_plans[0].spots[0].city, '京都');
});

test('规范化：重复的 Day 保留更完整的一份并排序，超出天数的被裁掉', () => {
  const plan = normalizePlan({
    city: '东京',
    daily_plans: [
      { day: 2, spots: [{ name: 'A' }] },
      { day: 1, spots: [{ name: 'B' }] },
      { day: 2, spots: [{ name: 'C' }, { name: 'D' }] },
      { day: 3, spots: [{ name: 'E' }] },
    ],
  }, { expectedDays: 2 });
  assert.deepEqual(plan.daily_plans.map(day => day.day), [1, 2]);
  assert.deepEqual(plan.daily_plans[1].spots.map(spot => spot.name), ['C', 'D']);
  assert.equal(plan.days, 2);
});

test('规范化：同一天重复地点去重', () => {
  const plan = normalizePlan({
    city: '京都',
    daily_plans: [{ day: 1, spots: [{ name: '清水寺', name_en: 'Kiyomizu-dera' }, { name: '清水寺', name_en: 'Kiyomizu-dera' }] }],
  });
  assert.equal(plan.daily_plans[0].spots.length, 1);
});

test('单城市行程保留模型标注的一日游城市（京都 → 奈良）', () => {
  const plan = normalizePlan({
    city: '京都', country: '日本',
    destinations: [{ city: '京都', country: '日本', start_day: 1, end_day: 1 }],
    daily_plans: [{ day: 1, city: '京都', spots: [{ name: '奈良公园', name_en: 'Nara Park', city: '奈良', country: '日本' }] }],
  });
  assert.equal(plan.daily_plans[0].spots[0].city, '奈良');
});

test('住宿：兼容旧的单个 accommodation 字段', () => {
  const plan = normalizePlan({ city: '京都', country: '日本', accommodation: { area: '四条', landmark: '河原町站' }, daily_plans: [] });
  assert.equal(plan.accommodations.length, 1);
  assert.equal(plan.accommodations[0].city, '京都');
  assert.equal(plan.accommodation.area, '四条');
});

test('findMissingDays 同时找出缺失和空白的天', () => {
  const plan = normalizePlan({ city: '京都', daily_plans: [{ day: 1, spots: [{ name: 'A' }] }, { day: 2, spots: [] }] });
  assert.deepEqual(findMissingDays(plan, 4), [2, 3, 4]);
  assert.deepEqual(findMissingDays(plan, null), []);
});

test('mergeDays 按 Day 编号覆盖并保持顺序', () => {
  const plan = normalizePlan({ city: '京都', daily_plans: [{ day: 1, spots: [{ name: 'A' }] }, { day: 3, spots: [{ name: 'C' }] }] });
  const merged = mergeDays(plan, [{ day: 2, spots: [{ name: 'B' }] }]);
  assert.deepEqual(merged.daily_plans.map(day => day.day), [1, 2, 3]);
});

test('确定性检查：节奏过满与跨天重复', () => {
  const plan = normalizePlan({
    city: '京都',
    preferences: { pace: 'relaxed' },
    daily_plans: [
      { day: 1, spots: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name })) },
      { day: 2, spots: [{ name: 'A' }] },
    ],
  });
  const warnings = deterministicWarnings(plan);
  assert.ok(warnings.some(item => item.includes('Day 1') && item.includes('偏紧')));
  assert.ok(warnings.some(item => item.includes('重复')));
});

test('只输出白名单字段：模型生成的额外字段不会进入响应', () => {
  const plan = normalizePlan({
    title: 't',
    city: '京都',
    injected: 'x'.repeat(1000),
    daily_plans: [{ day: 1, junk: true, spots: [{ name: 'A', html: '<script>alert(1)</script>' }] }],
    accommodations: [{ area: '四条', extra: 1 }],
  });
  assert.equal(plan.injected, undefined);
  assert.equal(plan.daily_plans[0].junk, undefined);
  assert.equal(plan.daily_plans[0].spots[0].html, undefined);
  assert.equal(plan.accommodations[0].extra, undefined);
});
