import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callLLM,
  isLongTripRequest,
  normalizePlan,
  parseJsonContent,
  requestedDaysFromText,
} from '../services/llm.js';

const COMPLEX_QUERY = '我想去塞尔维亚，波黑，克罗地亚，意大利，瑞士，法国。帮我设计一个完整的旅游路线，总时长28天，预算中等，旅行节奏轻松，塞尔维亚开始，法国结束，欧洲内部交通用火车';

function completion(payload, finishReason = 'stop') {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: finishReason,
      message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
});

test('能从代码围栏和附带文字中提取 JSON', () => {
  assert.deepEqual(parseJsonContent('结果如下：\n```json\n{"status":"success"}\n```'), { status: 'success' });
});

test('单城市计划不能通过篡改 spot.city 绕过目标城市约束', () => {
  const plan = normalizePlan({
    city: '东京', country: '日本', days: 1,
    destinations: [{ city: '东京', country: '日本', start_day: 1, end_day: 1 }],
    daily_plans: [{
      day: 1, city: '东京', country: '日本',
      spots: [{ name: '同名景点', name_en: 'Duplicate Place', city: '静冈', country: '日本' }],
    }],
  });
  assert.equal(plan.daily_plans[0].spots[0].city, '东京');
});

test('长行程按段细化后仍完整保留 28 天和逐日城市上下文', async () => {
  const originalFetch = global.fetch;
  const outline = buildOutline();
  let callCount = 0;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async (_url, options) => {
    callCount++;
    const request = JSON.parse(options.body);
    const system = request.messages[0].content;
    if (system.includes('长途旅行路线架构师')) return completion(outline);

    const user = request.messages[1].content;
    const jsonStart = user.indexOf('{"daily_plans"');
    const chunk = JSON.parse(user.slice(jsonStart));
    return completion({
      daily_plans: chunk.daily_plans.map(day => ({
        ...day,
        spots: day.spots.map(spot => ({
          ...spot,
          duration_hours: 2,
          description: '经过细化的描述',
          tips: '经过细化的建议',
        })),
      })),
    });
  };

  try {
    const result = await callLLM(COMPLEX_QUERY);
    assert.equal(result.plan.days, 28);
    assert.equal(result.plan.daily_plans.length, 28);
    assert.deepEqual(result.plan.daily_plans.map(day => day.day), Array.from({ length: 28 }, (_, i) => i + 1));
    assert.ok(result.plan.daily_plans.every(day => day.city && day.country));
    assert.ok(result.plan.daily_plans.every(day => day.spots.every(spot => spot.description)));
    assert.equal(callCount, 5, '应为一次骨架请求和四次 7 天细化请求');
  } finally {
    global.fetch = originalFetch;
  }
});

test('单次输出被 length 截断时会自动重试而不是直接返回解析错误', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) return completion('{"status":"success","plan":', 'length');
    return completion({
      status: 'success',
      plan: {
        city: '东京', country: '日本', days: 3,
        destinations: [{ city: '东京', country: '日本', start_day: 1, end_day: 3 }],
        daily_plans: Array.from({ length: 3 }, (_, i) => ({ day: i + 1, city: '东京', country: '日本', spots: [] })),
      },
    });
  };

  try {
    const result = await callLLM('东京3天旅行');
    assert.equal(result.plan.daily_plans.length, 3);
    assert.equal(callCount, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
