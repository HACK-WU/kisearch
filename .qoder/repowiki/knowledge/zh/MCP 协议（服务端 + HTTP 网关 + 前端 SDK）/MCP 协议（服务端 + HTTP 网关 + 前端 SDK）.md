---
kind: external_dependency
name: MCP 协议（服务端 + HTTP 网关 + 前端 SDK）
slug: mcp
category: external_dependency
category_hints:
    - framework_behavior
    - auth_protocol
scope:
    - '**'
source_files:
    - src/mcp-server.ts
    - src/lib/mcp-http.ts
    - web/src/api/mcpClient.ts
---

### MCP 在 ki 中的三层用法
- 服务端：`src/mcp-server.ts` 暴露标准 MCP tools（如 `ki_scope_list`、`ki_search`），供 IDE / CLI stdio 客户端调用。
- HTTP 网关：`src/lib/mcp-http.ts` 将 `/mcp` POST 请求体中的 `tools/call` 转发给 MCP SDK，同时把首个工具名注入 AsyncLocalStorage，使下游 `probeWithRetry` 日志带来源标注（如 `[mcp:ki_scope_list]`）。
- 前端：`web/src/api/mcpClient.ts` 通过 `@modelcontextprotocol/sdk` 的 fetch transport 直接调 `/mcp`，消费 `kiScopeList` 等工具。
- 行为约定：`--http --web` 启动时同时提供 `/mcp` 接口和静态前端页面（`web/dist`），升级代码后需 `ki mcp restart` 才能生效（长驻进程不热加载）。