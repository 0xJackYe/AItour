process.env.LOG_LEVEL ||= 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { getConfig } from '../config.js';
import { resetGoogleClient } from '../services/google.js';
import { createMockUpstream } from '../testing/mockUpstream.js';

const realFetch = globalThis.fetch;

async function startServer({ env = {}, mock = {}, clientDist } = {}) {
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'test-deepseek',
    GOOGLE_MAPS_API_KEY: 'test-google',
    SERVE_CLIENT: clientDist ? 'true' : 'false',
    ...env,
  });
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  resetGoogleClient();
  const upstream = createMockUpstream(mock).install();
  const app = createApp({ config: getConfig(), ...(clientDist ? { clientDist } : {}) });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    upstream,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      upstream.restore();
      process.env = savedEnv;
      resetGoogleClient();
    },
  };
}

function post(base, body, { stream = false, signal } = {}) {
  return realFetch(`${base}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

function parseSse(textValue) {
  return textValue.split('\n\n').map((block) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return data ? { event, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

function allSpots(result) {
  return result.plan.daily_plans.flatMap(day => day.spots);
}

test('健康检查与运行时配置', async () => {
  const server = await startServer();
  try {
    const health = await (await realFetch(`${server.base}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.llm_configured, true);
    assert.equal(health.maps_configured, true);
    const config = await (await realFetch(`${server.base}/api/config`)).json();
    assert.equal(config.maps.browserKey, 'test-google');
    assert.equal(config.maps.mapId, 'DEMO_MAP_ID');
    assert.equal(config.limits.maxTripDays, 30);
  } finally {
    await server.close();
  }
});

test('JSON 模式：京都三天（前端示例）完整生成、全部定位、逐段路线', async () => {
  const server = await startServer();
  try {
    const response = await post(server.base, { query: '我想去京都玩三天，想去清水寺、伏见稻荷、岚山，住在地铁方便的地方，行程别太赶' });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('x-request-id'));
    const result = await response.json();
    assert.equal(result.status, 'success');
    assert.equal(result.plan.days, 3);
    assert.deepEqual(result.plan.daily_plans.map(day => day.day), [1, 2, 3]);
    assert.ok(allSpots(result).every(spot => spot.coordinates && spot.location_status === 'verified'));
    assert.equal(result.quality.verified_spots, result.quality.total_spots);
    assert.equal(result.routes.length, 3);
    assert.ok(result.routes.every(route => route.legs.length === 2 && route.distance_meters > 0));
    assert.ok(result.transit_markers.length > 0);
    assert.equal(result.verification.passed, true);
    assert.equal(result.meta.request_id, response.headers.get('x-request-id'));
    assert.ok(result.meta.stats.llm_calls >= 2, '生成 + 自审');
    assert.match(server.upstream.calls.llm.find(call => call.purpose === 'plan').model, /deepseek/);
  } finally {
    await server.close();
  }
});

test('SSE 模式：巴黎示例保留凡尔赛宫，进度事件单调递增并覆盖各阶段', async () => {
  const server = await startServer();
  try {
    const response = await post(server.base, { query: '巴黎四天三夜，想看埃菲尔铁塔、卢浮宫、凡尔赛宫，喜欢咖啡馆和甜品' }, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const events = parseSse(await response.text());
    const progress = events.filter(item => item.event === 'progress').map(item => item.data);
    const stages = new Set(progress.map(item => item.stage));
    for (const stage of ['parse', 'generate', 'verify', 'route']) assert.ok(stages.has(stage), `缺少阶段 ${stage}`);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress >= progress[i - 1].progress, '进度不应倒退');
    const result = events.find(item => item.event === 'result').data;
    assert.equal(result.plan.days, 4);
    const versailles = allSpots(result).find(spot => spot.name === '凡尔赛宫');
    assert.ok(versailles?.coordinates, '凡尔赛宫不应再被城市边界误删');
    assert.ok(server.upstream.calls.llm.every(call => call.stream), '默认使用流式调用');
  } finally {
    await server.close();
  }
});

