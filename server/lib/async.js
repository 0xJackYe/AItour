import { cancelledError } from './errors.js';

export function abortReason(signal) {
  const reason = signal?.reason;
  // 自定义原因（如 PLAN_TIMEOUT）原样保留；默认的 DOMException AbortError 统一为 CANCELLED。
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  return cancelledError();
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

/** 可被 AbortSignal 打断的 sleep，用于重试退避。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 指数退避 + 抖动重试。只有 shouldRetry 返回 true 的错误才会重试；
 * 上游给出 Retry-After 时取两者较大值。调用方取消时立即停止。
 */
export async function withRetry(fn, {
  retries = 2,
  baseDelayMs = 500,
  maxDelayMs = 8000,
  signal = null,
  shouldRetry = error => error?.retryable === true,
  onRetry = null,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jittered = exponential / 2 + Math.random() * (exponential / 2);
      const delay = Math.min(Math.max(jittered, error?.retryAfterMs || 0), maxDelayMs * 2);
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
    }
  }
}

/** 受控并发 map，结果顺序与输入一致。 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}

/** 全局并发闸门（semaphore），用于保护第三方 API 的 QPS 配额。 */
export function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  const limit = task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
  limit.stats = () => ({ active, queued: queue.length });
  return limit;
}

/**
 * 组合“调用方取消 + 总超时 + 空闲超时”的 AbortController。
 * touch() 在收到数据时调用，用来重置空闲计时（检测上游卡死而不是慢）。
 */
export function createDeadline({ parentSignal = null, timeoutMs = 0, idleTimeoutMs = 0, onTimeout, onIdle } = {}) {
  const controller = new AbortController();
  let timeoutTimer = null;
  let idleTimer = null;
  let reason = null;

  const abort = (kind, error) => {
    if (controller.signal.aborted) return;
    reason = kind;
    controller.abort(error);
  };
  const onParentAbort = () => abort('parent', abortReason(parentSignal));

  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => abort('timeout', onTimeout ? onTimeout() : new Error('timeout')), timeoutMs);
  }
  const touch = () => {
    if (!(idleTimeoutMs > 0) || controller.signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort('idle', onIdle ? onIdle() : new Error('idle timeout')), idleTimeoutMs);
  };
  touch();

  return {
    signal: controller.signal,
    touch,
    get reason() {
      return reason;
    },
    dispose() {
      clearTimeout(timeoutTimer);
      clearTimeout(idleTimer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** 解析 HTTP Retry-After（秒数或日期），返回毫秒。 */
export function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
