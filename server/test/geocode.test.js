import test from 'node:test';
import assert from 'node:assert/strict';
import { isInTargetCity, placeNameMatches, spotLocationKey } from '../services/geocode.js';

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
