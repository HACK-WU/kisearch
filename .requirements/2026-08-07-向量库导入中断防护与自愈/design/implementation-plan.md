---
id: REQ-20260807-001
feature: 向量库导入中断防护与自愈
status: 实施中
created: 2026-08-08
updated: 2026-08-08
version: 2
tags: [fix, vector, search]
depends_on: []
author: AI
document_type: design
---

# 分批实现计划：向量库导入中断防护与自愈（方案 D）

> 关联需求：REQ-20260807-001（v9，REQ-01~09 + 推演问题 1-5 + N1-N5 全部闭环）
> 前置产物：requirement.md（v9）、reference/code-survey.md、demo/verify-report.md（15/15 通过）、review/scenario-rehearsal.md（2 轮推演问题已全部回写）
> 创建方式：跳过 design-craft，按依赖分批直接实现

## 1. 分批原则

1. **基础先行、消费后置**：清洗基础（批次 1）→ 数据模型（批次 2）→ 导入链路（批次 3）→ 恢复防护（批次 4）→ 召回/hook（批次 5）→ 配套（批次 6），任意批次后系统仍可用
2. **依赖驱动**：clean.ts 无下游依赖先建；方案 D 数据模型（local KB 文件原文 + memoryIds 多值）是核心契约，导入/召回都依赖它
3. **测试同步**：每批完成即跑相关测试（demo 已在批次 2 前验证核心链路 15/15）
4. **每批可验证**：每批有独立验收点，可提交可回滚
5. **存量不兼容**：方案 D 变更数据模型，旧库（chunk 级 relation/无 memoryIds）不兼容，**本计划不含存量迁移**（用户确认重建）

## 2. 批次划分

