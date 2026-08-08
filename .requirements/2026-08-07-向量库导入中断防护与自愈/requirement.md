---
id: REQ-20260807-001
feature: 向量库导入中断防护与自愈
status: 草案
created: 2026-08-07
updated: 2026-08-08
version: 9
tags: [fix, vector, search]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析报告：向量库导入中断防护与自愈（独立需求）

> 本需求源于真实事故：`scan-kb import` 导入过程中被中断（Ctrl+C/kill），导致向量库留下 crash residue，后续所有向量命令触发 zvec 原生 ERROR 刷屏，且被中断批次的向量存在"索引已重建、idmap 未登记"的数据完整性风险。
> **依赖**：无（已合并原 REQ-20260807-002 ki-search 返回原文，其需求文档与 meta 条目已删除，以本需求 REQ-09 设计为准）。独立演进项，与导入/向量链路并行。
> **来源**：① 导入中断事故复盘（bug-impact-analysis）；② 导入链路代码优化分析（artifact-optimizer：O-01 切分进度分母 / O-02 并行进度条冲突 / O-03 向量化分批进度 / O-04 向量化前数据清洗 / O-05 非 TTY 进度降级）；③ 用户新增：自定义数据清洗钩子（REQ-07）；④ 合并 REQ-20260807-002（ki-search 返回原文，REQ-09）。

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
  - **信号捕获范围（推演问题 1 决策）**：仅 `SIGINT`（Ctrl+C）/`SIGTERM`（kill）**可捕获并写标记**；`SIGKILL`（kill -9）**无法捕获**，标记写不出——此类中断由 **REQ-03 probe residue 兜底检测**（双路径，见下）
  - **中断恢复双路径（推演问题 1 决策）**：中断标记链路 = ① 可捕获信号（SIGINT/SIGTERM）→ REQ-01 写标记 + REQ-02 检测引导；② 不可捕获信号（SIGKILL/崩溃）→ REQ-03 probe 检测 crash residue + 引导。两条路径互补，需求不再只依赖标记文件
- **验收标准**：
  - kill（SIGTERM）导入进程后，状态标记文件存在且内容有效
  - 中断提示明确（含已处理进度）
- **改动位置**：`src/lib/import.ts`

### REQ-02 中断标记检测与恢复引导

- **描述**：向量命令打开向量库前（`getEngine`/`ensureVectorAvailable` 路径）检测中断标记；若存在且向量库 probe 异常 → 输出可执行引导：
  - `检测到未完成的导入（<时间>），向量库可能不完整。建议执行：ki rebuild-vector 或 ki restore <scope> --from-snapshot --rebuild-vector 恢复`
  - **触发命令范围（推演 N1 决策）**：中断标记检测挂在 `getEngine`/`ensureVectorAvailable` 路径，即**所有打开向量库的命令**（search/store/doc/scope/tag/restore 等）；**纯 KB 命令（不碰向量库，如 doc list 仅查 local KB 时）不触发引导**——若 doc list 实现为"先 getEngine 后查 KB"，则也触发（保持一致性，实现时按"是否实际打开向量库"判定，文档明确此边界）
  - **标记生命周期（推演问题 2 + N2 决策）**：中断标记的**清除时机**——① `rebuild-vector`/`restore --rebuild-vector` 全量重建成功后**自动清除**；② 用户**手动重跑一次成功的 full 导入**（完整走完）后自动清除；③ **incremental 增量导入成功**（完整走完且无中断标记新增）后同样自动清除（增量从当前库状态继续，若库因中断不完整则增量可能不完整——增量导入成功后清除标记的前提是 diff 基于完整库；实现时若增量前检测到标记，可提示"库可能不完整，建议 rebuild"但允许用户继续）④ 提供手动清除方式（如 `ki clear-interrupt-mark` 或重建命令的 `--force` 隐含清除）。**未清除前**，向量命令按本条提示引导（这是有意的提醒，非 bug）；重建/成功导入后引导消失
- **验收标准**：
  - 中断后任意向量命令给出引导提示（而非 zvec 原始 ERROR 刷屏）
  - 正常（无标记）时零额外输出
  - `rebuild-vector` 成功后标记清除、引导消失（不再提示）
- **改动位置**：`src/lib/vector-client.ts`、`src/zvec-engine/engine.ts`

### REQ-03 probe 异常提示增强

- **描述**：`ZVecEngine.probe` 检测到崩溃残留/recovery 迹象（如 `already exists`/`crash residue` 关联状态）时，在既有 `lockedHint` 文案基础上补充"可重建恢复"引导
- **验收标准**：
  - 有 residue 时提示明确包含恢复命令
  - 空库/正常库不受影响
- **改动位置**：`src/zvec-engine/engine.ts`、`src/lib/vector-client.ts`（`lockedHint`）

### REQ-04 中断恢复测试

