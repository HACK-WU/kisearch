---
id: REQ-20260807-001
feature: 向量库导入中断防护与自愈
status: 草案
created: 2026-08-07
updated: 2026-08-07
version: 2
tags: [fix, vector]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析报告：向量库导入中断防护与自愈（独立需求）

> 本需求源于真实事故：`scan-kb import` 导入过程中被中断（Ctrl+C/kill），导致向量库留下 crash residue，后续所有向量命令触发 zvec 原生 ERROR 刷屏，且被中断批次的向量存在"索引已重建、idmap 未登记"的数据完整性风险。
> **依赖**：无。独立演进项，与导入/向量链路并行。
> **来源**：① 导入中断事故复盘（bug-impact-analysis）；② 导入链路代码优化分析（artifact-optimizer：O-01 切分进度分母 / O-02 并行进度条冲突 / O-03 向量化分批进度 / O-04 向量化前数据清洗 / O-05 非 TTY 进度降级）。

## 1. 原始需求描述

> 用户运行 `ki scan-kb import --scope monitor ...` 在向量化阶段被中断。之后执行 `ki doc list -s monitor` 时，输出大量 zvec 原生日志：
>
> ```text
> [ WARN ...] ForwardBlock file[.../scalar.4.ipc] already exists (possible crash residue); cleaning and overwriting.
> [ WARN ...] Index file[.../dense.index.5.proxima] already exists (possible crash residue); cleaning and overwriting.
> [ERROR ...] Failed to put [docId, 300] into IDMap[.../idmap.0], code[3], reason[Not implemented: Not supported operation in read only mode.]
> ...（大量重复 ERROR，涉及被中断批次全部 docId）
> ```
>
> 命令最终返回 `ok: true` 与数据，但：
> 1. 错误日志刷屏，无法判断库是否可用
> 2. 被中断批次的 chunk 可能"索引文件已重建、idmap 未登记"，导致检索/计数/删除遗漏
> 3. 无恢复引导，用户不知道怎么办

## 2. 需求澄清

### 2.1 需求形态
真实 Bug 修复需求（可靠性 + 可观测性改进）。事故驱动的技术改进。

### 2.2 功能本质
在导入链路建立"中断防护 + 自愈引导"机制：中断时安全收尾并留下标记，后续命令检测到中断/损坏迹象时给出可执行恢复引导，替代 zvec 原生 ERROR 刷屏。

### 2.3 使用场景与角色
- 场景 1：大目录导入中途被 Ctrl+C / kill——期望不留下不可恢复的脏库
- 场景 2：中断后继续使用 ki 命令——期望得到"如何恢复"的明确提示而非原始错误刷屏
- 场景 3：损坏库自愈——期望 `rebuild-vector` / `restore --rebuild-vector` 路径可用且可验证

**用户角色**：CLI 使用者 / 脚本维护者

### 2.4 核心痛点
1. 导入进程无 SIGINT/SIGTERM 处理，被 kill 后留下半写状态的 crash residue
2. full 直导不写 progress/state 文件，中断后无法识别"上次导入未完成"
3. `probe()` 以 `readOnly: true` 打开集合，撞上 zvec 打开即 recovery 的行为，recovery 需要写 idmap → 只读拒绝 → ERROR 刷屏（`engine.ts:171`）
4. 被中断批次的 docId 未登记到 idmap，向量数据存在静默丢失风险
5. 无任何恢复引导文案，用户只能自己猜

### 2.5 期望体验
- 中断导入后，任意向量命令给出可执行引导（含恢复命令）而非原始 ERROR 刷屏
- 中断状态可被识别（state/progress 文件），恢复路径明确
- `rebuild-vector` / `restore --rebuild-vector` 全量重建后数据完整可检索

### 2.6 深层动机
- 向量库是 ki 的核心资产，中断/损坏场景的可靠性直接影响用户信任
- zvec 原生日志无法低成本拦截（worker_threads 直写 stderr），必须从 ki 侧建立"检测-提示-自愈"闭环

### 2.7 非功能性需求

| 类别 | 要求 |
|------|------|
| 可靠性 | 中断后库可恢复；重建路径可验证 |
| 可观测性 | 恢复引导清晰可执行；非 TTY 下同样可读 |
| 兼容性 | 不改变正常导入路径行为；不引入新依赖 |
| 性能 | 中断标记检测开销可忽略（文件存在性检查） |

## 3. 需求范围

