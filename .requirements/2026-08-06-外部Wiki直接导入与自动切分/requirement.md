---
id: REQ-20260806-001
feature: 外部Wiki直接导入与自动切分
status: 已确认
created: 2026-08-06
updated: 2026-08-06
version: 7
tags: [feat, cli]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析报告：外部 Wiki 直接导入（原文直导 + 自动切分 + 移除 AI 依赖 + CLI 简化）

## 1. 原始需求描述

> 当前 CLI 缺少"直接导入外部 Wiki"功能，导入必须依赖 AI 生成的 ai-results.json。希望 `scan-kb import` 直接吃外部 Markdown 目录；大文档自动切分（内存中执行，无需独立命令），relation 名加 `-01/-02` 后缀。
>
> 迭代确认：
> - ai-results.json 导入功能冗余（应用场景太小），**直接删除**
> - 关键词（keywords）机制**一并删除**（搜索质量依赖向量引擎；agent 实际使用中几乎不用，索引不再显示关键词）
> - **isFullText 字段取消**（唯一 `false` 来源是 ai-results 摘要，删除后失去区分度，全部为全文）
> - **增量更新必须保留**，改由 git diff 驱动 + 原文向量化
> - **CLI 简化（范围 A + B）纳入本次**：短参数 + 位置参数 + 本次改造顺带的命令清理
> - **核对后确认**：`scan` 子命令删除、restore `--from-results` 删除、文件变更→该文件全部 chunk 覆盖更新、切分参数持久化、MCP 工具名不变（数据结构同步）、全量直导写入 scope sourceDir（绝对路径）
> - **第 2 轮核对确认**：`migrate-keywords` 命令随 keywords 一并删除；export/wiki 写回 frontmatter 的 `keywords` 字段彻底删除；docs/skills 文档同步更新或标注废弃（拆独立任务）；test 30+ 文件与 fixtures 纳入本次改造

## 2. 需求澄清

### 2.1 需求形态
真实需求。底层诉求：
1. 让外部 Wiki 在不经过 AI 摘要的情况下进入 KiSearch 检索，**彻底移除 AI 依赖**
2. CLI 命令简化——短参数、位置参数、顺带清理废弃/命名不规范的命令

### 2.2 功能本质
- `scan-kb import` 的输入从"AI 结构化摘要（ai-results.json）"扩展为"原始 Markdown 目录"，导入链路中自动完成大文档切分（内存中执行）
- 移除 ai-results.json / keywords / isFullText 机制；删除 `scan-kb scan` 子命令与 restore `--from-results` 模式
- 增量更新改由 git diff 直接驱动（文件级 diff → 该文件全部 chunk 覆盖更新）
- CLI 简化：高频参数短别名 + 必填文本参数位置化 + 本次改造触碰的命令清理

### 2.3 使用场景与角色
- 场景 1：无 AI 环境的用户，直接导入现有 Markdown Wiki（快速初始化）
- 场景 2：已有高质量 Wiki（结构清晰），跳过 AI 摘要的二次加工
- 场景 3：大规模批量导入（AI 成本/时延太高，先全文入库）
- 场景 4：知识库持续演进时的增量更新（git diff 驱动，无 AI 参与；文件变更→该文件 chunk 全量覆盖）
- 场景 5：日常 CLI 使用——短参数 / 位置参数提升输入效率
- 场景关联性：全量直导与增量直连共享"读原文 → 切分 → 向量化"核心，差异仅在是否先 diff

**用户角色**：CLI 开发者 / 知识库管理员

### 2.4 核心痛点
1. 无 AI 环境或不想依赖 AI 时，知识无法进入系统
2. 语义检索摘要意义不大（向量 content 是摘要而非原文），不如直接索引原文
3. agent 实际使用中几乎不使用关键词/词云功能（利用率低，冗余）
4. CLI 输入繁琐：`ki search --query "sas"` 必须显式写出 `--query`，不能 `ki search "sas"`；高频参数无短别名

