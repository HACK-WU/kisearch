import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// ki 前端：独立 Vite 工程，构建产物 web/dist 由 ki mcp --http --web 静态服务。
// dev 模式下 /api 与 /mcp 代理到本机 ki mcp --http（7423），便于本地开发。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7423', changeOrigin: true },
      '/mcp': { target: 'http://127.0.0.1:7423', changeOrigin: true },
      '/healthz': { target: 'http://127.0.0.1:7423', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
