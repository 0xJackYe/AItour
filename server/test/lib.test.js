import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, sleep, withRetry } from '../lib/async.js';
import { TtlCache } from '../lib/cache.js';
import { AppError, toPublicError } from '../lib/errors.js';
import { decodePolyline, encodePolyline, haversineKm } from '../lib/geo.js';
import { createRateLimiter } from '../lib/rateLimit.js';

test('TtlCache：过期、LRU 淘汰与 single-flight', async () => {
  let now = 0;
  const cache = new TtlCache({ max: 2, ttlMs: 100, now: () => now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.has('b'), false, '最久未使用的 b 被淘汰');
  assert.equal(cache.get('a'), 1);
  now = 200;
  assert.equal(cache.get('a'), undefined, '过期后失效');

  let producerCalls = 0;
  const producer = async () => {
    producerCalls++;
    await sleep(10);
    return 'value';
  };
  const results = await Promise.all([cache.wrap('k', producer), cache.wrap('k', producer), cache.wrap('k', producer)]);
  assert.deepEqual(results, ['value', 'value', 'value']);
  assert.equal(producerCalls, 1, '并发相同请求只执行一次');
});

test('TtlCache：失败结果不缓存', async () => {
  const cache = new TtlCache();
  await assert.rejects(cache.wrap('x', async () => { throw new Error('boom'); }));
  assert.equal(await cache.wrap('x', async () => 'ok'), 'ok');
});

test('withRetry：只重试可重试错误，并在次数用尽后抛出', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new AppError('X', 'transient', { retryable: true });
    return 'done';
  }, { retries: 2, baseDelayMs: 1 });
  assert.equal(value, 'done');

  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new AppError('X', 'fatal');
  }, { retries: 3, baseDelayMs: 1 }));
  assert.equal(calls, 1);
});

test('withRetry：取消信号会打断退避等待', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  await assert.rejects(
    withRetry(async () => { throw new AppError('X', 'transient', { retryable: true }); }, { retries: 5, baseDelayMs: 5000, signal: controller.signal }),
    { code: 'CANCELLED' },
  );
  assert.ok(Date.now() - started < 1000);
});

test('createLimiter：限制最大并发', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
  })));
  assert.equal(peak, 2);
});

test('polyline 编解码往返一致', () => {
  const points = [[35.0116, 135.7681], [34.9949, 135.785], [-33.8688, 151.2093]];
  assert.deepEqual(decodePolyline(encodePolyline(points)), points);
  assert.ok(Math.abs(haversineKm({ lat: 35.6762, lng: 139.6503 }, { lat: 34.6937, lng: 135.5023 }) - 397) < 5);
});

test('限流：超出次数返回 RATE_LIMITED 并设置 Retry-After', () => {
  let now = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => now });
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; } };
  const results = [];
  for (let i = 0; i < 3; i++) limiter({ ip: '1.1.1.1' }, res, error => results.push(error?.code || 'ok'));
  assert.deepEqual(results, ['ok', 'ok', 'RATE_LIMITED']);
  assert.equal(headers['Retry-After'], '1');
  now = 1500;
  limiter({ ip: '1.1.1.1' }, res, error => results.push(error?.code || 'ok'));
  assert.equal(results.at(-1), 'ok', '窗口过后恢复');
});

test('对外错误不泄露内部细节', () => {
  const internal = toPublicError(new Error('DB password is hunter2'));
  assert.equal(internal.code, 'INTERNAL');
  assert.ok(!internal.message.includes('hunter2'));
  const llm = toPublicError(new AppError('LLM_INVALID_JSON', 'raw upstream text', { status: 502 }));
  assert.equal(llm.code, 'LLM_INVALID_OUTPUT');
  assert.equal(llm.retryable, true);
  assert.ok(!llm.message.includes('raw upstream'));
});
