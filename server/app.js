import express from 'express';
import cors from 'cors';
import planRouter from './routes/plan.js';
import {
  configuredOrigins,
  createPlanningRateLimiter,
  isCorsOriginAllowed,
} from './services/httpSecurity.js';

export const BUILD_TAG = 'v6-cloudflare-fullstack-2026-11-07';

export function createApp() {
  const app = express();
  const allowedOrigins = configuredOrigins(process.env.CORS_ORIGINS);

  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use(cors({
    origin(origin, callback) {
      callback(null, isCorsOriginAllowed(origin, { allowedOrigins }));
    },
  }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/plan', createPlanningRateLimiter());
  app.use('/api', planRouter);

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      build: BUILD_TAG,
      runtime: typeof WebSocketPair === 'function' ? 'cloudflare-workers' : 'node',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
