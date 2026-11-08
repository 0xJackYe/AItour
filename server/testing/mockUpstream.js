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
  sapporo: {
    names: ['札幌', 'sapporo'], zh: '札幌', countryZh: '日本', countryCode: 'JP', admin: 'Sapporo',
    lat: 43.0618, lng: 141.3545, viewport: [[42.766, 140.99], [43.19, 141.53]],
    area: '大通', landmark: '大通站', line: '地铁南北线',
  },
  hakodate: {
    names: ['函馆', 'hakodate', '函館'], zh: '函馆', countryZh: '日本', countryCode: 'JP', admin: 'Hakodate',
    lat: 41.7687, lng: 140.729, viewport: [[41.7, 140.6], [41.95, 141.2]],
    area: '函馆站前', landmark: '函馆站前电车站', line: '函馆市电',
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
  // 餐厅（用于午餐 / 晚餐）
  { id: 'okutan', city: 'kyoto', name: '奥丹清水', en: 'Okutan Kiyomizu', lat: 34.9967, lng: 135.7817, type: 'restaurant', cost: '人均约 3500 日元' },
  { id: 'pontocho', city: 'kyoto', name: '先斗町', en: 'Pontocho', lat: 35.0055, lng: 135.771, type: 'restaurant', cost: '人均约 5000 日元' },
  { id: 'owariya', city: 'kyoto', name: '本家尾张屋', en: 'Honke Owariya', lat: 35.0127, lng: 135.7584, type: 'restaurant', cost: '人均约 1500 日元' },
  { id: 'flore', city: 'paris', name: '花神咖啡馆', en: 'Cafe de Flore', lat: 48.8542, lng: 2.3326, type: 'restaurant', cost: '人均约 25 欧元' },
  { id: 'angelina', city: 'paris', name: '安吉丽娜茶室', en: 'Angelina Paris', lat: 48.865, lng: 2.3285, type: 'restaurant', cost: '人均约 20 欧元' },
  { id: 'magots', city: 'paris', name: '双叟咖啡馆', en: 'Les Deux Magots', lat: 48.854, lng: 2.3333, type: 'restaurant', cost: '人均约 30 欧元' },
  { id: 'imahan', city: 'tokyo', name: '浅草今半', en: 'Asakusa Imahan', lat: 35.7124, lng: 139.7944, type: 'restaurant', cost: '人均约 6000 日元' },
  { id: 'tsukiji', city: 'tokyo', name: '筑地场外市场', en: 'Tsukiji Outer Market', lat: 35.6654, lng: 139.7707, type: 'restaurant', cost: '人均约 3000 日元' },
  { id: 'ichiran', city: 'tokyo', name: '一兰拉面 涩谷店', en: 'Ichiran Shibuya', lat: 35.6614, lng: 139.701, type: 'restaurant', cost: '人均约 1200 日元' },
  { id: 'shizuka', city: 'nara', name: '志津香', en: 'Shizuka Kamameshi', lat: 34.6835, lng: 135.8402, type: 'restaurant', cost: '人均约 1500 日元' },
  // 北海道（多城市：札幌 → 函馆）
  { id: 'odori', city: 'sapporo', name: '大通公园', en: 'Odori Park', lat: 43.0605, lng: 141.3546 },
  { id: 'tvtower', city: 'sapporo', name: '札幌电视塔', en: 'Sapporo TV Tower', lat: 43.0611, lng: 141.3564 },
  { id: 'clocktower', city: 'sapporo', name: '札幌市钟楼', en: 'Sapporo Clock Tower', lat: 43.0625, lng: 141.3536 },
  { id: 'jingu', city: 'sapporo', name: '北海道神宫', en: 'Hokkaido Jingu', lat: 43.0546, lng: 141.3076 },
  { id: 'shiroi', city: 'sapporo', name: '白色恋人公园', en: 'Shiroi Koibito Park', lat: 43.0889, lng: 141.2715 },
  { id: 'beer', city: 'sapporo', name: '札幌啤酒博物馆', en: 'Sapporo Beer Museum', lat: 43.0716, lng: 141.3688 },
  { id: 'garaku', city: 'sapporo', name: '汤咖喱 GARAKU', en: 'Soup Curry GARAKU', lat: 43.0573, lng: 141.3553, type: 'restaurant', cost: '人均约 1500 日元' },
  { id: 'daruma', city: 'sapporo', name: '成吉思汗达摩 本店', en: 'Genghis Khan Daruma Honten', lat: 43.0546, lng: 141.3529, type: 'restaurant', cost: '人均约 3000 日元' },
  { id: 'ramen', city: 'sapporo', name: '札幌拉面横丁', en: 'Sapporo Ramen Yokocho', lat: 43.0563, lng: 141.3533, type: 'restaurant', cost: '人均约 1200 日元' },
  { id: 'sapporo-st', city: 'sapporo', name: '札幌站', en: 'Sapporo Station', lat: 43.0687, lng: 141.3508, type: 'transport' },
  { id: 'hakodate-st', city: 'hakodate', name: '函馆站', en: 'Hakodate Station', lat: 41.7737, lng: 140.7264, type: 'transport' },
  { id: 'asaichi', city: 'hakodate', name: '函馆朝市', en: 'Hakodate Morning Market', lat: 41.7727, lng: 140.7255 },
  { id: 'kanemori', city: 'hakodate', name: '金森红砖仓库', en: 'Kanemori Red Brick Warehouse', lat: 41.7669, lng: 140.7176 },
  { id: 'hachiman', city: 'hakodate', name: '八幡坂', en: 'Hachimanzaka Slope', lat: 41.765, lng: 140.7128 },
  { id: 'goryokaku', city: 'hakodate', name: '五稜郭公园', en: 'Goryokaku Park', lat: 41.7969, lng: 140.757 },
  { id: 'motomachi', city: 'hakodate', name: '元町教会群', en: 'Motomachi Churches', lat: 41.7616, lng: 140.7108 },
  { id: 'pierrot', city: 'hakodate', name: '幸运小丑汉堡 港湾店', en: 'Lucky Pierrot Bay Area', lat: 41.7671, lng: 140.7195, type: 'restaurant', cost: '人均约 1000 日元' },
  { id: 'kikuyo', city: 'hakodate', name: '惠比寿屋食堂', en: 'Ebisuya Shokudo', lat: 41.7731, lng: 140.7261, type: 'restaurant', cost: '人均约 2500 日元' },
  { id: 'ajisai', city: 'hakodate', name: '函馆面厨房 紫阳花', en: 'Ajisai Ramen', lat: 41.7703, lng: 140.721, type: 'restaurant', cost: '人均约 1100 日元' },
];