### 3.1 范围 A（本次实现）
1. **导入中断安全收尾**：`scan-kb import`（full 直导）捕获 SIGINT/SIGTERM，中断时写"导入中断"状态标记并安全退出
2. **中断标记检测与恢复引导**：向量命令打开向量库前检测中断标记 + probe 异常 → 输出可执行引导
3. **probe 异常提示增强**：`ZVecEngine.probe` 检测崩溃残留/recovery 迹象时输出"可重建恢复"提示
4. **中断恢复测试**：模拟中断 → 验证引导提示 + rebuild 后检索完整
5. **导入进度可观测性**（O-01/02/03/05）：修复切分进度超 100%、消除并行进度条冲突、向量化分批进度、非 TTY 降级
6. **向量化前数据清洗**（O-04）：剥离 frontmatter/BOM、过滤空 chunk、空白规范化（`--no-clean` 逃生阀）

### 3.2 范围 B（明确不做）
1. **拦截 zvec 原生日志**：worker 是 `worker_threads`，原生库直接写 stderr，低成本过滤不可行；不改造为子进程捕获 stdio
2. **断点续跑**：本需求只做"中断识别 + 恢复引导"，不实现增量续跑（已有 incremental 增量链路）
3. **zvec 侧修复**：只读模式 recovery 冲突属 zvec 原生行为，ki 侧不做绕行

## 4. 需求条目

### REQ-01 导入中断安全收尾

- **描述**：`scan-kb import`（full 直导模式）捕获 `SIGINT`/`SIGTERM`，中断时安全收尾：
  - 写入"导入中断"状态标记文件（复用/新增 progress 文件，记录已处理文件数、chunk 数、中断时间）
  - 输出明确的中断提示（如 `⚠ 导入已中断：已完成 N/M 个文件`），退出码非 0
- **验收标准**：
  - kill 导入进程后，状态标记文件存在且内容有效
  - 中断提示明确（含已处理进度）
- **改动位置**：`src/lib/import.ts`

### REQ-02 中断标记检测与恢复引导

- **描述**：向量命令打开向量库前（`getEngine`/`ensureVectorAvailable` 路径）检测中断标记；若存在且向量库 probe 异常 → 输出可执行引导：
  - `检测到未完成的导入（<时间>），向量库可能不完整。建议执行：ki rebuild-vector 或 ki restore <scope> --from-snapshot --rebuild-vector 恢复`
- **验收标准**：
  - 中断后任意向量命令给出引导提示（而非 zvec 原始 ERROR 刷屏）
  - 正常（无标记）时零额外输出
- **改动位置**：`src/lib/vector-client.ts`、`src/zvec-engine/engine.ts`

### REQ-03 probe 异常提示增强

- **描述**：`ZVecEngine.probe` 检测到崩溃残留/recovery 迹象（如 `already exists`/`crash residue` 关联状态）时，在既有 `lockedHint` 文案基础上补充"可重建恢复"引导
- **验收标准**：
  - 有 residue 时提示明确包含恢复命令
  - 空库/正常库不受影响
- **改动位置**：`src/zvec-engine/engine.ts`、`src/lib/vector-client.ts`（`lockedHint`）

### REQ-04 中断恢复测试

- **描述**：新增测试覆盖：
  - 模拟导入中断（kill -9）→ 后续 `doc list`/`search` 不抛错且给出引导
  - `rebuild-vector` / `restore --rebuild-vector` 全量重建后检索完整（被中断批次可召回）
- **验收标准**：中断场景测试全绿；重建后召回完整
- **改动位置**：`test/` 新增用例

### REQ-05 导入进度可观测性（O-01/02/03/05）

- **描述**：修复导入过程进度显示的 4 个缺陷：
  - **O-01 切分进度分母错误**：`import.ts:226` 用 `files.length * 10` 做分母，但 `entries.length` 是累计 chunk 数，大文件时分母远小于实际值，进度超 100%（实测 `1444/1430 (100%)`）→ 改为按"已处理文件数/总文件数"或先统计总 chunk 数作分母，进度恒 ≤100%
  - **O-02 并行进度条互相覆盖**：`import.ts:269-300` `Promise.all` 并行向量化与 KB 写入，两条链路都写 stderr `\r` 进度条，KB 写入（<1s）冲刷 embedding 进度（数分钟），用户看不到向量化进度 → 改为串行（推荐，KB 写入近实时无并行损失）或分区独立显示
  - **O-03 向量化无中间进度**：`bulkVectorize` 单次 `vectorBulkStore` 提交全部条目，engine 内部批量 embed 无中间态 → 分批提交（如 200 条/批）+ 批间 `logProgress`
  - **O-05 非 TTY 进度退化**：`progress.ts:145` 用 `\r` 覆写当前行仅 TTY 有效 → 检测 `process.stderr.isTTY`，非 TTY 时逐行输出
- **验收标准**：
  - 切分进度恒 ≤100%，无 `n/1430 (100%)` 类失真输出
  - 向量化与 KB 写入进度独立呈现、均有动态刷新（用户可感知向量化进行到哪一步）
  - 向量化长任务有批间进度反馈
  - stderr 重定向到文件/管道时进度仍可读
- **改动位置**：`src/lib/import.ts`、`src/lib/batch-vectorize.ts`、`src/lib/progress.ts`

