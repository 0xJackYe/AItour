const LONG_TRIP_THRESHOLD_DAYS = 12;
const DETAIL_CHUNK_SIZE = 7;
const DEFAULT_MAX_TOKENS = 8192;

const PLAN_SCHEMA = `{
  "status": "success | need_clarification",
  "clarification_questions": [],
  "plan": {
    "title": "行程标题",
    "city": "单城市填城市名；多城市填多城市",
    "country": "单国填国家名；多国用、分隔",
    "days": 旅行总天数,
    "summary": "一句话概括",
    "preferences": {
      "pace": "relaxed | moderate | intensive",
      "budget": "budget | moderate | luxury",
      "interests": ["文化", "自然"]
    },
    "destinations": [
      { "city": "城市", "country": "国家", "start_day": 1, "end_day": 3 }
    ],
    "accommodations": [
      { "city": "城市", "country": "国家", "area": "住宿区域", "reason": "原因", "landmark": "可地理编码地标" }
    ],
    "accommodation": { "area": "单城市兼容字段", "reason": "原因", "landmark": "地标" },
    "daily_plans": [
      {
        "day": 1,
        "city": "当天所在城市",
        "country": "当天所在国家",
        "theme": "当天主题",
        "spots": [
          {
            "name": "景点名称",
            "name_en": "官方英文名或罗马音，并带城市名消歧",
            "city": "景点实际所在城市；当天跨城时必须准确填写",
            "country": "景点实际所在国家",
            "type": "attraction | restaurant | transport | hotel | shopping",
            "duration_hours": 2,
            "description": "简短描述",
            "tips": "实用建议"
          }
        ],
        "transport_notes": "当天交通建议"
      }
    ],
    "route_reasoning": "路线逻辑",
    "practical_tips": ["贴士"]
  }
}`;

const SYSTEM_PROMPT = `你是旅行规划助手。请把用户需求转换为可被程序直接渲染的 JSON 旅行计划。

必须只输出 JSON，不要 Markdown，不要解释。JSON 结构如下：
${PLAN_SCHEMA}

规则：
1. 不编造地点；name_en 必须是官方英文名或常用罗马音。
2. 单城市和多城市行程都必须给每一天以及每个 spot 填写 city、country，这是后续地图消歧的硬约束。当天去邻近小镇时，spot.city 填小镇而不是住宿城市。
3. 多城市行程必须填写 destinations 和 accommodations；单城市也要填写 destinations，accommodation 与 accommodations[0] 保持一致。
4. daily_plans 必须从 Day 1 连续覆盖到用户要求的总天数，不能缺天、重复或跳号。
5. 每天景点数量符合节奏偏好；relaxed 通常 2-3 个主要地点。
6. 用户明确点名的地点、国家和体验必须覆盖；跨国路线严格遵守起点、终点和交通方式。
7. 同名地点必须选当天 city/country 内的候选，并在 name_en 中附带城市或行政区用于消歧。
8. 信息严重不足才返回 need_clarification。
9. 描述和 tips 要简短，优先保证完整 JSON 和完整天数。`;

const LONG_OUTLINE_PROMPT = `你是长途旅行路线架构师。请先输出一份紧凑但完整的长行程骨架，只输出 JSON。

JSON 顶层和 plan 元数据必须遵循下面结构：
${PLAN_SCHEMA}

这是长行程骨架阶段，daily_plans 中每个 spot 只输出 name、name_en、type；不要输出 description、tips、duration_hours，以节省长度。transport_notes 只写一句。

硬性要求：
- daily_plans 必须逐日连续覆盖用户要求的全部天数。
- 每一天和每个 spot 必须有准确的 city 和 country；一日跨城时 spot.city 填景点真实所在地。
- destinations 的天数范围必须覆盖全程；多国顺序、起点、终点和指定交通方式不得改变。
- name_en 必须带城市或行政区消歧；不要选择同名的其他城市地点。
- relaxed 节奏每天安排 2-3 个主要地点。
- 只输出 JSON，不要 Markdown。`;

const DETAIL_PROMPT = `你是旅行计划细化助手。输入会包含用户原需求和一个已经确定的行程片段骨架。
只输出以下 JSON：{"daily_plans":[...]}

要求：
- 不得改变 day、city、country、景点 name、name_en、type，也不得增删景点。
- 为每个景点补充 duration_hours、简短 description、简短 tips。
- 补充当天 transport_notes，并遵守用户指定的交通方式和旅行节奏。
- 只输出 JSON，不要 Markdown。`;

