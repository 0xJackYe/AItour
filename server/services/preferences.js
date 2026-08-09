const MODE_ALIASES = {
  walk: 'WALK', walking: 'WALK', '步行': 'WALK', '走路': 'WALK',
  transit: 'TRANSIT', public_transport: 'TRANSIT', metro: 'TRANSIT', subway: 'TRANSIT', bus: 'TRANSIT', '公交': 'TRANSIT', '巴士': 'TRANSIT', '大巴': 'TRANSIT', '地铁': 'TRANSIT', '公共交通': 'TRANSIT',
  drive: 'DRIVE', driving: 'DRIVE', car: 'DRIVE', taxi: 'DRIVE', '自驾': 'DRIVE', '出租车': 'DRIVE',
  bicycle: 'BICYCLE', bike: 'BICYCLE', cycling: 'BICYCLE', '骑行': 'BICYCLE', '自行车': 'BICYCLE',
  rail: 'RAIL', train: 'RAIL', '火车': 'RAIL', '列车': 'RAIL', '高铁': 'RAIL', '新干线': 'RAIL', '铁路': 'RAIL',
  flight: 'FLIGHT', plane: 'FLIGHT', air: 'FLIGHT', '飞机': 'FLIGHT', '航空': 'FLIGHT',
};

const TRANSIT_MODE_ALIASES = {
  bus: 'BUS', coach: 'BUS', '公交': 'BUS', '巴士': 'BUS', '大巴': 'BUS',
  subway: 'SUBWAY', metro: 'SUBWAY', underground: 'SUBWAY', '地铁': 'SUBWAY',
  train: 'TRAIN', railway: 'TRAIN', '火车': 'TRAIN', '列车': 'TRAIN', '高铁': 'TRAIN', '新干线': 'TRAIN',
  light_rail: 'LIGHT_RAIL', lightrail: 'LIGHT_RAIL', tram: 'LIGHT_RAIL', '轻轨': 'LIGHT_RAIL', '有轨电车': 'LIGHT_RAIL',
  rail: 'RAIL', '铁路': 'RAIL', '轨道交通': 'RAIL',
};

const TRANSIT_MODES = ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'];
const TRANSIT_ROUTING_PREFERENCES = new Set(['LESS_WALKING', 'FEWER_TRANSFERS']);
const DEFAULT_DISTANCE_POLICY = Object.freeze({
  walkMaxKm: 1,
  localTransitMaxKm: 30,
  flightMinKm: 800,
});

const PACE_ALIASES = {
  relaxed: 'relaxed', slow: 'relaxed', '轻松': 'relaxed', '休闲': 'relaxed', '慢': 'relaxed', '不赶': 'relaxed',
  moderate: 'moderate', balanced: 'moderate', '适中': 'moderate', '均衡': 'moderate',
  intensive: 'intensive', fast: 'intensive', '紧凑': 'intensive', '高强度': 'intensive', '特种兵': 'intensive',
};

const BUDGET_ALIASES = {
  budget: 'budget', low: 'budget', economy: 'budget', '经济': 'budget', '省钱': 'budget', '低': 'budget',
  moderate: 'moderate', medium: 'moderate', '中等': 'moderate', '适中': 'moderate',
  luxury: 'luxury', high: 'luxury', premium: 'luxury', '豪华': 'luxury', '高端': 'luxury', '高': 'luxury',
};

const PRIORITY_ALIASES = {
  balanced: 'balanced', balance: 'balanced', '均衡': 'balanced',
  cost: 'cost', budget: 'cost', cheapest: 'cost', '省钱': 'cost', '价格': 'cost', '低价': 'cost',
  time: 'time', fastest: 'time', speed: 'time', '省时': 'time', '快': 'time', '效率': 'time',
  comfort: 'comfort', comfortable: 'comfort', '舒适': 'comfort', '少换乘': 'comfort',
  transfers: 'comfort', transfer: 'comfort', few_transfers: 'comfort',
  walking: 'walking', less_walking: 'walking', walk_less: 'walking', '少步行': 'walking',
  transit: 'transit', public_transport: 'transit', '公交': 'transit', '公共交通': 'transit',
  rail: 'rail', train: 'rail', '火车': 'rail', '高铁': 'rail', '铁路': 'rail',
};

