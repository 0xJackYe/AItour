function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function configuredOrigins(value = '') {
  return new Set(String(value).split(',').map(item => item.trim()).filter(Boolean));
}

export function isCorsOriginAllowed(origin, {
  allowedOrigins = configuredOrigins(process.env.CORS_ORIGINS),
  environment = process.env.NODE_ENV || 'development',
} = {}) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (environment === 'production') return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function createPlanningRateLimiter({
  windowMs = positiveInteger(process.env.PLAN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  max = positiveInteger(process.env.PLAN_RATE_LIMIT_MAX, 10),
  now = () => Date.now(),
} = {}) {
  const clients = new Map();
  return function planningRateLimiter(req, res, next) {
    const timestamp = now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const current = clients.get(key);
    const bucket = !current || current.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + windowMs }
      : current;
    bucket.count += 1;
    clients.set(key, bucket);

    if (clients.size > 5000) {
      for (const [client, value] of clients) {
        if (value.resetAt <= timestamp) clients.delete(client);
      }
    }

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000))));
      return res.status(429).json({
        error: '规划请求过于频繁，请稍后再试',
        code: 'PLAN_RATE_LIMITED',
      });
    }
    return next();
  };
}
