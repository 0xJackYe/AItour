process.env.LOG_LEVEL ||= 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeAllSpots, isInTargetCity, metroRadiusKm, placeNameMatches, spotLocationKey } from '../services/geocode.js';
import { resetGoogleClient } from '../services/google.js';
import { normalizePlan } from '../services/planSchema.js';
import { buildMockPlan, createMockUpstream } from '../testing/mockUpstream.js';

const tokyoContext = {
  lat: 35.6762,
  lng: 139.6503,
  countryCode: 'JP',
  targetAdministrativeNames: ['东京', 'tokyo'],
  viewport: {
    // Google 的东京都 viewport 包含远海岛屿，矩形会覆盖到静冈附近。
    low: { latitude: 20.4231216, longitude: 136.0696826 },
    high: { latitude: 35.8984074, longitude: 153.9867945 },
  },
};

const parisContext = {
  lat: 48.8566,
  lng: 2.3522,
  countryCode: 'FR',
  targetAdministrativeNames: ['巴黎', 'paris'],
  viewport: { low: { latitude: 48.8156, longitude: 2.2242 }, high: { latitude: 48.9022, longitude: 2.4699 } },
};

const beijingContext = {
  lat: 39.9042,
  lng: 116.4074,
  countryCode: 'CN',
  targetAdministrativeNames: ['北京', 'beijing'],
  viewport: { low: { latitude: 39.4427, longitude: 115.4234 }, high: { latitude: 41.0608, longitude: 117.5146 } },
};

function place(latitude, longitude, countryCode = 'JP', administrativeName = 'Tokyo') {
  return {
    location: { latitude, longitude },
    addressComponents: [
      { longText: administrativeName, shortText: administrativeName, types: ['administrative_area_level_1'] },
      { longText: '国家', shortText: countryCode, types: ['country'] },
    ],
  };
}

test('东京范围内候选通过城市校验', () => {
  assert.equal(isInTargetCity(place(35.7148, 139.7967), tokyoContext), true);
});

test('静冈同名候选即使文本相同也会被拒绝', () => {
  assert.equal(isInTargetCity(place(35.1184, 138.9186, 'JP', 'Shizuoka'), tokyoContext), false);
  assert.equal(isInTargetCity(place(34.9846, 138.3725, 'JP', 'Shizuoka'), tokyoContext), false);
});

test('位于视口内但国家不一致的候选会被拒绝', () => {
  assert.equal(isInTargetCity(place(35.7, 139.7, 'US'), tokyoContext), false);
});

test('近郊景点不再被误删：凡尔赛宫属于巴黎行程', () => {
  assert.equal(isInTargetCity(place(48.8049, 2.1204, 'FR', 'Versailles'), parisContext), true);
});

test('近郊景点不再被误删：东京迪士尼（千叶县浦安）属于东京行程', () => {
  assert.equal(isInTargetCity(place(35.6329, 139.8804, 'JP', 'Chiba'), tokyoContext), true);
});

test('大型直辖市按行政区匹配：慕田峪长城属于北京', () => {
  assert.equal(isInTargetCity(place(40.4319, 116.5704, 'CN', 'Beijing'), beijingContext), true);
});

test('超过 150km 的同名行政区仍然拒绝', () => {
  assert.equal(isInTargetCity(place(42.5, 116.4, 'CN', 'Beijing'), beijingContext), false);
});

test('都市圈半径由城市视口推算并有上下限', () => {
  assert.equal(metroRadiusKm(parisContext.viewport), 40);
  assert.equal(metroRadiusKm(tokyoContext.viewport), 60);
  assert.equal(metroRadiusKm(null), 40);
});

test('同名景点使用天和序号作为唯一键，不会覆盖', () => {
  assert.notEqual(spotLocationKey(0, 0), spotLocationKey(1, 0));
  assert.notEqual(spotLocationKey(0, 0), spotLocationKey(0, 1));
});

test('地点名称不一致时不会因位于同一城市而误收', () => {
  const latinBridge = { displayName: { text: 'Latin Bridge' } };
  assert.equal(placeNameMatches(latinBridge, 'Stari Most (Old Bridge), Mostar', 'Sarajevo', 'Bosnia and Herzegovina'), false);
});

test('英文官方名的常见词形差异仍可正确匹配', () => {
  const basilica = { displayName: { text: "St. Mark's Basilica" } };
  assert.equal(placeNameMatches(basilica, "Saint Mark's Basilica, Venice", 'Venice', 'Italy'), true);
});

test('只有通用词的名称要求通用词一致（京都塔 ≠ 京都站）', () => {
  assert.equal(placeNameMatches({ displayName: { text: 'Kyoto Station' } }, 'Kyoto Tower', 'Kyoto', 'Japan'), false);
  assert.equal(placeNameMatches({ displayName: { text: 'Kyoto Tower' } }, 'Kyoto Tower, Kyoto', 'Kyoto', 'Japan'), true);
});

test('中文名称匹配兼容别名、繁简与日文汉字差异', () => {
  const name = text => ({ displayName: { text } });
  assert.equal(placeNameMatches(name('音羽山清水寺'), '清水寺', '京都', '日本'), true);
  assert.equal(placeNameMatches(name('伏見稻荷大社'), '伏见稻荷大社', '京都', '日本'), true);
  assert.equal(placeNameMatches(name('东京铁塔'), '东京塔', '东京', '日本'), true);
  assert.equal(placeNameMatches(name('浅草神社'), '浅草寺', '东京', '日本'), false);
});

