import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBudgetSummary,
  buildExecutableItinerary,
  flattenRoutes,
  selectLegMode,
} from '../services/itinerary.js';
import { calculatePlanRoutes } from '../routes/plan.js';
import { validatePlanHealth } from '../services/health.js';

const profile = {
  days: 2,
  startDate: '2026-10-01',
  budget: { level: 'moderate', amount: 5000, currency: 'CNY', basis: 'total', hardLimit: true },
  pace: 'relaxed',
  transport: { priority: 'transit', allowedModes: ['WALK', 'TRANSIT'], avoidModes: [] },
  travelers: { adults: 2, children: 0, seniors: 0 },
  maxWalkingKm: 0.5,
  dailyStartTime: '09:00',
  dailyEndTime: '20:00',
  interests: [], accommodation: {}, dietaryNeeds: [], accessibilityNeeds: [], notes: '',
};

function sourcePlan() {
  return {
    title: '京都两日', city: '京都', country: '日本', days: 2,
    accommodations: [{ city: '京都', country: '日本', landmark: 'Kyoto Station', coordinates: { lat: 35, lng: 135.75 } }],
    daily_plans: [1, 2].map(day => ({
      day, city: '京都', country: '日本', spots: [{
        name: `景点${day}`, name_en: `Spot ${day}`, city: '京都', country: '日本',
        duration_hours: 1, coordinates: { lat: 35 + day * 0.01, lng: 135.76 },
      }],
    })),
  };
}

test('编译器生成稳定 ID、酒店首尾、逐段交通、时间轴、stage 和跨日连接', () => {
  const first = buildExecutableItinerary(sourcePlan(), profile);
  const second = buildExecutableItinerary(sourcePlan(), profile);
  assert.equal(first.id, second.id);
  assert.equal(first.daily_plans[0].nodes[1].id, second.daily_plans[0].nodes[1].id);
  assert.equal(first.stages.length, 1);
  assert.equal(first.daily_plans[0].nodes[0].role, 'start_anchor');
  assert.equal(first.daily_plans[0].nodes.at(-1).role, 'end_anchor');
  assert.equal(first.daily_plans[0].legs.length, first.daily_plans[0].nodes.length - 1);
  assert.equal(first.daily_plans[0].connection_to_next.type, 'overnight');
  assert.ok(first.daily_plans[0].nodes[1].start_time);
});

test('住宿 Place ID 会保留到每日酒店锚点并传递两种字段命名', () => {
  const source = sourcePlan();
  source.accommodations[0].place_id = 'ChIJ-kyoto-hotel';
  const plan = buildExecutableItinerary(source, profile);
  for (const day of plan.daily_plans) {
    assert.equal(day.nodes[0].place_id, 'ChIJ-kyoto-hotel');
    assert.equal(day.nodes[0].placeId, 'ChIJ-kyoto-hotel');
    assert.equal(day.nodes.at(-1).place_id, 'ChIJ-kyoto-hotel');
  }
});

test('空白或越界坐标不会被编译成 0,0', () => {
  const source = sourcePlan();
  source.accommodations[0].coordinates = { lat: null, lng: '' };
  source.daily_plans[0].spots[0].coordinates = { lat: false, lng: 181 };
  const plan = buildExecutableItinerary(source, profile);
  assert.equal(plan.daily_plans[0].nodes[0].coordinates, null);
  assert.equal(plan.daily_plans[0].nodes[1].coordinates, null);
});

test('预算口径按天数和同行人确定性换算', () => {
  const plan = sourcePlan();
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_day' } }).limit, 200);
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_person_total' } }).limit, 200);
  assert.equal(buildBudgetSummary(plan, { ...profile, budget: { ...profile.budget, amount: 100, basis: 'per_person_day' } }).limit, 400);
});

test('预算只统计带币种和口径的显式费用，未知费用不会伪装成零元', () => {
  const plan = sourcePlan();
  plan.daily_plans[0].spots[0].estimated_cost = null;
  plan.daily_plans[1].spots[0].cost = {
    amount: 80, currency: 'CNY', basis: 'per_person', category: 'activities',
  };
  const summary = buildBudgetSummary(plan, profile);
  assert.equal(summary.known_total, 160);
  assert.equal(summary.costed_items, 1);
  assert.equal(summary.total_items, 2);
  assert.equal(summary.coverage, 0.5);
  assert.equal(summary.status, 'estimated');
});