| 批次 | 需求 | 内容 | 涉及文件（主要） | 验收点 | 风险 |
|------|------|------|-----------------|--------|------|
| 0 | 基线 | 现有测试基线 + git 提交 | - | `npm run test:all` 全绿（340/340） | - |
| 1 | REQ-06 清洗基础 | **clean.ts 内置清洗规则**（BOM/frontmatter/mermaid/代码块先剥→路径/空行/空chunk）+ `--no-clean` + `--clean-rules` + `cleanVersion` 记录 | `src/lib/clean.ts`（新建）、`src/scan-kb.ts`（参数）、`src/lib/config.ts`（schema） | 单测覆盖 7 规则 + 顺序约束（代码块先于路径）；`--clean-rules` 独立开关生效 | 低 |
| 2 | REQ-06 数据模型 | **方案 D 核心**：local KB 文件级原文（一个文件一条，key=文件级 relation）+ relation-cache 文件级 relation 挂 `memoryIds` 多值 + `sourcePath` 无 `#N` + relation-map 多值聚合反查 + `get-module-info` 文件级读取 + 冲突跳过 | `src/lib/import.ts`、`src/lib/relation-map.ts`、`src/get-module-info.ts`、`src/lib/diff.ts`（buildMemoryIdMap 字段直读） | demo 用例迁移为单测：多 chunk 文件 memoryIds 多值 + 任一命中返原文去重 + 字段直读与 #N 聚合等价；冲突跳过。**chunker 不改**（生产 `chunker.ts` 已有段落边界 + 500 上限，demo 仅验证行为一致） | 高 |
| 3 | REQ-06/08/05 | **导入链路重构**：import/incremental 按方案 D 流程（前置检查→写文件原文→清洗→切分→向量化→回填）+ REQ-08 格式白名单/大小限制（config maxFileSize 默认 1MB）+ 非 md 汇总提示 + REQ-05 进度（**仅 O-01/02/03/05**：文件数分母 + local KB 写入口径 + Promise.all 串行简化 + 向量化分批提交（O-03，batch-vectorize）+ 非 TTY 降级；**O-04 清洗已由批次 1 承担**）+ **sync-relation `--no-vector` 对齐**（非向量化时 memoryIds 空、不可 search 召回，与 REQ-06 语义一致） | `src/lib/import.ts`、`src/lib/incremental.ts`、`src/lib/batch-vectorize.ts`（O-03 分批提交 + 批间进度）、`src/lib/clean.ts`（hook 接入点）、`src/lib/config.ts`、`src/scan-kb.ts` | 端到端导入：local KB 文件原文 + memoryIds 回填；非 md/>1MB/冲突跳过 + 反馈；进度 ≤100%；向量化批间进度可见；--no-vector 仅跳向量、KB 必写；sync-relation 非向量化语义对齐 | 高 |
| 4 | REQ-01/02/03/04 | **中断防护**：SIGINT/SIGTERM 捕获写标记（SIGKILL probe 兜底双路径）+ getEngine 前置检测 + probe 提示增强 + 标记生命周期（重建/full/incremental 成功/手动清除）+ 并发锁文件（SIGKILL 残留清理）+ REQ-04 双中断测试 | `src/lib/import.ts`、`src/lib/vector-client.ts`、`src/zvec-engine/engine.ts`、`src/lib/backup.ts`、`test/` | SIGTERM 写标记引导；SIGKILL probe 兜底；rebuild 后标记清除；残留锁自动清理 | 中 |
| 5 | REQ-09/07 | **原文召回 + 清洗 hook**：`ki_search` `include_original`（默认 true）/CLI `--include-original`/`--no-original` + originalHint 降级去重 + sync-relation 无 memoryIds 兼容；REQ-07 config 注入 hooks（stdin→stdout 管道、超时 10s、P-7 回滚、N5 子进程管理） | `src/search.ts`、`src/ki-search.ts`、`src/lib/relation-map.ts`、`src/lib/clean.ts`、`src/lib/config.ts` | search 默认返回文件原文去重；失败 originalHint 不抛错；hook 失败回滚 + 中断终止子进程无孤儿 | 中 |
| 6 | 配套 | docs 同步（cli.md/scan-kb.md/README 清洗与一对多语义、中断引导、格式限制）+ 测试收尾（新增用例全量回归） | `docs/*`、`test/*` | 文档无旧 chunk 级描述；`npm run test:all` 全绿 | 低 |

## 3. 批次依赖图

```
批次0 (基线)
  ↓
批次1 (clean.ts 清洗基础) ──→ 批次2 (方案D 数据模型) ──→ 批次3 (导入链路重构+REQ08/05)
                                                              ↓
                                                        批次4 (中断防护 REQ01-04)
                                                              ↓
批次5 (REQ09 召回 + REQ07 hook) ←─────────────── (REQ09 原文召回依赖批次2；originalHint 去重依赖批次4)
  ↓
批次6 (配套: docs + 测试收尾)
```

**依赖说明**：
- 批次 1 无依赖（clean.ts 独立新建）
- 批次 2 依赖批次 1（方案 D 流程含清洗）；demo 已验证核心数据模型
- 批次 3 依赖批次 2（导入链路消费新数据模型）；REQ-08/05 随导入重构落地
- 批次 4 依赖批次 3（中断防护作用于导入链路）
- 批次 5 依赖批次 2（原文召回依赖文件级原文 + memoryIds）+ **批次 4（REQ-09 `originalHint` 去重依赖 REQ-02 引导文案）**；REQ-07 hook 部分依赖批次 1（clean.ts）+ 批次 3（hook 接入点）
- 批次 6 依赖全部

## 4. 关键实现要点（批次内）

### 批次 1（clean.ts）
- `cleanMarkdownText(text, rules)`：7 条规则，**执行顺序约束**——代码块先剥（keepShortSamples 保留 ≤15 行原样）→ 路径剥离仅代码块外 → 空行折叠 → 空 chunk 过滤
- 路径剥离：先剥行号（`#L\d+(-\d+)?` 含 `-L\d+` 兜底）→ 剥 `file://`/markdown 链接/裸路径（`(?![\w-])` 防残留）→ 空 inline code 清理 → 孤儿标题清理（"本文引用的文件"类）
- 异常兜底：`normalize('NFC')` try-catch 降级返回原文
- `cleanVersion` 记录到 source 块（规则变更提示重建，防增量/全量不一致）

