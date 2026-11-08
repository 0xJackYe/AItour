// 集中式配置：所有环境变量在这里解析并给出安全默认值。
// 每次调用实时读取 process.env，便于测试中覆盖。

function intValue(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseInt(env[name], 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function listValue(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function getConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  return {
    isProduction,
    port: intValue(env, 'PORT', 3001, { min: 0, max: 65535 }),
    llm: {
      apiKey: env.DEEPSEEK_API_KEY || '',
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      // 单次调用总时长上限；空闲超时用于识别“连接还在但上游卡死”。
      timeoutMs: intValue(env, 'LLM_TIMEOUT_MS', 240000, { min: 1000 }),
      idleTimeoutMs: intValue(env, 'LLM_IDLE_TIMEOUT_MS', 90000, { min: 1000 }),
      maxRetries: intValue(env, 'LLM_MAX_RETRIES', 2, { min: 0, max: 5 }),
      stream: env.LLM_STREAM !== 'false',
    },
    google: {
      apiKey: env.GOOGLE_MAPS_API_KEY || '',
      // 生产环境绝不把服务端 Key 下发给浏览器；本地开发才允许共用。
      browserKey: env.GOOGLE_MAPS_BROWSER_KEY || (!isProduction ? env.GOOGLE_MAPS_API_KEY || '' : ''),
      mapId: env.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
      timeoutMs: intValue(env, 'GOOGLE_TIMEOUT_MS', 15000, { min: 1000 }),
      maxConcurrency: intValue(env, 'GOOGLE_MAX_CONCURRENCY', 8, { min: 1, max: 64 }),
      cacheTtlMs: intValue(env, 'GOOGLE_CACHE_TTL_MS', 12 * 60 * 60 * 1000, { min: 0 }),
      cacheMaxEntries: intValue(env, 'GOOGLE_CACHE_MAX_ENTRIES', 5000, { min: 0 }),
    },
    plan: {
      maxQueryLength: intValue(env, 'MAX_QUERY_LENGTH', 1000, { min: 20 }),
      maxTripDays: intValue(env, 'MAX_TRIP_DAYS', 30, { min: 1, max: 90 }),
      timeoutMs: intValue(env, 'PLAN_TIMEOUT_MS', 480000, { min: 10000 }),
      maxConcurrent: intValue(env, 'PLAN_MAX_CONCURRENT', 8, { min: 1 }),
      rateLimitMax: intValue(env, 'PLAN_RATE_LIMIT', 20, { min: 0 }),
      rateLimitWindowMs: intValue(env, 'PLAN_RATE_WINDOW_MS', 10 * 60 * 1000, { min: 1000 }),
    },
    http: {
      allowedOrigins: listValue(env.ALLOWED_ORIGINS),
      trustProxy: env.TRUST_PROXY || '',
      serveClient: env.SERVE_CLIENT !== 'false',
    },
  };
}
