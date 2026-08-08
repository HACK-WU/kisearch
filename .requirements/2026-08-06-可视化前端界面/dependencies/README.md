# 第三方依赖文档索引（可视化前端界面）

## 依赖总览

| 依赖名称 | 类型 | 用途 | 地址 | 详情文档 | 信息完整度 |
|----------|------|------|------|----------|-----------|
| zvec-studio（应用 + REST API） | 外部服务 + API | 向量数据可视化：集合/文档/向量检索浏览；前端超链接**占位跳转**（v3：前端不启动，打开 ki 向量库后续实现） | 启动后 `http://127.0.0.1:7861`（API base `/api/v1`） | [详情](./zvec-studio.md) | ✅ 完整 |
| ki MCP HTTP 服务 | 内部服务（集成对象） | 前端后端底座：经 MCP 协议调用 ki 的 11 个工具 | `ki mcp --http` → `http://127.0.0.1:7423/mcp` | [详情](./ki-mcp-http.md) | ✅ 完整 |
| MCP 协议 / TypeScript SDK | 第三方 SDK | 前端与 `ki mcp --http` 通信的协议客户端 | npm `@modelcontextprotocol/sdk`（^1.29.0），文档 https://modelcontextprotocol.io | [详情](./mcp-sdk.md) | ✅ 完整 |

## 使用说明

- 每个依赖的详细信息见独立文档（含完整地址）
- 设计时按需查阅相关依赖文档：
  - 前端跳转/向量可视化 → `zvec-studio.md`
  - 前端后端通信 → `ki-mcp-http.md` + `mcp-sdk.md`
- 三个依赖的地址汇总：

| 服务 | 启动方式 | 访问地址 |
|------|----------|----------|
| ki 前端（本项目） | `ki mcp --http --web`（v3：由 MCP HTTP 一并提供静态页面） | 待定（web 端口，技术设计定） |
| ki MCP HTTP | `ki mcp --http` | `http://127.0.0.1:7423/mcp` |
| zvec-studio | `zvec-studio --port 7861` | `http://127.0.0.1:7861`（Swagger `/docs`） |
