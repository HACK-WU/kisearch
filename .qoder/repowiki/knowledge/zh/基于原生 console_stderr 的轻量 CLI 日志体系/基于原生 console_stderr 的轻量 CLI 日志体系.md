---
kind: logging_system
name: 基于原生 console/stderr 的轻量 CLI 日志体系
category: logging_system
scope:
    - '**'
source_files:
    - bin/ki.mjs
    - src/lib/progress.ts
    - src/lib/cli-args.ts
    - src/lib/store.ts
    - src/lib/mcp-http.ts
    - src/lib/import.ts
    - src/lib/version-guard.ts
    - src/backup.ts
    - src/export.ts
    - src/config.ts
    - src/doc.ts
    - src/bulk-store.ts
    - src/get-module-info.ts
    - src/delete-relation.ts
---

## 1. 使用的系统/方案

仓库没有引入任何第三方日志框架（`package.json` 依赖中无 `pino`、`winston`、`bunyan`、`debug`、`signale`、`consola` 等；`debug` 仅作为其他依赖的间接依赖存在，且未被本项目代码直接引用）。整个日志体系完全基于 Node.js 原生 API：
- `console.log` / `console.error` / `console.warn` / `console.info`：用于 CLI 命令的标准输出结果与帮助信息。
- `process.stderr.write(...)`：用于进度条、阶段提示、警告、诊断信息等“非结构化”控制台输出。
- 唯一的结构化输出约定是 `console.log(JSON.stringify(result, null, 2))`，将命令结果以 JSON 形式输出到 stdout，便于管道消费。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `bin/ki.mjs` | CLI 入口，通过 `spawn('npx jiti', ...)` 启动子进程执行具体命令脚本，`stdio: 'inherit'` 使子进程直接复用父进程的 stdout/stderr |
| `src/lib/progress.ts` | 统一的进度/阶段/摘要输出模块，所有导入、同步等长耗时操作统一走此模块 |
| `src/lib/cli-args.ts` | CLI 参数解析时的警告输出（`console.warn`） |
| `src/lib/store.ts` | 存储层迁移提示、错误告警（`console.warn` + `process.stderr.write`） |
| `src/lib/mcp-http.ts` | MCP HTTP 服务启动、鉴权失败、状态查询等运行时日志（`console.log` + `process.stderr.write`） |
| `src/lib/import.ts` | 中断信号处理时写中断标记并输出进度（`process.stderr.write`） |
| `src/lib/version-guard.ts` | 版本兼容性检查警告（`process.stderr.write`） |
| `src/backup.ts`、`src/export.ts`、`src/config.ts`、`src/doc.ts`、`src/bulk-store.ts`、`src/get-module-info.ts`、`src/delete-relation.ts` | 各 CLI 命令的主输出（stdout JSON 结果） |

## 3. 架构与约定

### 3.1 双通道输出分离
- **stdout**：仅承载命令的**结构化结果**（JSON），供外部程序或脚本消费。典型模式：`console.log(JSON.stringify({ ok: true, data }, null, 2))`。
- **stderr**：承载所有**人类可读的控制台输出**——进度条、阶段提示、警告、诊断信息、帮助文本。`progress.ts` 注释明确说明：“控制台进度走 stderr，不污染 stdout 的 JSON 结果”。

### 3.2 进度输出规范（`src/lib/progress.ts`）
提供一组固定函数封装 stderr 输出，确保格式一致：
- `logPhaseStart(phase, totalPhases, message)`：打印 `[Phase X/Y] 消息`
- `logPhaseDone(phase, totalPhases, message)`：打印 `✓ 消息`
- `logProgress(current, total, detail?)`：apt install 风格进度条，TTY 下用回车覆盖当前行，非 TTY 逐行输出
- `logInfo(message)`：普通信息
- `logWarn(message)`：带 ⚠ 前缀的警告
- `logSummary(message)`：块级总结

### 3.3 子进程模型
`bin/ki.mjs` 使用 `child_process.spawn` 启动每个命令脚本，默认 `stdio: 'inherit'`，因此子进程直接继承父进程的 stdout/stderr，无需在子进程中做额外的日志重定向。daemon 模式下 stdio 设为 `'ignore'`，由 MCP 内部自行管理日志。

### 3.4 无全局 logger 实例
项目没有初始化全局 logger、没有配置 log level、没有按模块划分 logger。每个文件直接使用 `console.*` 或 `process.stderr.write`，不存在集中式日志路由或 sink 机制。

## 4. 约定与约束

| 约定 | 说明 | 依据 |
|---|---|---|
| 命令结果必须为 JSON 输出到 stdout | 所有 CLI 命令最终通过 `console.log(JSON.stringify(result, null, 2))` 输出可被管道消费的结构化结果 | 多个命令文件（`backup.ts`、`export.ts`、`config.ts`、`doc.ts`、`bulk-store.ts`、`delete-relation.ts`、`get-module-info.ts`）一致模式 |
| 进度/诊断/警告输出到 stderr | 避免污染 stdout 的 JSON 结果 | `progress.ts` 顶部注释明确声明设计约束 |
| 进度条需兼容 TTY 与非 TTY | TTY 下覆盖当前行，非 TTY 下逐行输出 | `progress.ts` 中 `process.stderr.isTTY` 分支逻辑 |
| daemon 模式关闭 stdio 透传 | 后台常驻进程不向终端输出，避免干扰 | `bin/ki.mjs` 中 `stdio: 'ignore'` + detached 模式 |
| 无日志级别开关 | 未实现 DEBUG/INFO/WARN/ERROR 分级控制，所有输出始终可见 | 全仓搜索未发现日志级别配置或环境变量控制 |
| 无结构化字段（如 timestamp、scope、traceId） | 日志为纯文本，不包含时间戳、上下文字段 | 所有 `process.stderr.write` 调用均为模板字符串拼接，无额外字段 |
| 无日志文件/远程收集 | 日志仅输出到标准流，无文件 sink、无网络 sink | 未见任何日志写入文件或发送日志的请求代码 |

## 5. 结论

该仓库采用**极简的原生 console/stderr 日志方案**，核心设计目标是：**CLI 命令的 stdout 保持纯净 JSON 以便管道消费，所有人类可读的进度、警告、诊断信息统一走 stderr**。没有引入日志框架、没有全局 logger、没有日志级别、没有结构化字段、没有持久化 sink。这是一个面向交互式 CLI 工具的实用主义方案，适合本地工具场景，但不适合需要集中采集、分级过滤、结构化检索的生产环境日志需求。