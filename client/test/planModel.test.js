import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneProfile,
  externalDirectionsReference,
  formatBudgetPreference,
  formatDistance,
  formatDuration,
  googleRouteCompliance,
  isActualIntercityTransition,
  normalizeSnapshot,
  profileCompletion,
  stableId,
  routeAdvisoryText,
  validCoordinates,
  validGeometryPoint,
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

test('交通偏好深拷贝并为旧 profile 补齐距离策略', () => {
  const profile = cloneProfile({ transport: { allowedModes: ['TRANSIT'] } });
  assert.deepEqual(profile.transport.distancePolicy, {
    walkMaxKm: 1, localTransitMaxKm: 30, flightMinKm: 800,
  });
  assert.ok(profile.transport.transitPreferences.allowedModes.includes('SUBWAY'));
  profile.transport.transitPreferences.allowedModes.pop();
  profile.transport.distancePolicy.walkMaxKm = 2;
  const fresh = cloneProfile({});
  assert.equal(fresh.transport.distancePolicy.walkMaxKm, 1);
  assert.ok(fresh.transport.transitPreferences.allowedModes.includes('RAIL'));
});

test('时长格式不会产生 60 分钟的非法余数', () => {
  assert.equal(formatDuration(3599), '1小时');
  assert.equal(formatDuration(3660), '1小时1分');
  assert.equal(formatDuration(0), '0分钟');
  assert.equal(formatDuration(null), null);
  assert.equal(formatDistance(''), null);
});

test('只有城市或国家真实变化的 intercity 连接才算跨城', () => {
  const kyoto = { city: '京都', country: '日本' };
  assert.equal(isActualIntercityTransition(kyoto, { city: '东京', country: '日本' }, { type: 'intercity' }), true);
  assert.equal(isActualIntercityTransition(kyoto, { city: '京都', country: '日本' }, { type: 'intercity' }), false);
  assert.equal(isActualIntercityTransition(kyoto, { city: '东京', country: '日本' }, { type: 'overnight' }), false);
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
  assert.equal(validCoordinates({ lat: 0, lng: 0 }), true);
  assert.equal(validCoordinates({ lat: 120, lng: 139.7 }), false);
  assert.equal(validCoordinates({ lat: Number.NaN, lng: 10 }), false);
  assert.equal(validCoordinates({ lat: null, lng: null }), false);
  assert.equal(validCoordinates({ lat: '', lng: '' }), false);
  assert.equal(validCoordinates({ lat: undefined, lng: undefined }), false);
  assert.equal(validCoordinates({ lat: '   ', lng: '   ' }), false);
  assert.equal(validGeometryPoint([null, null]), false);
  assert.equal(validGeometryPoint(['', '']), false);
  assert.equal(validGeometryPoint([undefined, undefined]), false);
  assert.equal(validGeometryPoint([0, 0]), true);
});

test('可用路线会丢弃空路径点而不会把它们变成 0,0', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '路径坐标清理', days: 1,
      daily_plans: [{
        day: 1,
        nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        legs: [{
          id: 'leg-geometry', status: 'available', mode: 'TRANSIT',
          geometry: [[null, null], ['', ''], [35, 135], [36, 136], [undefined, undefined]],
        }],
      }],
    },
  }, { query: '测试', profile: completeProfile() });
  assert.deepEqual(snapshot.plan.daily_plans[0].legs[0].geometry, [[35, 135], [36, 136]]);
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

test('缺失的路线数值不会被规范化为 0 米或 0 秒', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '缺失数值', days: 1,
      daily_plans: [{
        day: 1,
        nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        legs: [{
          id: 'leg-null', status: 'available', mode: 'TRANSIT',
          distance_meters: null, duration_seconds: '', transfers: undefined,
          segments: [{ id: 'segment-null', distance_meters: null, duration_seconds: '' }],
        }],
      }],
    },
  }, { query: '测试', profile: completeProfile() });
  const leg = snapshot.plan.daily_plans[0].legs[0];
  assert.equal(leg.distance_meters, null);
  assert.equal(leg.duration_seconds, null);
  assert.equal(leg.transfers, null);
  assert.equal(leg.segments[0].distance_meters, null);
  assert.equal(leg.segments[0].duration_seconds, null);
});