test('东京示例保留迪士尼（千叶县浦安）', async () => {
  const server = await startServer();
  try {
    const result = await (await post(server.base, { query: '东京五日游，带小孩，想去迪士尼、浅草寺、秋叶原、台场，预算中等' })).json();
    assert.equal(result.plan.days, 5);
    assert.ok(allSpots(result).find(spot => spot.name === '东京迪士尼乐园')?.coordinates);
  } finally {
    await server.close();
  }
});

test('地图校验发现大量无法定位的地点时，带反馈重生成并采用更好的版本', async () => {
  const server = await startServer({
    mock: {
      planHook: (plan, { call }) => {
        if (call > 0) return plan;
        plan.daily_plans.forEach((day) => {
          day.spots.push({ name: `虚构景点${day.day}`, name_en: `Imaginary Spot ${day.day}, Kyoto`, city: '京都', country: '日本', type: 'attraction' });
        });
        return plan;
      },
    },
  });
  try {
    const result = await (await post(server.base, { query: '京都三天' })).json();
    assert.equal(result.status, 'success');
    assert.equal(result.quality.regeneration, 'applied');
    assert.equal(result.verification.regenerated, true);
    assert.ok(!allSpots(result).some(spot => spot.name.startsWith('虚构景点')));
    const planCalls = server.upstream.calls.llm.filter(call => call.purpose === 'plan');
    assert.equal(planCalls.length, 2);
  } finally {
    await server.close();
  }
});

test('没有公交数据的地区：不会把驾车当作公共交通方案展示', async () => {
  const server = await startServer({ mock: { transitAvailable: false } });
  try {
    const result = await (await post(server.base, { query: '东京五日游，带小孩，想去迪士尼、浅草寺、秋叶原、台场' })).json();
    const legs = result.routes.flatMap(route => route.legs);
    assert.ok(legs.length > 0);
    assert.ok(legs.every(leg => leg.mode !== 'TRANSIT'));
    assert.ok(legs.filter(leg => leg.mode === 'DRIVE').every(leg => leg.transit_unavailable === true));
  } finally {
    await server.close();
  }
});

test('大模型短暂 503 自动重试后成功', async () => {
  const server = await startServer({ mock: { llmFailures: [503] } });
  try {
    const result = await (await post(server.base, { query: '京都三天' })).json();
    assert.equal(result.status, 'success');
  } finally {
    await server.close();
  }
});

test('单次生成被截断时自动改为分段生成', async () => {
  const server = await startServer({ mock: { finishReasons: ['length'] } });
  try {
    const result = await (await post(server.base, { query: '京都五天' })).json();
    assert.equal(result.status, 'success');
    assert.equal(result.plan.days, 5);
    assert.equal(result.meta.strategy, 'chunked-fallback');
  } finally {
    await server.close();
  }
});

test('长行程（两周）走分段生成', async () => {
  const server = await startServer();
  try {
    const result = await (await post(server.base, { query: '京都两周深度游' })).json();
    assert.equal(result.plan.days, 14);
    assert.equal(result.meta.strategy, 'chunked');
    assert.ok(server.upstream.calls.llm.some(call => call.purpose === 'outline'));
    assert.ok(allSpots(result).every(spot => spot.description));
  } finally {
    await server.close();
  }
});

test('输入校验与未知接口', async () => {
  const server = await startServer();
  try {
    const empty = await post(server.base, { query: '   ' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'INVALID_INPUT');

    const tooLong = await post(server.base, { query: '京'.repeat(1001) });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).code, 'INPUT_TOO_LONG');

    const badJson = await post(server.base, '{"query":');
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).code, 'INVALID_INPUT');

    const notFound = await realFetch(`${server.base}/api/nope`);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).code, 'NOT_FOUND');
    assert.equal(server.upstream.calls.llm.length, 0);
  } finally {
    await server.close();
  }
});

