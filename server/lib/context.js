// 请求上下文（AsyncLocalStorage）：在整条异步调用链中传递 requestId、
// 取消信号和用量统计，避免把这些参数层层透传到每个函数。

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

export function currentContext() {
  return storage.getStore() || null;
}

export function currentSignal() {
  return storage.getStore()?.signal || null;
}

export function recordStat(name, amount = 1) {
  const stats = storage.getStore()?.stats;
  if (!stats || !Number.isFinite(amount)) return;
  stats[name] = (stats[name] || 0) + amount;
}
