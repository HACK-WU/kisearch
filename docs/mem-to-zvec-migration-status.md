# mem → zvec 迁移状态

> 记录 `mem` CLI（外部进程） → `src/lib/vector-client.ts`（zvec 基座）迁移的**已完成**与**未完成**部分。
> 最后更新：P0（MCP 工具层）+ P3（向量化管线）完成、scan-kb e2e 6/6 通过后。

## 一、迁移目标

把仍依赖 `scripts/lib/mem-client.ts`（spawn 外部 `mem` CLI）的功能，逐步迁移到 `src/lib/vector-client.ts`（基于 `dist/zvec-engine` 的进程内向量适配器）。

判定标准：一个命令算"已迁移"当且仅当其运行链路**不再 spawn `mem` 进程**，向量读写全部经由 `vector-client`。

**范式约束**：`scripts/` 下代码一律**不改**，全部拷贝到 `src/` 后再修改；`bin/ki.mjs` 指向 `src/`。

## 二、已完成 ✅

### 命令入口（均已接线到 `src/`）

| 命令 | CLI 入口 | 批次 | 说明 |
|---|---|---|---|
| `search` | `src/search.ts` | Step A/B | 向量检索 |
| `store` | `src/store.ts` | Step A/B | 单条写入 |
| `bulk_store` | `src/bulk-store.ts` | Step A/B | 批量写入 |
| `query-group` | `src/query-group.ts` | Step C | async + `vectorSearch` 语义兜底 + `closeEngine` |
| `get-module-info` | `src/get-module-info.ts` | Step C | async + `await searchPath/resolveGroupPath` |
| `sync-relation` | `src/sync-relation.ts` | Step C | `await` 写入 + 一次 `vectorBulkStore` |
| `delete-relation` | `src/delete-relation.ts` | Step C | `vectorSearch` 定位 + 批量 `vectorDelete` |
| `manage-index` | `src/manage-index.ts` | Step C | cascade 收集 memoryId + 批量 `vectorDelete` |
| `mcp` | `src/mcp-server.ts` | **P0** | MCP server + `src/lib/mcp-tools/*` 全部指向 `src/`，9 工具注册验证通过 |
| `scan-kb` | `src/scan-kb.ts` | **P3** | import/diff 管线走 zvec；import 命令收尾 `await closeEngine()` |
| `import-kb` | `src/import-kb.ts` | **P3** | 纯 index/cache 构建（无直接向量调用） |
| `restore` | `src/restore.ts` | **P3** | 重放 `handleImport/handleIncremental`，`main` 的 `finally` + 循环内 exit 前 `closeEngine()` |

### 配套 lib（`src/lib/`）

- Step C：`path-search`（async + vectorSearch + 阈值 0）、`path-vectorize`（mem→vector，函数 async 化）、`group-resolve`（async），纯拷贝 `store/scoring/wal/markdown-gen/wiki-sync`。
- P3：`batch-vectorize`（`mem store/bulk-store` → `vectorStore/vectorBulkStore/vectorDelete`，全 async，返回真实 `docId`；`deleteMemory` 加 `scope` 参数）、`import`/`incremental`（去 `ensureMemScope`，`bulkStorePaths/deletePathVector/deleteMemory` 加 `await`），纯拷贝 `ai-results/progress/diff/backup`。

### 关键修复

- **全量 import 持久化真实 docId**（`src/lib/import.ts`）：Phase 2（向量化）与 Phase 4（写 cache）并行，`docId` 仅在 `Promise.all` 后汇入 `mergedMap`。新增**回填 pass**：向量化完成后按 `sourcePath` 把真实 docId 写回 `relations-cache` 并重新持久化。这是 zvec 下 `diff → 增量 modify/delete` 能定位旧向量的前提（docId 是删除向量的唯一钥匙），修复了 mem 时代"memoryId 死数据"假设在 zvec 下的断裂。
- **CLI 进程退出**：`scan-kb`/`restore` 补 `closeEngine()`（terminate worker + 释放 LOCK），否则 worker 线程持事件循环引用，进程卡到 180s 超时才被杀。

### 验证

- `build:zvec-engine` 无错误。
- 离线单测全绿。
- `test:e2e:step-c` 真实链路 6/6 通过。
- `test:e2e:scan-kb`（新增）真实链路 6/6 通过（~21s）：全量 import → recall → diff0 → diffN（docId 关联回归点）→ 增量 add/modify/delete errors=0 → 删除向量清理 + diff 归零。

## 三、未完成 / 待决 ⬜

### 1）打包配置缺口（真实风险，发布必修）

`package.json` 的 `files` 字段为：

```
"files": ["bin/**/*", "scripts/**/*", "_template/**/*",
          "dist/zvec-engine/**/*", "src/zvec-engine/**/*", "README.md", "LICENSE"]
```

**未包含 `src/lib/**` 与 `src/*.ts`**。而 `bin/ki.mjs` 现已指向 `src/scan-kb.ts`、`src/search.ts` 等迁移后入口。

- 本地开发正常（文件都在工作区）。
- 一旦 `npm publish` → 安装，迁移后的命令因源文件未被打包而**全部报错找不到文件**。

**迁移动作**：`files` 增加 `"src/**/*"`（或至少 `"src/lib/**/*"` + `"src/*.ts"`）。

### 2）`package.json` scripts 快捷方式仍指 `scripts/`

`scripts.scan-kb/manage-index/query-group/...` 等 npm 脚本仍 `npx jiti scripts/*.ts`，与 `bin/ki.mjs`（已指 `src/`）分叉。属开发便捷入口，不影响 `ki` CLI，可择机统一。

### 3）代码文案里的 "mem" 残留（仅措辞，功能无影响）

`src/lib/import.ts`、`src/lib/incremental.ts` 的注释与错误提示字符串仍含 `mem delete / mem store / mem bulk-store` 字样（实际已走 `vectorDelete/vectorStore`）。建议后续清理为 zvec 术语，避免误导。

### 4）旧 mem 版测试仍在 `test/`（冻结保留）

`test/batch-vectorize.test.mjs`、`test/e2e/scan-kb-cli.e2e.mjs`（mock-mem）等旧单测/e2e 仍导入 `scripts/lib/*`（旧 mem 版），随 `scripts/` 冻结保留；新链路由 `*.network.mjs` e2e 覆盖。若后续删除 `scripts/`，需同步清理。

## 四、无需迁移（无 mem 依赖，刻意保留在 `scripts/`）

以下命令为纯文件 / 配置操作，不触碰向量层，不在 mem→zvec 范围内：`config`、`setup`、`export`、`backup`、`migrate-keywords`。如需入口统一（全部迁 `src/`）可另行安排，与本次向量迁移解耦。

## 五、收尾建议顺序

1. **补 `package.json` 的 `files`**（唯一影响发布的真实缺口）。
2. 清理 `import.ts`/`incremental.ts` 的 mem 文案。
3.（可选）统一 `package.json` scripts 与 5 个非 mem 命令到 `src/`。
4. 全部完成后方可移除 `scripts/lib/mem-client.ts` 及外部 `mem` CLI 依赖。

## 六、当前 `bin/ki.mjs` 接线对照

| 已指向 `src/`（走 zvec） | 仍指向 `scripts/`（无 mem） |
|---|---|
| scan-kb, import-kb, restore, manage-index, query-group, get-module-info, sync-relation, delete-relation, mcp, search, store, bulk_store | migrate-keywords, setup, config, backup, export |
