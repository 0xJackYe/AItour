import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import planRouter from './routes/plan.js';
import {
  configuredOrigins,
  createPlanningRateLimiter,
  isCorsOriginAllowed,
} from './services/httpSecurity.js';

const app = express();
const PORT = process.env.PORT || 3001;
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const BUILD_TAG = 'v5-executable-trip-graph-2026-08-01';

app.listen(PORT, () => {
  console.log('================================================');
  console.log(`[AItour Server] 运行在 http://localhost:${PORT}`);
  console.log(`[AItour Server] Build: ${BUILD_TAG}`);
  console.log(`[AItour Server] DeepSeek API Key: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置!'}`);
  console.log(`[AItour Server] Google Maps API Key: ${process.env.GOOGLE_MAPS_API_KEY ? '已配置' : '未配置!'}`);
  console.log('特性: 结构化偏好 + 连续时间轴 + 逐段交通 + 跨日连接 + 确定性健康检查');
  console.log('================================================');
});