const STATIONS = {
  kyoto: [['京都河原町站', 0.0012, 0.0008], ['祇园四条站', -0.0009, 0.0021]],
  nara: [['近铁奈良站', 0.001, 0.001]],
  paris: [['夏特雷站', 0.0006, -0.0011], ['卢浮宫-里沃利站', 0.0014, 0.0007]],
  tokyo: [['上野站', 0.0008, 0.0006], ['京成上野站', -0.0012, 0.0004]],
  shizuoka: [['静冈站', 0.001, 0.001]],
  sapporo: [['大通站', 0.0007, 0.0004], ['札幌站', 0.0068, -0.0037]],
  hakodate: [['函馆站前电车站', -0.0008, 0.0011]],
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
  if (/札幌|函馆|北海道|sapporo|hakodate/i.test(requirement)) return 'hokkaido';
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
  const own = PLACES.filter(place => place.city === cityKey && place.type !== 'restaurant');
  // 用户点名的一日游城市（如京都→奈良）。
  const extras = PLACES.filter(place => place.city !== cityKey && place.city !== 'shizuoka' && place.type !== 'restaurant' && String(userMessage).includes(place.name));
  return [...own, ...extras];
}

const RICH_TEXT = '看点集中、步行顺路，适合放慢节奏拍照和感受当地氛围，建议预留充足时间。';

function spotFrom(place, { compact, labelCity, start_time, duration_hours }) {
  const city = CITIES[place.city];
  const spot = {
    name: place.name,
    name_en: `${place.en}, ${CITIES[labelCity || place.city].names[1].replace(/^./, ch => ch.toUpperCase())}`,
    city: CITIES[labelCity || place.city].zh,
    country: city.countryZh,
    type: place.type || 'attraction',
  };
  if (compact) return spot;
  return {
    ...spot,
    start_time,
    duration_hours,
    cost: place.cost || '门票约 500 日元',
    description: `${place.name}：${RICH_TEXT}`,
    tips: '早上人少，开放时间约 9:00-17:00',
  };
}