export class LLMOutputError extends Error {
  constructor(message, code = 'LLM_INVALID_OUTPUT') {
    super(message);
    this.name = 'LLMOutputError';
    this.code = code;
  }
}

export function requestedDaysFromText(text = '') {
  const matches = [...String(text).matchAll(/(\d{1,3})\s*(?:天|日)(?:\s*(?:游|行程|旅行))?/g)];
  if (matches.length === 0) return null;
  const values = matches.map(match => Number(match[1])).filter(value => value > 0 && value <= 180);
  return values.length ? Math.max(...values) : null;
}

export function isLongTripRequest(text = '') {
  const days = requestedDaysFromText(text);
  return days !== null && days >= LONG_TRIP_THRESHOLD_DAYS;
}

export function parseJsonContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new LLMOutputError('LLM 未返回内容', 'LLM_EMPTY_OUTPUT');
  }

  const trimmed = content.trim().replace(/^\uFEFF/, '');
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个候选片段。
    }
  }
  throw new LLMOutputError('LLM 返回了无法解析的内容', 'LLM_INVALID_JSON');
}

function llmConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
}

async function requestJson(systemPrompt, userContent, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const { apiKey, baseUrl, model } = llmConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let response;

  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.25,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('DeepSeek API 请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new LLMOutputError('行程内容超过单次输出长度，正在自动分段生成', 'LLM_OUTPUT_TRUNCATED');
  }
  if (choice?.finish_reason && choice.finish_reason !== 'stop') {
    throw new LLMOutputError(`LLM 输出被中断 (${choice.finish_reason})`, 'LLM_OUTPUT_INTERRUPTED');
  }
  return parseJsonContent(choice?.message?.content);
}

async function requestJsonWithRetry(systemPrompt, userContent, options = {}) {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const retryHint = attempt === 0
        ? ''
        : '\n\n上一次输出为空、被截断或不是合法 JSON。请缩短描述，确保这次输出完整且只包含 JSON。';
      return await requestJson(systemPrompt, `${userContent}${retryHint}`, options);
    } catch (error) {
      firstError ||= error;
      if (!(error instanceof LLMOutputError)) throw error;
    }
  }
  throw firstError;
}

function destinationForDay(destinations, dayNumber) {
  return (destinations || []).find(item =>
    Number(item.start_day) <= dayNumber && Number(item.end_day) >= dayNumber,
  );
}

export function normalizePlan(plan, requestedDays = null) {
  if (!plan || typeof plan !== 'object') return plan;
  const destinations = Array.isArray(plan.destinations) ? plan.destinations : [];
  const fallbackCity = plan.city && plan.city !== '多城市' ? plan.city : '';
  const fallbackCountry = plan.country && !String(plan.country).includes('、') ? plan.country : '';
  const singleDestinationScope = Boolean(fallbackCity && destinations.length <= 1);
  const dailyPlans = (Array.isArray(plan.daily_plans) ? plan.daily_plans : [])
    .map((day, index) => {
      const dayNumber = Number(day.day) || index + 1;
      const destination = destinationForDay(destinations, dayNumber);
      const resolvedCity = singleDestinationScope
        ? destination?.city || fallbackCity
        : day.city || destination?.city || fallbackCity;
      const resolvedCountry = singleDestinationScope
        ? destination?.country || fallbackCountry
        : day.country || destination?.country || fallbackCountry;
      return {
        ...day,
        day: dayNumber,
        city: resolvedCity,
        country: resolvedCountry,
        spots: (Array.isArray(day.spots) ? day.spots : []).map(spot => ({
          ...spot,
          city: singleDestinationScope ? resolvedCity : spot.city || resolvedCity,
          country: singleDestinationScope ? resolvedCountry : spot.country || resolvedCountry,
        })),
      };
    })
    .sort((a, b) => a.day - b.day);

  const accommodations = Array.isArray(plan.accommodations) && plan.accommodations.length
    ? plan.accommodations
    : plan.accommodation
      ? [{
          city: fallbackCity || destinations[0]?.city || '',
          country: fallbackCountry || destinations[0]?.country || '',
          ...plan.accommodation,
        }]
      : [];

  return {
    ...plan,
    days: Number(plan.days) || requestedDays || dailyPlans.length,
    destinations,
    accommodations,
    accommodation: plan.accommodation || accommodations[0] || null,
    daily_plans: dailyPlans,
  };
}

