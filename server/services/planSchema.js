// 行程数据的规范化与完整性校验。大模型输出不可完全信任：类型可能错、
// 字段可能缺、天数可能重复或跳号。所有下游模块只处理这里规范化后的数据。

export const SPOT_TYPES = ['attraction', 'restaurant', 'shopping', 'transport', 'hotel'];

const TYPE_ALIASES = {
  attraction: 'attraction', sight: 'attraction', sightseeing: 'attraction', museum: 'attraction', park: 'attraction',
  landmark: 'attraction', temple: 'attraction', 景点: 'attraction', 景区: 'attraction', 博物馆: 'attraction',
  restaurant: 'restaurant', food: 'restaurant', dining: 'restaurant', cafe: 'restaurant', bar: 'restaurant',
  餐厅: 'restaurant', 美食: 'restaurant', 餐饮: 'restaurant', 小吃: 'restaurant',
  shopping: 'shopping', shop: 'shopping', market: 'shopping', mall: 'shopping', 购物: 'shopping', 商圈: 'shopping',
  transport: 'transport', station: 'transport', transit: 'transport', airport: 'transport', 交通: 'transport', 车站: 'transport',
  hotel: 'hotel', accommodation: 'hotel', 酒店: 'hotel', 住宿: 'hotel',
};
const PACE_ALIASES = {
  relaxed: 'relaxed', slow: 'relaxed', leisurely: 'relaxed', 轻松: 'relaxed', 悠闲: 'relaxed', 慢: 'relaxed', 休闲: 'relaxed',
  moderate: 'moderate', normal: 'moderate', balanced: 'moderate', medium: 'moderate', 适中: 'moderate', 正常: 'moderate', 中等: 'moderate',
  intensive: 'intensive', fast: 'intensive', packed: 'intensive', busy: 'intensive', 紧凑: 'intensive', 特种兵: 'intensive', 紧张: 'intensive',
};
const BUDGET_ALIASES = {
  budget: 'budget', low: 'budget', cheap: 'budget', economy: 'budget', 经济: 'budget', 穷游: 'budget', 低: 'budget',
  moderate: 'moderate', medium: 'moderate', mid: 'moderate', standard: 'moderate', 中等: 'moderate', 适中: 'moderate',
  luxury: 'luxury', high: 'luxury', premium: 'luxury', 豪华: 'luxury', 高端: 'luxury', 高: 'luxury',
};
const TRANSPORT_ALIASES = {
  public_transit: 'public_transit', transit: 'public_transit', public: 'public_transit', train: 'public_transit',
  公共交通: 'public_transit', 地铁: 'public_transit', 火车: 'public_transit',
  drive: 'drive', driving: 'drive', car: 'drive', 自驾: 'drive', 驾车: 'drive',
  walk: 'walk', walking: 'walk', 步行: 'walk',
};

const MULTI_CITY_LABELS = new Set(['多城市', 'multi-city', 'multiple cities', '多地']);

export function text(value, max = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function enumValue(value, aliases, fallback = null) {
  const raw = text(value, 40);
  return aliases[raw.toLowerCase()] || aliases[raw] || fallback;
}

export function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function durationHours(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(Math.min(parsed, 12) * 4) / 4;
}

function stringList(value, { max = 10, length = 80 } = {}) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string').map(item => text(item, length)).filter(Boolean).slice(0, max);
}

/** “9:00”“09：30”“9.30”“09:00-11:00” → “09:00”；无法识别返回 null。 */
export function normalizeClock(value) {
  const match = /^(\d{1,2})[:：.](\d{2})/.exec(text(value, 20));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** 预算估算：总额以分项之和为准，保证前后一致。 */
export function normalizeBudget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const breakdown = (Array.isArray(raw.breakdown) ? raw.breakdown : [])
    .map(item => ({ item: text(item?.item, 12), amount: Math.round(Number(item?.amount)) }))
    .filter(item => item.item && Number.isFinite(item.amount) && item.amount >= 0)
    .slice(0, 8);
  const sum = breakdown.reduce((total, item) => total + item.amount, 0);
  const declared = Math.round(Number(raw.per_person));
  const perPerson = sum > 0 ? sum : (Number.isFinite(declared) && declared > 0 ? declared : null);
  if (!perPerson) return null;
  return {
    currency: (text(raw.currency, 8) || 'CNY').toUpperCase(),
    per_person: perPerson,
    excludes: text(raw.excludes, 40),
    breakdown,
  };
}

export function isMultiCityLabel(value) {
  return MULTI_CITY_LABELS.has(text(value, 40).toLowerCase());
}

