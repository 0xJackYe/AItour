const API_BASE = '/api';
const NETWORK_ERROR_MESSAGE = '无法连接到后端服务，请确认本地服务正在运行后重试';

async function request(path, options) {
  try {
    return await fetch(`${API_BASE}${path}`, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error?.name === 'TypeError') {
      const networkError = new Error(NETWORK_ERROR_MESSAGE);
      networkError.code = 'NETWORK_UNREACHABLE';
      networkError.cause = error;
      throw networkError;
    }
    throw error;
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const disconnected = response.status >= 500 && !payload;
    const message = disconnected
      ? NETWORK_ERROR_MESSAGE
      : payload?.error?.message || payload?.error || `请求失败: ${response.status}`;
    const error = new Error(message);
    error.code = disconnected
      ? 'NETWORK_UNREACHABLE'
      : payload?.error?.code || payload?.code || 'REQUEST_FAILED';
    throw error;
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('服务器返回了无法识别的响应');
  }
  return payload;
}

export async function generatePlan({ query, profile }, { signal } = {}) {
  const response = await request('/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, profile }),
    signal,
  });
  return readJson(response);
}

export async function recalculatePlan({ plan, profile }, { signal } = {}) {
  const response = await request('/plan/recalculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, profile }),
    signal,
  });
  return readJson(response);
}

export async function checkHealth() {
  const response = await request('/health');
  if (!response.ok) throw new Error('后端服务不可用');
  return response.json();
}
