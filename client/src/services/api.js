const API_BASE = '/api';

async function readJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `请求失败: ${response.status}`;
    const error = new Error(message);
    error.code = payload?.error?.code || payload?.code || 'REQUEST_FAILED';
    throw error;
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('服务器返回了无法识别的响应');
  }
  return payload;
}

export async function generatePlan({ query, profile }, { signal } = {}) {
  const response = await fetch(`${API_BASE}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, profile }),
    signal,
  });
  return readJson(response);
}

export async function recalculatePlan({ plan, profile }, { signal } = {}) {
  const response = await fetch(`${API_BASE}/plan/recalculate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, profile }),
    signal,
  });
  return readJson(response);
}

export async function checkHealth() {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error('后端服务不可用');
  return response.json();
}
