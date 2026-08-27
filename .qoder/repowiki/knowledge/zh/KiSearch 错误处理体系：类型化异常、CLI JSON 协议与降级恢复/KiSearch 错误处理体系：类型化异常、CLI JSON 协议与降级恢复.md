---
kind: error_handling
name: KiSearch 错误处理体系：类型化异常、CLI JSON 协议与降级恢复
category: error_handling
scope:
    - '**'
source_files:
    - src/zvec-engine/errors.ts
    - src/lib/preflight.ts
    - src/lib/mcp-http-api.ts
    - src/lib/import.ts
    - src/lib/interrupt.ts
    - src/lib/mcp-token.ts
    - src/bulk-store.ts
    - src/delete-relation.ts
    - src/doc.ts
    - test/error-handling.test.ts
    - docs/error-handling.md
---

## 1. 整体方案

KiSearch 在两个层面组织错误处理：

- **ZvecEngine（向量引擎层）**：定义统一的 `ZvecEngineError` 基类及 11 种派生异常，通过 `ERROR_CONSTRUCTORS` 映射表支持跨 worker/线程的序列化反序列化重建。
- **ki CLI / MCP HTTP API（应用层）**：所有命令以 `{ ok: true/false, error?, ... }` 的 JSON 形式输出；HTTP `/api/*` 路由统一返回 JSON，并在越权时记录 stderr 但响应体脱敏。

项目文档 `docs/error-handling.md` 明确三条原则：**输入非法快速失败**、**可恢复场景给出 hint/next_step**、**能兜底优先退化而非崩溃**。

## 2. 关键文件与包

| 文件 | 职责 |
|---|---|
| `src/zvec-engine/errors.ts` | 定义 `ZvecEngineError` 基类及全部 11 种业务异常（Schema、Collection、Embedding、Worker、Protocol 等），并提供 `ERROR_CONSTRUCTORS` 供 `worker-protocol` 反序列化使用 |
| `src/lib/preflight.ts` | 写操作前置预检（目录可写性、磁盘空间），抛出带 `code` 的 `PreflightError`（`DIR_NOT_WRITABLE` / `DISK_INSUFFICIENT`） |
| `src/lib/mcp-http-api.ts` | HTTP `/api/*` 路由的错误处理：路径穿越拒绝、扩展名/大小校验、scope 越权拦截（stderr 记录 + 403 JSON） |
| `test/error-handling.test.ts` | 覆盖参数校验、Group 树索引、Relations 缓存、本地 KB、展示参数、导入异常等矩阵 |
| `docs/error-handling.md` | 面向用户的“常见报错、警告与恢复方式”手册 |

## 3. 架构与约定

### 3.1 ZvecEngine 类型化异常

- 所有引擎异常继承 `ZvecEngineError`，携带可选 `code`、`data`、`cause`，调用方可用 `instanceof` 统一识别。
- 异常按领域分组：Schema/配置类（`DimensionMismatchError`、`InvalidSchemaError`、`InvalidDocInputError`、`InvalidSearchError`、`InvalidFilterError`、`SchemaMismatchError`、`InconsistentUpdateError`）、集合生命周期（`CollectionNotFoundError`、`CollectionLockedException`、`CollectionCorruptedException`、`CollectionAlreadyExistsError`）、Embedding（`EmbeddingError`、`EmbeddingConfigError`）、Worker（`WorkerSpawnError`、`WorkerCrashedError`、`WorkerUnavailableError`、`WorkerProtocolError`、`CloseTimeoutError`）。
- `ERROR_CONSTRUCTORS` 字典将异常名称映射到构造器，配合 `SerializedError` 实现跨线程/进程的反序列化重建。

### 3.2 CLI 命令的统一 JSON 协议

每个命令脚本（如 `query-group.ts`、`scan-kb.ts`、`sync-relation.ts`、`get-module-info.ts`、`delete-relation.ts`、`bulk-store.ts`）对外暴露函数，返回形如：

```ts
{ ok: true, groups?: string[] }
// 或
{ ok: false, error: 'relations-cache.json 不存在' }
```

测试通过 `execFileSync('npx', ['jiti', script, ...args])` 调用并解析 stdout JSON 来断言 `ok` 和 `error` 字段。失败时命令 `process.exit(1)`，成功则 `process.exit(0)`。

### 3.3 前置预检（Pre-flight）

`backup` / `restore` / `export` 等写盘操作在执行前调用 `preflight.checkWritable()` 和 `checkDiskSpace()`，提前探测 EACCES 和 ENOSPC，避免写入中途失败产生半截产物。失败抛 `PreflightError`，由调用方转为 JSON 错误输出。

### 3.4 HTTP API 错误策略

`mcp-http-api.ts` 中：
- 上传文件名经 `sanitizeFileName` 拒绝绝对路径与 `..` 穿越。
- scope 越权走 `rejectScopeViolation`：stderr 记录完整 scope 便于排查，响应体仅返回脱敏的 `Forbidden: 无权访问该 scope`。
- 请求体过大直接 reject，文件扩展名/大小受白名单限制。

### 3.5 降级与容错

- 增量删除失败不阻塞流程，记录 warning 继续执行（旧记录可能残留但不影响新写入）。
- `estimateDirSize` 单文件统计失败忽略，返回 0 表示无法估算，调用方跳过空间检查。
- 向量服务不可用时返回 `{ ok: false, degraded: true }` 标记降级状态。
- 锁文件清理、进程 kill 等操作对 `unlinkSync`/`kill` 的 catch 块均做静默忽略，避免中断清理本身成为故障点。

## 4. 约定与约束

- **输入非法快速失败**：scope 含 `/`、`..` 等非法字符直接拒绝；`--mode` 无效值列出合法枚举后退出。
- **数据文件缺失/损坏**：`relations-cache.json` 不存在、`group-index.json` 损坏、本地 KB 缺失时返回明确的 `ok:false` 与提示性 `error` 消息，指导用户重新初始化或从备份恢复。
- **可恢复场景给 hint**：如忘记 scope 名称时提示执行 `list-scopes`；增量删除未找到 sourcePath 时记录 warning 并继续。
- **能兜底优先退化**：磁盘空间探测不可用（无 `statfsSync`）时跳过检查而非阻断；单文件统计失败忽略。
- **跨进程异常可重建**：ZvecEngine 异常必须能在 worker 侧序列化、主进程反序列化为同名实例，因此 `ERROR_CONSTRUCTORS` 是契约的一部分。
- **安全相关错误脱敏**：HTTP API 的 scope 越权响应体不包含具体 scope 名，防止枚举探测。

## 5. 测试覆盖

`test/error-handling.test.ts` 以“异常矩阵”形式验证：非法 scope、Group 不存在/损坏/非空节点删除、Relations 缓存缺失、本地 KB 缺失、无效 mode、scan-kb import 源目录不存在/无 md 文件等场景，均断言 `ok:false` 且 `error` 包含预期子串。

## 6. 相关文件清单

- `src/zvec-engine/errors.ts`
- `src/lib/preflight.ts`
- `src/lib/mcp-http-api.ts`
- `src/lib/import.ts`
- `src/lib/interrupt.ts`
- `src/lib/mcp-token.ts`
- `src/bulk-store.ts`
- `src/delete-relation.ts`
- `src/doc.ts`
- `test/error-handling.test.ts`
- `docs/error-handling.md`