test('预算排除空值、缺失口径和币种不一致的费用', () => {
  const plan = sourcePlan();
  plan.daily_plans[0].spots[0].cost = { amount: null, currency: 'CNY', basis: 'group_total' };
  plan.daily_plans[1].spots[0].cost = { amount: 1000, currency: 'JPY', basis: 'group_total' };
  const summary = buildBudgetSummary(plan, profile);
  assert.equal(summary.known_total, 0);
  assert.equal(summary.costed_items, 0);
  assert.equal(summary.currency_mismatch_items, 1);
  assert.equal(summary.coverage, 0);
  assert.equal(summary.status, 'unknown');
});

test('真实逐段路线回写后确定性 health 通过连续性校验', async () => {
  let plan = buildExecutableItinerary(sourcePlan(), profile);
  plan = await calculatePlanRoutes(plan, {
    routeProvider: async ({ origin, destination }) => ({
      provider: 'test', geometry: [[origin.lat, origin.lng], [destination.lat, destination.lng]],
      distance_meters: 1000, duration_seconds: 600,
    }),
  });
  const health = validatePlanHealth(plan, profile);
  assert.equal(health.passed, true);
  assert.equal(health.metrics.route_coverage, 1);
  assert.ok(plan.daily_plans.every(day => day.legs.every(leg => leg.status === 'available')));
});

test('路线服务失败时保留明确标记的估算耗时，时间轴不会压缩成零分钟', async () => {
  const source = sourcePlan();
  source.country = '法国';
  source.accommodations[0].country = '法国';
  source.daily_plans.forEach(day => {
    day.country = '法国';
    day.spots.forEach(spot => { spot.country = '法国'; });
  });
  let plan = buildExecutableItinerary(source, profile);
  const originalDuration = plan.daily_plans[0].legs[0].duration_seconds;
  plan = await calculatePlanRoutes(plan, { routeProvider: async () => null });
  const leg = plan.daily_plans[0].legs[0];
  assert.equal(leg.status, 'unavailable');
  assert.equal(leg.duration_seconds, originalDuration);
  assert.equal(leg.estimated, true);
  assert.notEqual(plan.daily_plans[0].nodes[0].end_time, plan.daily_plans[0].nodes[1].start_time);
  assert.equal(leg.geometry, null);
});