- **描述**：新增测试覆盖（**区分两种中断，推演问题 1 决策**）：
  - **可捕获中断（SIGTERM/kill）**：模拟 → 状态标记文件写入 + 后续 `doc list`/`search` 给出引导（REQ-02 标记检测路径）
  - **不可捕获中断（SIGKILL/kill -9）**：模拟 → 无标记文件，靠 **REQ-03 probe residue 检测**给出引导（probe 兜底路径）
  - `rebuild-vector` / `restore --rebuild-vector` 全量重建后检索完整（被中断批次可召回）
- **验收标准**：两种中断场景测试全绿（SIGTERM 验证标记路径、SIGKILL 验证 probe 路径）；重建后召回完整
- **改动位置**：`test/` 新增用例

### REQ-05 导入进度可观测性（O-01/02/03/05）

- **描述**：修复导入过程进度显示的 4 个缺陷：
  - **O-01 切分进度分母错误**：`import.ts:226` 用 `files.length * 10` 做分母，但 `entries.length` 是累计 chunk 数，大文件时分母远小于实际值，进度超 100%（实测 `1444/1430 (100%)`）→ 改为按**已处理文件数/总文件数**作分母（**用户决策 P-4**：清洗会过滤空 chunk，chunk 数在清洗后才确定，作分母会失真），进度恒 ≤100%
  - **O-02 并行进度条互相覆盖**：`import.ts:269-300` `Promise.all` 并行向量化与 KB 写入，两条链路都写 stderr `\r` 进度条，KB 写入（<1s）冲刷 embedding 进度（数分钟），用户看不到向量化进度 → 改为串行（推荐，KB 写入近实时无并行损失）或分区独立显示
  - **O-03 向量化无中间进度**：`bulkVectorize` 单次 `vectorBulkStore` 提交全部条目，engine 内部批量 embed 无中间态 → 分批提交（如 200 条/批）+ 批间 `logProgress`
  - **O-05 非 TTY 进度退化**：`progress.ts:145` 用 `\r` 覆写当前行仅 TTY 有效 → 检测 `process.stderr.isTTY`，非 TTY 时逐行输出
- **验收标准**：
  - 切分进度恒 ≤100%，无 `n/1430 (100%)` 类失真输出
  - 向量化与 KB 写入进度独立呈现、均有动态刷新（用户可感知向量化进行到哪一步）
  - 向量化长任务有批间进度反馈
  - stderr 重定向到文件/管道时进度仍可读
- **改动位置**：`src/lib/import.ts`、`src/lib/batch-vectorize.ts`、`src/lib/progress.ts`

### REQ-06 数据清洗 + local KB 与向量一对多（O-04，方案 D：文件级原文 + memoryIds 多值）

