import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferDaysFromQuery,
  normalizeProfile,
  profileClarificationQuestions,
} from '../services/preferences.js';

test('结构化 profile 会规范化交通、预算、同行人和作息', () => {
  const profile = normalizeProfile({
    days: 5,
    startDate: '2026-10-01',
    budget: { amount: 12000, currency: 'cny', basis: 'total' },
    pace: 'relaxed',
    transport: { priority: 'public_transport', allowedModes: ['walk', 'metro'], avoidModes: ['drive'] },
    travelers: { adults: 2, children: 1 },
    maxWalkingKm: 3,
    dailyStartTime: '08:30',
    dailyEndTime: '19:30',
  });
  assert.equal(profile.days, 5);
  assert.equal(profile.budget.currency, 'CNY');
  assert.equal(profile.transport.priority, 'transit');
  assert.deepEqual(profile.transport.allowedModes, ['WALK', 'TRANSIT']);
  assert.equal(profile.travelers.children, 1);
  assert.deepEqual(profileClarificationQuestions(profile), []);
});

test('缺少天数、预算、节奏和交通优先级时返回结构化问题', () => {
  const profile = normalizeProfile({}, '我想去东京');
  assert.deepEqual(profileClarificationQuestions(profile).map(item => item.id), [
    'days', 'budget', 'pace', 'transportPriority',
  ]);
});

test('能识别中文数字时长，不把普通日期当成旅行天数', () => {
  assert.equal(inferDaysFromQuery('京都玩三天，行程轻松'), 3);
  assert.equal(inferDaysFromQuery('8日出发，10日返回'), null);
  assert.equal(inferDaysFromQuery('总共两周'), 14);
});

test('兼容前端 transfers 优先级和四种预算 basis', () => {
  assert.equal(normalizeProfile({ transport: { priority: 'transfers' } }).transport.priority, 'comfort');
  assert.equal(normalizeProfile({ budget: { basis: 'per_day' } }).budget.basis, 'per_day');
  assert.equal(normalizeProfile({ budget: { basis: 'per_person_day' } }).budget.basis, 'per_person_day');
  assert.equal(normalizeProfile({ budget: { basis: 'per_person_total' } }).budget.basis, 'per_person_total');
  assert.equal(normalizeProfile({ transport: { priority: 'walking' } }).transport.priority, 'walking');
});

test('规范化公共交通子类型、路线偏好和距离规则', () => {
  const profile = normalizeProfile({
    transport: {
      priority: 'rail',
      allowedModes: ['walk', 'transit', 'rail'],
      transitPreferences: {
        allowedModes: ['bus', 'metro', 'train', 'invalid'],
        routingPreference: 'fewer_transfers',
      },
      distancePolicy: { walkMaxKm: 0.8, localTransitMaxKm: 25, flightMinKm: 650 },
    },
  });
  assert.deepEqual(profile.transport.transitPreferences, {
    allowedModes: ['BUS', 'SUBWAY', 'TRAIN'],
    routingPreference: 'FEWER_TRANSFERS',
  });
  assert.deepEqual(profile.transport.distancePolicy, {
    walkMaxKm: 0.8,
    localTransitMaxKm: 25,
    flightMinKm: 650,
  });
});

test('距离规则会限制异常值并保持阈值递增', () => {
  const profile = normalizeProfile({
    transport: {
      distancePolicy: { walkMaxKm: 999, localTransitMaxKm: -1, flightMinKm: 10 },
      transitPreferences: { allowedModes: [], routingPreference: 'invalid' },
    },
  });
  assert.deepEqual(profile.transport.distancePolicy, {
    walkMaxKm: 20,
    localTransitMaxKm: 20,
    flightMinKm: 50,
  });
  assert.deepEqual(profile.transport.transitPreferences.allowedModes, ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL']);
  assert.equal(profile.transport.transitPreferences.routingPreference, null);
});

test('自然语言中的新干线和巴士会保留为可传给 Google 的子类型', () => {
  const profile = normalizeProfile({}, '城市之间优先新干线，接驳可以坐巴士');
  assert.ok(profile.transport.allowedModes.includes('RAIL'));
  assert.deepEqual(profile.transport.transitPreferences.allowedModes, ['BUS', 'TRAIN']);
});