### 2.5 期望体验
- `ki scan-kb import --source <wiki-dir> --scope <s> --root-name <n>` 直接导入整个 Wiki，大文档自动切分，无任何 AI 产物
- `ki scan-kb import --source <dir> --scope <s> --mode incremental` 基于 git diff 增量更新，无 AI 参与
- `ki search "sas"` / `ki search -s <scope> "sas"` 位置参数 + 短别名可用
- 语义检索直接命中原文 chunk；索引/查询结果不再显示关键词词云

### 2.6 深层动机
- 降低知识入库门槛——把"AI 是必要环节"的架构假设改为"AI 无关"
- 摘要检索质量差（实践反馈）：向量化应索引原文而非摘要
- 精简系统复杂度：删除应用场景过小的功能（ai-results / keywords / isFullText / scan / from-results）
- CLI 可用性提升：短参数 + 位置参数降低使用摩擦

### 2.7 非功能性需求
- 性能：数千文件导入可接受（复用批量向量化 + 断点续跑）
- 兼容性：
  - 不破坏现有已导入数据的读取（relations-cache / local KB 结构兼容，旧字段只读不消费）
  - **CLI 简化向后兼容**：`--query`/`--text` 等 option 保留（位置参数为新增，不破坏现有脚本调用）
  - **MCP 工具名保持不变**（`ki_bulk_store` 等），仅返回数据结构同步变更
- 可用性：命令参数与现有 `scan-kb` 风格一致

### 2.8 关键假设（已确认）
| 假设 | 内容 | 状态 |
|------|------|------|
| H-01 | Wiki 是 Markdown 目录 | ✅ 确认 |
| H-02 | 直接导入 = 原文全文入库（非摘要） | ✅ 确认 |
| H-03 | 新增 `--source` 路径（缺省 `--results` 时走原文直导） | ✅ 确认 |
| H-04 | groupPath 从目录结构推导，relation 从文件名推导 | ✅ 确认 |
| H-05 | 大文档自动切分，内存执行，无独立命令 | ✅ 确认 |
| H-06 | relation 名 = 文件名 + `-01/-02` 后缀 | ✅ 确认 |
| H-07 | 切分触发条件 = 长度阈值（非段落数），`\n\n` 仅作切点偏好 | ✅ 确认 |
| H-08 | **删除 ai-results.json 导入**（应用场景太小） | ✅ 确认 |
| H-09 | **删除 keywords 机制**（含 sync_relation 关键词校验/词云、query-group 关键词显示） | ✅ 确认 |
| H-10 | **增量更新保留**，改由 git diff 驱动 + 原文向量化 | ✅ 确认 |
| H-11 | **取消 isFullText 字段**（唯一 false 来源被删，失去区分度） | ✅ 确认 |
| H-12 | **sync_relation 不引入切分**（单条关系语义；超长 module-info 仅警告） | ✅ 确认 |
| H-13 | **CLI 范围 A**：高频参数短别名 + 必填文本参数位置化（option 保留兼容） | ✅ 确认 |
| H-14 | **CLI 范围 B**：本次改造顺带清理（import-kb / vectorize / bulk_store 命名等） | ✅ 确认 |
| H-15 | **删除 `scan-kb scan` 子命令**（含 scan-pending/scan-index 中间产物，无 AI 流程后冗余） | ✅ 确认 |
| H-16 | **删除 restore `--from-results` 模式**（ai-results 备份不再产生；存量备份不重放） | ✅ 确认 |
| H-17 | **文件变更 → 该文件对应的全部 chunk relation 直接覆盖更新**（不精确定位单 chunk，文件级重切重写） | ✅ 确认 |
| H-18 | **切分参数持久化**：`--chunk-size/--chunk-overlap` 记录到 source 块（或独立元数据），增量自动复用保证跨次一致 | ✅ 确认 |
| H-19 | **MCP 工具名保持不变**（`ki_bulk_store` 等），返回数据结构同步变更 | ✅ 确认 |
| H-20 | **全量直导写入 scope sourceDir**：scope 未配置 sourceDir 时写入（绝对路径），供增量免传 `--source` | ✅ 确认 |
| H-21 | **`migrate-keywords` 命令删除**：其迁移目标字段（Group.keywords）随 keywords 机制删除，命令失去意义 | ✅ 确认 |
| H-22 | **export/wiki 写回 frontmatter 移除 `keywords` 字段**（`markdown-gen.ts` 的 `keywords` 参数、`export.ts` 的 `rel.keywords`、`wiki-sync.ts` 的 keywords 传参一并移除），frontmatter 只留 groupPath/relation/exportedAt | ✅ 确认 |
| H-23 | **docs/（17 个）与 skills/（5 个）文档同步更新或标注废弃**：含 keywords/词云/ai-results 描述的内容更新为直导/增量新流程；**拆分为独立文档更新任务**（不在核心开发批次内） | ✅ 确认 |
| H-24 | **test/ 30+ 文件与 fixtures 纳入本次改造**：删除功能必须同步删除/重构相关测试（sync-relation / query-group / migrate-keywords / scan-kb / import-kb 等），删除 `test/fixtures/ai-results-*.json` 等夹具 | ✅ 确认 |
| H-25 | **无 git 仓库时增量明确报错**（提示先 git init 或改用 --mode full），不做静默降级全量 | ✅ 确认（场景推演 #1 修复） |
| H-26 | **切分参数变更语义**：`--mode full` 重导允许更新 chunk-size（重切受影响文件）；`--mode incremental` 永远用 source 块持久化值（命令行传参忽略） | ✅ 确认（场景推演 #2/#3 修复） |