// 每天：景点 09:30 → 景点 11:00 → 午餐 12:30 → 景点 14:30 → 晚餐 18:30
const DAY_SLOTS = [['09:30', 1.5], ['11:00', 1], ['12:30', 1], ['14:30', 2], ['18:30', 1.5]];

export function buildMockPlan(cityKey, days, { compact = false, userMessage = '', labelOverrides = {} } = {}) {
  const city = CITIES[cityKey];
  const pool = placesFor(cityKey, userMessage);
  const restaurants = PLACES.filter(place => place.city === cityKey && place.type === 'restaurant');
  const dailyPlans = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const sights = [0, 1, 2].map(offset => pool[(index * 3 + offset) % pool.length]);
    const lunch = restaurants[(index * 2) % restaurants.length];
    const dinner = restaurants[(index * 2 + 1) % restaurants.length];
    // 骨架阶段不列餐厅（与真实提示词一致），细化阶段再补充。
    const ordered = compact ? sights : [sights[0], sights[1], lunch, sights[2], dinner];
    return {
      day,
      city: city.zh,
      country: city.countryZh,
      theme: `${city.zh}第${day}天`,
      spots: ordered.map((place, slot) => spotFrom(place, {
        compact,
        labelCity: labelOverrides[place.id] || (place.city === 'nara' ? 'nara' : cityKey),
        start_time: DAY_SLOTS[slot][0],
        duration_hours: DAY_SLOTS[slot][1],
      })),
      transport_notes: '地铁与步行结合，景点之间多在 20 分钟以内',
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
    accommodations: [{ city: city.zh, country: city.countryZh, area: city.area, reason: '交通便利，餐饮选择多', landmark: city.landmark, price_hint: '约 600-900 元/晚' }],
    budget_estimate: {
      currency: 'CNY',
      per_person: 1100 * days,
      excludes: '往返大交通',
      breakdown: [{ item: '住宿', amount: 500 * days }, { item: '餐饮', amount: 350 * days }, { item: '交通', amount: 100 * days }, { item: '门票', amount: 150 * days }],
    },
    booking_tips: [`${pool[0].name}旺季建议提前一周在官网购票`],
    daily_plans: dailyPlans,
    route_reasoning: '按区域安排，减少折返',
    practical_tips: ['提前购买交通卡'],
  };
}

