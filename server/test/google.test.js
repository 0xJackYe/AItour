import test from 'node:test';
import assert from 'node:assert/strict';
import { googleJsonRequest } from '../services/google.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Google 请求对瞬态网络失败有界重试且每次使用独立 signal', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    signals.push(options.signal);
    if (calls === 1) throw new TypeError('fetch failed');
    return jsonResponse({ ok: true });
  };
  try {
    const result = await googleJsonRequest('https://example.test', { retryDelayMs: 0, timeoutMs: 1000 });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    assert.notEqual(signals[0], signals[1]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Google 请求重试 HTTP 429/5xx，但 4xx 逻辑错误不重试', async () => {
  const originalFetch = global.fetch;
  try {
    for (const status of [429, 503]) {
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return calls === 1
          ? jsonResponse({ error: { code: status, message: 'temporary' } }, status)
          : jsonResponse({ recovered: status });
      };
      assert.deepEqual(
        await googleJsonRequest('https://example.test', { retryDelayMs: 0 }),
        { recovered: status },
      );
      assert.equal(calls, 2);
    }

    let badRequestCalls = 0;
    global.fetch = async () => {
      badRequestCalls++;
      return jsonResponse({ error: { code: 400, message: 'invalid request' } }, 400);
    };
    await assert.rejects(
      googleJsonRequest('https://example.test', { retryDelayMs: 0 }),
      /invalid request/,
    );
    assert.equal(badRequestCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Google 请求对 AbortError 最多尝试两次并以超时错误结束', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    await assert.rejects(
      googleJsonRequest('https://example.test', { retryDelayMs: 0 }),
      /请求超时/,
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
