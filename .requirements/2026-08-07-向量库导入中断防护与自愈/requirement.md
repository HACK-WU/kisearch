---
id: REQ-20260807-001
feature: 向量库导入中断防护与自愈
status: 草案
created: 2026-08-07
updated: 2026-08-07
version: 4
tags: [fix, vector]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析报告：向量库导入中断防护与自愈（独立需求）

> 本需求源于真实事故：`scan-kb import` 导入过程中被中断（Ctrl+C/kill），导致向量库留下 crash residue，后续所有向量命令触发 zvec 原生 ERROR 刷屏，且被中断批次的向量存在"索引已重建、idmap 未登记"的数据完整性风险。
> **依赖**：无。独立演进项，与导入/向量链路并行。
> **来源**：① 导入中断事故复盘（bug-impact-analysis）；② 导入链路代码优化分析（artifact-optimizer：O-01 切分进度分母 / O-02 并行进度条冲突 / O-03 向量化分批进度 / O-04 向量化前数据清洗 / O-05 非 TTY 进度降级）；③ 用户新增：自定义数据清洗钩子（REQ-07）。

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
7. **自定义数据清洗钩子**（REQ-07）：config 注入外部清洗脚本，与内置规则组成管道链

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

- **描述**：向量化前执行**模式识别清洗**（默认开启，规则独立可配）；**local KB 直接存原文（不清洗），清洗后数据只去向量化**（用户澄清确认，方案 C）。当前 `readFileToChunks`（`import.ts:162-165`）直接读原文切分，frontmatter（`---` YAML 头）、UTF-8 BOM、空 chunk、引用清单、mermaid、文件路径、代码块等噪音直接进入向量 content，污染语义与 BM25 检索。清洗规则：
  1. 剥离 UTF-8 BOM（`/^\uFEFF/`）
  2. 剥离 YAML frontmatter（**整块删除**：首行 `---` 起至闭合 `\n---`，含 `title/date/tags` 等全部字段；仅当块内匹配键值对特征 `key:` 才剥，防误伤正文 `---` 分隔线）
  3. 折叠 3+ 连续空行为 2 个（保留段落边界供切分）
  4. **mermaid 块剥离**（` ```mermaid ... ``` `，图语法语义密度低、正文已覆盖图信息）
  5. **文件路径剥离（模式识别，不依赖 `<cite>`/`**来源**` 等结构化标记）**：`file://` URL、markdown 文件链接、`#L188-L605` 行号引用、裸代码文件路径（`[\w./-]+\.(py|ts|js|go|java|rs|sh|md|json|yaml|yml)`）；剥离后整行仅剩空白/符号 → 删行
  6. **代码块剥离**（默认剥离；`keepShortSamples` 可保留 ≤15 行短命令/配置示例，如 curl/JSON 响应）
  7. 过滤空/近空 chunk（`if (!chunk.text.trim()) continue`）
  - 提供 `--no-clean` 逃生阀关闭全部清洗（依赖 frontmatter/代码块检索的用户可回退）
- **验收标准**：
  - 向量 content 无 `\uFEFF`、无 `---title` 类 frontmatter 头、无 mermaid 块、无 file:// 路径残留
  - **local KB 存原文（未被清洗），清洗后数据只进向量化**（`get-module-info` 可返回原文 chunk）
  - 空/近空文件不产生向量（节省 embedding 配额）
  - `--no-clean` 关闭后行为回退（不清洗）
  - 规则独立开关（`--clean-rules bom,frontmatter,mermaid,codePath,codeBlock`）生效
- **改动位置**：`src/lib/clean.ts`（新建：`cleanMarkdownText` 规则函数 + 模式识别路径剥离）、`src/lib/import.ts`（`handleDirectImport` 在 `bulkVectorize` 前清洗 entries）、`src/lib/incremental.ts`（`handleIncrementalDirect` 在 `bulkVectorize` 前清洗 entries，对齐 import.ts）；**`readFileToChunks`/`chunker.ts`/local KB 写入链路不改**（保持原文）

### REQ-07 自定义数据清洗钩子

- **描述**：为 `scan-kb import` 数据清洗提供**扩展点**，允许用户通过 config 注入自定义清洗逻辑（外部命令/脚本），与内置规则组成管道链：
  - config 扩展 `scopes.<scope>.clean`：
    ```yaml
    scopes:
      my-project:
        clean:
          enabled: true          # 总开关（false 等效 --no-clean，连 hooks 一起关闭）
          rules:                 # 内置规则开关（默认全开）
            bom: true            # BOM 剥离
            frontmatter: true    # YAML frontmatter 剥离
            htmlComment: true    # HTML 注释剥离
            mermaid: true        # mermaid 图块剥离
            codePath: true       # 文件路径剥离（模式识别，不依赖 <cite> 标记）
            codeBlock: true      # 代码块剥离（keepShortSamples: true 可保留短命令/配置示例）
            emptyChunk: true     # 空 chunk 过滤
          hooks:                 # 外部清洗钩子（按序管道执行，stdin→stdout）
            - "node scripts/clean.js"
            - "python3 clean.py"
    ```
  - **钩子协议**：每个文件内容经 stdin 传入钩子，stdout 输出清洗后内容（一次一个文件，互不感知）；钩子失败（非零退出 / 超时）→ 跳过该钩子 + 告警（不阻断导入），该文件记入 skipped 并提示
  - **执行顺序**：内置规则先执行 → 外部 hooks 依次（管道链）；`--no-clean` / `enabled:false` 全部关闭
  - CLI 补充：`--clean-rules bom,frontmatter` 覆盖内置规则开关（可选，不传用 config）