// 多城市示例：札幌 → 函馆。换城市当天以两座车站开头，transfers 写明车次（或自驾道路）。
export function buildHokkaidoMockPlan(days = 5, { compact = false, drive = false, withTransfers = true } = {}) {
  const total = Math.max(2, days);
  const sapporoDays = Math.max(1, total - 2);
  const transferDay = sapporoDays + 1;
  const pools = {
    sapporo: { sights: ['odori', 'clocktower', 'tvtower', 'jingu', 'shiroi', 'beer'], meals: ['garaku', 'daruma', 'ramen'] },
    hakodate: { sights: ['asaichi', 'kanemori', 'hachiman', 'goryokaku', 'motomachi'], meals: ['pierrot', 'kikuyo', 'ajisai'] },
  };
  const byId = id => PLACES.find(place => place.id === id);
  const counters = { sapporo: 0, hakodate: 0 };
  const nextSight = (key) => {
    const list = pools[key].sights;
    return byId(list[counters[key]++ % list.length]);
  };
  const station = (id, start, description) => ({
    ...spotFrom(byId(id), { compact, start_time: start, duration_hours: 0.5 }),
    ...(compact ? {} : { cost: id === 'sapporo-st' ? 'JR 车票约 9000 日元' : '免费', description, tips: '车站内有寄存柜，可先寄存大件行李' }),
  });
  const dailyPlans = Array.from({ length: total }, (_, index) => {
    const day = index + 1;
    const key = day < transferDay ? 'sapporo' : 'hakodate';
    const meals = pools[key].meals;
    const lunch = byId(meals[index % meals.length]);
    const dinner = byId(meals[(index + 1) % meals.length]);
    let spots;
    if (day === transferDay && !drive) {
      spots = [
        station('sapporo-st', '08:00', '札幌站乘坐 JR 特急北斗号前往函馆，车程约 3 小时 45 分，沿途可看内浦湾海景。'),
        station('hakodate-st', '11:45', '抵达函馆站，出站即是函馆朝市，可先把行李寄存在车站。'),
        spotFrom(lunch, { compact, start_time: '12:30', duration_hours: 1 }),
        spotFrom(nextSight(key), { compact, start_time: '14:30', duration_hours: 2 }),
        spotFrom(dinner, { compact, start_time: '18:30', duration_hours: 1.5 }),
      ];
    } else {
      const sights = [nextSight(key), nextSight(key), nextSight(key)];
      spots = [sights[0], sights[1], lunch, sights[2], dinner].map((place, slot) =>
        spotFrom(place, { compact, start_time: DAY_SLOTS[slot][0], duration_hours: DAY_SLOTS[slot][1] }));
    }
    if (compact) spots = spots.filter(spot => spot.type !== 'restaurant');
    return {
      day,
      city: CITIES[key].zh,
      country: '日本',
      theme: `${CITIES[key].zh}第${day}天`,
      spots,
      transport_notes: day === transferDay
        ? drive ? '自驾经道央自动车道约 5 小时到函馆' : '札幌站乘 JR 特急北斗号约 3 小时 45 分到函馆站'
        : `${CITIES[key].line}与步行结合`,
    };
  });
  return {
    title: `北海道${total}日游`,
    city: '多城市',
    country: '日本',
    days: total,
    summary: '札幌城市与美食，再乘特急去函馆看夜景',
    preferences: { pace: 'moderate', budget: 'moderate', transport: drive ? 'drive' : 'public_transit', interests: ['美食', '夜景'] },
    destinations: [
      { city: '札幌', country: '日本', start_day: 1, end_day: sapporoDays },
      { city: '函馆', country: '日本', start_day: transferDay, end_day: total },
    ],
    accommodations: [
      { city: '札幌', country: '日本', area: '大通', reason: '地铁三线交汇，去札幌站一站路', landmark: '大通站', price_hint: '约 600-900 元/晚' },
      { city: '函馆', country: '日本', area: '函馆站前', reason: '紧邻车站与朝市，电车直达景点', landmark: '函馆站前电车站', price_hint: '约 500-800 元/晚' },
    ],
    transfers: withTransfers
      ? [{
          day: transferDay,
          from_city: '札幌',
          to_city: '函馆',
          mode: drive ? 'drive' : 'train',
          service: drive ? '道央自动车道' : 'JR 特急北斗号',
          from_place: drive ? '' : '札幌站',
          to_place: drive ? '' : '函馆站',
          depart_time: '08:00',
          arrive_time: drive ? '13:00' : '11:45',
          duration_hours: drive ? 5 : 3.75,
          cost: drive ? '油费与高速费约 12000 日元' : '每人约 9000 日元',
          tips: drive ? '冬季注意积雪路况，中途可在长万部休息' : '可用 JR 北海道铁路周游券，建议提前预订指定席',
          round_trip: false,
        }]
      : [],
    budget_estimate: {
      currency: 'CNY',
      per_person: 1300 * total,
      excludes: '往返大交通',
      breakdown: [{ item: '住宿', amount: 550 * total }, { item: '餐饮', amount: 400 * total }, { item: '交通', amount: 200 * total }, { item: '门票', amount: 150 * total }],
    },
    booking_tips: ['札幌 → 函馆的特急北斗号旺季建议提前一周订指定席'],
    daily_plans: dailyPlans,
    route_reasoning: '先札幌后函馆，乘特急一次换城，避免往返',
    practical_tips: ['函馆山夜景建议日落前 30 分钟上山'],
  };
}

