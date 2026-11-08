process.env.LOG_LEVEL ||= 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetGoogleClient } from '../services/google.js';
import { cityKey, normalizePlan, normalizeTransfer, normalizeTransfers, sameCity } from '../services/planSchema.js';
import { computeRoutes } from '../services/route.js';
import { applySchedules } from '../services/schedule.js';
import {
  baseCities,
  extractPlaces,
  extractService,
  inferTransferMode,
  inferTransfers,
  parseDurationMinutes,
  reconcileTransfers,
  routeBetween,
  routeTransfers,
  transferLeg,
  transferWarnings,
} from '../services/transfers.js';
import { createMockUpstream } from '../testing/mockUpstream.js';

const spot = (name, city, extra = {}) => ({ name, city, country: '日本', type: 'attraction', ...extra });
const station = (name, city, extra = {}) => spot(name, city, { type: 'transport', ...extra });

/** 东京 2 天 → 京都 2 天 → 奈良一日游 → 大阪 1 天（结构取自真实评测输出）。 */
function japanPlan(extra = {}) {
  return normalizePlan({
    title: '日本六日游',
    city: '多城市',
    country: '日本',
    destinations: [
      { city: '东京', start_day: 1, end_day: 2 },
      { city: '京都', start_day: 3, end_day: 4 },
      { city: '奈良', start_day: 5, end_day: 5 },
      { city: '大阪', start_day: 6, end_day: 6 },
    ],
    accommodations: [
      { city: '东京', area: '新宿' },
      { city: '京都', area: '京都站' },
      { city: '大阪', area: '难波' },
    ],
    daily_plans: [
      { day: 1, city: '东京', spots: [spot('浅草寺', '东京')] },
      { day: 2, city: '东京', spots: [spot('明治神宫', '东京')] },
      {
        day: 3,
        city: '京都',
        spots: [
          station('东京站', '东京', { start_time: '08:00', cost: '新干线车票约 14000 日元', description: '乘坐 JR 东海道新干线希望号前往京都，车程约 2 小时 15 分，建议提前购买指定席。' }),
          station('京都站', '京都', { start_time: '10:15' }),
          spot('京都塔', '京都', { start_time: '11:00' }),
        ],
      },
      { day: 4, city: '京都', spots: [spot('清水寺', '京都')] },
      {
        day: 5,
        city: '奈良',
        spots: [station('近铁奈良站', '奈良', { start_time: '09:30' }), spot('奈良公园', '奈良', { start_time: '10:00' })],
        transport_notes: '从京都站乘近铁京都线快速急行约45分钟至近铁奈良站，步行游览。',
      },
      {
        day: 6,
        city: '大阪',
        spots: [station('京都站', '京都', { start_time: '09:00' }), station('大阪站', '大阪', { start_time: '09:30' }), spot('大阪城', '大阪')],
        transport_notes: '京都站乘JR京都线新快速约30分钟至大阪站。',
      },
    ],
    ...extra,
  });
}

test('城市名比较：去掉市 / 都 / 府后缀，京都、成都保持原样', () => {
  assert.equal(cityKey('东京都'), '东京');
  assert.equal(cityKey('京都'), '京都');
  assert.equal(cityKey('成都'), '成都');
  assert.ok(sameCity('京都市', '京都'));
  assert.ok(sameCity('Sapporo', 'sapporo'));
  assert.equal(sameCity('京都', '东京'), false);
  assert.equal(sameCity('', ''), false);
});

test('规范化城市间交通：方式别名、时长换算、跨午夜、同城与越界丢弃', () => {
  const train = normalizeTransfer({ day: '4', from_city: '札幌', to_city: '函馆', mode: '火车', duration_hours: 3.75, service: 'JR 特急北斗号' });
  assert.equal(train.mode, 'train');
  assert.equal(train.duration_minutes, 225);
  const night = normalizeTransfer({ day: 2, from_city: 'A', to_city: 'B', mode: 'flight', depart_time: '23:30', arrive_time: '01:10' });
  assert.equal(night.duration_minutes, 100);
  assert.equal(normalizeTransfer({ day: 2, from_city: '京都市', to_city: '京都', mode: 'train' }), null);
  assert.equal(normalizeTransfer({ day: 9, from_city: 'A', to_city: 'B' }, { maxDay: 5 }), null);
  assert.equal(normalizeTransfer({ day: 2, from_city: 'A', to_city: 'B', mode: '瞬移' }).mode, null);

  const list = normalizeTransfers([
    { day: 3, from_city: 'B', to_city: 'C', mode: '自驾' },
    { day: 1, from_city: 'A', to_city: 'B', mode: 'bus' },
    { day: 1, from_city: 'A', to_city: 'B', mode: 'train' },
    'oops',
  ]);
  assert.deepEqual(list.map(item => [item.day, item.mode]), [[1, 'bus'], [3, 'drive']]);
});