test('日本 Transit 无 API 覆盖时连接保留人工建议、官方链接和非阻断 health', async () => {
  const source = sourcePlan();
  source.city = '多城市';
  source.daily_plans[0].transport_notes = '当天乘地铁前往岚山，返回酒店。';
  source.daily_plans[0].connection_to_next_notes = '京都到大阪：从京都站乘 JR 京都线新快速到大阪站；到站后步行前往酒店，班次临近出发复核。';
  source.accommodations[0].place_id = 'ChIJ-kyoto-station';
  source.accommodations.push({
    city: '大阪', country: '日本', landmark: 'Osaka Station', place_id: 'ChIJ-osaka-station',
    coordinates: { lat: 34.7, lng: 135.5 },
  });
  source.daily_plans[1].city = '大阪';
  source.daily_plans[1].spots[0].city = '大阪';
  source.daily_plans[1].spots[0].coordinates = { lat: 34.71, lng: 135.51 };
  let plan = buildExecutableItinerary(source, profile);
  plan = await calculatePlanRoutes(plan, { routeProvider: async () => null });
  const connection = plan.daily_plans[0].connection_to_next;
  assert.equal(connection.status, 'needs_confirmation');
  assert.equal(connection.provider_limit_code, 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED');
  assert.equal(connection.advisory_text, source.daily_plans[0].connection_to_next_notes);
  assert.notEqual(connection.advisory_text, source.daily_plans[0].transport_notes);
  assert.match(connection.external_directions_url, /^https:\/\/www\.google\.com\/maps\/dir\//);
  const flattened = flattenRoutes(plan).find(route => route.connection_to_day === 2);
  assert.equal(flattened.provider_limit_code, 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED');
  assert.equal(flattened.external_directions_url, connection.external_directions_url);
  assert.equal(flattened.advisory_text, source.daily_plans[0].connection_to_next_notes);
  const health = validatePlanHealth(plan, profile);
  assert.equal(health.passed, true);
  assert.ok(health.warnings.some(item => item.code === 'TRANSIT_PROVIDER_LIMIT_CONFIRMATION_REQUIRED'));
});

test('大阪到京都跨城 advisory 不会误用大阪当天环球影城市内说明', () => {
  const source = sourcePlan();
  source.city = '多城市';
  source.route_reasoning = '全程按大阪→京都顺序移动，跨城班次临近出发复核。';
  source.accommodations = [
    { city: '大阪', country: '日本', landmark: 'Osaka Station', coordinates: { lat: 34.7025, lng: 135.4959 } },
    { city: '京都', country: '日本', landmark: 'Kyoto Station', coordinates: { lat: 34.9858, lng: 135.7588 } },
  ];
  source.daily_plans[0].city = '大阪';
  source.daily_plans[0].spots[0].city = '大阪';
  source.daily_plans[0].spots[0].coordinates = { lat: 34.6654, lng: 135.4323 };
  source.daily_plans[0].transport_notes = '大阪站乘 JR 梦咲线前往环球影城，当晚原路返回。';
  source.daily_plans[0].connection_to_next_notes = '大阪到京都：从大阪站乘 JR 京都线新快速到京都站，携行李入住京都站附近酒店。';
  const plan = buildExecutableItinerary(source, profile);
  assert.match(plan.daily_plans[0].connection_to_next.advisory_text, /^大阪到京都：从大阪站乘 JR 京都线新快速到京都站/);
  assert.match(plan.daily_plans[0].connection_to_next.advisory_text, /仅作参考.*Google Maps/);
  assert.notEqual(plan.daily_plans[0].connection_to_next.advisory_text, source.daily_plans[0].transport_notes);

  source.daily_plans[0].connection_to_next_notes = '大阪站到京都站，请 online 查询公共交通。';
  const overlyGenericPlan = buildExecutableItinerary(source, profile);
  assert.match(overlyGenericPlan.daily_plans[0].connection_to_next.advisory_text, /JR 京都线新快速/);
  assert.doesNotMatch(overlyGenericPlan.daily_plans[0].connection_to_next.advisory_text, /online/);

  delete source.daily_plans[0].connection_to_next_notes;
  const fallbackPlan = buildExecutableItinerary(source, profile);
  assert.match(fallbackPlan.daily_plans[0].connection_to_next.advisory_text, /大阪站.*JR 京都线新快速.*京都站/);
  assert.match(fallbackPlan.daily_plans[0].connection_to_next.advisory_text, /临近出发.*Google Maps/);
  assert.notEqual(fallbackPlan.daily_plans[0].connection_to_next.advisory_text, source.route_reasoning);
  assert.notEqual(fallbackPlan.daily_plans[0].connection_to_next.advisory_text, source.daily_plans[0].transport_notes);
});

test('四城日本走廊在 AI 未给出逐段说明时生成三条独立且具体的参考交通', () => {
  const cities = ['大阪', '京都', '富士山', '东京'];
  const countries = ['JP', 'Japan', '日本', 'JPN'];
  const coordinates = [
    { lat: 34.7025, lng: 135.4959 },
    { lat: 34.9858, lng: 135.7588 },
    { lat: 35.4884, lng: 138.7951 },
    { lat: 35.6909, lng: 139.7003 },
  ];
  const source = {
    title: '四城行程', city: '多城市', country: '日本', days: 4,
    route_reasoning: '按大阪、京都、富士山、东京顺序移动。',
    accommodations: cities.map((city, index) => ({
      city, country: countries[index], landmark: `${city}住宿`, coordinates: coordinates[index],
    })),
    daily_plans: cities.map((city, index) => ({
      day: index + 1, city, country: countries[index], connection_to_next_notes: null,
      spots: [{
        name: `${city}景点`, name_en: `${city} Spot`, city, country: countries[index],
        duration_hours: 1, coordinates: { lat: coordinates[index].lat + 0.002, lng: coordinates[index].lng + 0.002 },
      }],
    })),
  };
  const plan = buildExecutableItinerary(source, { ...profile, days: 4 });
  const advisories = plan.daily_plans.slice(0, 3).map(day => day.connection_to_next.advisory_text);
  assert.match(advisories[0], /大阪站.*JR 京都线新快速.*京都站/);
  assert.match(advisories[1], /京都站.*东海道新干线.*三岛站.*富士急.*(?:富士山站|河口湖站)/);
  assert.match(advisories[2], /河口湖站.*新宿高速巴士.*大月站.*JR 中央线/);
  assert.equal(new Set(advisories).size, 3);
  assert.ok(advisories.every(note => /临近出发.*Google Maps/.test(note)));
  assert.ok(advisories.every(note => note !== source.route_reasoning));
});

test('跨城参考模板遵守只允许驾车的交通偏好', () => {
  const source = sourcePlan();
  source.city = '多城市';
  source.accommodations = [
    { city: '大阪', country: '日本', landmark: '大阪住宿', coordinates: { lat: 34.7, lng: 135.5 } },
    { city: '京都', country: '日本', landmark: '京都住宿', coordinates: { lat: 35.0, lng: 135.76 } },
  ];
  source.daily_plans[0].city = '大阪';
  source.daily_plans[0].spots[0].city = '大阪';
  source.daily_plans[0].connection_to_next_notes = '大阪到京都：从大阪站乘 JR 京都线新快速到京都站。';
  source.daily_plans[1].city = '京都';
  source.daily_plans[1].spots[0].city = '京都';
  const driveProfile = {
    ...profile,
    transport: { ...profile.transport, allowedModes: ['DRIVE'], avoidModes: [] },
  };
  const plan = buildExecutableItinerary(source, driveProfile);
  const connection = plan.daily_plans[0].connection_to_next;
  assert.equal(connection.mode, 'DRIVE');
  assert.match(connection.advisory_text, /道路交通/);
  assert.doesNotMatch(connection.advisory_text, /JR|新干线|新快速/);

  const busOnlyProfile = {
    ...profile,
    transport: {
      ...profile.transport,
      allowedModes: ['TRANSIT'],
      transitPreferences: { allowedModes: ['BUS'], routingPreference: 'FEWER_TRANSFERS' },
    },
  };
  const busOnlyPlan = buildExecutableItinerary(source, busOnlyProfile);
  assert.equal(busOnlyPlan.daily_plans[0].connection_to_next.mode, 'TRANSIT');
  assert.doesNotMatch(busOnlyPlan.daily_plans[0].connection_to_next.advisory_text, /JR|新干线|新快速/);
  assert.match(busOnlyPlan.daily_plans[0].connection_to_next.advisory_text, /公共交通/);
});

test('超过步行上限时会选择允许的公共交通', () => {
  const selected = selectLegMode(
    { city: '京都', coordinates: { lat: 35, lng: 135 } },
    { city: '京都', coordinates: { lat: 35.1, lng: 135.1 } },
    profile,
  );
  assert.equal(selected.mode, 'TRANSIT');
});

test('换城日会生成并计算独立跨日交通连接', async () => {
  const source = sourcePlan();
  source.city = '多城市';
  source.accommodations.push({ city: '大阪', country: '日本', landmark: 'Osaka Station', coordinates: { lat: 34.7, lng: 135.5 } });
  source.daily_plans[1].city = '大阪';
  source.daily_plans[1].spots[0].city = '大阪';
  source.daily_plans[1].spots[0].coordinates = { lat: 34.71, lng: 135.51 };
  let plan = buildExecutableItinerary(source, profile);
  assert.equal(plan.daily_plans[0].connection_to_next.type, 'intercity');
  plan = await calculatePlanRoutes(plan, {
    routeProvider: async ({ origin, destination }) => ({
      provider: 'test', geometry: [[origin.lat, origin.lng], [destination.lat, destination.lng]],
      distance_meters: 50000, duration_seconds: 3600,
    }),
  });
  assert.equal(plan.daily_plans[0].connection_to_next.status, 'available');
  assert.equal(plan.daily_plans[0].connection_to_next.departure_time, '2026-10-02T09:00:00');
  assert.equal(plan.daily_plans[0].connection_to_next.arrival_time, '2026-10-02T10:00:00');
  assert.equal(plan.daily_plans[1].nodes[0].start_time, '2026-10-02T10:45:00');
  assert.equal(validatePlanHealth(plan, profile).passed, true);
});

test('同城换酒店会按入住退房日选择锚点并拆分住宿阶段', () => {
  const source = sourcePlan();
  source.accommodations = [
    { city: '京都', country: '日本', landmark: 'Hotel A', check_in_day: 1, check_out_day: 2, coordinates: { lat: 35, lng: 135.75 } },
    { city: '京都', country: '日本', landmark: 'Hotel B', check_in_day: 2, check_out_day: 3, coordinates: { lat: 35.02, lng: 135.77 } },
  ];
  const plan = buildExecutableItinerary(source, profile);
  assert.equal(plan.daily_plans[0].nodes[0].name, 'Hotel A');
  assert.equal(plan.daily_plans[1].nodes[0].name, 'Hotel B');
  assert.equal(plan.stages.length, 2);
});

test('距离策略会在步行、市内交通、城际铁路和远程飞机之间选择', () => {
  const transportProfile = {
    ...profile,
    maxWalkingKm: 6,
    transport: {
      priority: 'time',
      allowedModes: ['WALK', 'TRANSIT', 'RAIL', 'FLIGHT'],
      avoidModes: [],
      distancePolicy: { walkMaxKm: 1, localTransitMaxKm: 30, flightMinKm: 800 },
    },
  };
  assert.equal(selectLegMode(
    { city: '京都', coordinates: { lat: 35, lng: 135.75 } },
    { city: '京都', coordinates: { lat: 35.004, lng: 135.75 } },
    transportProfile,
  ).mode, 'WALK');
  assert.equal(selectLegMode(
    { city: '京都', coordinates: { lat: 35, lng: 135.75 } },
    { city: '京都', coordinates: { lat: 35.05, lng: 135.75 } },
    transportProfile,
  ).mode, 'TRANSIT');
  assert.equal(selectLegMode(
    { city: '大阪', coordinates: { lat: 34.6937, lng: 135.5023 } },
    { city: '京都', coordinates: { lat: 35.0116, lng: 135.7681 } },
    transportProfile,
  ).mode, 'RAIL');
  assert.equal(selectLegMode(
    { city: '大阪', coordinates: { lat: 34.6937, lng: 135.5023 } },
    { city: '札幌', coordinates: { lat: 43.0618, lng: 141.3545 } },
    transportProfile,
  ).mode, 'FLIGHT');
});

test('京都到富士山的跨城连接保留新干线与巴士的真实分段并通过 health', async () => {
  const source = sourcePlan();
  source.title = '京都到富士山';
  source.city = '多城市';
  source.accommodations.push({
    city: '富士吉田', country: '日本', landmark: 'Fujisan Station',
    coordinates: { lat: 35.4884, lng: 138.7951 },
  });
  source.daily_plans[1].city = '富士吉田';
  source.daily_plans[1].spots[0].city = '富士吉田';
  source.daily_plans[1].spots[0].coordinates = { lat: 35.49, lng: 138.80 };
  const detailedProfile = {
    ...profile,
    transport: {
      priority: 'rail',
      allowedModes: ['WALK', 'TRANSIT', 'RAIL'],
      avoidModes: [],
      transitPreferences: {
        allowedModes: ['BUS', 'TRAIN', 'RAIL'], routingPreference: 'FEWER_TRANSFERS',
      },
      distancePolicy: { walkMaxKm: 1, localTransitMaxKm: 30, flightMinKm: 800 },
    },
  };
  let plan = buildExecutableItinerary(source, detailedProfile);
  plan = await calculatePlanRoutes(plan, {
    routeProvider: async ({ origin, destination, requestedMode }) => {
      if (requestedMode !== 'RAIL') {
        return {
          provider: 'fixture', geometry: [[origin.lat, origin.lng], [destination.lat, destination.lng]],
          distance_meters: 1000, duration_seconds: 600,
        };
      }
      const mishima = [35.1264, 138.9106];
      return {
        provider: 'fixture',
        geometry: [[origin.lat, origin.lng], mishima, [destination.lat, destination.lng]],
        distance_meters: 170000,
        duration_seconds: 10800,
        summary: '东海道新干线 → 富士急巴士',
        primary_vehicle: 'HIGH_SPEED_TRAIN',
        transfers: 1,
        segments: [
          {
            sequence: 0, travel_mode: 'TRANSIT', transit_vehicle_type: 'HIGH_SPEED_TRAIN',
            line: { name: '东海道新干线', vehicle: { type: 'HIGH_SPEED_TRAIN' } },
            from_stop: { name: '京都站' }, to_stop: { name: '三岛站' },
            distance_meters: 140000, duration_seconds: 7200,
            geometry: [[origin.lat, origin.lng], mishima],
          },
          {
            sequence: 1, travel_mode: 'TRANSIT', transit_vehicle_type: 'BUS',
            line: { name: '富士急巴士', vehicle: { type: 'BUS' } },
            from_stop: { name: '三岛站' }, to_stop: { name: '富士山站' },
            distance_meters: 30000, duration_seconds: 3600,
            geometry: [mishima, [destination.lat, destination.lng]],
          },
        ],
      };
    },
  });
  const connection = plan.daily_plans[0].connection_to_next;
  assert.equal(connection.status, 'available');
  assert.equal(connection.mode, 'RAIL');
  assert.equal(connection.summary, '东海道新干线 → 富士急巴士');
  assert.equal(connection.primary_vehicle, 'HIGH_SPEED_TRAIN');
  assert.equal(connection.segments.length, 2);
  assert.equal(connection.segments[0].to_stop.name, '三岛站');
  assert.equal(connection.segments[1].to_stop.name, '富士山站');
  const flattened = flattenRoutes(plan).find(route => route.connection_to_day === 2);
  assert.equal(flattened.segments.length, 2);
  assert.equal(flattened.transfers, 1);
  assert.equal(validatePlanHealth(plan, detailedProfile).passed, true);
});