## 3. 根本性分析

### 3.1 核心问题
知识入库路径被 AI 环节阻塞，且摘要向量化检索质量低于原文；关键词/词云功能利用率低；CLI 输入繁琐。

### 3.2 根因链
- 导入链路以 ai-results.json 为唯一输入 → AI 是必经环节 → 无 AI 环境则无法入库
- `buildVectorizeContent` 返回 `entry.summary`（摘要）→ 向量 content 是摘要 → 语义检索命中摘要而非原文 → 细节丢失、检索质量差
- 关键词机制依赖 AI 生成 → AI 缺失时无关键词 → BM25 靠原文词汇（但向量引擎是主要召回路径）
- isFullText 的唯一 `false` 来源是 ai-results 摘要 → 删除 ai-results 后字段失去区分度
- `scan` 子命令是 ai-results 流程的前置（scan-pending → AI → scan-index）→ AI 删除后冗余
- CLI：16 命令用 commander、5 个手写 argv；短别名仅 setup 有；必填参数全部走 option 无位置参数

### 3.3 方案评估
**方案对症（情况 A）**。删除 ai-results + keywords + isFullText + scan + from-results，原文直导 + git diff 增量，从根本消除 AI 依赖；CLI 范围 A/B 简化提升可用性。方案合理，直接转译。

### 3.4 预期效果分析
- **核心场景覆盖度**：高（全量直导 + 增量直连 + 无 AI 依赖全覆盖）
- **痛点解决程度**：高（彻底打通无 AI 入库路径 + 向量化索引原文提升检索质量 + 移除低利用率功能 + CLI 输入效率提升）
- **用户体验提升**：一条命令完成导入；增量 git diff 驱动免 AI；语义检索直接命中原文；`ki search "sas"` 短参数可用
- **潜在副作用**：
  - BM25 全文召回失去 AI 关键词增强（已接受：向量引擎是主召回路径）
  - query-group 不再显示关键词词云（已接受：agent 几乎不用）
  - chunk 粒度 relation 使 `get-module-info` 只返回部分内容（已确认影响不大）
  - 文件变更 → 全 chunk 覆盖更新会有冗余重写（已接受：chunk 量小、幂等 upsert）
  - 删除功能需改造 import-kb / incremental / sync-relation / query-group / scan-kb / diff / ai-results / rebuild / relation-map / restore / backup 链路（有工作量）
  - CLI 位置参数改造需保证向后兼容（option 保留）

