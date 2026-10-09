import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// ki 前端：独立 Vite 工程，构建产物 web/dist 由 ki mcp --http --web 静态服务。
// dev 模式下 /api 与 /mcp 代理到本机 ki mcp --http，便于本地开发。
// 当前指向 7433（本工作区代码 + 隔离 vectorDir 的开发实例，见 AGENTS.md「开发模式启动方式」）；
// 生产/默认实例为 7423。
const API_TARGET = 'http://127.0.0.1:7433';
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
      '/api': { target: API_TARGET, changeOrigin: true },
      '/mcp': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
