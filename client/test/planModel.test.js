import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneProfile,
  formatBudgetPreference,
  formatDuration,
  normalizeSnapshot,
  profileCompletion,
  stableId,
  validCoordinates,
} from '../src/services/planModel.js';

function completeProfile() {
  return cloneProfile({
    days: 2,
    budget: { level: 'moderate', amount: 5000, currency: 'CNY' },
    pace: 'relaxed',
    transport: { priority: 'balanced', allowedModes: ['WALK', 'TRANSIT'] },
  });
}

test('资料完整度只把四项核心偏好作为生成门槛', () => {
  assert.equal(profileCompletion({}).ready, false);
  assert.deepEqual(profileCompletion(completeProfile()), {
    complete: 4,
    total: 4,
    percentage: 100,
    ready: true,
  });
});

test('时长格式不会产生 60 分钟的非法余数', () => {
  assert.equal(formatDuration(3599), '1小时');
  assert.equal(formatDuration(3660), '1小时1分');
  assert.equal(formatDuration(0), '0分钟');
});

test('结构化预算会被渲染为可读文字而不是对象字符串', () => {
  assert.equal(formatBudgetPreference({
    level: 'moderate', amount: 1800, currency: 'CNY', basis: 'per_day',
  }), '适中 · 全体每天 1,800 CNY');
  assert.equal(formatBudgetPreference('每人 5000 元'), '每人 5000 元');
});

test('稳定 ID 对同一输入保持不变并区分不同顺序', () => {
  assert.equal(stableId('node', 1, '清水寺', 0), stableId('node', 1, '清水寺', 0));
  assert.notEqual(stableId('node', 1, '清水寺', 0), stableId('node', 1, '清水寺', 1));
});

test('坏坐标在进入地图之前被拒绝', () => {
  assert.equal(validCoordinates({ lat: 35.6, lng: 139.7 }), true);
  assert.equal(validCoordinates({ lat: 120, lng: 139.7 }), false);
  assert.equal(validCoordinates({ lat: Number.NaN, lng: 10 }), false);
});

test('不可用路线即使带坐标也不会保留伪 geometry', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '两日测试', days: 1,
      daily_plans: [{
        day: 1,
        city: '京都',
        nodes: [
          { id: 'a', name: '酒店', type: 'hotel', coordinates: { lat: 35, lng: 135 } },
          { id: 'b', name: '清水寺', type: 'attraction', coordinates: { lat: 35.1, lng: 135.1 } },
        ],
        legs: [{
          id: 'leg-a-b', from_node_id: 'a', to_node_id: 'b', mode: 'WALK',
          status: 'unavailable', geometry: [[35, 135], [35.1, 135.1]],
        }],
      }],
    },
  }, { query: '京都', profile: completeProfile() });

  assert.equal(snapshot.plan.daily_plans[0].legs[0].geometry, null);
  assert.equal(snapshot.plan.daily_plans[0].legs[0].status, 'unavailable');
});

test('新计划会统一日期类型并为节点与路段补稳定 ID', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '京都两日', days: 2,
      daily_plans: [
        { day: '2', city: '京都', spots: [{ name: '岚山' }, { name: '渡月桥' }] },
        { day: '1', city: '京都', spots: [{ name: '清水寺' }, { name: '祇园' }] },
      ],
    },
  }, { query: '京都两天', profile: completeProfile() });

  assert.deepEqual(snapshot.plan.daily_plans.map(day => day.day), [1, 2]);
  assert.ok(snapshot.plan.daily_plans.every(day => day.id));
  assert.ok(snapshot.plan.daily_plans.every(day => day.nodes.every(node => node.id)));
  assert.ok(snapshot.plan.daily_plans.every(day => day.legs.every(leg => leg.id)));
  assert.ok(snapshot.plan.daily_plans.every(day => day.legs.every(leg => leg.status === 'unknown')));
});

test('全程概览会保留真实的跨城连接路线', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '京都到大阪', days: 2,
      daily_plans: [
        { day: 1, city: '京都', spots: [{ id: 'kyoto', name: '京都站' }] },
        { day: 2, city: '大阪', spots: [{ id: 'osaka', name: '大阪站' }] },
      ],
    },
    routes: [{
      id: 'connection-1', day: 1, connection_to_day: 2,
      from_node_id: 'kyoto', to_node_id: 'osaka', travel_mode: 'TRANSIT',
      status: 'available', geometry: [[35, 135.7], [34.7, 135.5]],
    }],
  }, { query: '京都大阪', profile: completeProfile() });

  const connection = snapshot.routes.find(route => route.connection_to_day === 2);
  assert.equal(connection.status, 'available');
  assert.equal(connection.geometry.length, 2);
});

test('历史快照恢复时保留版本 ID、时间和扩展元数据', () => {
  const snapshot = normalizeSnapshot({
    id: 'revision-original', createdAt: 123456,
    query: '京都', profile: completeProfile(),
    plan: { title: '历史计划', days: 1, daily_plans: [{ day: 1, city: '京都', spots: [{ name: '清水寺' }] }] },
    parsedRequest: { days: 1 },
    transitMarkers: [{ name: 'Kyoto Station' }],
    geocodingWarnings: ['待确认'],
  }, { query: '京都', profile: completeProfile() });
  assert.equal(snapshot.id, 'revision-original');
  assert.equal(snapshot.createdAt, 123456);
  assert.deepEqual(snapshot.parsedRequest, { days: 1 });
  assert.equal(snapshot.transitMarkers[0].name, 'Kyoto Station');
  assert.deepEqual(snapshot.geocodingWarnings, ['待确认']);
});
