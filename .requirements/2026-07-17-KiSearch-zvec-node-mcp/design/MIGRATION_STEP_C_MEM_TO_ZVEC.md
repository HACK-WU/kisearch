# 迁移计划：剩余 mem 命令 → Vector Adapter（Step C）

> 日期：2026-07-21
> 前置：Step A 完成——`src/lib/vector-client.ts`(Vector Adapter) 已就绪，`search/store/bulk_store` 已迁移并通过 10/10 端到端冒烟。
> 范围：**仅迁移依赖 `mem-client.ts` 的其余 CLI 命令**，不含 daemon / partitions / YAML 等。

---

## 一、待迁移命令清单

| 命令 | 入口文件 | mem 依赖 | 迁移优先级 | 说明 |
|------|---------|---------|:---------:|------|
| `query-group` | `scripts/query-group.ts` | `memSearch({tags:'ki-path'})` | P1 | 按 Group 树检索，tags=ki-path |
| `get-module-info` | `scripts/get-module-info.ts` | `searchPath`(间接 mem) | P1 | 读模块信息，tags=ki-path |
| `sync-relation` | `scripts/sync-relation.ts` | `memStoreAsync` + `memSearch` | P2 | 写入 Relation，tags=ki-relation |
| `delete-relation` | `scripts/delete-relation.ts` | `memSearch` | P2 | 删除 Relation，tags=ki-relation |
| `manage-index` | `scripts/manage-index.ts` | `ensureMemAvailable` | P2 | 索引管理，无 mem 直接依赖 |
| `scan-kb` | `scripts/scan-kb.ts` | 间接调用 batch-vectorize | P3 | 批量导入/向量化，走 `batch-vectorize.ts` |
| `import-kb` | `scripts/import-kb.ts` | 独占锁，需本地 open | P3 | 已设计为**停 daemon 后本地执行**（N2），暂不迁移 |

### 已完成（Step A）
- `search` → `vectorSearch`(S-05 前：仅单 tag)
- `store` → `vectorStore`
- `bulk_store` → `vectorBulkStore`

---

## 二、mem → vector 映射表

### 2.1 函数映射

| mem 函数 | vector 对应 | 差异 |
|---------|-----------|------|
| `memSearch({scope,query,tags,threshold})` | `vectorSearch({scope,query,tags,threshold})` | 返回类型：`MemSearchResult[]` → `VectorSearchResult[]`（字段名 memoryId/content/score 对齐） |
| `memStore({scope,text,tags,keywords})` | `vectorStore({scope,text,tags,keywords})` | 返回类型：`{memoryId}` → `{docId}`（语义等价） |
| `memStoreAsync(...)` | `vectorStore(...)` | 原 async 是 execFile wrapper，vector 本身已是 async，直接替换 |
| `memBulkStore({scope,entries})` | `vectorBulkStore({scope,entries})` | 返回结构兼容（BulkStoreItemResult 同构） |
| `ensureMemAvailable()` | `ensureVectorAvailable()` | 语义：检测服务是否可用（probe/tryOpen） |
| `checkMemScope(scope)` | **移除** | S-01 已设计：scope 运行时化，无需预校验 |
| `ensureMemScope(scope)` | **移除** | 同上，scope 在首次 store 时隐式创建 |
| `getMemScopes()` | **后续补齐** | 可用 `listAllScopes()`(scope.ts) + `engine.listIds` 联合 |
| `searchPath(content, tag, scope)` | `vectorSearch({scope, query: content, tags: tag})` | searchPath 是 path-search.ts 的封装，直接替换底层 |

### 2.2 类型映射

| mem 类型 | vector 类型 | 备注 |
|---------|-----------|------|
| `MemSearchResult.memoryId` | `VectorSearchResult.memoryId` | 对齐 |
| `MemSearchResult.content` | `VectorSearchResult.content` | 对齐 |
| `MemSearchResult.score` | `VectorSearchResult.score` | 对齐（基座已归一化） |
| `MemStoreResult.memoryId` | `VectorStoreResult.docId` | 语义等价，调用方需更新字段名 |

### 2.3 tag 映射（scope 语义）

