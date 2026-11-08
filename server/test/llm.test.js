process.env.LOG_LEVEL ||= 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithContext } from '../lib/context.js';
import {
  DETAIL_CHUNK_SIZE,
  callLLM,
  chatCompletion,
  chatCompletionsUrl,
  isLongTripRequest,
  parseJsonContent,
  requestedDaysFromText,
} from '../services/llm.js';
import { llmPurpose } from '../testing/mockUpstream.js';
import { configureWorkersAI } from '../services/workersAi.js';

const COMPLEX_QUERY = '我想去塞尔维亚，波黑，克罗地亚，意大利，瑞士，法国。帮我设计一个完整的旅游路线，总时长28天，预算中等，旅行节奏轻松，塞尔维亚开始，法国结束，欧洲内部交通用火车';

function completion(payload, finishReason = 'stop') {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: finishReason,
      message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sse(chunks, signal) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      for (const item of chunks) controller.enqueue(encoder.encode(item));
      if (!chunks.hang) controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const RICH = '这里有足够具体的介绍：看点、体验和顺路安排都写清楚了，游客可以直接照着走。';

function richSpots(day) {
  return [
    { name: `景点${day}`, name_en: `Spot ${day}, Tokyo`, type: 'attraction', start_time: '09:30', duration_hours: 2, description: RICH },
    { name: `午餐${day}号店`, name_en: `Lunch Place ${day}, Tokyo`, type: 'restaurant', start_time: '12:00', duration_hours: 1, description: RICH },
    { name: `景点${day}B`, name_en: `Spot ${day}B, Tokyo`, type: 'attraction', start_time: '14:00', duration_hours: 2, description: RICH },
    { name: `晚餐${day}号店`, name_en: `Dinner Place ${day}, Tokyo`, type: 'restaurant', start_time: '18:30', duration_hours: 1.5, description: RICH },
  ];
}

function tokyoPlan(days, { missing = [] } = {}) {
  return {
    status: 'success',
    plan: {
      title: '东京', city: '东京', country: '日本', days,
      destinations: [{ city: '东京', country: '日本', start_day: 1, end_day: days }],
      daily_plans: Array.from({ length: days }, (_, i) => i + 1)
        .filter(day => !missing.includes(day))
        .map(day => ({ day, city: '东京', country: '日本', spots: richSpots(day), transport_notes: '地铁与步行结合' })),
    },
  };
}

async function withFetch(handler, fn, env = {}) {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  Object.assign(process.env, env);
  global.fetch = handler;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
}

function buildOutline() {
  const destinations = [
    { city: '贝尔格莱德', country: '塞尔维亚', start_day: 1, end_day: 5 },
    { city: '萨拉热窝', country: '波黑', start_day: 6, end_day: 9 },
    { city: '杜布罗夫尼克', country: '克罗地亚', start_day: 10, end_day: 12 },
    { city: '佛罗伦萨', country: '意大利', start_day: 13, end_day: 17 },
    { city: '卢塞恩', country: '瑞士', start_day: 18, end_day: 22 },
    { city: '巴黎', country: '法国', start_day: 23, end_day: 28 },
  ];
  const dailyPlans = Array.from({ length: 28 }, (_, index) => {
    const day = index + 1;
    const destination = destinations.find(item => item.start_day <= day && item.end_day >= day);
    return {
      day,
      city: destination.city,
      country: destination.country,
      theme: `${destination.city}第${day}天`,
      spots: [
        { name: `${destination.city}历史中心${day}`, name_en: `${destination.city} Historic Centre ${day}`, type: 'attraction' },
        { name: `${destination.city}博物馆${day}`, name_en: `${destination.city} Museum ${day}`, type: 'attraction' },
      ],
      transport_notes: '使用火车和市内公共交通。',
    };
  });
  return {
    status: 'success',
    clarification_questions: [],
    plan: {
      title: '欧洲历史与自然28日行程',
      city: '多城市',
      country: '塞尔维亚、波黑、克罗地亚、意大利、瑞士、法国',
      days: 28,
      summary: '从塞尔维亚到法国的慢节奏铁路旅行。',
      preferences: { pace: 'relaxed', budget: 'moderate', interests: ['历史', '自然'] },
      destinations,
      accommodations: destinations.map(item => ({ ...item, area: '中央车站附近', reason: '交通方便', landmark: `${item.city} Central Station` })),
      daily_plans: dailyPlans,
      route_reasoning: '由东向西减少折返。',
      practical_tips: ['提前预订跨国列车。'],
    },
  };
}

test('识别复杂请求为 28 天长行程', () => {
  assert.equal(requestedDaysFromText(COMPLEX_QUERY), 28);
  assert.equal(isLongTripRequest(COMPLEX_QUERY), true);
  assert.equal(isLongTripRequest('日本两周深度游'), true, '旧版无法识别“两周”，会被当作短行程一次生成');
  assert.equal(isLongTripRequest('京都三天'), false);
});

test('能从代码围栏、附带文字和尾逗号中提取 JSON', () => {
  assert.deepEqual(parseJsonContent('结果如下：\n```json\n{"status":"success"}\n```'), { status: 'success' });
  assert.deepEqual(parseJsonContent('{"a":[1,2,],}'), { a: [1, 2] });
  assert.throws(() => parseJsonContent(''), { code: 'LLM_EMPTY_OUTPUT' });
  assert.throws(() => parseJsonContent('not json'), { code: 'LLM_INVALID_JSON' });
});

test('兼容多种 OpenAI 兼容 Base URL 写法', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(chatCompletionsUrl('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
});

test('长行程按段细化后仍完整保留 28 天和逐日城市上下文', async () => {
  const outline = buildOutline();
  let callCount = 0;
  await withFetch(async (_url, options) => {
    callCount++;
    const request = JSON.parse(options.body);
    const system = request.messages[0].content;
    if (system.includes('长途旅行路线架构师')) return completion(outline);
    const user = request.messages[1].content;
    const chunk = JSON.parse(user.slice(user.indexOf('{"daily_plans"')));
    return completion({
      daily_plans: chunk.daily_plans.map(day => ({
        ...day,
        spots: [
          { ...day.spots[0], start_time: '09:00', duration_hours: 2, description: `经过细化的描述：${RICH}`, tips: '经过细化的建议' },
          { name: `${day.city}午餐${day.day}`, name_en: `Lunch ${day.day}`, type: 'restaurant', start_time: '12:00', duration_hours: 1, description: RICH },
          { ...day.spots[1], start_time: '14:00', duration_hours: 2, description: `经过细化的描述：${RICH}`, tips: '经过细化的建议' },
          { name: `${day.city}晚餐${day.day}`, name_en: `Dinner ${day.day}`, type: 'restaurant', start_time: '18:30', duration_hours: 1.5, description: RICH },
        ],
      })),
    });
  }, async () => {
    const result = await callLLM(COMPLEX_QUERY);
    assert.equal(result.strategy, 'chunked');
    assert.equal(result.plan.days, 28);
    assert.deepEqual(result.plan.daily_plans.map(day => day.day), Array.from({ length: 28 }, (_, i) => i + 1));
    assert.ok(result.plan.daily_plans.every(day => day.city && day.country));
    assert.ok(result.plan.daily_plans.every(day => day.spots.every(spot => spot.description)));
    assert.ok(result.plan.daily_plans.every(day => day.spots.filter(spot => spot.type === 'restaurant').length === 2), '细化阶段补充的午餐和晚餐被合并进来');
    assert.deepEqual(result.plan.daily_plans[0].spots.map(spot => spot.start_time), ['09:00', '12:00', '14:00', '18:30']);
    assert.equal(callCount, 1 + Math.ceil(28 / DETAIL_CHUNK_SIZE), '一次骨架请求 + 每段一次细化请求，细节达标时不再额外补充');
  });
});

test('单次输出被 length 截断时自动降级为分段生成', async () => {
  const purposes = [];
  await withFetch(async (_url, options) => {
    const request = JSON.parse(options.body);
    const purpose = llmPurpose(request.messages[0].content);
    purposes.push(purpose);
    if (purpose === 'plan') return completion('{"status":"success","plan":', 'length');
    if (purpose === 'outline') return completion(tokyoPlan(3));
    return completion({ daily_plans: [] });
  }, async () => {
    const result = await callLLM('东京3天旅行');
    assert.equal(result.strategy, 'chunked-fallback');
    assert.equal(result.plan.daily_plans.length, 3);
    assert.deepEqual(purposes, ['plan', 'outline', 'detail'], '骨架本身已完整，细化为空时保留骨架');
  });
});

test('缺失的天只做定向补全，而不是整份重新生成', async () => {
  const purposes = [];
  await withFetch(async (_url, options) => {
    const request = JSON.parse(options.body);
    const purpose = llmPurpose(request.messages[0].content);
    purposes.push(purpose);
    if (purpose === 'plan') return completion(tokyoPlan(3, { missing: [2] }));
    assert.match(request.messages[1].content, /【需要补全的天】\nDay 2/);
    return completion({ daily_plans: [{ day: 2, transport_notes: '地铁与步行结合', spots: [{ ...richSpots(2)[0], name: '补全景点', name_en: 'Filled, Tokyo' }, ...richSpots(2).slice(1)] }] });
  }, async () => {
    const result = await callLLM('东京三天');
    assert.deepEqual(result.plan.daily_plans.map(day => day.day), [1, 2, 3]);
    assert.equal(result.plan.daily_plans[1].spots[0].name, '补全景点');
    assert.equal(result.plan.daily_plans[1].city, '东京');
    assert.deepEqual(purposes, ['plan', 'repair']);
  });
});

test('补全仍失败时返回明确的 LLM_INCOMPLETE_PLAN，而不是残缺行程', async () => {
  await withFetch(async (_url, options) => {
    const purpose = llmPurpose(JSON.parse(options.body).messages[0].content);
    if (purpose === 'plan' || purpose === 'outline') return completion(tokyoPlan(3, { missing: [3] }));
    return completion({ daily_plans: [] });
  }, async () => {
    await assert.rejects(callLLM('东京三天'), { code: 'LLM_INCOMPLETE_PLAN' });
  });
});

test('高置信度天数作为硬约束写入提示词', async () => {
  let userMessage = '';
  await withFetch(async (_url, options) => {
    userMessage = JSON.parse(options.body).messages[1].content;
    return completion(tokyoPlan(5));
  }, async () => {
    await callLLM('东京五日游，自驾');
    assert.match(userMessage, /总天数：5 天/);
    assert.match(userMessage, /交通偏好：自驾/);
  });
});

test('信息不足时透传澄清问题', async () => {
  await withFetch(async () => completion({ status: 'need_clarification', clarification_questions: ['想去哪个城市？'] }), async () => {
    const result = await callLLM('帮我规划一下');
    assert.equal(result.status, 'need_clarification');
    assert.deepEqual(result.clarification_questions, ['想去哪个城市？']);
  });
});

test('503 / 429 自动退避重试后成功', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls === 1) return new Response('busy', { status: 503 });
    if (calls === 2) return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
    return completion({ ok: true });
  }, async () => {
    const result = await chatCompletion({ system: 's', user: 'u' });
    assert.equal(JSON.parse(result.content).ok, true);
    assert.equal(calls, 3);
  });
});

