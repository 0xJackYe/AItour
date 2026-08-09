import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cityContextFromGeocoderResult,
  geocodeCity,
  isInTargetCity,
  placeNameMatches,
  spotLocationKey,
} from '../services/geocode.js';

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

function place(latitude, longitude, countryCode = 'JP', administrativeName = 'Tokyo') {
  return {
    location: { latitude, longitude },
    addressComponents: [
      { longText: administrativeName, shortText: administrativeName, types: ['administrative_area_level_1'] },
      { longText: '日本', shortText: countryCode, types: ['country'] },
    ],
  };
}

test('东京范围内候选通过城市硬边界', () => {
  assert.equal(isInTargetCity(place(35.7148, 139.7967), tokyoContext), true);
});

test('静冈同名候选即使文本相同也会被城市硬边界拒绝', () => {
  assert.equal(isInTargetCity(place(35.1184, 138.9186, 'JP', 'Shizuoka'), tokyoContext), false);
});

test('位于视口内但国家不一致的候选会被拒绝', () => {
  assert.equal(isInTargetCity(place(35.7, 139.7, 'US'), tokyoContext), false);
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

test('城市锚点缺失时必须拒绝未验证的全球同名候选', () => {
  assert.equal(isInTargetCity(place(35.7, 139.7), null), false);
});

function geocoderResult({ latitude, longitude, types, administrativeName, viewport }) {
  return {
    types,
    formatted_address: `${administrativeName}, Japan`,
    geometry: {
      location: { lat: latitude, lng: longitude },
      viewport: viewport || {
        southwest: { lat: latitude - 0.005, lng: longitude - 0.005 },
        northeast: { lat: latitude + 0.005, lng: longitude + 0.005 },
      },
    },
    address_components: [
      { long_name: administrativeName, short_name: administrativeName, types: ['administrative_area_level_1'] },
      { long_name: '日本', short_name: 'JP', types: ['country'] },
    ],
  };
}

test('非行政 destination region 使用同国锚点 35km，接受富士山附近河口湖站', () => {
  const context = cityContextFromGeocoderResult('富士山', '日本', geocoderResult({
    latitude: 35.3606,
    longitude: 138.7274,
    types: ['natural_feature', 'establishment'],
    administrativeName: 'Yamanashi',
  }));
  const kawaguchiko = {
    ...place(35.4982, 138.7688, 'JP', 'Fujikawaguchiko'),
    displayName: { text: 'Kawaguchiko Station' },
  };
  assert.equal(context.boundaryMode, 'region_radius');
  assert.equal(context.viewport, null, '不得沿用天然景观的小 viewport');
  assert.equal(context.regionRadiusKm, 35);
  assert.equal(isInTargetCity(kawaguchiko, context), true);
  assert.equal(placeNameMatches(kawaguchiko, 'Kawaguchiko Station', '富士山', '日本'), true);
  assert.equal(isInTargetCity(place(35.0, 137.8, 'JP', 'Shizuoka'), context), false);
  assert.equal(isInTargetCity(place(35.4982, 138.7688, 'US', 'Fujikawaguchiko'), context), false);
});

test('行政城市仍使用严格 viewport 与行政名，东京同名候选不能落到静冈', () => {
  const context = cityContextFromGeocoderResult('东京', '日本', geocoderResult({
    latitude: 35.6762,
    longitude: 139.6503,
    types: ['locality', 'political'],
    administrativeName: 'Tokyo',
    viewport: {
      southwest: { lat: 20.4231216, lng: 136.0696826 },
      northeast: { lat: 35.8984074, lng: 153.9867945 },
    },
  }));
  const shizuokaDuplicate = {
    ...place(35.1184, 138.9186, 'JP', 'Shizuoka'),
    displayName: { text: 'Duplicate Place' },
  };
  assert.equal(context.boundaryMode, 'administrative');
  assert.equal(placeNameMatches(shizuokaDuplicate, 'Duplicate Place', '东京', '日本'), true);
  assert.equal(isInTargetCity(shizuokaDuplicate, context), false);
});

test('错误的富士山 geocoder sublocality 会由 Places 严格同名候选纠正锚点', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  let calls = 0;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  global.fetch = async url => {
    calls++;
    if (String(url).includes('/geocode/')) {
      return new Response(JSON.stringify({
        status: 'OK',
        results: [{
          place_id: 'wrong-fujiyama-ueda',
          formatted_address: 'Fujiyama, Ueda, Nagano, Japan',
          types: ['sublocality_level_1', 'political'],
          geometry: {
            location: { lat: 36.401, lng: 138.249 },
            viewport: {
              southwest: { lat: 36.39, lng: 138.23 },
              northeast: { lat: 36.42, lng: 138.27 },
            },
          },
          address_components: [
            { long_name: 'Nagano', short_name: 'Nagano', types: ['administrative_area_level_1'] },
            { long_name: '日本', short_name: 'JP', types: ['country'] },
          ],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      places: [{
        id: 'correct-mount-fuji',
        displayName: { text: '富士山' },
        formattedAddress: '日本、富士山',
        location: { latitude: 35.3606, longitude: 138.7274 },
        viewport: {
          low: { latitude: 35.34, longitude: 138.70 },
          high: { latitude: 35.39, longitude: 138.76 },
        },
        types: ['mountain_peak', 'natural_feature'],
        addressComponents: [
          { longText: '日本', shortText: 'JP', types: ['country'] },
        ],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const context = await geocodeCity('富士山', '日本');
    assert.equal(calls, 2);
    assert.equal(context.anchorSource, 'places_text');
    assert.equal(context.place_id, 'correct-mount-fuji');
    assert.equal(context.lat, 35.3606);
    assert.equal(context.lng, 138.7274);
    assert.equal(context.boundaryMode, 'region_radius');
    assert.equal(isInTargetCity(place(35.4982, 138.7688, 'JP', 'Fujikawaguchiko'), context), true);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});
