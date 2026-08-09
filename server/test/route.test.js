import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleRouteRequest,
  getRouteForLeg,
  getRouteForLegWithFallback,
  GOOGLE_ROUTE_FIELD_MASK,
  parseGoogleRouteResponse,
  transitDepartureRequest,
} from '../services/route.js';

const from = { coordinates: { lat: 35, lng: 135 } };
const to = { coordinates: { lat: 35.1, lng: 135.1 } };
const FIXTURE_POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

function routeStep(travelMode, distanceMeters, vehicleType = null, lineName = null) {
  return {
    travelMode,
    distanceMeters,
    staticDuration: `${Math.max(60, Math.round(distanceMeters / 2))}s`,
    polyline: { encodedPolyline: FIXTURE_POLYLINE },
    ...(travelMode === 'TRANSIT' ? {
      transitDetails: {
        transitLine: {
          name: lineName || vehicleType,
          vehicle: { type: vehicleType, name: { text: vehicleType } },
        },
      },
    } : {}),
  };
}

function alternativeRoute(steps, duration = '1200s') {
  return {
    distanceMeters: steps.reduce((sum, step) => sum + step.distanceMeters, 0),
    duration,
    polyline: { encodedPolyline: FIXTURE_POLYLINE },
    legs: [{ steps }],
  };
}

test('逐段路线支持依赖注入并保留实际方式', async () => {
  const result = await getRouteForLeg(from, to, 'TRANSIT', {
    routeProvider: async ({ mode }) => ({
      provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
      distance_meters: 15000, duration_seconds: 1800, mode,
    }),
  });
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'TRANSIT');
  assert.equal(result.provider, 'fixture');
});

test('路线端点优先把节点 Place ID 交给 Google，坐标数组必须为有限数值', async () => {
  let received;
  const result = await getRouteForLeg(
    { place_id: 'ChIJ-origin', coordinates: [35, 135] },
    { placeId: 'ChIJ-destination', coordinates: { lat: 35.1, lng: 135.1 } },
    'TRANSIT',
    {
      routeProvider: async args => {
        received = args;
        return {
          provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
          distance_meters: 1000, duration_seconds: 600,
        };
      },
    },
  );
  assert.equal(result.status, 'available');
  assert.equal(received.origin.placeId, 'ChIJ-origin');
  assert.equal(received.destination.placeId, 'ChIJ-destination');
  const request = buildGoogleRouteRequest({
    origin: received.origin,
    destination: received.destination,
    mode: 'TRANSIT',
  });
  assert.deepEqual(request.body.origin, { placeId: 'ChIJ-origin' });
  assert.deepEqual(request.body.destination, { placeId: 'ChIJ-destination' });

  let called = false;
  const invalid = await getRouteForLeg(
    { coordinates: [Number.NaN, 135] },
    { coordinates: [35.1, Number.POSITIVE_INFINITY] },
    'WALK',
    { routeProvider: async () => { called = true; } },
  );
  assert.equal(invalid.error_code, 'ROUTE_COORDINATES_MISSING');
  assert.equal(called, false);

  const emptyOrOutOfRange = await getRouteForLeg(
    { coordinates: { lat: null, lng: '' } },
    { coordinates: [false, 181] },
    'TRANSIT',
    { routeProvider: async () => { called = true; } },
  );
  assert.equal(emptyOrOutOfRange.error_code, 'ROUTE_COORDINATES_MISSING');
  assert.equal(called, false);
});

