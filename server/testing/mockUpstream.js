// 测试用上游模拟：DeepSeek Chat Completions（JSON / SSE 流式）与 Google
// Geocoding、Places (searchText / searchNearby)、Routes。
// 通过替换 globalThis.fetch 生效；未匹配的请求透传给真实 fetch（例如测试客户端
// 访问本地 Express 服务）。使用真实坐标，能覆盖近郊景点、一日游与外地同名地点。

import { encodePolyline, haversineKm } from '../lib/geo.js';

export const CITIES = {
  kyoto: {
    names: ['京都', 'kyoto'], zh: '京都', countryZh: '日本', countryCode: 'JP', admin: 'Kyoto',
    lat: 35.0116, lng: 135.7681, viewport: [[34.8675, 135.559], [35.3212, 135.8798]],
    area: '四条河原町', landmark: '京都河原町站',
  },
  nara: {
    names: ['奈良', 'nara'], zh: '奈良', countryZh: '日本', countryCode: 'JP', admin: 'Nara',
    lat: 34.6851, lng: 135.8048, viewport: [[34.5732, 135.7489], [34.7467, 136.0868]],
    area: '奈良站', landmark: '近铁奈良站',
  },
  paris: {
    names: ['巴黎', 'paris'], zh: '巴黎', countryZh: '法国', countryCode: 'FR', admin: 'Paris',
    lat: 48.8566, lng: 2.3522, viewport: [[48.8156, 2.2242], [48.9022, 2.4699]],
    area: '夏特雷 / 玛黑区', landmark: '夏特雷站',
  },
  tokyo: {
    names: ['东京', 'tokyo', '東京'], zh: '东京', countryZh: '日本', countryCode: 'JP', admin: 'Tokyo',
    // 东京都的 Google 视口包含远海岛屿，矩形会覆盖到静冈附近。
    lat: 35.6762, lng: 139.6503, viewport: [[20.4231216, 136.0696826], [35.8984074, 153.9867945]],
    area: '上野', landmark: '上野站',
  },
  shizuoka: {
    names: ['静冈', 'shizuoka'], zh: '静冈', countryZh: '日本', countryCode: 'JP', admin: 'Shizuoka',
    lat: 34.9756, lng: 138.3828, viewport: [[34.8, 138.1], [35.6, 138.6]],
    area: '静冈站', landmark: '静冈站',
  },
};

