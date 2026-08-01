import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const rootEnvDir = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootEnvDir, '');
  return {
    plugins: [react()],
    define: {
      // 浏览器 Key 必须单独配置并设置 HTTP referrer 限制，绝不回退到服务端 Key。
      'import.meta.env.VITE_GOOGLE_MAPS_API_KEY': JSON.stringify(
        env.VITE_GOOGLE_MAPS_API_KEY || '',
      ),
      'import.meta.env.VITE_GOOGLE_MAP_ID': JSON.stringify(env.VITE_GOOGLE_MAP_ID || ''),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
