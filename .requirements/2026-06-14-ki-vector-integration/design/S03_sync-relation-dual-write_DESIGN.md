# S-03 sync-relation 自动双写向量

> 状态：草案
> 依赖：S-01（mem-client + store.ts）

## 术语

| 术语 | 定义 |
|------|------|
| 容错双写 | sync-relation 本地写成功后同步调 mem store（try-catch 包裹），失败不影响主流程返回值 |
| 向量回写 | 将 Relation 的 module-info + keywords 向量化后存入 mem |
| 重复存储防护 | import 流程内部调 sync-relation 时，双写由 sync-relation 统一完成，不重复调用 |

## 现状（AS-IS）

`sync-relation.ts` 当前已有 ki-relation 向量写入（第 430-434 行）：

```typescript
// 写入 ki-relation 向量索引（失败不阻塞）
try {
  const relText = buildRelationContent(relation, group, keywordList);
  storeOnePath({ text: relText, tag: 'ki-relation', scope });
} catch { /* 向量写入失败不影响主流程 */ }
```

这是为 `query-group` 的路径级向量兜底服务的（ki-relation tag），写入的是路径+Relation 名称的摘要文本。

**问题**：sync-relation 没有将完整 module-info 内容做通用向量化存储。Agent 通过 `ki search` 做通用语义搜索时，搜不到这些内容。

**现有 import 流程**（`scan-kb.ts`）在内部也独立调 `mem store` 做向量化，存在两条存储路径。

**关键文件**：
- `scripts/sync-relation.ts`（第 386-439 行：`executeSyncRelation` 函数）
- `scripts/scan-kb.ts`（import 流程中独立调 mem store）
- `scripts/lib/path-vectorize.ts`（第 182-226 行：`storeOnePath` 函数）

## 方案（TO-BE）

### 3.1 新增通用向量双写

在 `executeSyncRelation` 中，ki-relation 向量写入之后，新增一步：将完整 module-info 通过 `memStore` 存入 mem。

```typescript
// 现有：ki-relation 路径向量（保留）
try {
  const relText = buildRelationContent(relation, group, keywordList);
  storeOnePath({ text: relText, tag: 'ki-relation', scope });
} catch { /* 不影响主流程 */ }

// 新增：通用语义向量双写
try {
  const memResult = memStore({
    scope,
    text: moduleInfo,
    keywords: keywordList,
    tags: 'ki-search',
  });
  // 可选：将 memoryId 回写到 relations-cache
  // cache.groups[group].hot_relations[...].memoryId = memResult.memoryId;
} catch { /* 不影响主流程 */ }
```

### 3.2 容错策略

- **本地写成功即返回**：`writeJson(cachePath, cache)` 完成后立即返回 `ok: true`
- **向量双写执行方式**：同步调用 `memStore`（spawnSync），用 try-catch 包裹，失败时记录 warning（`console.warn`），不改变返回值
- **不重试**：ki 是 CLI 工具，重试无意义。下次 sync-relation 时会重新写入

### 3.3 与 import 流程的关系

当前 `scan-kb import` 内部调 `mem store` 做向量化。S-03 实现后：

- **短期**：保留 import 流程中的独立 mem store 调用，确保向后兼容
- **远期**：import 流程简化为只调 `sync-relation`，双写由 `sync-relation` 统一完成

**重复存储防护**：
- ki-relation tag 的 `storeOnePath` 继续保留（路径级兜底需要）
- ki-search tag 的通用向量存储由 sync-relation 新增逻辑完成
- import 流程中的独立 mem store 调用在远期统一后移除

### 3.4 输出变更

`executeSyncRelation` 返回值新增可选字段：

```typescript
export type SyncRelationResult =
  | { ok: true; relation: string; keywords: string[]; invalid_keywords: string[];
      evicted: string | null; hint?: string; vectorStored?: boolean }
  | { ok: false; error: string };
```

`vectorStored: true` 表示向量双写成功，`false` 或不存在表示双写失败或跳过。

### 3.5 关键决策点

| 决策 | 选定方案 | 被否决方案 | 否决理由 |
|------|----------|------------|----------|
| 向量双写执行方式 | 同步 spawnSync + try-catch 容错 | 异步 child_process.spawn | ki 是 CLI 工具，进程生命周期短，异步进程可能在父进程退出前未完成；同步执行保证双写在进程退出前完成，失败时立即知道结果 |
| 重复 sync 同一 Relation | 允许重复存储，依赖 mem 冷热治理自然淘汰 | 存储前 memSearch 查重 | 查重需额外一次 mem search 调用（~1-3s），增加每次 sync 耗时；ki 是低频工具，重复条目量有限；mem 自身有冷热淘汰机制 |
| import 流程是否立即统一 | 短期保留 import 独立 mem store | 立即统一为 sync-relation 双写 | 立即统一需同时修改 scan-kb.ts 和 sync-relation.ts，变更范围大，回归测试成本高；短期保留可分步降低风险 |

## 接口设计

**无新增接口**。变更点：

- `executeSyncRelation()` 内部新增 `memStore()` 调用
- 返回值新增 `vectorStored?: boolean` 字段

## 影响范围

| 调用方 | 影响 |
|--------|------|
| CLI `ki sync-relation` | 无感知变更，输出新增 `vectorStored` 字段 |
| MCP `ki_sync_relation` | 无感知变更，返回新增 `vectorStored` 字段 |
| `scan-kb import` 流程 | 短期不变更（保留独立 mem store），远期简化 |
| 批量模式 `sync-relation --input` | 批量模式需同步新增双写逻辑 |

## 异常处理

| 场景 | 行为 | 是否对外暴露 |
|------|------|-------------|
| memStore 调用失败 | 记录 warning，返回 `vectorStored: false` | 是（warning 输出） |
| memStore 超时 | 同上 | 是 |
| mem 不可用 | 跳过双写，不记录 warning（静默降级） | 否 |
| 重复 sync-relation 同一 Relation | 允许重复存储，依赖 mem 冷热治理自然淘汰 | 否 |

## 测试方案

- **单元测试**：mock `memStore`，验证双写调用、失败不阻塞、返回值变更
- **集成测试**：sync-relation 写入后，`ki search` 可立即召回 module-info 内容
- **回归测试**：验证 ki-relation 路径向量写入不受影响

## 风险 & 待定问题

| 问题 | 状态 | 备选方案 |
|------|------|----------|
| sync-relation 每次调用都新增 mem 条目，是否会导致 mem 数据膨胀？ | 低风险 | mem 有冷热治理，长期不用会自然淘汰 |
| memoryId 是否需要回写到 relations-cache.json？ | 待定 | 回写可方便后续 update/delete，但增加数据结构复杂度 |
| 批量模式的双写是否应该用 bulk-store 替代逐条 store？ | 待定 | 批量模式下用 bulk-store 性能更优 |
