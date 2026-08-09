import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../services/verify.js';

test('AI 审核不可用时 fail-closed 为 unknown，不伪称已通过', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await verifyPlan('京都三天', { daily_plans: [] });
    assert.equal(result.status, 'unknown');
    assert.equal(result.passed, false);
    assert.equal(result.skipped, true);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('AI 审核请求包含独立跨城说明并检查具体线路', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = global.fetch;
  let request;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        passed: true, missing_spots: [], incorrect_spots: [], transport_issues: [],
        warnings: [], needs_regeneration: false,
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await verifyPlan('大阪到京都', {
      city: '多城市', country: '日本', days: 2, route_reasoning: '大阪到京都向东移动',
      daily_plans: [
        {
          day: 1, city: '大阪', country: '日本', transport_notes: '环球影城往返',
          connection_to_next_notes: '大阪站乘 JR 京都线新快速到京都站', spots: [],
        },
        { day: 2, city: '京都', country: '日本', transport_notes: '京都市内巴士', connection_to_next_notes: null, spots: [] },
      ],
    });
    assert.equal(result.passed, true);
    assert.match(request.messages[0].content, /connection_to_next_notes/);
    assert.match(request.messages[0].content, /不得用当天市内 transport_notes 冒充跨城说明/);
    assert.match(request.messages[1].content, /大阪站乘 JR 京都线新快速到京都站/);
    assert.match(request.messages[1].content, /环球影城往返/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});
