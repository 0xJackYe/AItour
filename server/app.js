// Express 应用工厂：与端口监听分离，便于集成测试直接创建实例。

import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { AppError, toPublicError } from './lib/errors.js';
import { log } from './lib/log.js';
import { createPlanRouter } from './routes/plan.js';
import { hasWorkersAI } from './services/workersAi.js';

// Cloudflare 的 Node HTTP 兼容层在 bundle 中不保证提供 import.meta.url。
// Worker 不直接托管静态文件，但仍需给应用工厂一个安全的默认目录。
const moduleUrl = import.meta.url;
const __dirname = typeof moduleUrl === 'string' && moduleUrl
  ? dirname(fileURLToPath(moduleUrl))
  : resolve(process.cwd(), 'server');
export const CLIENT_DIST = resolve(__dirname, '..', 'client', 'dist');
export const BUILD_TAG = 'v6-human-usable-cloudflare-2026-11-08';

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const hops = Number(value);
  return Number.isInteger(hops) ? hops : value;
}

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w.:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Google Maps 浏览器 Key 的 HTTP Referrer 限制依赖 Referer，不能设为 no-referrer。
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function corsOrigin(config) {
  if (config.http.allowedOrigins.length) return config.http.allowedOrigins;
  // 开发环境放开；生产环境默认只允许同源（由 Express 同时托管前端）。
  return !config.isProduction;
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }
  let appError = error;
  if (error?.type === 'entity.parse.failed') appError = new AppError('INVALID_INPUT', '请求体不是合法的 JSON', { status: 400 });
  else if (error?.type === 'entity.too.large') appError = new AppError('PAYLOAD_TOO_LARGE', '请求内容过大', { status: 413 });
  const publicError = toPublicError(appError);
  if (publicError.status >= 500 && publicError.code === 'INTERNAL') {
    log.error('http.error', { path: req.path, message: error?.message, stack: error?.stack });
  }
  res.status(publicError.status).json({
    error: publicError.message,
    code: publicError.code,
    retryable: publicError.retryable,
    request_id: req.requestId,
  });
}

export function createApp({ config = getConfig(), clientDist = CLIENT_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.http.trustProxy) app.set('trust proxy', parseTrustProxy(config.http.trustProxy));

  app.use(requestId);
  app.use(securityHeaders);
  app.use('/api', cors({ origin: corsOrigin(config), exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
  app.use('/api', express.json({ limit: '32kb' }));

  app.get('/api/health', (req, res) => {
    const current = getConfig();
    res.set('Cache-Control', 'no-store').json({
      status: 'ok',
      version: BUILD_TAG,
      uptime_s: Math.round(process.uptime()),
      llm_configured: Boolean(current.llm.apiKey) || hasWorkersAI(),
      llm_fallback_configured: hasWorkersAI(),
      maps_configured: Boolean(current.google.apiKey),
      timestamp: new Date().toISOString(),
    });
  });

  // 运行时下发浏览器配置：同一份前端构建产物可部署到任意环境。
  app.get('/api/config', (req, res) => {
    const current = getConfig();
    res.set('Cache-Control', 'no-store').json({
      maps: { browserKey: current.google.browserKey || null, mapId: current.google.mapId },
      limits: { maxQueryLength: current.plan.maxQueryLength, maxTripDays: current.plan.maxTripDays },
    });
  });

  app.use('/api', createPlanRouter(config));
  app.use('/api', (req, res, next) => next(new AppError('NOT_FOUND', '接口不存在', { status: 404 })));

  if (config.http.serveClient && existsSync(resolve(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${sep}assets${sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get('/{*splat}', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