### 3.5 建议
删除 ai-results / keywords / isFullText / scan / from-results；全量直导（原文 + 切分）为主路径；增量直连（git diff 驱动 + 文件级重切覆盖）保留更新能力；sync_relation 保持单条关系语义（不切分，超长仅警告）；CLI 范围 A/B 简化纳入本次；切分参数持久化；MCP 工具名不变。

## 4. 需求清单

### 4.1 需求拆分清单

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|--------|---------|----------|----------|------|----------|
| P0 | REQ-01 | `scan-kb import` 支持 `--source <dir>`（缺省 `--results`）直接导入 Markdown 目录，原文全文入库；**scope 未配置 sourceDir 时写入绝对路径**（H-20） | 一条命令完成 Wiki 入库，无 AI 依赖；后续增量免传 source | - | `ki scan-kb import --source <dir> --scope <s> --root-name <n>` 成功入库；scope sourceDir 已写入绝对路径 |
| P0 | REQ-02 | 大文档自动切分（内存中），固定长度 + 段落边界优先（递归字符切分） | 超过 chunk 上限的文档不丢失语义，检索可定位段落 | REQ-01 | 10KB 文档无论段落多少，份数 ≈ 10（=10000/1000）；各 chunk 可独立检索，语义无截断断裂 |
| P0 | REQ-03 | 切分 chunk 的 relation 名 = `文件名-01/-02` 后缀 | chunk 可独立定位，命名安全 | REQ-02 | `foo.md` 3 chunks → relation `foo-01/02/03`，通过 `isUnsafeRelationName` 校验 |
| P0 | REQ-04 | **删除 ai-results.json 导入**：移除 import-kb / incremental / scan-kb 的 ai-results 输入契约（`ScanResultEntry` 瘦身为 `{path, groupPath?, memoryId?}` + 原文内容，action/summary/keywords 字段删除）；**删除 `scan-kb scan` 子命令**（含 scan-pending/scan-index 产物，H-15）；**删除 restore `--from-results` 模式**（backupAiResults 不再产生，H-16） | 系统彻底不依赖 AI 产物 | - | `import --results` 移除或标注废弃；`scan` 子命令不存在；`restore --from-results` 移除；代码中无 `normalizeAiResults` / `backupAiResults` 依赖 |
| P0 | REQ-05 | **删除 keywords 机制（全链路）**：batch-vectorize / path-vectorize / import / rebuild / sync-relation（validateKeywords / invalid_keywords / evicted / keywords_truncated）不再传/不生成 keywords；query-group 关键词词云显示移除；relations-cache 不再写入 keywords（旧数据只读兼容）；**`migrate-keywords` 命令删除（H-21）**；**export/wiki 写回 frontmatter 移除 keywords 字段（H-22）** | 搜索质量完全依赖向量引擎；索引不显示关键词 | REQ-04 | 代码无 keywords 传入向量层；query-group 输出无词云；sync-relation 入参无 --keywords；migrate-keywords 命令不存在；export/wiki frontmatter 无 keywords 字段 |
| P0 | REQ-06 | **增量更新直连**：`import --mode incremental --source <dir>` 内部走 git diff（复用 `handleDiff`）；**文件变更 → 该文件全部 chunk relation 直接覆盖更新**（H-17：重切 + 删旧全 chunk memoryId + 写新全 chunk）；deleted 按文件关联全部 chunk memoryId 清理；完成后更新 `source.commit` 到 HEAD；**增量复用持久化切分参数**（H-18） | 增量更新无 AI 参与，自给自足；文件级 diff 与 chunk 级存储解耦 | REQ-01, REQ-04 | 文件变更后该文件全部 chunk 正确更新/删除；`source.commit` 更新；切分参数与全量一致 |
| P0 | REQ-09 | **取消 isFullText 机制**：移除 `Relation.isFullText` 字段写入、`search.ts` 的 isFullTextContent/命中反查 isFullText 判定、`relation-map.ts` 反查 isFullText 字段（旧数据字段保留不消费）；**MCP `ki_search` 返回结构同步移除该字段**（H-19） | search 结果统一按全文处理 | REQ-04 | 代码无 isFullText 判定逻辑；search/MCP 输出无 isFullText 字段 |
| P0 | REQ-11 | **CLI 范围 A：高频参数短别名**：`-s`(--scope)、`-q`(--query)、`-t`(--text)、`-g`(--group)、`-r`(--relation)、`-i`(--input)、`-o`(--output) 等覆盖所有常用/必填参数（注意命令内避让 `-t` 与 setup 的 target 冲突） | CLI 输入效率提升 | - | 高频命令的必填/常用参数均可用短别名 |
| P0 | REQ-12 | **CLI 范围 A：必填文本参数位置化**：`ki search "sas"`、`ki store "内容"` 等支持位置参数；原 `--query`/`--text` option 保留兼容 | 位置参数可用，旧脚本不受破坏 | REQ-11 | 位置参数与 option 均可触发；旧调用方式不报错 |
| P0 | REQ-13 | **CLI 范围 B：本次改造顺带清理**：import-kb 与 scan-kb import 合并（删除 deprecated 入口）、scan-kb vectorize 删除、`bulk_store` → `bulk-store` 改名；**MCP 工具名 `ki_bulk_store` 保持不变**（仅 CLI 命令改名，H-19） | 消除冗余入口，命名统一 | REQ-04 | deprecated 命令移除；bulk-store 命令与文件名一致；MCP 工具名不变且功能正常 |
| P1 | REQ-07 | 切分参数可配置（`--chunk-size` 默认 1000 字符 / `--chunk-overlap` 默认 150）；**参数持久化到 source 块**（H-18），增量自动复用；**参数变更语义（场景推演 #2/#3 修复）：`--mode full` 全量重导允许更新 chunk-size（按新参数对受影响文件重切）；`--mode incremental` 永远用 source 块持久化值，命令行传参被忽略** | 用户可按 wiki 密度调整切分粒度；跨次一致 | REQ-02 | 传参后切分行为与默认不同；增量复用持久化参数；full 重导更新参数后重切生效 |
| P1 | REQ-08 | chunk 粒度 sourcePath 唯一（`foo.md#1` 等）；**文件级 diff 定位该文件全部 chunk**（按文件路径聚合 / 前缀匹配，支撑 H-17 全量覆盖） | 文件变更时能定位该文件全部 chunk 完成覆盖/删除 | REQ-02, REQ-06 | 文件级 diff 能定位该文件全部 chunk memoryId；覆盖/删除正确 |
| P2 | REQ-10 | sync_relation 超长 `--module-info`（>1000 字符）输出警告（建议拆分或改用 import --source），不自动切分 | 保持单条关系语义，避免大向量质量稀释 | - | 超长 module-info 时输出警告，仍正常写入单条 |
| P1 | REQ-14 | **docs/ 与 skills/ 文档同步**（H-23）：更新 17 个 docs + 5 个 skill 中含 keywords/词云/ai-results 的描述为直导/增量新流程；不兼容内容标注废弃；**拆分为独立文档更新任务**（可并行于核心开发之后） | 文档与实现一致，用户不被旧流程误导 | REQ-04, REQ-05 | 文档无 keywords/词云/ai-results 旧流程描述（或标注废弃） |
| P1 | REQ-15 | **test/ 重构（H-24）**：删除/重构 sync-relation / query-group / migrate-keywords / scan-kb / import-kb 等 30+ 测试文件与 `test/fixtures/ai-results-*.json` 夹具；新增直导/切分/增量直连测试 | 测试与实现同步，无失效用例 | REQ-04, REQ-05, REQ-06 | `npm run test:all` 全绿；无 ai-results 相关夹具残留 |