function detailFor(userMessage) {
  const marker = '【不可更改的行程骨架】';
  const start = userMessage.indexOf(marker);
  const skeleton = JSON.parse(userMessage.slice(start + marker.length).trim());
  return {
    daily_plans: skeleton.daily_plans.map((day) => {
      const cityKey = cityFromText(day.city) || 'kyoto';
      const restaurants = PLACES.filter(place => place.city === cityKey && place.type === 'restaurant');
      const meal = (place, time) => ({
        name: place.name,
        name_en: `${place.en}, ${CITIES[cityKey].names[1]}`,
        type: 'restaurant',
        start_time: time,
        duration_hours: 1,
        cost: place.cost,
        description: `${place.name}：${RICH_TEXT}`,
        tips: '饭点前到店可减少排队',
      });
      const sights = day.spots.map((spot, index) => ({
        name: spot.name,
        start_time: ['09:30', '11:00', '14:30', '16:30'][index] || '17:00',
        duration_hours: 1.5,
        cost: '门票约 500 日元',
        description: `${spot.name}的细化描述：${RICH_TEXT}`,
        tips: '细化建议：开放时间约 9:00-17:00',
      }));
      const hasMeals = day.spots.some(spot => spot.type === 'restaurant');
      const spots = hasMeals || restaurants.length === 0
        ? sights
        : [...sights.slice(0, 2), meal(restaurants[day.day % restaurants.length], '12:30'), ...sights.slice(2), meal(restaurants[(day.day + 1) % restaurants.length], '18:30')];
      return { day: day.day, theme: day.theme, transport_notes: '乘坐地铁，换乘一次', spots };
    }),
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

function cityPlace(key) {
  const city = CITIES[key];
  return {
    id: `city-${key}`,
    displayName: { text: city.admin, languageCode: 'en' },
    formattedAddress: `${city.admin}, ${city.countryCode}`,
    location: { latitude: city.lat, longitude: city.lng },
    viewport: {
      low: { latitude: city.viewport[0][0], longitude: city.viewport[0][1] },
      high: { latitude: city.viewport[1][0], longitude: city.viewport[1][1] },
    },
    addressComponents: [
      { longText: city.admin, shortText: city.admin, types: ['locality', 'political'] },
      { longText: city.countryZh, shortText: city.countryCode, types: ['country', 'political'] },
    ],
    types: ['locality', 'political'],
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
 *  - transitMaxKm: 超过该直线距离的公共交通请求返回空结果（模拟城际铁路没有数据）
 *  - omitTransfers: 多城市示例不返回 transfers（覆盖按行程推断的路径）
 *  - googleDelayMs: 每次 Google 调用的模拟耗时（性能测试用）
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
    transitMaxKm = Infinity,
    omitTransfers = false,
    googleDelayMs = 0,
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
    let plan = cityKey === 'hokkaido'
      ? buildHokkaidoMockPlan(daysFromMessage(user), {
          compact: purpose === 'outline',
          drive: /自驾/.test(user.split('【系统解析的硬性约束】')[0]),
          withTransfers: !omitTransfers,
        })
      : buildMockPlan(cityKey, daysFromMessage(user), { compact: purpose === 'outline', userMessage: user });
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
    // 城市锚点查询（“京都, 日本”）：第一段恰好是城市名。
    const firstPart = query.split(',')[0].trim();
    const cityKey = Object.entries(CITIES).find(([, city]) => city.names.some(name => name.toLowerCase() === firstPart))?.[0];
    if (cityKey) return json({ places: [cityPlace(cityKey)] });
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
    const from = body.origin.location.latLng;
    const to = body.destination.location.latLng;
    const km = haversineKm(from, to);
    // 模拟 Routes API 在部分地区（如日本）没有公共交通数据：返回空对象。
    if (body.travelMode === 'TRANSIT' && (!transitAvailable || km > transitMaxKm)) return json({});
    const nearest = Object.values(CITIES).sort((a, b) => haversineKm(from, a) - haversineKm(from, b))[0];
    const mid = { latitude: (from.latitude + to.latitude) / 2 + 0.001, longitude: (from.longitude + to.longitude) / 2 };
    const speeds = { WALK: 1.3, TRANSIT: 7, DRIVE: 9 };
    const route = {
      distanceMeters: Math.round(km * 1250),
      duration: `${Math.round((km * 1250) / (speeds[body.travelMode] || 5) + (body.travelMode === 'TRANSIT' ? 300 : 0))}s`,
      polyline: { encodedPolyline: encodePolyline([from, mid, to]) },
    };
    if (body.travelMode === 'TRANSIT') {
      const line = nearest.line || '地铁乌丸线';
      route.legs = [{ steps: [
        { travelMode: 'WALK' },
        { travelMode: 'TRANSIT', transitDetails: { transitLine: { name: line, nameShort: line.replace(/^地铁/, ''), vehicle: { type: 'SUBWAY' } } } },
      ] }];
    }
    if (body.travelMode === 'DRIVE' && km > 50) route.description = nearest.zh === '札幌' || nearest.zh === '函馆' ? '道央自动车道' : '高速公路';
    return json({ routes: [route] });
  }

  async function mockFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/chat/completions')) return handleLLM(init);
    if (url.startsWith('https://maps.googleapis.com/maps/api/geocode/json')) return handleGeocode(url);
    const google = url.startsWith('https://places.googleapis.com/') || url.startsWith('https://routes.googleapis.com/');
    if (google && googleDelayMs) await delay(googleDelayMs, init.signal);
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