function withUpstream(options, fn) {
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

test('端到端落地：巴黎行程保留凡尔赛宫并全部定位', withUpstream({}, async () => {
  const plan = normalizePlan(buildMockPlan('paris', 2), { expectedDays: 2 });
  assert.ok(plan.daily_plans.flatMap(day => day.spots).some(spot => spot.name === '凡尔赛宫'));
  const result = await geocodeAllSpots(plan);
  const spots = result.plan.daily_plans.flatMap(day => day.spots);
  assert.ok(spots.find(spot => spot.name === '凡尔赛宫')?.coordinates, '凡尔赛宫应被定位');
  assert.equal(result.stats.verified, spots.length);
  assert.equal(result.rejectedSpots.length, 0);
  assert.ok(result.plan.accommodations[0].coordinates, '住宿地标应被定位');
}));

test('端到端落地：京都 → 奈良一日游被接受', withUpstream({}, async () => {
  const plan = normalizePlan(buildMockPlan('kyoto', 3, { userMessage: '京都三天，其中一天去奈良公园' }), { expectedDays: 3 });
  const result = await geocodeAllSpots(plan);
  const nara = result.plan.daily_plans.flatMap(day => day.spots).find(spot => spot.name === '奈良公园');
  assert.ok(nara?.coordinates);
  assert.equal(nara.city, '奈良');
}));

test('端到端落地：标为东京的静冈同名神社被剔除并说明原因', withUpstream({}, async () => {
  const raw = buildMockPlan('tokyo', 1);
  raw.daily_plans[0].spots.push({ name: '静冈浅间神社', name_en: 'Shizuoka Sengen Shrine, Tokyo', city: '东京', country: '日本', type: 'attraction' });
  const result = await geocodeAllSpots(normalizePlan(raw, { expectedDays: 1 }));
  const names = result.plan.daily_plans[0].spots.map(spot => spot.name);
  assert.ok(!names.includes('静冈浅间神社'));
  assert.equal(result.rejectedSpots.length, 1);
  assert.match(result.rejectedSpots[0].reason, /km/);
}));

test('端到端落地：明确标注的近距离一日游（东京 → 静冈，约 140km）被接受', withUpstream({}, async () => {
  const raw = buildMockPlan('tokyo', 1);
  raw.daily_plans[0].spots = [{ name: '静冈浅间神社', name_en: 'Shizuoka Sengen Shrine, Shizuoka', city: '静冈', country: '日本' }];
  const result = await geocodeAllSpots(normalizePlan(raw, { expectedDays: 1 }));
  assert.ok(result.plan.daily_plans[0].spots[0].coordinates);
  assert.equal(result.rejectedSpots.length, 0);
}));

test('端到端落地：超过 150km 的“一日游”被拒绝（东京行程里的京都清水寺）', withUpstream({}, async () => {
  const raw = buildMockPlan('tokyo', 1);
  raw.daily_plans[0].spots = [{ name: '清水寺', name_en: 'Kiyomizu-dera, Kyoto', city: '京都', country: '日本' }];
  const result = await geocodeAllSpots(normalizePlan(raw, { expectedDays: 1 }));
  assert.equal(result.plan.daily_plans[0].spots.length, 0);
  assert.match(result.rejectedSpots[0].reason, /超出当日可往返范围/);
}));

test('端到端落地：找不到的地点保留为“未定位”而不是删除', withUpstream({}, async () => {
  const raw = buildMockPlan('kyoto', 1);
  raw.daily_plans[0].spots.push({ name: '不存在的小店', name_en: 'Nonexistent Shop, Kyoto', city: '京都', country: '日本' });
  const result = await geocodeAllSpots(normalizePlan(raw, { expectedDays: 1 }));
  const shop = result.plan.daily_plans[0].spots.find(spot => spot.name === '不存在的小店');
  assert.ok(shop);
  assert.equal(shop.coordinates, null);
  assert.equal(shop.location_status, 'unverified');
  assert.ok(result.warnings.some(item => item.code === 'not_found'));
}));

test('Google 短暂 503 会自动重试，不影响结果', withUpstream({ googleFailures: 2 }, async () => {
  const result = await geocodeAllSpots(normalizePlan(buildMockPlan('kyoto', 1), { expectedDays: 1 }));
  assert.equal(result.stats.verified, 3);
}));

test('相同城市与地点的查询命中缓存', withUpstream({}, async (upstream) => {
  const plan = normalizePlan(buildMockPlan('kyoto', 1), { expectedDays: 1 });
  await geocodeAllSpots(plan);
  const first = { geocode: upstream.calls.geocode, places: upstream.calls.places };
  await geocodeAllSpots(plan);
  assert.equal(upstream.calls.geocode, first.geocode);
  assert.equal(upstream.calls.places, first.places);
}));

test('未配置 Google Key 时降级：保留行程、不定位、给出一条提示', async () => {
  const env = { ...process.env };
  delete process.env.GOOGLE_MAPS_API_KEY;
  try {
    const result = await geocodeAllSpots(normalizePlan(buildMockPlan('kyoto', 1), { expectedDays: 1 }));
    assert.equal(result.plan.daily_plans[0].spots.length, 3);
    assert.ok(result.plan.daily_plans[0].spots.every(spot => spot.coordinates === null));
    assert.deepEqual(result.warnings.map(item => item.code), ['maps_unavailable']);
  } finally {
    process.env = env;
  }
});