test('Google 公交降级建议保留字段且只接受安全外链', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '日本公交降级', days: 1,
      daily_plans: [{
        day: 1,
        nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        legs: [{
          id: 'fallback-leg', status: 'needs_confirmation', mode: 'TRANSIT',
          external_directions_url: 'https://www.google.com/maps/dir/?api=1',
          provider_limit_code: 'TRANSIT_ROUTE_REGION_LIMIT',
          advisory_text: '请参考 Google Maps 实时公交。',
          geometry: null, segments: [],
        }],
      }],
    },
  }, { query: '日本', profile: completeProfile() });
  const leg = snapshot.plan.daily_plans[0].legs[0];
  assert.equal(leg.geometry, null);
  assert.deepEqual(leg.segments, []);
  assert.equal(externalDirectionsReference(leg).advisory, '请参考 Google Maps 实时公交。');
  assert.match(externalDirectionsReference(leg).url, /^https:\/\/www\.google\.com\/maps\/dir/);
  assert.equal(externalDirectionsReference({
    ...leg, external_directions_url: 'javascript:alert(1)',
  }).url, null);
  assert.equal(externalDirectionsReference({
    ...leg, external_directions_url: 'https://evil.example/maps/dir/?api=1',
  }).url, null);
  assert.equal(externalDirectionsReference({
    ...leg, external_directions_url: 'https://www.google.com/maps/search/?api=1',
  }).url, null);
  assert.match(externalDirectionsReference({
    ...leg, external_directions_url: 'https://maps.google.com/maps/dir/?api=1',
  }).url, /^https:\/\/maps\.google\.com\/maps\/dir/);
});

test('跨城 connection_to_next_notes 会映射到该段的独立衔接建议', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '大阪到京都', days: 2,
      daily_plans: [{
        day: 1, city: '大阪', country: '日本',
        connection_to_next_notes: '大阪站乘 JR 京都线新快速到京都站，出站后前往酒店。',
        nodes: [{ id: 'osaka', name: '大阪站' }],
        connection_to_next: {
          id: 'osaka-kyoto', type: 'intercity', status: 'available', mode: 'TRANSIT',
        },
      }, {
        day: 2, city: '京都', country: '日本', nodes: [{ id: 'kyoto', name: '京都站' }],
      }],
    },
  }, { query: '大阪京都', profile: completeProfile() });
  const connection = snapshot.plan.daily_plans[0].connection_to_next;
  assert.equal(routeAdvisoryText(connection), '大阪站乘 JR 京都线新快速到京都站，出站后前往酒店。');
  assert.notEqual(routeAdvisoryText(connection), snapshot.plan.route_reasoning);
});

test('Google 路线合规信息可脱离地图加载状态从计划中汇总', () => {
  const compliance = googleRouteCompliance({
    daily_plans: [{
      legs: [{ provider: 'google', segments: [{ travel_mode: 'WALK' }, { travel_mode: 'TRANSIT' }] }],
      connection_to_next: null,
    }],
  });
  assert.deepEqual(compliance, { usesGoogle: true, betaModes: ['WALK'] });
  assert.deepEqual(googleRouteCompliance({ daily_plans: [] }), { usesGoogle: false, betaModes: [] });
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

test('具体公交线路、站点与分段轨迹在快照中保留', () => {
  const snapshot = normalizeSnapshot({
    plan: {
      title: '京都到富士山', days: 1,
      daily_plans: [{
        day: 1, city: '京都',
        nodes: [{ id: 'kyoto', name: '京都站' }, { id: 'fuji', name: '富士山站' }],
        legs: [{
          id: 'leg-1', status: 'available', mode: 'TRANSIT', summary: '新干线 + 巴士', transfers: 1,
          segments: [{
            id: 'segment-1', sequence: 0, transit_vehicle_type: 'HIGH_SPEED_RAIL',
            line: { name: '东海道新干线' },
            from_stop: { name: '京都站', coordinates: { lat: 34.98, lng: 135.75 } },
            to_stop: { name: '三岛站', coordinates: { lat: 35.12, lng: 138.91 } },
            geometry: [[34.98, 135.75], [35.12, 138.91]],
          }],
        }],
      }],
    },
  }, { query: '富士山', profile: completeProfile() });
  const leg = snapshot.plan.daily_plans[0].legs[0];
  assert.equal(leg.summary, '新干线 + 巴士');
  assert.equal(leg.transfers, 1);
  assert.equal(leg.segments[0].line.name, '东海道新干线');
  assert.equal(leg.segments[0].from_stop.name, '京都站');
  assert.equal(leg.segments[0].geometry.length, 2);
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
