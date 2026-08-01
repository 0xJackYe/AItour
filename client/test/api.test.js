import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, generatePlan } from '../src/services/api.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('生成请求无法连接服务时返回可操作的中文错误', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await assert.rejects(
    generatePlan({ query: '京都三日游', profile: {} }),
    error => error.code === 'NETWORK_UNREACHABLE'
      && error.message === '无法连接到后端服务，请确认本地服务正在运行后重试',
  );
});

test('主动取消请求时保留 AbortError 语义', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  globalThis.fetch = async () => {
    throw abortError;
  };

  await assert.rejects(
    generatePlan({ query: '京都三日游', profile: {} }),
    error => error === abortError,
  );
});

test('开发代理无法连接后端时不会显示模糊的 500 错误', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });

  await assert.rejects(
    generatePlan({ query: '京都三日游', profile: {} }),
    error => error.code === 'NETWORK_UNREACHABLE'
      && error.message === '无法连接到后端服务，请确认本地服务正在运行后重试',
  );
});

test('健康检查仍会解析成功响应', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  assert.deepEqual(await checkHealth(), { status: 'ok' });
});
