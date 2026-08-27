---
kind: logging_system
name: 基于 console/progress 的 CLI 输出与 stderr 进度日志系统
category: logging_system
scope:
    - '**'
source_files:
    - bin/ki.mjs
    - src/lib/progress.ts
    - src/lib/import.ts
    - src/lib/batch-vectorize.ts
    - src/lib/cli-args.ts
    - src/lib/mcp-http.ts
    - src/lib/vector-client.ts
    - src/lib/version-guard.ts
    - src/doctor.ts
    - src/backup.ts
    - src/export.ts
    - src/config.ts
    - src/doc.ts
    - src/delete-relation.ts
    - src/get-module-info.ts
    - src/bulk-store.ts
---

## 1. 使用的系统与框架

仓库没有引入第三方日志库（如 winston、pino、bunyan、debug 等），也没有统一的 logger 模块。日志输出完全依赖 Node.js 原生的 `console.log` / `console.error` / `console.warn`，以及直接调用 `process.stderr.write`。核心约定是：**结构化结果走 stdout（JSON），人类可读的进度/诊断/警告信息走 stderr**，从而避免污染 JSON 管道。

## 2. 关键文件

- `bin/ki.mjs`：CLI 统一入口，通过 `spawn('jiti', ...)` 启动各命令脚本；非 daemon 模式使用 `stdio: 'inherit'` 透传子进程 stdout/stderr，daemon 模式则忽略 stdio。
- `src/lib/progress.ts`：唯一的专用日志/进度封装，提供 `logPhaseStart`、`logPhaseDone`、`logProgress`、`logInfo`、`logWarn`、`logSummary`，全部写入 `process.stderr`，并区分 TTY（原地刷新进度条）与非 TTY（逐行输出）两种模式。
- `src/lib/import.ts`、`src/lib/batch-vectorize.ts`：导入/批量向量化流程中通过 `import { logPhaseStart, logPhaseDone, logProgress, logInfo, logWarn, logSummary } from './progress.js'` 消费进度日志。
- 各命令脚本（`src/backup.ts`、`src/export.ts`、`src/config.ts`、`src/doc.ts`、`src/delete-relation.ts`、`src/get-module-info.ts`、`src/doctor.ts`、`src/bulk-store.ts`）：直接使用 `console.log(JSON.stringify(result, null, 2))` 输出结构化结果，用 `console.error` 输出错误提示。
- `src/lib/cli-args.ts`：参数校验失败时通过 `console.warn` 输出警告。
- `src/lib/mcp-http.ts`、`src/lib/vector-client.ts`、`src/lib/version-guard.ts`、`src/lib/store.ts`、`src/lib/path-search.ts`、`src/lib/backup.ts`、`src/lib/mcp-stdio-lock.ts`：在底层组件中直接用 `process.stderr.write` 输出运行期状态、警告和诊断信息。

## 3. 架构与约定

### 3.1 stdout 与 stderr 的职责分离
- **stdout**：仅承载结构化数据（JSON）。所有命令脚本对成功结果统一使用 `console.log(JSON.stringify(result, null, 2))`，以便外部消费者解析。
- **stderr**：承载人类可读的输出——进度条、阶段提示、警告、诊断报告、MCP 服务启动信息等。`progress.ts` 的设计约束明确写明“控制台进度走 stderr，不污染 stdout 的 JSON 结果”。

### 3.2 进度日志分层
`progress.ts` 将进度日志分为多个语义层级：
- `logPhaseStart` / `logPhaseDone`：阶段开始/完成标记，格式为 `[Phase N/M] message` 和 `✓ message`。
- `logProgress`：apt install 风格的进度条，TTY 下原地刷新（`\r`），非 TTY 下退化为逐行输出。
- `logInfo` / `logWarn`：普通信息与带 ⚠ 前缀的警告。
- `logSummary`：汇总性输出，前后加空行。

### 3.3 无全局日志级别控制
仓库中没有 `LOG_LEVEL`、`DEBUG`、`logLevel` 等环境变量或配置项。所有日志路径都是硬编码输出的，不存在按级别过滤的能力。调试/诊断信息一律输出到 stderr。

### 3.4 结构化字段
结构化输出（stdout JSON）包含固定字段，例如 `ImportResult` 中的 `ok`、`action`、`scope`、`stats`、`errors`、`groups`、`source`；`DeleteRelationResult` 中的 `ok`、`error` 等。这些字段由命令脚本构造后直接序列化输出，而非通过日志框架附加。

### 3.5 MCP 与 CLI 的日志通道
- CLI 命令通过 `ki.mjs` spawn 子进程，非 daemon 模式下 `stdio: 'inherit'` 使子进程的 stdout/stderr 直接透传到父进程终端。
- MCP HTTP 模式（`--daemon`）下 stdio 被设为 `ignore`，此时运行期日志只写 stderr，但父进程已 detached，日志仅留在后台进程流中。

## 4. 约定与约束

- **必须将可解析的结果输出到 stdout**：所有命令脚本对成功响应统一使用 `console.log(JSON.stringify(...))`，这是被测试和外部调用方依赖的契约。
- **人类可读输出必须走 stderr**：`progress.ts` 注释明确要求进度输出到 stderr，且多处底层代码（vector-client、mcp-http、store、version-guard 等）也遵循这一约定。
- **进度条需兼容非 TTY**：`logProgress` 检测 `process.stderr.isTTY`，在非 TTY 下改用逐行输出，保证重定向到文件或管道时仍可读。
- **无日志级别开关**：当前实现未暴露任何日志级别配置，新增日志点应沿用现有模式（人类可读 → stderr，结构化 → stdout JSON）。
- **无统一 logger 抽象**：新增模块不应自行创建新的日志门面，而应复用 `progress.ts` 的函数或直接使用 `console` / `process.stderr`，以保持 stdout/stderr 职责清晰。
- **错误信息使用 `console.error`**：命令级错误（如 doctor 诊断失败、未知命令、参数非法）统一通过 `console.error` 输出，与正常结果区分。
- **警告使用 `console.warn` 或 `⚠` 前缀**：参数校验警告使用 `console.warn`，进度/向量客户端警告使用 `process.stderr.write(\`  ⚠ ${message}\`)` 形式保持一致视觉标识。