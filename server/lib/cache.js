// 带 TTL 的 LRU 缓存 + single-flight（同一 key 的并发请求只打一次上游）。
// 用于 Google 地理数据：同城市、同地点在不同请求之间大量重复，缓存能显著降低
// 延迟和费用。Google Maps Platform 条款允许临时缓存坐标（不超过 30 天），
// 默认 TTL 远低于该上限。

export class TtlCache {
  constructor({ max = 1000, ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  getEntry(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // 访问后移动到队尾，实现 LRU。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  get(key) {
    return this.getEntry(key)?.value;
  }

  has(key) {
    return this.getEntry(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * 命中直接返回；未命中时执行 producer 并缓存成功结果。失败不缓存，
   * 下次请求会重新尝试。
   */
  async wrap(key, producer, { ttlMs = this.ttlMs } = {}) {
    const entry = this.getEntry(key);
    if (entry) {
      this.hits++;
      return entry.value;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.hits++;
      return pending;
    }
    this.misses++;
    const promise = Promise.resolve()
      .then(producer)
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}
