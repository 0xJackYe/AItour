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
