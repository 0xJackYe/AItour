import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createApp, BUILD_TAG } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const app = createApp();
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('================================================');
  console.log(`[AItour Server] 运行在 http://localhost:${PORT}`);
  console.log(`[AItour Server] Build: ${BUILD_TAG}`);
  console.log(`[AItour Server] DeepSeek API Key: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置!'}`);
  console.log(`[AItour Server] Google Maps API Key: ${process.env.GOOGLE_MAPS_API_KEY ? '已配置' : '未配置!'}`);
  console.log('特性: 结构化偏好 + 连续时间轴 + 逐段交通 + 跨日连接 + 确定性健康检查');
  console.log('================================================');
});