test('路线服务失败时返回 unavailable 且绝不伪造直线', async () => {
  const result = await getRouteForLeg(from, to, 'WALK', {
    routeProvider: async () => { throw new Error('quota'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.geometry, null);
  assert.equal(result.provider, null);

  const poisonedGeometry = await getRouteForLeg(from, to, 'WALK', {
    routeProvider: async () => ({
      provider: 'fixture', geometry: [[null, null], [35.1, 135.1]],
    }),
  });
  assert.equal(poisonedGeometry.status, 'unavailable');
  assert.equal(poisonedGeometry.error_code, 'ROUTE_PROVIDER_RESPONSE_INVALID');
  assert.equal(poisonedGeometry.geometry, null);
});

test('飞机等非 Google 市内路线不会被伪装成步行', async () => {
  const result = await getRouteForLeg(from, to, 'FLIGHT');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.mode, 'FLIGHT');
  assert.equal(result.geometry, null);
  assert.equal(result.estimated, true);
  assert.equal(result.error_code, 'INTERCITY_ROUTE_CONFIRMATION_REQUIRED');
});

test('首选路线不可用时只在用户允许的方式中回退', async () => {
  const attempted = [];
  const result = await getRouteForLegWithFallback(from, to, 'TRANSIT', {
    allowedModes: ['TRANSIT', 'WALK'],
    avoidModes: ['DRIVE'],
    routeProvider: async ({ mode }) => {
      attempted.push(mode);
      return mode === 'WALK' ? {
        provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
        distance_meters: 14000, duration_seconds: 10800,
      } : null;
    },
  });
  assert.deepEqual(attempted, ['TRANSIT', 'WALK']);
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'WALK');
  assert.equal(result.fallback_from_mode, 'TRANSIT');
});

test('公共交通失败时不会回退成长距离步行并违反步行上限', async () => {
  const attempted = [];
  const result = await getRouteForLegWithFallback(from, to, 'TRANSIT', {
    allowedModes: ['TRANSIT', 'WALK'],
    maxWalkingKm: 3,
    routeProvider: async ({ mode }) => {
      attempted.push(mode);
      return null;
    },
  });
  assert.deepEqual(attempted, ['TRANSIT']);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.mode, 'TRANSIT');
});

test('WALK 以 Google 实际距离复核，超单段上限后改试允许的 TRANSIT', async () => {
  const closeFrom = { coordinates: { lat: 34.666, lng: 135.501 } };
  const closeTo = { coordinates: { lat: 34.671, lng: 135.502 } };
  const attempted = [];
  const result = await getRouteForLegWithFallback(closeFrom, closeTo, 'WALK', {
    allowedModes: ['WALK', 'TRANSIT'],
    maxWalkingKm: 6,
    distancePolicy: { walkMaxKm: 1 },
    routeProvider: async ({ requestedMode }) => {
      attempted.push(requestedMode);
      return requestedMode === 'WALK'
        ? {
            provider: 'fixture', geometry: [[34.666, 135.501], [34.671, 135.502]],
            distance_meters: 3500, duration_seconds: 2700,
          }
        : {
            provider: 'fixture', geometry: [[34.666, 135.501], [34.671, 135.502]],
            distance_meters: 1200, duration_seconds: 600,
          };
    },
  });
  assert.deepEqual(attempted, ['WALK', 'TRANSIT']);
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'TRANSIT');
  assert.equal(result.fallback_from_mode, 'WALK');
});

test('日本 WALK 实际超限且 Transit 空覆盖时转为人工确认，不保留超限假可用路线', async () => {
  const japanFrom = { country: '日本', coordinates: { lat: 34.666, lng: 135.501 } };
  const japanTo = { country: 'JP', coordinates: { lat: 34.671, lng: 135.502 } };
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'WALK', {
    allowedModes: ['WALK', 'TRANSIT'],
    maxWalkingKm: 6,
    distancePolicy: { walkMaxKm: 1 },
    routeProvider: async ({ requestedMode }) => requestedMode === 'WALK'
      ? {
          provider: 'fixture', geometry: [[34.666, 135.501], [34.671, 135.502]],
          distance_meters: 3500, duration_seconds: 2700,
        }
      : null,
  });
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.mode, 'TRANSIT');
  assert.equal(result.fallback_from_mode, 'WALK');
  assert.equal(result.provider_limit_code, 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED');
  assert.equal(result.geometry, null);
});

test('WALK 超限后 Transit provider 硬失败仍优先暴露真实错误', async () => {
  const japanFrom = { country: '日本', coordinates: { lat: 34.666, lng: 135.501 } };
  const japanTo = { country: '日本', coordinates: { lat: 34.671, lng: 135.502 } };
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'WALK', {
    allowedModes: ['WALK', 'TRANSIT'],
    distancePolicy: { walkMaxKm: 1 },
    routeProvider: async ({ requestedMode }) => {
      if (requestedMode === 'WALK') {
        return {
          geometry: [[34.666, 135.501], [34.671, 135.502]],
          distance_meters: 3500, duration_seconds: 2700,
        };
      }
      throw new Error('quota');
    },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'ROUTE_PROVIDER_ERROR');
  assert.equal(result.provider_limit_code, undefined);
});