test('未配置大模型 Key 时返回 503 CONFIG_MISSING', async () => {
  const server = await startServer({ env: { DEEPSEEK_API_KEY: undefined } });
  try {
    const response = await post(server.base, { query: '京都三天' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CONFIG_MISSING');
  } finally {
    await server.close();
  }
});

test('限流：超出次数返回 429', async () => {
  const server = await startServer({ env: { PLAN_RATE_LIMIT: '1' } });
  try {
    assert.equal((await post(server.base, { query: '京都三天' })).status, 200);
    const limited = await post(server.base, { query: '京都三天' });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
  } finally {
    await server.close();
  }
});

test('超过最大天数时直接澄清，不消耗大模型额度', async () => {
  const server = await startServer();
  try {
    const result = await (await post(server.base, { query: '去欧洲玩六十天' })).json();
    assert.equal(result.status, 'need_clarification');
    assert.match(result.questions[0], /30 天/);
    assert.equal(server.upstream.calls.llm.length, 0);
  } finally {
    await server.close();
  }
});

test('信息不足时返回澄清问题', async () => {
  const server = await startServer();
  try {
    const result = await (await post(server.base, { query: '帮我规划一个旅行' })).json();
    assert.equal(result.status, 'need_clarification');
    assert.ok(result.questions.length > 0);
  } finally {
    await server.close();
  }
});

test('大模型鉴权失败：JSON 返回 503，SSE 返回 error 事件', async () => {
  const server = await startServer({ mock: { llmFailures: [401, 401] } });
  try {
    const json = await post(server.base, { query: '京都三天' });
    assert.equal(json.status, 503);
    const body = await json.json();
    assert.equal(body.code, 'LLM_AUTH');
    assert.ok(body.request_id);

    const streamed = parseSse(await (await post(server.base, { query: '京都三天' }, { stream: true })).text());
    const error = streamed.find(item => item.event === 'error');
    assert.equal(error.data.code, 'LLM_AUTH');
  } finally {
    await server.close();
  }
});

test('客户端断开后立即取消上游大模型请求', async () => {
  const server = await startServer({ mock: { llmDelayMs: 3000 } });
  try {
    const controller = new AbortController();
    const response = await post(server.base, { query: '京都三天' }, { stream: true, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('"stage":"generate"')) {
      const { value } = await reader.read();
      received += decoder.decode(value, { stream: true });
    }
    controller.abort();
    const deadline = Date.now() + 2000;
    while (!server.upstream.signals[0]?.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.upstream.signals[0]?.aborted, true, '上游请求应被中止');
    assert.equal(server.upstream.calls.llm.length, 1, '取消后不应发起新的大模型请求');
  } finally {
    await server.close();
  }
});

test('并发已满时返回 503 SERVER_BUSY', async () => {
  const server = await startServer({ env: { PLAN_MAX_CONCURRENT: '1' }, mock: { llmDelayMs: 300 } });
  try {
    const first = post(server.base, { query: '京都三天' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await post(server.base, { query: '京都三天' });
    assert.equal(second.status, 503);
    assert.equal((await second.json()).code, 'SERVER_BUSY');
    assert.equal((await first).status, 200);
  } finally {
    await server.close();
  }
});

test('未配置 Google Key 时仍返回完整行程（不定位）并提示', async () => {
  const server = await startServer({ env: { GOOGLE_MAPS_API_KEY: undefined } });
  try {
    const result = await (await post(server.base, { query: '京都三天' })).json();
    assert.equal(result.status, 'success');
    assert.equal(result.plan.daily_plans.length, 3);
    assert.equal(result.quality.grounding_available, false);
    assert.ok(result.geocoding_warnings.some(item => item.code === 'maps_unavailable'));
    assert.equal(result.quality.regeneration, null, '地图不可用时不应触发重生成');
  } finally {
    await server.close();
  }
});

test('托管前端构建产物，并支持前端路由回退', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'aitour-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>AItour</title>');
  const server = await startServer({ clientDist: dist });
  try {
    const home = await realFetch(`${server.base}/`);
    assert.match(await home.text(), /AItour/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    const deep = await realFetch(`${server.base}/history/42`);
    assert.match(await deep.text(), /AItour/);
    const api404 = await realFetch(`${server.base}/api/unknown`);
    assert.equal(api404.status, 404);
  } finally {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  }
});