### 4.2 需求依赖图
```
REQ-01 (直接导入入口 + sourceDir 写入)
   ↓
REQ-02 (自动切分)
   ├→ REQ-03 (relation 命名)
   ├→ REQ-07 (切分参数 + 持久化)
   ├→ REQ-08 (chunk sourcePath + 文件聚合)
   ↓
REQ-04 (删除 ai-results / scan / from-results)
   ├→ REQ-05 (删除 keywords + 词云)
   ├→ REQ-09 (取消 isFullText + MCP 结构同步)
   ├→ REQ-13 (CLI 范围 B 清理，MCP 名不变)
   ↓
REQ-06 (增量直连 git diff + 文件级覆盖更新)
REQ-10 (sync_relation 超长警告) [独立]
REQ-11 → REQ-12 (CLI 范围 A：短别名 → 位置参数)
REQ-04 → REQ-14 (docs/skills 文档同步)
REQ-04/05/06 → REQ-15 (test 重构)
```

### 4.3 需求验证标准
| 需求 ID | 验证方式 | 验证指标 | 验证时机 |
|---------|----------|----------|----------|
| REQ-01 | CLI 验收 | 无 ai-results 完成导入；sourceDir 绝对路径已写 | 开发完成后 |
| REQ-02 | 单测 + CLI | 大文档切分正确、检索各 chunk 可达 | 开发完成后 |
| REQ-03 | 单测 | relation 命名 + 安全校验通过 | 开发完成后 |
| REQ-04 | 代码审查 | ai-results / scan / from-results 依赖彻底移除 | 开发完成后 |
| REQ-05 | 代码审查 | keywords 不再传入向量层；词云显示移除 | 开发完成后 |
| REQ-06 | 集成测试 | 文件变更→全 chunk 覆盖/删除正确 + source.commit 更新 | 集成阶段 |
| REQ-07 | CLI 验收 | 参数生效 + 持久化复用 | 开发完成后 |
| REQ-08 | 集成测试 | 文件级 diff 定位全 chunk 正确 | 集成阶段 |
| REQ-09 | 单测 | 无 isFullText 判定；search/MCP 无该字段 | 开发完成后 |
| REQ-10 | CLI 验收 | 超长 module-info 输出警告 | 开发完成后 |
| REQ-11 | CLI 验收 | 高频参数短别名可用 | 开发完成后 |
| REQ-12 | CLI 验收 | 位置参数 + option 双通道可用 | 开发完成后 |
| REQ-13 | 代码审查 | deprecated 命令移除；bulk-store 改名；MCP 工具名不变 | 开发完成后 |
| REQ-14 | 文档审查 | docs/skills 无旧流程描述（或标注废弃） | 文档任务完成后 |
| REQ-15 | 测试运行 | `npm run test:all` 全绿；无 ai-results 夹具残留 | 开发完成后 |

