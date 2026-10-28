import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// ki 前端：独立 Vite 工程，构建产物 web/dist 由 ki mcp --http --web 静态服务。
// dev 模式下 /api 与 /mcp 代理到本机 ki mcp --http，便于本地开发。
// 默认 7433 = 「本工作区代码 + 隔离 vectorDir」的开发实例（见 AGENTS.md「开发模式启动方式」）；
// 默认常驻实例为 7423。若要临时指向真实实例，用环境变量覆盖，勿改默认值：
//   KI_API_TARGET=http://127.0.0.1:7423 npm run dev
const API_TARGET = process.env.KI_API_TARGET ?? 'http://127.0.0.1:7433';
/**
 * 同三条代理规则，dev（`npm run dev` :5173）与 preview（`npm run preview` :4173
 * 预览 dist 产物）**共用**：
 *
 * ★ preview 原先没有 proxy —— 页面能开，但 `/api`、`/mcp`、`/healthz` 全被静态服务
 *   当文件找（404 / 返回 index.html），等于「预览构建产物」时所有功能都不可用；
 *   侧栏页脚也会因为拿不到 `/healthz` 而回落到 4173（一个不存在的 MCP 端口）。
 */
const PROXY = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/mcp': { target: API_TARGET, changeOrigin: true },
  '/healthz': { target: API_TARGET, changeOrigin: true },
};
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
    proxy: PROXY,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: PROXY,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