- **描述**：重构导入数据模型，**local KB 存文件级原文，向量存清洗后 chunk，两者建立一对多关系**（用户澄清确认，方案 D）。当前 `readFileToChunks`（`import.ts:162-165`）读原文切分，`phase4WriteRelations` 因 `e.path` 含 `#N` 降级用 chunk.text 写 local KB，导致 local KB 存 chunk 片段、非文件原文；且 frontmatter（`---` YAML 头）、UTF-8 BOM、空 chunk、mermaid、文件路径、代码块等噪音直接进入向量 content，污染语义与 BM25 检索。改造后导入流程：
  1. **文档进来第一步直接写入 local KB（原文，文件级）**：`handleDirectImport`/`handleIncrementalDirect` 在切分前按**文件**读原文（`fs.readFileSync(文件路径, 'utf-8')`），以**文件级 relation**（`deriveRelationText(文件路径)`，去 `.md` 扩展名）为 key 写入 local KB，一个文件一条记录。**前置检查顺序（S-1 决策）**：格式白名单检查（REQ-08）、大小上限检查（REQ-08）、relation 冲突检查**均先于写 local KB**——超限/冲突文件在写 local KB 之前即跳过，避免"写后又回滚"的浪费。**relation 命名冲突处理（用户决策）**：文件级 relation 命名取 basename 去扩展名（`deriveRelationText`），命名冲突仅可能发生在**相同 group 路径下**的同名文件（不同 group 由 `deriveGroupPath` 含目录层级天然隔离）；外部 Wiki 目录结构下通常不会发生。**若发生冲突（同 group 下 relation 名重复）→ 该文件直接跳过**，并**反馈用户**（列出冲突的 relation 名与文件路径，计入 skipped 统计）
  - **进度口径（意见3 决策）**：进度统计按"**local KB 写入完成**"计（第 1 步完成即计 1 文件），中断时"已写 local KB 未写向量"的文件在中断提示中**单独标注待重建**（`import.ts:226` 分母同此口径）
  2. **随后数据清洗**：对文件原文执行 `cleanMarkdownText`（默认开启，规则独立可配）
  3. **然后切分**：清洗后文本 → `splitIntoChunks` → 每段 chunk 向量化 → 获取每段 chunk 的 **memoryId**
  4. **写入 relation-cache 的 `memoryIds` 字段**：relation-cache 中该文件级 relation 记录挂 `memoryIds: string[]`（= 该文件全部 chunk 的 memoryId），`sourcePath` 存**文件路径**（无 `#N`）；增量 diff 的 `buildMemoryIdMap` 改为**直接读该字段**（文件级 key → memoryId[]），不再按 `#N` 前缀运行时聚合。**存量兼容策略：不做旧数据兼容**——旧库（chunk 级 relation/无 `memoryIds` 字段）需**重建 KB 与向量数据**（用户确认计划重建），`buildMemoryIdMap` 单一路径字段直读即可
  5. **原文召回**：`ki search` 命中任意一个 chunk memoryId → 通过 relation-map 反查所属文件级 relation → 返回该文件 local KB 原文；同一文件多个 chunk 命中时原文只返回一次（去重）
  - **`--no-vector` 语义（用户决策）**：`--no-vector` 只影响**是否做向量化这一步**——跳过向量写入（不产生 memoryId），**local KB 文件原文照常写入**（必须写入）；此时 relation-cache 文件级 relation 的 `memoryIds` 为空数组，原文召回仍可用（REQ-09 经 local KB 直接取原文），仅不可被 `ki search` 向量召回
  - **`--no-vector` 混用语义（推演问题 4 决策）**：同一 scope 混用 `--no-vector` 与正常（向量化）导入时——增量 diff 以**文件为单位**独立判定：某文件已向量化（memoryIds 非空）则后续正常导入按 modified 增量更新；`--no-vector` 导入的文件 memoryIds 为空，再次正常导入该 scope 时视为**新增**（重新向量化，旧空 memoryIds 被覆盖）。**存量 `--no-vector` 文件不做自动向量补写**（需用户显式重跑正常导入）；该边界标注于文档（既有已知边界，方案 D 下明确语义）
  - **增量 modified 原文更新时机（P-2 决策）**：incremental modified 场景下，**local KB 文件原文的更新与向量化保持一致的事务顺序**——先写新向量 chunk（成功）→ 再更新 local KB 文件原文 → 最后删旧 chunk/旧 memoryId；任一失败则**不更新 local KB 原文**（保持旧原文，与旧向量一致），确保 local KB 与向量不出现"新原文+旧向量"错配
  - **删旧与 memoryIds 字段原子顺序（推演问题 3 + N3 决策）**：第三步"删旧"与 relation-cache `memoryIds` 字段更新采用**先删后更**顺序——① 基于**旧 memoryIds 字段**删除旧向量 → ② 删除成功后再更新字段为新 memoryIds；若①失败 → **字段保持旧值**（不更新），并输出告警提示（该文件增量更新未完成，可重新执行或 rebuild-vector），**不产生孤儿向量**（字段指向的 id 与库中实际存在一致）。禁止"先更新字段后删旧"（否则删旧失败 → 字段指向新 id、旧 id 残留库中成为孤儿向量）。**部分删除中间态（推演 N3 决策）**：若删除为**批量执行**（一次删多个 id），中途失败导致**部分成功**——此时**字段保持旧值**（含已删 id），已删 id 成为"反向孤儿"（字段指向但库中已无）；处理：① 批量删除采用"逐 id 删除 + 收集失败"，全部成功才推进；② 若已发生部分删除，告警提示列出**已删/未删 id 清单**，并**记录该文件的增量未完成标记**（复用中断标记或独立 pending 标记），引导用户重跑该文件或 rebuild-vector；③ 下次 modified 再触发时，diff 基于新文件内容重新生成 memoryIds，**旧字段中的无效 id 在删旧时容错跳过**（删除不存在的 id 不报错）
  - **进度分母（P-4 决策）**：REQ-05 O-01 进度分母统一改为**文件数**（已处理文件/总文件数），不依赖 chunk 数（清洗会过滤空 chunk，chunk 数在清洗后才确定，作分母会失真）
  - **O-02 并行进度冲突（C-4 说明）**：当前 `import.ts:274` 用 `Promise.all` 并行向量化与 KB 写入导致进度条互相覆盖。方案 D 下 local KB 写入前置到切分前（第 1 步）、与向量化天然分离，**`Promise.all` 结构将简化**——向量化与 relation-cache 回填串行，无并行进度条冲突，REQ-05 O-02 的"串行化"建议自然达成
  - 清洗规则（**执行顺序约束，C-2/意见2 决策**：代码块**先于**路径剥离执行——代码块整体剥离（含短示例整块保留）后再做路径剥离，路径剥离**只作用于代码块外**，避免路径正则破坏保留的短代码示例）：
  1. 剥离 UTF-8 BOM（`/^\uFEFF/`）
  2. 剥离 YAML frontmatter（**整块删除**：首行 `---` 起至闭合 `\n---`，含 `title/date/tags` 等全部字段；仅当块内匹配键值对特征 `key:` 才剥，防误伤正文 `---` 分隔线；闭合 `---` 后须紧跟 `\n` 或 EOF）
  3. 折叠 3+ 连续空行为 2 个（保留段落边界供切分）
  4. **mermaid 块剥离**（` ```mermaid ... ``` `，图语法语义密度低、正文已覆盖图信息）
  5. **代码块剥离**（默认剥离；`keepShortSamples` 可保留 ≤15 行短命令/配置示例，如 curl/JSON 响应；**保留的短示例整体原样保留，不做内部清洗**）
  6. **文件路径剥离（模式识别，不依赖 `<cite>`/`**来源**` 等结构化标记）**：`file://` URL、markdown 文件链接、`#L188-L605` 行号引用、裸代码文件路径（`[\w./-]+\.(py|ts|js|go|java|rs|sh|md|json|yaml|yml)`；**前置排除 `https?://`/`ftp://` 等 URL**）；剥离后整行仅剩空白/符号 → 删行；**仅在步骤 5 代码块剥离后进行，作用于代码块外文本**
  7. 过滤空/近空 chunk（`if (!chunk.text.trim()) continue`）
  - 提供 `--no-clean` 逃生阀关闭全部清洗（依赖 frontmatter/代码块检索的用户可回退）；`cleanMarkdownText` 异常兜底（try-catch 降级返回原文，防中断导入）
  - **并发竞态（推演问题 5 + N4 决策）**：
    - **导入并发**：同一 scope 的**并发导入（两个 scan-kb import 同时跑）不在支持范围**——导入前检测是否已有进行中的导入，存在则**拒绝启动**并提示"已有导入进行中"；**串行导入是唯一支持形态**
    - **锁选型（推演 N4 决策）**：采用**导入锁文件**（`<scope>/.import.lock`，含 pid + 开始时间），**不复用 mcp lock**（mcp lock 是 stdio 服务进程锁，与 CLI 导入进程无关）；锁文件在**正常完成时删除**；**SIGKILL/崩溃时锁文件残留** → 启动导入时检测到残留锁（pid 不存在/超时）→ **视为死锁自动清理并警告**（"检测到残留导入锁，已清理"），避免永久拒绝；若 pid 仍存活则拒绝（真并发）
    - **导入中查询**：导入进行中执行 `ki search`/`doc list` → 读到部分写入状态属**已知边界**（写入非原子），不额外加读锁；中断标记写入后（REQ-02）查询会引导重建。此行为标注为已知边界，不承诺"导入中查询结果一致性"