test('401 鉴权失败不重试', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  }, async () => {
    await assert.rejects(chatCompletion({ system: 's', user: 'u' }), { code: 'LLM_AUTH' });
    assert.equal(calls, 1);
  });
});

test('DeepSeek 余额不足时使用 Workers AI 后备模型', async () => {
  let fallbackCalls = 0;
  configureWorkersAI({
    async run() {
      fallbackCalls++;
      return {
        response: { ok: true, provider: 'workers-ai' },
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      };
    },
  });
  try {
    await withFetch(async () => new Response('insufficient balance', { status: 402 }), async () => {
      const result = await chatCompletion({ system: 's', user: 'u' });
      assert.deepEqual(JSON.parse(result.content), { ok: true, provider: 'workers-ai' });
      assert.equal(result.finishReason, 'stop');
      assert.equal(fallbackCalls, 1);
    });
  } finally {
    configureWorkersAI(null);
  }
});

test('DeepSeek 鉴权失败时使用 Workers AI，并重试一次瞬时错误', async () => {
  let fallbackCalls = 0;
  configureWorkersAI({
    async run() {
      fallbackCalls++;
      if (fallbackCalls === 1) throw new Error('temporary workers ai error');
      return { response: '{"ok":true,"provider":"workers-ai"}' };
    },
  });
  try {
    await withFetch(async () => new Response('invalid key', { status: 401 }), async () => {
      const result = await chatCompletion({ system: 's', user: 'u' });
      assert.deepEqual(JSON.parse(result.content), { ok: true, provider: 'workers-ai' });
      assert.equal(fallbackCalls, 2);
    });
  } finally {
    configureWorkersAI(null);
  }
});