// labelCity：模型给地点标注的城市；admin：Google 地址组件中的行政区。
export const PLACES = [
  { id: 'kiyomizu', city: 'kyoto', name: '清水寺', en: 'Kiyomizu-dera', lat: 34.9949, lng: 135.785 },
  { id: 'gion', city: 'kyoto', name: '祇园', en: 'Gion', lat: 35.0037, lng: 135.7788 },
  { id: 'fushimi', city: 'kyoto', name: '伏见稻荷大社', en: 'Fushimi Inari Taisha', lat: 34.9671, lng: 135.7727 },
  { id: 'nishiki', city: 'kyoto', name: '锦市场', en: 'Nishiki Market', lat: 35.005, lng: 135.7649, type: 'shopping' },
  { id: 'arashiyama', city: 'kyoto', name: '岚山竹林', en: 'Arashiyama Bamboo Grove', lat: 35.017, lng: 135.6713 },
  { id: 'kinkaku', city: 'kyoto', name: '金阁寺', en: 'Kinkaku-ji', lat: 35.0394, lng: 135.7292 },
  { id: 'nijo', city: 'kyoto', name: '二条城', en: 'Nijo Castle', lat: 35.0142, lng: 135.7482 },
  { id: 'ginkaku', city: 'kyoto', name: '银阁寺', en: 'Ginkaku-ji', lat: 35.027, lng: 135.7982 },
  { id: 'narapark', city: 'nara', name: '奈良公园', en: 'Nara Park', lat: 34.6851, lng: 135.843, admin: 'Nara' },
  { id: 'eiffel', city: 'paris', name: '埃菲尔铁塔', en: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 },
  { id: 'louvre', city: 'paris', name: '卢浮宫', en: 'Louvre Museum', lat: 48.8606, lng: 2.3376 },
  { id: 'versailles', city: 'paris', name: '凡尔赛宫', en: 'Palace of Versailles', lat: 48.8049, lng: 2.1204, admin: 'Versailles' },
  { id: 'notredame', city: 'paris', name: '巴黎圣母院', en: 'Notre-Dame de Paris', lat: 48.853, lng: 2.3499 },
  { id: 'montmartre', city: 'paris', name: '蒙马特高地', en: 'Montmartre', lat: 48.8867, lng: 2.3431 },
  { id: 'orsay', city: 'paris', name: '奥赛博物馆', en: "Musée d'Orsay", lat: 48.86, lng: 2.3266 },
  { id: 'sensoji', city: 'tokyo', name: '浅草寺', en: 'Senso-ji', lat: 35.7148, lng: 139.7967 },
  { id: 'disney', city: 'tokyo', name: '东京迪士尼乐园', en: 'Tokyo Disneyland', lat: 35.6329, lng: 139.8804, admin: 'Chiba' },
  { id: 'akiba', city: 'tokyo', name: '秋叶原', en: 'Akihabara', lat: 35.6984, lng: 139.7731 },
  { id: 'odaiba', city: 'tokyo', name: '台场', en: 'Odaiba', lat: 35.6267, lng: 139.7768 },
  { id: 'meiji', city: 'tokyo', name: '明治神宫', en: 'Meiji Jingu', lat: 35.6764, lng: 139.6993 },
  { id: 'shibuya', city: 'tokyo', name: '涩谷十字路口', en: 'Shibuya Crossing', lat: 35.6595, lng: 139.7005 },
  { id: 'sengen', city: 'shizuoka', name: '静冈浅间神社', en: 'Shizuoka Sengen Shrine', lat: 34.9846, lng: 138.3725, admin: 'Shizuoka' },
];

const STATIONS = {
  kyoto: [['京都河原町站', 0.0012, 0.0008], ['祇园四条站', -0.0009, 0.0021]],
  nara: [['近铁奈良站', 0.001, 0.001]],
  paris: [['夏特雷站', 0.0006, -0.0011], ['卢浮宫-里沃利站', 0.0014, 0.0007]],
  tokyo: [['上野站', 0.0008, 0.0006], ['京成上野站', -0.0012, 0.0004]],
  shizuoka: [['静冈站', 0.001, 0.001]],
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function cityFromText(textValue) {
  const lower = String(textValue || '').toLowerCase();
  return Object.entries(CITIES).find(([, city]) => city.names.some(name => lower.includes(name.toLowerCase())))?.[0] || null;
}

function cityFromQuery(userMessage) {
  const requirement = String(userMessage).split('【系统解析的硬性约束】')[0].split('【当前行程概要】')[0];
  // 用户需求里优先识别主城市（京都/巴黎/东京），避免“奈良一日游”被当作主城市。
  for (const key of ['kyoto', 'paris', 'tokyo']) {
    if (CITIES[key].names.some(name => requirement.toLowerCase().includes(name))) return key;
  }
  return cityFromText(requirement);
}

function daysFromMessage(userMessage) {
  const match = String(userMessage).match(/总天数：(\d+) 天/);
  if (match) return Number(match[1]);
  const plain = String(userMessage).match(/(\d+)\s*天/);
  return plain ? Number(plain[1]) : 3;
}

function placesFor(cityKey, userMessage) {
  const own = PLACES.filter(place => place.city === cityKey);
  // 用户点名的一日游城市（如京都→奈良）。
  const extras = PLACES.filter(place => place.city !== cityKey && place.city !== 'shizuoka' && String(userMessage).includes(place.name));
  return [...own, ...extras];
}

function spotFrom(place, { compact, labelCity }) {
  const city = CITIES[place.city];
  const spot = {
    name: place.name,
    name_en: `${place.en}, ${CITIES[labelCity || place.city].names[1].replace(/^./, ch => ch.toUpperCase())}`,
    city: CITIES[labelCity || place.city].zh,
    country: city.countryZh,
    type: place.type || 'attraction',
  };
  if (compact) return spot;
  return { ...spot, duration_hours: 2, description: `${place.name}的简短介绍`, tips: '建议提前出发' };
}

export function buildMockPlan(cityKey, days, { compact = false, userMessage = '', labelOverrides = {} } = {}) {
  const city = CITIES[cityKey];
  const pool = placesFor(cityKey, userMessage);
  const dailyPlans = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const spots = [0, 1, 2].map(offset => pool[(index * 3 + offset) % pool.length]);
    return {
      day,
      city: city.zh,
      country: city.countryZh,
      theme: `${city.zh}第${day}天`,
      spots: spots.map(place => spotFrom(place, { compact, labelCity: labelOverrides[place.id] || (place.city === 'nara' ? 'nara' : cityKey) })),
      transport_notes: '地铁与步行结合',
    };
  });
  return {
    title: `${city.zh}${days}日游`,
    city: city.zh,
    country: city.countryZh,
    days,
    summary: `${city.zh}经典${days}日行程`,
    preferences: { pace: 'moderate', budget: 'moderate', transport: 'public_transit', interests: ['文化'] },
    destinations: [{ city: city.zh, country: city.countryZh, start_day: 1, end_day: days }],
    accommodations: [{ city: city.zh, country: city.countryZh, area: city.area, reason: '交通便利，餐饮选择多', landmark: city.landmark }],
    daily_plans: dailyPlans,
    route_reasoning: '按区域安排，减少折返',
    practical_tips: ['提前购买交通卡'],
  };
}