- **验收标准**：
  - 向量 content 无 `\uFEFF`、无 `---title` 类 frontmatter 头、无 mermaid 块、无 file:// 路径残留
  - **local KB 存文件级原文（未清洗），一个文件一条记录**；`get-module-info` 按文件级 relation 返回整文件原文
  - **relation-cache 文件级 relation 挂 `memoryIds` 多值**，等于该文件全部 chunk 的 memoryId；单 chunk 命中可定位到文件原文，多 chunk 命中去重只返回一次
  - 空/近空文件不产生向量（节省 embedding 配额）
  - **同 group 下 relation 命名冲突的文件直接跳过并反馈用户**（冲突 relation 名 + 文件路径计入 skipped）
  - `--no-clean` 关闭后行为回退（不清洗）
  - 规则独立开关（`--clean-rules bom,frontmatter,mermaid,codePath,codeBlock`）生效
- **改动位置**：`src/lib/clean.ts`（新建：`cleanMarkdownText` 规则函数 + 模式识别路径剥离）、`src/lib/import.ts`（`handleDirectImport`：先写 local KB 文件原文 → 清洗 → 切分 → `bulkVectorize` → 回填 `memoryIds`）、`src/lib/incremental.ts`（`handleIncrementalDirect` 对齐 import.ts：先写 local KB 文件原文 → 清洗 → 切分 → 向量化 → 回填 `memoryIds`）、`src/lib/relation-map.ts`（memoryId 反查支持多值聚合到文件级 relation）、`src/search.ts`（命中任一 memoryId → 返回文件原文，去重）

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
  - **钩子协议**：每个**文件原文**（local KB 已先行写入后）经 stdin 传入钩子，stdout 输出清洗后内容（一次一个文件，互不感知）；钩子失败（非零退出 / 超时）→ 跳过该钩子 + 告警（不阻断导入）
  - **hook 失败回滚（P-7 决策）**：**所有** hooks 均失败的**文件不写入向量**，且 **local KB 回滚**（删除已写入的文件原文，保持 local KB 与该文件无任何记录，避免"有原文无向量"的悬空状态），该文件计入 skipped 并提示
  - **失败处理差异澄清（C-1）**：内置规则失败（`normalize` 异常等理论场景）→ `cleanMarkdownText` try-catch **降级返回原文继续**（不跳过）；外部 hook 失败（exit 1/超时）→ **回滚跳过**（上述 P-7）。两层语义不同：内置规则属"理论异常降级容错"，hook 属"外部进程不可靠安全隔离"
  - **执行顺序**：local KB 写入文件原文后 → 内置规则先执行 → 外部 hooks 依次（管道链）→ 切分向量化；`--no-clean` / `enabled:false` 全部关闭
  - **hook 子进程管理（推演 N5 决策）**：hook 以子进程方式执行（`child_process.spawn`）；**导入进程捕获 SIGINT/SIGTERM 中断时，同步终止正在运行的 hook 子进程**（发送 SIGTERM，超时后 SIGKILL），防止孤儿进程残留继续写 stdout；hook 子进程超时（默认 10s）同样终止。**中断时正在 hook 的文件**：该文件 local KB 已写（第 1 步）但未向量化 → 归入中断标记语义（REQ-02"待重建"引导），**不触发 P-7 回滚**（P-7 仅用于"hook 正常执行但失败"的确定性失败场景，中断是环境性中断，走中断标记链路）
  - CLI 补充：`--clean-rules bom,frontmatter` 覆盖内置规则开关（可选，不传用 config）
