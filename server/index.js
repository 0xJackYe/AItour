import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import planRouter from './routes/plan.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api', planRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const BUILD_TAG = 'v4-long-trip-and-location-validation-2026-07-15';

app.listen(PORT, () => {
  console.log('================================================');
  console.log(`[AItour Server] 运行在 http://localhost:${PORT}`);
  console.log(`[AItour Server] Build: ${BUILD_TAG}`);
  console.log(`[AItour Server] DeepSeek API Key: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置!'}`);
  console.log(`[AItour Server] Google Maps API Key: ${process.env.GOOGLE_MAPS_API_KEY ? '已配置' : '未配置!'}`);
  console.log('特性: 长行程分段生成 + Google 行政区消歧 + Places + Routes + LLM 自审');
  console.log('================================================');
});
