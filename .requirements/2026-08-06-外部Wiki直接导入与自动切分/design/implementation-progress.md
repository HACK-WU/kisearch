# 实施进度追踪（外部Wiki直接导入与自动切分）

> 需求：REQ-20260806-001（实施中）
> 最近更新：2026-08-07（批次 5 + 技术设计遗留项完成）
> 本文件与 `AGENTS.md` 变更记录同步维护，作为需求目录内的进度快照。

## 1. 总览（按分批计划 6 批）

| 批次 | 内容 | 状态 | 说明 |
|------|------|------|------|
| 0 | 基线检查 | ✅ 完成 | lib 28/28、scan-kb、import-kb 全绿 |
| 1 | 切分器 + 直导核心（REQ-01/02/03/07） | ✅ 完成 | chunker + handleDirectImport + `import --source`，KB 层端到端验证通过 |
| 2 | 增量直连（REQ-06/08） | ✅ 完成 | git diff 驱动 + 方案②多值映射 + 写序修复，add/delete/modified KB 层验证通过 |
| 3 | 删除旧链路（REQ-04/05/09/13） | ✅ 完成 | ai-results/keywords/isFullText/scan/from-results/migrate-keywords/import-kb/vectorize/bulk_store 全部清理（提交 b6f8ea9） |
| 4 | CLI 简化（REQ-10/11/12） | ✅ 完成 | 短别名、位置参数、sync_relation 超长警告（提交 b778074） |
| 5 | 配套（REQ-14/15） | ✅ 完成 | docs 16 个 + skills 5 个同步、fixtures 清理、测试重构、全量 339/339 全绿 |

**批次 0~5 全部完成**。技术设计遗留项已收尾（P-5 清点通过 / P-7 chunk 上限 / 向量库重建+路径向量补验），剩余 P-6（FTS 规模实测，性能验证可选）。REQ-002 独立需求已完成。

## 2. 已实施明细

### 批次 1（切分器 + 直导核心）

| 文件 | 变更 |
|------|------|
| `src/lib/chunker.ts`（新建） | `splitIntoChunks` 递归字符切分（固定长度 + 段落边界优先 `\n\n→\n→。→；`），overlap 逻辑修复（`nextStart = max(pos+1, cut-overlap)` 保证推进） |
| `test/chunker.test.ts`（新建） | 9 用例全绿 |
| `src/lib/import.ts` | `handleDirectImport`（复用 5-Phase 后半段）+ `HandleDirectImportArgs` + `collectMarkdownFiles`（递归/跳过隐藏与 node_modules）+ 导出 `deriveChunkRelation`/`deriveChunkSourcePath`/`readFileToChunks` |
| `src/lib/ai-results.ts` | `deriveGroupPath` 导出；`ScanResultEntry` 加 `chunkRelation` 字段 |
| `src/lib/scope.ts` | `GroupIndexSource` 加 `chunkSize/chunkOverlap`；`setSource` 允许 commit 为空（直导非 git 场景） |
| `src/lib/config.ts` | `setScopeSourceDir`（H-20：仅未配置时写入绝对路径；YAML 用 parseDocument 保留注释；写回后 resetConfigCache） |
| `src/scan-kb.ts` | `import` 子命令 `--results`/`--source` 二选一 + `--chunk-size`/`--chunk-overlap` 参数 |

### 批次 2（增量直连）

| 文件 | 变更 |
|------|------|
| `src/lib/diff.ts` | `DiffEntry` 加 `memoryIds`；`buildMemoryIdMap` 改多值映射（按 sourcePath `#` 前缀聚合到文件级 key，兼容无 `#` 旧数据） |
| `src/lib/incremental.ts` | `handleIncrementalDirect`（4-Phase：校验 source 块 → deleted 清理 → add/modify 向量化 → 持久化+更新 commit）+ `chunkifyFile`；modified 删旧对齐 deleted 分支（清 relations-cache/local KB/路径向量，修复 deploy-02~08 残留 bug） |
| `src/scan-kb.ts` | `--source` + `--mode incremental` 走 `handleIncrementalDirect` |

### 批次 3（删除旧链路，提交 b6f8ea9）

- 删除 `ai-results.json` 输入契约（`normalizeAiResults`/`handleImport` 的 results 模式）；`ai-results.ts` 瘦身为纯类型 `ScanResultEntry` + `deriveGroupPath`
- 删除 `keywords` 全链路（sync-relation validateKeywords/evicted/keywords_truncated、query-group 词云、migrate-keywords 命令、export/wiki frontmatter 字段）
- 删除 `isFullText` 字段（import/incremental 唯一 false 来源、search 判定、relation-map 反查字段）
- 删除 `scan` 子命令（含 scan-pending/scan-index 产物）、`restore --from-results`、`import-kb`、`scan-kb vectorize`
- `bulk_store` → `bulk-store` 改名（MCP 工具名 `ki_bulk_store` 不变）

### 批次 4（CLI 简化，提交 b778074）

- 高频参数短别名：`-s`(scope)、`-q`(query)、`-t`(text)、`-g`(group)、`-r`(relation)、`-i`(input)、`-o`(output)
- 必填文本参数位置化：`ki search "sas"`（`.argument('[query]')`，`--query` 保留兼容）
- `sync_relation` 超长 `--module-info`（>1000 字符）警告

### 批次 5（配套）