| mem tags 参数 | vector tags 参数 | 备注 |
|-------------|---------------|------|
| `'ki-search'` | `'ki-search'` | 记笔记/片段 |
| `'ki-path'` | `'ki-path'` | Group 树/路径检索 |
| `'ki-relation'` | `'ki-relation'` | 关系抽取 |
| `'ki-search,ki-path,ki-relation'`（逗号串） | **不支持**，改为 S-05 `DEFAULT_TAGS` 并发查询 | vector tag 是单值 STRING，多 tag 查询在 vector 层走 partitions（后续 Step B） |

---

## 三、各命令改造要点

### 3.1 query-group（P1）

**当前依赖**：`scripts/lib/query-group.ts` → `memSearch({tags:'ki-path'})` + `group-resolve.ts` → `searchPath`

**改造**：
- `scripts/lib/query-group.ts`：`memSearch({tags:'ki-path'})` → `vectorSearch({tags:'ki-path'})`
- `scripts/lib/group-resolve.ts`：`searchPath(content, 'ki-path', scope)` → `vectorSearch({scope, query: content, tags: 'ki-path', limit: 5})`
- 返回类型：`{ok, groups}` 结构不变，仅底层调用从 mem → vector

**影响范围**：`bin/ki.mjs` 的 `query-group` 命令 → 改指向 `src/query-group.ts`

**测试**：`test/query-group.test.ts` 现有测试覆盖（需确认是否用 mock 还是真实 mem）

### 3.2 get-module-info（P1）

**当前依赖**：`scripts/lib/get-module-info.ts` → `searchPath(relation, 'ki-relation', scope)`

**改造**：
- 底层 `searchPath` 的 mem 调用 → vectorSearch
- 返回结构：按 Group 路径检索模块原文，返回 markdown 格式，结构不变

**影响范围**：`bin/ki.mjs` 的 `get-module-info` 命令

### 3.3 sync-relation（P2）

**当前依赖**：`scripts/sync-relation.ts` → `memStoreAsync({scope, text: relText, tags: 'ki-relation'})` + `memSearch({tags:'ki-search'})`（回写 memoryId）

**改造**：
- `memStoreAsync` → `vectorStore({tags:'ki-relation'})`（vector 本身是 async，无需 async wrapper）
- `memSearch` → `vectorSearch({tags:'ki-search'})`（回写检查）
- ⚠️ **注意**：sync-relation 用 `memStoreAsync` 是 fire-and-forget（异步写向量不阻塞关系写入），vectorStore 是 `await` 的。改造后会变成同步等待 embed 完成。可接受（embed 单条约 0.5s），若需保持原异步语义，可在 vectorStore 后 `.catch(console.warn)` 不 await。

**影响范围**：`bin/ki.mjs` 的 `sync-relation` 命令

### 3.4 delete-relation（P2）

**当前依赖**：`scripts/delete-relation.ts` → `memSearch({tags:'ki-search'})`（查 memoryId 后删）

**改造**：
- `memSearch` → `vectorSearch({tags:'ki-search'})`
- 删除用 `vectorDelete`（已在 vector-client 暴露）
- ⚠️ 原 delete-relation 通过 `mem delete` CLI 命令删（spawn mem），现在直接调 engine.delete

**影响范围**：`bin/ki.mjs` 的 `delete-relation` 命令

### 3.5 manage-index（P2）

**当前依赖**：`scripts/manage-index.ts` → `ensureMemAvailable()`

**改造**：
- `ensureMemAvailable()` → `ensureVectorAvailable()`
- 索引操作（create/drop/optimize）目前无对应 MCP 工具，暂只做可用性替换

### 3.6 batch-vectorize（P3）

**当前依赖**：`scripts/lib/batch-vectorize.ts` → `memStore({tags:'ki-search'})` 逐条调用

**改造**：
- `memStore` → `vectorStore`
- 返回 `{memoryId}` → `{docId}`，调用方需更新字段名

---

## 四、基座改动评估

### 可能需要的基座改动

