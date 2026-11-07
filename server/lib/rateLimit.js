// 固定窗口限流（按客户端 IP）。每次规划会消耗大模型与地图额度，
// 公网部署必须有基础限流。单实例内存实现；多实例部署应换成 Redis 等共享存储。

import { AppError } from './errors.js';

export function createRateLimiter({ max, windowMs, keyFn = req => req.ip || 'unknown', now = () => Date.now() }) {
  const hits = new Map();
  let lastSweep = now();

  return function rateLimit(req, res, next) {
    if (!max) {
      next();
      return;
    }
    const time = now();
    if (time - lastSweep > windowMs) {
      for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
      lastSweep = time;
    }
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    const resetSeconds = Math.ceil((entry.resetAt - time) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      next(new AppError('RATE_LIMITED', '请求过于频繁', { status: 429, retryAfterMs: resetSeconds * 1000 }));
      return;
    }
    next();
  };
}