- **验收标准**：
  - config 配置 hooks 后，导入内容经过自定义清洗（端到端可验证，如 `doc list` 抽查）
  - 钩子失败不阻断整体导入（告警 + 计入统计）
  - `enabled:false` / `--no-clean` 完全关闭清洗（含 hooks）
  - hook 超时保护（默认 10s），不卡死导入
- **改动位置**：`src/lib/import.ts`（清洗链接入）、`src/lib/clean.ts`（新建：内置规则 + hook 管道执行）、`src/lib/config.ts`（schema 扩展 `clean`）、`src/scan-kb.ts`（`--clean-rules`）

### REQ-08 导入文件格式检查与大小限制（用户新增）

- **描述**：直接导入外部文档时，增加**文档格式检查**与**单文件大小限制**的显式化（当前 `collectMarkdownFiles` 已按 `/\.md$/i` 只收集 `.md`，非 md 文件静默忽略；大小上限 2MB 与 500 chunk 上限不协调）：
  - **格式白名单**：当前仅支持 `.md` 格式，其他格式**默认跳过**；跳过时**汇总提示**（统计并列出不支持格式的文件，如 `跳过 N 个不支持格式的文件：a.txt, b.pdf`），非 TTY 下同样可读；格式白名单可配置（`scopes.<scope>.import.extensions`，默认 `[.md]`，可扩展 `.markdown` 等）。**扩展名剥除一致性（P-8）**：白名单扩展非 `.md` 扩展名时，`deriveRelationText` 的剥扩展名逻辑须与白名单同步（按实际扩展名剥离，如 `.markdown` 文件剥 `.markdown`），保证文件级 relation 命名正确
  - **单文件大小上限**：默认从 **2MB 调整为 1MB**（用户确认，作为配置项 `scopes.<scope>.import.maxFileSize` 写入配置文件，**不作为 CLI 参数**）。依据：① 方案 D 下 local KB 存**文件级原文**，文件大小直接决定**原文返回体量**——1MB 中文 ≈ 33 万字符 ≈ 20-30 万 token，用户已接受此体量（超大文件属极端情况，`--no-clean` 等逃生阀可配合）；② 与 `MAX_CHUNKS_PER_FILE=500` 上限的关系——1MB 中文 ≈ 660 chunk 会先撞 500 chunk 上限（大小限制对中文大文件退化为兜底），英文 1MB 同样撞 500 上限，实际由 chunk 上限先行拦截，大小上限兜底异常字节情况
  - **chunk 超限兜底**：保留 `MAX_CHUNKS_PER_FILE=500` 硬约束，超长文件（字节未超限但 chunk 数超）仍按 chunk 超限跳过（已有行为）
- **验收标准**：
  - 导入含非 `.md` 文件（.txt/.pdf/图片等）→ 自动跳过且汇总提示"跳过 N 个不支持格式的文件"（含文件名）
  - 导入超过 1MB 的单文件 → 跳过 + 提示（配置项 `scopes.<scope>.import.maxFileSize` 可调）
  - `maxFileSize` 与 500 chunk 上限两者关系明确（字节超限 → 大小跳过；chunk 超限 → chunk 跳过）
- **改动位置**：`src/lib/import.ts`（`collectMarkdownFiles` 改为白名单 + 跳过统计提示；`maxFileSizeBytes` 从 config 读取，默认 1MB）、`src/lib/config.ts`（schema 扩展 `scopes.<scope>.import.extensions` + `scopes.<scope>.import.maxFileSize`）

### REQ-09 ki-search 返回原文（合并 REQ-20260807-002，以本需求设计为准）

