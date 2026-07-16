const API_BASE = '/api';

export async function generatePlan(query) {
  const response = await fetch(`${API_BASE}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '网络错误' }));
    throw new Error(err.error || `请求失败: ${response.status}`);
  }

  return response.json();
}

export async function checkHealth() {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error('后端服务不可用');
  return response.json();
}
