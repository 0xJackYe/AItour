import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredOrigins,
  createPlanningRateLimiter,
  isCorsOriginAllowed,
} from '../services/httpSecurity.js';

test('生产环境 CORS 只允许显式配置来源', () => {
  const allowedOrigins = configuredOrigins('https://app.example.com, https://admin.example.com');
  assert.equal(isCorsOriginAllowed('https://app.example.com', { allowedOrigins, environment: 'production' }), true);
  assert.equal(isCorsOriginAllowed('http://localhost:5173', { allowedOrigins, environment: 'production' }), false);
  assert.equal(isCorsOriginAllowed(null, { allowedOrigins, environment: 'production' }), true);
});

test('开发环境允许本机前端但拒绝伪造来源', () => {
  assert.equal(isCorsOriginAllowed('http://localhost:5173', { environment: 'development' }), true);
  assert.equal(isCorsOriginAllowed('https://evil.example', { environment: 'development' }), false);
  assert.equal(isCorsOriginAllowed('not-a-url', { environment: 'development' }), false);
});

test('规划限流在窗口内超过阈值后返回 429', () => {
  let clock = 1000;
  const middleware = createPlanningRateLimiter({ max: 2, windowMs: 1000, now: () => clock });
  const request = { ip: '127.0.0.1' };
  const makeResponse = () => ({
    headers: {}, statusCode: 200, payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  });
  let nextCalls = 0;
  middleware(request, makeResponse(), () => { nextCalls++; });
  middleware(request, makeResponse(), () => { nextCalls++; });
  const blocked = makeResponse();
  middleware(request, blocked, () => { nextCalls++; });
  assert.equal(nextCalls, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.code, 'PLAN_RATE_LIMITED');

  clock = 2001;
  middleware(request, makeResponse(), () => { nextCalls++; });
  assert.equal(nextCalls, 3);
});
