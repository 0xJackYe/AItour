import { createSseParser } from './sse.js';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(message, { code = 'UNKNOWN', status = 0, retryable = true, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

async function errorFromResponse(response) {
  const body = await response.json().catch(() => null);
  const fallback = response.status === 404
    ? '后端接口不可用，请确认服务已启动'
    : `请求失败（${response.status}）`;
  return new ApiError(body?.error || fallback, {
    code: body?.code || `HTTP_${response.status}`,
    status: response.status,
    retryable: body?.retryable ?? response.status >= 500,
    requestId: body?.request_id || response.headers.get('x-request-id'),
  });
}

async function readPlanStream(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = null;
  let failure = null;
  const parser = createSseParser(({ event, data }) => {
    if (event === 'progress') onProgress?.(data);
    else if (event === 'result') result = data;
    else if (event === 'error') {
      failure = new ApiError(data?.error || '规划失败，请重试', {
        code: data?.code,
        retryable: data?.retryable !== false,
        requestId: data?.request_id,
      });
    }
  });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();
  if (failure) throw failure;
  if (!result) throw new ApiError('连接意外中断，请重试', { code: 'STREAM_INTERRUPTED' });
  return result;
}

/** 生成行程：优先使用 SSE 获取实时进度；服务端返回普通 JSON 时自动兼容。 */
export async function generatePlan(query, { signal, onProgress } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ query }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查网络或确认后端服务已启动', { code: 'NETWORK' });
  }
  if (!response.ok) throw await errorFromResponse(response);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/event-stream') || !response.body) return response.json();
  try {
    return await readPlanStream(response, onProgress);
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof ApiError) throw error;
    throw new ApiError('连接意外中断，请重试', { code: 'STREAM_INTERRUPTED' });
  }
}

export async function checkHealth() {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new ApiError('后端服务不可用', { status: response.status });
  return response.json();
}