| 类别 | 内容 |
|------|------|
| 测试修复 | `test/test-config.ts` 默认模型 `text-embedding-3-small` → `Qwen/Qwen3-Embedding-8B`（SiliconFlow 无前者，导致向量化 HTTP 400）；`test/incremental-direct.test.ts` git commit 加 `-c commit.gpgsign=false` |
| fixtures 清理 | 删除 `test/fixtures/ai-results-full.json`、`ai-results-incremental.json` |
| docs 同步（16 个） | `e2e-guide.md`（直导+git diff 增量）、`update-kb.md`/`build-kb.md`/`workflows.md`（重写为直导/增量直连）、`cli.md`/`query-kb.md`/`manage-index.md`/`verify-index.md`/`architecture.md`/`tags-design.md`/`backup-restore.md`/`memory-agent-guide.md`/`codekb-agent-guide.md`/`memory-system-dataflow.md`/`vector-engine-mem.md`/`scan-kb.md`（去 keywords/词云/ai-results 旧流程，保留"已删除"说明性标注） |
| skills 同步（5 个） | `ki-foundation`/`snippet-memory`/`memory-skill`/`codekb-skill`/`update-kb` 同步（去 keywords 规则、批量改 `sync-relation --input`、增量改 git diff 直连） |

## 3. 端到端验证结果（wiki-test scope，`/root/.ki-data/wiki-test/`）

| 验证项 | 结果 |
|--------|------|
| 全量直导（4 文件 + deploy.md 大文件） | ✅ total=11；deploy.md 14.7KB → 10 chunks（deploy-01..10）；relation 命名/sourcePath/source 块持久化/memoryId 关联全正确 |
| 检索 | ✅ `ki search --scope wiki-test --query "告警收敛"` alarm-01 命中第一 |
| 增量 add（new.md）+ delete（alarm.md） | ✅ add=1/delete=1/errors=0；commit 8713b8ee→4bbfcd93；alarm-01 消失、new-01 添加、deploy chunks 保留 |
| 增量 modified（deploy 8 chunks→1 chunk） | ✅ 删旧修复后 KB 层正确 |
| 路径向量（ki-path/ki-relation）写入 | ✅ **已闭环（2026-08-07）**——向量库重建后 rebuild-vector 成功：content 137 + relation 137 + path 26 = 300 向量，failed 0；ki-path 检索命中 |
| 全量测试 `npm run test:all` | ✅ 339/339 全绿（批次 5 后） |

## 4. 已确认的关键设计落地

- **D-2/方案②**：`buildMemoryIdMap` 多值 `Map<文件path, memoryId[]>`，无新增数据文件，每次增量现场重建
- **写序**：modified 先写新全 chunk → 全部成功后再删旧（失败保留旧数据待下次增量重试）
- **D-8**：`--mode full` 重导允许更新 chunk-size（重切）；`--mode incremental` 永远用 source 块持久化值
- **D-9/H-25**：增量无 git 明确报错，不做静默降级
- **H-18**：切分参数持久化到 source 块；**H-20**：全量直导写入 scope sourceDir（绝对路径）

## 5. 阻塞点

**向量库锁异常**：
- 调试路径向量时误删 RocksDB LOCK 文件 → 集合半损坏，`ZVecOpen` 挂起不返回（引擎已知行为，probe 超时误判 locked）
- 已 pkill 挂起进程恢复现场；向量库未删除（mv 未执行）
- 处理记录：`/root/.ki/vector/LOCK`（零字节）与 `fts.2.rocksdb/LOCK`、`scalar.index.1.rocksdb/LOCK` 经 flock 测试均可获取（非真持锁），但 zvec probe 对锁文件存在即判 locked

> ⚠️ **约定**：后续所有涉及向量写入的命令必须用 `timeout 60` 包裹，禁止无超时执行。

## 6. 待办

### 技术设计遗留（批次 0~5 之外）
- [x] **P-5**：grep 清点 `scan-index|getScanIndexPath` 消费方——全库仅一处注释提及，无代码引用（✅ 2026-08-07）
- [ ] **P-6**：FTS 规模量化实测（1000 文件直导的索引构建时间/存储/延迟）——性能验证可选，需专门构造基准
- [x] **P-7**：超大文件上限——文件大小上限（2MB，`maxFileSizeBytes`）✅；单文件 chunk 数上限 `MAX_CHUNKS_PER_FILE=500` 补实现（import.ts 直导 + incremental.ts 双处防护，chunker 9/9 全绿）
- [x] **重建向量库 + 补验路径向量**：向量库 FTS 索引损坏（segment stats 加载失败）→ 备份删除 `/root/.ki/vector` → `test_data/monitor/snapshots/snapshot.20260618-021614.tar.gz` 还原 KB → `rebuild-vector` 重建 300 向量（content 137 + relation 137 + path 26，failed 0）→ 检索 / ki-path 命中 / doc list 无 FTS 报错（✅ 2026-08-07）

### REQ-20260806-002（CLI 命令迁移与规范化，独立需求）
- [ ] CLI-01~04（P0）：`--scope` 必填性统一、`--output` 三义拆分、`--tags` 默认值统一、export 补 `--yes`
- [ ] CLI-05~08（P1）：手写 argv → commander 迁移（mcp/doctor/backup/restore/export）、帮助去重、`--root-name` 语义、backup/restore 列备份统一
- [ ] CLI-09~11（P2）：命名统一、`--yes` 全命令审计、数值参数语义文档化

## 7. 相关文档索引

| 文档 | 路径 |
|------|------|
| 需求文档 | `requirement.md` |
| 数据流设计 | `design/data-flow.md` |
| 设计评审报告 | `design/design-review.md` |
| 质疑审查报告 | `review/challenge-report.md` |
| 场景推演报告 | `review/scenario-rehearsal.md` |
| 分批实现计划 | `design/implementation-plan.md` |
| 实施进度 | `design/implementation-progress.md`（本文件） |
