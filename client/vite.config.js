import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Google Maps 浏览器 Key 不再在构建时写入前端产物，而是运行时由后端
// /api/config 下发：同一份构建可以部署到任意环境，也便于轮换 Key。
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
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
});
