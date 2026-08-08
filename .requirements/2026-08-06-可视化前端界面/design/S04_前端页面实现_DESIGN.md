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

# S-04：前端 5 页面实现（MCP SDK + 页面）

## 术语

| 术语 | 定义 |
|------|------|
| MCP client | `StreamableHTTPClientTransport` + `Client`（SDK ^1.29.0，C-03 已确认浏览器可行） |
| scope 上下文 | 全局选中的 scope，跨页面共享（React Context + localStorage 持久化） |
| 原文 | `ki_get_module_info` / `ki_search.original` 返回的 Markdown |

## 现状（AS-IS）

- demo 5 页（原生 HTML + mock）：`demo/index.html`/`browse.html`/`search.html`/`import.html`/`write.html`
- MCP 工具可用（mcp-server.ts:46-55）：`ki_search`/`ki_get_module_info`/`ki_sync_relation`/`ki_store`/`ki_scope_list`/`ki_tag_list`/`ki_query_group`
- `ki_search` 返回 JSON `SearchHit`（search.ts:34，含 `group`/`original`/`relation`/`score`/`tags`）
- 无前端工程（S-01 新建 `web/`）

## 方案（TO-BE）

### 1. MCP client 封装（`web/src/api/mcpClient.ts`）

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('/mcp', location.origin));
const client = new Client({ name: 'ki-web', version: '1.0.0' });
await client.connect(transport);

export async function callTool(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : text;
}
```

- 同源（`location.origin`）→ 无 CORS（S-01）
- 会话管理：30 分钟空闲回收 → 请求失败时重新 `connect()`（指数退避）
- **会话失效用户反馈（评审修复）**：重连期间显示"重新连接中…"横幅；重连失败给"请检查 `ki mcp --http --web` 服务"提示（不静默白屏）

### 2. `/api/*` 封装（`web/src/api/httpApi.ts`）

```ts
export const httpApi = {
  health: () => fetch('/api/health').then(r => r.json()),
  docList: (scope: string, q?: string) =>
    fetch(`/api/doc/list?scope=${encodeURIComponent(scope)}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(r => r.json()),
  importUpload: (body) => fetch('/api/import/upload', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r => r.json()),
  importRun: (body) => fetch('/api/import/run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r => r.json()),
  importStatus: (jobId) => fetch(`/api/import/status?jobId=${encodeURIComponent(jobId)}`).then(r => r.json()),
};
```

### 3. 页面实现（`web/src/pages/`）

| 页面 | 数据源 | 关键交互 | 对应 demo |
|------|--------|----------|-----------|
| `Dashboard.tsx` | `ki_scope_list` + `/api/health` | scope 卡片（名称/两层状态/统计）+ 健康状态 + 服务未就绪横幅 | index.html |
| `Browse.tsx` | `/api/doc/list` | Group 分组文档列表 + 文件名模糊搜索 + 点击看原文（`ki_get_module_info`） | browse.html（去 tag 过滤） |
| `Search.tsx` | `ki_search`（include_original: true） | 结果列表（原文摘要/得分/Group 路径/tags）+ threshold/tags 过滤 + 点击看原文 | search.html（去 isFullText） |
| `Import.tsx` | `/api/import/*` | scope 必选（default 兜底）+ 单文件/本地目录上传 + 切分参数（**默认折叠为"高级选项"**，多数用户用默认值）+ 进度轮询 + 结果 | import.html |
| `Write.tsx` | `ki_store`/`ki_sync_relation` | scope 必选 + 单条文本/关系写入 + 表单校验 + 成功反馈 | write.html（去批量） |

**scope 上下文**：`ScopeContext`（React Context），所有页面读取；`ScopeSelect` 组件展示当前 scope + 下拉切换；localStorage 持久化。

**服务状态检测**：`useServiceHealth` hook，页面加载检测 `/healthz`（**仅加载时查一次 + 手动刷新按钮**，不自动高频轮询，避免频繁触发 `runHealthCheck` zvec 探活），未就绪显示横幅 + `ki mcp --http --web` 手动指引（**无启动按钮**，v3）。

**文件名搜索防抖（challenger 质疑修复）**：浏览页文件名搜索框输入 **300ms 防抖**后再调 `/api/doc/list`，避免每次按键全量请求。

### 4. 页面路由（`web/src/App.tsx`）

- 轻量路由（无 react-router 依赖，或引入）：`/`（总览）、`/browse`、`/search`、`/import`、`/write`
- 侧边栏导航：总览/知识库浏览/语义搜索/上传导入/知识写入 + 集成区（向量可视化外链 7861）

## 关键决策点

| 决策 | 选择 | 被否决方案 | 否决理由 |
|------|------|-----------|----------|
| MCP 通信 | SDK `StreamableHTTPClientTransport` 直连 | 手写 JSON-RPC / Node 代理 | C-03 已确认浏览器可行；类型安全 |
| 浏览页数据源 | `/api/doc/list` | `ki_query_group` 文本解析 | 结构化 + 文件名搜索（v4）；避免解析脆弱 |
| 语义搜索原文 | `ki_search include_original:true` | 点击后二次调 `ki_get_module_info` | F04 要求结果直接展示原文 + Group 路径 |
| scope 持久化 | localStorage + Context | 仅 URL 参数 | 跨页面共享一致 |
| 路由 | 原生 hash 路由 | react-router | 页面少，避免额外依赖 |

## 影响范围

| 文件 | 改动 |
|------|------|
| `web/src/api/mcpClient.ts` | 新增 MCP client 封装 |
| `web/src/api/httpApi.ts` | 新增 /api/* 封装 |
| `web/src/pages/*.tsx` | 新增 5 页面 |
| `web/src/App.tsx`/`main.tsx` | 新增路由 + 布局 |
| `web/src/components/` | 新增 ScopeSelect/Sidebar/HealthBanner 等 |
| demo HTML | 保留作参考（正式实现以 web/ 为准） |

## 待定问题

| 问题 | 说明 | 状态 |
|------|------|------|
| demo 是否并入 web/ | 作为视觉参考保留 | 保留 demo/ 目录 |

## 变更记录

- 2026-08-08 v1：初版
