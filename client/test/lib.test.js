import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLeg, formatDate, formatDistance, formatDuration, formatHours } from '../src/lib/format.js';
import {
  dayColor,
  directionsModeFor,
  googleMapsDirectionsUrl,
  legsByOrigin,
  normalizeResult,
  numberStops,
  planTitle,
  summarizeQuality,
} from '../src/lib/plan.js';
import { createSseParser, parseEventBlock } from '../src/services/sse.js';

test('距离与时长格式化', () => {
  assert.equal(formatDistance(0), '');
  assert.equal(formatDistance(842), '840 m');
  assert.equal(formatDistance(4250), '4.3 km');
  assert.equal(formatDistance(18400), '18 km');
  assert.equal(formatDuration(30), '1 分钟');
  assert.equal(formatDuration(1500), '25 分钟');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(5400), '1 小时 30 分钟');
  assert.equal(formatHours(2), '2 小时');
  assert.equal(formatHours(1.5), '1.5 小时');
  assert.equal(formatHours(null), '');
});

test('交通段描述', () => {
  assert.equal(describeLeg({ mode: 'WALK', duration_seconds: 720, distance_meters: 900 }).label, '步行 12 分钟 · 900 m');
  assert.equal(describeLeg({ mode: 'TRANSIT', duration_seconds: 1080, transit_lines: [{ name: '乌丸线', vehicle: 'SUBWAY' }] }).label, '地铁 乌丸线 · 18 分钟');
  assert.equal(describeLeg({ mode: 'DRIVE', duration_seconds: 1500, distance_meters: 12000 }).label, '驾车 · 25 分钟 · 12 km');
  assert.equal(
    describeLeg({ mode: 'DRIVE', transit_unavailable: true, duration_seconds: 900, distance_meters: 6000 }).label,
    '打车约 15 分钟 · 6.0 km（公交线路见 Google 地图）',
  );
  assert.equal(describeLeg({ mode: 'STRAIGHT', distance_meters: 3200 }).label, '约 3.2 km（直线距离）');
  assert.equal(describeLeg(null), null);
});

test('相对日期', () => {
  const now = new Date('2026-11-07T12:00:00').getTime();
  assert.match(formatDate(new Date('2026-11-07T09:05:00').getTime(), now), /^今天 09:05$/);
  assert.equal(formatDate(new Date('2026-11-04T09:00:00').getTime(), now), '3 天前');
  assert.equal(formatDate(new Date('2026-10-01T09:00:00').getTime(), now), '2026/10/1');
});

test('每天颜色循环且地图与列表一致', () => {
  assert.equal(dayColor(1), dayColor(9));
  assert.notEqual(dayColor(1), dayColor(2));
});

test('只有已定位的地点参与编号（与地图标记一致）', () => {
  const stops = numberStops([
    { name: 'A', coordinates: { lat: 1, lng: 1 }, location_id: 'day:0:spot:0' },
    { name: 'B', coordinates: null },
    { name: 'C', coordinates: { lat: 1, lng: 2 } },
  ], 1);
  assert.deepEqual(stops.map(item => item.order), [1, null, 2]);
  assert.equal(stops[0].key, 'day:0:spot:0');
  assert.equal(stops[2].key, 'day:1:spot:2');
});

test('兼容旧版历史记录结构', () => {
  const legacy = normalizeResult({
    plan: {
      city: '京都',
      days: 2,
      daily_plans: [],
      __parsed_request: { city: '京都' },
      __verification: { passed: true },
      __transit_markers: [{ name: '京都站' }],
      __geocoding_warnings: [],
    },
    routes: [{ day: 1, geometry: [] }],
  }, '京都两天');
  assert.equal(legacy.query, '京都两天');
  assert.equal(legacy.parsedRequest.city, '京都');
  assert.equal(legacy.transitMarkers.length, 1);
  assert.equal(legacy.verification.passed, true);
  assert.equal(planTitle(legacy.plan), '京都 2 日游');
  assert.equal(normalizeResult(null), null);
});

