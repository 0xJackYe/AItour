import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBudgetSummary,
  buildExecutableItinerary,
  selectLegMode,
} from '../services/itinerary.js';
import { calculatePlanRoutes } from '../routes/plan.js';
import { validatePlanHealth } from '../services/health.js';

const profile = {
  days: 2,
  startDate: '2026-10-01',
  budget: { level: 'moderate', amount: 5000, currency: 'CNY', basis: 'total', hardLimit: true },
  pace: 'relaxed',
  transport: { priority: 'transit', allowedModes: ['WALK', 'TRANSIT'], avoidModes: [] },
  travelers: { adults: 2, children: 0, seniors: 0 },
  maxWalkingKm: 0.5,
  dailyStartTime: '09:00',
  dailyEndTime: '20:00',
  interests: [], accommodation: {}, dietaryNeeds: [], accessibilityNeeds: [], notes: '',
};

function sourcePlan() {
  return {
    title: '京都两日', city: '京都', country: '日本', days: 2,
    accommodations: [{ city: '京都', country: '日本', landmark: 'Kyoto Station', coordinates: { lat: 35, lng: 135.75 } }],
    daily_plans: [1, 2].map(day => ({
      day, city: '京都', country: '日本', spots: [{
        name: `景点${day}`, name_en: `Spot ${day}`, city: '京都', country: '日本',
        duration_hours: 1, coordinates: { lat: 35 + day * 0.01, lng: 135.76 },
      }],
    })),
  };
}

test('编译器生成稳定 ID、酒店首尾、逐段交通、时间轴、stage 和跨日连接', () => {
  const first = buildExecutableItinerary(sourcePlan(), profile);
  const second = buildExecutableItinerary(sourcePlan(), profile);
  assert.equal(first.id, second.id);
  assert.equal(first.daily_plans[0].nodes[1].id, second.daily_plans[0].nodes[1].id);
  assert.equal(first.stages.length, 1);
  assert.equal(first.daily_plans[0].nodes[0].role, 'start_anchor');
  assert.equal(first.daily_plans[0].nodes.at(-1).role, 'end_anchor');
  assert.equal(first.daily_plans[0].legs.length, first.daily_plans[0].nodes.length - 1);
  assert.equal(first.daily_plans[0].connection_to_next.type, 'overnight');
  assert.ok(first.daily_plans[0].nodes[1].start_time);
});

test('预算口径按天数和同行人确定性换算', () => {
  const plan = sourcePlan();
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_day' } }).limit, 200);
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_person_total' } }).limit, 200);
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_person_day' } }).limit, 400);
});

test('预算只统计带币种和口径的显式费用，未知费用不会伪装成零元', () => {
  const plan = sourcePlan();
  plan.daily_plans[0].spots[0].estimated_cost = null;
  plan.daily_plans[1].spots[0].cost = {
    amount: 80, currency: 'CNY', basis: 'per_person', category: 'activities',
  };
  const summary = buildBudgetSummary(plan, profile);
  assert.equal(summary.known_total, 160);
  assert.equal(summary.costed_items, 1);
  assert.equal(summary.total_items, 2);
  assert.equal(summary.coverage, 0.5);
  assert.equal(summary.status, 'estimated');
});

test('预算排除空值、缺失口径和币种不一致的费用', () => {
  const plan = sourcePlan();
  plan.daily_plans[0].spots[0].cost = { amount: null, currency: 'CNY', basis: 'group_total' };
  plan.daily_plans[1].spots[0].cost = { amount: 1000, currency: 'JPY', basis: 'group_total' };
  const summary = buildBudgetSummary(plan, profile);
  assert.equal(summary.known_total, 0);
  assert.equal(summary.costed_items, 0);
  assert.equal(summary.currency_mismatch_items, 1);
  assert.equal(summary.coverage, 0);
  assert.equal(summary.status, 'unknown');
});