### 4.4 非功能性约束
- 向后兼容：
  - 已导入数据（relations-cache / local KB）可正常读取（keywords / isFullText 字段只读兼容，不再写入）
  - CLI 简化保留原 option（位置参数为增量能力）
  - **MCP 工具名不变**（仅返回结构变更）
- 无新增外部依赖（chunking 用递归字符算法，增量用现有 git diff）
- 大规模导入性能可接受（复用现有批量向量化）
- `--source <dir>` 必须位于 git 仓库内（增量模式依赖）；**增量时无 git 仓库 → 明确报错（提示"source 目录不在 git 仓库中，增量更新依赖 git，请先 git init 或改用 --mode full 全量导入"）**，不做静默降级全量（避免用户误以为增量成功）
- 全量直导写入的 scope sourceDir 为**绝对路径**（H-20）

### 4.5 潜在风险与注意事项
- **删除范围广**：ai-results 影响 import-kb / incremental / scan-kb(scan 子命令) / diff / ai-results 校验 / backup(backupAiResults) / restore(--from-results)；keywords 影响 sync-relation / query-group / batch-vectorize / path-vectorize / rebuild / relation-map；isFullText 影响 search / relation-map / scoring / import / incremental——删除时需逐一清理，避免残留死代码
- **增量 memoryId 关联**：依赖 `buildMemoryIdMap`（relations-cache 的 sourcePath→memoryId），删除 ai-results 后该映射仍由 cache 提供，需保留
- **文件级 diff vs chunk 级存储**（H-17 核心）：git diff 以文件为粒度，库内以 chunk 为粒度——需"文件 → 该文件全部 chunk"的聚合映射（REQ-08），变更文件时全量覆盖该文件 chunks
- **覆盖更新冗余**：文件改一行 → 该文件全部 chunk 重切重写（已接受：幂等 upsert，chunk 量小）
- **切分参数跨次一致**（H-18）：参数持久化到 source 块，增量复用，避免 chunk 划分漂移
- **BM25 召回下降**：删除 keywords 后全文召回依赖原文词汇（已接受，向量引擎为主路径）
- **query-group 词云移除**：输出结构变化，相关测试需同步更新
- **MCP 契约**：工具名不变（H-19），但 `ki_search` 返回结构移除 isFullText、`ki_bulk_store` 对应 CLI 改名——MCP 文档与测试需同步，客户端按返回结构适配
- **CLI 短别名冲突**：`-t` 可能同时想表示 text/tags/target，需在命令内按语义分配（setup 已有 `-t` 表示 target）
- **CLI 位置参数与 option 并存**：commander 中位置参数与 option 同时存在时需明确优先级（位置参数优先或 option 优先）
- **切分触发条件**：份数 = `ceil(文档字符数/chunk_size)`，与段落数无关；`\n\n > \n > 。 > ； > 硬切` 优先级
- **restore 存量影响**：删除 `--from-results` 后，旧 ai-results 备份无法重放（可提示用户删除或忽略存量备份）
- **migrate-keywords 删除**：若仍有用户依赖旧 keywords 迁移，删除前需确认（本次确认删除，随 keywords 机制清理）
- **export/wiki frontmatter 变更**：移除 keywords 字段后，外部工具若读取该字段会受影响（已确认接受，frontmatter 只留 groupPath/relation/exportedAt）
- **docs/skills 同步滞后**：文档更新拆分为独立任务，若晚于核心开发完成，过渡期文档与实现不一致（可接受，标注废弃兜底）

