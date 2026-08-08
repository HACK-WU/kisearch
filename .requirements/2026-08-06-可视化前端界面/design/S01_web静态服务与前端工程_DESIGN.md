---
id: REQ-20260806-003
feature: 可视化前端界面
status: 设计中
created: 2026-08-08
updated: 2026-08-08
version: 1
tags: [feat, ux, design]
depends_on: [REQ-20260806-001]
author: AI
document_type: design
parent: design/DESIGN.md
---

# S-01：`--web` 静态页面服务 + 前端工程骨架

## 术语

| 术语 | 定义 |
|------|------|
| `--web` | `ki mcp --http` 新增参数，控制是否提供前端静态页面 |
| 前端静态目录 | `web/dist/`（Vite 构建产物） |
| 同源 | 前端页面与 `/mcp` 同一 host:port（7423），规避 CORS |

## 现状（AS-IS）

- `src/mcp-server.ts`：`parseMcpArgs`（mcp-server.ts:116）known 数组 `['--http','--host','--port','--token','--allowed-hosts','--status']`，无 `--web`
- `src/lib/mcp-http.ts`：`handleRequest`（mcp-http.ts:271）对 `pathname !== '/mcp'` 一律 404（mcp-http.ts:290），无 `/` 根路由、无静态文件服务
- 项目无前端工程（package.json 无 React/Vite 依赖）

## 方案（TO-BE）

### 1. `ki mcp --http --web` 参数

**改 `src/mcp-server.ts` `parseMcpArgs`**：
- `known` 数组加 `--web`
- `McpCliOptions` 加 `web: boolean`
- 解析 `const web = args.includes('--web')`
- 将 `web` 传入 `startHttpMcpServer`

### 2. mcp-http 服务前端静态页面

**改 `src/lib/mcp-http.ts` `createMcpHttpServer` 的 `HttpAppOptions`**：
- 加 `webDir?: string`（静态目录，默认 `web/dist`）
- `handleRequest` 路由分流（mcp-http.ts:271 改造）：

```
pathname 分流：
  /healthz        → 现有（免鉴权探活）
  /mcp            → 现有 MCP（POST/GET/DELETE）
  /api/*          → S-02/S-03 接口路由（新增分支）
  其他 GET 路径    → 静态文件服务（webDir；/ → index.html，含 SPA fallback）
```

- 静态服务实现：`fs.readFileSync(path.join(webDir, decodeURIComponent(pathname)))`，MIME 映射（html/js/css/svg/png），非 `/api` 非 `/mcp` 的 GET 404 返回 index.html（SPA fallback）
- **路由优先级（评审修复）**：`/api/*` 前缀先于静态服务判断——`/api/*` 未匹配到接口 → 返回 JSON 404（`{ok:false,error:'Not Found'}`），**不 fallback index.html**；仅非 `/api` 非 `/mcp` 的 GET 路径才 fallback（防止前端 JSON.parse 到 HTML 崩溃）
- 安全：`path.normalize` + 前缀校验防路径穿越；仅 GET 方法

### 3. 前端工程骨架

**新增 `web/` 目录**（Vite + React + TS）：

```
web/
├── index.html          # SPA 入口
├── package.json        # 前端依赖（vite/react/react-dom/@modelcontextprotocol/sdk）
├── tsconfig.json
├── vite.config.ts      # build.outDir = dist；base = '/'
└── src/
    ├── main.tsx        # React 入口
    ├── App.tsx         # 路由 + 布局
    ├── api/
    │   ├── mcpClient.ts   # MCP SDK StreamableHTTPClientTransport 封装
    │   └── httpApi.ts     # /api/* 封装（fetch）
    ├── pages/
    │   ├── Dashboard.tsx  # 总览
    │   ├── Browse.tsx     # 浏览
    │   ├── Search.tsx     # 搜索
    │   ├── Import.tsx     # 上传导入
    │   └── Write.tsx      # 写入
    └── components/        # 共享组件（ScopeSelect、Sidebar 等）
```

**构建产物**：`web/dist`（`vite build`），`ki mcp --http --web` 服务该目录。

**package.json 前端脚本**：
```json
{
  "name": "ki-web",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  }
}
```

## 关键决策点

| 决策 | 选择 | 被否决方案 | 否决理由 |
|------|------|-----------|----------|
| 静态页面宿主 | 复用 7423 加根路由 `/` | 另开 web 端口（如 7860） | 同源规避 CORS；不新增端口冲突面 |
| 前端框架 | Vite + React | 纯原生 HTML（demo 形态） | 多页面状态共享（scope 上下文）、组件复用、SDK 集成需要工程化 |
| 静态服务实现 | mcp-http 内 `fs.readFileSync` | 引入 express/静态中间件 | 保持零新增依赖，node:http 内建 |

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/mcp-server.ts` | `parseMcpArgs` 加 `--web`；`McpCliOptions` 加 `web`；传给 `startHttpMcpServer` |
| `src/lib/mcp-http.ts` | `HttpAppOptions` 加 `webDir`；`handleRequest` 加路由分流 + 静态服务 |
| `web/**`（新增） | 前端工程骨架 |

## 待定问题

| 问题 | 说明 | 状态 |
|------|------|------|
| `web/dist` 是否入库 | 需决策（便于零构建部署 vs 体积） | 技术评审确认 |

## 变更记录

- 2026-08-08 v1：初版