### 批次 2（方案 D 数据模型）
- local KB：`localKb[group][文件级relation] = 文件原文`（一个文件一条）
- relation-cache：文件级 relation 挂 `memoryIds: string[]` + `sourcePath`（文件路径无 `#N`）
- `relation-map.ts`：`memoryId → {group, relation}` 多值聚合（多个 chunk memoryId → 同一文件级 relation）
- `diff.ts buildMemoryIdMap`：**字段直读** `Map<文件路径, memoryId[]>`（去重保留，`diff.ts:107` 语义）+ 无字段 relation 返回空
- `get-module-info.ts`：按文件级 relation 取整文件原文
- 冲突跳过：同 group 同名文件 → 跳过 + 反馈（前置检查在写 local KB 前）

### 批次 3（导入链路 + REQ-08/05 + sync-relation 对齐）
- import/incremental 流程：**前置检查**（格式/大小/冲突，先于写 local KB）→ 写文件原文 → 清洗 → 切分 → 向量化 → 回填 memoryIds
- REQ-08：`collectMarkdownFiles` 白名单 `[.md]`（config `import.extensions`）+ 非 md 汇总提示；`maxFileSizeBytes` 从 config（默认 1MB）
- REQ-05（**仅 O-01/02/03/05**，O-04 归批次 1）：进度分母 = 文件数（O-01）；进度按 local KB 写入完成计（意见3）；Promise.all 简化（O-02，local KB 前置后无并行冲突）；**batch-vectorize 分批提交 + 批间进度（O-03，如 200 条/批）**；非 TTY 降级（O-05）
- `--no-vector`：仅跳向量写入，local KB 照写，memoryIds 空
- **sync-relation `--no-vector` 对齐**：非向量化时 memoryIds 空、不可 search 召回，与 REQ-06 语义一致（既有决策，批次 3 同步确认）
- **P-2 删旧原子顺序**：先删后更（基于旧 memoryIds 删旧 → 成功更新字段）；部分失败 → 字段保持旧值 + id 清单告警 + 增量未完成标记

### 批次 4（中断防护）
- REQ-01：SIGINT/SIGTERM 捕获写标记（含进度/时间）；**SIGKILL 不可捕获 → REQ-03 probe 兜底**（双路径）
- REQ-02：`getEngine` 前置检测标记 + probe 异常 → 引导；**触发范围**：所有打开向量库命令，纯 KB 命令不触发；**标记清除**：rebuild 成功 / full 成功 / incremental 成功 / 手动
- REQ-03：`lockedHint` 补"崩溃残留可重建"恢复引导
- 并发锁：`<scope>/.import.lock`（pid+时间）；正常完成删除；SIGKILL 残留 → pid 不存在自动清理 + 警告
- REQ-04：双中断测试（SIGTERM 标记路径 / SIGKILL probe 路径）

### 批次 5（REQ-09 + REQ-07）
- REQ-09：`ki_search` `include_original`（默认 true）+ CLI `--include-original`/`--no-original`；原文 = local KB 文件级原文（REQ-06 同源）；多 chunk 命中去重；失败 → `originalRetrieved:false` + `originalHint`（**与 REQ-02 引导去重**，精简文案——依赖批次 4 的 REQ-02 引导实现）；sync-relation 无 memoryIds 字段 → 返回空 + 原文仍可经 local KB 获取
- REQ-07：config `scopes.<scope>.clean.hooks` 注入；stdin→stdout 管道；超时 10s；**P-7 回滚**（hook 失败删除 local KB + skipped）；**N5**（中断同步终止 hook 子进程 SIGTERM→SIGKILL；中断文件走中断标记不触发 P-7）——依赖批次 1（clean.ts 接入点）+ 批次 3（导入链路 hook 挂载点）