- **描述**：方案 D 下数据清洗使向量 content 非原文，`ki search` 需支持返回 local KB 文件级原文。**本需求合并原 REQ-20260807-002（ki-search 返回原文支持），以当前设计为准**，原需求文档已删除。设计：
  - `ki_search` 新增 `include_original` 参数（**默认 true**）；CLI 新增 `--include-original`/`--no-original`
  - **原文获取**：命中任一 chunk memoryId → relation-map 反查文件级 relation → 从 local KB 取文件原文（`get-module-info` 路径复用）；同一文件多 chunk 命中去重只返回一次
  - **降级策略**：获取失败（relation 缺失/文件缺失）→ 返回原 search 信息 + `originalRetrieved:false` + **`originalHint` 失败提示**，**不抛错**。`originalHint` 文案**与 REQ-02 中断引导去重（意见1 决策）**：REQ-02 已在 `getEngine` 前置检测中断标记并给出 `rebuild-vector` 恢复引导，故 REQ-09 的 `originalHint` 在"本地 KB 缺失"场景**不再重复**完整恢复引导文案，仅精简提示（如"原文不可用，本地 KB 缺失"）；REQ-02 拦截已给过的重建引导不重复叠加
  - **sync-relation 兼容（S-3 决策）**：`sync-relation` 手动写入的 relation **无 `memoryIds` 字段**（非方案 D 导入链路）。方案 D 下 `buildMemoryIdMap` 字段直读遇到**无字段 relation** → 返回空数组（该 relation 无向量，不可被 search 向量召回）；sync-relation 的 relation 原文仍可经 local KB 直接获取（`get-module-info` 路径）。**不做存量迁移**（与 O-2 决策一致，重建时统一补齐）
  - **关系冲突的 relation 不产生原文**：同 group relation 冲突被跳过的文件无 local KB 记录，search 命中其向量（若有）时原文获取失败 → 走降级策略**
- **验收标准**：
  - search 命中向量 → 默认返回文件级原文（去重），**原文内容 = local KB 存储的未清洗文件原文**（交叉引用 REQ-06 验收第 2 条，同一数据源）
  - `--no-original` 关闭后不取原文、无额外开销
  - 原文获取失败 → `originalRetrieved:false` + `originalHint` 引导，不抛错
- **改动位置**：`src/search.ts`（include_original + 原文获取）、`src/lib/relation-map.ts`（多值反查）、`src/get-module-info.ts`（文件级原文读取）、`src/ki-search.ts`（CLI 参数，若存在）

## 5. 影响范围

| # | 调用方 | 影响 | 级别 |
|---|--------|------|------|
| 1 | `scan-kb import`（full 直导） | 新增 SIGINT/SIGTERM 处理 + 状态标记 | ❌ 行为变更（正常路径不变） |
| 2 | 所有向量命令（search/store/doc/scope/tag/restore） | `getEngine` 前置检测新增中断标记检查 | ⚠️ 需回归 |
| 3 | `ZVecEngine.probe` | 新增 residue 检测提示 | ⚠️ 需回归 |
| 4 | `scan-kb import` 切分/向量化阶段 | 进度输出重构（分母/并行/分批/TTY） | ⚠️ 需回归 |
| 5 | `scan-kb import` 导入内容 | **数据模型变更（方案 D）**：local KB 由 chunk 片段改存**文件级原文**（一个文件一条）；relation 由 chunk 粒度改**文件级**并挂 `memoryIds` 多值；清洗改变**入向量文本**（默认开启，`--no-clean` 可关） | ❌ 行为变更 |
| 6 | `scan-kb import` 导入内容 | 自定义清洗钩子（外部命令执行，配置驱动） | ⚠️ 行为变更（显式配置才生效） |
| 7 | `ki search` 原文召回 | relation 粒度变文件级；命中任一 chunk memoryId → relation-map 反查文件级 relation → 返回文件原文，多 chunk 命中去重 | ⚠️ 需回归（relation-map 反查聚合） |
| 8 | 增量 diff 链路 | `memoryIds` 持久化为字段，`buildMemoryIdMap` 改为字段直读（文件级 key → memoryId[]），移除 `#N` 前缀运行时聚合；**不做旧数据兼容**（旧库需重建 KB 与向量） | ⚠️ 需回归 |
| 9 | `scan-kb import` 文件收集 | 格式白名单显式化（非 md 汇总提示）；大小上限改为 **config 配置项**（`scopes.<scope>.import.maxFileSize`，默认 1MB，移除 CLI 参数） | ⚠️ 需回归（配置读取 + 跳过提示新增） |
| 10 | `ki search` / MCP | 新增 `include_original`（默认 true）+ 原文召回（文件级，去重）；失败降级 `originalRetrieved:false` + `originalHint` | ❌ 行为变更（新增参数 + 默认返回原文） |
| 11 | `get-module-info` | relation 粒度变文件级后，按文件级 relation 返回整文件原文（原 chunk 片段） | ❌ 行为变更（返回体语义变化） |

## 6. 文件路径清单

