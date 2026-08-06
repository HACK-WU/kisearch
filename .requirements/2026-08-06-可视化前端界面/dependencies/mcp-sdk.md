# MCP 协议 / TypeScript SDK

## 基本信息

| 字段 | 内容 |
|------|------|
| 类型 | 第三方 SDK（协议客户端） |
| npm 包 | `@modelcontextprotocol/sdk` |
| 项目当前版本 | `^1.29.0`（ki 项目 package.json） |
| 官方文档 | https://modelcontextprotocol.io |
| 用途 | 前端与 `ki mcp --http`（127.0.0.1:7423）通信的协议客户端：初始化会话、调用 `ki_*` 工具、接收结果 |
| 传输方式 | Streamable HTTP（`StreamableHTTPServerTransport` 对应客户端），与 ki 的 HTTP 模式匹配 |

## 关键接口

| 接口/方法 | 用途 | 说明 |
|-----------|------|------|
| `Client` + `StdioClientTransport` | stdio 传输 | 本需求不用（前端走 HTTP） |
| `Client` + `StreamableHTTPClientTransport` | HTTP 传输 | 连接 `http://127.0.0.1:7423/mcp` |
| `client.connect()` | 建立会话 | 发送 `initialize`，携带 `mcp-session-id` |
| `client.tool(name, args)` / `client.listTools()` | 调用/列出工具 | 调用 `ki_search` 等 11 个工具 |
| `client.callTool()` | 调用工具 | 低层 API |

> 具体 API 以官方文档 / 包内类型为准（`^1.29.0` 为 ki 后端使用版本，前端客户端版本应与之兼容）。

## 认证与配置

- 回环免鉴权（默认）：直接连 `http://127.0.0.1:7423/mcp` 即可
- 非回环：请求头 `Authorization: Bearer <token>`（ki 侧强制）
- 会话需 `initialize` 建立，响应头 `mcp-session-id` 需回传

## 限流与配额

- 由 ki 服务端控制：会话上限 256、空闲 30 分钟回收（见 `ki-mcp-http.md`）

## 备选方案

| 方案 | 说明 | 对比 |
|------|------|------|
| MCP SDK（推荐） | 官方协议客户端，类型安全、自动处理会话/SSE | 与 ki 服务端版本兼容，维护成本低 |
| 手写 JSON-RPC | 直接 POST `/mcp` 构造协议消息 | 需自行处理 initialize/会话/SSE，易出错 |
| ki 新增 REST 层 | 为前端单独实现 REST API | 工作量大，违背"复用 MCP HTTP"的既定架构 |

## 风险与注意事项

- 前端 SDK 版本需与 ki 服务端（`^1.29.0`）的协议兼容
- 浏览器端调用 MCP HTTP 需确认 SDK 是否支持浏览器环境（Node 客户端为主）；若仅支持 Node，前端需经本地代理/同源封装转发（技术设计阶段验证，见 REQ-F01）
- 会话生命周期管理：前端需处理会话超时重建（30 分钟空闲回收）
