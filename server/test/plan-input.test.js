import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import planRouter, { preparePlanRequest } from '../routes/plan.js';

test('plan 输入会对缺失的四项核心偏好进行结构化澄清', () => {
  const result = preparePlanRequest({ query: '我想去京都' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.questions.map(item => item.id), ['days', 'budget', 'pace', 'transportPriority']);
  assert.ok(result.questions.every(item => typeof item.label === 'string' && item.type && item.required));
});

test('plan 输入兼容扁平 transportPriority 并通过完整性检查', () => {
  const result = preparePlanRequest({
    query: '京都行程',
    profile: { days: 3, budgetLevel: 'moderate', pace: 'relaxed', transportPriority: 'transit' },
  });
  assert.deepEqual(result.questions, []);
  assert.equal(result.profile.transport.priority, 'transit');
});

test('POST /api/plan 实际 HTTP 契约返回结构化澄清和规范化 profile', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', planRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '我想去京都' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.status, 'need_clarification');
    assert.deepEqual(result.questions.map(item => item.id), ['days', 'budget', 'pace', 'transportPriority']);
    assert.equal(typeof result.profile, 'object');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /api/plan/recalculate 在无坐标时也返回可解释 health，不伪造路线', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', planRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plan/recalculate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: {
          days: 1, budget: { level: 'moderate', basis: 'total' }, pace: 'relaxed',
          transport: { priority: 'transit', allowedModes: ['WALK', 'TRANSIT'] },
        },
        plan: {
          title: '重算测试', city: '京都', country: '日本', days: 1,
          daily_plans: [{ day: 1, city: '京都', country: '日本', spots: [{ name: '测试景点' }] }],
        },
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.status, 'success');
    assert.equal(result.health.passed, false);
    assert.ok(result.routes.every(route => route.geometry === null));
    assert.ok(result.routes.every(route => route.status === 'unavailable'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