test('从交通说明中解析时长、方式、车次和车站', () => {
  assert.equal(parseDurationMinutes('乘新干线约2小时15分到京都站'), 135);
  assert.equal(parseDurationMinutes('车程约 3-4 小时'), 210);
  assert.equal(parseDurationMinutes('乘火车至普洛切（约1小时），再转乘巴士（约3-4小时），总耗时约4-5小时'), 270);
  assert.equal(parseDurationMinutes('上午乘高铁，车程约2小时。抵达后步行约10分钟'), 120);
  assert.equal(parseDurationMinutes('约45分钟'), 45);
  assert.equal(parseDurationMinutes('步行约10分钟'), null);
  assert.equal(parseDurationMinutes(''), null);

  assert.equal(inferTransferMode('乘火车至普洛切，再转乘巴士'), 'train');
  assert.equal(inferTransferMode('从巴士站乘巴士约4.5小时，抵达后步行至火车站'), 'bus');
  assert.equal(inferTransferMode('自驾约7小时，途经克拉玛依'), 'drive');
  assert.equal(inferTransferMode('乘航班飞往罗马'), 'flight');
  assert.equal(inferTransferMode('全天步行'), null);

  assert.equal(extractService('乘坐 JR 东海道新干线希望号前往京都'), 'JR 东海道新干线希望号');
  assert.equal(extractService('东京站乘新干线希望号约2小时15分到京都站。'), '新干线希望号');
  assert.equal(extractService('从卢塞恩火车站乘金色山口快车（GoldenPass Express）至因特拉肯东站'), '金色山口快车');
  assert.equal(extractService('乘早班火车前往萨拉热窝'), '');
  assert.equal(extractService('乘坐公交或步行'), '');

  assert.deepEqual(extractPlaces('从京都站乘近铁京都线快速急行约45分钟至近铁奈良站'), { from: '京都站', to: '近铁奈良站', via: '' });
  assert.equal(extractPlaces('从贾登峪自驾至禾木门票站约1.5小时').from, '');
  assert.equal(extractPlaces('自驾约7小时，途经克拉玛依、乌尔禾。').via, '克拉玛依、乌尔禾');
});

test('落脚城市：只停一天且没有住宿的中途城市视为一日游', () => {
  const bases = baseCities(japanPlan());
  assert.equal(bases.get(5).base, '京都');
  assert.equal(bases.get(5).dayTrip, true);
  assert.equal(bases.get(6).base, '大阪');
  assert.equal(bases.get(1).dayTrip, false);
});

test('按行程推断换城市：新干线、一日游往返、从落脚城市出发', () => {
  const transfers = inferTransfers(japanPlan());
  assert.deepEqual(transfers.map(item => [item.day, item.from_city, item.to_city, item.round_trip]), [
    [3, '东京', '京都', false],
    [5, '京都', '奈良', true],
    [6, '京都', '大阪', false],
  ]);
  const [shinkansen, nara, osaka] = transfers;
  assert.equal(shinkansen.mode, 'train');
  assert.equal(shinkansen.service, 'JR 东海道新干线希望号');
  assert.equal(shinkansen.from_place, '东京站');
  assert.equal(shinkansen.to_place, '京都站');
  assert.equal(shinkansen.duration_minutes, 135);
  assert.equal(shinkansen.cost, '新干线车票约 14000 日元');
  assert.equal(nara.from_place, '京都站');
  assert.equal(nara.to_place, '近铁奈良站');
  assert.equal(nara.duration_minutes, 45);
  assert.equal(osaka.service, 'JR京都线新快速');
});

test('合并模型给出的交通：日期以行程为准、缺失字段互补、未知城市丢弃', () => {
  const plan = japanPlan({
    transfers: [
      { day: 2, from_city: '东京', to_city: '京都', mode: 'train', service: '东海道新干线 希望号 7 号', cost: '每人约 14170 日元', tips: '选 E 座看富士山' },
      { day: 4, from_city: '火星', to_city: '京都', mode: 'flight' },
    ],
  });
  const transfers = reconcileTransfers(plan);
  assert.equal(transfers.length, 3);
  const shinkansen = transfers[0];
  assert.equal(shinkansen.id, 'transfer:0');
  assert.equal(shinkansen.day, 3);
  assert.equal(shinkansen.source, 'model');
  assert.equal(shinkansen.service, '东海道新干线 希望号 7 号');
  assert.equal(shinkansen.from_place, '东京站');
  assert.equal(shinkansen.duration_minutes, 135);
  assert.equal(shinkansen.tips, '选 E 座看富士山');
  assert.equal(transfers.filter(item => item.source === 'inferred').length, 2);
  assert.ok(!transfers.some(item => item.from_city === '火星'));
});

test('单城市行程没有城市间交通', () => {
  const plan = normalizePlan({
    city: '京都',
    destinations: [{ city: '京都', start_day: 1, end_day: 2 }],
    daily_plans: [{ day: 1, spots: [spot('清水寺', '京都')] }, { day: 2, spots: [spot('岚山', '京都')] }],
  });
  assert.deepEqual(reconcileTransfers(plan), []);
});

function withMock(options, run) {
  return async () => {
    const saved = { ...process.env };
    process.env.GOOGLE_MAPS_API_KEY = 'test-google';
    resetGoogleClient();
    const upstream = createMockUpstream(options).install();
    try {
      await run(upstream);
    } finally {
      upstream.restore();
      process.env = saved;
      resetGoogleClient();
    }
  };
}

