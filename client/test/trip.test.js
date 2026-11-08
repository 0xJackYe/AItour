import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLeg } from '../src/lib/format.js';
import { planToMarkdown } from '../src/lib/markdown.js';
import { normalizeResult } from '../src/lib/plan.js';
import {
  cityGroups,
  cityKey,
  cityOfDay,
  cityPosition,
  cityRuns,
  dayRangeLabel,
  describeTransfer,
  isMultiCity,
  routeOutline,
  transferDirectionsUrl,
  viewLevel,
  visibleDays,
} from '../src/lib/trip.js';

const day = (number, city, spots = []) => ({ day: number, city, theme: `${city}第${number}天`, spots });

const TRANSFER = {
  id: 'transfer:0',
  day: 4,
  from_city: '札幌',
  to_city: '函馆',
  mode: 'train',
  service: 'JR 特急北斗号',
  from_place: '札幌站',
  to_place: '函馆站',
  depart_time: '08:00',
  arrive_time: '11:45',
  duration_minutes: 225,
  duration_seconds: 13500,
  distance_meters: 153000,
  cost: '每人约 9000 日元',
  tips: '可用 JR 北海道铁路周游券',
  round_trip: false,
  route_source: 'schematic',
  from: { name: '札幌站', coordinates: { lat: 43.0687, lng: 141.3508 } },
  to: { name: '函馆站', coordinates: { lat: 41.7737, lng: 140.7264 } },
  geometry: [[43.0687, 141.3508], [41.7737, 140.7264]],
  attached_leg: { from_id: 'day:3:spot:0', to_id: 'day:3:spot:1' },
};

const PLAN = {
  title: '北海道五日游',
  city: '多城市',
  days: 5,
  accommodations: [{ city: '札幌', area: '大通', coordinates: { lat: 43.06, lng: 141.35 } }],
  daily_plans: [
    day(1, '札幌'),
    day(2, '札幌'),
    day(3, '札幌'),
    day(4, '函馆', [
      { name: '札幌站', type: 'transport', city: '札幌', start_time: '08:00', location_id: 'day:3:spot:0', coordinates: { lat: 43.0687, lng: 141.3508 } },
      { name: '函馆站', type: 'transport', city: '函馆', start_time: '11:45', location_id: 'day:3:spot:1', coordinates: { lat: 41.7737, lng: 140.7264 } },
      { name: '金森红砖仓库', type: 'attraction', city: '函馆', start_time: '12:30', location_id: 'day:3:spot:2', coordinates: { lat: 41.7669, lng: 140.7176 } },
    ]),
    day(5, '函馆市'),
  ],
  transfers: [{ ...TRANSFER, geometry: undefined, from: undefined, to: undefined }],
};

test('城市分组：按第一次出现的顺序，“函馆市”与“函馆”是同一座城市', () => {
  assert.equal(cityKey('函馆市'), cityKey('函馆'));
  assert.equal(cityKey('京都'), '京都');
  const groups = cityGroups(PLAN);
  assert.deepEqual(groups.map(group => [group.name, group.days]), [['札幌', [1, 2, 3]], ['函馆', [4, 5]]]);
  assert.equal(isMultiCity(PLAN), true);
  assert.equal(isMultiCity({ city: '京都', daily_plans: [day(1, '京都'), day(2, '')] }), false);
  assert.deepEqual(cityRuns(PLAN).map(run => run.days), [[1, 2, 3], [4, 5]]);
  assert.equal(dayRangeLabel([1, 2, 3]), '第 1–3 天');
  assert.equal(dayRangeLabel([4]), '第 4 天');
});

test('路线卡片：换城市当天的交通排在两座城市之间', () => {
  const items = routeOutline(PLAN, [TRANSFER]);
  assert.deepEqual(items.map(item => (item.type === 'city' ? item.run.name : item.transfer.service)), ['札幌', 'JR 特急北斗号', '函馆']);
});

test('城市间交通文案：车次、时刻、时长、票价；示意线不显示直线距离', () => {
  const info = describeTransfer(TRANSFER);
  assert.equal(info.title, '札幌 → 函馆');
  assert.equal(info.icon, 'train');
  assert.equal(info.modeLabel, '火车');
  assert.equal(info.service, 'JR 特急北斗号');
  assert.equal(info.times, '08:00 札幌站 → 11:45 函馆站');
  assert.deepEqual(info.facts, ['约 3 小时 45 分钟', '每人约 9000 日元']);
  assert.equal(info.schematic, true);
  assert.match(info.mapsUrl, /travelmode=transit/);

  const drive = describeTransfer({ day: 2, from_city: '札幌', to_city: '函馆', mode: 'drive', road: '道央自动车道', duration_seconds: 18000, distance_meters: 318000, route_source: 'road' });
  assert.equal(drive.service, '自驾');
  assert.deepEqual(drive.facts, ['约 5 小时', '318 km']);
  assert.equal(drive.route, '经道央自动车道');

  const dayTrip = describeTransfer({ day: 5, from_city: '京都', to_city: '奈良', mode: null, round_trip: true, notes: '近铁约 45 分钟' });
  assert.equal(dayTrip.title, '京都 ⇄ 奈良');
  assert.equal(dayTrip.service, '城际交通');
  assert.equal(dayTrip.roundTrip, true);
});