### REQ-06 向量化前数据清洗（O-04）

- **描述**：`readFileToChunks`（`import.ts:158-161`）直接读原文切分，frontmatter（`---` YAML 头）、UTF-8 BOM、空 chunk、导航/页脚噪音直接进入向量 content，污染语义与 BM25 检索 → 切分前执行低风险清洗（默认开启）：
  1. 剥离 UTF-8 BOM（`/^\uFEFF/`）
  2. 剥离 YAML frontmatter（首行 `---` 与闭合 `\n---`，`title/date/tags` 等元数据不入向量）
  3. 折叠 3+ 连续空行为 2 个（保留段落边界供切分）
  4. 过滤空/近空 chunk（`if (!chunk.text.trim()) continue`）
  - 提供 `--no-clean` 逃生阀关闭清洗（依赖 frontmatter 检索的用户可回退）
- **验收标准**：
  - 向量 content 无 `\uFEFF`、无 `---title` 类 frontmatter 头
  - 空/近空文件不产生向量（节省 embedding 配额）
  - `--no-clean` 关闭后行为回退（不清洗）
- **改动位置**：`src/lib/import.ts`、`src/lib/chunker.ts`（清洗函数落点）

## 5. 影响范围

| # | 调用方 | 影响 | 级别 |
|---|--------|------|------|
| 1 | `scan-kb import`（full 直导） | 新增 SIGINT/SIGTERM 处理 + 状态标记 | ❌ 行为变更（正常路径不变） |
| 2 | 所有向量命令（search/store/doc/scope/tag/restore） | `getEngine` 前置检测新增中断标记检查 | ⚠️ 需回归 |
| 3 | `ZVecEngine.probe` | 新增 residue 检测提示 | ⚠️ 需回归 |
| 4 | `scan-kb import` 切分/向量化阶段 | 进度输出重构（分母/并行/分批/TTY） | ⚠️ 需回归 |
| 5 | `scan-kb import` 导入内容 | 内容清洗改变入向量文本（默认开启，`--no-clean` 可关） | ⚠️ 行为变更 |

## 6. 文件路径清单

- `src/lib/import.ts`（REQ-01：中断捕获 + 状态标记；REQ-05：进度分母/并行/分批；REQ-06：清洗调用）
- `src/lib/vector-client.ts`（REQ-02/03：中断检测 + 引导 + lockedHint 增强）
- `src/zvec-engine/engine.ts`（REQ-03：probe 提示增强）
- `src/lib/batch-vectorize.ts`（REQ-05：分批提交 + 批间进度）
- `src/lib/progress.ts`（REQ-05：TTY 检测降级）
- `src/lib/chunker.ts`（REQ-06：清洗函数）
- `test/`（REQ-04：中断模拟用例，如 `test/import-interrupt.test.ts`；REQ-05/06：进度与清洗用例）
- `docs/cli.md`、`docs/scan-kb.md`（行为说明：中断提示、恢复引导、清洗开关）

## 7. 测试方案

| 测试场景 | 优先级 | 说明 |
|----------|--------|------|
| 导入中断（kill -9）后 doc list/search 可引导 | P0 | 直接对应本次事故 |
| 中断后 `rebuild-vector` 全量重建后检索完整 | P0 | 验证自愈路径有效 |
| 含 frontmatter/BOM fixture 导入 → doc list 抽查 content 无污染 | P0 | 验证 REQ-06 清洗 |
| probe 只读打开在正常库上无副作用 | P1 | 回归基线 |
| 中断标记存在时引导提示出现、无标记时零输出 | P1 | 新功能验证 |
| 切分进度恒 ≤100%（大文件 fixture） | P1 | 验证 REQ-05 O-01 |
| 非 TTY 下进度可读（stderr 重定向） | P1 | 验证 REQ-05 O-05 |

## 8. 验收标准

1. 导入中断后，任意向量命令输出可执行恢复引导，不再出现 zvec 原生 ERROR 刷屏
2. 中断标记可识别且不污染正常路径
3. `rebuild-vector` / `restore --rebuild-vector` 重建后，被中断批次的文档可正常检索
4. 全量测试通过（含新增中断用例），lint 零错误
5. 导入进度恒 ≤100%；向量化与 KB 写入进度独立呈现，均有动态刷新
6. 导入内容经清洗：无 BOM/frontmatter/空 chunk 污染（`--no-clean` 可关闭）

## 9. 当前进度

- [ ] REQ-01 导入中断安全收尾
- [ ] REQ-02 中断标记检测与恢复引导
- [ ] REQ-03 probe 异常提示增强
- [ ] REQ-04 中断恢复测试
- [ ] REQ-05 导入进度可观测性（O-01/02/03/05）
- [ ] REQ-06 向量化前数据清洗（O-04）
- **状态**：草案（已落盘，待评审确认）
