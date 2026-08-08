---
id: REQ-20260806-003
feature: 可视化前端界面
status: 设计中
created: 2026-08-08
updated: 2026-08-08
tags: [feat, ux, probe]
author: AI
document_type: reference
---

# 调研：前端直接调用 MCP 可行性验证（C-03）

> 调研时间：2026-08-08
> 调研对象：`@modelcontextprotocol/sdk` 浏览器端可用性 + `ki mcp --http` 调用可行性
> 决策关联：C-03（MCP SDK 浏览器端可用性）、REQ-F01（前端通信底座）

## 结论

**前端直接调用 MCP 可行，且建议直接采用**。基于源码实证 + SDK 依赖分析，拆为 4 个维度判定：

| 维度 | 判定 | 证据 |
|------|:----:|------|
| SDK 浏览器可用性 | ✅ 可行 | `StreamableHTTPClientTransport` 仅依赖 `fetch`/`Headers`/`ReadableStream`（Web 标准 API），无 Node 特有依赖 |
| CORS | ✅ 同源规避 | `--web` 静态页面与 `/mcp` 同源 → 天然无 CORS 问题（见下方分析） |
| 返回数据消费 | ✅ 直接可用 | `ki_search` 返回 JSON `SearchHit`，含 `group`/`original`/`relation` |
| `ki_query_group` 文本 | ⚠️ 已规避 | 浏览页 Group 改由 `/api/doc/list`（v4）提供，不再文本解析 |

## 1. SDK 浏览器可用性：✅ 可行

**源码实证**（`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js`）：

- 依赖 `eventsource-parser/stream` + `createFetchWithInit`
- `createFetchWithInit` 默认 `baseFetch = fetch`，只用 `Headers` / `Object.fromEntries`——**纯 Web 标准 API，无 Node 特有依赖**
- `eventsource-parser/stream` 提供 ESM/CJS 双格式，基于 `ReadableStream`（浏览器原生）
- 官方 GitHub 无浏览器兼容性阻塞 Issue

**判定**：SDK 客户端（`StreamableHTTPClientTransport`）可在浏览器直接运行，无需本地代理/封装。

## 2. CORS：✅ 同源规避（关键前提）

**源码实证**：`src/lib/mcp-http.ts` `handleRequest` **无任何 CORS 响应头**（无 `Access-Control-Allow-Origin`）。若前端页面与 `/mcp` 跨源，浏览器会拦截。

**规避方案**：用户决策④"前端由 `ki mcp --http --web` 一并提供静态页面" → 前端页面与 `/mcp` **同源**（同一端口复用根路由 `/`）→ 浏览器 **same-origin 请求天然无 CORS 问题**。

> 这是方案 A + `--web` 组合的最大红利：**不额外处理 CORS，MCP SDK 可直接用**。

## 3. 返回数据可直接消费：✅ 可行

**源码实证**：`src/search.ts` `SearchHit` 接口（search.ts:34）含：
- `group`：所属 Group 路径 → 满足 F04"展示命中 Group 路径"
- `original`：原文内容 + `originalRetrieved` → 满足 F04"返回原文内容"
- `relation`、`score`、`tags` → 完整定位字段

前端经 SDK `callTool` 拿到的 `content[0].text` 为 JSON 字符串，`JSON.parse` 即可用。

## 4. `ki_query_group` 文本格式：⚠️ 已规避

`ki_query_group` 返回 `result.output`（文本格式，`src/query-group.ts`）。浏览页 Group 树改由 `/api/doc/list`（v4 决策：返回 Group 路径 + 文档）提供，**不再依赖文本解析**；搜索页用 `ki_search`（JSON）。

> 若未来有页面需用 `ki_query_group`，前端需文本解析（脆弱），当前设计已规避。

## 技术设计建议

| 项 | 建议 |
|----|------|
| 前端通信底座 | 直接用 MCP SDK `StreamableHTTPClientTransport`，前端 bundle 引入 |
| 静态页面 | 复用 7423 加 `/` 根路由（与 `/mcp` 同源）→ 无需 CORS 处理 |
| `/api/*` 接口 | 走方案 A 路由（导入/健康/doc-list），不依赖 MCP 工具 |
| 会话管理 | 前端处理 30 分钟空闲回收 → 会话重建（SDK 已支持） |

## 变更记录

- 2026-08-08：完成 C-03 调研，结论"前端直连 MCP 可行"，关闭推演问题 #3（需实测项）