- `src/lib/import.ts`（REQ-01：中断捕获 + 状态标记；REQ-05：进度分母/并行/分批；REQ-06：local KB 文件原文写入 → 清洗 → 切分 → 向量化 → `memoryIds` 回填）
- `src/lib/vector-client.ts`（REQ-02/03：中断检测 + 引导 + lockedHint 增强）
- `src/zvec-engine/engine.ts`（REQ-03：probe 提示增强）
- `src/lib/batch-vectorize.ts`（REQ-05：分批提交 + 批间进度）
- `src/lib/progress.ts`（REQ-05：TTY 检测降级）
- `src/lib/incremental.ts`（REQ-06：对齐 import.ts 的文件原文写入 → 清洗 → 切分 → 向量化 → `memoryIds` 回填）
- `src/lib/diff.ts`（REQ-06：`buildMemoryIdMap` 改为字段直读——文件级 key → `memoryId[]`，移除 `#N` 前缀运行时聚合）
- `src/lib/clean.ts`（REQ-06/07：新建，内置清洗规则 + hook 管道执行）
- `src/lib/relation-map.ts`（REQ-06/09：memoryId 反查聚合到文件级 relation，多值去重）
- `src/search.ts`（REQ-06/09：命中任一 memoryId → 返回文件原文 + include_original 参数）
- `src/get-module-info.ts`（REQ-06/09：文件级原文读取——relation 粒度变文件级后，按文件级 relation 取整文件原文）
- `src/ki-search.ts`（REQ-09：CLI `--include-original`/`--no-original`）
- `src/lib/config.ts`（REQ-07：schema 扩展 `scopes.<scope>.clean`；REQ-08：`scopes.<scope>.import.extensions` + `scopes.<scope>.import.maxFileSize`）
- `src/scan-kb.ts`（REQ-07：`--clean-rules`）
- `test/`（REQ-04：中断模拟用例；REQ-05/06：进度、清洗与一对多召回用例；REQ-07：hook 管道用例）
- `docs/cli.md`、`docs/scan-kb.md`（行为说明：中断提示、恢复引导、清洗开关与 hook 配置、一对多语义）

## 7. 测试方案

| 测试场景 | 优先级 | 说明 |
|----------|--------|------|
| 导入中断（kill -9）后 doc list/search 可引导 | P0 | 直接对应本次事故 |
| 中断后 `rebuild-vector` 全量重建后检索完整 | P0 | 验证自愈路径有效 |
| 含 frontmatter/BOM fixture 导入 → 向量 content 无污染 + local KB 抽查存文件级原文（未清洗） | P0 | 验证 REQ-06 清洗与原文保留（方案 D） |
| 多 chunk 文件导入 → relation-cache 文件级 relation 挂 `memoryIds` 多值 + search 命中任一 chunk 返回文件原文、多命中去重 | P0 | 验证 REQ-06 一对多召回 |
| 同 group 下同名文件（如 `a/README.md` 与 `b/README.md`）→ 后者跳过 + 反馈冲突 | P1 | 验证 REQ-06 relation 命名冲突处理 |
| probe 只读打开在正常库上无副作用 | P1 | 回归基线 |
| 中断标记存在时引导提示出现、无标记时零输出 | P1 | 新功能验证 |
| 切分进度恒 ≤100%（大文件 fixture） | P1 | 验证 REQ-05 O-01 |
| 非 TTY 下进度可读（stderr 重定向） | P1 | 验证 REQ-05 O-05 |
| config 配置 hook（如 node 脚本去行号）→ doc list 抽查已清洗 | P0 | 验证 REQ-07 钩子生效 |
| hook 失败（exit 1）→ 不阻断导入 + 计入统计 | P1 | 验证 REQ-07 容错 |
| `enabled:false`/`--no-clean` → hooks 与内置规则全部关闭 | P1 | 验证 REQ-07 逃生阀 |
| 导入含非 `.md` 文件目录 → 非 md 跳过 + 汇总提示（含文件名） | P1 | 验证 REQ-08 格式检查 |
| 导入 >1MB 单文件 → 大小跳过 + 提示；config `scopes.<scope>.import.maxFileSize` 可调 | P1 | 验证 REQ-08 大小限制（配置驱动） |
| 增量 modified 文件 → local KB 原文更新 + 旧向量删除正确，无"新原文+旧向量"错配 | P0 | 验证 REQ-06 增量原文更新时机（P-2） |
| 增量 deleted 文件 → local KB 文件原文与向量一并清除 | P1 | 验证 REQ-06 增量清理（buildMemoryIdMap 字段直读） |
| `--no-vector` 导入 → local KB 文件原文写入、`memoryIds` 为空、原文召回可用 | P1 | 验证 REQ-06 --no-vector 语义 |
| search 命中 → 默认返回文件原文去重；`--no-original` 不取原文 | P0 | 验证 REQ-09 原文召回 |
| search 原文获取失败（relation 缺失）→ `originalRetrieved:false` + `originalHint` 不抛错 | P1 | 验证 REQ-09 降级策略 |
| 中断标记存在 + search 原文缺失 → 引导不重复叠加（`originalHint` 精简，无双重 rebuild-vector 文案） | P2 | 验证 REQ-09 引导去重（意见1） |
| `--no-clean` + `--no-vector` 组合 → local KB 原文写入、无清洗、无向量、原文召回可用 | P2 | 验证 S-2 组合语义 |
| 短代码块 + keepShortSamples=true → 短示例整体保留且不被路径剥离破坏 | P2 | 验证 REQ-06 清洗顺序（意见2） |
| 超限/冲突文件 → 不写入 local KB（前置检查先于写入） | P2 | 验证 S-1 前置检查顺序 |
| SIGTERM 中断 → 标记文件写入 + 引导；SIGKILL 中断 → 无标记、probe 兜底引导 | P0 | 验证 REQ-01/04 双路径（推演问题 1） |
| rebuild-vector 成功后标记清除、引导消失 | P1 | 验证 REQ-02 标记生命周期（推演问题 2） |
| 增量删旧失败（模拟删除抛错）→ memoryIds 字段保持旧值 + 告警，无孤儿向量 | P0 | 验证 P-2 删旧原子顺序（推演问题 3） |
| --no-vector 导入后正常导入同 scope → 原 no-vector 文件重新向量化 | P2 | 验证混用语义（推演问题 4） |
| 第二并发导入 → 拒绝启动 + 提示已有导入进行中 | P2 | 验证并发控制（推演问题 5） |
| 纯 KB 命令（不碰向量）在中断标记存在时不触发引导；向量命令触发 | P2 | 验证 probe 触发命令范围（N1） |
| incremental 增量导入成功后标记清除 | P2 | 验证标记清除时机（N2） |
| 删旧批量部分失败 → 告警含已删/未删清单 + 文件记增量未完成 + 字段保持旧值 | P0 | 验证部分删除中间态（N3） |
| SIGKILL 后残留导入锁 → 下次导入自动清理 + 警告 | P1 | 验证锁残留处理（N4） |
| 中断时 hook 子进程被终止、无孤儿进程；中断文件走中断标记不触发 P-7 回滚 | P1 | 验证 hook 子进程管理（N5） |

