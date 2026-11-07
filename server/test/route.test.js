process.env.LOG_LEVEL ||= 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetGoogleClient } from '../services/google.js';
import { chooseTravelModes, computeLeg, computeRoutes, nextLocalMorning } from '../services/route.js';
import { createMockUpstream } from '../testing/mockUpstream.js';

test('按距离与偏好选择交通方式', () => {
  assert.deepEqual(chooseTravelModes(0.8), ['WALK', 'TRANSIT']);
  assert.deepEqual(chooseTravelModes(2), ['TRANSIT', 'WALK', 'DRIVE']);
  assert.deepEqual(chooseTravelModes(3), ['TRANSIT', 'DRIVE', 'WALK']);
  assert.deepEqual(chooseTravelModes(30), ['TRANSIT', 'DRIVE']);
  assert.deepEqual(chooseTravelModes(30, 'drive'), ['DRIVE', 'TRANSIT']);
  assert.deepEqual(chooseTravelModes(2, 'walk'), ['WALK', 'TRANSIT']);
});

test('公共交通出发时间是目的地次日上午 10 点且在未来', () => {
  const now = new Date('2026-11-07T23:30:00Z');
  const kyoto = new Date(nextLocalMorning(135.77, now));
  assert.ok(kyoto > now);
  assert.equal((kyoto.getUTCHours() + 9) % 24, 10);
  const newYork = new Date(nextLocalMorning(-74, now));
  assert.equal((newYork.getUTCHours() + 24 - 5) % 24, 10);
  const farEast = new Date(nextLocalMorning(179, now));
  assert.ok(farEast.getTime() > now.getTime() + 60 * 60 * 1000);
});

const spot = (id, lat, lng) => ({ location_id: id, name: id, coordinates: { lat, lng } });

function withGoogle(fn, options = {}) {
  return async () => {
    const env = { ...process.env };
    process.env.GOOGLE_MAPS_API_KEY = 'test-google';
    resetGoogleClient();
    const upstream = createMockUpstream(options).install();
    try {
      await fn(upstream);
    } finally {
      upstream.restore();
      process.env = env;
      resetGoogleClient();
    }
  };
}

test('短距离步行，长距离公共交通并带线路名', withGoogle(async (upstream) => {
  const walk = await computeLeg(spot('a', 35.0, 135.77), spot('b', 35.005, 135.772));
  assert.equal(walk.mode, 'WALK');
  const transit = await computeLeg(spot('a', 35.0, 135.77), spot('c', 35.04, 135.73));
  assert.equal(transit.mode, 'TRANSIT');
  assert.equal(transit.transit_lines[0].name, '乌丸线');
  assert.ok(transit.geometry.length >= 2);
  assert.deepEqual(upstream.calls.routeModes, ['WALK', 'TRANSIT']);
}));

test('所有方式都失败时用直线兜底并标记', async () => {
  const env = { ...process.env };
  delete process.env.GOOGLE_MAPS_API_KEY;
  resetGoogleClient();
  try {
    const leg = await computeLeg(spot('a', 35.0, 135.77), spot('c', 35.04, 135.73));
    assert.equal(leg.mode, 'STRAIGHT');
    assert.equal(leg.fallback, true);
    assert.ok(leg.distance_meters > 4000);
  } finally {
    process.env = env;
  }
});

test('按天汇总距离、时长与交通方式', withGoogle(async () => {
  const plan = {
    daily_plans: [
      { day: 1, spots: [spot('a', 35.0, 135.77), spot('b', 35.005, 135.772), spot('c', 35.04, 135.73)] },
      { day: 2, spots: [spot('d', 35.0, 135.77)] },
    ],
  };
  const routes = await computeRoutes(plan, { optimizations: new Map([[1, { optimized: true, savedKm: 1.2 }]]) });
  assert.equal(routes[0].legs.length, 2);
  assert.equal(routes[0].travel_mode, 'MIXED');
  assert.ok(routes[0].distance_meters > 0 && routes[0].duration_seconds > 0);
  assert.equal(routes[0].optimized, true);
  assert.equal(routes[0].saved_meters, 1200);
  assert.equal(routes[1].legs.length, 0);
  assert.equal(routes[1].travel_mode, null);
}));

test('没有公交数据的地区（如日本）：近距离改步行，远距离给出打车参考并明确标记', withGoogle(async () => {
  const nearby = await computeLeg(spot('a', 35.0, 135.77), spot('b', 35.0, 135.792));
  assert.equal(nearby.mode, 'WALK');
  assert.equal(nearby.transit_unavailable, undefined);

  const far = await computeLeg(spot('a', 35.0, 135.77), spot('c', 35.04, 135.73));
  assert.equal(far.mode, 'DRIVE');
  assert.equal(far.transit_unavailable, true);

  const selfDrive = await computeLeg(spot('a', 35.0, 135.77), spot('c', 35.04, 135.73), { preference: 'drive' });
  assert.equal(selfDrive.mode, 'DRIVE');
  assert.equal(selfDrive.transit_unavailable, undefined, '自驾偏好下驾车是用户的选择，不需要提示');
}, { transitAvailable: false }));
