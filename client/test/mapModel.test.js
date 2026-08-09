import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMappableOverviewNodes,
  collectOverviewNodes,
  legendForSegments,
  markerIsSelected,
  routeSegments,
  segmentMode,
  transferPoints,
  visibleRoutesForSelection,
} from '../src/services/mapModel.js';

const intercityRoute = {
  id: 'kyoto-fuji',
  day: 2,
  connection_to_day: 3,
  status: 'available',
  summary: '东海道新干线 + 富士急巴士',
  segments: [
    {
      id: 'shinkansen', sequence: 0, travel_mode: 'TRANSIT', transit_vehicle_type: 'HIGH_SPEED_TRAIN',
      line: { name: '东海道新干线' },
      from_stop: { name: '京都站', coordinates: { lat: 34.985, lng: 135.758 } },
      to_stop: { name: '三岛站', coordinates: { lat: 35.126, lng: 138.91 } },
      geometry: [[34.985, 135.758], [35.126, 138.91]],
    },
    {
      id: 'fujikyu-bus', sequence: 1, travel_mode: 'TRANSIT', transit_vehicle_type: 'BUS',
      line: { name: '富士急巴士', color: '#f59e0b' },
      from_stop: { name: '三岛站', coordinates: { lat: 35.126, lng: 138.91 } },
      to_stop: { name: '富士山站', coordinates: { lat: 35.483, lng: 138.795 } },
      geometry: [[35.126, 138.91], [35.483, 138.795]],
    },
  ],
};

test('全程概览汇总每天景点并排除住宿起终锚点', () => {
  const nodes = collectOverviewNodes({
    daily_plans: [
      { day: 1, nodes: [{ id: 'start', role: 'start' }, { id: 'osaka', name: '大阪城', type: 'attraction' }] },
      { day: 2, spots: [{ id: 'kyoto', name: '清水寺', type: 'attraction' }] },
    ],
  });
  assert.deepEqual(nodes.map(node => node.id), ['osaka', 'kyoto']);
  assert.deepEqual(nodes.map(node => node.overviewDay), [1, 2]);
});

test('地图概览模型包含每个具有有效坐标的景点', () => {
  const nodes = collectMappableOverviewNodes({
    daily_plans: [
      { day: 1, spots: [
        { id: 'osaka', name: '大阪城', coordinates: { lat: 34.6873, lng: 135.5262 } },
        { id: 'kyoto', name: '清水寺', coordinates: { lat: 34.9949, lng: 135.785 } },
      ] },
      { day: 2, spots: [
        { id: 'fuji', name: '富士山', coordinates: { lat: 35.3606, lng: 138.7274 } },
        { id: 'missing', name: '坐标待确认', coordinates: null },
      ] },
    ],
  });
  assert.deepEqual(nodes.map(node => node.id), ['osaka', 'kyoto', 'fuji']);
});

test('复合跨城方案会展开为独立新干线和巴士轨迹', () => {
  const segments = routeSegments(intercityRoute);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].displayMode, 'HIGH_SPEED_RAIL');
  assert.equal(segments[1].displayMode, 'BUS');
  assert.equal(segments[0].routeId, intercityRoute.id);
  assert.equal(segments[1].color, '#f59e0b');
  assert.equal(segmentMode({ transit_vehicle_type: 'METRO_RAIL' }), 'SUBWAY');
});

test('分段交界处会生成可点击的换乘站', () => {
  const points = transferPoints(routeSegments(intercityRoute));
  assert.equal(points.length, 1);
  assert.equal(points[0].name, '三岛站');
  assert.equal(points[0].routeId, intercityRoute.id);
  assert.match(points[0].from, /新干线/);
  assert.match(points[0].to, /富士急巴士/);
});

test('步行接驳不会被误计为公交换乘', () => {
  const segments = routeSegments({
    id: 'walk-transfer',
    segments: [
      { id: 'train', sequence: 0, travel_mode: 'TRANSIT', transit_vehicle_type: 'TRAIN', line: { name: 'A' }, geometry: [[1, 1], [2, 2]] },
      { id: 'walk', sequence: 1, travel_mode: 'WALK', geometry: [[2, 2], [2.1, 2.1]] },
      { id: 'bus', sequence: 2, travel_mode: 'TRANSIT', transit_vehicle_type: 'BUS', line: { name: 'B' }, geometry: [[2.1, 2.1], [3, 3]] },
    ],
  });
  assert.deepEqual(transferPoints(segments), []);
});

test('地图景点与换乘点使用各自的选中状态', () => {
  assert.equal(markerIsSelected({ id: 'spot-1', selectionType: 'node' }, 'spot-1', 'leg-1'), true);
  assert.equal(markerIsSelected({ id: 'spot-1', selectionType: 'node' }, null, 'spot-1'), false);
  assert.equal(markerIsSelected({ id: 'leg-1', selectionType: 'leg' }, 'leg-1', null), false);
  assert.equal(markerIsSelected({ id: 'leg-1', selectionType: 'leg' }, null, 'leg-1'), true);
});

test('概览在扁平 routes 缺失时仍会保留计划内的跨城连接', () => {
  const plan = {
    daily_plans: [
      { day: 1, legs: [], connection_to_next: { ...intercityRoute, type: 'intercity' } },
      { day: 2, legs: [], connection_to_next: null },
    ],
  };
  const visible = visibleRoutesForSelection(plan, [], null);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].connection_to_day, 2);
});

test('旧版顶层 geometry 在没有 segments 时仍可绘制且图例去重', () => {
  const segments = [
    ...routeSegments({ id: 'legacy-1', mode: 'RAIL', geometry: [[null, null], ['', ''], [35, 135], [36, 136]] }),
    ...routeSegments({ id: 'legacy-2', mode: 'RAIL', geometry: [[36, 136], [37, 137]] }),
  ];
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].geometry, [[35, 135], [36, 136]]);
  assert.equal(legendForSegments(segments).length, 1);
  assert.equal(legendForSegments(segments)[0].label, '铁路');
});
