// 确定性需求解析：在调用大模型之前，从自然语言中可靠地抽取总天数和交通偏好。
// 解析结果用于：1) 选择单次生成或分段生成；2) 作为硬约束注入提示词；
// 3) 校验生成结果是否逐日完整。只有高置信度时才作为硬约束，避免误解析
// 反过来误导模型。

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100 };
const EN_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
};

const NUM = '[0-9０-９]+(?:\\.5)?|[零〇一二两俩三四五六七八九十百]+';
// “第三天”是序数；“3月5日”是日期；“日本/日元”等不是天数。
const DAY_RE = new RegExp(`(?<!第\\s*)(?<!月\\s*)(${NUM})\\s*(?:个)?\\s*(?:整)?\\s*(天半(?!个)|天|日(?![本元语式料系剧文韩]))`, 'g');
const RANGE_RE = new RegExp(`(${NUM})\\s*(?:-|~|～|—|到|至)\\s*(${NUM})\\s*(?:个)?\\s*(?:天|日(?![本元语式料系剧文韩]))`, 'g');
const NIGHT_RE = new RegExp(`(?<!第\\s*)(${NUM})\\s*(?:个)?\\s*(?:晚|夜|宿)`, 'g');
const WEEK_RE = new RegExp(`(?<!第\\s*)(${NUM}|半)\\s*(?:个)?\\s*(?:周|星期|礼拜)(?!年|岁|末)`, 'g');
const MONTH_RE = new RegExp(`(${NUM}|半)\\s*个\\s*月`, 'g');
const EN_DAY_RE = /\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty)[\s-]*days?\b/gi;
const EN_NIGHT_RE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*nights?\b/gi;
const EN_WEEK_RE = /\b(\d{1,2}|an?|one|two|three|four)[\s-]*weeks?\b/gi;
// 分段描述（“前三天…后四天…”）的标记词：仅有分段描述时求和。
const SEGMENT_PREFIX_RE = /(?:前|后|最后|头|接下来|剩下的?|剩余的?|其余的?|其中|另外|再|然后|接着)\s*$/;
const TOTAL_PREFIX_RE = /(?:共|一共|总共|总计|合计|全程|为期|总时长|总天数|时长|行程|计划|安排|玩|去|待|呆|旅游|旅行)\s*(?:是|为|大概|大约|约)?\s*$/;

export function parseChineseNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim().replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  let previousWasDigit = false;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      // “两三天”这类连续数字表示范围，取较大值。
      current = previousWasDigit ? Math.max(current, CN_DIGITS[ch]) : CN_DIGITS[ch];
      previousWasDigit = true;
    } else if (ch in CN_UNITS) {
      total += (current || 1) * CN_UNITS[ch];
      current = 0;
      previousWasDigit = false;
    } else {
      return null;
    }
  }
  return total + current;
}

/** “两三天”“七八天”这类相邻数字表示范围，不能当作确定天数。 */
export function isChineseNumberRange(raw) {
  return /[一二两俩三四五六七八九][一二两俩三四五六七八九]/.test(String(raw || ''));
}

function englishNumber(raw) {
  const lower = String(raw).toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return EN_NUMBERS[lower] ?? null;
}

function collect(regex, text, mapper) {
  const results = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = mapper(match);
    if (value !== null && Number.isFinite(value) && value > 0) {
      const before = text.slice(Math.max(0, match.index - 6), match.index);
      results.push({
        value,
        index: match.index,
        segment: SEGMENT_PREFIX_RE.test(before),
        total: TOTAL_PREFIX_RE.test(before),
        ambiguous: isChineseNumberRange(match[1]),
      });
    }
  }
  return results;
}

/**
 * 解析总天数。返回 { days, confidence, source }：
 * - confidence = 'high'：可作为硬约束（单一表述、明确总数、或纯分段求和）；
 * - confidence = 'low'：存在多个不一致的数字，仅用于选择生成策略。
 */