test('未配置 DeepSeek Key 时可以直接使用 Workers AI', async () => {
  configureWorkersAI({ async run() { return { response: '{"ok":true}' }; } });
  try {
    await withFetch(async () => completion({}), async () => {
      process.env.DEEPSEEK_API_KEY = '';
      const result = await chatCompletion({ system: 's', user: 'u' });
      assert.equal(JSON.parse(result.content).ok, true);
    });
  } finally {
    configureWorkersAI(null);
  }
});

test('Workers AI 后备模式跳过可选细化，避免一次请求内重复慢推理', async () => {
  let fallbackCalls = 0;
  configureWorkersAI({
    async run() {
      fallbackCalls++;
      return { response: JSON.stringify(tokyoPlan(1)) };
    },
  });
  try {
    await withFetch(async () => new Response('insufficient balance', { status: 402 }), async () => {
      const result = await runWithContext({ stats: {}, signal: null }, () => callLLM('东京一日游'));
      assert.equal(result.status, 'success');
      assert.equal(result.plan.daily_plans.length, 1);
      assert.equal(fallbackCalls, 1);
    });
  } finally {
    configureWorkersAI(null);
  }
});

test('未配置 Key 时快速失败', async () => {
  await withFetch(async () => completion({}), async () => {
    process.env.DEEPSEEK_API_KEY = '';
    await assert.rejects(chatCompletion({ system: 's', user: 'u' }), { code: 'CONFIG_MISSING' });
  });
});