const coords = (lat, lng) => ({ lat, lng });

function groundedHokkaido() {
  const located = (name, city, lat, lng, extra = {}) => ({
    ...spot(name, city, extra), coordinates: coords(lat, lng), location_id: `${name}-id`,
  });
  return {
    destinations: [{ city: '札幌', start_day: 1, end_day: 1 }, { city: '函馆', start_day: 2, end_day: 2 }],
    accommodations: [
      { city: '札幌', area: '大通', coordinates: coords(43.0605, 141.3546) },
      { city: '函馆', area: '函馆站前', coordinates: coords(41.7737, 140.7264) },
    ],
    daily_plans: [
      { day: 1, city: '札幌', spots: [located('大通公园', '札幌', 43.0605, 141.3546, { start_time: '09:30' })] },
      {
        day: 2,
        city: '函馆',
        spots: [
          located('札幌站', '札幌', 43.0687, 141.3508, { type: 'transport', start_time: '08:00', duration_hours: 0.5 }),
          located('函馆站', '函馆', 41.7737, 140.7264, { type: 'transport', start_time: '11:45', duration_hours: 0.5 }),
          located('金森红砖仓库', '函馆', 41.7669, 140.7176, { start_time: '12:30' }),
        ],
      },
    ],
  };
}

test('火车没有公共交通数据时画示意线，并直接作为当天两座车站之间的一段路程', withMock({ transitMaxKm: 50 }, async () => {
  const plan = groundedHokkaido();
  const planned = [{ id: 'transfer:0', day: 2, from_city: '札幌', to_city: '函馆', mode: 'train', service: 'JR 特急北斗号', from_place: '札幌站', to_place: '函馆站', duration_minutes: 225 }];
  const [transfer] = await routeTransfers(plan, planned);
  assert.equal(transfer.route_source, 'schematic');
  assert.equal(transfer.duration_seconds, 225 * 60);
  assert.equal(transfer.from.kind, 'station');
  assert.deepEqual(transfer.attached_leg, { from_id: '札幌站-id', to_id: '函馆站-id' });
  assert.equal(transfer.covered, true);

  const [, day2] = await computeRoutes(plan, { transfers: [transfer], transferLeg });
  assert.equal(day2.legs[0].mode, 'TRANSFER');
  assert.equal(day2.legs[0].transfer_mode, 'train');
  assert.equal(day2.legs[0].service, 'JR 特急北斗号');
  assert.equal(day2.legs[0].schematic, true);
  assert.equal(day2.legs[1].mode, 'WALK');

  // 排程按列车时长计算，不叠加在车站停留的半小时：11:45 到站保持不变。
  const scheduled = applySchedules(plan, [{ day: 1, legs: [] }, day2]);
  assert.equal(scheduled.plan.daily_plans[1].spots[1].start_time, '11:45');
}));

test('有公共交通数据时使用真实线路；自驾走真实道路并带道路名；航班画示意线', withMock({}, async () => {
  const sapporo = coords(43.0687, 141.3508);
  const hakodate = coords(41.7737, 140.7264);
  const rail = await routeBetween(sapporo, hakodate, { mode: 'train', duration_minutes: 225 });
  assert.equal(rail.route_source, 'transit');
  assert.ok(rail.transit_lines.length > 0);
  assert.ok(rail.geometry.length >= 2);

  const drive = await routeBetween(sapporo, hakodate, { mode: 'drive' });
  assert.equal(drive.route_source, 'road');
  assert.equal(drive.road, '道央自动车道');
  assert.ok(drive.duration_seconds > 0);

  const flight = await routeBetween(coords(35.68, 139.76), coords(26.21, 127.68), { mode: null, duration_minutes: 165 });
  assert.equal(flight.mode, 'flight');
  assert.equal(flight.route_source, 'schematic');
  assert.equal(flight.duration_seconds, 165 * 60);
}));

test('当天从住宿出发的长途自驾：不作为路程，但会提示第一站可能赶不上', withMock({}, async () => {
  const plan = groundedHokkaido();
  plan.daily_plans[1].spots = plan.daily_plans[1].spots.slice(2);
  const planned = [{ id: 'transfer:0', day: 2, from_city: '札幌', to_city: '函馆', mode: 'drive' }];
  const [transfer] = await routeTransfers(plan, planned, { preference: 'drive' });
  assert.equal(transfer.from.kind, 'stay');
  assert.equal(transfer.attached_leg, null);
  assert.equal(transfer.covered, false);
  const warnings = transferWarnings(plan, [transfer]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /第 2 天从札幌到函馆约需 .*12:30 的“金森红砖仓库”可能赶不上/);
}));

test('未配置 Google Key 时只返回文字信息，不画线', async () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  resetGoogleClient();
  try {
    const plan = japanPlan();
    const [transfer] = await routeTransfers(plan, reconcileTransfers(plan));
    assert.equal(transfer.service, 'JR 东海道新干线希望号');
    assert.deepEqual(transfer.geometry, []);
    assert.equal(transfer.from, null);
  } finally {
    if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
    resetGoogleClient();
  }
});
