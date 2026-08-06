---
id: REQ-20260806-001
feature: 外部Wiki直接导入与自动切分
status: 实施中
created: 2026-08-06
updated: 2026-08-06
version: 1
tags: [feat, cli]
depends_on: []
author: AI
document_type: design
---

# 分批实现计划：外部 Wiki 直接导入与自动切分

> 关联需求：REQ-20260806-001（v7，15 条需求 + 26 项假设）
> 前置产物：data-flow.md（已评审+质疑+推演，全部问题已修复）
> 创建方式：跳过 design-craft，按依赖分批直接实现

## 1. 分批原则

1. **新增先行、删除后置**：批次 1~2 新增直导/切分/增量能力（不动现有 ai-results 路径），批次 3 才删除旧链路——保证任意批次后系统仍可用
2. **依赖驱动**：REQ-01 → 02 → 03/07/08 → 06；删除（04/05/09）依赖直导替代就位
3. **测试同步**：每批完成即跑相关测试（REQ-15 随批推进，非末尾集中）
4. **每批可验证**：每批有独立验收点，可提交可回滚

## 2. 批次划分

| 批次 | 需求 | 内容 | 涉及文件（主要） | 验收点 | 风险 |
|------|------|------|-----------------|--------|------|
| 0 | 基线 | 现有测试基线 + git 提交 | - | `npm run test:all` 全绿 | - |
| 1 | REQ-01/02/03/07/08 | **切分器 + 直导核心（纯新增）**：chunker.ts 递归字符切分；import.ts 新增直导分支（handleDirectImport 复用 Phase2-5）；scan-kb import 支持 `--source`；relation=`foo-01`/sourcePath=`foo.md#N`；`--chunk-size/--chunk-overlap` + source 块持久化 | `src/lib/chunker.ts`（新建）、`src/lib/import.ts`、`src/scan-kb.ts`、`src/lib/ai-results.ts`（ScanResultEntry 扩展） | 直导 10 文件（含 5000 字大文件）成功；chunk relation 命名正确；source 块含 chunkSize | 低 |
| 2 | REQ-06/08 | **增量直连（git diff 驱动）**：`--mode incremental` 复用 handleDiff；`buildMemoryIdMap` 多值化 `Map<文件, memoryId[]>`；写序"先写新后删旧"；无 git 明确报错（D-9）；增量用 source 块参数（D-8） | `src/lib/incremental.ts`、`src/lib/diff.ts`、`src/lib/import.ts`、`src/scan-kb.ts` | 文件变更→全 chunk 覆盖/删除正确；source.commit 更新 | 中 |
| 3 | REQ-04/05/09/13 | **删除旧链路**：删 ai-results 输入契约 / scan 子命令 / restore --from-results / keywords 全链路（含 sync-relation 校验、query-group 词云、migrate-keywords、export/wiki frontmatter）/ isFullText / import-kb / vectorize / bulk_store 改名 | `src/lib/ai-results.ts`（删）、`src/scan-kb.ts`、`src/restore.ts`、`src/lib/sync-relation.ts`（改）、`src/query-group.ts`、`src/export.ts`、`src/lib/markdown-gen.ts`、`src/migrate-keywords.ts`（删）、`src/import-kb.ts`（删）、`src/lib/batch-vectorize.ts`、`src/lib/rebuild-vector.ts`、`src/lib/relation-map.ts`、`src/search.ts`、`src/lib/backup.ts`、`bin/ki.mjs` | 代码无 normalizeAiResults/backupAiResults/isFullText/keywords 依赖；`npm run test:all` 重构后全绿 | 高 |
| 4 | REQ-10/11/12 | **CLI 简化**：sync_relation 超长 module-info 警告；高频参数短别名；必填文本位置参数（option 保留兼容） | `src/search.ts`、`src/store.ts`、`src/sync-relation.ts`、`src/scan-kb.ts`、`src/query-group.ts` 等 | `ki search "sas"` / `-s` 可用；旧 option 调用不报错 | 中 |
| 5 | REQ-14/15 | **配套**：docs 17 + skills 5 文档同步（可独立任务）；test 重构收尾（新增直导/切分/增量测试）+ fixtures 清理 | `docs/*`、`skills/*`、`test/*` | 文档无旧流程描述；`npm run test:all` 全绿；无 ai-results 夹具 | 低 |

## 3. 批次依赖图

```
批次0 (基线)
  ↓
批次1 (切分器+直导核心) ──→ 批次2 (增量直连) ──→ 批次5 (配套: 文档+测试收尾)
  ↓                                      ↑
批次3 (删除旧链路) ───────────────────────┘
  ↓
批次4 (CLI 简化)
```

**依赖说明**：
- 批次 2 依赖批次 1（增量需直导的切分能力与 sourcePath）
- 批次 3 依赖批次 1（直导替代就位后才能删 ai-results）
- 批次 4 依赖批次 3（命令清单稳定后做 CLI 简化）
- 批次 5 的 test 重构随批次 1~4 同步推进，文档同步可独立并行

## 4. 关键实现要点（批次内）

### 批次 1
- `chunker.ts`：`splitIntoChunks(text, {chunkSize, overlap}) → Chunk[]`，分隔符优先级 `\n\n > \n > 。 > ； > 硬切`；返回 `{text, index}`（sourcePath 由调用方拼 `文件#index`）
- `import.ts` 新增 `handleDirectImport(args)`：读目录 → 逐文件切分 → 构造瘦身 ScanResultEntry（`{path, groupPath, memoryId}` + chunk text）→ 复用 phase2~5
- relation 生成：`deriveChunkRelation(fileBase, index)` = `${fileBase}-${pad(index)}`
- source 块：`recordSource` 增加 `chunkSize/chunkOverlap` 字段（缺失回退默认）

### 批次 2
- `diff.ts`：`buildMemoryIdMap` 返回 `Map<string, string[]>`（按 `foo.md#` 前缀聚合）
- `incremental.ts`：modified 先写新全 chunk → 成功删旧；deleted 按文件删全 chunk；复用 source 块参数；无 git 报错
- `handleDiff` 的 DiffEntry 增加文件级 sourcePath 支持

### 批次 3
- 逐一清理：`normalizeAiResults` → 删；`scan` 子命令 → 删；`restoreFromResults`/`backupAiResults` → 删；sync-relation keywords 校验 → 删；query-group 词云 → 删；markdown-gen/export/wiki frontmatter keywords → 删；isFullText 全链路 → 删；migrate-keywords/import-kb/vectorize → 删；bulk_store → bulk-store
- 每删一处同步更新引用与测试

### 批次 4
- 短别名：commander `.option('-s, --scope <s>')` 等；避让 `-t`（setup 已用）
- 位置参数：`.argument('<query>')` + option 兼容；优先级"位置参数优先"

## 5. 每批完成检查

- [ ] 相关 lint 零错误
- [ ] 相关测试通过（`npx jiti test/<name>.test.ts` 或 `node --test`）
- [ ] 手动 CLI 验收（每批的验收点）
- [ ] `req update REQ-20260806-001 --changelog "批次N完成：..."` 记录
- [ ] git 提交（每批独立提交，可回滚）

## 6. 变更记录

- 2026-08-06 v1：创建分批实现计划（6 批：基线/切分直导/增量/删除/CLI/配套）
