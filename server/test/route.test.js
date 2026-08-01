import test from 'node:test';
import assert from 'node:assert/strict';
import { getRouteForLeg, getRouteForLegWithFallback } from '../services/route.js';

const from = { coordinates: { lat: 35, lng: 135 } };
const to = { coordinates: { lat: 35.1, lng: 135.1 } };

test('逐段路线支持依赖注入并保留实际方式', async () => {
  const result = await getRouteForLeg(from, to, 'TRANSIT', {
    routeProvider: async ({ mode }) => ({
      provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
      distance_meters: 15000, duration_seconds: 1800, mode,
    }),
  });
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'TRANSIT');
  assert.equal(result.provider, 'fixture');
});

test('路线服务失败时返回 unavailable 且绝不伪造直线', async () => {
  const result = await getRouteForLeg(from, to, 'WALK', {
    routeProvider: async () => { throw new Error('quota'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.geometry, null);
  assert.equal(result.provider, null);
});

test('飞机等非 Google 市内路线不会被伪装成步行', async () => {
  const result = await getRouteForLeg(from, to, 'FLIGHT');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.mode, 'FLIGHT');
  assert.equal(result.geometry, null);
  assert.equal(result.estimated, true);
  assert.equal(result.error_code, 'INTERCITY_ROUTE_CONFIRMATION_REQUIRED');
});

test('首选路线不可用时只在用户允许的方式中回退', async () => {
  const attempted = [];
  const result = await getRouteForLegWithFallback(from, to, 'TRANSIT', {
    allowedModes: ['TRANSIT', 'WALK'],
    avoidModes: ['DRIVE'],
    routeProvider: async ({ mode }) => {
      attempted.push(mode);
      return mode === 'WALK' ? {
        provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
        distance_meters: 14000, duration_seconds: 10800,
      } : null;
    },
  });
  assert.deepEqual(attempted, ['TRANSIT', 'WALK']);
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'WALK');
  assert.equal(result.fallback_from_mode, 'TRANSIT');
});

test('公共交通失败时不会回退成长距离步行并违反步行上限', async () => {
  const attempted = [];
  const result = await getRouteForLegWithFallback(from, to, 'TRANSIT', {
    allowedModes: ['TRANSIT', 'WALK'],
    maxWalkingKm: 3,
    routeProvider: async ({ mode }) => {
      attempted.push(mode);
      return null;
    },
  });
  assert.deepEqual(attempted, ['TRANSIT']);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.mode, 'TRANSIT');
});
