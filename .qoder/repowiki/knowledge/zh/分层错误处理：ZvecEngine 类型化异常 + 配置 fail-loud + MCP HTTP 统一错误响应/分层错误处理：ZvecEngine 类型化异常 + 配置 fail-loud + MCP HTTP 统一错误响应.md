---
kind: error_handling
name: 分层错误处理：ZvecEngine 类型化异常 + 配置 fail-loud + MCP HTTP 统一错误响应
category: error_handling
scope:
    - '**'
source_files:
    - src/zvec-engine/errors.ts
    - docs/error-handling.md
    - src/lib/config-schema.ts
    - src/lib/mcp-http.ts
    - bin/ki.mjs
    - test/error-handling.test.ts
---

## 1. 整体方案

本仓库采用**分层错误处理**策略，不同层级使用不同的错误模型与传播方式：

- **ZvecEngine（向量引擎）**：定义 `ZvecEngineError` 基类及一系列领域异常子类，通过 `ERROR_CONSTRUCTORS` 映射表支持跨 Worker 进程反序列化重建。
- **CLI / lib 层**：大量使用原生 `throw new Error(...)` 配合 `try/catch` 包裹业务块，在命令入口统一输出 JSON `{ ok, error }` 或退出码。
- **MCP HTTP 服务**：所有请求走统一的 `handleRequest` 顶层 `catch`，返回标准 JSON-RPC 错误体（`code -32603/-32001/-32002` 等）；鉴权/越权/会话数超限等安全路径集中拦截。
- **配置文件**：`config-schema.ts` 实现 schema 驱动的字段级校验，区分 `errors`（阻断加载）与 `warns`（仅告警），失败时一次性报告全部问题。

## 2. 关键文件与包

| 文件 | 职责 |
|---|---|
| `src/zvec-engine/errors.ts` | ZvecEngine 领域异常体系（`DimensionMismatchError`、`CollectionNotFoundError`、`WorkerCrashedError` 等）+ `ERROR_CONSTRUCTORS` 反序列化映射 |
| `docs/error-handling.md` | 面向用户的错误分类、恢复建议与排障顺序 |
| `src/lib/config-schema.ts` | 配置 YAML/JSON 的 schema 驱动校验，收集 `ConfigIssue[]` |
| `src/lib/mcp-http.ts` | MCP HTTP 传输层：鉴权、scope 越权拦截、会话管理、统一 JSON-RPC 错误响应、优雅退出 |
| `bin/ki.mjs` | CLI 入口：子进程转发、信号透传、daemon 启动期存活探测 |
| `test/error-handling.test.ts` | 覆盖参数校验、Group 树、Relations、KB、导入等异常场景 |

## 3. 架构与设计决策

### 3.1 ZvecEngine 类型化异常
- 所有引擎异常继承 `ZvecEngineError`，携带 `code`、`data`、`cause`。
- 通过 `ERROR_CONSTRUCTORS` 字典将异常名称→构造器注册，供 worker-protocol 的 `deserializeError` 跨线程重建异常实例，保证 `instanceof` 在 Worker 边界有效。
- 异常按领域分组：Schema/配置、集合生命周期、Embedding、Worker 通信、关闭超时。

### 3.2 配置 fail-loud 策略
- `validateConfigFields` 遍历解析后的原始配置对象，对未知字段名、类型不符、非法枚举值、非法取值（端口范围、正整数、URL 前缀）收集为 `errors`，直接阻断加载。
- 已知废弃字段（如 scope 级 `sourceDir`）走 `warns` 通道，不破坏存量配置。
- 未知字段提示附带 Levenshtein 编辑距离相近字段建议（如 `datDir` → `dataDir`）。
- 空字符串、null 条目等“静默错配”场景降级为显式告警而非静默吞掉。

### 3.3 MCP HTTP 统一错误响应
- 所有 `/mcp` 请求经 `handleRequest` 顶层 `.catch`，未发送响应头时回 `500` + JSON-RPC `-32603 Internal error`。
- 鉴权失败：非回环绑定且无有效 Bearer Token → `401` + `-32001 Unauthorized`；scope 越权 → `403` + `-32002 Forbidden`。
- 会话保护：超过 `DEFAULT_MAX_SESSIONS`（256）→ `503` + `-32000 Too many active sessions`。
- 监听错误通过 `describeListenError` 翻译为可读提示（EADDRINUSE/EACCES/EADDRNOTAVAIL/ENOTFOUND）。
- 鉴权失败次数写入 `/healthz` 的 `authFailures` 字段，stderr 限流日志（5s 间隔防重试风暴刷屏）。

### 3.4 CLI 错误传播
- `bin/ki.mjs` 通过 `spawn('npx', ['jiti', ...])` 执行各子命令脚本，父进程只负责信号转发（SIGINT/SIGTERM）和 exit code 透传。
- daemon 模式有 3s 存活探测窗口：子进程在预检阶段退出会暴露真实失败，避免假成功。
- 子命令内部普遍以 `try/catch` 捕获业务错误，输出 JSON `{ ok: false, error: '...' }` 并 `process.exit(1)`。

## 4. 约定与约束

- **ZvecEngine 异常必须继承 `ZvecEngineError`**：新增异常需在 `ERROR_CONSTRUCTORS` 中注册，否则跨 Worker 反序列化会失败。（来源：`src/zvec-engine/errors.ts` 注释与映射表）
- **配置校验分 errors/warns 两级**：`errors` 阻断加载，`warns` 仅记录；新增字段校验应明确归属哪一级。（来源：`src/lib/config-schema.ts` 文档注释与 `validateConfigFields` 实现）
- **MCP 安全路径集中拦截**：鉴权、scope 越权、会话数上限均在 `mcp-http.ts` 内统一处理，禁止下沉到工具层绕过。（来源：`findScopeViolation` + 注释“安全关键路径”）
- **HTTP 错误统一 JSON-RPC 格式**：所有 `/mcp` 错误响应包含 `jsonrpc`、`error.code`、`error.message`、`id`。（来源：`sendJson` 调用点）
- **用户文档与实现对齐**：`docs/error-handling.md` 汇总常见报错、恢复方式与排障顺序，作为对外契约。（来源：文档标题“本文档汇总 ki 当前实现中的常见报错、警告与恢复方式”）
- **测试覆盖异常矩阵**：`test/error-handling.test.ts` 断言各类非法输入返回 `{ ok: false }` 且 `error` 包含预期关键字。（来源：测试用例）