test('Google Transit 响应会解析新干线、巴士、站点、线路和分段轨迹', () => {
  const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const result = parseGoogleRouteResponse({
    routes: [{
      distanceMeters: 170000,
      duration: '10800s',
      polyline: { encodedPolyline: encoded },
      legs: [{ steps: [
        {
          travelMode: 'TRANSIT', distanceMeters: 140000, staticDuration: '7200s',
          localizedValues: { staticDuration: { text: '2 小时', languageCode: 'zh-CN' } },
          polyline: { encodedPolyline: encoded },
          startLocation: { latLng: { latitude: 34.985, longitude: 135.758 } },
          endLocation: { latLng: { latitude: 35.126, longitude: 138.91 } },
          transitDetails: {
            localizedValues: {
              departureTime: { time: { text: '上午9:10' }, timeZone: 'Asia/Tokyo' },
              arrivalTime: { time: { text: '上午11:10' }, timeZone: 'Asia/Tokyo' },
            },
            stopDetails: {
              departureStop: { name: '京都站', location: { latLng: { latitude: 34.985, longitude: 135.758 } } },
              arrivalStop: { name: '三岛站', location: { latLng: { latitude: 35.126, longitude: 138.91 } } },
              departureTime: '2026-10-02T00:10:00Z', arrivalTime: '2026-10-02T02:10:00Z',
            },
            headsign: '东京方向', stopCount: 4, tripShortText: 'Hikari 500',
            transitLine: {
              name: '东海道新干线', nameShort: 'Hikari', color: '#0052a4',
              vehicle: { type: 'HIGH_SPEED_TRAIN', name: { text: '新干线' } },
              agencies: [{ name: 'JR东海' }],
            },
          },
        },
        {
          travelMode: 'TRANSIT', distanceMeters: 30000, staticDuration: '3600s',
          polyline: { encodedPolyline: encoded },
          startLocation: { latLng: { latitude: 35.126, longitude: 138.91 } },
          endLocation: { latLng: { latitude: 35.488, longitude: 138.795 } },
          transitDetails: {
            stopDetails: {
              departureStop: { name: '三岛站', location: { latLng: { latitude: 35.126, longitude: 138.91 } } },
              arrivalStop: { name: '富士山站', location: { latLng: { latitude: 35.488, longitude: 138.795 } } },
            },
            headsign: '河口湖方向', stopCount: 8,
            transitLine: {
              name: '富士急巴士', color: '#d71920',
              vehicle: { type: 'BUS', name: { text: '巴士' } },
              agencies: [{ name: 'Fujikyuko Bus' }],
            },
          },
        },
      ] }],
    }],
  }, { requestedMode: 'RAIL', scheduleRecheckRequired: true, scheduleBasis: 'representative' });

  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].transit_vehicle_type, 'HIGH_SPEED_TRAIN');
  assert.equal(result.segments[0].line.name, '东海道新干线');
  assert.equal(result.segments[0].from_stop.name, '京都站');
  assert.equal(result.segments[0].to_stop.name, '三岛站');
  assert.equal(result.segments[0].departure_time, '2026-10-02T00:10:00Z');
  assert.equal(result.segments[0].arrival_time, '2026-10-02T02:10:00Z');
  assert.equal(result.segments[0].localized_duration.text, '2 小时');
  assert.equal(result.segments[0].localized_departure_time.time.text, '上午9:10');
  assert.equal(result.segments[0].localized_departure_time.timeZone, 'Asia/Tokyo');
  assert.equal(result.segments[1].transit_vehicle_type, 'BUS');
  assert.equal(result.segments[1].to_stop.name, '富士山站');
  assert.equal(result.summary, 'Hikari → 富士急巴士');
  assert.equal(result.primary_vehicle, 'HIGH_SPEED_TRAIN');
  assert.equal(result.transfers, 1);
  assert.equal(result.schedule_recheck_required, true);
  assert.equal(result.schedule_basis, 'representative');
  assert.ok(result.geometry.length >= 2);
});

test('Google HTTP 200 但 routes 为空时明确视为无路线', async () => {
  assert.equal(parseGoogleRouteResponse({}), null);
  assert.equal(parseGoogleRouteResponse({ routes: [] }), null);
  const result = await getRouteForLeg(from, to, 'TRANSIT', { routeProvider: async () => null });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'ROUTE_NOT_FOUND');
  assert.equal(result.geometry, null);
});