export function analyzeDays(input = '') {
  const text = String(input);
  const ranges = collect(RANGE_RE, text, (m) => {
    const hi = parseChineseNumber(m[2]);
    return hi === null ? null : Math.ceil(hi);
  });
  const dayMentions = collect(DAY_RE, text, (m) => {
    const value = parseChineseNumber(m[1]);
    if (value === null) return null;
    return Math.ceil(value + (m[2] === '天半' ? 0.5 : 0));
  }).filter(item => !ranges.some(range => Math.abs(range.index - item.index) < 12));
  const englishDays = collect(EN_DAY_RE, text, m => englishNumber(m[1]));
  const weeks = [
    ...collect(WEEK_RE, text, m => (m[1] === '半' ? 4 : (parseChineseNumber(m[1]) ?? 0) * 7)),
    ...collect(EN_WEEK_RE, text, m => (englishNumber(m[1]) ?? 0) * 7),
  ];
  const months = collect(MONTH_RE, text, m => (m[1] === '半' ? 15 : (parseChineseNumber(m[1]) ?? 0) * 30));
  const nights = [
    ...collect(NIGHT_RE, text, m => parseChineseNumber(m[1])),
    ...collect(EN_NIGHT_RE, text, m => englishNumber(m[1])),
  ];

  const explicit = [...dayMentions, ...englishDays];
  if (ranges.length > 0 && explicit.length === 0) {
    return { days: Math.max(...ranges.map(r => r.value)), confidence: 'low', source: 'range' };
  }

  if (explicit.length > 0) {
    const result = resolveExplicitDays(explicit);
    // “十天半个月”“一周左右，七八天”：天数与周/月表述不一致时只作参考。
    const coarse = [...weeks, ...months].map(item => item.value);
    if (result.confidence === 'high' && coarse.some(value => value !== result.days)) {
      return { ...result, confidence: 'low', strategyDays: Math.max(result.days, ...coarse) };
    }
    return result;
  }

  if (weeks.length > 0) return { days: Math.max(...weeks.map(w => w.value)), confidence: weeks.length === 1 ? 'high' : 'low', source: 'weeks' };
  if (months.length > 0) return { days: Math.max(...months.map(m => m.value)), confidence: months.length === 1 ? 'high' : 'low', source: 'months' };
  if (nights.length > 0) {
    const value = Math.max(...nights.map(n => n.value)) + 1;
    return { days: value, confidence: nights.length === 1 ? 'high' : 'low', source: 'nights' };
  }
  if (/周末|weekend/i.test(text)) return { days: 2, confidence: 'high', source: 'weekend' };
  if (/半天|half[\s-]day/i.test(text)) return { days: 1, confidence: 'high', source: 'half-day' };
  return { days: null, confidence: 'none', source: null };
}

function resolveExplicitDays(explicit) {
  const ambiguous = explicit.some(item => item.ambiguous);
  const withConfidence = result => (ambiguous ? { ...result, confidence: 'low' } : result);

  const totals = explicit.filter(item => item.total && !item.segment);
  if (totals.length === 1) return withConfidence({ days: totals[0].value, confidence: 'high', source: 'days' });

  const segments = explicit.filter(item => item.segment);
  let plain = explicit.filter(item => !item.segment);
  // “一天两个景点”里的“一天”是频率而不是总天数。
  if (plain.length > 1) plain = plain.filter(item => item.value !== 1);
  const distinct = [...new Set(plain.map(item => item.value))];
  if (distinct.length === 1) return withConfidence({ days: distinct[0], confidence: 'high', source: 'days' });
  if (distinct.length === 0 && segments.length > 0) {
    return withConfidence({ days: segments.reduce((sum, item) => sum + item.value, 0), confidence: 'high', source: 'segments' });
  }
  // “东京三天，大阪两天”通常意味着求和；交给模型判断，置信度标为低。
  const sum = distinct.reduce((acc, value) => acc + value, 0);
  return { days: Math.max(...distinct), strategyDays: sum, confidence: 'low', source: 'days' };
}

const DRIVE_RE = /自驾|租车|开车|驾车|自己开|房车|road\s*trip|self[-\s]?driv|rent(?:al|ing)?\s+(?:a\s+)?car|by\s+car/i;
const WALK_RE = /步行为主|走路为主|全程步行|citywalk|city\s+walk|on\s+foot/i;

export function detectTransportPreference(input = '') {
  const text = String(input);
  if (DRIVE_RE.test(text)) return 'drive';
  if (WALK_RE.test(text)) return 'walk';
  return null;
}

/** 汇总需求分析结果，供生成、校验和路线规划使用。 */
export function analyzeQuery(input = '') {
  const dayInfo = analyzeDays(input);
  return {
    days: dayInfo.confidence === 'high' ? dayInfo.days : null,
    approxDays: dayInfo.days,
    strategyDays: dayInfo.strategyDays ?? dayInfo.days,
    dayConfidence: dayInfo.confidence,
    transport: detectTransportPreference(input),
  };
}