function valueFromAliases(value, aliases) {
  if (value === null || value === undefined || value === '') return null;
  return aliases[String(value).trim().toLowerCase()] || null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeTime(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function chineseNumber(text) {
  const digits = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  const parts = text.split('十');
  if (parts.length === 2) {
    return (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0);
  }
  return digits[text] ?? null;
}

export function inferDaysFromQuery(query = '') {
  const text = String(query);
  const explicit = text.match(/(?:共|总共|总时长|玩|旅行|行程)?\s*([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*(天|日游|周)/);
  if (!explicit) return null;
  const amount = chineseNumber(explicit[1]);
  if (!amount) return null;
  const days = explicit[2] === '周' ? amount * 7 : amount;
  return days <= 180 ? days : null;
}

function inferBudget(query = '') {
  const text = String(query);
  const amountMatch = text.match(/(?:预算|花费|花销)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(万|千)?\s*(?:元|块|CNY|RMB|人民币)?/i);
  const multiplier = amountMatch?.[2] === '万' ? 10000 : amountMatch?.[2] === '千' ? 1000 : 1;
  const levelKey = Object.keys(BUDGET_ALIASES).find(key => text.toLowerCase().includes(key));
  return {
    level: levelKey ? BUDGET_ALIASES[levelKey] : null,
    amount: amountMatch ? Number(amountMatch[1]) * multiplier : null,
  };
}

function inferPace(query = '') {
  const text = String(query).toLowerCase();
  const key = Object.keys(PACE_ALIASES).find(alias => text.includes(alias));
  return key ? PACE_ALIASES[key] : null;
}

function inferTransport(query = '') {
  const text = String(query).toLowerCase();
  const modes = [...new Set(Object.entries(MODE_ALIASES)
    .filter(([alias]) => text.includes(alias))
    .map(([, mode]) => mode))];
  const priorityKey = Object.keys(PRIORITY_ALIASES).find(alias => text.includes(alias));
  const transitModes = [...new Set(Object.entries(TRANSIT_MODE_ALIASES)
    .filter(([alias]) => text.includes(alias))
    .map(([, mode]) => mode))];
  return { modes, transitModes, priority: priorityKey ? PRIORITY_ALIASES[priorityKey] : null };
}

function normalizeModes(values) {
  return [...new Set((Array.isArray(values) ? values : values ? [values] : [])
    .map(value => MODE_ALIASES[String(value).trim().toLowerCase()] || String(value).trim().toUpperCase())
    .filter(value => ['WALK', 'TRANSIT', 'DRIVE', 'BICYCLE', 'RAIL', 'FLIGHT'].includes(value)))];
}

function normalizeTransitModes(values, fallback = TRANSIT_MODES) {
  const source = Array.isArray(values) ? values : values ? [values] : fallback;
  const modes = [...new Set(source
    .map(value => TRANSIT_MODE_ALIASES[String(value).trim().toLowerCase()] || String(value).trim().toUpperCase())
    .filter(value => TRANSIT_MODES.includes(value)))];
  return modes.length ? modes : [...fallback];
}

function normalizeRoutingPreference(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return TRANSIT_ROUTING_PREFERENCES.has(normalized) ? normalized : null;
}

function normalizeDistancePolicy(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const walkMaxKm = boundedNumber(raw.walkMaxKm, DEFAULT_DISTANCE_POLICY.walkMaxKm, 0, 20);
  const localTransitMaxKm = Math.max(
    walkMaxKm,
    boundedNumber(raw.localTransitMaxKm, DEFAULT_DISTANCE_POLICY.localTransitMaxKm, 1, 500),
  );
  const flightMinKm = Math.max(
    localTransitMaxKm,
    boundedNumber(raw.flightMinKm, DEFAULT_DISTANCE_POLICY.flightMinKm, 50, 20000),
  );
  return { walkMaxKm, localTransitMaxKm, flightMinKm };
}

export function normalizeProfile(rawProfile = {}, query = '') {
  const raw = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
  const inferredBudget = inferBudget(query);
  const inferredTransport = inferTransport(query);
  const transport = raw.transport && typeof raw.transport === 'object' ? raw.transport : {};
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  const travelers = raw.travelers && typeof raw.travelers === 'object' ? raw.travelers : {};
  const accommodation = raw.accommodation && typeof raw.accommodation === 'object' ? raw.accommodation : {};
  const transitPreferences = transport.transitPreferences && typeof transport.transitPreferences === 'object'
    ? transport.transitPreferences
    : {};
  const allowedModes = normalizeModes(
    transport.allowedModes || raw.allowedModes || raw.transportModes || inferredTransport.modes,
  );
  const avoidModes = normalizeModes(transport.avoidModes || raw.avoidModes);

  const budgetBasisAliases = {
    total: 'total', daily: 'per_day', per_day: 'per_day',
    per_person: 'per_person_total', per_person_total: 'per_person_total',
    per_person_day: 'per_person_day', per_person_per_day: 'per_person_day',
  };

  return {
    days: positiveNumber(raw.days) || inferDaysFromQuery(query),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startDate || '')) ? raw.startDate : null,
    budget: {
      level: valueFromAliases(budget.level || raw.budgetLevel, BUDGET_ALIASES) || inferredBudget.level,
      amount: positiveNumber(budget.amount ?? raw.budgetAmount) || inferredBudget.amount,
      currency: String(budget.currency || raw.currency || 'CNY').toUpperCase(),
      basis: budgetBasisAliases[String(budget.basis || '').toLowerCase()] || 'total',
      hardLimit: budget.hardLimit === true,
    },
    pace: valueFromAliases(raw.pace, PACE_ALIASES) || inferPace(query),
    transport: {
      priority: valueFromAliases(transport.priority || raw.transportPriority, PRIORITY_ALIASES) || inferredTransport.priority,
      allowedModes: allowedModes.filter(mode => !avoidModes.includes(mode)),
      avoidModes,
      transitPreferences: {
        allowedModes: normalizeTransitModes(
          transitPreferences.allowedModes || transport.transitModes || raw.transitModes || inferredTransport.transitModes,
        ),
        routingPreference: normalizeRoutingPreference(
          transitPreferences.routingPreference || transport.routingPreference || raw.transitRoutingPreference,
        ),
      },
      distancePolicy: normalizeDistancePolicy(transport.distancePolicy || raw.distancePolicy),
    },
    travelers: {
      adults: Math.max(0, Math.round(Number(travelers.adults ?? raw.adults ?? 1) || 0)),
      children: Math.max(0, Math.round(Number(travelers.children ?? raw.children ?? 0) || 0)),
      seniors: Math.max(0, Math.round(Number(travelers.seniors ?? raw.seniors ?? 0) || 0)),
    },
    maxWalkingKm: positiveNumber(raw.maxWalkingKm ?? transport.maxWalkingKm),
    dailyStartTime: normalizeTime(raw.dailyStartTime, '09:00'),
    dailyEndTime: normalizeTime(raw.dailyEndTime, '20:00'),
    interests: [...new Set((Array.isArray(raw.interests) ? raw.interests : []).map(String).map(v => v.trim()).filter(Boolean))],
    accommodation: {
      style: accommodation.style || null,
      locationPriority: accommodation.locationPriority || null,
    },
    dietaryNeeds: Array.isArray(raw.dietaryNeeds) ? raw.dietaryNeeds : raw.dietaryNeeds ? [String(raw.dietaryNeeds)] : [],
    accessibilityNeeds: Array.isArray(raw.accessibilityNeeds) ? raw.accessibilityNeeds : raw.accessibilityNeeds ? [String(raw.accessibilityNeeds)] : [],
    notes: String(raw.notes || '').trim(),
  };
}

export function profileClarificationQuestions(profile) {
  const questions = [];
  if (!profile.days) questions.push({
    id: 'days', label: '这次旅行计划几天？', type: 'number', required: true,
  });
  if (!profile.budget.level && !profile.budget.amount) questions.push({
    id: 'budget', label: '你的预算级别或预算金额是多少？', type: 'select', required: true,
    options: [
      { value: 'budget', label: '经济' }, { value: 'moderate', label: '适中' }, { value: 'luxury', label: '舒适高端' },
    ],
  });
  if (!profile.pace) questions.push({
    id: 'pace', label: '希望旅行节奏如何？', type: 'select', required: true,
    options: [
      { value: 'relaxed', label: '轻松' }, { value: 'moderate', label: '适中' }, { value: 'intensive', label: '紧凑' },
    ],
  });
  if (!profile.transport.priority) questions.push({
    id: 'transportPriority', label: '选择交通时最优先考虑什么？', type: 'select', required: true,
    options: [
      { value: 'balanced', label: '综合均衡' }, { value: 'cost', label: '更省钱' },
      { value: 'time', label: '更省时' }, { value: 'comfort', label: '更舒适' },
      { value: 'walking', label: '少步行' },
      { value: 'transit', label: '公共交通' }, { value: 'rail', label: '火车优先' },
    ],
  });
  return questions;
}

export function profilePrompt(profile) {
  return `\n\n【结构化用户偏好（硬约束优先于自然语言推测）】\n${JSON.stringify(profile, null, 2)}`;
}
