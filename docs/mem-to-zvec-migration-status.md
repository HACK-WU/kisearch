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

### 1）打包配置缺口 ✅已修复（2026-07-22）

`package.json` 的 `files` 已增加 `"src/**/*"`，覆盖 `bin/ki.mjs` 指向的 `src/` 迁移后入口。以下为原风险记录：

`package.json` 的 `files` 字段为：

```
"files": ["bin/**/*", "scripts/**/*", "_template/**/*",
          "dist/zvec-engine/**/*", "src/zvec-engine/**/*", "README.md", "LICENSE"]
```

**未包含 `src/lib/**` 与 `src/*.ts`**。而 `bin/ki.mjs` 现已指向 `src/scan-kb.ts`、`src/search.ts` 等迁移后入口。

- 本地开发正常（文件都在工作区）。
- 一旦 `npm publish` → 安装，迁移后的命令因源文件未被打包而**全部报错找不到文件**。

**迁移动作**：`files` 增加 `"src/**/*"`（或至少 `"src/lib/**/*"` + `"src/*.ts"`）。

### 2）`package.json` scripts 与 5 个非 mem 命令入口 ✅已统一（2026-07-22）

`config`/`setup`/`export`/`backup`/`migrate-keywords` 已**拷贝**（`scripts/` 不改）到 `src/`，`bin/ki.mjs` 与 `package.json` 的 `scripts.*` 均已改指 `src/`。此后 `ki` CLI 与 npm 脚本入口全部统一到 `src/`，`scripts/` 仅剩冻结代码/测试引用。

**已实现**：

1. `cp scripts/{config,setup,export,backup,migrate-keywords}.ts → src/`（逐字拷贝；这 5 个命令无 mem 依赖，仅 `import './lib/*'`，在 `src/` 下解析到 `src/lib`，无需改动）。
2. `bin/ki.mjs` 的 `COMMANDS`：`config/setup/export/backup/migrate-keywords` 5 项从 `scripts/*.ts` 改为 `src/*.ts`。
3. `package.json` 的 `scripts`：`scan-kb/manage-index/query-group/get-module-info/sync-relation/setup` 从 `npx jiti scripts/*.ts` 改为 `src/*.ts`。

**验证**：`node bin/ki.mjs {config,backup,export,migrate-keywords,setup} --help` 5 命令经 jiti 全部成功加载（`./lib/*` import 全部解析），行为与 `scripts/` 原件一致。

### 3）代码文案里的 "mem" 残留 ✅已清理（2026-07-22）

`src/lib/import.ts`、`src/lib/incremental.ts` 的注释与错误提示字符中的 `mem delete / mem bulk-store` 已改为「向量删除 / vectorBulkStore」等 zvec 术语。（`deleteMemory`/`memoryId`/`memOpts` 等标识符属 API 面，故保留不改；`vector-client.ts` 中「替代 memXxx」类迁移说明性注释也保留。）

### 4）旧测试对 `scripts/` 的引用 ✅已解耦（2026-07-22）

`test/` 曾有 15 个测试引用 `scripts/`（`import '../scripts/lib/*'` 或 `SCRIPTS_DIR/SCRIPT_PATH = .../scripts` 拼接命令路径）。已全部重指到 `src/`，并删除测旧 mem 契约的过时测试。此后 `test/` **不再引用 `scripts/`**（仅剩 `step-c-cli.e2e.network.mjs` 一处说明性注释）。

**重指（scripts/ → src/，纯逻辑一致；共 12 文件）**：`sync-relation`、`manage-index`、`query-group`、`get-module-info`、`migrate-keywords`、`scope-source`、`ai-results`、`lib`、`scope-isolation`、`error-handling`、`import-kb`、`scan-kb`、`integration`（`SCRIPTS_DIR`/`SCRIPT_PATH` 的 `'scripts'` 段一并改 `'src'`；`migrate-keywords.test.ts` 的 `npx tsx scripts/migrate-keywords.ts` 与 `import '../scripts/migrate-keywords.js'` 一并改 `src/`）。

**删除（过时/不可用；共 7 文件）**：