## 8. 验收标准

1. 导入中断后，任意向量命令输出可执行恢复引导，不再出现 zvec 原生 ERROR 刷屏
2. 中断标记可识别且不污染正常路径
3. `rebuild-vector` / `restore --rebuild-vector` 重建后，被中断批次的文档可正常检索
4. 全量测试通过（含新增中断用例），lint 零错误
5. 导入进度恒 ≤100%；向量化与 KB 写入进度独立呈现，均有动态刷新
6. 导入内容经清洗：无 BOM/frontmatter/空 chunk 污染（`--no-clean` 可关闭）；**local KB 存文件级原文（未被清洗）**；relation-cache 文件级 relation 挂 `memoryIds` 多值；search 命中任一 chunk memoryId 返回文件原文且重复命中去重
7. config 配置的自定义清洗钩子按序生效；钩子失败不阻断导入且超时有保护
8. 导入格式白名单生效（非 `.md` 自动跳过并汇总提示）；单文件大小上限由 config `scopes.<scope>.import.maxFileSize` 控制（默认 1MB，非 CLI 参数）
9. `--no-vector` 只影响向量化，local KB 文件原文必须写入（`memoryIds` 为空，原文召回仍可用）
10. `ki search` 默认返回文件级原文（去重）；`--no-original` 关闭；原文获取失败 → `originalRetrieved:false` + `originalHint` 不抛错
11. 中断恢复双路径：SIGTERM 写标记 + SIGKILL probe 兜底；`rebuild-vector` 成功后标记清除
12. 增量删旧失败 → memoryIds 字段保持旧值 + 告警，无孤儿向量
13. 同 scope 并发导入被拒绝；`--no-vector` 混用语义明确（存量文件需显式重跑向量化）
14. probe 触发范围明确：向量命令触发引导，纯 KB 命令不触发（或保持一致按"是否打开向量库"判定）
15. 标记清除覆盖 full/incremental 成功导入；删旧部分失败 → 告警含 id 清单 + 增量未完成标记，无孤儿
16. 导入锁文件正常完成删除、SIGKILL 残留自动清理；中断时 hook 子进程被终止无孤儿

## 9. 当前进度

- [ ] REQ-01 导入中断安全收尾
- [ ] REQ-02 中断标记检测与恢复引导
- [ ] REQ-03 probe 异常提示增强
- [ ] REQ-04 中断恢复测试
- [ ] REQ-05 导入进度可观测性（O-01/02/03/05）
- [ ] REQ-06 数据清洗 + local KB 与向量一对多（O-04，方案 D）
- [ ] REQ-07 自定义数据清洗钩子
- [ ] REQ-08 导入文件格式检查与大小限制
- [ ] REQ-09 ki-search 返回原文（合并 REQ-20260807-002）
- **状态**：草案（已落盘，待评审确认）
