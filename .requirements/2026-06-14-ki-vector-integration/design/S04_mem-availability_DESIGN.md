# S-04 mem 可用性检测与降级策略

> 状态：草案
> 依赖：无（第一期，与 S-01 并行）

## 术语

| 术语 | 定义 |
|------|------|
| 健康检查 | 在向量操作执行前检测 mem CLI 是否可用 |
| 静默降级 | mem 不可用时向量能力优雅失败，结构化导航不受影响 |
| degraded 标记 | 返回结果中带 `degraded: true`，调用方可据此判断 |

## 现状（AS-IS）

ki 当前没有任何 mem 可用性检测机制。`path-vectorize.ts` 中 mem 调用失败时静默 catch（`catch { /* 向量写入失败不影响主流程 */ }`），这对 path-vectorize 场景是合理的（写入失败不阻塞主流程），但对用户直接调用的 `ki search` / `ki store` 不够——用户需要知道为什么向量能力不可用。

**关键文件**：
- `scripts/lib/path-vectorize.ts`（第 160-168 行：catch 块静默忽略错误）
- `scripts/query-group.ts`（无 mem 可用性检查）

## 方案（TO-BE）

### 3.1 新增 `checkMemAvailable()` 函数

在 `scripts/lib/mem-client.ts` 中提供（S-01 定义，S-04 提供实现细节）：

```typescript
function checkMemAvailable(): { available: boolean; reason?: string };
```

**检测方式**：执行 `mem --version`（最轻量），超时 3s。

**返回逻辑**：
- 命令存在且返回版本号 → `{ available: true }`
- ENOENT（命令不存在） → `{ available: false, reason: "mem CLI 未安装。安装命令: curl -fsSL ... | bash" }`
- 超时（>3s） → `{ available: false, reason: "mem CLI 响应超时" }`
- 其他错误 → `{ available: false, reason: "mem CLI 异常: <error>" }`

### 3.2 降级行为矩阵

| 命令 | mem 可用 | mem 不可用 |
|------|----------|-----------|
| `ki search` | 正常返回搜索结果 | `{ ok: false, error: "向量检索暂不可用（mem 未检测到）", degraded: true, hint: "请确认 mem CLI 已安装" }` |
| `ki store` | 正常存储并返回 memoryId | `{ ok: false, error: "向量存储暂不可用（mem 未检测到）", degraded: true }` |
| `ki bulk_store` | 正常批量存储 | `{ ok: false, error: "向量存储暂不可用（mem 未检测到）", degraded: true }` |
| `ki query-group` | 正常 + 语义兜底 | 正常（结构化导航不受影响），不触发语义兜底 |
| `ki sync-relation` | 正常 + 双写向量 | 正常（本地写入成功），跳过双写，输出 warning |
| `ki get-module-info` | 正常 | 正常（不依赖 mem） |
| `ki manage-index` | 正常 | 正常（不依赖 mem） |
| MCP `ki_search` | 正常 | `{ isError: true, content: "向量检索暂不可用" }` |
| MCP `ki_store` | 正常 | `{ isError: true, content: "向量存储暂不可用" }` |

### 3.3 检测时机

- **跨进程不缓存**：ki 是 CLI 工具，每次命令是独立进程，检测结果不跨进程缓存
- **进程内缓存**：同一进程内多次向量操作（如 bulk_store 逐条）仅首次检测，使用模块级变量缓存结果

```typescript
let _memAvailable: { available: boolean; reason?: string } | null = null;

function ensureMemAvailable(): { available: boolean; reason?: string } {
  if (_memAvailable === null) {
    _memAvailable = checkMemAvailable();
  }
  return _memAvailable;
}
```

- **`checkMemAvailable()`**：每次调用都实际执行 `mem --version`，不做缓存
- **`ensureMemAvailable()`**：进程内缓存版本，首次检测后复用，推荐在业务逻辑中使用

### 3.4 关键决策点

| 决策 | 选定方案 | 被否决方案 | 否决理由 |
|------|----------|------------|----------|
| 检测方式 | 执行 `mem --version`（3s 超时） | 执行 `mem search --help` 或 `mem status` | `--version` 是最轻量的探测命令，不涉及模型加载或网络请求；`search --help` 可能触发模型初始化，耗时更长 |
| 缓存策略 | 进程内缓存 + 跨进程不缓存 | 完全不缓存 / 跨进程持久化缓存 | 完全不缓存会导致 bulk_store 等批量操作逐条检测（浪费 ~3s/次）；跨进程持久化对 CLI 工具无意义，且引入缓存过期复杂度 |
| 降级行为差异化 | 向量命令报错 + 结构化命令静默 | 所有命令统一报错 / 所有命令统一静默 | 向量命令（search/store）是用户主动调用，需要明确告知不可用；结构化命令（query-group/sync-relation）的向量能力是增强项，报错会干扰用户 |

## 接口设计

| 函数 | 签名 | 说明 |
|------|------|------|
| `checkMemAvailable()` | `() → {available, reason?}` | 实际检测（执行 `mem --version`） |
| `ensureMemAvailable()` | `() → {available, reason?}` | 进程内缓存版，首次检测后复用 |

## 性能与安全

- **检测超时**：3s（mem --version 通常 <100ms，3s 足以覆盖慢启动）
- **不阻塞主流程**：`checkMemAvailable()` 仅在向量操作前调用，结构化命令不调用它
- **PATH 注入**：检测时同样需要显式注入 PATH（与 mem-client 其他方法一致）

## 测试方案

- **单元测试**：mock `execFileSync`，验证 ENOENT / timeout / 正常 三种场景
- **集成测试**：临时修改 PATH 使 mem 不可达，验证降级输出
- **端到端**：`ki search` 在 mem 不可用时返回 degraded 提示，`ki query-group` 正常工作

## 风险 & 待定问题

| 问题 | 状态 | 备选方案 |
|------|------|----------|
| `mem --version` 是否在所有 mem 版本中可用？ | 需确认 | 如不可用，改用 `mem search --help` 作为探测命令 |
| 是否提供 `--skip-mem-check` 参数跳过检测？ | 待定 | 对于已知 mem 可用的环境可提升启动速度 |
