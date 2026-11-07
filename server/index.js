import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_TAG, createApp } from './app.js';
import { getConfig } from './config.js';
import { log } from './lib/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env') });

const config = getConfig();
const app = createApp({ config });

const server = app.listen(config.port, () => {
  const port = server.address().port;
  log.info('server.start', {
    port,
    build: BUILD_TAG,
    model: config.llm.model,
    llm_configured: Boolean(config.llm.apiKey),
    maps_configured: Boolean(config.google.apiKey),
  });
  if (!config.llm.apiKey) log.warn('config.missing', { key: 'DEEPSEEK_API_KEY' });
  if (!config.google.apiKey) log.warn('config.missing', { key: 'GOOGLE_MAPS_API_KEY' });
  if (config.isProduction && !process.env.GOOGLE_MAPS_BROWSER_KEY) {
    log.warn('config.browser_key_shared', { hint: '生产环境请配置独立的 GOOGLE_MAPS_BROWSER_KEY 并限制 HTTP Referrer' });
  }
  if (!config.isProduction) console.log(`\n  AItour API  → http://localhost:${port}/api/health\n`);
});

// 高于常见负载均衡器的空闲超时（如 AWS ALB 60s），避免偶发 502。
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal });
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('process.unhandled_rejection', { message: reason?.message || String(reason), stack: reason?.stack });
});