test('真实逐段路线回写后确定性 health 通过连续性校验', async () => {
  let plan = buildExecutableItinerary(sourcePlan(), profile);
  plan = await calculatePlanRoutes(plan, {
    routeProvider: async ({ origin, destination }) => ({
      provider: 'test', geometry: [[origin.lat, origin.lng], [destination.lat, destination.lng]],
      distance_meters: 1000, duration_seconds: 600,
    }),
  });
  const health = validatePlanHealth(plan, profile);
  assert.equal(health.passed, true);
  assert.equal(health.metrics.route_coverage, 1);
  assert.ok(plan.daily_plans.every(day => day.legs.every(leg => leg.status === 'available')));
});

test('路线服务失败时保留明确标记的估算耗时，时间轴不会压缩成零分钟', async () => {
  let plan = buildExecutableItinerary(sourcePlan(), profile);
  const originalDuration = plan.daily_plans[0].legs[0].duration_seconds;
  plan = await calculatePlanRoutes(plan, { routeProvider: async () => null });
  const leg = plan.daily_plans[0].legs[0];
  assert.equal(leg.status, 'unavailable');
  assert.equal(leg.duration_seconds, originalDuration);
  assert.equal(leg.estimated, true);
  assert.notEqual(plan.daily_plans[0].nodes[0].end_time, plan.daily_plans[0].nodes[1].start_time);
  assert.equal(leg.geometry, null);
});

test('超过步行上限时会选择允许的公共交通', () => {
  const selected = selectLegMode(
    { city: '京都', coordinates: { lat: 35, lng: 135 } },
    { city: '京都', coordinates: { lat: 35.1, lng: 135.1 } },
    profile,
  );
  assert.equal(selected.mode, 'TRANSIT');
});

test('换城日会生成并计算独立跨日交通连接', async () => {
  const source = sourcePlan();
  source.city = '多城市';
  source.accommodations.push({ city: '大阪', country: '日本', landmark: 'Osaka Station', coordinates: { lat: 34.7, lng: 135.5 } });
  source.daily_plans[1].city = '大阪';
  source.daily_plans[1].spots[0].city = '大阪';
  source.daily_plans[1].spots[0].coordinates = { lat: 34.71, lng: 135.51 };
  let plan = buildExecutableItinerary(source, profile);
  assert.equal(plan.daily_plans[0].connection_to_next.type, 'intercity');
  plan = await calculatePlanRoutes(plan, {
    routeProvider: async ({ origin, destination }) => ({
      provider: 'test', geometry: [[origin.lat, origin.lng], [destination.lat, destination.lng]],
      distance_meters: 50000, duration_seconds: 3600,
    }),
  });
  assert.equal(plan.daily_plans[0].connection_to_next.status, 'available');
  assert.equal(plan.daily_plans[0].connection_to_next.departure_time, '2026-10-02T09:00:00');
  assert.equal(plan.daily_plans[0].connection_to_next.arrival_time, '2026-10-02T10:00:00');
  assert.equal(plan.daily_plans[1].nodes[0].start_time, '2026-10-02T10:45:00');
  assert.equal(validatePlanHealth(plan, profile).passed, true);
});

test('同城换酒店会按入住退房日选择锚点并拆分住宿阶段', () => {
  const source = sourcePlan();
  source.accommodations = [
    { city: '京都', country: '日本', landmark: 'Hotel A', check_in_day: 1, check_out_day: 2, coordinates: { lat: 35, lng: 135.75 } },
    { city: '京都', country: '日本', landmark: 'Hotel B', check_in_day: 2, check_out_day: 3, coordinates: { lat: 35.02, lng: 135.77 } },
  ];
  const plan = buildExecutableItinerary(source, profile);
  assert.equal(plan.daily_plans[0].nodes[0].name, 'Hotel A');
  assert.equal(plan.daily_plans[1].nodes[0].name, 'Hotel B');
  assert.equal(plan.stages.length, 2);
});