test('解析 SSE 流式输出并统计用量', async () => {
  const stats = {};
  await withFetch(async (_url, options) => sse([
    ': keep-alive\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"a":' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '1}' } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
  ], options.signal), async () => {
    const result = await runWithContext({ stats }, () => chatCompletion({ system: 's', user: 'u' }));
    assert.equal(result.content, '{"a":1}');
    assert.equal(result.finishReason, 'stop');
    assert.equal(stats.llm_completion_tokens, 3);
  });
});

test('流式输出中途断开（无 finish_reason）会重试', async () => {
  let calls = 0;
  await withFetch(async (_url, options) => {
    calls++;
    if (calls === 1) return sse([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a":' } }] })}\n\n`], options.signal);
    return completion({ a: 2 });
  }, async () => {
    const result = await chatCompletion({ system: 's', user: 'u' });
    assert.equal(JSON.parse(result.content).a, 2);
    assert.equal(calls, 2);
  });
});

test('上游卡死（空闲超时）会被识别并重试', async () => {
  let calls = 0;
  await withFetch(async (_url, options) => {
    calls++;
    if (calls === 1) {
      const chunks = [': keep-alive\n\n'];
      chunks.hang = true;
      return sse(chunks, options.signal);
    }
    return completion({ ok: 1 });
  }, async () => {
    const started = Date.now();
    const result = await chatCompletion({ system: 's', user: 'u' });
    assert.equal(JSON.parse(result.content).ok, 1);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 1000);
  }, { LLM_IDLE_TIMEOUT_MS: '1000' });
});

test('调用方取消时立即中止且不重试', async () => {
  let calls = 0;
  await withFetch(async (_url, options) => {
    calls++;
    const chunks = [];
    chunks.hang = true;
    return sse(chunks, options.signal);
  }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      runWithContext({ signal: controller.signal }, () => chatCompletion({ system: 's', user: 'u' })),
      error => error.code === 'CANCELLED',
    );
    assert.equal(calls, 1);
  });
});

test('质量闸门：介绍过短、缺餐、缺时间都会被识别；换城市的日子和最后一天放宽用餐要求', async () => {
  const { dayDetailGaps } = await import('../services/llm.js');
  const full = { spots: richSpots(1), transport_notes: '地铁与步行结合' };
  assert.deepEqual(dayDetailGaps(full), []);
  const thin = { spots: richSpots(1).map(spot => ({ ...spot, description: '太短' })) };
  assert.ok(dayDetailGaps(thin).some(gap => gap.includes('简短')));
  const noDinner = { spots: richSpots(1).slice(0, 3), transport_notes: '地铁与步行结合' };
  assert.deepEqual(dayDetailGaps(noDinner), ['缺少晚餐']);
  assert.deepEqual(dayDetailGaps(noDinner, { isLastDay: true }), []);
  const travel = { spots: [{ name: '东京站', type: 'transport', start_time: '08:00', description: RICH }, ...richSpots(1).slice(0, 3)], transport_notes: '新干线约 2 小时' };
  assert.deepEqual(dayDetailGaps(travel), []);
  const untimed = { spots: richSpots(1).map(({ start_time, ...spot }) => spot) };
  assert.ok(dayDetailGaps(untimed).includes('缺少时间安排'));
});