- mem 版（`mock-mem` + `resetMemScopesCache` + 断言 `mem store 失败`）：`import.test.mjs`、`incremental.test.mjs`、`batch-vectorize.test.mjs`、`e2e/batch-vectorize.e2e.mjs`（真实调 `bin/mem.mjs`）、`e2e/scan-kb-cli.e2e.mjs`（mock-mem + 失效路径），以及假 mem CLI `fixtures/mock-mem.mjs`。
- 陈旧契约：`diff.test.mjs`——测 `parseGitDiff` 的**旧 tab 格式**（现改 `-z` NUL 分隔）且用未注册 scope（现 `ensureScopeDir` 强制注册）。已确认 `scripts/lib/diff.ts` 与 `src/lib/diff.ts` **字节一致**，故该失败为**既有**（非重指引入）；真实 `-z` 解析由 `test:e2e:scan-kb` 覆盖。

**验证**：重指后纯逻辑测试全绿——`lib` 28/28、`ai-results` 11/11、`scope-source` 6/6、`scope-isolation`（走 `src/` 命令）5/5。

**影响**：`test/` 与 `scripts/` 解耦后，删除 `scripts/`（含 `mem-client.ts`）的**唯一阻塞已消除**（见 §五 4）。

### 5）`scopeMode` scope 护栏 ✅已落地（2026-07-22）

设计已收敛（S-01 §3.5 + S-06 §3.5 N19）：引入 `scopeMode: 'default' | 'strict'` 作为 scope **护栏层**，把「漏传 scope → 静默落 default 串味」转为 fail-loud。**已明确不做**项目级绑定 / `X-Ki-Scope` 请求头（方案已取消），隔离仍靠全局唯一 scope 命名。

**已实现**：

1. `src/lib/config.ts`：`KiConfig` 新增 `scopeMode`（默认 `'default'`，`parseAndExpand` 仅认 `'strict'` 否则归 `'default'`）；新增 `getScopeMode()` + `resolveScope(config, scope?)`（default 档缺省/空→`default`、任意值放行；strict 档必须传且在 `scopes` 白名单内，否则抛错）。
2. `src/lib/vector-client.ts`：`vectorSearch/vectorStore/vectorBulkStore/vectorDelete` 入口统一先调 `resolveScope`（CLI + MCP 共同咽喉，开引擎前 fail-fast）。
3. `src/lib/mcp-tools/*.ts`（全 8 工具）：`scope: z.string()` → `.optional().default('default')`，保证 `default` 档零摩擦。

**验证**：tsc --noEmit 无错；`resolveScope` default/strict 八项行为断言全 PASS；`test:scope-isolation` 真实链路 5/5 通过。

**已知残留（接受）**：（a）`strict` 拦不住「传了合法但错的 scope」（见 S-01 §3.5）；（b）`ki_manage_index_create` 仅建 `group-index.json`（纯 FS，不经 vector-client），故 strict 白名单校验对它不生效（字符集仍由 `validateScope` 守）；如需严格可后续在 `executeManageCreate` 补调 `resolveScope`。

## 四、无需迁移（无 mem 依赖，刻意保留在 `scripts/`）

以下命令为纯文件 / 配置操作，不触碰向量层，不在 mem→zvec 范围内：`config`、`setup`、`export`、`backup`、`migrate-keywords`。**已于 2026-07-22 拷贝到 `src/` 并统一入口**（见 §三 2）），`scripts/` 原件冻结保留。

## 五、收尾建议顺序

1. ~~**补 `package.json` 的 `files`**~~ ✅已完成（2026-07-22）。
2. ~~清理 `import.ts`/`incremental.ts` 的 mem 文案~~ ✅已完成（2026-07-22）。
3. ~~统一 `package.json` scripts 与 5 个非 mem 命令到 `src/`~~ ✅已完成（2026-07-22）。
4. ~~全部完成后方可移除 `scripts/lib/mem-client.ts` 及外部 `mem` CLI 依赖~~ **阻塞已消除**（2026-07-22 测试已与 `scripts/` 解耦，见 §三 4）。仅剩「删除 `scripts/` 目录」这一物理动作，因当前约定「`scripts/` 不改」而暂缓，可择机执行。

## 六、当前 `bin/ki.mjs` 接线对照

| 已指向 `src/`（走 zvec） | 仍指向 `scripts/`（无 mem） |
|---|---|
| scan-kb, import-kb, restore, manage-index, query-group, get-module-info, sync-relation, delete-relation, mcp, search, store, bulk_store, migrate-keywords, setup, config, backup, export | （无，`bin/ki.mjs` 全部命令已指向 `src/`；`scripts/` 仅剩冻结代码与旧测试引用） |