test('质量摘要：全部通过与存在问题两种情况', () => {
  const plan = { daily_plans: [{ day: 1, spots: [{ name: 'A', coordinates: { lat: 1, lng: 1 } }, { name: 'B', coordinates: null }] }] };
  const ok = summarizeQuality({ plan: { daily_plans: [{ day: 1, spots: [{ name: 'A', coordinates: { lat: 1, lng: 1 } }] }] }, verification: { passed: true }, geocodingWarnings: [] });
  assert.equal(ok.tone, 'ok');
  assert.match(ok.headline, /1\/1 个地点/);

  const warn = summarizeQuality({
    plan,
    verification: { passed: false, missing_spots: ['岚山'], incorrect_spots: [], warnings: ['第 1 天偏紧'], regenerated: true },
    geocodingWarnings: [{ name: 'Day 1 · B', reason: '未找到', removed: false }, { name: 'Day 1 · X', reason: '在外地', removed: true }],
  });
  assert.equal(warn.tone, 'warn');
  assert.equal(warn.issueCount, 3);
  assert.match(warn.headline, /1\/2 个地点/);
  assert.match(warn.headline, /移除 1 个/);
  assert.match(warn.headline, /已自动修正/);
});

test('Google 地图导航链接', () => {
  const spots = [
    { name: 'A', coordinates: { lat: 35, lng: 135, place_id: 'pa' } },
    { name: 'B', coordinates: { lat: 35.1, lng: 135.1, place_id: 'pb' } },
    { name: 'C', coordinates: null },
    { name: 'D', coordinates: { lat: 35.2, lng: 135.2, place_id: 'pd' } },
  ];
  const url = new URL(googleMapsDirectionsUrl(spots, { travelMode: 'walking' }));
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('origin'), '35,135');
  assert.equal(url.searchParams.get('destination'), '35.2,135.2');
  assert.equal(url.searchParams.get('waypoints'), '35.1,135.1');
  assert.equal(url.searchParams.get('waypoint_place_ids'), 'pb');
  assert.equal(url.searchParams.get('travelmode'), 'walking');
  // 公共交通不支持途经点：带途经点时不指定 transit。
  assert.equal(new URL(googleMapsDirectionsUrl(spots, { travelMode: 'transit' })).searchParams.get('travelmode'), null);
  assert.match(googleMapsDirectionsUrl([spots[0]]), /maps\/search\/\?api=1&query=35%2C135&query_place_id=pa/);
  assert.equal(googleMapsDirectionsUrl([{ name: 'X' }]), null);
  assert.equal(directionsModeFor({ travel_mode: 'WALK' }, 'public_transit'), 'walking');
  assert.equal(directionsModeFor({ travel_mode: 'MIXED' }, 'drive'), 'driving');
  // 接口没有公交数据而回退为驾车时，导航链接仍用公交模式（Google 地图 App 支持）。
  assert.equal(directionsModeFor({ travel_mode: 'DRIVE' }, 'public_transit'), 'transit');
});

test('交通段按出发地点索引', () => {
  const legs = legsByOrigin({ legs: [{ from_id: 'a', to_id: 'b' }, { from_id: 'b', to_id: 'c' }] });
  assert.equal(legs.get('a').to_id, 'b');
  assert.equal(legsByOrigin(null).size, 0);
});

test('SSE 解析：跨分片、CRLF、注释与多行 data', () => {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  parser.push(': stream-open\n\nevent: progress\ndata: {"stage":"pa');
  parser.push('rse"}\r\n\r\nevent: result\ndata: {"ok":');
  parser.push('true}\n\n');
  parser.push('data: line1\ndata: line2');
  parser.flush();
  assert.deepEqual(events, [
    { event: 'progress', data: { stage: 'parse' } },
    { event: 'result', data: { ok: true } },
    { event: 'message', data: 'line1\nline2' },
  ]);
  assert.equal(parseEventBlock(': ping'), null);
});