### 4.6 复杂度评估与快速实现判断

| 评估维度 | 评分 | 说明 |
|----------|------|------|
| 技术难度 | 中 | 递归字符切分 + 增量直连改造 + 四机制删除（ai-results/keywords/isFullText/scan/from-results）+ CLI 简化 |
| 范围大小 | 高 | 涉及 scan-kb / import / incremental / diff / sync-relation / query-group / batch-vectorize / path-vectorize / rebuild-vector / import-kb / relation-map / scoring / backup / restore / search / store / bulk-store 多模块 |
| 依赖关系 | 低 | 无外部新依赖（复用 git diff） |
| 需求清晰度 | 高 | 决策点已全部确认（含 6 疑点处置） |
| 时间约束 | 低 | 无紧迫 deadline |
| 风险程度 | 中 | 删除功能波及链路广 + 文件级/chunk 级映射设计 + CLI 位置参数兼容需谨慎 |

**综合复杂度**：中（H=1，M=4）
**快速实现可行性**：不可快速实现（不建议直接编码）
**推荐下一步**：
- **特征命中**：数据流复杂（文件↔chunk 映射 + 删除链路波及）+ 多模块改动（范围高）
- **推荐行动**：`data-flow-model`（数据流设计）→ `design-craft`（技术设计）
- **理由**：涉及"1 文件 → N chunk → N memoryId"映射（增量覆盖/删除的关键）、ai-results/keywords/isFullText/scan/from-results 删除链路清理、增量 git diff 直连、CLI 参数体系调整，数据关系与技术方案均需先明确再编码。

