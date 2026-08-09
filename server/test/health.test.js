import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanHealth } from '../services/health.js';

function healthyShape() {
  return {
    days: 1,
    budget_summary: { status: 'estimated', coverage: 1, known_total: 100, currency: 'CNY' },
    daily_plans: [{
      id: 'day-1', day: 1, start_anchor: 'hotel-start', end_anchor: 'hotel-end',
      nodes: [
        { id: 'hotel-start', name: '酒店', role: 'start_anchor', start_time: '2026-10-10T09:00:00', end_time: '2026-10-10T09:00:00', coordinates: { lat: 35, lng: 135 } },
        { id: 'spot', name: '景点', start_time: '2026-10-10T09:20:00', end_time: '2026-10-10T11:00:00', coordinates: { lat: 35.01, lng: 135.01 } },
        { id: 'hotel-end', name: '酒店', role: 'end_anchor', start_time: '2026-10-10T21:30:00', end_time: '2026-10-10T21:30:00', coordinates: { lat: 35, lng: 135 } },
      ],
      legs: [
        { id: 'leg-1', from_node_id: 'hotel-start', to_node_id: 'spot', mode: 'WALK', status: 'available', distance_meters: 1000, duration_seconds: 1200, geometry: [[35, 135], [35.01, 135.01]] },
        { id: 'leg-2', from_node_id: 'spot', to_node_id: 'hotel-end', mode: 'WALK', status: 'available', distance_meters: 1000, duration_seconds: 1200, geometry: [[35.01, 135.01], [35, 135]] },
      ],
      connection_to_next: null,
    }],
  };
}

test('每日步行超过用户上限会成为阻断问题', () => {
  const health = validatePlanHealth(healthyShape(), {
    days: 1, startDate: '2026-10-10', maxWalkingKm: 1.5, dailyEndTime: '22:00',
    transport: { allowedModes: ['WALK'], avoidModes: [] },
  });
  assert.equal(health.passed, false);
  assert.ok(health.blocking_issues.some(item => item.code === 'WALKING_LIMIT_EXCEEDED'));
});

test('晚归提示保留完整 HH:mm 时间', () => {
  const health = validatePlanHealth(healthyShape(), {
    days: 1, startDate: '2026-10-10', maxWalkingKm: 5, dailyEndTime: '20:00',
    transport: { allowedModes: ['WALK'], avoidModes: [] },
  });
  const warning = health.warnings.find(item => item.code === 'DAY_ENDS_LATE');
  assert.match(warning.message, /21:30/);
});

function multiSegmentShape() {
  const plan = healthyShape();
  plan.daily_plans[0].legs[0] = {
    ...plan.daily_plans[0].legs[0],
    mode: 'RAIL',
    geometry: [[35, 135], [35.005, 135.005], [35.01, 135.01]],
    summary: '东海道新干线 → 富士急巴士',
    primary_vehicle: 'HIGH_SPEED_TRAIN',
    transfers: 1,
    segments: [
      {
        sequence: 0, travel_mode: 'TRANSIT', transit_vehicle_type: 'HIGH_SPEED_TRAIN',
        line: { name: '东海道新干线' }, distance_meters: 700,
        geometry: [[35, 135], [35.005, 135.005]],
      },
      {
        sequence: 1, travel_mode: 'TRANSIT', transit_vehicle_type: 'BUS',
        line: { name: '富士急巴士' }, distance_meters: 300,
        geometry: [[35.005, 135.005], [35.01, 135.01]],
      },
    ],
  };
  return plan;
}

const detailedTransportProfile = {
  days: 1, startDate: '2026-10-10', maxWalkingKm: 5, dailyEndTime: '22:00',
  transport: {
    allowedModes: ['WALK', 'RAIL'], avoidModes: [],
    transitPreferences: { allowedModes: ['TRAIN', 'BUS'] },
  },
};

test('真实新干线加巴士分段通过连续性和交通偏好检查', () => {
  const health = validatePlanHealth(multiSegmentShape(), detailedTransportProfile);
  assert.equal(health.passed, true);
  assert.equal(health.blocking_issues.length, 0);
});