test('Google 已返回 route 但响应结构或几何损坏时标记 provider response invalid', async () => {
  assert.throws(
    () => parseGoogleRouteResponse({ routes: {} }),
    error => error.code === 'ROUTE_PROVIDER_RESPONSE_INVALID',
  );
  assert.throws(
    () => parseGoogleRouteResponse({ routes: [{ distanceMeters: 1000, legs: [] }] }),
    error => error.code === 'ROUTE_PROVIDER_RESPONSE_INVALID' && /几何/.test(error.message),
  );
  assert.throws(
    () => parseGoogleRouteResponse({ routes: [{ polyline: { encodedPolyline: '?' }, legs: 'broken' }] }),
    error => error.code === 'ROUTE_PROVIDER_RESPONSE_INVALID',
  );

  const result = await getRouteForLeg(from, to, 'TRANSIT', {
    routeProvider: async () => ({ geometry: [[35, 135], [Number.NaN, 135.1]] }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'ROUTE_PROVIDER_RESPONSE_INVALID');
  assert.match(result.reason, /无法验证/);
});

test('Transit 跳过首个全 WALK alternative 并选择后续真实地铁路线', () => {
  const result = parseGoogleRouteResponse({
    routes: [
      alternativeRoute([routeStep('WALK', 3500)], '900s'),
      alternativeRoute([
        routeStep('WALK', 200),
        routeStep('TRANSIT', 5000, 'SUBWAY', '大阪地铁中央线'),
      ], '1200s'),
    ],
  }, { requestedMode: 'TRANSIT', providerMode: 'TRANSIT' });
  assert.equal(result.google_route_index, 1);
  assert.equal(result.primary_vehicle, 'SUBWAY');
  assert.ok(result.segments.some(segment => segment.travel_mode === 'TRANSIT'));
});

test('Transit 会检查主路线加三条额外路线并选择第四条真实铁路', () => {
  const result = parseGoogleRouteResponse({
    routes: [
      alternativeRoute([routeStep('WALK', 3000)], '900s'),
      alternativeRoute([routeStep('WALK', 3200)], '950s'),
      alternativeRoute([routeStep('WALK', 3400)], '1000s'),
      alternativeRoute([
        routeStep('WALK', 100),
        routeStep('TRANSIT', 12000, 'TRAIN', 'JR 京都线'),
      ], '1100s'),
    ],
  }, { requestedMode: 'RAIL', providerMode: 'TRANSIT' });
  assert.equal(result.google_route_index, 3);
  assert.equal(result.primary_vehicle, 'TRAIN');
});

test('LESS_WALKING 在有效 Transit alternatives 中优先真实步行更少的路线', () => {
  const result = parseGoogleRouteResponse({
    routes: [
      alternativeRoute([
        routeStep('WALK', 1200),
        routeStep('TRANSIT', 5000, 'SUBWAY', '快速地铁'),
      ], '600s'),
      alternativeRoute([
        routeStep('WALK', 100),
        routeStep('TRANSIT', 5200, 'SUBWAY', '少步行地铁'),
      ], '900s'),
    ],
  }, {
    requestedMode: 'TRANSIT', providerMode: 'TRANSIT',
    transitPreferences: { routingPreference: 'LESS_WALKING' },
  });
  assert.equal(result.google_route_index, 1);
  assert.equal(result.summary, '少步行地铁');
});

test('RAIL 拒绝纯 BUS/纯 WALK alternatives，但普通 TRANSIT 可接受 BUS', () => {
  const pureBus = alternativeRoute([
    routeStep('WALK', 100),
    routeStep('TRANSIT', 20000, 'BUS', '高速巴士'),
  ], '1800s');
  const pureWalk = alternativeRoute([routeStep('WALK', 5000)], '3600s');
  assert.equal(parseGoogleRouteResponse({ routes: [pureBus, pureWalk] }, {
    requestedMode: 'RAIL', providerMode: 'TRANSIT',
  }), null);
  const transit = parseGoogleRouteResponse({ routes: [pureBus] }, {
    requestedMode: 'TRANSIT', providerMode: 'TRANSIT',
  });
  assert.equal(transit.primary_vehicle, 'BUS');
});

test('日本 Transit alternatives 全 WALK 时按模式无路线安全转人工确认', async () => {
  const allWalkResponse = { routes: [
    alternativeRoute([routeStep('WALK', 3500)], '2700s'),
    alternativeRoute([routeStep('WALK', 4200)], '3000s'),
  ] };
  const japanFrom = { country: '日本', coordinates: { lat: 34.7025, lng: 135.4959 } };
  const japanTo = { country: 'JP', coordinates: { lat: 34.6873, lng: 135.5262 } };
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'TRANSIT', {
    allowedModes: ['TRANSIT'],
    routeProvider: async ({ requestedMode, mode, transitPreferences }) =>
      parseGoogleRouteResponse(allWalkResponse, {
        requestedMode, providerMode: mode, transitPreferences,
      }),
  });
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.provider_limit_code, 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED');
  assert.equal(result.geometry, null);
});

test('铁路偏好映射为 Google TRANSIT + TRAIN/RAIL/BUS 接驳，并保留少换乘偏好', () => {
  const now = Date.UTC(2026, 8, 1);
  const request = buildGoogleRouteRequest({
    origin: { lat: 35, lng: 135 }, destination: { lat: 36, lng: 136 },
    mode: 'TRANSIT', requestedMode: 'RAIL', departureTime: '2026-09-02T09:00:00+09:00',
    transitPreferences: { allowedModes: ['BUS'], routingPreference: 'FEWER_TRANSFERS' },
  }, now);
  assert.equal(request.body.travelMode, 'TRANSIT');
  assert.deepEqual(request.body.transitPreferences, {
    allowedTravelModes: ['TRAIN', 'RAIL', 'BUS'], routingPreference: 'FEWER_TRANSFERS',
  });
  assert.equal(request.body.computeAlternativeRoutes, true);
  assert.equal(request.scheduleRecheckRequired, false);
  assert.ok(request.body.departureTime);
  assert.match(GOOGLE_ROUTE_FIELD_MASK, /routes\.legs\.steps\.transitDetails/);
  assert.match(GOOGLE_ROUTE_FIELD_MASK, /routes\.legs\.steps\.localizedValues/);
  assert.match(GOOGLE_ROUTE_FIELD_MASK, /routes\.legs\.steps\.transitDetails\.localizedValues/);
  assert.match(GOOGLE_ROUTE_FIELD_MASK, /routes\.legs\.steps\.polyline\.encodedPolyline/);
});

test('超出 Google 公交时刻窗口时使用同星期白天代表时刻并要求复核', () => {
  const now = Date.UTC(2026, 0, 1);
  const departure = transitDepartureRequest('2026-06-01T09:00:00Z', now);
  assert.ok(departure.departureTime);
  assert.equal(departure.schedule_recheck_required, true);
  assert.equal(departure.schedule_basis, 'representative');
  assert.equal(new Date(departure.departureTime).getUTCDay(), new Date('2026-06-01T09:00:00Z').getUTCDay());
  assert.equal(new Date(departure.departureTime).getUTCHours(), 9);
  const request = buildGoogleRouteRequest({
    origin: { lat: 35, lng: 135 }, destination: { lat: 36, lng: 136 },
    mode: 'TRANSIT', departureTime: '2026-06-01T09:00:00Z',
    transitPreferences: { allowedModes: ['BUS', 'SUBWAY'], routingPreference: 'LESS_WALKING' },
  }, now);
  assert.equal(request.body.departureTime, departure.departureTime);
  assert.deepEqual(request.body.transitPreferences, {
    allowedTravelModes: ['BUS', 'SUBWAY'], routingPreference: 'LESS_WALKING',
  });
  assert.equal(request.scheduleRecheckRequired, true);
  assert.equal(request.scheduleBasis, 'representative');
});

test('公交支持窗口两端预留五分钟安全余量', () => {
  const now = Date.UTC(2026, 0, 8, 12, 0, 0);
  const justOutsidePastSafety = new Date(now - 7 * 24 * 60 * 60 * 1000 + 4 * 60 * 1000).toISOString();
  const justInsidePastSafety = new Date(now - 7 * 24 * 60 * 60 * 1000 + 6 * 60 * 1000).toISOString();
  assert.equal(transitDepartureRequest(justOutsidePastSafety, now).schedule_basis, 'representative');
  assert.equal(transitDepartureRequest(justInsidePastSafety, now).schedule_basis, 'requested');
});

test('RAIL 会调用 Google TRANSIT，失败后可继续尝试允许的普通公共交通', async () => {
  const attempted = [];
  const result = await getRouteForLegWithFallback(from, to, 'RAIL', {
    allowedModes: ['RAIL', 'TRANSIT'],
    transitPreferences: { allowedModes: ['TRAIN', 'RAIL'] },
    routeProvider: async ({ mode, requestedMode, transitPreferences }) => {
      attempted.push({ mode, requestedMode, allowedModes: transitPreferences.allowedModes });
      if (requestedMode === 'RAIL') return null;
      return {
        provider: 'fixture', geometry: [[35, 135], [35.1, 135.1]],
        distance_meters: 15000, duration_seconds: 1800,
      };
    },
  });
  assert.deepEqual(attempted, [
    { mode: 'TRANSIT', requestedMode: 'RAIL', allowedModes: ['TRAIN', 'RAIL', 'BUS'] },
    { mode: 'TRANSIT', requestedMode: 'TRANSIT', allowedModes: ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'] },
  ]);
  assert.equal(result.status, 'available');
  assert.equal(result.mode, 'TRANSIT');
  assert.equal(result.fallback_from_mode, 'RAIL');
});

test('日本 Transit 官方覆盖为空时返回诚实确认项和安全的 Google Maps 链接', async () => {
  const japanFrom = {
    country: '日本', place_id: 'ChIJ Kyoto/Station', coordinates: { lat: 34.9858, lng: 135.7588 },
  };
  const japanTo = {
    country: 'Japan', placeId: 'ChIJ Fujisan?Station', coordinates: { lat: 35.4884, lng: 138.7951 },
  };
  const attempted = [];
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'RAIL', {
    allowedModes: ['RAIL', 'TRANSIT'],
    routeProvider: async ({ requestedMode }) => {
      attempted.push(requestedMode);
      return null;
    },
  });
  assert.deepEqual(attempted, ['RAIL', 'TRANSIT']);
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.provider_limit_code, 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED');
  assert.equal(result.summary, '日本公共交通 · Google Maps 实时确认');
  assert.equal(result.estimated, true);
  assert.ok(result.distance_meters > 0);
  assert.ok(result.duration_seconds > 0);
  assert.equal(result.geometry, null);
  assert.deepEqual(result.segments, []);
  const directions = new URL(result.external_directions_url);
  assert.equal(directions.origin, 'https://www.google.com');
  assert.equal(directions.pathname, '/maps/dir/');
  assert.equal(directions.searchParams.get('travelmode'), 'transit');
  assert.equal(directions.searchParams.get('origin_place_id'), 'ChIJ Kyoto/Station');
  assert.equal(directions.searchParams.get('destination_place_id'), 'ChIJ Fujisan?Station');
});

test('日本 Transit 的真实 provider 错误不会被覆盖限制降级掩盖', async () => {
  const japanFrom = { country: 'JP', coordinates: { lat: 35, lng: 135 } };
  const japanTo = { country: '日本', coordinates: { lat: 35.1, lng: 135.1 } };
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'TRANSIT', {
    allowedModes: ['TRANSIT'],
    routeProvider: async () => { throw new Error('quota'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'ROUTE_PROVIDER_ERROR');
  assert.equal(result.provider_limit_code, undefined);
});

test('fallback 先遇到 no route、后遇到硬失败时优先返回 provider 错误', async () => {
  const attempted = [];
  const providerFailure = await getRouteForLegWithFallback(from, to, 'RAIL', {
    allowedModes: ['RAIL', 'TRANSIT'],
    routeProvider: async ({ requestedMode }) => {
      attempted.push(requestedMode);
      if (requestedMode === 'RAIL') return null;
      throw new Error('network');
    },
  });
  assert.deepEqual(attempted, ['RAIL', 'TRANSIT']);
  assert.equal(providerFailure.error_code, 'ROUTE_PROVIDER_ERROR');

  const malformedFailure = await getRouteForLegWithFallback(from, to, 'RAIL', {
    allowedModes: ['RAIL', 'TRANSIT'],
    routeProvider: async ({ requestedMode }) => requestedMode === 'RAIL'
      ? null
      : { geometry: [[35, 135], [Number.POSITIVE_INFINITY, 135.1]] },
  });
  assert.equal(malformedFailure.error_code, 'ROUTE_PROVIDER_RESPONSE_INVALID');
});

test('日本 Transit 的 malformed route 不会被误判为官方空覆盖', async () => {
  const japanFrom = { country: '日本', coordinates: { lat: 35, lng: 135 } };
  const japanTo = { country: 'JP', coordinates: { lat: 35.1, lng: 135.1 } };
  const result = await getRouteForLegWithFallback(japanFrom, japanTo, 'RAIL', {
    allowedModes: ['RAIL', 'TRANSIT'],
    routeProvider: async ({ requestedMode }) => requestedMode === 'RAIL'
      ? null
      : { geometry: 'not-an-array' },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error_code, 'ROUTE_PROVIDER_RESPONSE_INVALID');
  assert.equal(result.provider_limit_code, undefined);
});