function detailFor(userMessage) {
  const marker = '【不可更改的行程骨架】';
  const start = userMessage.indexOf(marker);
  const skeleton = JSON.parse(userMessage.slice(start + marker.length).trim());
  return {
    daily_plans: skeleton.daily_plans.map(day => ({
      day: day.day,
      theme: day.theme,
      transport_notes: '乘坐地铁',
      spots: day.spots.map(spot => ({ name: spot.name, duration_hours: 2, description: `${spot.name}的细化描述`, tips: '细化建议' })),
    })),
  };
}

function repairFor(userMessage) {
  const cityKey = cityFromQuery(userMessage) || 'kyoto';
  const wanted = [...String(userMessage).split('【需要补全的天】')[1].matchAll(/Day (\d+)/g)].map(match => Number(match[1]));
  const full = buildMockPlan(cityKey, Math.max(...wanted), { userMessage });
  return { daily_plans: full.daily_plans.filter(day => wanted.includes(day.day)) };
}

function sseResponse(content, { finishReason = 'stop', usage = { prompt_tokens: 100, completion_tokens: 200 } } = {}) {
  const encoder = new TextEncoder();
  const pieces = [];
  for (let index = 0; index < content.length; index += 180) pieces.push(content.slice(index, index + 180));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': keep-alive\n\n'));
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function completionResponse(payload, request, { finishReason = 'stop' } = {}) {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (request.stream) return sseResponse(content, { finishReason });
  return json({
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: Math.ceil(content.length / 2) },
  });
}

export function llmPurpose(systemPrompt) {
  if (systemPrompt.includes('长途旅行路线架构师')) return 'outline';
  if (systemPrompt.includes('旅行计划细化助手')) return 'detail';
  if (systemPrompt.includes('旅行计划补全助手')) return 'repair';
  if (systemPrompt.includes('旅行规划质量审核员')) return 'verify';
  return 'plan';
}

function placeResponse(place, languageCode) {
  const city = CITIES[place.city];
  return {
    id: `mock-${place.id}`,
    displayName: { text: languageCode === 'en' ? place.en : place.name, languageCode },
    formattedAddress: `${place.en}, ${place.admin || city.admin}, ${city.countryCode}`,
    location: { latitude: place.lat, longitude: place.lng },
    addressComponents: [
      { longText: place.admin || city.admin, shortText: place.admin || city.admin, types: ['locality', 'political'] },
      { longText: city.countryZh, shortText: city.countryCode, types: ['country', 'political'] },
    ],
    types: ['tourist_attraction'],
    googleMapsUri: `https://maps.google.com/?cid=${place.id}`,
  };
}