test('交通分段缺少车辆类型或几何时仍诚实阻断', () => {
  const plan = multiSegmentShape();
  plan.daily_plans[0].legs[0].segments[1].transit_vehicle_type = null;
  plan.daily_plans[0].legs[0].segments[1].geometry = null;
  const health = validatePlanHealth(plan, detailedTransportProfile);
  assert.equal(health.passed, false);
  assert.ok(health.blocking_issues.some(item => item.code === 'TRANSIT_VEHICLE_MISSING'));
  assert.ok(health.blocking_issues.some(item => item.code === 'ROUTE_SEGMENT_GEOMETRY_MISSING'));

  const poisoned = multiSegmentShape();
  poisoned.daily_plans[0].legs[0].geometry = [[null, null], [35.01, 135.01]];
  poisoned.daily_plans[0].legs[0].segments[0].geometry = [[null, null], [35.005, 135.005]];
  const poisonedHealth = validatePlanHealth(poisoned, detailedTransportProfile);
  assert.equal(poisonedHealth.passed, false);
  assert.ok(poisonedHealth.blocking_issues.some(item => item.code === 'ROUTE_GEOMETRY_MISSING'));
  assert.ok(poisonedHealth.blocking_issues.some(item => item.code === 'ROUTE_SEGMENT_GEOMETRY_MISSING'));
});

test('超出实时班次窗口只要求复核，不把真实轨迹判成不可用', () => {
  const plan = multiSegmentShape();
  plan.daily_plans[0].legs[0].schedule_recheck_required = true;
  plan.daily_plans[0].legs[0].schedule_basis = 'representative';
  const health = validatePlanHealth(plan, detailedTransportProfile);
  assert.equal(health.passed, true);
  const warning = health.warnings.find(item => item.code === 'TRANSIT_SCHEDULE_RECHECK_REQUIRED');
  assert.match(warning.message, /不代表实际班次/);
  assert.ok(!health.blocking_issues.some(item => item.code === 'ROUTE_UNAVAILABLE'));
});

test('日本公共交通官方覆盖限制是明确警告而不是不可用阻断', () => {
  const plan = healthyShape();
  plan.daily_plans[0].legs[0] = {
    ...plan.daily_plans[0].legs[0],
    mode: 'RAIL',
    status: 'needs_confirmation',
    geometry: null,
    segments: [],
    estimated: true,
    provider_limit_code: 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED',
    external_directions_url: 'https://www.google.com/maps/dir/?api=1&origin=Kyoto&destination=Tokyo&travelmode=transit',
  };
  const health = validatePlanHealth(plan, detailedTransportProfile);
  assert.equal(health.passed, true);
  const warning = health.warnings.find(item => item.code === 'TRANSIT_PROVIDER_LIMIT_CONFIRMATION_REQUIRED');
  assert.match(warning.message, /官方覆盖限制/);
  assert.ok(!health.blocking_issues.some(item => item.code === 'ROUTE_UNAVAILABLE'));
});

test('health 用独立阻断项暴露 provider 调用失败与损坏响应', () => {
  for (const [errorCode, messagePattern] of [
    ['ROUTE_PROVIDER_ERROR', /API、配额或网络/],
    ['ROUTE_PROVIDER_RESPONSE_INVALID', /无效响应或损坏几何/],
  ]) {
    const plan = healthyShape();
    plan.daily_plans[0].legs[0] = {
      ...plan.daily_plans[0].legs[0],
      mode: 'RAIL',
      status: 'unavailable',
      geometry: null,
      error_code: errorCode,
    };
    const health = validatePlanHealth(plan, detailedTransportProfile);
    assert.equal(health.passed, false);
    const blocker = health.blocking_issues.find(item => item.code === errorCode);
    assert.match(blocker.message, messagePattern);
    assert.ok(!health.blocking_issues.some(item => item.code === 'ROUTE_UNAVAILABLE'));
  }
});