## 5. 迭代建议

### 5.1 反馈收集计划
- 收集方式：导入后检索质量抽验（对比直导 vs 原 AI 摘要导入的召回）；CLI 使用反馈
- 收集频率：首版上线后使用反馈

### 5.2 迭代规划
- 第一阶段：REQ-01~03（核心直导 + 切分 + 命名 + sourceDir 写入）
- 第二阶段：REQ-04~06（删除 ai-results/scan/from-results/migrate-keywords + 删除 keywords/词云 + 增量直连 + 文件级覆盖）
- 第三阶段：REQ-07~09（参数持久化 + 文件聚合 + 取消 isFullText + MCP 结构同步）
- 第四阶段：REQ-10~13（sync_relation 警告 + CLI 短别名 + 位置参数 + 命令清理）
- **并行/独立任务**：REQ-14（docs/skills 文档同步）+ REQ-15（test 重构，随各阶段同步推进）

### 5.3 长期演进建议
- CLI 全面迁移 commander + 其余规范化点（`--output` 三义、`--yes` 补全、帮助去重等）→ 独立需求 REQ-20260806-002
- 如需恢复"AI 增强"能力（如自动摘要/关键词），作为直导后的**可选后处理**而非前置依赖（本次不实现）

## 6. 变更记录

- 2026-08-06 v1：需求分析完成，决策点确认（原文直导 + 内存自动切分 + relation 序号后缀 + 切分触发=长度阈值）
- 2026-08-06 v2：新增决策——删除 ai-results 导入 + 删除 keywords 机制 + 增量更新改 git diff 驱动；需求清单更新为 9 条（REQ-01~09）；状态推进为"已确认"
- 2026-08-06 v3：补充决策——取消 isFullText 字段（REQ-09 改）+ keywords 全链路删除含 sync_relation/query-group 词云（REQ-05 扩）+ sync_relation 不引入切分仅超长警告（新增 REQ-10）；需求清单更新为 10 条（REQ-01~10）
- 2026-08-06 v4：纳入 **CLI 范围 A + B**（短别名 REQ-11 / 位置参数 REQ-12 / 命令清理 REQ-13）；其余 CLI 迁移规范化点拆分为独立需求 REQ-20260806-002；需求清单更新为 13 条（REQ-01~13）
- 2026-08-06 v5：核对后确认 6 疑点处置——①删除 `scan` 子命令（H-15）②删除 restore `--from-results`（H-16）③文件变更→该文件全部 chunk 覆盖更新（H-17）④切分参数持久化（H-18）⑤MCP 工具名不变、结构同步（H-19）⑥全量直导写入 scope sourceDir 绝对路径（H-20）；REQ-01/04/06/07/08/09/13 相应更新
- 2026-08-06 v6：第 2 轮核对确认 4 疑点处置——⑦`migrate-keywords` 命令随 keywords 一并删除（H-21）⑧export/wiki frontmatter 移除 keywords 字段（H-22）⑨docs 17 个 + skills 5 个文档拆独立更新任务（H-23）⑩test 30+ 文件与 fixtures 纳入本次（H-24）；REQ-05 扩展、新增 REQ-14（文档同步）/REQ-15（测试重构）；需求清单 15 条（REQ-01~15）
- 2026-08-06 v7：场景推演修复——H-25（无 git 增量明确报错，不做静默降级）、H-26（切分参数变更语义：full 重导允许更新、增量永远用 source 块值）；§4.4 与 REQ-07 相应更新