- **验收标准**：
  - config 配置 hooks 后，导入内容经过自定义清洗（端到端可验证，如 `doc list` 抽查）
  - 钩子失败不阻断整体导入（告警 + 计入统计）
  - `enabled:false` / `--no-clean` 完全关闭清洗（含 hooks）
  - hook 超时保护（默认 10s），不卡死导入
- **改动位置**：`src/lib/import.ts`（清洗链接入）、`src/lib/clean.ts`（新建：内置规则 + hook 管道执行）、`src/lib/config.ts`（schema 扩展 `clean`）、`src/scan-kb.ts`（`--clean-rules`）

## 5. 影响范围

| # | 调用方 | 影响 | 级别 |
|---|--------|------|------|
| 1 | `scan-kb import`（full 直导） | 新增 SIGINT/SIGTERM 处理 + 状态标记 | ❌ 行为变更（正常路径不变） |
| 2 | 所有向量命令（search/store/doc/scope/tag/restore） | `getEngine` 前置检测新增中断标记检查 | ⚠️ 需回归 |
| 3 | `ZVecEngine.probe` | 新增 residue 检测提示 | ⚠️ 需回归 |
| 4 | `scan-kb import` 切分/向量化阶段 | 进度输出重构（分母/并行/分批/TTY） | ⚠️ 需回归 |
| 5 | `scan-kb import` 导入内容 | 内容清洗改变**入向量文本**（默认开启，`--no-clean` 可关）；**local KB 存原文不受影响** | ⚠️ 行为变更 |
| 6 | `scan-kb import` 导入内容 | 自定义清洗钩子（外部命令执行，配置驱动） | ⚠️ 行为变更（显式配置才生效） |

## 6. 文件路径清单

- `src/lib/import.ts`（REQ-01：中断捕获 + 状态标记；REQ-05：进度分母/并行/分批；REQ-06：清洗调用）
- `src/lib/vector-client.ts`（REQ-02/03：中断检测 + 引导 + lockedHint 增强）
- `src/zvec-engine/engine.ts`（REQ-03：probe 提示增强）
- `src/lib/batch-vectorize.ts`（REQ-05：分批提交 + 批间进度）
- `src/lib/progress.ts`（REQ-05：TTY 检测降级）
- `src/lib/incremental.ts`（REQ-06：向量化前清洗，line 367 对齐 import.ts）
- `src/lib/clean.ts`（REQ-06/07：新建，内置清洗规则 + hook 管道执行）
- `src/lib/config.ts`（REQ-07：schema 扩展 `scopes.<scope>.clean`）
- `src/scan-kb.ts`（REQ-07：`--clean-rules`）
- `test/`（REQ-04：中断模拟用例；REQ-05/06：进度与清洗用例；REQ-07：hook 管道用例）
- `docs/cli.md`、`docs/scan-kb.md`（行为说明：中断提示、恢复引导、清洗开关与 hook 配置）

## 7. 测试方案

| 测试场景 | 优先级 | 说明 |
|----------|--------|------|
| 导入中断（kill -9）后 doc list/search 可引导 | P0 | 直接对应本次事故 |
| 中断后 `rebuild-vector` 全量重建后检索完整 | P0 | 验证自愈路径有效 |
| 含 frontmatter/BOM fixture 导入 → doc list 抽查 content 无污染 + local KB 抽查原文未清洗 | P0 | 验证 REQ-06 清洗与原文保留（方案 C） |
| probe 只读打开在正常库上无副作用 | P1 | 回归基线 |
| 中断标记存在时引导提示出现、无标记时零输出 | P1 | 新功能验证 |
| 切分进度恒 ≤100%（大文件 fixture） | P1 | 验证 REQ-05 O-01 |
| 非 TTY 下进度可读（stderr 重定向） | P1 | 验证 REQ-05 O-05 |
| config 配置 hook（如 node 脚本去行号）→ doc list 抽查已清洗 | P0 | 验证 REQ-07 钩子生效 |
| hook 失败（exit 1）→ 不阻断导入 + 计入统计 | P1 | 验证 REQ-07 容错 |
| `enabled:false`/`--no-clean` → hooks 与内置规则全部关闭 | P1 | 验证 REQ-07 逃生阀 |

## 8. 验收标准

1. 导入中断后，任意向量命令输出可执行恢复引导，不再出现 zvec 原生 ERROR 刷屏
2. 中断标记可识别且不污染正常路径
3. `rebuild-vector` / `restore --rebuild-vector` 重建后，被中断批次的文档可正常检索
4. 全量测试通过（含新增中断用例），lint 零错误
5. 导入进度恒 ≤100%；向量化与 KB 写入进度独立呈现，均有动态刷新
6. 导入内容经清洗：无 BOM/frontmatter/空 chunk 污染（`--no-clean` 可关闭）；**local KB 存原文（未被清洗），清洗后数据只进向量化**
7. config 配置的自定义清洗钩子按序生效；钩子失败不阻断导入且超时有保护

## 9. 当前进度

- [ ] REQ-01 导入中断安全收尾
- [ ] REQ-02 中断标记检测与恢复引导
- [ ] REQ-03 probe 异常提示增强
- [ ] REQ-04 中断恢复测试
- [ ] REQ-05 导入进度可观测性（O-01/02/03/05）
- [ ] REQ-06 向量化前数据清洗（O-04）
- [ ] REQ-07 自定义数据清洗钩子
- **状态**：草案（已落盘，待评审确认）