test('Google 地图路线链接：有坐标用坐标，没有坐标用站名', () => {
  const withCoordinates = new URL(transferDirectionsUrl(TRANSFER));
  assert.equal(withCoordinates.searchParams.get('origin'), '43.0687,141.3508');
  assert.equal(withCoordinates.searchParams.get('travelmode'), 'transit');
  const byName = new URL(transferDirectionsUrl({ from_city: '京都', to_city: '奈良', from_place: '京都站', mode: 'drive' }));
  assert.equal(byName.searchParams.get('origin'), '京都站');
  assert.equal(byName.searchParams.get('destination'), '奈良');
  assert.equal(byName.searchParams.get('travelmode'), 'driving');
  assert.equal(transferDirectionsUrl(null), null);
});

test('三级视图：多城市总览 / 某个城市 / 某一天', () => {
  assert.equal(viewLevel({ city: null, day: null }, true), 'trip');
  assert.equal(viewLevel({ city: null, day: null }, false), 'city');
  assert.equal(viewLevel({ city: '函馆', day: null }, true), 'city');
  assert.equal(viewLevel({ city: '函馆', day: 4 }, true), 'day');
  assert.deepEqual(visibleDays(PLAN, { city: cityKey('函馆'), day: null }).map(item => item.day), [4, 5]);
  assert.deepEqual(visibleDays(PLAN, { city: null, day: 2 }).map(item => item.day), [2]);
  assert.equal(visibleDays(PLAN, { city: null, day: null }).length, 5);
  assert.equal(cityOfDay(PLAN, 5), cityKey('函馆'));
});

test('城市标记位置：住宿 → 地点中心 → 城际交通端点', () => {
  const result = { plan: PLAN, transfers: [TRANSFER] };
  const [sapporo, hakodate] = cityGroups(PLAN);
  assert.deepEqual(cityPosition(result, sapporo), { lat: 43.06, lng: 141.35 });
  const center = cityPosition(result, hakodate);
  assert.ok(Math.abs(center.lat - 41.7703) < 0.001);
  const empty = { plan: { daily_plans: [day(1, 'A'), day(2, 'B')] }, transfers: [{ from_city: 'A', to_city: 'B', to: { coordinates: { lat: 1, lng: 2 } } }] };
  assert.deepEqual(cityPosition(empty, cityGroups(empty.plan)[1]), { lat: 1, lng: 2 });
});

test('作为当天一段路程的城际交通显示车次，而不是打车参考', () => {
  const label = describeLeg({ mode: 'TRANSFER', transfer_mode: 'train', service: 'JR 特急北斗号', duration_seconds: 13500, distance_meters: 153000, schematic: true });
  assert.deepEqual(label, { icon: 'train', transfer: true, label: 'JR 特急北斗号 · 约 3 小时 45 分钟' });
});

test('接口结果优先使用带路线的交通；旧记录退回计划里的文字版', () => {
  assert.equal(normalizeResult({ plan: PLAN, transfers: [TRANSFER] }).transfers[0].geometry.length, 2);
  assert.equal(normalizeResult({ plan: PLAN }).transfers[0].service, 'JR 特急北斗号');
  assert.deepEqual(normalizeResult({ plan: { daily_plans: [] } }).transfers, []);
});

test('复制 / 打印的文字版包含城市间交通', () => {
  const result = normalizeResult({ plan: PLAN, transfers: [TRANSFER, { ...TRANSFER, id: 'transfer:1', day: 5, attached_leg: null, from_city: '函馆', to_city: '大沼', round_trip: true, service: '', mode: 'bus' }] });
  const markdown = planToMarkdown(result);
  assert.match(markdown, /## 城市间交通/);
  assert.match(markdown, /- 第 4 天 · 札幌 → 函馆：JR 特急北斗号 · 约 3 小时 45 分钟 · 每人约 9000 日元（08:00 札幌站 → 11:45 函馆站）/);
  assert.match(markdown, /提示：可用 JR 北海道铁路周游券/);
  assert.match(markdown, /城际交通：函馆 ⇄ 大沼：大巴/);
});