test('细节不足的天会被定向补充，并且只在更好时采用', async () => {
  const purposes = [];
  const thinDay = { day: 2, city: '东京', country: '日本', spots: [{ name: '景点2', name_en: 'Spot 2, Tokyo', type: 'attraction', start_time: '10:00', duration_hours: 2, description: '短' }] };
  await withFetch(async (_url, options) => {
    const request = JSON.parse(options.body);
    const purpose = llmPurpose(request.messages[0].content);
    purposes.push(purpose);
    if (purpose === 'plan') {
      const plan = tokyoPlan(3);
      plan.plan.daily_plans[1] = thinDay;
      return completion(plan);
    }
    assert.match(request.messages[1].content, /【需要改进的地方】\nDay 2：/);
    return completion({ daily_plans: [{ day: 2, transport_notes: '地铁与步行结合', spots: richSpots(2).map((spot, index) => (index === 0 ? { ...spot, name: '景点2（Spot 2）' } : spot)) }] });
  }, async () => {
    const result = await callLLM('东京三天');
    const day2 = result.plan.daily_plans[1];
    assert.equal(day2.spots[0].name, '景点2', '保留骨架中的原名');
    assert.equal(day2.spots.filter(spot => spot.type === 'restaurant').length, 2);
    assert.ok(day2.spots.every(spot => spot.description.length >= 25));
    assert.deepEqual(purposes, ['plan', 'detail']);
  });
});

test('定向补充的结果更差时保留原来的版本', async () => {
  const thinDay = { day: 1, city: '东京', country: '日本', spots: [{ name: '景点1', type: 'attraction', start_time: '10:00', duration_hours: 2, description: '短' }] };
  await withFetch(async (_url, options) => {
    const purpose = llmPurpose(JSON.parse(options.body).messages[0].content);
    if (purpose === 'plan') return completion({ status: 'success', plan: { city: '东京', country: '日本', days: 1, daily_plans: [thinDay] } });
    return completion({ daily_plans: [{ day: 1, spots: [{ name: '景点1' }] }] });
  }, async () => {
    const result = await callLLM('东京一日游');
    assert.equal(result.plan.daily_plans[0].spots[0].start_time, '10:00');
    assert.equal(result.plan.daily_plans[0].spots[0].description, '短');
  });
});

test('合并细化结果：容忍名称改写，补充的餐厅按时间插入，占位名称被丢弃', async () => {
  const { mergeDetailedDay } = await import('../services/llm.js');
  const outline = { day: 1, city: '京都', country: '日本', spots: [
    { name: '清水寺', name_en: 'Kiyomizu-dera, Kyoto', type: 'attraction' },
    { name: '祇园', name_en: 'Gion, Kyoto', type: 'attraction' },
  ] };
  const merged = mergeDetailedDay(outline, { theme: '东山', spots: [
    { name: '清水寺（Kiyomizu-dera）', start_time: '09:00', duration_hours: 2, description: RICH },
    { name: '奥丹清水', name_en: 'Okutan Kiyomizu, Kyoto', type: 'restaurant', start_time: '12:00', description: RICH },
    { name: '?', type: 'restaurant', start_time: '13:00' },
    { name: '祇园', start_time: '15:00', duration_hours: 1.5, description: RICH },
  ] });
  assert.deepEqual(merged.spots.map(spot => spot.name), ['清水寺', '奥丹清水', '祇园']);
  assert.equal(merged.spots[1].city, '京都');
  assert.equal(merged.spots[2].start_time, '15:00');
});

test('质量闸门：缺少当天交通建议也算未完成', async () => {
  const { dayDetailGaps } = await import('../services/llm.js');
  assert.deepEqual(dayDetailGaps({ spots: richSpots(1), transport_notes: '地铁银座线 + 步行' }), []);
  assert.ok(dayDetailGaps({ spots: richSpots(1), transport_notes: '' }).includes('缺少当天交通建议'));
});