| 改动 | 原因 | 是否必须 |
|------|------|---------|
| 无（保持现状） | vector-client 已 import `dist/zvec-engine/index.js`，基座接口够用 | ✅ 本阶段不改基座 |
| `ScalarFieldDef` 补 `ARRAY_STRING`（S-03 后续） | 若多 tag 需在 zvec 层面做 `contains` 过滤 | ❌ 当前 tag 是单值 STRING，够用 |

### 已确认的基座约束
- `Filter` 的 `==` 仅支持 `string|number|boolean`，不支持数组。tag 用单值 STRING + 小写规范化绕过。
- zvec open 时加载索引 ~0.4s（含 jieba），每次冷启动必付。

---

## 五、迁移执行顺序

```
Phase 1（P1，同批可并行）：
  └─ query-group + get-module-info（共享 path-search/searchPath 改造）
     ├─ 改造 scripts/lib/query-group.ts（底层 mem→vector）
     ├─ 改造 scripts/lib/group-resolve.ts（searchPath→vectorSearch）
     ├─ 拷贝 query-group.ts → src/query-group.ts
     ├─ 拷贝 get-module-info.ts → src/get-module-info.ts
     ├─ 更新 bin/ki.mjs 指向 src/
     └─ 跑 test/query-group.test.ts + test/get-module-info.test.ts

Phase 2（P2，同批可并行）：
  └─ sync-relation + delete-relation + manage-index
     ├─ 改造 scripts/lib/path-vectorize.ts（memStoreAsync→vectorStore）
     ├─ 改造 scripts/sync-relation.ts（底层 mem→vector）
     ├─ 改造 scripts/delete-relation.ts（底层 mem→vector）
     ├─ 改造 scripts/manage-index.ts（ensureMemAvailable→ensureVectorAvailable）
     ├─ 拷贝三个入口 → src/
     ├─ 更新 bin/ki.mjs
     └─ 跑 test/sync-relation.test.ts + test/delete-relation.test.ts + test/manage-index.test.ts

Phase 3（P3）：
  └─ batch-vectorize / scan-kb / import-kb
     ├─ import-kb 设计为停 daemon 后本地独占（N2），改造方式不同
     └─ 后续再定
```

---

## 六、风险与注意事项

| 风险 | 影响 | 缓解 |
|------|------|------|
| **return type 字段名变更** | `memoryId` → `docId`；下游消费方（test/CLI JSON）需适配 | 每个入口保持 JSON 输出结构不变，仅改字段名（或别名兼容） |
| **sync-relation 的 fire-and-forget 语义** | 原 `memStoreAsync` 不 await，改后 `vectorStore` 会 await | vectorStore 单条约 0.5s，可接受；或 `.catch()` 不 await |
| **scope 校验变更** | `ensureMemScope(scope)` 移除，新 scope 在 store 时隐式创建 | S-01 设计已明确 scope 运行时化，不阻塞首次导入 |
| **test 覆盖** | 现有 test 用 mem mock，迁移到 vector 后 mock 失效 | 用 `vector-client-smoke.mjs` 的隔离 vectorDir 方案；或保留 mem mock 作回归（双保险） |
| **bin/ki.mjs jiti 冷启动** | 每条命令 ~3.8s（已验证） | 后续 daemon(v2) 解决，本阶段接受 |

---

## 七、验证标准

每个 Phase 完成后：
1. 对应 test 全绿（`npm run test:{命令名}`）
2. 手动冒烟：`ki {命令} --scope test` 结果与旧 mem 版一致
3. 端到端：`ki store → ki {命令} → 结果含写入内容`
4. scope 隔离：`ki {命令} --scope A` 不泄露 B 数据

---

## 八、不迁移的命令（明确排除）

| 命令 | 不迁移原因 |
|------|----------|
| `backup` | 纯文件备份，不依赖 mem |
| `restore` | 从备份恢复，走本地文件，不走向量 |
| `export` | 导出 Wiki Markdown，走本地文件 |
| `import-kb` | 需独占锁重建（N2），设计为停 daemon 后本地执行，暂不迁移 |
| `migrate-keywords` | 数据迁移，一次性脚本，用完即弃 |
| `setup` | 下载 Skills/Rules，与向量无关 |
| `config` | 配置管理（init），与向量查询无关 |