/** 单国家时返回国家名；多国（含“、”“,”）返回空串。 */
export function singleCountry(value) {
  const country = text(value, 60);
  return /[、,，/]/.test(country) ? '' : country;
}

// 模型偶尔会用占位符代替具体地点（“?”“待定”“午餐”），这种地点无法使用，直接丢弃。
const PLACEHOLDER_NAMES = /^(?:待定|未定|暂定|不详|无|tbd|n\/?a|unknown|餐厅|饭店|当地餐厅|附近餐厅|午餐|晚餐|早餐|午饭|晚饭|lunch|dinner|breakfast|restaurant|local restaurant)$/i;

export function isPlaceholderName(value) {
  const name = text(value, 80);
  return !name || !/[\p{L}\p{N}]/u.test(name) || PLACEHOLDER_NAMES.test(name);
}

export function normalizeSpot(raw, { city = '', country = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 60) || text(raw.name_en, 80);
  if (isPlaceholderName(name)) return null;
  return {
    name,
    name_en: text(raw.name_en, 100),
    city: text(raw.city, 40) || city,
    country: text(raw.country, 40) || country,
    type: enumValue(raw.type, TYPE_ALIASES, 'attraction'),
    start_time: normalizeClock(raw.start_time),
    duration_hours: durationHours(raw.duration_hours),
    cost: text(raw.cost, 40),
    description: text(raw.description, 200),
    tips: text(raw.tips, 120),
  };
}