function assertCompleteDays(plan, expectedDays) {
  if (!expectedDays) return;
  const dayNumbers = new Set((plan.daily_plans || []).map(day => Number(day.day)));
  const missing = [];
  for (let day = 1; day <= expectedDays; day++) {
    if (!dayNumbers.has(day)) missing.push(day);
  }
  if (missing.length) {
    throw new LLMOutputError(
      `LLM 长行程缺少 Day ${missing.slice(0, 8).join('、')}${missing.length > 8 ? '…' : ''}`,
      'LLM_INCOMPLETE_PLAN',
    );
  }
}

function mergeDetailedDay(outlineDay, detailedDay) {
  if (!detailedDay) return outlineDay;
  const detailedSpots = Array.isArray(detailedDay.spots) ? detailedDay.spots : [];
  const spots = (outlineDay.spots || []).map((spot, index) => {
    const detail = detailedSpots.find(item => item.name === spot.name || item.name_en === spot.name_en)
      || detailedSpots[index]
      || {};
    return {
      ...spot,
      duration_hours: Number(detail.duration_hours) || Number(spot.duration_hours) || 2,
      description: detail.description || spot.description || '',
      tips: detail.tips || spot.tips || '',
    };
  });
  return {
    ...outlineDay,
    theme: detailedDay.theme || outlineDay.theme,
    transport_notes: detailedDay.transport_notes || outlineDay.transport_notes || '',
    spots,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function generateLongPlan(userMessage, feedback = null) {
  const expectedDays = requestedDaysFromText(userMessage);
  const feedbackText = feedback ? `\n\n修正要求：\n${feedback}` : '';
  let outlineResult;
  let outlineError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completenessHint = attempt === 0
        ? ''
        : `\n\n上一次没有完整覆盖 ${expectedDays} 天。请压缩文字，并严格输出 Day 1 到 Day ${expectedDays}。`;
      outlineResult = await requestJsonWithRetry(
        LONG_OUTLINE_PROMPT,
        `${userMessage}${feedbackText}${completenessHint}`,
        { maxTokens: DEFAULT_MAX_TOKENS },
      );
      if (outlineResult.status === 'need_clarification') return outlineResult;
      outlineResult.plan = normalizePlan(outlineResult.plan, expectedDays);
      assertCompleteDays(outlineResult.plan, expectedDays);
      break;
    } catch (error) {
      outlineError = error;
      outlineResult = null;
    }
  }
  if (!outlineResult?.plan) throw outlineError || new Error('长行程骨架生成失败');

  const chunks = [];
  for (let index = 0; index < outlineResult.plan.daily_plans.length; index += DETAIL_CHUNK_SIZE) {
    chunks.push(outlineResult.plan.daily_plans.slice(index, index + DETAIL_CHUNK_SIZE));
  }

  const detailedChunks = await mapWithConcurrency(chunks, 2, async (chunk) => {
    try {
      return await requestJsonWithRetry(
        DETAIL_PROMPT,
        `【用户原需求】\n${userMessage}\n\n【不可更改的行程骨架】\n${JSON.stringify({ daily_plans: chunk })}`,
        { maxTokens: 4096 },
      );
    } catch (error) {
      console.warn(`[LLM] Day ${chunk[0]?.day}-${chunk.at(-1)?.day} 细化失败，使用骨架兜底: ${error.message}`);
      return { daily_plans: chunk };
    }
  });

  const detailByDay = new Map(
    detailedChunks.flatMap(chunk => chunk?.daily_plans || []).map(day => [Number(day.day), day]),
  );
  outlineResult.plan.daily_plans = outlineResult.plan.daily_plans.map(day =>
    mergeDetailedDay(day, detailByDay.get(Number(day.day))),
  );
  assertCompleteDays(outlineResult.plan, expectedDays);
  return outlineResult;
}

export async function callLLM(userMessage, feedback = null) {
  if (isLongTripRequest(userMessage)) {
    console.log(`[LLM] 检测到 ${requestedDaysFromText(userMessage)} 天长行程，启用分段生成`);
    return generateLongPlan(userMessage, feedback);
  }

  const userContent = feedback
    ? `${userMessage}\n\n---\n${feedback}\n---\n请输出修正后的完整 JSON。`
    : userMessage;
  const result = await requestJsonWithRetry(SYSTEM_PROMPT, userContent, { maxTokens: DEFAULT_MAX_TOKENS });
  if (result.plan) result.plan = normalizePlan(result.plan, requestedDaysFromText(userMessage));
  return result;
}