function insideRectangle(place, rectangle) {
  if (!rectangle) return true;
  return place.lat >= rectangle.low.latitude && place.lat <= rectangle.high.latitude
    && place.lng >= rectangle.low.longitude && place.lng <= rectangle.high.longitude;
}

/**
 * options:
 *  - stream: 请求带 stream=true 时以 SSE 返回（默认 true，覆盖流式解析路径）
 *  - llmDelayMs: 每次大模型调用的模拟耗时
 *  - llmFailures: 前 N 次大模型调用依次返回的 HTTP 状态码（如 [503, 429]）
 *  - planHook(plan, { purpose, call }): 修改生成结果以注入故障（缺天、错地点等）
 *  - finishReasons: 依次覆盖 plan / outline 调用的 finish_reason（如 ['length']）
 *  - verify: 自审结果或函数
 *  - googleFailures: 前 N 次 Google 调用返回 503
 *  - transitAvailable: false 时公共交通返回空结果（模拟日本等地区）
 */
export function createMockUpstream(options = {}) {
  const {
    stream = true,
    llmDelayMs = 0,
    llmFailures = [],
    planHook = null,
    finishReasons = [],
    verify = null,
    googleFailures = 0,
    transitAvailable = true,
  } = options;
  const calls = { llm: [], geocode: 0, places: 0, nearby: 0, routes: 0, routeModes: [] };
  const signals = [];
  let llmCallIndex = 0;
  let planCallIndex = 0;
  let googleFailuresLeft = googleFailures;
  const originalFetch = globalThis.fetch;

  async function handleLLM(init) {
    const request = JSON.parse(init.body);
    const system = request.messages[0].content;
    const user = request.messages[1].content;
    const purpose = llmPurpose(system);
    calls.llm.push({ purpose, stream: Boolean(request.stream), model: request.model });
    if (init.signal) signals.push(init.signal);
    if (llmDelayMs) await delay(llmDelayMs, init.signal);
    const failure = llmFailures[llmCallIndex++];
    if (failure) return json({ error: { message: `mock failure ${failure}` } }, failure, failure === 429 ? { 'Retry-After': '0' } : {});
    if (!stream) request.stream = false;

    if (purpose === 'verify') {
      const payload = typeof verify === 'function' ? verify(user) : verify
        || { passed: true, missing_spots: [], incorrect_spots: [], warnings: [], needs_regeneration: false };
      return completionResponse(payload, request);
    }
    if (purpose === 'detail') return completionResponse(detailFor(user), request);
    if (purpose === 'repair') return completionResponse(repairFor(user), request);

    const cityKey = cityFromQuery(user);
    if (!cityKey) {
      return completionResponse({ status: 'need_clarification', clarification_questions: ['你想去哪个城市？'] }, request);
    }
    const call = planCallIndex++;
    const finishReason = finishReasons[call] || 'stop';
    if (finishReason === 'length') return completionResponse('{"status":"success","plan":{"title":"被截断', request, { finishReason });
    let plan = buildMockPlan(cityKey, daysFromMessage(user), { compact: purpose === 'outline', userMessage: user });
    if (planHook) plan = planHook(plan, { purpose, call, user }) || plan;
    return completionResponse({ status: 'success', clarification_questions: [], plan }, request, { finishReason });
  }

  function googleFailure() {
    if (googleFailuresLeft <= 0) return null;
    googleFailuresLeft--;
    return json({ error: { code: 503, message: 'mock backend error', status: 'UNAVAILABLE' } }, 503);
  }

  function handleGeocode(url) {
    calls.geocode++;
    const failure = googleFailure();
    if (failure) return failure;
    const address = new URL(url).searchParams.get('address');
    const key = cityFromText(address);
    if (!key) return json({ status: 'ZERO_RESULTS', results: [] });
    const city = CITIES[key];
    return json({
      status: 'OK',
      results: [{
        place_id: `city-${key}`,
        formatted_address: `${city.admin}, ${city.countryCode}`,
        geometry: {
          location: { lat: city.lat, lng: city.lng },
          viewport: {
            southwest: { lat: city.viewport[0][0], lng: city.viewport[0][1] },
            northeast: { lat: city.viewport[1][0], lng: city.viewport[1][1] },
          },
        },
        address_components: [
          { long_name: city.admin, short_name: city.admin, types: ['locality', 'political'] },
          { long_name: city.countryZh, short_name: city.countryCode, types: ['country', 'political'] },
        ],
      }],
    });
  }

  function handlePlaces(init) {
    calls.places++;
    const failure = googleFailure();
    if (failure) return failure;
    const body = JSON.parse(init.body);
    const query = body.textQuery.toLowerCase();
    const matches = PLACES.filter(place => query.includes(place.en.toLowerCase()) || query.includes(place.name));
    const stations = Object.entries(CITIES)
      .filter(([, city]) => query.includes(city.landmark.toLowerCase()) || query.includes(city.area.toLowerCase()))
      .map(([key, city]) => ({ id: `station-${key}`, city: key, name: city.landmark, en: city.landmark, lat: city.lat + 0.002, lng: city.lng + 0.002 }));
    const candidates = [...matches, ...stations].filter(place => insideRectangle(place, body.locationRestriction?.rectangle));
    return json({ places: candidates.slice(0, body.pageSize || 5).map(place => placeResponse(place, body.languageCode)) });
  }

  function handleNearby(init) {
    calls.nearby++;
    const body = JSON.parse(init.body);
    const center = body.locationRestriction.circle.center;
    const key = Object.entries(CITIES)
      .sort(([, a], [, b]) => haversineKm(center, a) - haversineKm(center, b))[0][0];
    return json({
      places: (STATIONS[key] || []).map(([name, dLat, dLng], index) => ({
        id: `station-${key}-${index}`,
        displayName: { text: name },
        formattedAddress: `${name}, ${CITIES[key].admin}`,
        location: { latitude: center.latitude + dLat, longitude: center.longitude + dLng },
        primaryType: 'subway_station',
        googleMapsUri: `https://maps.google.com/?q=${encodeURIComponent(name)}`,
      })),
    });
  }

  function handleRoutes(init) {
    calls.routes++;
    const body = JSON.parse(init.body);
    calls.routeModes.push(body.travelMode);
    // 模拟 Routes API 在部分地区（如日本）没有公共交通数据：返回空对象。
    if (body.travelMode === 'TRANSIT' && !transitAvailable) return json({});
    const from = body.origin.location.latLng;
    const to = body.destination.location.latLng;
    const km = haversineKm(from, to);
    const mid = { latitude: (from.latitude + to.latitude) / 2 + 0.001, longitude: (from.longitude + to.longitude) / 2 };
    const speeds = { WALK: 1.3, TRANSIT: 7, DRIVE: 9 };
    const route = {
      distanceMeters: Math.round(km * 1250),
      duration: `${Math.round((km * 1250) / (speeds[body.travelMode] || 5) + (body.travelMode === 'TRANSIT' ? 300 : 0))}s`,
      polyline: { encodedPolyline: encodePolyline([from, mid, to]) },
    };
    if (body.travelMode === 'TRANSIT') {
      route.legs = [{ steps: [
        { travelMode: 'WALK' },
        { travelMode: 'TRANSIT', transitDetails: { transitLine: { name: '地铁乌丸线', nameShort: '乌丸线', vehicle: { type: 'SUBWAY' } } } },
      ] }];
    }
    return json({ routes: [route] });
  }

  async function mockFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/chat/completions')) return handleLLM(init);
    if (url.startsWith('https://maps.googleapis.com/maps/api/geocode/json')) return handleGeocode(url);
    if (url === 'https://places.googleapis.com/v1/places:searchText') return handlePlaces(init);
    if (url === 'https://places.googleapis.com/v1/places:searchNearby') return handleNearby(init);
    if (url === 'https://routes.googleapis.com/directions/v2:computeRoutes') return handleRoutes(init);
    return originalFetch(input, init);
  }

  return {
    calls,
    signals,
    fetch: mockFetch,
    install() {
      globalThis.fetch = mockFetch;
      return this;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