function spotKey(spot) {
  return (spot.name_en || spot.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function normalizeDay(raw, { dayNumber, city = '', country = '' }) {
  const dayCity = text(raw?.city, 40) || city;
  const dayCountry = text(raw?.country, 40) || country;
  const seen = new Set();
  const spots = [];
  for (const item of Array.isArray(raw?.spots) ? raw.spots : []) {
    const spot = normalizeSpot(item, { city: dayCity, country: dayCountry });
    if (!spot) continue;
    const key = spotKey(spot);
    if (seen.has(key)) continue;
    seen.add(key);
    spots.push(spot);
  }
  return {
    day: dayNumber,
    city: dayCity,
    country: dayCountry,
    theme: text(raw?.theme, 40),
    spots: spots.slice(0, 10),
    transport_notes: text(raw?.transport_notes, 160),
  };
}

export function destinationForDay(destinations, dayNumber) {
  return (destinations || []).find(item => item.start_day <= dayNumber && item.end_day >= dayNumber) || null;
}

function normalizeDestinations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const start = positiveInt(item?.start_day);
      const end = positiveInt(item?.end_day) || start;
      const city = text(item?.city, 40);
      if (!city || !start) return null;
      return { city, country: text(item?.country, 40), start_day: start, end_day: Math.max(start, end) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start_day - b.start_day);
}

// ───────────────────────────── 城市间交通 ─────────────────────────────

export const TRANSFER_MODES = ['train', 'flight', 'bus', 'drive', 'ferry'];

const TRANSFER_MODE_ALIASES = {
  train: 'train', rail: 'train', railway: 'train', high_speed_rail: 'train', hsr: 'train', shinkansen: 'train', metro: 'train',
  火车: 'train', 高铁: 'train', 动车: 'train', 新干线: 'train', 铁路: 'train', 列车: 'train', 电车: 'train',
  flight: 'flight', plane: 'flight', air: 'flight', airplane: 'flight', fly: 'flight', 飞机: 'flight', 航班: 'flight',
  bus: 'bus', coach: 'bus', 大巴: 'bus', 巴士: 'bus', 长途汽车: 'bus', 客车: 'bus',
  drive: 'drive', car: 'drive', driving: 'drive', self_drive: 'drive', taxi: 'drive',
  自驾: 'drive', 驾车: 'drive', 开车: 'drive', 包车: 'drive', 租车: 'drive', 打车: 'drive',
  ferry: 'ferry', boat: 'ferry', ship: 'ferry', 轮渡: 'ferry', 渡轮: 'ferry', 渡船: 'ferry', 船: 'ferry',
};

export function transferMode(value) {
  return enumValue(value, TRANSFER_MODE_ALIASES, null);
}

/** 城市名比较用的键：去掉“市 / 都 / 府 / 县”等后缀、大小写与标点（“京都”“成都”保持原样）。 */
export function cityKey(value) {
  const base = text(value, 60).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const stripped = base.replace(/(?:特别行政区|自治区|自治州|地区|市|都|府|县|州|省)$/u, '');
  return [...stripped].length >= 2 ? stripped : base;
}

export function sameCity(left, right) {
  const a = cityKey(left);
  const b = cityKey(right);
  return Boolean(a && b && a === b);
}

function transferMinutes(raw, departTime, arriveTime) {
  const minutes = Number.parseFloat(raw?.duration_minutes);
  const hours = Number.parseFloat(raw?.duration_hours);
  let value = Number.isFinite(minutes) && minutes > 0 ? minutes : Number.isFinite(hours) && hours > 0 ? hours * 60 : null;
  if (!value && departTime && arriveTime) {
    const [dh, dm] = departTime.split(':').map(Number);
    const [ah, am] = arriveTime.split(':').map(Number);
    let diff = ah * 60 + am - (dh * 60 + dm);
    if (diff <= 0) diff += 24 * 60; // 夜车 / 红眼航班跨过午夜
    value = diff;
  }
  if (!value || value > 48 * 60) return null;
  return Math.max(5, Math.round(value / 5) * 5);
}

/** 一条城市间交通。day 为发生在哪一天；round_trip 表示一日游当天往返。 */
export function normalizeTransfer(raw, { maxDay = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const day = positiveInt(raw.day);
  const fromCity = text(raw.from_city ?? raw.from, 40);
  const toCity = text(raw.to_city ?? raw.to, 40);
  if (!day || (maxDay && day > maxDay) || !fromCity || !toCity || sameCity(fromCity, toCity)) return null;
  const departTime = normalizeClock(raw.depart_time);
  const arriveTime = normalizeClock(raw.arrive_time);
  return {
    day,
    from_city: fromCity,
    to_city: toCity,
    mode: transferMode(raw.mode),
    service: text(raw.service, 60),
    from_place: text(raw.from_place, 60),
    to_place: text(raw.to_place, 60),
    depart_time: departTime,
    arrive_time: arriveTime,
    duration_minutes: transferMinutes(raw, departTime, arriveTime),
    cost: text(raw.cost, 40),
    tips: text(raw.tips, 120),
    round_trip: raw.round_trip === true || raw.round_trip === 'true',
  };
}

export function normalizeTransfers(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map(item => normalizeTransfer(item, options))
    .filter((item) => {
      if (!item) return false;
      const key = `${item.day}|${cityKey(item.from_city)}|${cityKey(item.to_city)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.day - b.day || String(a.depart_time || '').localeCompare(String(b.depart_time || '')))
    .slice(0, 40);
}

function normalizeAccommodation(item, fallback = {}) {
  if (!item || typeof item !== 'object') return null;
  const area = text(item.area, 60);
  const landmark = text(item.landmark, 80);
  if (!area && !landmark) return null;
  return {
    city: text(item.city, 40) || fallback.city || '',
    country: text(item.country, 40) || fallback.country || '',
    area: area || landmark,
    reason: text(item.reason, 120),
    landmark,
    price_hint: text(item.price_hint, 30),
  };
}

/**
 * 规范化整份计划。expectedDays 给定时，超出的天会被裁掉；缺失的天由
 * findMissingDays 检出后交给补全流程，而不是在这里臆造。
 */
export function normalizePlan(plan, { expectedDays = null } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const destinations = normalizeDestinations(plan.destinations);
  const planCity = isMultiCityLabel(plan.city) ? '' : text(plan.city, 40);
  const planCountry = singleCountry(plan.country);

  const byDay = new Map();
  (Array.isArray(plan.daily_plans) ? plan.daily_plans : []).forEach((raw, index) => {
    const dayNumber = positiveInt(raw?.day) || index + 1;
    if (expectedDays && dayNumber > expectedDays) return;
    const destination = destinationForDay(destinations, dayNumber);
    const day = normalizeDay(raw, {
      dayNumber,
      city: destination?.city || planCity,
      country: destination?.country || planCountry,
    });
    const existing = byDay.get(dayNumber);
    // 重复的 Day 编号保留地点更多的那一份。
    if (!existing || day.spots.length > existing.spots.length) byDay.set(dayNumber, day);
  });
  const dailyPlans = [...byDay.values()].sort((a, b) => a.day - b.day);

  const firstDestination = destinations[0] || {};
  const accommodations = (Array.isArray(plan.accommodations) && plan.accommodations.length
    ? plan.accommodations
    : plan.accommodation ? [plan.accommodation] : [])
    .map(item => normalizeAccommodation(item, {
      city: planCity || firstDestination.city,
      country: planCountry || firstDestination.country,
    }))
    .filter(Boolean)
    .slice(0, 12);

  const preferences = plan.preferences && typeof plan.preferences === 'object' ? plan.preferences : {};
  const declaredDays = positiveInt(plan.days);
  const lastDay = dailyPlans.length ? dailyPlans[dailyPlans.length - 1].day : 0;
  const maxDay = expectedDays || Math.max(declaredDays || 0, lastDay) || null;

  // 只输出白名单字段：模型额外生成的任意字段不会进入 API 响应与本地存储。
  return {
    title: text(plan.title, 40),
    city: text(plan.city, 40) || (destinations.length > 1 ? '多城市' : firstDestination.city || ''),
    country: text(plan.country, 80) || firstDestination.country || '',
    days: expectedDays || declaredDays || lastDay,
    summary: text(plan.summary, 120),
    preferences: {
      pace: enumValue(preferences.pace, PACE_ALIASES, 'moderate'),
      budget: enumValue(preferences.budget, BUDGET_ALIASES, 'moderate'),
      transport: enumValue(preferences.transport, TRANSPORT_ALIASES, 'public_transit'),
      interests: stringList(preferences.interests, { max: 6, length: 12 }),
    },
    destinations,
    accommodations,
    accommodation: accommodations[0] || null,
    transfers: normalizeTransfers(plan.transfers, { maxDay }),
    daily_plans: dailyPlans,
    budget_estimate: normalizeBudget(plan.budget_estimate),
    booking_tips: stringList(plan.booking_tips, { max: 5, length: 80 }),
    route_reasoning: text(plan.route_reasoning, 300),
    practical_tips: stringList(plan.practical_tips, { max: 6, length: 80 }),
  };
}

/** 应有但缺失（或没有任何地点）的天编号。 */
export function findMissingDays(plan, expectedDays) {
  if (!expectedDays) return [];
  const complete = new Set((plan?.daily_plans || []).filter(day => day.spots?.length > 0).map(day => day.day));
  const missing = [];
  for (let day = 1; day <= expectedDays; day++) {
    if (!complete.has(day)) missing.push(day);
  }
  return missing;
}

/** 将补全得到的天合并进计划（按 Day 编号覆盖）。 */
export function mergeDays(plan, days) {
  const byDay = new Map((plan.daily_plans || []).map(day => [day.day, day]));
  for (const day of days || []) {
    if (day?.spots?.length) byDay.set(day.day, day);
  }
  return { ...plan, daily_plans: [...byDay.values()].sort((a, b) => a.day - b.day) };
}

/** 给补全 / 自审提示词使用的精简计划视图，控制 token 数。 */
export function planOutline(plan) {
  return {
    title: plan.title,
    city: plan.city,
    country: plan.country,
    days: plan.days,
    preferences: plan.preferences,
    destinations: plan.destinations,
    accommodations: (plan.accommodations || []).map(item => ({ city: item.city, area: item.area, landmark: item.landmark })),
    daily_plans: (plan.daily_plans || []).map(day => ({
      day: day.day,
      city: day.city,
      country: day.country,
      theme: day.theme,
      spots: (day.spots || []).map(spot => ({
        name: spot.name,
        name_en: spot.name_en,
        city: spot.city,
        country: spot.country,
        type: spot.type,
      })),
    })),
  };
}

const PACE_LIMITS = { relaxed: 4, moderate: 5, intensive: 7 };

/** 不依赖大模型的确定性质量检查，结果作为提示展示给用户。 */
export function deterministicWarnings(plan) {
  const warnings = [];
  const limit = PACE_LIMITS[plan?.preferences?.pace] || PACE_LIMITS.moderate;
  for (const day of plan?.daily_plans || []) {
    const main = (day.spots || []).filter(spot => spot.type !== 'restaurant' && spot.type !== 'transport').length;
    if (main > limit) warnings.push(`第 ${day.day} 天安排了 ${main} 个主要地点，节奏可能偏紧`);
    const hours = (day.spots || []).reduce((sum, spot) => sum + (spot.duration_hours || 0), 0);
    if (hours > 11) warnings.push(`第 ${day.day} 天建议停留时间合计约 ${hours} 小时，可能过满`);
  }
  const stayCities = new Set((plan?.accommodations || []).map(item => item.city));
  for (const destination of plan?.destinations || []) {
    // 只对住两晚以上（跨天）的城市要求住宿建议；中途只停留一天的城市常是一日游。
    const staysOvernight = destination.end_day > destination.start_day;
    if (staysOvernight && !stayCities.has(destination.city)) warnings.push(`${destination.city}需要过夜，但没有住宿建议`);
  }
  const seen = new Map();
  for (const day of plan?.daily_plans || []) {
    for (const spot of day.spots || []) {
      const key = spotKey(spot);
      if (seen.has(key) && seen.get(key) !== day.day) {
        warnings.push(`“${spot.name}”在第 ${seen.get(key)} 天和第 ${day.day} 天重复出现`);
      } else {
        seen.set(key, day.day);
      }
    }
  }
  return warnings.slice(0, 8);
}