### 批次 6（配套）
- docs：cli.md/scan-kb.md/README 补方案 D 语义（一对多、清洗、格式限制、中断引导、原文召回）
- test：新增用例全量回归（双路径/标记清除/删旧部分失败/锁残留/hook 子进程/混用语义/组合开关）

## 5. 每批完成检查

- [ ] 相关 lint 零错误
- [ ] 相关测试通过（`npx jiti test/<name>.test.ts` 或 `node --test`）
- [ ] 手动 CLI 验收（每批的验收点）
- [ ] `req update REQ-20260807-001 --changelog "批次N完成：..."` 记录（req CLI 不可用时手动更新 meta.json）
- [ ] git 提交（每批独立提交，可回滚）

## 6. 变更记录

- 2026-08-08 v1：创建分批实现计划（7 批：基线/清洗/数据模型/导入链路/中断防护/召回+hook/配套）
- 2026-08-08 v2：批次合理性修正——批次 5 依赖批次 4（originalHint 去重）；批次 2 明确 chunker 不改（仅验证行为一致）；批次 3 REQ-05 仅 O-01/02/03/05（O-04 归批次 1）+ sync-relation --no-vector 对齐；批次 5 hook 依赖批次 1/3 明示
- 2026-08-08 v3：第三轮检查——批次 3 补 `src/lib/batch-vectorize.ts`（REQ-05 O-03 分批提交 + 批间进度），文件归属补全
- 2026-08-08 v4：**全部批次实现完成（0-6）**——clean.ts（7 规则+顺序约束+parseCleanRules）；方案 D 数据模型（文件级 relation+memoryIds 多值+buildMemoryIdMap 字段直读+relation-map 多值）；导入链路重构（前置检查→写文件原文→清洗→切分→向量化→回填）；REQ-08 格式白名单+1MB config；REQ-05 进度（文件数分母+串行+batch-vectorize 分批+TTY 降级）；REQ-01/02/03/04 中断防护（SIGINT/SIGTERM 标记+SIGKILL probe 双路径+标记生命周期+并发锁）；REQ-09 原文召回（include_original+originalHint 去重）；REQ-07 hook（stdin→stdout 管道+超时+P-7 回滚）；docs 同步（scan-kb/query-kb）；新增测试（interrupt 5+clean-hook 4）；**全量测试 exit 0 全绿**
- 2026-08-08 v5：code-review 修复——#M1 中断标记带真实进度（importedFileCount/totalFileCount）+ 中断路径只清锁保留标记（新增 clearImportLock，避免 releaseImportLock 误清标记）；#M3 去重命中置 originalRetrieved:true + deduplicated 标记（不再误判失败）；P1-1 删 clean.ts 死代码 CODE_FENCE_LANG；全量测试 exit 0
- 2026-08-08 v6：测试补齐——新增单测（search-original 4、memory-id-map 6、import-scheme-d 4，覆盖原文召回/buildMemoryIdMap 字段直读/方案 D 导入/格式限制）+ e2e（scheme-d-cli 4，真实 embedding 黑盒验证 local KB 原文/原文召回/--no-vector/非 md 跳过）；修复 stats.skipped 未含冲突文件计数；全量测试 exit 0 全绿
- 2026-08-08 v7：真实 Wiki 体验（143 文件，tests/e2e/experience/reports/）发现并修复 2 个 P0——① full 重导幂等：冲突检测增加 sourcePath 区分（同文件重导幂等覆盖，不同文件同名才真冲突）；② bin/ki.mjs 信号透传（spawn + SIGTERM/SIGINT 转发，否则导入中断标记机制在真实 CLI 链路失效）；import-scheme-d 用例适配；全量测试 exit 0
