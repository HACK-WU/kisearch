# AGENTS.md - AI AGENT 项目记忆文件

## 🔑 第一原则：遇事不决，ki-search

**遇到任何不知道的问题、信息或不确定的内容，先用 `ki_search` MCP 工具查项目记忆，不凭记忆猜、不凭印象答。**

- **默认直接查视图 `kisearch-docs`**：`ki_search(scope: "kisearch-docs", query: "...")` —— 视图自动展开为成员库、结果统一排序并按来源标注（响应里看 `scopes` / `matchedByScope` 核对本次实际参与的库）。
- **`kisearch-docs` 成员（2026-11-12 核对：`usableCount 2/2`，无降级）**：
  - `kisearch-memory` — 项目记忆（上下文 / 决策 / 踩坑 / 架构 / 工具库）
  - `kisearch-xperts` — 专家资产（业务模块的契约层与实现层文档）
  - **★ 成员不含代码知识库 `kisearch`**（它是独立的代码索引，不在该视图内）。需要代码知识时叠加：`scope: "kisearch-docs,kisearch"`（实测可用，结果按库标注）；纯记忆/专家查询仍只用 `kisearch-docs`。
- **`threshold` 量级不同**：单库 `0.02~0.03`、视图（多库）`0.6~0.8`，混用会全灭或全留。
- **其他视图**：需要别的聚合时先 `ki_view_list()` 看现成视图（本项目只认成员含 `kisearch` 同词根的视图，其余如 `sre-license-docs` 忽略）；成员会变，上面的成员表需复核时用 `ki_view_list(verbose: true)`。
- **视图只读**：写入（`ki_sync_relation` / 上传文档）必须用真实库名（如 `kisearch-memory`），用视图名会被拒。
- 同源约定：`rules/ai-codekb-memory.md`「第一性原则：遇事不决 ki-search」

---

> **本文件由 AI AGENT 自动维护，用于缓存项目记忆索引（`kisearch-memory`）、同步「团队约定」Group 占位、存储用户画像、记录近期工作与进度、跟踪新需求。**
>
> **代码知识库（`kisearch`）索引不写入本文件**，查询代码知识时直接使用 `ki-search` 访问 ki。
> **使用 ki-search 语义检索时，直接用视图 scope `kisearch-docs`（成员 `kisearch-memory` + `kisearch-xperts`）；需要代码知识时叠加 `kisearch`（`kisearch-docs,kisearch`）。**
---

## 项目记忆索引

> 数据来源：ki 的 `kisearch-memory` scope（2026-08-28 初始化，2026-10-29 校验）。代码知识库 `kisearch` 的索引不缓存于此。
> 规模：36 索引（热 10 / 常温 13 / 冷 13）。

### kisearch-memory 索引

#### Group 结构

- 背景与目标
- 技术栈选型
- 团队约定
- 项目历史
- 当前状态
- 外部依赖
- 项目踩坑点
- 项目架构
- 工具库
- 常用命令
- 部署运维
- 专题记忆
  > **注意**：专题记忆组下必须创建子索引（子组）后才能写入记忆片段，禁止直接向专题记忆组写入 relation。
  - 知识索引导入、向量引擎专家、关系与索引管理专家、检索与向量客户端专家、AI对话链路
- 接口信息
  - 知识索引导入、关系与索引管理、检索与向量客户端
- 数据流
  - 知识索引导入、向量引擎、关系与索引管理、检索与向量客户端
- 关联关系
  - 知识索引导入、向量引擎、关系与索引管理
- 错误库
  - Web前端界面、关系与索引管理、数据源管理
- 决策记录
  - 浏览页头部、图表渲染、侧边栏与导航
- 通用记忆片段

#### 热门 Relation

- `专题记忆/关系与索引管理专家` → 模块骨架与入口分层 (0.6)
- `数据流/关系与索引管理` → 数据实体与落点 (0.4)
- `项目架构` → 混合检索的文档内高亮与开关（判据不可用 fullTextOnly）(0.2)

---

## 团队约定

> **同步源**：ki `kisearch-memory` → 「团队约定」Group。本节为缓存，权威数据在 ki，便于 agent 免查询直接获取。
> **无内容时写 `无`**；写入 ki 后须回刷本节。同步日期：2026-11-05（其中 1 条来自用户当面拍板，**尚未写入 ki**，下次同步时补登）。

- **`docs/` 下的文档是给用户看的，不写开发逻辑**（2026-11-05 用户拍板）
  - **要写**：怎么用、参数与响应字段、会看到什么现象、出错怎么补救、升级 / 回滚会不会坏事
  - **不写**：源码路径与文件名、内部字段与存储细节、决策编号（`D3` / `R-09` / `REQ-xxx`）、内部算法与判据、「为什么这么实现」的论证、`fail-loud` / `fan-out` 这类内部术语，以及原型污染 / 文件锁 / 缓存机制之类只有维护者关心的原因
  - **落点**：开发向的理由写进**代码注释**（函数头、分支处），不要搬进 `docs/`
  - **自查**：写完 docs 后 grep 一遍 `src/`、`REQ-`、`D[0-9]`、`fail-loud`、`fan-out`、`判据`、`幂等`，命中即复核是否真该留在用户文档里

---

## 用户画像

> **用户画像直接存储于本文件，不写入 ki 记忆。**
> 按维度维护，每个维度一个小节，内容为用户偏好的事实描述（1-3 条，简洁明确）。

### 沟通偏好

- 语言偏好: 中文
- 回复风格: 简洁直接、结构化输出（带标题与列表）

### 工作习惯

- 偏好 fail-loud + 给出路的错误处理哲学，反感静默失败
- 重要决策（如 breaking change、不兼容迁移）由用户显式拍板后才执行
- 重视 challenger / auto-review 等二次质疑闭环，修复需附验证证据（tsc + 回归测试）
- **禁止擅自 git commit**：任何提交（含文档仓）必须先征得用户同意，即使任务已完成、测试全绿
- 代码修改完成后，若项目提供构建命令，应重新构建受影响项目并记录构建结果

> **新增维度**：发现以上维度无法覆盖的偏好时，直接新增小节，命名保持"4-8 字名词短语"。

---

## 近期工作 (7天内)

> 最近需求/进度直接存储于本文件，不写入 ki 记忆。**超过 7 天的条目移入项目根目录 `archive.md`**（待决/进行中永久保留）。
> 2026-10-21 及更早的全部记录（含原「最近需求」「进度」「历史工作记录」）已归档至 `archive.md`。

### 待决（进行中）

- [2026-11-16] ✅ 对外上传接口支持文档分类（lifecycle/ttlDays/event）：上传文档脱离「数据源」身份、覆盖保持原值；修 hidden 摘索引空操作；16 例新测 + 真机验通

- [2026-11-16] 🔄 **REQ-20261116-003 ki_ask 问答按来源分组上屏（实施中·B0 完成）**：左栏按来源分组 + 只读详情已落真实页面（mock 数据），头部切换按钮右移；web 1229/1229、build ✓；下一步 B1 后端数据层

- [2026-11-16] ✅ **上传导入 + 知识写入合并为一项**（REQ-20261116-002）：侧栏 10→9 项，`/import`、`/write` 同页双 tab（H1「知识写入」），两面板 AppShell 常驻、切 tab 不卸载；web 1211/1211、真机 24/24；全仓 build 被外部在途文件 `web/src/chat/PromptConfigLayer.tsx` 阻断
- [2026-11-16] ✅ **分类页文档列表分页**（REQ-20261116-001）：客户端分页默认 20/页、全选=当前页、切筛选清空已选、>200 篇显式提示；web 1192 全绿、真机 24/24
- [2026-11-16] 🆕 **需求目录回填为事件**：`CodeWikiHub/kisearch/requirements` 下 35 个需求目录 → `POST /api/governance/events`（scope `kisearch-memory`，类型 et_3「需求实现」，阶段 st_1「实施中」，标题 `[YYYY-MM-DD] feature`，按目录日期升序创建故 #1~#35 与历史顺序一致）；全部未收口、未绑成员文档；2 个未在 meta.json 登记（`2026-11-06-单库定标加权`、`2026-11-06-向量重建id失配`）按目录名兜底；meta.json 另有 13 条无目录的需求未建

- [2026-11-16] ✅ **侧边栏重排**（用户："每个 tab 上下距离太远 / 分组是否合适 / 组标题样式"）：行高 42→34、项间距 3→2、组间 0→20、组标题 11px/700/.12em → 11px/600/.04em、品牌区下 32→24、激活竖条 9→7；分组 工作空间(9) → 工作台(5)/接入与运维(4)/知识治理(3)，治理三项留在底部不动位置记忆；侧栏总高 779→691 顺带解掉 768 高窗口下页脚被隐藏滚动条静默沉底；web 1216/1216、tsc/build ✓、agent-browser 1440×900 + 900×800 实测；详情 ki 决策记录/侧边栏与导航

- [2026-11-16] ✅ **修 Bug：CLI 登记的数据源在数据源页看不到**（kisearch-memory）——根因 `scanDataSources` / `listRegisteredDataSourceRecords` 只扫 `dataDir` 目录，配置了 `scopes.<x>.kbDir` 的 scope 其 `datasource.json` 落在外面 ⇒ 列表页、定时调度器、共享 clone 引用计数全当它不存在；抽出 `enumerateScopeNames`（config.scopes ∪ dataDir，过滤保留字）两处共用，对齐 `listAllScopes` 口径；21 个 datasource 测试 200 例 + 新增 4 例全绿，daemon 重启后 `GET /api/datasource/list` 返回 8 条含 kisearch-memory；详情 `.debug/datasource-list-missing-kbdir-scope-20261116/`

- [2026-11-16] ✅ **修 Bug：数据源页刷新瞬间所有行闪「仅全文」**——把向量状态 `checking` 误当成「确诊不可用」；新增 `isVectorConfirmedUnavailable()`（只认 `unavailable`）驱动顶部横幅与行徽标，同步按钮禁用仍按 `!available`（行为约束，checking 期间短暂禁用无副作用）；web 全量 **1178/1178**、tsc/build ✓；详情 `.debug/datasource-vector-badge-flicker-20261116/`

- [2026-11-13] 🆕 **REQ-20261113-004 立项**：知识治理（文档分类 / 事件 / 回收站 / 参考文档）——四轮讨论收敛的完整方案已出可交互 demo（4500 行单文件，含暗色/窄屏/拖动排序/AI 过程展示），demo 与文档同目录；核心结论：两维度正交（分类=何时消失、阶段=何时可检索）、三档可见性而非布尔、回收站必须删除即摘四类索引、参考文档是引用不随阶段变；三期路线（回收站+分类 8~12d → 事件 10~15d → 参考文档+AI沉淀 6~8d）；状态草案待确认

- [2026-11-13] 🆕 **REQ-20261113-003 立项**：事件源码分析（只读）——事件页一键分析源码，产出待确认草稿。已核实 `DataSourceKind` 含 `git`（数据源能力现成）、ki 已有 chat tool-loop ⇒ **不引入 Pi Agent**，缺的只是 4 个只读文件工具 + 一条 pipeline；四条硬边界：代码不入库、永不给 write/edit/bash、产物是草稿、预算硬上限；**前置依赖「事件实体」尚未落地**；状态草案待确认

- [2026-11-13] ✅ **资源页删除「记忆闭环」卡片**（用户拍板：不再引入其他项目的记忆 skill/rules）：连同 `MEMORY_SKILLS` / `MEMORY_RULE_FILE` / 两条命令常量、`.res-more--block` / `.res-more__body` 样式、对应测试一并移除；web **1153/1153**、tsc/build ✓

- [2026-11-13] ✅ **MCP 工具描述补「精确查询 vs 语义检索」判据**：`ki_scope_list` 增三步翻书链路（**必须含 `ki_group_list`**——`get_module_info` 要精确 group/relation 名，`scope_list` 给不出）、`ki_search` 加反向指路、`docs/mcp-tools.md` 同步一句；chat 版刻意不动（scope 由 daemon 注入，列库无意义）；tsc/build ✓、mcp-token-readonly 28/28、daemon 已重启 + 真实 `tools/list` 验通；详情 ki 决策记录

- [2026-11-13] ✅ **REQ-20261113-002 已修复**：FTS-only→dense 切换后旧全文索引残留（fulltext 返回过时内容）——新增共用清理原语 + 单条/批量两条路径接入（先写 dense 后清、失败保留 ID 并透出 `ftsRemoved`/`ftsCleanupFailed`/`ftsCleanupReason`）；9 例新单测 + 真机旧词 0 命中；复核还纠正了「hybrid 去重掩盖」的错误机制（实为不查 FTS-only 库）与降级暴露路径；详情 ki 错误库/关系与索引管理

- [2026-11-13] ✅ **阅读器新增「下载 .md」**：与「复制」同源、只读库可用，片段态文件名加「-命中片段」，objectURL 延迟释放；窄屏阈值 820→880；web **1154/1154**、tsc/build ✓，**未真机点击验证**

- [2026-11-13] ✅ **阅读器新增「删除」（二次确认）**：预检源文件落点/草稿/数据源归属，可只删库保留 wiki 源文件，数据源文档放行并预告；两端测试全绿、daemon 已重启，详情 ki 决策记录

- [2026-11-13] ✅ **REQ-20261113-001 新增 MCP 问答工具 `ki_ask`（已实施，未提交）**：形态 B 无状态 RAG（不落盘 / 不进会话列表），轮次上限 6、软预算 25s / 硬预算 45s、内层恒只读（`knowledge.read`）、只读 Token 拒绝（`TOKEN_MODEL_FORBIDDEN`）、限流 10 次/60s + 并发 2、审计只记长度；**22 例新单测全绿 + test:chat 与基线一致 + 真链路 12/12**（daemon 已重启加载新代码）；IDE 内实测 5 次后又修 2 个缺陷——**强制作答触发 deepseek-flash 把工具调用写成 DSML 文本**（答案全废，加 system 收口提示后 3/3 恢复）、sources 噪声 40→15 条；详情 `CodeWikiHub/kisearch/requirements/2026-11-13-mcp-stateless-ask/`

- [2026-11-13] ✅ **上传即回写**：对外上传接口与 Web 上传导入后写回 wiki（根因 `runImportJob` 从未传 `wikiWriteback`）；status 暴露 `wikiWriteback` 计数；测试 5/5、tsc 0，**daemon 已重启并真机 curl 验通**（`written:1` + wiki 文件生成）；详情 `.debug/openapi-upload-wiki-no-writeback-20261113/`

- [2026-11-12] ✅ **修 Bug：文档正文目录点了不跳转**（根因：标题从来没有 id，marked v18 也不再自动生成）—— `renderer.heading` 补 GitHub 口径 slug + 点击代理（精确 id → 去标点兜底 → 滚 `.ki-drawer__body` 留 20px）；真实 KB 两篇 ×10 锚点 + 三种锚点写法全通，web **1138/1138**、tsc/build ✓；详情 `.debug/md-heading-anchor-no-jump-20261112/` 与 ki 错误库

- [2026-11-12] ✅ 总览 scope 表：冷热列改**热度条**（热=红 / 温=黄 / 冷=淡蓝，24×6，亮暗两套 `--ki-heat-*`）、「无调用」不画条并贴列左边缘；查询/写入/文档数列 169→109px、左对齐内缩 32px；**641~1100px 与 ≤640px 各有列宽回填**（否则热度条/数字溢出，实测 961/641/390 三处共 194 行溢出，已全部归零）；demo `demo/heat-badges/`；web **1130/1130**、tsc/build ✓、12 档视口实测；详情 `.debug/scope-table-align-20261112/`

- [2026-11-12] ✅ **新增「移动文档」到其他 Group（含移动时改名 / 移到根目录）**：`POST /api/doc/move` + `src/lib/doc-move.ts`（预检 → 搬源文件 → 复用 sync/delete 两条链 → 回滚）；前端复用导入页 `GroupPathSelect`，同名冲突提示改名，数据源文档 409 禁移，wiki 源文件随移；同日追加**通用「根目录」选项**（`rootOption` 组件级开关，仅移动弹窗开启；`allowRootGroup` 放行保留键但不打兜底标记，源侧仍禁）；后端 7/7、web **1129/1129**、两端 build ✓；真机已验证移动到普通组成功、**根目录待重启 daemon 复验**；详情 `.requirements/2026-11-12-doc-move/`

- [2026-11-12] ✅ **mermaid 也并入「图表 / 代码」双面板**（用户：「现在 mermaid 也支持 tabs 切换」）：删掉 mermaid 独立渲染 effect，三类图统一走 `data-ki-diagram` 一条通道；容器保留 `.ki-mermaid` 类做选择器兼容（CSS 归零该类的卡片样式）。**行为变更**：`::: code-group` 内放 mermaid 不再出图（该用法文档本就禁止）。web **1109/1109**、tsc/build ✓、真机三类图同页 + 切面板 + 复制原文 + 暗色重绘 + 语法错误兜底；详情 ki 决策记录/图表渲染

- [2026-11-12] ✅ **追加 ECharts 图表渲染**（用户给 ```echarts + option JSON：「就是这个样子能渲染」）：`echarts@6.1.0` 懒加载（1.1MB/360KB gzip）+ **静态 SVG 快照**（无 tooltip），与 PlantUML 共用 `data-ki-diagram` 双面板；真机两个坑已修——zrender 根 svg 的 `position:absolute` 会盖住工具条（tab 点不到）、无 viewBox 导致只裁切不缩放（`normalizeEchartsSvg`）。web **1106/1106**、tsc/build ✓、真链 echarts+plantuml 同页出图；详情 决策记录/图表渲染 + `.debug/md-fence-plantuml-not-rendered-20261112/`（E-06）

- [2026-11-12] ✅ **新增 PlantUML 图表渲染 + 「图表 / 代码」切换**（用户 `/debug` 报「md 文档没渲染 mermaid」）：根因是该块围栏是 ```plantuml（PlantUML 语法），ki 只把 `language-mermaid` 交给图表链路 ⇒ 显示为普通代码块且无任何提示。用户拍板走**纯前端** `@plantuml/core`（无 Java、不出网，实测 240ms 出图）+ 双面板；失败退回纯代码块 + ⚠ 标记。web **1092/1092**、tsc 0、build ✓、真机 17/17；详情 决策记录/图表渲染 + `.debug/md-fence-plantuml-not-rendered-20261112/`

- [2026-11-12] ✅ 文档编辑器「强制保存（以 KB 覆盖回写目标）」：force 只放宽回写目标侧校验（KB 锁/索引不动），编辑器 + 添加链接双入口；后端 10/10、真机 19/19+10/10，详情 `.requirements/2026-11-12-doc-force-save/`

- [2026-11-12] ✅ **修 Bug：wiki 写回目标只认 `wikiSync.sourceDir`**（`source` 块退出定位，上传导入时它指向 import-uploads 副本，导致编辑永远写不回用户仓库）；文案全面改「wiki 回写目标」+ 错误区给「用 KB 覆盖该文档」按钮与数据源提示（不可点）；8 个后端测试文件按新语义同步；真机 `sourceFile` 已指向 `/root/learning/k8s`，详情 `.debug/force-save-wrong-target-20261112/`

- [2026-11-12] ✅ 编辑器「保存时向量化」默认值改为跟随文档索引（B 口径：dense 开 / fts 关，不隐式升级），开关说明按 indexMode 分两种说法；web 1080/1080、真机 19/19+7/7、build ✓，详情 ki 决策记录

- [2026-11-12] ✅ 检索入口改为视图 `kisearch-docs`（成员 memory + xperts；不含代码库，需时叠加 `kisearch`），AGENTS.md 第一原则与文件头同步，详情 ki 决策记录

- [2026-11-12] ✅ 对话配置确认卡竖排修复：锚行扩到 skill 卡片 + 宽度下限 240px（36→355px），依赖提示文案缩成一句；web 1065/1065、build ✓，详情 ki 错误库/Web前端界面

- [2026-11-12] ✅ 对话输入框 `/` 斜杠点名 skill + 输入框内 token 高亮（主色块 + ✦ 标志，只读镜像层实现，无 token 时零影响）；两端 build ✓ / web **1075** 全绿 / 真机走查 26+19；**待重启 daemon** 才在真实链路生效。详情 `.plans/2026-11-12-chat-slash-skill/`

- [2026-11-11] ✅ 新增内置 skill `doc-editing`（改文档，**默认停用**）：依赖 `ki_edit_relation` 工具——前端点开关只指路「去启用」（不代开）、关工具时联动停用该 skill、后端保存严格 400 / 读取就地停用；老配置缺该内置项**自动补齐**（不报错，否则整份回退默认）。后端 `test:chat` 26/29（3 个既有失败）、`prompt-config` **41/41**、web **1033/1033**、两端 build ✓。详情 `.requirements/2026-11-11-doc-editing-skill/`

- [2026-11-11] ✅ skill 名称强制英文：内置名 `知识库检索` → **`knowledge-retrieval`**（服务端 `BUILTIN_SKILL_NAMES` 强制，老配置读取即迁移；中途曾取 `ki_search`，因与只读工具同名当天改掉）；新增/改名走 `SKILL_NAME_RE`（字母开头、禁空格）；读取宽松 + 既有名放行防整份回退与保存死锁。后端 `test:chat` 26/29（3 个失败为工作区既有改动）、web **1027/1027**、两端 build ✓；真实配置已落盘迁移（备份 `.bak-20261111` / `.bak-20261111-v2`）。详情 `.requirements/2026-11-11-skill名称英文/`

- [2026-11-11] ✅ 引用附录 prompt 两点修正：围栏显式标注「group 路径：」（部分模型会把前半段当文档名）+ `__root__` 映射成「根目录」（存储保留键不再铺给模型）；**同口径补齐历史轮次回放**（`replay.ts` 原只写文档名，同名文档跨 group 会混淆）；`chat-refs` 18/18 · `evidence-replay` 21/21

- [2026-11-11] ✅ 引用 chip 悬停浮层：草稿态 / 已发送两处都改为与「来源」卡同款（`.ki-chat-ref-pop`，取值逐项对齐 `.ki-chat-src__pop`）；真机修两坑 —— 用户气泡收缩到内容宽致卡片只有 142px（改固定 300 上限）、右对齐气泡里左展开会顶出视口（改 `right:0`）

- [2026-11-11] ✅ 对话工具卡片：入参统一 JSON + query/args 随 progress 落盘（刷新后仍在）+ 非检索不显示命中数（未提交；详情见 `.plans/2026-11-11-chat-tool-args-json/` 与 ki 专题记忆）

- [2026-11-11] ✅ 编辑重发输入框「双层绿框」修复：补 `.ki-chat-edit__ta:focus-visible{outline:none}`（全局无前缀 `:focus-visible` 后置覆盖所致）；1001/1001 绿，详情见 ki 错误库

- [2026-11-11] ✅ 对话配置：危险开关确认改「行内浮层无遮罩」+ 配置层改「改动即时生效」（去掉底栏取消/保存）
  - **问题一**：全屏阅读器下点 `ki_store` 只变黑、不弹确认框。根因：确认遮罩就地渲染在 `.ki-chat-cfg`（`position:absolute;z-index:20`）里，层叠上下文被困住，被 `.ki-drawer`(z:1000) 整块盖住（`elementFromPoint` 实测命中 `ki-drawer__body`；隐藏抽屉后卡片立刻显形）。用户拍板 **A 方案**：去掉遮罩，改锚定该行的行内浮层（`position:absolute` 现算落点，窄屏浮层的 `transform` 会把 `fixed` 参照系带偏）。
  - **问题二**：「开了 MCP 重开又关了」不是没存住 —— 确认只写草稿、0 次 `PUT`、✕ 关闭不询问、磁盘 mtime 停在 10-14。用户拍板 **B 方案 + 去掉底栏取消/保存**：改完即落盘（串行+合并队列，文本输入 350ms 防抖、失焦/关闭前 flush、基线不覆盖在途改动、失败可重试）。
  - 落点：`web/src/chat/PromptConfigLayer.tsx`、`web/src/styles/ki.css`、新增 `web/test/prompt-config-confirm.test.mjs`(5) 与 `web/test/prompt-config-autosave.test.mjs`(6)；证据 `.debug/chat-cfg-danger-confirm-blank-20261111/`。
  - 验证：`tsc` 0 · `npm test` **997/997** · `npm run build` ✓ · 真机 4 场景（全屏/窄屏/滚出收起/删除 skill）+ 即时生效 5 步（开层 0 请求、确认即 1 次 PUT、重开仍开、防抖合并 1 次、关回 false），测试后已还原 `/root/chat/prompt-config.json`。

- [2026-11-10] ✅ `agents-md-init` 集成 `ki-upload` 文档入库约定（§2.4）+ 视图检索提示（§2.1 ⑧，不缓存视图列表）

- [2026-11-10] **取消 `ki datasource add --source` 的 Git 仓库自动识别（缺省 = 目录）**（已完成，未提交）
  - **诉求**（用户原话）：「当前 ki datasource add 时，会自动识别目录是否是一个git 仓库。取消这个自动识别功能，默认就是目录」。走 `product-manager` M1 一次成型档出报告 → 用户拍板 **A 方案**（不传 `--type` 时沿用记录原类型）+ 确认 H1（`--git-url` 仍为 git）/ H3（彻底不探测）→ 实施。
  - **落点**：`src/lib/datasource.ts`（类型决议重写 + `sameSourceDir` + `typeChanged` 归入 NEEDS_FORCE 家族）、`src/datasource.ts`（`--source` / `--type` / `--force` 帮助文案）、`test/datasource-model-v2.test.ts`（3 处改/增）、`test/datasource-sync-incremental.test.ts`（补 `type:'git'`）、`docs/cli.md`（新增「`--source` 规则」4 条）。
  - **类型决议新口径**（`addDataSourceUnlocked`）：① `gitInfo`（托管 clone / 副本复用，内部注入）→ git；② 显式 `--type git` → **唯一**调 `probeGit` 的入口，非仓库 fail-loud；③ 未指定 → directory，**不探测**（连带省掉每次 add 的 4 次 git 子进程）；④ 未指定 + 已有**同目录** Git 登记 → 沿用 `prev.git`（幂等）。
  - **★ 修掉的真风险**：旧 `NEEDS_FORCE` 判据不含类型，若不处理，一条 `add --group <g>` 就会把增量源**静默降级**成全量重扫并丢 commit 水位。现 `typeChanged` 纳入同档判据（`git → directory` 提示「Git 元信息与 commit 水位会被清除」）。
  - **结构变化（连带）**：`readDataSource(prev)` 从映射校验之后**提前**到类型决议之前（沿用判定依赖它）⇒ `datasource.json` 损坏时 CORRUPT 报错先于 MAPPING/INVALID_GROUP（更早 fail-loud）；`addDataSource` 的 `warnings` 产出被删（唯一来源就是那条「未识别为 Git 仓库」），`AddDataSourceResult.warnings?` 字段保留未删（3 处消费方 `?? []` / `&& length>0` 均 tolerant）。
  - 验证：`npm run build` 0 · 21 个 `test/datasource-*.test.ts` **198/198 全绿** · 真机 CLI 冒烟 6 步（缺省→目录且无 warning / `--type git`→git / 重跑不带 type→仍 git / `--type directory`→NEEDS_FORCE / `--force`→目录 / `list` 显示 dir）· `add --help` 文案已生效。
  - **已知代价（challenger 提，未处理，待用户定）**：仓库 `.git` 被删/移走后重跑 add（同目录）仍沿用 git ⇒ 失败点从 add 推迟到 sync（`GIT_UPDATE_FAILED` + git 原始报错，缺一句「改用 `--type directory --force`」的指路）。窄场景，未扩范围。
  - 未做：`docs/build-kb.md` 等未涉自动识别的文档未改；web 端无本地目录添加入口，未改前端。

- [2026-11-10] **创建 Token 的「访问范围」改用视图页的选库选择器（抽出公共组件）**（已完成，未提交）
  - **诉求**（用户原话）：「访问范围使用选择框的方式，样式直接视图页面中，创建视图时，选择知识库的样式」。走 `product-manager` + `ui-to-ascii` 出 ASCII 图 → 用户选 **方案 A（抽公共组件，视图页与 Token 共用一份实现）**。
  - **新增**：`web/src/components/ScopeMultiPicker.tsx`（搜索过滤 + 候选面板 + 已选 chips + ↑↓/Enter/Esc + 点外收起）、`web/src/styles/scope-picker.css`（App.tsx 全局引入，类名 `sp-*`，迁自 views.css 的 `views-picker*` 段）。
  - **迁移与删除**：`views.css` 删 picker 整段（约 4.3k 字符）与 `views-chip--pick` / `views-chip__x` / `views-tag*`，**保留**列表行仍用的 `views-chips` / `views-chip` 及各状态色；`ViewsPage.tsx` 删掉约 200 行私有实现（状态 + 点外收起 effect + candidates + 增删 + 键盘）改用组件，chip 文案/配色/title/候选徽标通过 `chipLabel` / `chipClassName` / `chipTitle` / `optionMeta` 原样保留；`UserTokenSection.tsx` 扁平 chips → 组件；`users-v2.css` 删掉随之失效的 `.u2-scope-chips` 3 行。
  - **两边口径（刻意不同）**：Token **不显示**「维度不一致」（数据来自 `/api/views` 的 memberMeta，不属于 Token 表单口径），保留「只读 / 仅全文」；Token 传 `maxWidth="100%"` 撑满字段（实测 610 = 内容宽 610），视图页仍是 340。
  - **★ 关键回归点（真机验证过）**：Token 创建表单外壳 `UserDialog` 在 **window** 上监听 Esc 关弹窗，组件内 Esc 必须 `e.stopPropagation()` —— 实测「收候选不关弹窗、已填名称与已选库都还在」；面板收起后再按 Esc 仍能正常关弹窗。
  - 验证：`tsc --noEmit` 0 · web `npm test` **979/979** · `npm run build` ✓ · 真机走查 **29/29**（`/tmp/ki-scope-picker-walk.mjs`，dev server 5174 指向 daemon 7423）：视图页 11 项（展开/过滤/点击与键盘添加/移除/Esc）+ Token 14 项（含 4 条 Esc 与点外收起的断言）+ 视图列表与编辑回填 3 项 + console 0 错。
  - **★ auto-review 复检修掉两条（同日，用户显式调用 `auto-review`）**：
    - **Tab 陷阱（实测发现）**：候选项当时全在 Tab 序内，在 Token 弹窗（`UserDialog` 有焦点陷阱）里从搜索框按 **154 次 Tab** 才能到「取消」。改为 `tabIndex={-1}`（标准 combobox：键盘走 ↑↓ + 回车），复测降到 **2 次**（第一下落在可滚动容器上，是 Chrome 的无障碍焦点行为，保留）。
    - **ARIA 补偿（修上一条的净损失）**：拿掉 Tab 可达后屏幕阅读器感知不到高亮项 → 补 `role="combobox"` / `aria-controls` / `aria-activedescendant` / `aria-autocomplete="list"`，候选改 `role="option"` + `aria-selected` + 稳定 `id`（`useId`，同页多个 picker 不撞 id）。实测 ↓ 后 `aria-activedescendant` 顺移一位且 `aria-selected` 跟随。
    - 新增 `web/test/scope-picker.test.mjs` **6 条源码守卫**：两调用方共用一份实现 / 组件不发请求 / **Esc 必须 stopPropagation**（真机验证过的关键点）/ 候选不进 Tab 序 / ARIA 关联完整 / 样式单一来源。
  - **★ 候选面板改浮层（同日第三次调整，用户拍板方案 A「向下浮层」）**：
    - 动因（用户原话）：「展开选项时，使用悬浮的样式。不要向下挤压其他组件」。先出 ASCII 图 + **运行时注入**实测可行性 → 用户选 A。
    - **技术关键**：Token 弹窗这条链路上有**四层 overflow 裁剪**（`.u2-inline-panel` hidden / `.u2-dialog__body` auto / `.u2-dialog` hidden / `.ki-dialog` auto）。注入 `position:absolute` 实测面板被裁到 **83px（少 117px）**，所以不能只改 margin。最终用 `position: fixed` + 按输入框 `getBoundingClientRect()` 现算 `top/left/width/maxHeight`（`.ki-overlay` 无 transform，fixed 参照系仍是视口）。
    - 落点：组件新增 `floating?: boolean`（默认 false = 常规流）+ `reposition` 回调 + `useLayoutEffect`（首帧在 paint 前定位，避免闪一下在流内）+ `scroll`(capture) / `resize` 重算；`.sp-picker__panel--floating { position: fixed; z-index: 1200; margin-top: 0 }`；`UserTokenSection` 传 `floating`。
    - **视图页刻意不启用**（`views.css` 原注释写明：面板下方是「影响面提示」，选成员时要一直盯着）。若要统一，把 `floating` 加到 `ViewsPage` 的组件调用即可。
    - **A 方案的预期代价**：面板向下会溢出弹窗下沿、盖住提示行与「取消 / 创建」按钮，点那个位置第一次只收起面板；`maxHeight = min(200, 视口底 - 输入框底 - 14)`（下限 80），矮视口自动变矮。
    - 验证：`tsc` 0 · web `npm test` **986/986**（新增 1 条浮层守卫）· `npm run build` ✓ · 浮层专项实测 **12/12**（fixed、gap 6、宽 610 = 输入框宽、面板高 200 不再被裁、弹窗高度 529 不变、按钮 top 639 不变、无内部滚动）+ 矮视口 **5/5**（520 高：body 可滚，滚 40px 后面板 441→401 且与输入框 gap 仍 6，面板收敛到 80，视图页 `position=static`）· 回归走查 **29/29**。
  - **★ 视图页也改浮层，`floating` 开关随之删除（同日第四次调整）**：
    - 用户原话：「视图编辑这里，选择scope时也不要向下挤压组件」→ 两处调用方都要浮层，`floating?: boolean` 成了永远为 true 的死分支，直接去掉、面板恒浮层。
    - 视角差异：Token 弹窗面板撑满 610、会盖住整个 footer；视图页面板只有 340（`maxWidth`），右侧的「取消 / 创建视图」**仍然露在外面可点**，实际体验更好。
    - **z-index 由 1200 改为 150**：1200 是给弹窗内的算法，但视图页没有 overlay 容器，1200 会在页面根层叠上下文里盖住侧栏（990）与聊天面板（1030）。150 同时满足两处：高于页面内各类下拉（30 / 60 / 100 / 120），低于侧栏与聊天面板。
    - 顺带加位置去抖：滚动事件密集，`reposition` 里位置变化 < 0.5px 就返回旧对象，避免每帧 setState。
    - 验证：`tsc` 0 · web `npm test` **986/986**（守卫改为断言「恒浮层 + fixed + z-index 150」）· `npm run build` ✓ · 视图页浮层专项 **7/7**（900 高视口下面板完整 200px 溢出卡片下沿 538 > 437；520 高视口收敛到 175 = 可用空间；`.ki-content` 内部滚 50px 后面板 338 → 288、与输入框 gap 仍 6 —— 验证了 capture 监听确实生效）· Token 浮层专项 **12/12** · 回归走查 **29/29**。
  - **已知未改**：Token 首次点开「指定」时若 `scopeList` 还没返回，候选区显示「暂无可选知识库」（既有行为，未加加载态）；`.sp-chip` 与 `.views-chip` 的基础形态取值有重复（前者是交互件、后者是展示件，已在 css 头注释说明）。

- [2026-11-10] **创建 MCP Token 表单「权限 / 访问范围」改为单列竖排**（已完成，未提交）
  - **诉求**（用户原话）：「个人中心，创建token时，权限和访问范围选择竖着显示」。走 `product-manager` M4 + `ui-to-ascii` 界面确认闸门：先出 ASCII 现状/预期图 → 用户「确认」→ 实施。
  - **根因**：`.u2-inline-panel__row` 默认就是单列（`users-v2.css:164`），是文件末尾一条 `@media (min-width: 700px)` 桌面双列覆盖把它掰成两列（注释还写着「桌面双列压缩高度」）。
  - **改动**：删掉该 @media 段（4 行 → 0），并在单列规则上方加注释「不要再加桌面双列覆盖」防回退。**未改任何组件代码** —— `u2-inline-panel__row` 全仓只有 `UserTokenSection.tsx:223` 一处使用，`TokenCreateForm` 同时服务个人中心弹窗（`ProfilePage.tsx:169`）与「编辑成员 → 新增 Token」内联表单（`UserEditDialog.tsx:376`），两处自动一致。
  - **样式口径不变**：`.u2-inline-panel__seg` 仍 `inline-flex / width:auto / align-self:flex-start`，每按钮 `min-width: 96px` → 分段控件实测宽 202，未铺满整行。
  - **代价（实测修正）**：桌面内联面板高 273 → 349（**+76px**；先前估算 46px 偏小，漏算 12px gap + 整行 field 高 64）。弹窗 `max-height: calc(100vh - 32px)` + body 可滚动，900 高视口下总高约 420px 不触发滚动。390 窄屏前后完全一致（368），因为原本就是单列。
  - 验证：web `npm run build`（tsc --noEmit + vite build）✓ · web `npm test` **979/979** · 真机量测（Playwright 复刻真实 DOM + 真实 CSS，1200/820/390 三档，`/tmp/ki-token-layout-check.mjs`）：before 1200/820 并排双列（perm/scope 同 `y=466`、`x=295/606`）→ after 三档全部单列（`x` 相同、`scope.y = perm.y + 76`），无横向溢出。
  - 未做（用户未要求）：管理端「编辑成员」表单 `.u2-form-grid` 里的权限/状态分段控件仍是同款布局逻辑，若也要竖排需另评。

- [2026-11-09] **数据源页「同步」加二次确认弹框**（已完成，未提交）
  - **诉求**（用户原话）：「"同步"按钮增加一个二次确认弹框，避免误操作」。走 `product-manager` M1（一次成型档）先出方案 + ASCII 图 → 用户「确认」→ `request-guard` 通过 → 实施。
  - **拍板三条**：保留 5 行信息（源目录 / 落点 / 上次同步 / 同步方式 / 定时）；**不给**「全量重建」勾选（`full:true` 仍只在编辑弹窗保存后自动触发）；默认焦点落「取消」（Enter 不误发）。
  - **落点**：`web/src/pages/DataSourcePage.tsx`（state `syncTarget` / `syncSubmitting` + `syncCancelRef` / `syncTriggerRef`；`syncTargetView` useMemo；`openSyncConfirm` / `closeSyncConfirm` / `submitSyncConfirm`；行内按钮 `data-ds-sync` + 改调 `openSyncConfirm`；弹框 `section.ki-ds-sync` 复用 `.ki-dialog` 骨架）；`web/src/styles/ki.css` 纯追加 32 行 `.ki-ds-sync*`（无既有规则被改）；新增 `web/test/datasource-sync-confirm.test.mjs`（8 条源码守卫）。
  - **语义口径**：同步**不是**破坏性操作 ⇒ 无 danger 顶条、主按钮 `ki-btn--primary`；弹框真正的价值是写明 scope，**点错行能当场看见**。
  - **★ 修掉一条自查出的真问题**：焦点归还原先写了两处（`submitSyncConfirm` 的 rAF + `syncTarget` effect），实测互相抢焦点、行内按钮赢——收敛为单一 effect：行还在且按钮可点 → 还按钮；按钮已置灰（同步中/冷却/向量不可用）→ 落 `rowNoticeRef`，绝不掉 body。
  - **★ auto-review 复检又抓到一条真缺陷（2026-11-10，已修）**：弹框「同步方式」原先**对所有类型写死「增量（只处理有变化的文件）」**，但后端 `datasourceSyncMode`（`src/lib/datasource-task.ts:12`）只有 **Git 源且上次同步过** 才是 incremental，**目录源恒为 full（全目录重扫）** ⇒ 4/5 个数据源被标反，还会与提交后的行内提示「已提交全量同步」当场打架。改为 `syncTargetView.mode / modeHint` 按 `type === 'git' && git.shortCommit` 推导（与后端同口径；`shortCommit` 与 `commit` 同函数同写：`datasource.ts:1493`）；顺带把旧 daemon（`schedule === undefined`）的「未开启」改成「—」（不把"不支持"说成"没开"）。走查补三条断言：目录源显「全量」、Git 源（blog-es，shortCommit=8032fdb）显「增量」、Git 提示不受冷却。
  - **既有布局约束（非本次引入）**：详情抽屉宽 70vw 盖住操作列 ⇒ 抽屉开着时**鼠标点不到**行内同步按钮，只有键盘可达；`syncTarget` 已加入抽屉 Esc 关闭条件，避免 Esc「关两层」。
  - **已知限制（全站一致，未改）**：弹框无 focus trap，Tab 从「开始同步」会走出弹框；remove / add 弹窗同样如此。
  - 验证：`tsc --noEmit` 0 · web `npm test` **979/979**（含新增 9）· `npm run build` ✓ · 真机走查 **25/25**（`/tmp/ki-sync-walk.mjs`，Playwright + 拦截 `/api/datasource/sync`：三条关闭路径 0 请求、确认后仅 1 次且 `scope` 正确、默认焦点取消、Shift+Tab→✕ / Tab→开始同步、提交后焦点回行内、目录源显「全量」/ Git 源显「增量」、390 宽无溢出、抽屉开着时弹框在上层且 Esc 只关一层、console 0 错）。

- [2026-11-09] **辅助向量命中定位（P0-A）已修复；DESIGN.md 根因误判；另发现 ki-path 检索段错误**（未提交）
  - **来源**：`CodeWikiHub/kisearch/requirements/2026-11-06-向量重建id失配/design/DESIGN.md` 报「rebuild 后 relation 为空」。核实后**根因判错**：真实函数是 `updateMemoryIds`（不是 `writeBackMemoryIds`，全仓不存在），自 `53f6be4` 起一直在回写；从当前 KB 重算 15594 个内容 chunk id 在反查表**缺失 0**、悬空 0，集合侧三类 id 缺失 0 ⇒ 回写没问题。
  - **真实根因**：报告中的 `92fa5bc4…` 精确等于 `generateDocId('<chunk名>', 'ai-docs', 'ki-relation')` ⇒ 命中的是**辅助通道向量**（`ki-relation`/`ki-path`），其 docId **按设计不入 relations-cache**；`search.ts:644` 的 `lookupId = ftsId ?? memoryId` 必然 miss → `relation` 空、`group` 由向量 doc 自带字段补上。不传 `--tags` 时按全部 tag 取候选（`TAG_PRIORITY` ki-search > ki-relation > ki-path），内容候选不足即补位。
  - **修复（方案 A）**：`relation-map.ts` 新增 `AuxRelationIndex` / `getRelationAuxIndex` / `resolveAuxHit`（缓存条目扩 `aux` 字段，与 `getRelationMap` 共用 `resolveCacheEntry`，不额外多一次分片全量读）；`search.ts` 在 id 反查 miss 时用向量自带字段反推：`ki-relation` 的 content 是 `<文件级 relation>-<chunk序号>` → 候选按名字长度降序取**最长前缀**（文件级名可能自带 `-NN` 后缀）；`ki-path` 用 content **精确匹配**回 group（不做空格→斜杠，避免段名自带空格歧义）。`hit.relation` 改为非空才写。
  - 测试：新增 `test/relation-aux-locator.test.ts` **11/11**；既有 relation-map 13 · search-multiscope 17 · search-original 6 · cross-process-invalidation 1 · search-view 10 · search-fulltext-locator 8 · import-auxiliary-degrade 3 · delete-relation-relation-vector 5 全绿；`npm run build` 0；真机（daemon 重启后）`--tags ki-relation` 命中均带 `relation`+`sourcePath`，默认检索 5/5 正常。
  - **★ 未修（既有缺陷，已用 HEAD 原始代码对照确认）**：`ki search --tags ki-path` 让 daemon **Segmentation fault (core dumped)**（native 层，`ki mcp status` 变 running:false + 残留 lock）；git stash 还原到 HEAD 同样崩 ⇒ 与本次改动无关，需单独立项。
  - 未做：P1（`path-search.extractPathFromContent` 仍按旧格式 `名称 | Group: …` 解析 → `get-module-info` 的 relation 名模糊兜底静默失效）、P2（DESIGN.md 根因/验收标准更正）、P3（`DEFAULT_TAGS` 已是死常量，实际是 `vectorListTags()` 动态枚举）。
  - 证据：`.debug/vector-rebuild-id-mismatch-20261109/`（`evidence.md` E-01~E-08 + 4 个只读探针）。

- [2026-11-09] **检索打分改造：单库「字面加权 RRF」+ 多库「语义相似度绝对分」**（未提交）
  - **阶段一（还原）** 用户原话「当前对单库向量查询 rrf 分数计算方式进行了修改，现在要求进行还原」。
    - `src/lib/vector-client.ts` 单库（`existingScopes.length === 1`）不再强制 `ranking: 'dynamic-ratio'` / `requireSemanticRecall: true`；`withRouteScores` 由 `true`（`TEMP-VERIFY`）改为仅多库 → 单库回到 `multiQuerySync`（`rerank: rrf, rankConstant=60`），分数 = `Σ 1/(60+rank)`。
    - 连带清理：`requireSemanticRecall` / `MIN_FTS_SCORE` 全链路删除；threshold「跳过过滤」收敛为 `multiScopeRequest && ranking === 'dynamic-ratio'`。
    - 验证：真机单库分数精确等于 `1/61`、`1/62`…（原生 RRF 签名）。
  - **阶段二（新公式，用户拍板口径）** 用户原话「混合查询将要提高字面分的权重 / 字面分数 = bm25//50 × 字面分数 / score = 向量分 + 字面分」，后续修正为「不要整除，改为 `/`，精度到 3 位有效数字」「bm25 ≤ 50 就不乘倍率」。
    - 确认口径：**仅单库生效**；权重**不封顶**；字面权重 3 位有效数字；最终分 5 位有效数字。
    - 公式：`score = round5( 1/(60+r_v) + w × 1/(60+r_f) )`，`w = bm25 > 50 ? round3(bm25/50) : 1`。
    - 落点：`scoring.ts` 新增 `SINGLE_SCOPE_RANKING='fts-weighted-rrf'` / `FTS_WEIGHT_DIVISOR=50` / `roundSignificant` / `ftsWeight` / `ftsWeightedRrfScore`；`worker.ts` 新增该 ranking 分支（库内按最终分截断，路序用 `findIndex` 按字段判定而非硬编码下标），`routeTopk` 放大条件加入该值；`types.ts` / `worker-protocol.ts` 联合类型加成员；`vector-client.ts` 恢复 `wantRouteScores = true` 并注入 `engineRanking = 多库? params.ranking : SINGLE_SCOPE_RANKING`（`params.ranking` 对单库彻底失效）。
    - 已明知代价：单库从 1 次 `multiQuerySync` 变两路并行查询（候选 2 倍、下限 40）。
    - 测试：新增 `test/single-scope-scoring.test.ts` **18/18**（含「bm25≤50 退化为原 RRF」「字面强可反超名次靠前」「12345/50→247」等边界）。
    - **★ 门槛 50 的实测（用户确认是设计意图，不改）**：门槛是「**原文粘贴查询**」的判别器 —— 用户自己组织的语义查询 BM25 天然低，此时放大字面反而会干扰；只有直接复制文档原文时字面分才该顶上来。
      - 自组织语义查询侧：3 库 × 6 查询 × 每查询 20 条共 **120 条**，BM25 `min 0 / p50 7.64 / p90 9.87 / max 13.11`，>50 条数 = 0 ⇒ 权重恒 1，等于不介入（符合预期）。
      - **大库 kisearch 闭环成立**（粘贴真实正文）：60 字符 → Top1 BM25 `57.1`、w `1.14`、score `0.035`；150 字符 → `139.2~263.7`、w `2.78~5.27`、score `0.062~0.103`；300 字符 → `317.3~398.6`、w `6.35~7.97`、score `0.120~0.147`。三档原文档均排第 1。
      - 小库 docker 不触发但也无需触发：同样粘贴 60~300 字符 BM25 仅 `33.0~34.8`（w=1，score `0.0328`），原文档同样已排第 1。
  - **阶段三（多库新算法）** 用户原话「重新设计多库/视图查询的分数计算公式…当前是用排名进行计算，但每个知识库中的排名没有参考价值…直接使用语义分数…什么『定标加权』彻底舍弃，主要改造参考还是单库那个公式」。
    - 公式：`score = round5( sim_v + w(bm25) × 1/61 )`；`sim_v = 1/(1+cosine distance)`（0.33~1，绝对量，同一 embedding 空间内跨库可比）；`w` 沿用单库那套（`bm25>50 ? round3(bm25/50) : 1`）。
    - 关键设计：**两项都不含库内名次** —— 向量项换绝对相似度；字面项把名次固定为 1（只留强度）。否则小库字面路只召回一条时又拿满档 `1/61`，「库内名次虚高」从向量项挪到字面项。
    - ★ 传参约定：字面路**未召回必须传 `bm25 = undefined`**（传 0 会命中 `ftsWeight(0)=1`，白送一份字面分）；worker 用 `e.scores[ftsRouteIdx]` 的 `undefined` 判定，单测专门守这条陷阱。
    - 落点：`scoring.ts` 加 `SEMANTIC_SIMILARITY_RANKING='semantic-similarity'` + `semanticSimilarityScore`；`worker.ts` 加同名分支（库内按最终分截断，`routeTopk` 放大）；`types.ts` / `worker-protocol.ts` / `vector-client.ts` / `search.ts` 类型与 `ENGINE_FINAL_RANKINGS` 加成员；`search.ts` 入口统一 `params.ranking ?? 'semantic-similarity'`（原三处 `?? 'weighted'` 全改）；CLI `--ranking` 默认改新值；MCP `ranking` enum 加值；`SearchPage.tsx` 下拉**最上面**加「语义相似度」并设为默认。
    - 真机对比（`docker,k8s` + 「容器网络怎么配置」）：新算法 `0.79862 / 0.79336 / 0.79309 / 0.7888 / 0.78875`（前 5 全是 docker）；旧 weighted `2.128(k8s) / 2.071(k8s) / 1.836 / 1.789 / 1.757` —— 从「k8s 靠库内名次占前二」变为「docker 靠语义相似度占前五」。
    - 未决（待用户看效果后定）：旧算法（weighted / dynamic-ratio / semantic-first / calibrated-*）是否整批删除；检索页 Threshold 滑块 `max=0.2` 与新分数（0.33~1.13）不匹配；`docs/multi-scope-ranking.md` 388 行仍以定标加权为主线（只加了「默认已变更」提示，未重写）。
    - **三策略并存（历史记录，用户当时要求「加上 2 和 3 策略选项看看」）**：`scoring.ts` 的 `semanticSimilarityScore(sim, bm25, mode)` + `SEMANTIC_RANKING_MODES` 映射三个 ranking（**前端选项已于同日删除，见下方「已对齐 + 收敛」**）：
      - `semantic-similarity`（balanced）：`sim + w × 1/23`
      - `semantic-fts-dominant`（dominant）：`sim + bm25/100`，线性、无门槛
      - `semantic-fts-boost`（boost）：`bm25 > 30 ? 0.05 : w × 1/23`
      下拉（最上三项）、CLI `--ranking`、MCP enum 均已列出；默认仍是 `semantic-similarity`。
    - **实测（`just-test` + 「主机监控性能优化方案」，走 7423 热通道）**：`page-first-loading-proposal.md` 在 balanced 第 **4**（0.71141）、dominant 第 **1**（0.83241）、boost 第 **4**（0.71165，BM25 16.42 未过 30 门槛，与 balanced 几乎一致）。
      - dominant 前 3：page-first 0.83241 / PERF-009 0.82059 / progressive-loading 0.7662 —— 同目录文档聚集。
      - 回归（普通语义查询「告警通知渠道怎么配置」）：dominant 前 5 仍全是告警通知类，未引入无关结果。
    - 关键事实：`state-machine.md`（balanced 第 2，0.72691）**未被字面路召回**（全文 40 条里没有它）⇒ 字面项为 0、不加成；这也是 1/23 能让 page 从第 5 升到第 4（仅差 0.00024）的原因。
    - 服务已 `ki mcp restart`（旧 pid 808580 terminated），页面上可直接切换三项对比。
    - **文档已按「字面主导」重写（用户指令 2026-11-09）**：`docs/multi-scope-ranking.md` 从 395 行压到约 200 行，主线公式改为 `score = sim_v + bm25/100`；删掉定标加权的 `q/g/d` 分档推导、加权融合对照数据与历史实验表，保留「为什么库内名次不可比」的用户向论证。连带修三处会失准的描述：`docs/query-kb.md`（threshold 拆为单库 `0.02~0.03` / 多库 `0.6~0.8`、score 量级）、`docs/cli.md`（score 量级随范围变化）、`docs/single-scope-ranking.md` §7（多库字面项改为「字面分 ÷ 100」）。
    - **已对齐 + 收敛（2026-11-09 用户指令）**：前端删除「排序算法」下拉、「语义权重」输入、结果里的「字面 / 语义 / 名次 / 定标」分数构成（连同 `Result` 的 4 个分数字段）；后端默认改为 `semantic-fts-dominant`（`search.ts` 入口 `?? 'semantic-fts-dominant'`、CLI `--ranking` 默认与兜底同步）。CLI / MCP 仍可显式传 ranking 做对比，页面不再暴露。
    - **★ 修掉一个真缺陷（实测复现）**：`executeSearchLocal` 之前只把默认算法用于 `mergeBoost` / `ENGINE_FINAL_RANKINGS` 判断，**传给 `vectorSearch` 的仍是原始 `params.ranking`** ⇒ 页面 / MCP 不传参时引擎落到「其余算法」分支，多库分数退回库内融合分（实测 5 条各库 rank1 全是 `1/61`）。两处调用改为传套用默认后的 `ranking`；重启后 `page-first-loading-proposal.md` 回到第 1（0.83218）。
    - **文档修正 `docs/multi-scope-query.md`（5 处，用户核查后要求改）**：① 总览公式改 `语义相似度 + 字面分 ÷ 100`；② §2 表格补「维度与配置不一致 → 跳过并给迁移命令」；③ §3 补「两路放大只发生在库内算分的算法上」；④ §3 补「每库配额 = 返回条数 + 编辑中间态补位（上限 1000）」；⑤ §5 删掉**不存在的「8 秒总预算」**（全仓无该实现，实际只有单库 5 秒 + 全部失败报错）。
    - 验证：`npm run build` 0 · web `tsc --noEmit` 0 · `vite build` ✓（dist 内已无「排序算法」文案）· search-multiscope 17 · search-view 10 · multi-scope-scoring 12 · semantic-similarity-scoring 13 全绿 · 服务已重启。
    - **新增 `docs/search-threshold.md`（用户要求把阈值策略独立成篇）**：讲清「阈值只是分数下限、不参与排序」；单库（名次基，常规 `0.016~0.033`，文字强时 `0.1~0.35`）与多库（相似度基，常规 `0.5~1.0`，原文级 `2~5`）两套量级与推荐区间；⚠️ 切换检索范围前先归零；页面滑块 `0~1`、步进 `0.05` 对单库过粗；哪些情况阈值不生效（全文模式、降级）；空结果四步排查。`docs/README.md` 已加索引。
    - **★ 修正我自己的一个数字错误**：先前在 Q3 里报「单库 `0.016~0.4`」是错的 —— 单库字面项用的是 `1/(60+r_f)`、不是 `1/23`，常规上限就是 `2/61 ≈ 0.0328`。
    - **阈值步进定为 `0.01`（用户拍板方案 A）**：`THRESHOLD_MAX` 保持 1、`THRESHOLD_STEP` `0.05 → 0.01` —— 0.05 刻度下单库任何非零值都会清空（常规上限 0.033 < 0.05）；0.01 让单库能设 `0.01 / 0.02 / 0.03`。多库不受影响：滑块**拖动**按刻度吸附、一步到位，只有 −/+ 按钮是逐格微调。`docs/search-threshold.md` §三/§五 同步（推荐值 `0.02~0.03`、刻度 `0.01`；同时删掉"单库只能走 CLI"的旧说法）。
    - **MCP `ki_search.threshold` 描述改为精简版（96 字，用户两轮反馈：先要详细、再嫌太长）**，最终三句：`分数下限：低于该值的结果直接丢弃（0 或省略 = 不过滤，只过滤不排序）。单库建议 0.02~0.03，多库 / 视图建议 0.6~0.8（两者量级不同，勿混用）；全文模式与降级检索下不生效。` 细节（两套区间、上限 1 的理由、切范围归零）留在 `docs/search-threshold.md`，不塞进工具描述。
      - ★ 教训：**MCP 工具 schema 在服务启动时注册，改描述必须重启服务**（第一次改完没重启，IDE 里仍是「相似度阈值（0-1）」）；`tools/list` 可实测确认，**IDE 侧可能需重连 MCP 连接才会刷新**。
    - 测试：`test/semantic-similarity-scoring.test.ts` 扩到 **13/13**（新增三口径用例）。
  - 文档：`docs/single-scope-ranking.md` 按单库新公式重写（倍率表、数值示例、分数区间 `0.016~0.4+`）；`docs/multi-scope-ranking.md` 顶部加「默认算法已变更」提示；`docs/README.md` 描述同步。
  - 多库默认已切到新算法（真机 0.79 量级），旧算法仍可通过 `--ranking weighted` 等切回。
  - 验证：`npm run build` 0 · web `tsc --noEmit` 0 · `vite build` ✓ · `test:zvec-engine` **129/129** · semantic-similarity-scoring 7 · single-scope-scoring 18 · multi-scope-scoring 12 · search-view 10 · search-multiscope 17 全绿。
  - **全量 `npm run test:all` 有 28 个失败，均为既有**：已用「index 版本回退」对照验证 `test/vector-cli-functions.test.ts` 在改动前后同样 8 失败（mock 桩在 `ensureVectorAvailable` 处失效，`vectorSearch` 根本没被调）；其余集中在 import/group/sync-relation/chat 与 3 个超时，与本次改动无交集。

- [2026-11-06] **语义检索页 Limit 由固定下拉（5/10/20）改为数字输入 + −/+ 步进**（未提交）
  - 动因（用户原话）：「当前最高是 20，要求改为可以手动输入，或者有个按钮可以增加」。
  - 落点：新增 `web/src/lib/searchLimit.ts`（`SEARCH_LIMIT_MIN/MAX/DEFAULT/STEP` + `parseSearchLimit` / `normalizeSearchLimit` / `stepSearchLimit`）；`SearchPage.tsx` 的 `<select>` → `type="number"` 输入框 + 两个 `.ki-step-btn`。
  - **范围内核**：1–1000，上界对齐后端 `SEARCH_TOPK_MAX`（`src/lib/vector-client.ts:298`）—— 超了后端只会收敛到 1000 并回 skipped 提示，前端挡住免得「填 5000 只回 1000」被当成丢结果。
  - **★ 三点设计约束**：① 编辑期**不 clamp**（先删光再输 12 会被逐字符卡在 1），归一化只在 `onBlur` / 发起检索时做；② 空串 → 默认 10（沿用原 `Number(limit) || 10` 语义），绝不把 `limit: 0` 发给后端；③ **越界必须标红**（`isSearchLimitOutOfRange` → `ki-form-input--error` + `aria-invalid` + title 换文案）—— 失焦会把 5000 改写成 1000，只靠数字变化就是静默改写。
  - **★ challenger 二次质疑的两条产出**：
    - **否证一条**：担心「输入 5000 / 3.7 后不失焦直接点搜索或回车」会被 number 的原生约束校验（min/max/step）拦成气泡、`onSubmit` 不触发。真机实测 3/3 全通（blur 与 keydown 的归一都发生在默认提交动作之前），`checkValidity()` 也已是 true —— 不成立。
    - **抓到一条真缺陷**：标红在**聚焦时看不见**。`.ki-form-input:focus`（ki.css:908，(0,2,0)）与全站 `:focus-visible`（ki.css:4623，绿色 outline）都盖过 `.ki-form-input--error`（0,1,0），而越界恰恰发生在聚焦编辑途中。修法：只在本区块提高特异性（`.ki-query-option .ki-form-input--error`），并补 `outline-color: var(--ki-color-danger)`，避免红框套绿圈；**不动全站 error 基类**（那个 0,1,0 特异性问题在全站仍在，是既有隐患）。
  - **★ auto-review 复检补的一条口径修正（重要）**：初版 title 写「引擎单次检索上限 1000，更大也只会返回 1000 条」，会被读成"填 1000 就给 1000"——**上界 ≠ 承诺**。实证（`src/search.ts`）：全文候选 `max(limit×10, 50) + 隐藏补位`（:414）、无 tags 向量模式再乘 tag 数（:493）、多库 ×2（:435），放大值一过 1000 就被截断，文档聚合后可能明显少于所填值。文案已改为「实际条数可能少于所填值（结果区会提示）」，lib 顶部注释同步写明。真机实证：填 1000 跑全文 → 结果区出现「已跳过或受限 1 项，结果可能不完整」→ 不是静默少给。
  - 顺带：`ki.css` 隐藏 `.ki-query-option` 内 `input[type=number]` 的原生 spinner（hover 才冒出来、会挤动数字，且与 −/+ 重复；Timeout 同步受益）；`step` 属性改用 `SEARCH_LIMIT_STEP` 常量，避免与 JS 步进脱节。
  - 验证：`tsc --noEmit` 0 · web **953/953**（新增 `test/search-limit.test.mjs` 15 例）· `vite build` ✓ · 真机 **35/35**（隔离实例 `/tmp/kiwalk-search` + `--port 7433 --web`，Playwright：步进、手输 37、5000→1000、0→1、清空→10、边界按钮禁用、**请求体实测 `limit:37`**、历史重放保 37、键盘 ↑ 仍可微调、越界直接提交 3 例、标红/aria/title 与失焦后复原、**limit=1000 全文模式 skipped 提示上屏**、390 无溢出、console/pageerror 0）。

- [2026-11-04 → 11-05] **团队共享视图（`REQ-20261104-004`）已全量落地**：数据基座 + `/api/views` + `/views` 页面（需求 v15 / `meta.json` v17，状态已完成；**未提交**）
  - **新拍板**：**D5** 视图名支持中英（scope 名仍 ASCII-only，非 ASCII 名一定是视图）；**D6** 管理员可改任意视图，其他用户只能改**自己创建的**（编辑成员 / 改名 / 删除）；**D7** 每个视图有**不可变 ID**（`v_xxxx`），名字可变，token 授权 / localStorage / 深链一律以 ID 为锚 → 改名不再需要迁移授权；**D8** CLI 创建归默认 admin（复用 `resolveDefaultCliTokenOwner()`，`src/lib/mcp-token.ts:301`）；**Q6** 删掉恒真的 R-06。**D2 改版**：入口由「个人中心」改为**侧边栏独立页** `/views`，插在 `/resources` 之前（用户看界面后拍板）。
  - **文档连带改动**：R-03 / §4 开头 / §4.1 布局图（重画成侧边栏 + 主区）/ §4.4 / §8 / §9.3 全部改为独立页；§9.3 落点 = 新 `web/src/pages/ViewsPage.tsx` + `AppShell` 的 `NAV_MAIN` 插项 + `router/routes.tsx` 加 `/views`，**不再动 `ProfilePage.tsx`**。
  - **demo 已重写并真机走查**（`demo/profile-views/index.html`，1198 行）：外壳换成侧边栏（`pv-*` 自建壳，不直接复用 `.ki-sidebar`——ki.css 加载不到时兜底才不会塌页），主区变独立页，视图列表/表单/picker 逻辑原样迁移。走查 24 项：10 项导航与顺序、active 态、196px 与 ≤959px 72px 两态、390px 无横向溢出、亮暗双主题、9 组负向命名、新建与编辑落库、影响面实时重算、键盘 ↑↓+回车、**console 与 pageerror 均 0**。工具：`playwright-core`（`/root/.bg-agent/node/node_modules`）+ `chrome-headless-shell`。
  - **★ 走查发现并修掉的真缺陷（其它页面同样适用）**：候选面板走**常规流**后，收起会让下方按钮上移 ~196px ⇒ 在 `mousedown` 当场收起会让本次 `mouseup` 落空、`click` 不触发，表现为「选完成员直接点保存，第一次点没反应」。修法：`pointerdown`（早于 innerHTML 重建）只记录 inside 标志，**`click` 阶段才收起**。另两个坑也一并避开：不能在 `click` 里用 `contains(e.target)`（重建后 target 脱离文档 → 恒 false → 「刚选中一项列表就自己关了」）。
  - **顺带修 §4.6 #1/#2**：`SCOPES` 的中文 scope 名「部署运维」→ `deploy-ops`；名称校验由 ASCII 正则改为 `viewNameError()`（按 §1.4，中英均收，空值中性/非法值立即标红）—— 此前点「编辑」必然标红 + 保存禁用，编辑主流程走不通。
  - **★ 仍是最先要改的产品代码（未动）**：`findScopeViolation`（`src/lib/mcp-http.ts:155`）只比对名字，成员展开（`src/lib/scope-view.ts:493`）后不再校验 → token `['team','a']` 仍可 `--scope team` 读到 b。D3 生效后即越权。
  - **★ 数据面风险（未动）**：`views.json`（按名键→按 ID 键）与 `mcp-tokens.json`（`viewGrants` 名→ID）升级时都要迁移；**迁移失败若静默，Token 会静默失去视图**。要求幂等 + fail-loud + 回滚预案（§9.5）。旧 ID 由旧名 hash 派生后必须固化，否则改名会重算。
  - **★ 命名放宽的两处坑**：① `--scope` 解析必须**先查视图**再走 `validateScope`（否则中文名先被 `INVALID_SCOPE` 拒，`scope.ts:42`）；② `mcp-token.ts:96` 的授权参数校验**不能只放宽正则**，否则任意中文串能写进 `token.scopes` —— 要改成"已知视图名或 ID"的存在性判定。
  - **v5 写权限态（用户原话「有我自己创建的，示例没有啊」）**：列表三行原本长得一样、管理员视角下按钮全亮 ⇒ D6 等于没演示。demo 补：① 自己创建的视图在库数之后标 **「我的」** 徽标；② `canEdit()` 生效——**非本人创建的编辑 / 删除禁用** + `title`「仅创建者或管理员可修改该视图」，管理员不受限；③ **默认身份改为普通用户（张三）**，顶栏加 **demo 专用**身份切换（张三 / 管理员，真实实现取登录态）。`createdBy` 改存 **userId**（`USERS` 映射只用于 demo 显示名字，对齐 R-07）。守卫在 `openForm()` / `confirmDelete()` 里都加了（绕过 UI 直接调也拦得住，对应 N10「服务端拦，不靠前端隐藏按钮」）。
  - **v6 创建时间（2026-11-04）**：列表行 `由 张三 创建 · 2026-10-28`，**行内只到天、`title` 给完整时刻**（列表要扫读，秒级是噪音）。存储 **ISO 8601 UTC**，展示转本地，口径对齐 `web/src/lib/datasourceSchedule.ts::formatDateTime`；新建写 `new Date().toISOString()`。★ 顺带定了：**旧视图（003 只存 members）没有 createdAt 时留空显示 `—`，不伪造迁移时刻**。
  - **v7 图标修正（2026-11-04）**：用户原话「知识视图，图标为什么要有文件夹」—— `folder` 语义错（视图不是目录，会暗示点开是目录树）。侧边栏项与列表行统一改 **`layers`（三层叠片）**。★ `web/src/components/icons.tsx` **现有 27 个图标里没有 layers**，实施时需先补（path 已写进需求 §4.1 图注）。
  - **v8 表单宽度对齐（2026-11-04）**：用户原话「支持库选项框太长了吧？和上面对齐」—— `.pv-picker` 的 `max-width` 560→**340px**，与名称输入框同宽。实测三者 `left=279 / right=619 / w=340` 完全一致，候选面板跟随（`scrollWidth 338`，无溢出），390px 下两者同为 248px。§4.2 补宽度约束，并注明"不要给候选面板单独设更宽 `min-width`（会破坏对齐）"。
  - **v9 空态重做（2026-11-04）**：原空态三个真问题——① 图标用 `⌗`（U+2317），**多数字体缺字形、实机渲染成空方块**；② 空态内**没有主按钮**，读到「还没有视图」后视线要跳回右上角；③ 卡片仅 ~150px，像提示条而非待填充区域。改为 40px `layers` SVG + 两行主说明 + **空态内主按钮**（走事件委托——空态是 innerHTML 重建的，绑按钮上会丢）+ 底部团队共享小字；`min-height: 260px` 垂直居中，窄屏 220px。新增需求 §4.7「空态」节。
  - **v10 空态可验收（2026-11-05）**：用户看完空态改动后说「没变化」——真因是**空态只有把三条示例视图全删光才出现**，打开 demo 永远看到列表，等于空态无法验收。补 demo 专用顶栏开关 `[列表 | 空态]`，用 `SAMPLE_VIEWS` 常量 + `VIEWS` 副本保证可复原（直接在原数组上改就复原不了）。★ 连带修一处会咬人的选择器：`syncWhoButtons()` 原用 `.pv-who__btn` 全选，新开关共用同一套样式类会被改坏选中态 → 限定 `[data-who]`。
  - **v11 归属行去重（2026-11-05）**：用户指出「我的后面直接跟时间就行了啊」——自己的视图同时显示「我的」与「由 张三 创建」是重复。改为两种归属行：自己 `[我的] 2026-10-28`；他人 `由 李四 创建 · 2026-09-16`（缺「我的」就必须写出创建者）。管理员视角全都是他人视图，一律走后一种。
  - **v12 空态与表单互斥（2026-11-05）**：空态下点「新建」后表单在上、空态还在下面（同屏两处「新建」入口 + 仍写着"还没有知识视图"）。加 `syncListVisibility()`：**表单已开 ∧ 视图数 = 0 → 隐藏列表卡**；有视图时表单打开仍显示列表（编辑可对照）。调用点覆盖 `renderList` 两条 return 路径 / `renderForm` / `closeForm`。
  - **★ 已进入实施（2026-11-05）—— B1 数据基座完成**：`scope-view.ts` 落地三块：① `ViewConfig` 加 `id/createdBy/createdAt/updatedBy/updatedAt/revision`，`views.json` 升 v2；② **幂等迁移**（`readViewsDetailed()` 对 v1 按名字派生 ID + `needsMigration` 强制写回；**旧视图不补 `createdAt`**）；③ `renameView()` + `ki view rename`（真机：改名前后 `id` 均 `v_09ccd52b`）。顺带落地 **D5 中文命名**（`VIEW_NAME_PATTERN` 退役 → `viewNameCharsetError()`；`--scope` 解析新增 `splitTargetSegments()`，**非视图段仍逐个 `validateScope`**，路径遍历不变量保住）。
    - ★ **实施时改了一个设计决策**：存储由「按 ID 做键」改为「**按名做键 + 值存 id**」——8 处读路径零改动，改名仍只需一次原子写，D7 由 `id` 不变满足。已回填 §1.5。
    - ★ **踩坑**：原 `updateView` 写 `views[name] = { members }`，加字段后会**静默丢 id**（下次读时重新派生 → token 授权锚点失效）。已改 `{ ...entry }`，并加测试守。
    - 验证：`npm run build` exit 0；视图测试 **69/69**（新增 `test/scope-view-rename.test.ts` 14 例）。
  - **★ B1 已完成（安全边界闭合）**：① **R-09** `findScopeViolation(body, scopes, viewMembers?)` 加注入，名字通过后**展开成员逐个校验**（全有或全无）；视图表**惰性加载**（越权请求第一段即拒、不读盘）；`views.json` 损坏时 **fail-closed 503**，不降级为放行。② **R-02** `scope-list.ts` 收紧为 `视图授权 ∧ 全部成员授权`。③ `ki view rename` 先反查受影响 Token 再改，打印清单 + 补救命令。
  - **★ B1 唯一推后项**：`viewGrants` 存 ID → B2。原因：`mcp-token` **不能**反向 import `scope-view`（成环 `scope-view → config → mcp-token`）；可行路径是给 `findTokenAuth` 注入「ID→名字」解析器，或与授权写入命令一起做一次性迁移。**在它落地前，改名会让按名字记录的旧授权失效**（已用影响面清单兜底，不静默）。
  - **测试基线**：相关 **199/199**；新增 `test/scope-view-http-gate.test.ts` 9 例；顺带修 `mcp-token-readonly` 两处未同步 `viewGrants` 的**既有**失败。
  - **后续批次**：B2 API 层（`/api/views` CRUD + 影响面 + `route-permissions` 规则 + `views.read|write` 能力项 + `viewGrants` 存 ID）、B3 前端 `ViewsPage`。
  - **★ 全量落地（v15，2026-11-05）**：① `viewGrants` 存 **ID**（`findTokenAuth` 第 4 参注入「ID→名字」解析器，惰性构建；**不做一次性迁移**，改名时 `syncTokenGrantsOnRename()` 把旧名字换 ID——实测 `v_03509765`，改名后仍命中）；② `--view` 支持中文并落 ID、`--scope` 先查视图再走 scope 校验；③ **`/api/views` 五端点**（`src/lib/views-api.ts`）：列表（`canEdit`/`mine` 服务端算）、impact（R-05 口径）、POST、PATCH（改名保 ID + `baseRevision` → 409）、DELETE（越权 403 `VIEW_NOT_OWNER`）；④ `capabilities` 加 `views.read|write`（**不进** `WRITE_CAPABILITIES`，Token 不含 write）+ `route-permissions` 5 条；⑤ 前端 `ViewsPage.tsx` + `views.css` + `viewsApi.ts` + `NAV_MAIN`（新增 `layers` 图标）+ `routes.tsx`。
  - **★ 顺手修的一处结构问题**：`views-api` 需要读 body，却被 `mcp-http-api` 反向引用 → 抽出 `src/lib/http-body.ts`，两边单向依赖，消除循环。
  - **验证**：后端 `tsc` + 前端 `tsc --noEmit` + `vite build` 通过；后端 **192 项** + 前端 **5 项**全绿（新增 `views-api` 13 / `scope-view-rename-grant` 6 / `scope-view-http-gate` 9 / `views-page` 5）。
  - **★ 真机走查已完成（2026-11-05）**：隔离实例（`KI_CONFIG_PATH=/tmp/kiwalk` + `--port 7433 --web` 服务 `web/dist`）跑完整交互 **11 项全通过**：`/views` 直达 + 侧栏 active、空态、新建中文名（`我的` + 创建日期 + `canEdit`）、编辑回填与加成员、**点遮罩弹窗不关闭**、暗色、390 无溢出（侧栏 72px）、删除回空态、console/pageerror **0**。
    - ★ **只有真机能发现的两个缺陷**：① `.views-page` 缺 `width:100%`，在 `AppShell` 的 flex 主区里被收缩成一条窄栏；② 成员「· 缺失」无解释，易被误解为库被删（已补 `title`）。
  - **仍未覆盖**：非管理员只读态（隔离环境只有一个身份），由 `views-api` 的 403 测试 + `views-page` 静态守卫兜住；Q3「保存前二次确认」未采纳（以实时影响面面板为准）。`requirement.md` version 15 / `meta.json` v17。
  - **★ 维度不一致标记（2026-11-05，用户拍板方案 A，未提交）**：用户原话「维度不一致，语义检索直接跳过」——代码实证 `src/search.ts:298-311` 单成员失败跳过 + `src/lib/vector-client.ts:1077-1079` `onScopeError → return []`（默认 hybrid 下**整库 0 命中**，非仅语义部分）；`src/search.ts:303-304` 注释「视图把跨时期导入的一批库聚在一起，其中残留旧维度是常态」。
    - **★ 核心决策（可行性取证结论）**：**纯 fs 零锁且完备的 per-scope 维度读法不存在** —— `info().dimension` 只来自 `ZVecOpen` 后的原生 schema（`zvec-engine/worker.ts:234-281`），落盘 `manifest.1` 是二进制；`collections/layout.json` 只有 version/createdAt/host；`@zvec/zvec` 无「不 open 读 schema」API；`vectorListScopes()` 只扫目录名。实时诊断 `getVectorDimensionStatus` 会 `withEngine` 拿锁（撞锁约 15s/scope），且推翻 `mcp-server.ts:955-958`「不做 O(scope) 逐集合维度诊断、改为按需拦截」的既有架构决策 ⇒ **不能进 `/api/views` 请求路径**。故产品口径收敛为**「已确认清单」而非全量保证**：只读 `.vector-status` 快照，仅 `mismatch` 上屏；`unknown` 不标但视图行必须给「N 个库维度状态未确认」兜底。
    - 落地：新增 `src/lib/view-dimension-state.ts`（唯一口径，三态 `ok|mismatch|unknown`，异常降级 unknown 不让列表 500）；`ViewMemberMeta.dimensionState` 由 `buildMemberMeta` 统一产出，`/api/views` 与 `ki_scope_list` 两处调用方共用并按 scope 缓存；前端 `ViewsPage` 从 `views[].memberMeta` 聚合 `dimensionByScope`，列表 / 编辑表单已选 chip / 候选面板三处同标（不改 `ki_scope_list` 的 `scopes[]`）。
    - 判据边界（别误读）：FTS-only 集合检索侧抛 `no dense vector field` 而非 MISMATCH、集合损坏抛 CORRUPTED、锁占用抛 LOCKED —— 这些都不是 `mismatch`；`vector === false` 的成员不参与维度判定。
    - **★ challenger 二次质疑抓到并修掉的真缺陷（复现过）**：初版用 `readVectorDimensionSnapshot`，它在 5 分钟 TTL 过期时**丢掉 `persisted`** 返回 unknown —— 实证本机 178 份快照抽样 12 份**全部过期**（最久 23 天），且其中确有 `persisted=4096 / configured=1024` 的真实 mismatch ⇒ 视图页「维度不一致」标记在真实数据里**一个都不会出现**。修法：新增 `readPersistedVectorDimension()`（`vector-dimension-snapshot.ts`，复用同一套安全校验但**不看 TTL**），`readViewDimensionState` 改用它；集合维度是结构性事实（只有删集合 / rebuild-vector / 重导才变，这些路径都会 refresh 快照），配置维度仍活读比较。顶栏 banner / 总览面板的 TTL 语义不动。代价是外部重建未刷新快照时可能误报，按 fail-loud 取舍，hover 补「依据上次维度检查，若已重建请重新检查」。
    - **★ auto-review 第二轮复检又抓到 2 项并修复**：① `refreshVectorDimensionSnapshot` 的 catch 分支写「无 persisted」快照**覆盖旧值** —— 本机实证 2 份 `state=unknown` 快照（非法 scope「飒」「飒飒」）均无 persisted，一次偶发锁冲突就会让已确认的 mismatch 静默消失（🟧 本次激活，因为新读路径依赖 persisted）。已改为保留上次 `persisted`，`state` 仍 unknown 故顶栏/总览语义不变。② `persisted` 原本只校验 `Number.isFinite`，`-1 / 1.5 / 0` 会被当成维度误报 mismatch，已收紧为**正整数**。两例补进单测（9→11）。另把 hover「其余库正常检索」改为「其余可用的库照常出结果」（全成员都不匹配时前者不成立）。
    - **★ 用户看界面后再次反馈（2026-11-05）**：「这样也看不出哪个 scope 的维度未确认啊」——行级只给一个数字没有指向。实证 `just-test` 12 个成员里后端本就分得清 `ok` 6 个 / `unknown` 6 个，是前端把两态都渲染成无标记。修法：**三态逐个上屏** —— `unknown` 的成员 chip 追加 `· 维度未确认`（`ok` 保持无标记防全屏噪音）+ 最低优先级中性虚线色（仅无主状态色、无定时失败虚线时叠加，避免两套虚线打架）；行级提示由纯数字改为列前 3 个库名 + `title` 全量名单；编辑表单已选 chip 同步；前端静态守卫补断言。
    - 验证：后端 `npm run build` 0 · 新 `test/view-dimension-state.test.ts` **11/11** · `views-api` **16/16** · `scope-view-auth` 9/9 · `vector-dimension-snapshot` 7/7 · `mcp-tool-view` 9/9 · `scope-view` 27/27 · 前端 tsc 0 + **938/938** + `vite build` ✓ · lints 0。**真实数据实证**（jiti 调真实函数 + `/root/.ki` 真实配置）：TTL 路径 178 份快照里 177 份丢 `persisted`；修复后 `mismatch=5 / ok=102 / unknown=71`，且 `first-view` 视图的 `bkmon-test`、`bkmon-test2`、`fts_test` 三个成员会真实出现标记。`requirement.md` §4.4 已补条款 / `meta.json` v33。未做浏览器真机走查（视觉态仅静态守卫覆盖）。

- [2026-11-04] **用户管理页与个人中心改版：真实产品实现完成（`REQ-20261104-001`，子需求；未提交）**
  - 父需求：`REQ-20261103-001`《Web 账号登录与只读权限》；需求目录：`CodeWikiHub/kisearch/requirements/2026-11-04-用户管理页与个人中心改版/`。
  - 文档：`requirement.md` + `demo/verify-report.md` + `report.md`（已注册）；计划 `.plans/2026-11-04-user-management-v2/`（29/29 通过）。
  - 实现：后端 `user-store` 有效期/唯一 admin/admin 保护、Token owner/名称/上限/有效只读/CLI 默认归 admin、`/api/me/tokens` + `/api/users/:id/tokens`；前端 `UsersPage`/`ProfilePage`/用户组件/`users-v2.css`、`/profile` 路由与用户菜单、390/深色。
  - 验证：后端 build 0 + 相关套件 166 项全绿（含 mcp-token 40/40）；web tsc 0 + 861/861 + build ✓；真机 37/37 + 18/18 + 7/7 + 焦点/布局 14/14、长名/390/深色通过；无 console 错误。
  - 后续已修复（2026-11-04）：Token 存储补文件锁（并发 40 条无丢更新、并发创建严格 10 上限）、`ki mcp token adopt` 显式迁移 ownerless CLI Token、UserDialog Tab 焦点陷阱、Token 表单 ≥700px 双列；真机焦点/布局 14/14。
  - 待拍板/遗留：① Token 权限「动态收紧」还是保存时永久降级；② Token 明文创建后关闭仍会丢失（仅警告）；③ 历史多管理员的 Web 管理入口；④ 未 commit，等待用户验收。
- [2026-11-02] **根散文件改落保留键 `__root__`（已实施，未提交）：与 scope 同名组解耦，前端裸挂树顶**
  - 来源：用户在 scope `k8s` 导入课程目录后，树里多出「k8s」组装着根下 10 篇散文件（源目录没有该目录）。
  - 旧机制：`resolveGroupForSource` 的 `dir === '.'` 分支返回 **scope 名**。★ 实测缺陷（`.debug/import-root-files-scope-group-20261102/` E-08）：源目录里若真有与 scope 同名的子目录，两者共用 group 键 → 同名 relation 被 `duplicate-index` 判成「幂等重导」→ **后一篇内容静默丢失**（`files=3` 只入库 2 篇）。
  - 新机制：根散文件 → `ROOT_GROUP_KEY = '__root__'`（`src/lib/import-path.ts`）。空 group 仍不支持（5 条硬约束不变）。新增 `isRootGroup` / `groupToRelDir` / `groupDisplayName` / `isUserAssignableGroup`（用户可指定 = 路径安全 + 非保留名）。
  - 后端落点：`handleDirectImportUnlocked`（import / HTTP / 数据源三链路共同入口，含**拒收用户手写 `__root__`** + 源目录含 `__root__` 目录时 fail-loud）、`sync-relation`（单条 + 批量两阶段，hint「已落到根目录」、根键跳过路径补全）、`group-create`（拒建保留名）、`wiki-sync`（根 ⇒ wiki 根目录，不再凭空建 `__root__/`）、`markdown-gen`（frontmatter 显示「根」）、`export`（产物不生成 `__root__/`）、`doc-path.logicalDocPath`（根不贡献路径段）。
  - 前端：`web/src/lib/rootGroup.ts`（零依赖唯一定义，供 jiti 链路复用）→ `groupTree` re-export，`buildGroupTree` 跳过根组；`BrowsePage` / `GroupTreePanel` 树顶裸挂根散文件（`renderDocButton` 复用）+ 计数 + 空态 + 首层 500 条截断单独补齐；`writeGroup`（留空→根）；`ImportPage`/`WritePage`/`resourcesPage`/`chat/format`/`browseSearchGroups` 展示统一映射「根」。
  - 验证：后端+前端 tsc 0 · `import-path` 6/6 · `doc-path` 16/16 · `browse-group-tree` 10/10 · `write-group` 9/9 · `chat/acceptance-sr02` 10/10 · 真机隔离（`__root__, probe, sub` 三组、4 文件全导入、同名目录不再丢、保留名/保留名目录被拒、正常导入回归）。
  - **既有失败（与本次无关）**：`test/import-export.test.ts` 1 例 fail —— `git stash` 回退本次改动后同样 fail。
  - **待拍板**：现有 `k8s` 组那 10 篇是旧键，**重导同一目录会产生两份**（旧组 + `__root__`）；是否要一次性迁移脚本（按 `sourcePath` 无 `/` 判定搬组）。
  - **未验证**：`test/sync-relation.test.ts`（断言已改）、web 全量 `npm test`、`web npm run build`、浏览器真机走查（树顶渲染/点击）。
- [2026-11-02] **任务失败可诊断（`ki log`）：S-01 + S-02 + S-03 + S-04 全部实施完成（未提交）**
  - 需求来源：用户在 Web「添加 Git 数据源」失败后（任务 `46aa5f08-…`，详情只在红条写「任务失败（未记录可判别原因）」，后续操作区说"请在终端执行对应命令"却**没有任何命令**）提出：希望能按任务 ID 查到日志。
  - **真身是"失败可诊断"，不是"日志文件"**：命令只是入口，缺落盘这一环时 `ki log` 只能读到同一份已压缩的 32KB 任务 JSON。
  - 设计文档：`.requirements/2026-11-02-任务诊断日志/design/`（父 `DESIGN.md` + S01~S04 + `design-review.md`），证据台账 `reference/code-survey.md`。
  - 四个断点（均已定位到行）：① `safeErrorSummary` 13 条白名单全是 embedding/导入语境，Git 错误被压成兜底句 `task-registry.ts:227-247`；② 任务 JSON 32KB + 1h TTL `:188,193`；③ 前端只消费 2 个 errorCode `taskDetailModel.ts:466-471`（而 `result.errorCode` 里其实存着 `GIT_*`）；④ `cliCommandFor` 无 `taskId` 形参、不覆盖 `datasource-add-remote` `taskActions.ts:78-83,231-237`。
  - 顺带查实的既有缺陷：**错误分类串台** —— `clone 超时（10 分钟）` 显示成「Embedding 服务请求超时」、`network is unreachable` 显示成「Embedding 服务暂不可用」（`task-registry.ts:237-238` × `datasource-clone.ts:373,189`）。
  - 实施顺序（DAG `S-01 ∥ S-02 → S-03 → S-04`）：S-01 错误分类与可读映射（当天可验收）→ S-02 日志落盘（`.ki-tasks/logs/<id>.log`，7 天/200 文件/50MB，reporter 内部接入、10 个调用点零改动）→ S-03 `ki log` 命令 → S-04 详情诊断区 + `/api/tasks/:id/log`。
  - **判定串行**：4 个砖头里 `taskDetailModel.ts` 被 S-01/S-04 同时改，共享面多，不走多窗口并行。
  - 评审已修 4 阻断（`-id` 不是 commander 合法短选项需 argv 归一化；2MB×200 与 50MB 上限矛盾；`--full` 定义自相矛盾；`expired` 降级态在 Web 端不可达）+ 8 警告。
  - 用户已拍板：允许日志落原始错误但强脱敏；日志 7 天；CLI + Web 都做；daemon 自身日志单独立项（不在本期）。
  - **已实施（未提交）**：`src/lib/task-registry.ts`（`safeErrorSummary` 前置 9 条 Git 分支，修串台）+ `src/log.ts`（commander 薄壳 + `-id` 归一化）+ `src/lib/task-log-view.ts`（纯函数/渲染，**故意与 log.ts 分开**：`log.ts` 顶层 `program.parse` 会让测试导入即退）+ `bin/ki.mjs`（命令表/帮助/示例）+ `docs/cli.md`（新增 `## log` 章节）+ `docs/error-handling.md`（排障顺序首步）+ `test/task-log-cli.test.ts`（11 例）。
  - **验证**：`npm run build` exit 0 · `test/task-log-cli.test.ts` **11/11** · 回归 `task-registry` 6/6、`datasource-scheduled-run` 3/3、`import-incomplete-api` 20/20 · 真机（隔离 `--config` + `KI_DATASOURCE_CLONE_ROOT`）：单任务查询、`-id` 归一化 exit 0、scope 不符 exit 2、未找到 exit 1 且给三条出路、`--json`、空态均符合。
  - **★ 实测新发现（既有缺口，未改）**：`ki datasource add`（CLI）**不写任务台账** —— 只有 Web 的 `/api/datasource/add-remote` 与 `datasource sync` 调 `createTaskReporter`。故 CLI 添加失败后 `ki log` 查不到（真实 git 失败已复现确认）。已写入 `S03 §8 Q-3` 与 `docs/cli.md` 能力边界。
  - **★ 真实串验证**：拿真实 git 输出（含换行 + `Cloning into '/tmp/…'`）喂 reporter，压缩结果为「无法连接远端仓库」+ `GIT_NETWORK_FAILED`，不再落兜底句、也不再误报 Embedding。
  - **本期未实现（依赖 S-02）**：`--tail` / `--full` / `--path` 与日志正文输出；`ki log` 当前会明确打印「本任务暂无运行日志」。
  - **auto-review + challenger 复审（同日）修 3 项**：① **中文列宽错位（真 bug）**——`kv()` / `renderList()` 用 `String.length` 补空格，而 CJK 在终端占 2 列，键值对与表格两处都错位；改为 `displayWidth()`（CJK 计 2 列）+ `padCol()`，并加 2 条列边界断言；② **分类漏 2 个 Git 场景**——`GIT_SCHEME_UNSUPPORTED` 的 `file://` 分支文案是「本地目录请使用 --source」（另一句，漏了落兜底）、`INVALID_BRANCH` 完全未覆盖；补齐后测试 11→15 例；③ **CLI 漏 `phase`（失败阶段）**——设计 S-04 诊断区明确要显示「阶段 clone」，CLI 却没有，已补 `LogTaskView.phase` + 输出行。
  - **★ 顺序坑（写进注释与测试）**：`clone 超时` 必须排在 `clone 失败` 之前（后者是 `mapCloneFailure` 兜底文案，会吞掉超时）；`GIT_BRANCH_NOT_FOUND` 必须排在 `INVALID_BRANCH` 之前（后者含「只支持远端分支」）。
  - **★ `-id` 归一化函数已抽到 `task-log-view.ts`**（`normalizeTaskLogArgv`）并加单测——放在 `log.ts` 里无法导入测试（顶层 `program.parse`）。
  - **性能**：列表无过滤时只读 `limit` 条，仅 `--failed` / `--scope` 才扫 500 条；`renderTask` 末尾「暂无运行日志」已标 `★ S-02 接入点`，防后续有日志仍打印该提示。
  - **S-02 日志落盘（同日完成）**：新增 `src/lib/task-log.ts` —— 落点 `{dataDir}/.ki-tasks/logs/<id>.log`（子目录 0700、文件 0600、拒符号链接）；**7 天 / ≤200 文件 / ≤50MB 硬约束**（50MB 先到者触发，「200」是数量上限不是容量承诺）；单文件 2MB 滚动 `.log.1`；`redactForLog` 抹凭据（Bearer / `token=` / `api_key=` / `access_token` / `?key=` / URL userinfo，**路径保留**）；所有 IO 错误降级为 no-op + stderr 30s 节流。
    - **接入方式**：`createTaskReporter` **内部**接入（10 个调用点零改动），4 类写入时机 = 创建 / 状态或阶段**变化**（去重）/ 终态（写 `options.error` 的**未压缩原文**）/ `note()`。
    - **★ 心跳零 IO**：5s 心跳 `update({})` 不写行、不 stat、不清理；滚动检查只在真正追加前做。测试等待 5.6s 断言行数不变。
    - **★ 两份产物两条保留期**：task JSON 仍 1h（`TASK_TTL_MS` 未动）、日志 7 天 —— 这是"事后能查"成立的前提。
  - **S-03 扩展**：`--tail N`（0–10000）/ `--full` / `--path`（只打印路径，可管道）；列表加「日志」列（`有`/`无`/`已滚动`）；**台账过期但日志在 → 过期降级 exit 0**，从日志头行恢复 operation/scope/createdAt；`toJsonPayload` 抽到 view 层（CLI 壳顶层 `program.parse` 无法导入测试）；列表模式顺带触发一次日志清理。
  - **S-04 诊断区**：后端 `GET /api/tasks/:id/log?tail=N`（**必排在 `/tasks/:id` 之前**，否则被 `startsWith('/tasks/')` 吃掉）；鉴权顺序 = 先台账取 scope，台账过期再用日志头行；**head 损坏 → 403 而非 404**（判 404 等于把已有日志判没）；**只回文件名不回绝对路径**（台账刻意 `[path]` 化 + HTTP 可能对外）。
    - 前端：新增 `web/src/lib/taskErrorCatalog.ts`（22 条码 → 原因/下一步，`reason` 与后端 `safeErrorSummary` **逐字对齐**）+ `describeErrorText` 文本兜底（**`clone 超时` 必须排在 `clone 失败` 之前**）+ `buildLogSection`（ready/loading/missing/error 四态 + 过期标注 + 复制命令/日志）+ 详情页「原因与日志」区（成功态整区不渲染，正文 `pre` 限高 240px 滚动，不做受控 details）+ `cliCommandFor(operation, scope, taskId?)` 给数据源类操作 `ki log <id>`。
  - **验证**：后端 `build` 0 · `test/task-log-cli` **19/19** · `test/task-log` **13/13** · `test/task-log-api` **6/6** · `test/task-registry` 6/6 · web `tsc` 0 · web `npm test` **828/828** · web `build` exit 0（★ 与 `npm test` **不可并行**，同用 vite 缓存会报 rollup 内部错）。
  - **真机（隔离 dataDir）**：真实 `cloneManagedRepo` 失败 → 日志含 `fatal: unable to access … Could not resolve host`、台账 `error` 仅「无法连接远端仓库」；删台账后 `ki log` 过期降级 exit 0；`--tail 2` / `--path` 符合。
  - **★ auto-review 抓到并修的真 bug**：`viewFromHead(raw!.head!)` 在「台账过期 + 日志头行损坏」组合下抛 `Cannot read properties of null` → 改为容忍 null 并用 taskId 兜底，补测试；顺带让过期降级保留 head 能提供的 operation/scope/创建时间（原实现只打一行「已过期」，白丢信息）。
  - **★ 真机隔离踩坑**：只设 `KI_CONFIG_PATH` 不写 `dataDir` 时，日志会落到**真实 `~/.ki/kb`**（`loadConfig()` 不做 `KI_DATA_DIR` 环境变量回退）。首轮验证确实写进用户目录，已清理并重跑。隔离验证必须显式写 `dataDir`。
  - **计划与自评审**：`.plans/2026-11-02-task-diagnostic-log/`（plan.md 工作项 1~7 全绿 + checklist.md **21/21**，P0 清零；护栏 E1~E7 与上游导入 F1~F2 均带证据）。
  - **第二轮 auto-review（同日）又修 3 项**：① `event()` 的 `detail` 值未脱敏 —— 当前只传 `phase`/`code` 没事，但它是公开接口，将来传 URL/token 就会漏，改为在 `formatDetail` 内统一 `redactForLog`；② `error()` 的 `code` 未清洗 —— `task.finish` 调用方会直接传 `err.code`（任意字符串），含换行会把单行日志拆开（task JSON 侧有 `ERROR_CODE_RE` 校验、日志侧此前没有），改为压成 `_`；③ **前端 `logQuery` 的 queryKey 没带 `task.state`** —— 任务 running → failed 时不会重拉，诊断区永远停在打开那一刻（漏掉失败那行），只能手动点「重新读取日志」；key 改为 `['taskLog', id, state]`。
  - ★ **UI 未真机走查**：诊断区的渲染（布局、`pre` 限高滚动、按钮点击）只有单测覆盖逻辑，未起服务目测。需肉眼确认 5 点：失败态首页可见、日志正文滚动不撑破抽屉、窄屏按钮换行、`复制排查命令` 与「后续操作」里的命令不重复显示、成功任务无该区。

- [2026-10-30] **关系评分 / 冷热分区两个缺陷的修法待拍板**（已沉淀 ki `kisearch-memory` → `错误库/关系与索引管理`：「关系评分 NaN（useCount 缺失）」「冷热分区上限为负数抛 RangeError」）
  - 性质：只在缓存被手改 / 迁移中断 / 外部工具写坏时触发；正常写入路径（`ki import`、`ki sync-relation`）都会写 `useCount: 0`。校验层只判断 `hot_relations` 是数组，不看元素、不看 `partition_config` 字段。
  - 后果：`useCount` 缺失 → 评分 NaN，Group 聚合被 `|| 0` 吞成 0 分（静默失真）；元素为 null → 裸 TypeError。`maxHotCount` 为负 → `hot.length = -1` 抛 `RangeError: Invalid array length`（无 scope 上下文）。
  - 选项：**A 只记录**（现状，零风险）/ **B 加固**（`calculateScore` 兜底 + 聚合改 `Number.isFinite` + 三个上限取 `Math.max(0,…)` + 缓存校验扩到元素层；需跑后端单测回归）。
- [2026-10-29] **windows 分支的「向量不可用降级」能力被 master 覆盖，待拍板保留还是放弃**（合并已提交 `66c3c19`，未推送）
  - 现状：`useHttpReadiness()` / `isVectorHealthCheck()` / `useVectorAvailability()`（原 `web/src/lib/hooks.ts`，来自 `4e9d624 fix(web): degrade gracefully when vector service is unavailable`）被 master 版 hooks 取代而丢失；`web/src/api/httpApi.ts` 仍留 `HttpReadinessResponse` + `getHttpReadiness()`（`/healthz` 探针），**当前无任何使用方**。
  - 能力差异：master 只有展示层（`ServiceBadge` + `dimensionNotice` banner）；缺动作层保护（向量不可用时导入页禁用「向量化」、检索页自动切全文、写页禁用向量选项）。
  - 待拍板：① **保留** → 把 `useVectorAvailability` 接回 master 新结构（改 `hooks.ts` + `ImportPage`/`SearchPage`/`WritePage`，顶栏沿用 `ServiceBadge`），改完重跑 web `tsc` / 单测 / `build`；② **放弃** → 删掉 `getHttpReadiness` 与 `HttpReadinessResponse`。**当前按 ① 预留**，代码处于「导出在、使用方缺」的中间态。
  - 取回参考：`git show 4e9d624 -- web/src/lib/hooks.ts web/src/pages/ImportPage.tsx web/src/pages/SearchPage.tsx web/src/pages/WritePage.tsx web/src/layouts/AppShell.tsx`；合并前快照 `git show 5d8fa6c:web/src/lib/hooks.ts`。

### 最近完成

- [2026-11-04] **总览：新增「视图」统计卡 + 视图态卡头改称「当前视图」（未提交）**
  - 需求（用户截图）：总览顶部新增一张「视图」卡展示视图数量；顶栏选中视图时「当前知识库」→「当前视图」、kicker `CURRENT SCOPE` → `CURRENT VIEW`。
  - 口径：视图数 = `ki_scope_list` 的 `views.length`（复用同一份 scopeList，**0 新增请求**）；`views` 不在 `scopes[]` 里（`src/scope.ts:252-269` 已把视图名剔除）⇒ 与 Scopes 卡**不重叠**。
  - 「—」vs「0」：`scopes` 未到 → `—`；列表已到但无 `views` → `0`（与顶栏 `ScopeSelect` 的 `data?.views ?? []` 同口径）。后端只在有视图时才带该字段（`src/scope.ts:327-331`）⇒ 0 有两种成因（真的没建 / daemon 旧版不上报），title 两条都写明。
  - 卡头：文案收在 `currentScopeHeading(isView, name)`（kicker / title / scopeTitle / switchHint 四件一起切，防漏改英文）；右侧副行随之变「顶栏切换视图即时刷新」。
  - 搭车修复：`readModeCard` 新增 `{ isView }` 分支 —— 视图态旧 title 给出 `ki scope readonly <view> --off`（视图不在 `config.scopes`，必然失败）且声称"import 与数据源同步仍可更新"（视图不能作为写入目标）。**label/tone 不变**（仍「只读」/ warn），只换 title。
  - 布局：`.ki-stats--overview` 5 → 6 卡；**「视图」卡排「定时同步」右边**（用户 2026-11-04 定稿，初版放在 Scopes 右侧被要求挪过来）；≥1200 六等分，**1025–1199 三等分两行**（六等分时单卡内宽只剩 ~83px，「未开启定时同步」会折行把整行卡撑高），≤1024 两列，≤640 单列；原「5 卡最后一张 `span 2`」兜底删除（6 可被 6/3/2/1 整除）。
  - 落点：`web/src/lib/dashboardScopeCards.ts`（`currentScopeHeading` / `viewCountCard` / `readModeCard` 三参）· `DashboardPage.tsx` · `ki.css` · `web/test/dashboard-scope-cards.test.mjs`（+5 例）。
  - 验证：web `tsc` 0 · `npm test` **926/927**（唯一失败 `resources-page.test.mjs`「工具名与 docs/mcp-tools.md 一致」，与本次无关：两侧文件均未改）· `npm run build` ✓ · 布局走查 `temp/verify-overview-view-card.cjs`（chromium，读真实 ki.css + 同构 DOM）：1440/1280/1200 六列一行、1199–1025 三列两行、1024–641 两列三行、640/390 单列，**副行零折行、无横向溢出**。
  - **未做 / 遗留**：① 未连真实 daemon 走查（视图态渲染只有单测 + 同构 DOM 证据）；② **视图态其余 3 格仍不准** —— KB/RAG 两列显示 `—`（title 说"scope 不在列表"，真实原因是 `currentMeta` 查不到视图）、Wiki 回写显示 `—`（title 说"旧 daemon 未提供"）。**用户 2026-11-04 拍板：暂时保持现状**（口径若改需先定，如按 `memberMeta` 聚合显示 `N/M 库可用`）；③ 硬刷新后 scopeList 未到的那一帧仍会先显示「当前知识库」（`useIsViewName` 无 loading 态，`readMode` 早就同病），未处理。

- [2026-11-04] **缺陷修复：根保留键 `__root__` 泄漏到浏览页页头（连带 9 处出口 + 1 处路径口径）**（未提交）
  - 现象（用户截图）：浏览页页头显示 `原文阅读 · __root__ / Plugin_StartDebugPlugin`。
  - 证据（`.debug/browse-root-group-label-20261104/`，深链复现 + playwright）：`leaksRootKey: true`；`rootGroup.ts:10` 早已写死口径「该键只用于存储，一切面向人的出口都要经 `groupDisplayName()`」。
  - 修复：9 处展示统一过 `groupDisplayName()`（页头 span+title / 全文结果 aria / 树文档 title / 抽屉 `.ki-drawer__path` / 检索徽标 / 对话来源 3 处 / 提问引用 / 文档选择器 2 处 / 任务详情「Group」行）；`href`、query、`data-ki-group` 与请求参数**仍用原键**。
  - **顺带修的同类逻辑漂移**：`dataSourceDetailModel.mergeGroupSourcePath` 注释声称与后端 `doc-path.logicalDocPath` 同口径，实际缺 `isRootGroup → []` → 数据源「待删」树会多出 `__root__` 目录；已对齐（根不贡献路径段）。
  - `groupDisplayName` 签名放宽到 `string | undefined | null` → 空串（调用方多是可选字段）。
  - 新增守卫 `web/test/root-group-display.test.mjs`（19 例：映射单测 + 根不贡献路径段 + 任务详情 Group 行 + 9 个出口的源码守卫）。
  - **口径（2026-11-04 用户拍板，B 案：所有出口都不显示根）**：新增零依赖 `groupPathSegment()`（根 → 空串）——路径段位置（页头 span+`/`、树 title、抽屉身份行、检索徽标/title/aria、对话来源 3 处、提问引用、文档选择器 2 处、`docDisplayPath` 兜底、`sourceRefTitle`）一律整段省略，连分隔符一起；独立键值对位置用描述代替：任务详情「Group」行 → 「根目录」。`groupDisplayName()`（根 → 「根」）保留但仅限这类"不能空着"的位置。
  - **auto-review 自查又补 6 处漏改**（B 案第一轮漏的）：正文命中行 `.ki-browse-fulltext__path` + 其 aria、`ChatPanel` 引用 chip 的 title、`DocumentEditor` 头部 `<small>`、数据源列表「落点」列、数据源详情「落点 Group」行。口径收敛为常量 `ROOT_GROUP_FIELD_LABEL = '根目录'`（三处键值对共用）。
  - **不动点（防回归）**：`canOpen = Boolean(relation && group)`、`?group=` 深链参数、`data-ki-group`、`key={doc.group…}`、请求体 group 全部仍用原始键。
  - 验证：守卫单测 **31/31** · `tsc` 0 · `npm test` 901/901 · `build` ✓ · 真机页头（根 → `nodemgr 原文阅读 · Plugin_StartDebugPlugin`、`seps:["·"]`）· 组件级 SSR（SourcesList 根组 chip → `a.md · L5-8`）· 真机数据源页（5 源 group=null → 落点列 `(自动)`、详情「落点 Group」=「自动：按顶层子目录」、页面无 `__root__`、pageerror 0）。
  - 附带：`isRootGroup` 签名放宽到 `string | undefined | null`。
  - **未收口（已告知）**：`ImportPage` 6 处 `groupDisplayName` 仍显示「根」（导入预检同组文档 / 清空组提示 / 待删组树节点名 / 未完成归属）—— 其中"组树节点名"省略会变无名节点，属功能性取舍；其余位置待用户拍板是否一并改。

- [2026-11-04] **缺陷修复：添加 Git 数据源弹窗「点遮罩即关闭」**（未提交）
  - 现象（用户截图 + 原话）：弹窗打开后点弹窗以外任何区域立刻消失，已填内容全丢。
  - 证据（`.debug/ds-add-overlay-close-20261104/`，vite dev 5199 + 真实 daemon 7423 + playwright）：弹窗内点击不关（`1`）、遮罩点击关（`0`）；全文件仅 6 处 `setAddOpen`，遮罩 `onMouseDown` 是唯一非显式关闭入口（`DataSourcePage.tsx:951-953`）。
  - 修复：遮罩移除关闭口径；关闭入口收敛为 ✕ / Esc /「取消」三个显式动作，**仍不做二次确认**。推翻 2026-11-02 的「点遮罩直接关」口径（当时理由"表单重填成本低"，用户真机操作后改判 —— 五处输入框损失过大）。
  - 守卫测试改写：`web/test/datasource-add-close.test.mjs`（**7 例**：遮罩不得出现 `setAddOpen(false)`、遮罩必须只有 className 且不挂 `on(Mouse|Pointer|Click|Touch|Key)`、遮罩仍内联在本文件、三入口与"不加确认条"继续守）。
  - 验证：单测 7/7 · `tsc` 0 · `npm test` 861/861 · `npm run build` ✓ · 真机回归（遮罩左/右/下不关、填了内容点遮罩不丢、Esc/✕/取消仍关、Esc 后焦点回触发器、pageerror 0）。
  - **auto-review + challenger 复审修 1 项**：原守卫靠切片找 overlay 块，**遮罩若被抽成组件就会静默通过** → 改为断言"整段只有 className"+"仍在本文件内联"（后者失效时提示迁移守卫）。
  - **P2 已知项（不修）**：点遮罩后 `activeElement` 掉到 `BODY`（点击不可聚焦元素的浏览器默认行为）；实测按一次 Tab 即回到弹窗内首个按钮，Esc 仍可关。要留住焦点必须给遮罩挂 mousedown，会让"遮罩是纯容器"失效并削弱守卫 —— 留给日后补焦点陷阱时一并解决。
  - **同类隐患（未改，待拍板）**：`UserDialog`（用户新建/编辑，多字段）与 `ChangePasswordDialog` 的遮罩仍是 `!busy` 即关、**无脏表单确认**，误点同样丢输入。属别的页面既有口径，不由本次代拍。编辑弹窗（`discardOpen` 已拦）与移除确认框（无输入）无需改。

- [2026-11-04] **`demo/users-page-v2` 视觉精修第二轮（用户四点反馈）**（未提交，仅 demo 单文件）
  - 详情/编辑/个人页的 Token 表格**去掉外层卡片**（`.u2-token-table-panel` 整组 CSS 删除），表格直接用 `border-top` 与上文分隔；`.u2-token-card__body` 的 panel override 一并移除。
  - 编辑弹窗权限/状态/有效期改为**竖向排列**（`.u2-edit-grid` 单列），segmented 由全宽改为 `inline-flex + width:auto + button min-width:96px`（全宽会显得空）。
  - 创建 Token 内联表单：权限/访问范围竖向（`.u2-inline-panel__row` 单列），segmented 同样收窄；旧类名 `.u2-token-inline*` 统一改名 `.u2-inline-panel*`（CSS/HTML/JS 三处），边框由 `border-strong` 改 `border`，与其它卡片配色一致。
  - **重置密码改为独立按钮 + 内联面板**（`.u2-edit-tools` 按钮行 + `#editPasswordForm`），与「保存」解耦：点「重置密码」直接校验 8–128 位并生效（toast），面板打开时点「保存」会被拦截提示先完成/取消（同 `inlineTokenFormOpen` 口径）。原「保存时顺带改密码」逻辑删除（`resetPassword` 变量、`editPassword` 校验）。
  - 修：打开密码面板后按钮行的灰字说明残留（改为整行 `.u2-edit-tools` 一起 hidden，不再只藏按钮）。
  - 位置调整（用户第三轮反馈）：重置密码按钮行与展开面板从「有效期之后」移到 **meta 之下、权限之上**（`.u2-edit-tools` 分隔线由 `border-top` 改 `border-bottom`）。★ 移动时曾短暂出现两个 `#editPasswordForm`（先删后插导致重复 id），已删除 grid 后那份，grep 计数为 1。
  - 验证：截图浅色/深色/480px 窄屏 + 密码面板；功能回归 **11/11**（新增：密码面板短密码报错、提交后收起、未完成时保存被拦截），pageerror 0，lint 0。
- [2026-11-04] **`demo/users-page-v2` 视觉精修：编辑弹窗 / 详情抽屉 / Token 表格**（未提交，仅 demo 单文件）
  - 编辑弹窗：权限/状态/有效期三个 field 包进 `.u2-edit-grid` 三列并排（≤760px 单列），label 上置；重置密码独立 `.u2-edit-security` 浅底卡片；Token 说明 note 移入 `.u2-token-section` 内，区标题加左侧竖条、计数改 chip。
  - 详情抽屉：facts 去掉与头部重复的「状态」「最近登录」，只留有效期/创建时间/账号 ID 三项三列，上加分隔线；Token note 移入 Token 区末尾。
  - Token 表格：表头去 mono+大字距改 11.5px/500；列宽重排；名称列加 `keyIcon()` 钥匙图标（名称改为 flex 包裹，内层 span 做省略）；撤销按钮改 `.u2-btn--quiet-danger`（透明底、hover 浅红）；编辑区与个人页表格统一 `.u2-token-table-panel` 圆角容器，个人页去双边框（`.u2-token-card__body` 内 panel 只留顶部分隔线）。
  - 验证：playwright（`/root/openclaw-dev/ui/node_modules/playwright` + `/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`，系统另有 `/usr/bin/google-chrome`）截图浅色/深色/480px 窄屏；功能回归 8/8（编辑保存、内联建 Token 明文 43 位、撤销、抽屉 Esc、个人只读视角、空态），pageerror 0。脚本 `/tmp/u2-shot.cjs`、`/tmp/u2-check.cjs`，截图 `/tmp/u2-before` `/tmp/u2-after`。
- [2026-11-03] **`docs/` 清理「开发痕迹」：用户文档不写实现说明与交付话术**（未提交）
  - 起点：用户指出 `docs/mcp-http.md` 只读 Token 段（88-99）混入开发描述。根因是该段由提交 `6c90e36` 从 `src/lib/mcp-tools/tool-access.ts` 的注释直译而来（`fail-safe` 白名单方向、`initialize` 装配、`本期刻意不覆盖`）。
  - 判据（后续写文档沿用）：**排期话术**（本期/下期/后置/日期）、**维护者约定**（漏登记/不要复用/fail-safe）、**内部符号**（函数名、常量名、异常类名、`方案 A/D`、`S-05`/`T12`/`N17`/`P-7` 需求编号）、**自证论证**（「正常不会触发」「刻意如此」）、**自测证据**（实测/回归/commit）→ 一律改为使用者视角的行为陈述；错误码、CLI 参数、能力缺失、安全边界照留。
  - 落地 9 篇：`mcp-http.md`（重写只读 Token 段 7→6 条、删「同一会话复用 Token」整条、`方案 A`/`S-05`/`N17`/`EmbeddingConfigError`/`loadConfig`/`closeAllConnections`/`closeEngine`/`TASK_TTL_MS` 去内部符号）、`cli.md`（`S-05`、`--tags` 的 zvec 字段语义、`syncBatch`、`(2026-11-02)`×4、实测阈值、单例锁自证）、`import.md`（`方案 D`、`P-7`、实测翻倍、`新增`/`恒等式均不变` 编辑残句）、`configuration.md`（`T12`、`path.dirname`、「刻意正交」）、`error-handling.md`（`ensureScopeDir`、`NaN/TypeError`）、`group.md`（`agents-md-init` 依赖、仅理论边界）、`build-kb.md`（cache）、`backup-restore.md`（`ensureScopeDir`）、`mcp-tools.md`（标题「刻意不暴露的能力」→「MCP 未提供的能力」）。
  - **有意保留**：`mcp-http.md`「解决的问题」「会话模型」等章节讲 zvec owner / worker 串行化 —— 该文档主题就是单例模式；`architecture.md` 设计说明；`README.md:59`、`mcp-tools.md:5` 的「以代码为准」链接（便于核对）；`docs/archive/**` 归档不动。
  - 校验：`rg` 复扫 12 类关键词 0 命中（排除 archive）；`read_lints(docs)` 0；仅文档措辞，无代码与测试变更。
  - **待拍板**：`web/src/lib/resourcesPage.ts:131-133` 的 UI 文案同样是「MCP 刻意不暴露 …」，且 `web/test/resources-page.test.mjs:350` 断言含「刻意不暴露」——改文案需同步改测试并重跑 `web npm test`，未擅自执行。

- [2026-11-02] **添加 Git 源复用托管副本前先 fetch：修「远端有该子目录却报子目录不存在」**（未提交）
  - 现象：Web「添加 Git 数据源」填 `HACK-WU/learning` + 子目录 `agent-engineering`（GitHub 上确实存在）→ 红条「子目录不存在: agent-engineering；仓库顶层目录：… 等 32 个」。
  - 定位（纯静态 + 远端只读 clone，非本机环境）：远端顶层非点目录 **34** 个，hint 报 **32** 个，缺的正好是当次最新提交 `0a99e8e`（2026-11-02 17:45:34）新增的 `agent-engineering` + `distributed-python` ⇒ 被 readdir 的工作树 HEAD 早于该提交。
  - 根因：`add-remote` 复用同 remote 的托管副本时，`checkManagedSubdir` **只 readdir 当前工作树、从不 fetch**（`mcp-http-api.ts:2697`、`datasource.ts:820`）；只有同步流程才会 `fetch` + `reset --hard`（`datasource-git.ts:276,295`）。副本一滞后，远端已有的子目录就被判「不存在」，且文案绝对化，与 GitHub 页面直接矛盾，用户没有自救路径。
  - 修复（用户拍板「新增 git 源时若已存在相同 git 地址，应优先 fetch」）：新增 `refreshManagedClone(repoRoot, remoteBranch)`（`datasource-git.ts`，内部复用 `prepareGitSync({managed:true})` = fetch + reset --hard + clean -fdx），在两处复用分支的 `withManagedCloneLock` 内**先 refresh 再校验**；**fetch 失败不阻断**，降级按现有工作树校验并在错误里追加「目录列表可能滞后」。文档 `docs/cli.md` / `docs/mcp-http.md` 同步。
  - 验证：`npm run build` 0 · 新增 `test/datasource-reuse-refresh` **3/3** · `test/mcp-http-api` **66/66**（完整链路内新增「远端 push 新目录后复用 add 必须 200」）· `datasource-shared-clone` 3/3 · `datasource-clone` 14/14 · `datasource-clone-url` 12/12 · `datasource-git-probe` 10/10 · `datasource-sync-managed` 2/2 · 反向验证（临时禁 refresh）→ 用例红且复现原文 `子目录不存在：agent-engineering；仓库顶层目录：docs`，插桩已清理（DEBUG-TRACE 计数 0）。
  - auto-review 第二轮补：降级路径（bare 移走 → fetch 失败）断言 400 + `INVALID_SUBDIR` + `/目录列表可能滞后/`（删 staleWarning 即红）；修 `docs/cli.md` 一句与修复后行为矛盾的表述；`clone.headCommit` 由固定 null 改为真实 HEAD（唯一消费方 CLI 的 reused 分支不读它）；删 `refreshManagedClone` 未使用的 `options.timeoutMs`。
  - 代价（已知）：每次 add 复用都 fetch，前端等待上限 `15s fetch + 30s reset`，期间占 clone 锁，owner scope 并发同步会拿 `CLONE_BUSY`。
  - 未做：目标环境真机复验（需部署新 daemon，Web 端无需重建）；CLI 复用提示语未反映 fetch 结果。
  - 证据台账：`.debug/datasource-subdir-stale-clone-20261102/`。
- [2026-11-02] **添加 Git 数据源弹窗：关闭即关闭，不加二次确认（用户拍板）**（未提交；`web/dist` 已重建）
  - 现象：在弹窗里填了仓库地址，点弹窗外部（遮罩）弹窗直接消失，输入全丢。用户先报为问题，但**当天否掉了「二次确认」方案**：「点击关闭后直接关闭即可，它本身不是危险操作」。
  - 结论（改之前先读）：遮罩 / ✕ / Esc / 「取消」四个入口**都直接 `setAddOpen(false)`** —— 不加确认条、不引入 `requestCloseAdd` 这类中间层。**不要再按 `DatasourceEditDialog.discardOpen` 的口径给它加 discard 确认**（编辑弹窗要确认是因为改的是已存在配置，添加弹窗只是重填成本）。
  - 代码现状：`web/src/pages/DataSourcePage.tsx` 已回退到与改动前逐字相同，仅 Esc 处保留一句注释说明「关闭不做二次确认（2026-11-02 用户拍板）：表单重填成本低，不是危险操作」；`addBusy` 留在 S-05 段落原位置。
  - 守卫：`web/test/datasource-add-close.test.mjs`（5 例）—— 四个入口直接关 + **反向断言**不得再出现 `addDiscardOpen` / `放弃已填写` / `requestCloseAdd`。首版 footer 断言曾因「`onClick` 写在子节点之前」而误报，已修正切片方向（断言要取文案**前** 300 字符）。
  - 验证：web `tsc --noEmit` 0 · `npm test` **846/846** · `npm run build` ✓ · 真机 CDP 走查 **18/18**（`temp/walk-add-close.cjs`，vite dev + chrome-headless-shell，**不点提交**）：四个入口各跑一遍「先填好 URL 再关」，都直接关闭且全程无任何确认文案；空表单点遮罩同样直接关。截图 `temp/add-close/*.png`。
  - 未扩散（有意）：移除确认弹窗已有 `if (removing) return` 保护且无输入；`ReaderLinkComposer` 的选择器点遮罩关闭不丢数据。
- [2026-11-02] **Windows 添加 Git 源时桌面闪 cmd 窗口：15 处子进程调用补 `windowsHide`（未提交）**
  - 现象：Windows 上 Web「添加并开始首次同步」后，桌面弹出黑窗口并闪好几下。
  - 根因：daemon 以 `detached: true` + `stdio: 'ignore'` 常驻（Windows = DETACHED_PROCESS，自身无控制台），此后每 spawn 一个 console 程序（git.exe / tar.exe / cmd.exe / node.exe）系统都会新建控制台窗口；全仓库 `windowsHide` 原本 **0 处**。一次添加数据源调 git 5+ 次（clone + `probeGit` 的 4 条 + 首次同步），故闪好几下。
  - 修复：`datasource-git.ts`、`datasource-clone.ts`(×2)、`daemon-client.ts`、`mcp-server.ts`、`bin/ki.mjs`、`clean.ts`、`backup.ts`(×2)、`safe-tar.ts`(×3)、`tar-compat.ts`、`restore.ts`、`restore-snapshot.ts` 统一加 `windowsHide: true`（Linux/macOS 忽略该选项，零副作用）。例外：`bin/ki.mjs` **仅在 daemon 分支**开启 —— 非 daemon 前台进程继承当前终端、本就不弹窗，而 `CREATE_NO_WINDOW` 会让子进程拿不到 console 句柄（`isTTY` 变 false，颜色/进度条失效）。
  - 守卫：新增 `test/windows-hide.test.ts` 两条 —— ① 扫描 src+bin 中含 child_process 导入的文件（含 `require` 形式），按括号配平取出每个调用表达式（`execFile(Sync)`/`spawn(Sync)`/`exec(Sync)`）断言含 `windowsHide`；带注释剥离（文件头注释里有 `execFile('git', args)` 示例）+ 文件数/调用数下限（防正则失效假绿）。② 11 个已知文件的**白名单兜底**，覆盖别名写法（`cp.spawn(...)`）导致的正则漏检。**反向验证**：删掉一处 → 变红，恢复 → 变绿。
  - 验证：`npm run build` exit 0 · `node --check bin/ki.mjs` OK · `windows-hide` 2/2 · `datasource-git-probe` 10/10 · `datasource-clone` 14/14 · `datasource-clone-url` 12/12 · `clean` 18/18 · `safe-tar` 2/2 · `backup-layout` 4/4 · `mcp-daemon` 20/20。
  - **未在 Windows 实测**（本机 Linux 无法复现窗口）：需 Windows 以 `ki mcp --http --daemon` 启动后添加一次 Git 源复验。
  - 顺带确认（未改）：仓库子目录**支持多层级** `a/b/c`（`isSafeRelativeSubdir` 按 `/` 分段校验，仅拒绝 `\`、绝对路径、空段、`.`/`..`/`.git`）；Windows 下必须写正斜杠。
  - 遗留风险（未处理）：`GIT_ASKPASS`/`SSH_ASKPASS` 写成 `/bin/true`（POSIX 路径），Windows 上无效；私有仓库若交给 Git Credential Manager，可能弹 GUI 凭据窗（与本次 cmd 黑窗不同源）。
- [2026-11-02] **编辑文档「保存时向量化」：复选框改拨杆 + 向量不可用时禁用并就地说明**（用户拍板形态「A」；未提交；`web/dist` 已重建）
  - **动机**：用户截图显示顶栏已「向量不可用」，编辑器底部复选框仍可勾；勾了保存必然
    `500 DOC_INDEX_INCOMPLETE`（`document-editor.ts:177` → `relation-edit-publish.ts:388,406-409` → `:440-443` → `document-editor.ts:255-263`）。
  - **根因**：不是判据缺失（`lib/vectorAvailability.ts` 2026-10-29 已接回），是**接回范围遗漏** —— 当时只覆盖
    顶栏 + 导入/检索/写入/数据源/资源 5 处，编辑弹窗不在清单里。
  - **口径边界（重要，别误改）**：`DatasourceEditDialog.tsx:301` 的「向量化」**故意不禁用**（持久配置，置灰会锁死
    "关掉它走仅全文"的自救路径）；编辑弹窗这枚是**单次动作**（只作用于这一次保存）→ 禁用，与导入页同口径。
  - **落点**：`web/src/lib/vectorAvailability.ts` 新增 `editorVectorizeHint()`（四态文案，available 返回常驻说明；
    **不复用** `vectorAvailabilityHint`——那句主语是"检索已降级"，编辑器要讲"这次写哪层索引"）·
    `hooks.ts` 补导出 · `DocumentEditor.tsx`：接 `useVectorAvailability` + 派生 `effectiveVectorize = vectorize && vectorAvailable`
    （**派生不用 effect**，探测恢复后回到用户原选择，同 ImportPage 口径），复选框 → `<button type="button" role="switch">`
    + `.ki-switch`（**用 button 不用 div**：导入/写入页那两处 div 无 `tabIndex`，键盘切不了），
    说明为**行内 `<span>`（跟在「保存时向量化」右侧同一行，非独立行）** + `role="status"`，
    提交值 / 状态行 / indexError 文案全部改读 `effectiveVectorize` ·
    `ki.css`：`.ki-editor__vector` → `__vector-row/__vector-title/__vector-desc/__vector-desc--blocked`（说明行缩进 54px = 拨杆 44 + gap 10）·
    `web/test/vector-availability.test.mjs` +6 例（含「非 available 必须讲清只写全文索引」不变量）。
  - **验证**：`tsc` 0 · `test/vector-availability` **26/26** · web `npm test` **840/840** · `build` ✓ ·
    真机（`temp/walk-editor-vectorize.cjs`，CDP + chrome-headless-shell，**不点保存**）：隔离 config（`vectorDir=/tmp` +
    `embedding.baseURL=127.0.0.1:9`）造 unavailable、真实 config 造 available —— 不可用时 `disabled=true` /
    `aria-checked=false` / `ki-switch--disabled` / 告警色 `rgb(138,98,8)` / 点击无效 / `focusable=false`，
    **改正文后 `saveDisabled=false`**（禁用开关没连带禁用保存）；可用时点击 `aria-checked=true` / `focusable=true`；
    375 无横向溢出。截图 `temp/editor-vectorize/*.png`。
  - **★ 说明文案三轮定型（别改回去）**：① 首版放在开关**下方独立一行**（footer 73→90px）；② 用户否掉观感 ——
    拼进 `availability.reason`（如「密钥无效（HTTP_401）：请更新 embedding.apiKey…后重启 ki mcp」）拖成三行；
    ③ **定稿 = 行内一句、跟在「保存时向量化」右侧**，`editorVectorizeHint` **不许拼 reason**（完整原因在顶栏徽标的
    健康明细里），三态文案均 ≤ 20 字；footer 63px（1440）/ 129px（375）。测试锁死「任何状态都不许把 reason 拼进文案」
    +「非 available 文案 ≤ 24 字」。
  - **★ 窄屏折行用 padding 不用 margin**：800px 媒体查询里 `.ki-editor__vector-note { flex: 1 0 100%; padding-left: 54px }`
    —— 全局 `border-box` 下 `flex-basis: 100%` 配 `margin-left: 54px` 会横向溢出。
  - **质疑留存（待拍板）**：`review/challenge-report-editor-vectorize.md` —— ① 🟡 dense 文档在不可用时保存会**静默降级为
    fts 并删掉原向量**（`relation-edit-publish.ts:248-254`），说明行只说"本次只写全文索引"，未说"原向量会被移除"；
    ② 🟡 同类入口只修了 Web 编辑器，`ReaderLinkComposer.tsx:287`（添加链接，`vectorize: indexMode==='dense'`）仍是必失败，
    需决策"降级写 FTS"还是"阻止并说明"。证据台账 `.debug/doc-editor-vectorize-disabled-20261102/`（E-01~E-10）。
- [2026-11-02] **任务台账保留期 1 小时 → 7 天（与运行日志同窗口）；心跳存活窗口刻意解耦**（用户拍板 2 项：心跳维持 1 小时 / 前端文案改接 `retainedForMs`；未提交；后端 `dist` 与 `web/dist` 均已重建）
  - **核心拆分**：`TASK_TTL_MS` 原为 7 天 + 新增 `TASK_HEARTBEAT_TTL_MS`（1 小时，**不导出**）。原实现里同一个常量兼作「终态保留期」与「未终态心跳存活判定」（`task-registry.ts:698,720`），直接调成 7 天会让 daemon 崩溃留下的假 `running` 以 `unknown` 在列表与顶栏红徽章（`taskNotice.ts` 的 `FAILURE_STATES` 含 unknown）里挂满一周。
  - **消灭双源**：`mcp-http-api.ts:566` 的 `retainedForMs` 原为**硬编码** `60*60*1000`（与 `:890` 的 `TASK_TTL_MS` 打架），已改为引用常量。
  - **前端不再硬编码保留期**：新增 `web/src/lib/taskRetention.ts`（`formatRetention(ms)` → `7 天`/`1 小时`/`90 分钟`，非法值返回 `null` 让调用方**省略数字**）；`TasksPage` 副标题与详情错误态、`taskDetailModel` 的「重试自」hint 三处改为消费 `/api/tasks` 的 `retainedForMs`（该字段此前零消费方）。`buildTaskDetail(task, retentionMs?)` 新增可选第二参。
  - **文案同步**：`task-log-view.ts`(7 处)·`log.ts`(2)·`task-log.ts`·`task-snapshot.ts`·`datasource-types.ts`·`import.ts`·`index-maintenance.ts`·`mcp-http-api.ts`·`tasksApi.ts`·`AppShell.tsx`·`taskNotice.ts`·`docs/cli.md`·`docs/error-handling.md`。
  - **验证**：后端 `npm run build` exit 0 · `test/task-registry.test.ts` **8/8**（新增 2 条：3 天前终态仍可查/8 天后清理；心跳停 2 小时的假 running 被清、3 天前创建但心跳新鲜的保留）· `task-log-cli` 19/19 · `task-log` 14/14 · `task-log-api` 6/6 · web `tsc` 0 · `npm test` **834/834**（新增 `web/test/task-retention.test.mjs` 6 条，含「源码守卫：TasksPage/taskDetailModel 不得出现『保留 1 小时｜保留 7 天』字面量」）· `npm run build` ✓ · 隔离 daemon 真机（7451，临时 config）**6/6**：`retainedForMs=604800000`、3 天前终态可见、8 天前终态与心跳停 2 小时的 running 均被物理清理、页面「最近任务保留 7 天」、详情错误态「任务仅保留 7 天」、无预期外 console error；`ki log` 三条出路文案同步。
  - **★ 两项遗留已修（同日，用户确认「1 对」）**：
    - ① `/api/tasks` 的 `total` 改为「授权过滤后、分页前」的真实条数（`handleTaskList` 不再把 `limit` 传给 `listTaskRecords`——传不传不改变 IO，该函数本就遍历全部文件）。与 `/api/doc/list` 的 S0-2 修复同口径。`TasksPage` 的 `truncated` 判据（`total > tasks.length`）**首次真正生效**：> 200 条时出现「全部任务共 N 个，列表仅加载最近 200 条」。
    - ② `listTaskRecords` 溢出改为两段式：先按保留期删过期；仍超 `MAX_SCAN_FILES` 则调新增的 `pruneOverflowingTaskDir()` **按 mtime 从旧删到 `maxFiles - 1000`**，把「永久 503」恢复成自愈。★ 但**绝不删 `TASK_HEARTBEAT_TTL_MS`（1 小时）内修改过的文件**——活任务心跳每 5s 刷新 mtime，硬删会造成「任务在跑、记录没了」；全是新文件时仍 503（有意 fail-loud）。
    - 新增 `TASK_FILE_RE` 常量统一 3 处内联正则（`TASK_ID_RE` 的孪生，改一处必须改另一处）。
    - **验证**：`task-registry` **12/12**（+2 条溢出兜底，含「窗口内文件一个都不能删」）· `mcp-http-api` **66/66**（+1 条 total：造 3 条 → `?limit=2` → total>2 且 tasks.length=2）· `mcp-daemon` 20/20 · `task-log-api` 6/6 · `task-log-cli` 19/19 · `datasource-schedule-api` 5/5 · `import-incomplete-api` 20/20 · web `tsc` 0 · `npm test` **840/840** · 两端 build ✓。
    - **真机（7451）**：`?limit=2` → `total=6 / tasks.length=2`（修复前恒为 2）；造 210 条后 `?limit=200` → `total=216 / tasks.length=200`；前端走查 **5/5**（页头「共 216 个任务」、截断说明「全部任务共 216 个，列表仅加载最近 200 条」、全部任务卡 216）。
    - **未覆盖**：分页总页数仍按已加载的 200 条算（20 页 × 10），与真实 216 并排时依赖截断文案解释；服务端 offset 分页属大改，未做。
  - **观察（预期内）**：终态失败任务现在最长在顶栏「需关注」徽章挂 7 天（有手动忽略 + 同 scope/operation 后续成功自动消除）。
  - **★ 服务重启收尾已实施（同日，用户拍板跟进）**：`markInterruptedTasks(config)`（`task-registry.ts`，由 `mcp-http.ts` 在 `listen` 成功后调用）把上个进程遗留的 `queued`/`running` **一律**改判 `failed` —— 写入 `error=任务在执行中被服务重启打断，结果未落定`、`recoveryHint`、`result.errorCode='SERVICE_RESTART_INTERRUPTED'`，并在日志正文追加同名 ERROR 行；**原 `params` / `progress` / `result` 快照全部保留**（用户能看到做到哪一步）。单条 IO 失败只跳过该条、不阻断启动。
    - **★ 判据刻意不用 30s 心跳阈值**：重启只需 2 秒，按阈值筛会漏掉「刚重启」的记录，而它同样永远不会再跑。理由是 HTTP 单例锁——启动瞬间本进程尚无任务 ⇒ 台账里的非终态记录必然属于已退出进程。
    - **真机重启实测（两次）**：① 停 7451 → 台账 5 个文件全在（**重启不删文件**，回答了用户「重启是否清空」）→ 重启后终态 3 条不变、`queued`/`running` 两条变 `unknown`（旧行为）；② 打完收尾补丁后造 `t-running-2`（progress 12/40）→ 重启 → `failed` + `code=SERVICE_RESTART_INTERRUPTED` + **progress 仍 12/40**；`ki log` 三段（错误/提示/日志正文）齐全；web 走查 **7/7**（失败卡 5、详情显示原因与「重新发起该操作」、不再出现「状态未知」、无 console error）。
    - **回归**：`task-registry` **10/10**（新增 2 条：只改非终态 + 保留快照 + 幂等、目录不存在不抛错）· `mcp-http-api` 65/65 · `mcp-daemon` 20/20 · `task-log-api` 6/6 · `task-log-cli` 19/19 · `datasource-scheduled-run` 3/3。
    - **未做（可后续）**：前端 `taskErrorCatalog` 未收录 `SERVICE_RESTART_INTERRUPTED`（当前回落原文展示，行为正确、只是没有专门的处置文案）。
  - **★ 隔离实例 7451 仍在运行**（两次 `kill` 已被批准执行，但每次验证后又重启了新的 daemon）：`curl 127.0.0.1:7451/healthz` 可取到 pid；配置与台账在 `/tmp/ki-ttl-verify`。清理：`kill $(curl -s 127.0.0.1:7451/healthz | grep -o '"pid":[0-9]*' | cut -d: -f2)`。

- [2026-10-30] **数据源列表「下次同步」独立成列 + 值加重**（用户拍板 3 项：插在上次同步之后 / 窄屏也保留独立列 / 13px·600·正文色；未提交；`web/dist` 已重建）
  - **动机**：原先它只是「上次同步」列的副行（`.ki-ds-sched-next`：11px + `--ki-color-text-subtle`），是全表对比度最低的一行 —— 却承载唯一的**向前看**信息；且被塞在过去时字段里，读起来要跨语义。
  - **落点**：`web/src/lib/datasourceSchedule.ts`（`scheduleNextLine` 从单行 `{text,tone}` 改成 `ScheduleNextView{value,sub,tone,empty,title}`）· `web/src/pages/DataSourcePage.tsx`（表头第 6 列 + 行内新 td + aria-label）· `web/src/styles/ki.css`（9 列重排 + `.ki-ds-next*`）· `web/test/datasource-schedule.test.mjs`（改 8 条 + 新增 3 条）。
  - **宽屏 9 列配比（合计 100%）**：Scope 12.5 / 类型 9.5 / 源目录 12 / 落点 11 / 上次同步 16 / **下次同步 10.5** / 状态 7 / 持续 6 / 操作 15.5。**类型 9.5% 与上次同步 16% 不许再压**：前者是「Git + 定时⚠」实测最宽组合的下限，后者要放 19 字符完整时刻。
  - **窄屏 ≤1399 改为五列**：Scope 190 / **下次同步 118px** / 源目录 auto / 状态 96 / 操作 186；`--compact` 下沉方案整体删除（`.ki-ds-sched-badge--compact` / `.ki-ds-sched-next--compact` 已无引用）。
  - **★ `nth-child` 三处必须联动重编号**：`th:nth-child(1..9)` 宽度 · `td:nth-child(5)` nowrap · 窄屏媒体查询的 `(1)(3)(6)(7)(9)`。加列时漏一处就会「列宽对、内容错位」。
  - **★ 空值 `—` 会被 `600` 放大**：4 行未开定时的源全是黑色 600 的 `—`，把唯一真实时刻压成配角。故数据层出 `empty: boolean`（不在 JSX 里比 `value === '—'`），渲染层据此降 400 + subtle；CSS 中 `--empty` 必须写在 `--warn` **之前**（同特异性靠声明顺序）。
  - **★ 告警不能只进 title**：连续失败 ≥3 原先写在可见文本里，改两行后若塞进 title 等于没说 —— 现为「副行改报 `连续失败 N 次`、周期退到 title」。反向同理：「仅一次已执行」不再拼「仍会尝试」，也不再转 warn 色（计划已结束，没有待办）。
  - **★ 375 档两个连带缺陷（不修就是回归）**：① 五列固定宽合计约 590px > 视口，不给 `overflow-x: auto` 时「状态 / 操作」被直接裁掉、按钮点不到；② `table-layout: fixed` + 总宽溢出会把「源目录」压成 0 宽（表头在、内容全无）→ 表格 `min-width: 720px`。
  - **验证**：`tsc --noEmit` 0 · `npm test` **806→809/809**（深轮复审又 +1 条「即将补跑 + 连续失败」）· `npm run build` ✓ · 真机 `temp/walk-ds-next-column.cjs` **17/17**（1440/1200/375：表头九列、主值 14px/600/正文色、empty 400/subtle、表格溢出 0、375 容器 `overflow-x:auto` 且 720>269、行高三档均 55px 与改版前一致）· 截图 `temp/ds-next-col/*.png` · 质疑报告 `review/challenge-report-datasource-next-column.md`（9 条质疑 7 条成立，全修）。
  - **★ 列宽必须按最长态收口，且数字要实测**：`temp/measure-next-value.cjs` 用 Range 量文本占位，实测跨天主值 `10-31 20:35` = **85px**（原按字号推算写 112px，偏大 27px）、最长副行「已执行 · 仅一次」= 77px、`即将补跑` = 56px；1440 列内容宽 103、1200 为 94。同一脚本临时挂 `.ki-ds-next--warn` 验证告警色确实落到主值+副行（`rgb(138,98,8)`），因为真机数据里没有连续失败的源、仅靠单测证明不了样式这条链路。
  - **遗留**：375 首屏顺序为 Scope + 源目录，「下次同步」需滑动 —— 若要求首屏必见需在 ≤640 隐藏源目录列（属隐藏数据列，待拍板）。

- [2026-10-30] **Windows 上数据源页幽灵 scope「sched-api 目录不可读」→ 测试隔离缺陷**（未提交；纯 `test/` 改动）
  - **现象**：Windows 真机数据源页出现一条从未登记的 `sched-api`，`目录不存在：C:\...\Temp\ki-ds-sched-api-1CG6I8\source`；同页「共 0 个数据源」。
  - **根因**：`test/datasource-schedule-api.test.ts` 只设 `process.env.HOME` 做隔离；**Windows 上 `os.homedir()` 读 `USERPROFILE`**，而该测试配置不写 `dataDir`（默认 = `os.homedir()/.ki/kb`）⇒ `addDataSource` 把登记写进**真实**用户目录，测试收尾又删掉临时目录 → 留下指向已删路径的幽灵登记。`scanDataSources()` 如实判 `missing`，页面照实告警（**产品侧行为正确**，非 bug）。
  - **改法**：新增 `test/isolate-home.ts`（`useTempHome` / `useTempHomeAt`：临时家目录**同时**挂 `HOME` + `USERPROFILE`，返回 `restore()`），改造 8 个同类测试（`datasource-schedule-api` / `import-assets` / `import-incomplete-api` / `datasource-clone` / `wiki-backfill` / `resolve-default-paths` / `daemon-rpc-stream` / `scope-wikisync-status`）+ `scope-doc` 单点补 `USERPROFILE`。仓库内原有正确写法见 `test/mcp-http-api.test.ts:41`、`test/mcp-daemon.test.ts:28`，本次抽成唯一来源。
  - **验证**：9 个文件逐个回归全绿（7/5/6/21/26/20/14/1/12）；`wiki-backfill` 的 `exportedAt 刷新` 断言属**既有毫秒精度 flake**（`wiki-sync.ts:221`），HEAD 原文件 8 次 / 改后 10 次均 0 失败，与本次无关。
  - **用户侧存量**：`ki datasource remove --scope sched-api --yes`（或删 `<kbDir>/sched-api`）即可清除，不碰文档/向量。
  - **证据台账**：`.debug/datasource-ghost-scope-win-20261030/`（E-01~E-10）。
  - **连带的产品侧改动（用户拍板 B 方案）**：`missing`（目录不可读）行原本只有「定时」按钮、**没有「移除登记」**，用户无法在页面上清掉幽灵登记。
    - **定时入口收敛为唯一**：删除 missing 行的「定时」按钮（它是 `DatasourceScheduleDialog` 的**唯一**使用方），定时设置此后只经行内「编辑」弹窗（`DatasourceEditDialog` → `saveDataSourceSchedule`）。`DatasourceScheduleDialog.tsx` 整文件删除；`ki.css` 删 `.ki-ds-missing-row`(2) + `.ki-ds-sched-dialog`(2+注释) + `.ki-ds-sched-dialog .ki-dialog__body` + `.ki-ds-sched-sub` + `.ki-ds-sched-error` + `.ki-ds-sched-footer`(3)；**保留** `.ki-ds-sched-discard`（编辑弹窗复用）与其余 `.ki-ds-sched-*`（`DatasourceScheduleFields` 用）。
    - **missing 行改为与 corrupt 行同构**（`ki-task-notice--warn ki-ds-notice--action` + 一枚「移除登记」，带 `data-ds-remove` 供失败后焦点归还）；`RemoveTarget` 增 `missing?: string`；移除弹窗增 missing 变体（副标题「源目录已不存在，移除只是清掉这条失效登记」/「源目录不存在」danger 徽标 / 「已失效 <reason>」路径行 / 「目录恢复后可 `ki datasource add` 重新登记」/ 脚注「只删除这条失效登记，库内文档不动」）。**missing 不传 `force`**（记录合法，只删 datasource.json）。
    - **★ 与确认稿的两处偏差（语义等价，已披露）**：① `missing[]` 只有 `{scope, reason}`、**没有 `dir`**，故「源目录」独立键值行改为一行「已失效 <reason>」（reason 已含完整路径）；加字段需改后端契约 + 重启 daemon，未做。② 弹窗主按钮沿用既有「确认移除」，未改「移除登记」。
    - **auto-review + challenger 复审（同日）**：修 4 项 —— ① 漏网测试 `import-prune-api`（只设 HOME，Windows 上被测代码去真实 `~/.ki/import-uploads`）+ `wiki-backfill` 的 before 冗余重复设 HOME，均改用 helper；② 5 处仍指向已删定时弹窗的过期注释（页面 2 + Fields 头 + ki.css 2）；③ **aria-label 违反 Label in Name**（可见「移除登记」不在 aria 名内）→ missing 改 `移除登记 {scope}（目录不可读）`，**corrupt 行同类缺陷一并修**；④ ki.css 残留注释。**质疑驳回 1 项**：移除登记后调度器不残留（`fire()` 每次重读 records，`due.length===0 → refresh()`，无噪音日志）。**遗留 2 项**：`missing[].schedule` 前端 0 消费方（清理需改契约）；该页 DOM 无入库自动化测试。
    - **验证**：web `tsc --noEmit` **0** · `npm test` **806/806** · `npm run build` ✓（dist 已重建）· 隔离 daemon 真机（临时 config，7429，未触碰用户 7423）**15/15 PASS**：缺失行有「移除登记」/ **无「定时」** / 弹窗 missing 口径 / **不误显示「目录」类型徽标**（missing 无 type，缺省会渲染成「目录」——已专门分支）/ 删除后接口 `missing` 清空 / 结果提示 / 375 无横向溢出 / 0 console error。验证后已关闭 7429 并清理临时目录。

- [2026-10-30] **修：导入页切分参数合法仍报「切分参数不合法：undefined」，导入被永久拦死**（未提交；`web/dist` 已重建；案例 `.debug/import-chunk-params-20261030`）
  - **根因**：`validateChunkFields()` 返回的是**结果对象**（成功态 `{ ok: true }`，truthy），`ImportPage.tsx:598` 却把它当「错误对象或 null」用 → `if (chunkParamErr)` 恒真、`chunkParamErr.message` 恒 `undefined`。引入点 `9bc049a`（该函数新建的同一次提交）。同一函数在 `DatasourceEditDialog` 用法正确（判 `.ok`），只有导入页中招。
  - **症状侧写**：红框/就地文案永不出现（`field` 恒 undefined），只有按钮旁 `runBlockedReason` 显示「切分参数不合法：undefined」；点「开始导入」被 `start()` 同一判断拦下，请求根本不发出。
  - **修复**：`web/src/lib/datasourceEdit.ts` 新增 `chunkFieldsError()`（「错误或 null」视图）+ `ChunkValidation` 改**判别联合**（成功态无 `field`/`message`，`tsc` 能拦住"取 message"这类误用）· `ImportPage.tsx` 改用 `chunkFieldsError` 并去掉 `setError(err.message ?? '切分参数不合法')` 的死兜底 · 单测 +3 条（首条锁「合法 1000/150 必须返回 null」）。
  - **★ 教训：`{ok: true}` 是 truthy**。web 里 `validateScheduleForm` 用的是同款可选字段类型（3 处调用方均正确判 `.ok`，本次**未改**以避免搭车变更）；新增校验函数时，若调用方要判空请直接返回 `X | null`，不要返回结果对象。
  - **★ 为什么原「真机走查 28/28」没抓到**：`temp/verify-chunk-params-ui.cjs` 只断言「红框消失 / `.ki-form-error` 数为 0」，而本 bug 恰恰是**没有红框、只有按钮旁红字**；I 步「点导入 → 卡片展开并高亮」在被拦下时同样成立。缺「合法参数点导入 → 请求真的发出」的断言。
  - **★ 类型防线是实测过的，不是"应该能拦"**：临时探针（`web/src/temp-typecheck-probe.ts`，验证后删除）把误用写回 → `tsc` 报 `Property 'message' does not exist on type '{ ok: true; }'`。同类改造可复用这招：写完判别联合就写一个探针跑 `tsc`，别只靠读注释相信它有效。
  - **★ `ChunkFieldError` 用 `Extract<ChunkValidation, { ok: false }>` 派生、`chunkFieldsError` 原样返回收窄结果**（不新建对象）—— 否则 `ChunkValidation` 以后加字段会被这层包装静默裁掉。
  - **验证**：web `tsc` 0 · `npm test` **802→806/806**（复验时并行会话又加了 4 条 `task-query-model`，非本案例）· `npm run build` ✓（dist 已更新）· 后端 `npm run build` exit 0 · 真机 `temp/verify-import-chunk-fix.cjs` **15/15**（dev 源码与 **`web/dist` 产物各跑一遍**：合法 1000/150 点导入 → upload/preflight/run 三请求真的发出；对照 99999 → 按钮旁即时提示带 100–4000 并拦下）。
  - **★ 提交注意**：`git add` 由并行会话执行过，暂存区里是该修复的**第一版**（`interface ChunkFieldError` + 新建对象）；工作区已是优化版（`Extract` 派生 + 原样返回）。提交前须重新 `git add web/src/lib/datasourceEdit.ts`，否则提交的与 `web/dist` 里的不一致。
  - **走查踩坑**：`.ki-scope-target` 的 class 不能判确认态（根 class 恒 `ki-scope-target`）；「选择已有 Scope」模式下输入框**回车不确认**（`ScopePathSelect.tsx` 的 onKeyDown 只处理 `mode==='new'`），要么点下拉项，要么切「新建 Scope」+回车。

- [2026-10-30] **`ki mcp --status` → `ki mcp status`（子命令化，旧写法保留为弃用别名）**（未提交；后端 `dist` 与 `web/dist` 均已重建）
  - **落点**：`src/mcp-server.ts`（MCP_HELP、`knownPositionals` + `status`、分发改 `positional === 'status' || argv.includes('--status')`、别名打 stderr 提示、`-status` 提示改「子命令写法」、restart 超时 hint）· 提示文案 `daemon-bridge.ts` / `daemon-client.ts`(4 处) / `mcp-stdio-lock.ts` · 注释 `mcp-http.ts` / `mcp-token.ts` · `bin/ki.mjs`（帮助 + 两条「查看状态」提示）· `docs/cli.md` / `docs/mcp-http.md`（flag 表把 `--status` 行移出 → 新增「子命令 `ki mcp status`」说明行）/ `README.md` · web `resourcesPage.ts::STATUS_COMMAND` + `ResourcesPage.tsx` 两处 CopyButton label + `web/test/resources-page.test.mjs`。
  - **★ 兼容策略**：`--status` 仍可用（脚本/IDE 配置不中断），但 stderr 提示「请改用 ki mcp status」。**未彻底删除** —— 属 breaking change，等用户拍板。
  - **★ 顺带修的真 bug（`--http status` 会被静默启动服务）**：positional 扫描原来对**任何** `--flag` 都吞掉下一个 token（当成分离值），于是 `ki mcp --http status` 里 `status` 被当 `--http` 的值吞掉 → 漏判子命令 → 直接启动 HTTP 服务。现改为只有 `valueFlags`（`--host`/`--port`/`--token`/`--allowed-hosts`）才跳过下一 token；布尔 flag 后的裸 token 必须参与子命令判定。副作用：`ki mcp --http foo` 现在 fail-loud 报未知参数（原为静默启动）。
  - **验证**：后端 `npm run build` exit 0 · `test/mcp-daemon.test.ts` **19/20**（+5 新用例：帮助不含 `--status`、`status` 输出 JSON、`--http status` 仍走诊断、旧别名可用且提示、`-status` 提示新写法；**唯一失败项为既有环境问题**：`回环正常启动 + -d` 因 SiliconFlow 余额 402 预检失败）· `test/mcp-stop` 9/9 · `test/cli-aliases` 21/21 · web `tsc` 0 · web `npm test` **799/799** · web `npm run build` ✓ · 真机：`ki mcp -h` 第 8 行为 `ki mcp status`、`ki mcp status` 输出 JSON、`ki mcp --status` 打迁移提示、`ki mcp -status` 报 `UNKNOWN_OPTION` 并提示子命令写法。
  - **未做（三条，均需拍板）**：
    ① `status` / `stop` / `restart` 路径都还没做 flag 白名单校验（`ki mcp status --prot 7423` 会被静默忽略 → 探错端口）。
    ② `stop` / `restart` / `token` 的 dispatch 仍写 `argv[0] === xxx`（只有 `status` 改成按 `positional` 判定），于是 `ki mcp --http stop` 这类混写会被**静默当成启动服务**——与本次修掉的 status 吞参缺陷同族。统一需把 loop 里 `positional` 的下标记下来再切片。
    ③ **`CodeWikiHub/kisearch/module-experts/MCP服务专家/**` 仍是旧写法**（7 文件 12 处，含 C0/C1/C2 契约层；另 `qoder/repowiki`、`.gitnexus/wiki`、`temp/worktree-windows-*`、`.plans/*` 也有残留）—— 专家包是 AI 消费的契约资产，未同步前查专家会拿到作废命令。
  - **auto-review 第 2 轮修补**：新增的别名用例用 `spawnSync` 直读 stderr（`runCli` 成功路径丢弃 stderr），已补 `USERPROFILE` 镜像，避免 Windows 上隔离 HOME 失效。

- [2026-10-30] **资源页「注册 scope」→「Wiki 回写」+ 新增落点核心区**（用户拍板；未提交；`web/dist` 已重建，7423 刷新即生效）
  - **标题最终定为「Wiki 回写」**（同日二次调整：先改「注册 scope 与 Wiki 回写」，用户要求再缩短）；`label` 与 `title` 同为「Wiki 回写」，`02 · SCOPE` kicker 保留以表明仍在配置组。总览页链接文案同步为「资源 › Wiki 回写 ↗」。
  - **需求**：Wiki 回写是本产品核心能力（AI 改一次 → KB + 向量 + 用户自己的 wiki 仓库同时变），但原页面上它只是「注册有什么好处」4 条里的第 3 条 + 每行末尾一枚徽标 → 读者收到的是"配置项之一"。用户要求改名 + 把能力可视化（要图）。
  - **术语（用户 2026-10-30 定稿）**：统一「**Wiki 回写**」（此前代码/文档/UI 混用「Wiki 写回」）。web/src 里面向用户的文案已全量翻转；`docs/*.md` **未改**（另一批，待定）。
  - **落点**：`web/src/lib/resourcesPage.ts`（topic 改名 + 摘要同口径 + `SCOPE_CONFIG_BENEFITS` 删「Wiki 回写的前提」降到 3 条 + 新增 `WIKI_FLOW_*` / `WIKI_WRITE_ACTIONS` / `WIKI_NO_WRITE_ACTIONS` / `WIKI_FILE_SAMPLE` / `WIKI_FILE_PATH_NOTE` / `wikiBackfillCommand` / `wikiBackfillNotes` / `WIKI_WRITEBACK_CAVEAT` / `describeWikiWriteback`）· `ResourcesPage.tsx`（`ScopeSection` + `WikiFlow` / `WikiLines` / `WikiActionBox` / `WikiWritebackTable`，替换原 `RegisteredScopes`）· `ki.css`（删 `.res-registered*` / `.res-wikisync*`，新增 `.res-wiki` / `.res-flow*` / `.res-wslist*` / `.res-cols2` / `.res-colbox*` + ≤720 断点）· `DashboardPage.tsx`（列头/行内文案/链接文案改「Wiki 回写」，链接改「资源 › 注册 scope 与 Wiki 回写 ↗」）· `web/test/resources-page.test.mjs`（label 断言 + 新增 17 条）。
  - **★ 判定函数必须单一来源**：状态表四列由 `describeWikiWriteback(ws)` 产出，它**直接复用 `describeWikiSync` 的 tone/title**，只额外算「状态/目录/来源」。总览页仍用 `describeWikiSync`。两处各写一套判定就会出现"总览说未配置、资源页说已配置"（已用测试锁 `tone` 全等）。
  - **★ 有「来源」列才解释得通**：回写优先落 `group-index.source`（导入源），`wikiSync.sourceDir` 只是兜底（`wiki-sync.ts:84-106`）。少了来源列，用户配完发现写到别处，页面无任何解释。未配置态**不展示** source 块路径（2026-10-28 回归点），只在 `title` 里留排障线索。
  - **★ 落点图那句「不是事务」不能省**：`writeBackToWiki` 失败只返回 `{synced:false,reason}`，不回滚 KB/向量。不写这句，"wiki 没写出来"会被读成"数据没存上"。
  - **★ 「✔」的含义要限定**：`resolveWikiRootDir` 只 `statSync` 判目录、**不探测写权限**（只读挂载下仍显示 ✔）。页面已挂 `WIKI_WRITEBACK_CAVEAT`（"目录存在 ≠ 可写"）；真探测属后端改动，用户本次拍板不做。
  - **★ 落点图两个 CSS 坑（demo 实测后修）**：① 分叉横线若画在 `top:-7px`（= 源框底边同一 y），看起来像"线从框里穿出来"→ 改为 32px 竖杆 + 横线画在**杆中点**（`-16px`）；② 三等分列宽 273.33px，横线按 gap 一半（6px）相接时浏览器取整留 1~4px 缝 → 左右各取 **7px 叠 1px**。
  - **★ auto-review 自查抓到的 3 个真缺陷（都已修）**：
    ① **P0 事实错误**：初版把「Web 在线编辑保存」列进「会回写」→ 错。`document-editor.ts:249` 建草稿时 `skipWikiWriteback: true`，改的是**这篇文档自己的源文件**（`writeSourceAtomically`），`relation-edit-publish.ts:426` 那道通用回写不执行；`!file` 时只回一句 warning、**不产生任何 wiki 文件**。已移出清单并单列 `WIKI_EDIT_SAVE_NOTE`。
    ② **P1 漏列**：只写了 `ki_sync_relation`，漏了 `ki_bulk_sync_relation`（批量）与 `ki_edit_relation`（局部编辑 finish 也经 relation-edit-publish 回写，见 `edit-relation.ts` 读 `draft.wikiSynced`）—— 而「AI 编辑」正是用户的心智模型，漏了等于答非所问。
    ③ **P1 窄屏语义**：状态表 ≤720 折单列时表头被隐藏，`/data/wiki` 与 `wikiSync` 变成无主语文本。已补 ARIA（`role=table/row/columnheader/cell`）+ 每格 `data-label`，由 CSS `::before` 补标签。
    另修 2 处措辞：`WIKI_WRITEBACK_CAVEAT` 补「不保证目录还存在（导入源可能已被清理）」；空态的「按下面的方式加一个」→ 点名「怎么配置（config.yaml）」（页面变长后"下面"指向模糊）。
  - **★ 未覆盖的已知边界（用户已拍板不动）**：总览页「显示注册 scope」表的 Wiki 回写列只显示 `✓ <目录>`，**没有「来源」列** —— 导入源覆盖 wikiSync 的情形在总览页看不出来，只有本页状态表能看出。如需对齐需另开口径。
  - **验证**：web `tsc --noEmit` 0 · `npm test` **779/779**（基线 761 + 18）· `npm run build` ✓ · 真机走查（7423 真实 daemon，`temp/walk-scope` 脚本）**40/40**：nav 文案未截断 / 标题+kicker / 摘要同口径 / 小节顺序 / 三节点与 key 只落在第三处 / 前两处"总是生效" / 状态表 4 列表头 + 真实数据 + ✔ 限定语 / 会 5 条 · 不会 4 条 / markdown 示例含 frontmatter / 配置片段 / 补齐 4 条（命令实填 default）/ 次要收益 3 条 / 旧 `.res-registered` 已消失 / 桌面与 375 均 0 横向溢出 / 0 console error / 总览链接与列头文案。
  - **demo**：`demo/resources-scope-wiki/index.html`（零构建，`<link>` 真实 `ki.css`；**现状 + 提案上下同屏**，不提供切换）。状态表第 5 行 `demo-import` 是造的数据，用于展示"导入源压过 wikiSync"这一态。
  - **遗留**：`docs/*.md` 仍是「Wiki 写回」；`autoBackfill`/`wiki-backfill` 的后端行为未改动。

- [2026-10-30] **`wikiSync.sourceDir` 改为必须绝对路径**（用户拍板；未提交）
  - **动机**：相对路径的解析基准是**配置文件所在目录**（`config.ts::expandPath` 的 `path.resolve(baseDir, …)`，baseDir = `path.dirname(configFile)`），而用户写 `./wiki` 想的是 shell cwd。配置在 `~/.ki/config.yaml` 时 `./wiki` → `~/.ki/wiki`，写回静默落错位置。
  - **唯一实施点**：`config-schema.ts` 新增校验器 `absolutePath`，挂在 `SCOPE_ENTRY.fields.wikiSync.sourceDir.validate`；放行 `path.isAbsolute` 与 `~`/`$HOME` 前缀，其余（`./wiki`、`wiki`、`../wiki`、`${HOME}/wiki`）报 `CONFIG_FIELD_INVALID`。
  - **★ `${HOME}/…` 一并拒绝**：`expandPath` 不认该写法，过去会拼出字面量目录 `${HOME}`（本次实测复现）。它是「相对路径的另一种伪装」，归入同一错误。
  - **★ 空串不放行也不报路径错**：`if (!s.trim()) return`，交给 `string` 分支既有的「按未配置」告警，避免同一字段双报。
  - **未做防御性重复校验**：`config.ts:769` 仍调 `expandPath`（只做前缀展开），仅在旁加注释指向 schema —— 全部加载路径（含 `--config`、JSON、mtime 热加载、快照）都经 `parseAndExpand`，schema 是唯一权威点。
  - **连带改文案（不改就会教用户写错）**：web `resourcesPage.ts::buildScopeConfigSnippet` 的 `sourceDir: ./wiki` → `/data/wiki`（用户在资源页复制的那段）+ `SCOPE_CONFIG_NOTES` 增一条；`src/config.ts` 的 `config init` 模板注释；`docs/configuration.md`（字段表 + 为什么 + 校验表新行）、`docs/cli.md`、`docs/build-kb.md`。
  - **验证**：后端 `npm run build` exit 0 · `config-doctor` **64/64**（+5：相对/裸名/`../`/`${HOME}` 拒绝 + 绝对/`~`/`$HOME` 放行 + 空串仅告警）· `wiki-root-resolve` 14 · `wiki-import-sync` 9 · `scope-wikisync-status` 6 · web `tsc` 0 · web `npm test` **761/761**（+1 snippet 绝对路径断言）· 端到端探针 7 种写法结果符合预期。
  - **`web/dist` 已重建**（auto-review 发现旧产物仍含 `sourceDir: ./wiki`，页面会教用户写必被拒的写法 → `npm run build` 后新 bundle `index-Ds2E5quq.js` 已无该串）。
  - **★ 仓库状态坑**：`web/src/lib/resourcesPage.ts` 的两处改动（片段 + 口径提醒）被**并行会话的提交 `f448c1b` 一起带走**（该提交主题是资源页字段卡改版），故 `git status` 里看不到它；排查「我的改动是不是丢了」时先 `git show HEAD:web/src/lib/resourcesPage.ts`，别急着重写。
  - **未做**：`kbDir` / `dataDir` 等其它路径字段仍允许相对（用户只要求 sourceDir，且现已是各自明确口径）。

- [2026-10-30] **资源页两处视觉改版：`当前生效配置` → 字段卡（B 方案）+ `向量一致性` → 结论块（去按钮）**（未提交；`web/dist` **已重建**；7423 刷新即生效，纯前端无需重启后端）
  - **用户拍板**：Q1 **B 方案**（每字段一枚独立小卡，非 A 的 1px 缝隙网格）；Q2/Q3/Q4 按推荐落地（保留等式对比 / 重试出口交顶栏 banner / 显示检查时刻）。
  - **落点**：`ki.css` 新增 `.res-kv*`（卡片阵，`grid-template-columns: repeat(2, minmax(0,1fr))`、gap 8px、≤720 单列）与 `.res-dim*`（状态块，ok/warn 走 `color-mix` 淡底 + 语义色描边）· `ResourcesPage.tsx` 两个 section 的 `<ul class="res-notes">` 换成 `.res-kv`、一致性区换 `.res-dim`、删除 `refreshDimension()` 与 `refreshVectorDimensionStatus` import 及本 section 的 `useQueryClient` · `resourcesPage.ts` 的 `EmbeddingConsistencyCopy` 新增 `headline`（短结论词）与 `compare`（`{collection, configured, relation:'eq'|'ne'}`，缺任一维度时不给）+ 新增 `formatDimensionCheckedAt()`（本地时区 `MM-DD HH:mm 检查`）· 单测 `resource-embedding.test.mjs` +5 条。
  - **★ 关键决策：不去掉 `text` 字段**。`text`（完整句）保留给 `.res-sr-only` 读屏与无 compare 时降级；页面渲染用 `headline` + `compare`。三者由**同一分支**产出，禁止页面自行拼装，否则会出现「text 说一致、compare 缺值」的同屏矛盾（已写进函数头注释与单测）。
  - **★ 连带必改（否则文案指向已删按钮）**：`embeddingConsistencyView` 三处 detail 原写「可点「重新检查」重试」→ 改为「刷新页面可重试」/「重建完成后本页会自动更新」；单测新增断言 `headline+text+detail` 不含「重新检查」，防回归。
  - **★ 删按钮的功能依据**（不是"少个按钮而已"）：重建类任务完成后 `AppShell.tsx:314` 会 `invalidateQueries(['vectorDimensionStatus', scope])`，本页同 queryKey 自动更新；请求失败重试走刷新页面；mismatch/unknown 顶栏 banner 仍有「重新检查」（`AppShell.tsx:602,620`）。已披露代价：同页失败后不能原地重试。
  - **★ 可复用坑①（奇数格留白）**：A 方案的 1px 缝隙网格在字段数为奇数时右下会透出缝色，像个占位块；当时用 `:last-child:nth-child(odd) { grid-column: span 2 }` 补。**B 方案（独立小卡 + 8px gap）天然没有这个问题**，故最终未采用 span 2 —— 换方案后要复查上一个方案的补丁是否还需要。
  - **★ 可复用坑②（角标定位）**：`.res-kv__label` 用 `justify-content: space-between` 会把「内置默认」角标推到格子最右（380px 宽格时飘出 300px，读起来像另一个字段）；改 `flex-start` + `gap: 6px` 紧跟标签。同时删掉 `SourceTag` 的内联 `marginLeft: 6`（会与 gap 叠加成 12px）。
  - **验证**：web `tsc --noEmit` **0** · `npm test` **756/756**（含新增 5 条）· `npm run build` **✓**（dist 已更新）· 真机走查（dev :5173 代理真后端 :7423）**14/14**：6 格 / label 覆盖 / 角标 / 密钥降脚注 / 旧 `.res-notes` 消失 / 一致性单块 / headline「一致」/ 检查时刻「10-30 18:25 检查」/ 对比行「集合维度 1024 维 = 配置维度 1024 维」/ **「重新检查」按钮 0 个** / sr-only 完整句 / 对话页 5 格 / ≤720 单列 / 0 console error。
  - **demo**：`demo/resources-config-kv/index.html`（零构建、`<link>` 真实 `ki.css`；默认展示已落地的 B；顶部可切 现状/A/B）。**★ 若 IDE 内置浏览器开了强制深色，浅色页面会被反色 → 曾表现为"点浅色没用"；已改为浅色/深色两块并排同屏、不再提供切换**。并排时踩到真实坑：只重设 `[data-theme="light"]` 的 token 不够，`color` 是「已计算值」继承 → 必须在块上显式 `color: var(--ki-color-text)`，否则白底白字（诊断实测 bg 白 / color rgb(233,237,232)）。
  - **追加（同日）：单位换算**（用户看真机后要求「字符用 1000K 这种格式、超时用 s」）：新增 `formatCharsK()`（`1,000,000`→`1000K`；<1000 给原数；最多 1 位小数去尾零）与 `formatTimeoutSeconds()`（`300000`→`300s`；最多 2 位小数）。落点：对话页「上下文刻度 / 单次超时」+ **向量页「查询超时」`3000ms`→`3s`**（同类问题，用户只截了对话页，按扩展规则一并改）。
    - **★ 不复用 `contextUsage.formatK` / `formatKUnit`**：那两个是**用量占比**口径，刻意保留 `1000.0K` / `0.48K` 的小数以便看出细微变化；改它们会波及对话面板（跨模块搭车），故新函数放在 `resourcesPage.ts` 并注释写明分工。
    - **★ snapshot 一律不改**：`buildLlmConfigSnippet` / `buildEmbeddingConfigSnippet` 里的 `requestTimeoutMs: 300000`、`contextChars: 1000000`、`queryTimeoutMs: 3000` 是「复制进 config.yaml 的内容」，换算成 s 会让人照着写错配置。已用单测双向锁住（展示换算 + snippet 原值），并在真机断言 snippet 文本。
    - **验证**：`tsc` 0 · `npm test` **760/760**（新增 4 条）· `build` ✓ · 真机 **6/6**（`1000K` / `300s` / `3s` + snippet 两处原值未变）。demo 已同步这三个值。
    - **auto-review 复查（同日）又修 2 处**：① demo 的 A 方案补丁 `.res-kv__cell:last-child:nth-child(odd){grid-column:span 2}` 未限定 `:not(.res-kv--loose)` → B 变体也吃到了，导致 demo 里「工具调用」占满整行而落地是半格（**看 demo 会误判最终形态**）；② 未配 API Key 时一致性块主行写「暂不校验」、旁边却挂「18:41 检查」，自相矛盾 → `checkedAtLabel` 改为 `apiKeyConfigured ? … : ''`（其余态保留：表示快照里上次检查时间，与顶栏 banner 同口径）。
    - **★ 真机复核覆盖到 5 种一致性格**（用 playwright route 覆写 `/api/vector/status` 与 `/api/embedding/summary` 造数据，走真实组件与真实 CSS）：一致 / 不一致（768≠1024，含命令复制）/ 暂不校验 / 尚未建向量索引 / 读取失败（500）**10/10 PASS**；375 窄屏无横向溢出且单列；深色 warn 态数字 `rgb(237,167,162)`、`≠` `rgb(217,173,92)`（未糊成纯灰）。**★ 顺带证实兜底存在**：mismatch 时唯一的「重新检查」按钮来自顶栏 `ki-vector-dimension-banner`（`.res-dim` 内 0 个）—— 判「页内无按钮」必须限定选择器范围，否则会误报 FAIL。

- [2026-10-30] **MCP Token 只读访问模式**（用户拍板 **A 方案：只做 MCP 层**；未提交；前端仅文案，`web/dist` **未重建** —— 避免把并发会话未提交的 `ResourcesPage.tsx` 一起打包）
  - **需求**：`ki mcp token generate --scope <...> --read-only` 生成只读 Token；远程连上后**看不到写工具**（13→5），构造 `tools/call` 仍被拒（403 `TOKEN_READONLY`）。
  - **单一事实源**：新增 `src/lib/mcp-tools/tool-access.ts`（`READ_ONLY_TOOL_NAMES` 5 个读工具 + `TOKEN_READONLY` + `readonlyRejectMessage` 四要素文案 + `READ_ONLY_INSTRUCTIONS`）。**与 `operation-coordinator.ts::READ_MCP_TOOLS` 是两套口径**（后者是并发调度分类，`ki_tag_list` 不在其中但语义只读），注释已写明禁止互相引用。
  - **白名单方向（fail-safe）**：注册侧只注册白名单，拦截侧「不在白名单即 403」（含 batch 逐项）—— 新增工具漏登记默认被拒，不会静默放开写入。
  - **落点**：`mcp-token.ts`（`TokenRecord.readOnly?` / `TokenAuth` / `createToken(scopes, filePath, readOnly)` / `updateToken(id, patch)` / `findTokenAuth` / `isReadOnlyFieldInvalid`）· 新增 `lib/mcp-server-factory.ts`（从 `mcp-server.ts` 抽出 `buildKiMcpServer`：原文件末尾有 `startMcpServer()` 入口副作用，不可被单测 import；`mcp-server.ts` 保留 re-export）· `mcp-http.ts`（`resolveTokenScopes`→`resolveTokenAuth`、`buildServer(auth)`、`findReadOnlyViolation` + `rejectReadOnlyRequest`，接在 scope 校验处、任何副作用之前）· `mcp-server.ts` CLI（`--read-only`/`--read-write`、`update` 可只改一项、未知 flag 走 `MCP_TOKEN_UNKNOWN_OPTION`、list 带 `accessMode` 与非法字段告警、generate hint 提示只读仅对非回环生效）。
  - **关键决策**：① **禁止复用 `SCOPE_READONLY`** —— 它的文案引导 `ki scope readonly --off`，复用会让 AI 关掉库级只读保护；② `readOnly` 严格 `=== true` 才只读，字段非法按读写 + `list` 告警（fail-closed 会把用户锁死）；③ 进程级临时 Token（`--token`/`KI_MCP_TOKEN`）永远读写，不参与降权；④ **拦截按每请求实时、工具列表是建连快照需重连刷新**（已在 update 输出与文档写明）。
  - **已知边界（用户已知悉）**：只读只约束 MCP 通道；`/api/*` 与 chat 通道仍按 scope 放行 —— `curl -H "Authorization: Bearer <只读token>" -X POST /api/import/run` 仍可写（选 A 的既定取舍，文档已记）。**回环来源（127.0.0.1）免鉴权 ⇒ 只读不生效**，本机用只读 Token 验证会「看起来无效」。
  - **验证**：后端 `npm run build` exit 0 · web `tsc` 0 · web `npm test` **722/722** · `mcp-token` 33 · 新增 `mcp-token-readonly` **28** · `mcp-http` **36**（含 5 条只读拦截 HTTP 用例）· `mcp-http-api` 65 · `scope-readonly` 7 · `document-editor` 4 · `import-prune-api` 12 · chat 权限 13 · 真机 e2e `temp/verify-readonly-e2e.mjs` **15/15**（隔离 HOME + **非回环 `172.26.238.136`** 访问：只读 5 工具、构造 `ki_store` 403 `TOKEN_READONLY`、读写 13 工具、升权后同会话列表仍 5 而 `tools/call` 已放行）。
  - **★ 可复用坑**：本机 e2e 必须走**非回环 IP**（由 `os.networkInterfaces()` 自动探测；用 `127.0.0.1` 会命中「回环免鉴权」→ `sessionAuth=null` → 13 个工具全露，极易误判成功能没生效）。
  - **auto-review + challenger 修复（同日）**：① `rejectUnknownTokenFlags` 从 generate/update 提到 `runTokenCommand` 开头 —— list/delete 此前会**静默忽略** `--readonly`（同一类安全属性静默失效）；② `tool-access.ts` 注释 typo（AIB→AI）；③ 文档补两条：**反向代理/SSH 隧道使源地址为 127.0.0.1 ⇒ 鉴权与只读都不生效**、**同一会话不要复用不同 Token**（工具集是建连快照）；④ e2e 从 15 项补到 **20 项**：新增 `instructions` 真下发（把"静态声明"升级为已验证）、**降权方向**（读写→只读后同会话写调用立即 403）、降权后列表仍 13；⑤ e2e 非回环 IP 改为自动探测。
  - **遗留**：`test/mcp-daemon.test.ts`「回环正常启动 + -d → exit 0 且服务真实就绪」稳定失败（在干净 HEAD worktree 上同样失败，与本改动无交集，疑似真实 embedding 端点 3s 探测窗口）；前端 `resourcesPage.ts` 文案未重建 `web/dist`。

- [2026-10-30] **资源页「接入」新增「向量模型」只读页**（`REQ-20261030-001` 实施中 · 未提交 · `web/dist` 已重建；**7423 主服务仍是旧后端，重启后 `/api/embedding/summary` 才生效**）：用户拍板 **Q1 = A 纯只读（无修改操作）**、**Q2 = 只针对当前 scope**（原 A+ 档的全 scope 体检 + 参数试算均砍掉）。
  - **落点**：`src/lib/embedding-summary.ts`（新增，纯读文件不发网络）· `mcp-http-api.ts` 加 `GET /api/embedding/summary`（`/vector/status` 之后；**不带 scope ⇒ 不进越权白名单**）· `web/src/api/embeddingApi.ts`（新增，404 显式归「旧 daemon」）· `resourcesPage.ts`（`ResourceTopicId`+`'embedding'`、`04 · EMBED`、12 个常量/纯函数）· `ResourcesPage.tsx`（`EmbeddingSection` + `SourceTag` + 分派一行）· `README.md` 页面能力行。`routes.tsx`/`AppShell.tsx` 未动（`/resources/:topic` 已通配）。
  - **★ 接口口径**：`source: configured|builtin-default` 按「**原始 YAML 里该字段是否存在**」判定，**不能**比较值是否等于默认值（用户显式写 `dimension: 1024` 属 configured）；`apiKeyConfigured` 只出布尔（防侧信道）；无配置文件 → `configPath: null` 且**不报 warning**；有文件但读失败 → 全降级 builtin-default + `warning`，不抛错。
  - **★ 修的既有缺陷（仅在新页修，总览未动）**：**D-1** 内置默认值被当「已配置」显示（`config.ts:661-671` 缺省回落 + `DashboardPage.tsx:408` 的 `model || '—'` 永远走不到 `—`）→ 新页每个字段挂「内置默认」角标；**D-2** 维度角标只看维度不看 apiKey → 新页一致性判据见下。
  - **★ 可复用坑①（一致性判定顺序）**：必须 `未配 key → 失败 → mismatch → persisted 缺失 → compatible`。原本先判 `persisted === undefined`，结果把「探测失败」说成「尚未建向量索引」= **把故障伪装成正常**。`hasError`/`statusError` 必须在它之前。
  - **★ 可复用坑②（后端在无集合时返回 compatible）**：`readVectorDimensionSnapshot` 在 `persisted===undefined` 时判 `compatible`（`vector-dimension-snapshot.ts:140-142`），前端**不能**据此显示「集合一致」，要显示「该知识库尚未建向量索引」。已用单测锁住。
  - **★ 可复用坑③（写漏角标）**：真机走查才发现 `provider` 行漏了 `SourceTag`（未配置态只出 3 个角标而非 4 个）——**同类字段要整组渲染**，别手写逐行。
  - **★ auto-review/code-review/challenger 复审又修 5 处**（见「可复用坑④~⑦」）：C1 片段硬编码维度 🔴 · C2 来源判定口径不一致 🟡 · C3「宣称可用」越界 🟡 · C4 同屏矛盾 🔴 · C5 超时文案与长 URL 断行 🟢。
  - **验证**：后端 `npm run build` exit 0 · `test/embedding-summary` **9/9** · `test/mcp-http-api` **65/65** · `test/config-doctor` **59/59** · web `tsc` 0（`DataSourcePage.tsx` 的 `flashTone` 报错属**并行会话**改动，非本次）· `npm test` **723/723**（基线 694 + 29）· `npx vite build` ✓（`npm run build` 会被上面那个并行错误挡在 tsc 一步）· 隔离 daemon 真机 **34/34**（`temp/verify-embedding-page.cjs`）+ **降级专项**（伪造 `/api/health` 密钥 fail → 页面转 warn 且与顶栏一致）。
  - **★ 可复用坑④（只读页也会「越界断言」）**：页面只读 config 就说「向量化可用」是错的 —— key 存在 ≠ 有效。正确口径是「已配置」，可用性从 `useVectorAvailability()`（与顶栏同源、0 新增请求）取；不接它就会出现「页面绿 / 顶栏黄」同屏矛盾。
  - **★ 可复用坑⑤（片段别写死默认值）**：embedding 的示例片段若硬编码 `dimension: 1024`，用户照抄会把自己 768 维的库写成 1024 ⇒ **所有已建库语义检索立刻失效**。片段必须用当前生效值（复制即现状）。
  - **★ 可复用坑⑥（来源判定要抄合并表达式，别自创）**：`config.ts:661-671` 对 provider/baseURL/model 用 **truthy** 判断、对 dimension/queryTimeoutMs 用 **存在** 判断；若统一按「字段存在」判 configured，`provider: ''`（schema 无 validate、能过校验）就会「值来自默认却标成你的配置」。
  - **★ 可复用坑⑦（走查选择器别按位置取）**：`.res-note` 的 `first()` 在页面加了行内 `res-note` 后会失准（同类坑：`.ki-task-sort:last-of-type`）。限定语这类「只要在页面上」的断言用 `body.textContent()`。
  - **★ 真机走查环境坑**：`page.goto({waitUntil:'networkidle'})` 在本站**必超时**（任务轮询不停）→ 用 `domcontentloaded` + `waitForSelector`。隔离 daemon 若用假 apiKey 会因启动预检 fail 拒绝启动（`mcp-server.ts:761`），要么真 key，要么走 `${ENV_VAR}` 引用（把 key 放环境变量、配置只写引用，不落盘）。`pkill -f "ki-emb"` **杀不掉**隔离实例（命令行是 `node bin/ki.mjs mcp --http --port 7499 --web`，不含临时目录名）→ 从 `ps` 取 PID 再 `kill`。
  - **遗留**：① 7423 需重启；② 总览 D-1/D-2 另开需求（Q7）；③ 三页降级 hint 补获取指引未做（Q8）；④ 文档 §11 记录了实施细节。

- [2026-10-30] **数据源列表：行序冻结（D 方案）+ 同步中把列表轮询降到 3s**（未提交；`web/dist` 已重建）——用户报"同步完成后行从最上面跑到最下面""持续时间不到 1s，页面却十几秒才变"。证据 `.debug/datasource-list-order-poll-20261030/`。
  - **行序跳动**：后端 `src/lib/datasource.ts:1042` 按 `lastSync.at` 升序（最久未同步在前）排序，同步完成该行即沉底，分页时还会跨页"消失"。**后端排序未改**（CLI 输出不变），在 `DataSourcePage.tsx` 加 `rowOrder` 冻结：首屏用后端顺序并记下序列，此后按序列取行、新 scope 追加末尾、刷新页面（组件重挂）才重排。实测：mock 后端把首行移末尾，DOM 顺序不变；reload 后按新序重排。
  - **列表滞后**：`useDataSourceList` 原来固定 `refetchInterval: 15_000`，任务 0.8s 跑完要等 15.2s 才恢复「成功」（详情抽屉本来就是 `running ? 3s : 15s`，所以抽屉比列表快）。改为「有任一行 running 就 3s」，实测 **15.2s → 3.2s**。
  - **审查后补的可测化**（`review/challenge-report-datasource-list-order-poll.md`）：把冻结逻辑抽成 `web/src/lib/datasourceOrder.ts`（`mergeRowOrder` / `applyRowOrder`，纯函数、同序返回原引用），新增 `web/test/datasource-order.test.mjs` **11 条**，锁住「后端重排不影响冻结序 / 新行追加末尾 / 移除剔除 / 同序不触发重渲染 / 12 行两页不丢行」；组件内联实现改为调用它们，逐行行为等价。单测 **694 → 705**。
  - **验证**：`tsc` 0 · `npm test` **705/705** · `build` ✓ · 行序冻结单页 3/3 · 分页 3/3（第1页冻结 / 12 行不丢 / 新增行落第2页）· 同步抖动真机 14/14 · 轮询延迟 15.2s → 3.2s。
  - **已披露的语义代价**：冻结后页面顺序与 `ki datasource list` 在本次会话内可能不同；新登记的行排末尾；刷新页面才重排。
- [2026-10-30] **数据源页点「同步」页面抖动 → 按钮文案恒定 + scope 状态徽标**（未提交；`web/dist` 已重建，7423 生效）：用户先给方案（按钮只变灰 + scope 后加「同步中」徽标），`debug` 定位后出 demo 确认，用户选 A 画法。
  - **根因**：按钮文案随状态变长（`同步` 52 → `提交中…` 70px），`.ki-ds-row-actions` 当时是 `flex-wrap: wrap`，操作列可用宽仅 158px（≥1400 的 15%）/ 162px（≤1399 固定 186px），三按钮 52+46+46+12=156 只余 2px ⇒ **3 字文案必换行**，行高 55→93、表格下边界 +38px、请求返回回弹。视口 <1600 一律触发。
  - **改法**（不动任何列宽）：① `DataSourcePage.tsx` 同步按钮文案恒为「同步」，只变灰；② scope 名后加 `.ki-ds-sync-badge`（脉冲圆点 + 文字，排队态换 warning 色）；③ `syncingScope` → `syncingScopes: Set`，**只灰被点的那行**（原条件 `syncingScope === null` 会让整列一起灰）；④ `ki.css` 合并两处 `.ki-ds-row-actions` 重复定义并把 `wrap` 改 **`nowrap`** 兜底；⑤ 行级结果提示改 `.ki-ds-flash` **fixed 浮层**（原先插在表格之前会把 `.ki-card` 下推 61px），info 6s 自动消失、warn 常驻 + 关闭按钮；**落点其后由底部居中改为顶部居中 `top: 56px`**（用户反馈"太往下了"——5~10 行时表格底边 y≈489，底部浮层在 y≈836，离操作位置隔整屏空白；顶栏 8~42、页头中段 42~104 本为空，实测 1440/1024/640/480/375 五档都不压表格与「添加 Git 数据源」按钮，长文案 warn 2 行 56~114 也不压表格）；**内容最终复用站内 `Notice` 组件**（`Notice` 新增可选 `onClose` + `.ki-notice__close`，info→success 绿 / warn→warn 黄，不再自造配色），info 停留 **1s**（6s → 3s → 1s，用户两次反馈"停留太久"），warn 仍常驻；⑥ 删掉随之失效的 `.ki-ds-notice--focus`。
  - **验证**：web `tsc` 0 · `npm test` **694/694** · `npm run build` ✓ · 真机 **14/14**（`temp` 外的 `.debug/datasource-sync-jitter-20261030/artifacts/verify-fix.cjs`：行高/表格上下边界全程不变、按钮恒 52px、只灰 1 行、徽标脉冲 `ki-ds-pulse` 生效、浮层 `position:fixed z1100` 且不挤表格、info 6s 消失、1024/768/375 无横向溢出）· 稳定态 **6/6**（`verify-running-badge.cjs`：mock 列表返回 running/queued，行高 55/57 不变、「同步中」54px、「排队中」带 `--queued` 类）· 失败态 **5/5**（`verify-warn-flash.cjs`：429 → warn 浮层 `role=alert` 常驻 7s 不被吞、可关闭）。
  - **★ 可复用坑①**：`DataSourcePage.tsx` 在编辑期间被外部（另一会话 / IDE 缓冲）**整体回滚**一次，`ki.css` 的改动保留 —— 多会话并行时改完必须 grep 复核关键锚点（`syncingScopes` / `ki-ds-sync-badge`）再往下走。
  - **★ 可复用坑②**：加徽标不改变行高（行高由操作列 32px 按钮 + td padding 决定，scope 单元格 16→18px 撑不动），但会把长 scope 名压成省略号（`verify-compare2` 名字可用宽 157-54-6≈97px，显示为 `verify-co…`）。这是 A 画法的既定代价，`title` 有全量。
  - **质疑环节（auto-review → challenger，报告 `review/challenge-report-datasource-sync-jitter.md`）抓到并修掉一条真实回归**：`submitRemove` 成功后焦点交给结果提示，而 info 浮层 6s 自毁 → `activeElement` 掉到 `body`（键盘用户丢失位置）。修法：`dismissFlash(kind)` 关闭前判断焦点是否在浮层内，是则交还 `.ki-ds-table__row`（表空退到「添加」按钮），自动消失与 ✕ 共用该出口；取证与复验见 `artifacts/verify-focus-loss.cjs`。
  - **遗留（待拍板）**：① `syncingScope → Set` 属超出「消除抖动」意图的搭车变更，用户当时只说「不太懂」，未明确拍板（回滚仅 3 处）；② info 提示 6s 自动消失对「下次运行时间 / 任务 ID」可能偏短；③ 组件 DOM 行为无入库自动化测试（只有 `.debug/` 临时 playwright 脚本）；④ `syncingScopes` 允许不同 scope 并发提交（后端各自 scope 锁 / 429 兜底），无并发上限。

- [2026-10-30] **后台任务页改版：卡片即筛选 + 表头排序 + 搜索 + 分页常显 + 时间精确到秒 + 「定时同步」来源**（未提交；`web/dist` 已重建，7423 生效，纯前端改动无需重启后端）：按 PM 报告 + `demo/tasks-page/index.html` 三轮确认后落地（用户拍板 **Q1 时间 12px / Q2 删「最近结束」/ Q5 全 0 摘要压成「无变更」**）。
  - **卡片即筛选**：页头 `.ki-task-filters` 整块删除（它到列表卡实测 **111px**，≤900 视口 192px）；4 张统计卡升级为 `<button aria-pressed>`，顺序固定 **全部任务 / 失败·状态未知 / 部分完成 / 运行中·排队中**（「全部」在最左，用户要求），再点一次已选卡回「全部」。总数移到页头副标题。
  - **表头排序**：工具条排序按钮删除，箭头就地跟在列名后（当前列实心 ↑/↓ 主色、其它列灰 ↕）；**默认开始时间降序**；点同列翻转、点新列回默认降序；**持续时间可排序**，无耗时行（运行中/排队中）固定排末尾、不随升降序翻转。窄屏（≤1199）列宽放不下 4 字，表头自动换「耗时」短标签。
  - **搜索**：工具条最右（在「点击表头箭头可排序」提示左边），支持**状态关键词**（输入「失败」「进行中」「排队」即可命中，别名表 `STATE_SEARCH_ALIAS`）＋知识库/操作/来源/错误/摘要。工具条左侧只留「当前筛选 · N 个」（用户要求「全部任务」在左）。
  - **分页**：改为**一直显示**（单页 / 空态都给「第 1 / 1 页 · 共 N 个任务」，避免筛选后整块消失导致高度跳变）；**保留每页 10/50/100 选择器**（用户中途改口要回）；新增**页码直达** `1 2 3`（>7 页折叠 `…`）。
  - **时间**：列表列改 `2026-10-30 15:57:55`（19 字符，12px 自然宽 128px、需 152px 单元格）。列宽 `th:nth-child(6)` 14%→**16%**（1200 视口 155px）、≤1199 `132px→152px`、≤760 `96px→164px`（旧格式的「折两行」兜底相应移除）。**详情抽屉不动**：其「时间」段是 163px 双列栅格、日期由 hint 承载，改完整格式会折行。
  - **来源类型**：`SOURCE_LABEL.scheduler` 由「定时」改 **「定时同步」**（后端 `source: 'scheduler'` 早就存在，写入点 `src/lib/datasource-scheduled-run.ts:112`，缺的只是文案与配色）；徽标由与 CLI 相同的实心浅绿改**紫色**（`--ki-color-purple`），四来源四色可辨（网页灰 / CLI 绿 / 后台服务黄 / 定时同步紫）。
  - **摘要压缩**：「成功 0 · 跳过 0 · 未完成 0 · 新增文档 0 篇」→「无变更」，但**失败 / 状态未知不压缩**（否则故障被伪装成没事），无 `result.files` 的行（运行中/排队中）不参与。
  - **落点**：`web/src/lib/taskQueryModel.ts`（新增：筛选/计数/搜索/排序纯函数）· `taskListModel.ts`（时间格式 + 摘要压缩）· `taskDetailModel.ts`（来源文案）· `TasksPage.tsx` · `ki.css`（卡片筛选态 / 工具条 / 表头排序 / 分页页码 / 紫色徽标 / 断点）· `web/test/task-query-model.test.mjs`（新增 25 项）· `web/test/task-list-model.test.mjs`（时间正则 + 压缩 + 来源文案）。
  - **验证**：web `tsc` 0 · `npm test` **694/694** · `npm run build` ✓ · 真机 **70/70**（`temp/verify-tasks-page-v2.cjs`：卡片顺序/aria-pressed/工具条顺序/时间格式/表头 aria-sort/排序翻转/状态搜索/空态文案/分页常显+页码+每页选择器 + **9 档视口** 1920→375 的时间列宽与时序间距、排序按钮不溢出 + 深色选中卡）。
  - **★ 可复用坑①（375 破版）**：`82 + 164 + 80` 三列固定宽吃光 269px 表宽，任务列被压成 0（`table-layout: fixed` 不撑开容器，`scrollWidth` 检测不出，只能量单元格宽度才发现）。已加 `@media (max-width: 520px)`：时间列回 96px 折两行、持续时间整列隐藏，任务列恢复到 91px。375 视口的结构性问题（任务列本来就窄）仍是历史遗留，本次只保证「不比改版前更差」。
  - **★ 可复用坑②（测试选择器）**：`.ki-task-sort:last-of-type` 会同时命中两个表头的按钮（各自父元素内唯一），排序断言会假通过/假失败；用 `[title="按持续时间排序"]` 定位。
  - **审查补充（同日 auto-review + challenger，修 3 项）**：
    ① `counts.all` 口径回归——列表只加载 200 条，卡片改用 `tasks.length` 后与页头 total 打架（截断时），已改回 `query.data.total`；
    ② 「无变更」压缩漏排除 **已取消**——取消任务会被读成「跑完没变化」，已并入异常终态；
    ③ **长搜索词撑破工具条**（challenger 抓到）——`.ki-task-toolbar__count` 无截断，120 字符关键词把计数撑到 985px、搜索框被挤到中间，760/375 直接横向溢出；已加 `min-width:0 + max-width:48% + ellipsis`，完整内容进 `title`。
  - **遗留**：无 `result.files` 的旧任务，结果摘要列显示 `—`（既有逻辑，本次未动）；排序后选中行可能翻到别页（`syncedSelectionRef` 防重复跳页，属既有机制，抽屉为浮层不遮挡，判定不修）；「开始时间」列在排队中显示的是创建时间（既有口径，用户未要求改）。
- [2026-10-30] **切分参数（chunkSize / chunkOverlap）范围校验全链路补齐**（未提交；`web/dist` 已重建；**7423 主服务仍是旧后端，`/api/import/run` 前置校验需重启才生效**——前端校验纯浏览器侧，已生效）：起因是「1000 字符配 1024 维是否匹配」的提问。两者**互不约束**（一个管输入长度、一个管输出宽度），但由此查出 chunkSize 全链路只有 `>0`、无上下限的真实缺口。
  - **取值**：段长硬边界 **100–4000**（沿用前端既有 `min/max` 承诺）、重叠 **0–500**、默认 1000/150 **不变**；建议 **500–2000** 只进提示不阻塞。
  - **依据**：中文 1000 字符 ≈ 700–1000 token，配 1024 维 ≈ 1 token : 1 维，是 embedding 舒适区；4000 字符 ≈ 3000 token 配 1024 维已是 3:1 压缩、语义明显稀释，故取为上限。模型真实上限 128K token（`qwen3.7-text-embedding-flash`，约 13–20 万汉字），与 4000 差 30 倍以上，**不是**约束来源。
  - **单一事实源**：`src/lib/chunker.ts` 导出 `DEFAULT_/MIN_/MAX_CHUNK_SIZE`、`DEFAULT_/MAX_CHUNK_OVERLAP`、`SUGGESTED_CHUNK_SIZE_*` + `validateChunkParams()`；`web/src/lib/datasourceEdit.ts` 复制同值常量（两套 tsconfig 无法跨目录 import，两侧须同步）。
  - **落点**：`import.ts` 的 `handleDirectImport`（拿写锁前 fail-fast，覆盖 CLI `import` / `/api/import/run` / 数据源同步三条链路）· `datasource.ts` add / update / addRemote 三处（抽公共校验替换原三段重复）· `mcp-http-api.ts` 的 `/api/import/run` 建 job **之前**同步 400 · `ImportPage.tsx`（此前只有 HTML `min/max` 属性，`type=number` 对手动输入不生效 = 等于裸奔）· `DatasourceEditDialog.tsx`。
  - **★ 兼容策略（不加会加出问题）**：① 后端 update 只校验 **patch 传入的字段**，不按合并后的生效值判范围——否则库里存着旧版放行的 5000 时，用户只想改「同名策略」也被拦住；② 前端 `validateChunkFields` 新增第三参 `base`，值未改动时跳过范围校验；③ `chunker.ts` **故意不加上限硬抛**（只留 `<=0`）——`group-index.json.source.chunkSize` 可能是历史超界值，重建/编辑发布复用它重新切分，硬抛会让老 scope 再也跑不起来。
  - **交互口径沿用既有设计**：按钮**不置灰**。`runBlockedReason` 加「切分参数不合法：…」，点「开始导入」自动展开高级卡片 + `scrollIntoView` + `ki-attention` 脉冲（与「未确认 Scope / 未选文件」同一机制）。
  - **验证**：后端 `npm run build` exit 0 · `chunker.test.ts` 18/18 · `datasource-update.test.ts` 10/10 · `import-partial-success.test.ts` 4/4（其 `chunkSize: 60` 已改 100）· web `tsc` 0 · `npm test` **671/671** · `npm run build` ✓ · CLI 实测 `--chunk-size 99999` 先于目录检查报错、`1000` 正常放行 · 真机走查 **28/28 + 20/20**（`temp/verify-chunk-params-ui.cjs`、`temp/verify-chunk-params-ds-dialog.cjs`）。
  - **★ 走查脚本坑**：本机只装了 `chromium_headless_shell-1208`，`/tmp/pw` 的 playwright-core 1.64 要 1248 → 必须显式传 `executablePath`；`DatasourceEditDialog` 有改动时 Escape 先弹「放弃」确认（非直接关），断言前要先点「放弃」。
  - **质疑审查（`review/challenge-report-chunk-params.md`）追加两项**：① **存量超界值「放行但看不见」已修** —— 数据源编辑弹窗对未改动的超界值放行（否则改不动其它字段），但提示区仍显示常规口径「100–4000」，输入框里却是 6000，用户会以为正常。新增 `chunkRangeNotice()`（`web/src/lib/datasourceEdit.ts`）追加 warn 语气软提示「沿用着超出范围的历史值：段长 6000（应 100–4000）；不影响保存其它项，建议一并改到 500–2000」，硬拦仍由 `validateChunkFields` 负责。验证：web 单测 **675/675**（+4 条）· 真机走查 **13/13**（临时把 `verify-compare2` 置 6000/200，走查后已恢复 `null`；关键断言「只改同名策略 → 保存可点」）。② **「重试未完成」回落历史参数保持 fail-loud 不钳制**（用户已拍板）—— 钳制会让重试悄悄改变切分口径（docId 变化、部分文档静默重建），比一次可读的失败更危险。
  - **auto-review 复审追加 3 处修补**：① `DatasourceEditDialog` 新增的软提示 `<p>` 被 `.ki-ds-edit__control .ki-form-hint { margin: 0 }` 抹平间距 → 补 `style={{ marginTop: 2 }}`；② 两处输入框补 `aria-invalid`（红框此前只在视觉层），且**只在真正非法时输出属性**（不要写成 `aria-invalid="false"`，与 `ImportPage` 的 `|| undefined` 口径保持一致）；③ `datasource.ts` 关系校验的字面量 `150/1000` → `DEFAULT_CHUNK_OVERLAP/DEFAULT_CHUNK_SIZE`。复验：走查 **30/30**（导入页）+ **22/22**（编辑弹窗）+ **13/13**（软提示）· web `675/675` · 16 个 datasource 测试文件 0 失败。
  - **auto-review 第 3 轮**：① 文档只给 `--chunk-size` 标了范围、`--chunk-overlap` 漏了 → `docs/import.md` / `cli.md` / `build-kb.md` 三处补齐「0–500，且须小于段长」；② CLI 传 `--chunk-size abc` 会拼出「段长必须为正整数（当前 NaN）」→ 非有限数改走「必须是数字（收到非数字输入）」（`validateChunkParams`）；③ 「点开始导入自动定位」此前只断言 class 挂载 → 补断言 computed `animationName === 'ki-attention-pulse'`（`.ki-adv-card` 带 `overflow:hidden`，需确认动画真在跑，实测 1.3s / radius 10px 无跳变）。复验：chunker **19/19** · 16 个 datasource 文件 0 失败 · `import-partial-success` 4/4 · web `675/675` · 走查 **31/31**。
  - **★ 全量测试基线噪声**：`npm run test:all` 报 27 个失败，逐个复核**均非本次引入**——`error-handling` / `group-create` / `import-preflight` 单独跑全绿（并发争抢），`memory-id-map` 因引用**已被其他会话删除**的 `src/lib/diff.js` 直接 MODULE_NOT_FOUND，`import-export` 断在 suffix 命名（他人未提交改动）。工作区当前有多个会话并行改动，**不能拿全量结果当回归证据**。

- [2026-10-30] **数据源：新建 Scope 可设只读 + 行内「编辑」同步参数与定时**（未提交；`web/dist` 已重建；**7423 主服务仍是旧后端，重启后才生效**）：按 `product-manager` M1 报告确认后实施（用户调整：只读用**开关**、落点 Group 编辑态**只读**、定时区含**启用开关**）。
  - **后端**：`DataSourceRecord.revision`（配置修订号，仅登记/编辑 +1；同步与定时保存不动它）+ `updateDataSourceConfig`（`POST /api/datasource/update`，scope 写锁、`baseRevision` 不符 409 `DATASOURCE_STALE`、运行中 `SCOPE_OPERATION_BUSY`）+ `add-remote` 接受 `readonly`（**登记成功后**写 `config.scopeReadonly`，失败回 `result.readonlyWarning`，不回滚登记）+ list 下发 `capabilities` + `datasource-update` 进 `EXEMPT_OPS`。
  - **前端**：`DatasourceEditDialog`（三段：基本信息只读 / 同步参数 / 定时同步）；从 `DatasourceScheduleDialog` 抽出 `DatasourceScheduleFields`（含「自动同步」开关，两处复用）；行内「编辑」先拉详情再开弹窗；添加弹窗**新建模式**加「创建为只读库」开关，已有模式只显示只读状态；单按钮保存（配置→定时，分项失败提示），可选「保存后立即全量同步」（仅配置有变更时可勾）。
  - **列宽**：`15/9.5/16/14.5/16/8/6/15`（**行内「定时」并入「编辑」后**操作列回到 15%：三个按钮 ≈156px，与改版前同档）；≤1399 固定 186px。
  - **同日调整（用户要求）**：**删除行内「定时」按钮**，定时设置统一走「编辑」弹窗；列表顶部说明与详情注释同步改「行内『编辑』中按源开启」；`missing`（目录不可读）行的「定时」入口保留——它没有可编辑的数据源记录，只能改计划。
  - **落点**：`src/lib/{datasource,datasource-types,task-registry,scope-policy}.ts` · `src/lib/mcp-http-api.ts` · `web/src/lib/datasourceEdit.ts` · `web/src/components/{DatasourceEditDialog,DatasourceScheduleFields,DatasourceScheduleDialog}.tsx` · `DataSourcePage.tsx` · `httpApi.ts` / `tasksApi.ts` · `ki.css`。
  - **验证**：后端 tsc 0 · 新测 `datasource-update` **8/8** · `scope-readonly` **7/7** · 定时保存回归 **7/7**；web tsc 0 · `npm test` **669/669** · build ✓ · 隔离 daemon 真机 **45/45**（`temp/verify-datasource-edit-readonly.cjs`：7 档视口按钮组/单行、旧 daemon 降级、只读开关+真实添加落盘、编辑五字段+revision、定时开关、关闭后焦点归还、375×600 两个弹窗可滚动）。
  - **★ 可复用坑①（`.ki-dialog--form` 全局无 limiter）**：添加弹窗新增只读行后 375×600 顶端 -61、提交按钮不可达；已给 `.ki-ds-add` 单独 `max-height + body 滚动`（与 `.ki-ds-sched-dialog` / `.ki-ds-edit` 同口径），**全局规则仍未动**（其它表单弹窗仍有同一风险）。
  - **★ 可复用坑②（走查环境要隔离 clone 根）**：托管 clone 默认在 `~/.ki/datasources`，跨环境残留同 scope 的 repo ⇒ 再次添加报 `CLONE_TARGET_EXISTS`；隔离 daemon 用 `KI_DATASOURCE_CLONE_ROOT` 指到临时目录。
  - **★ 并发会话改动（非本次）**：`datasourceEdit.ts` / `DatasourceEditDialog.tsx` 另被补了切分上下限（段长 100–4000、重叠 ≤500）与差异感知校验；已随本次构建验证（web 669/669 + 真机 45/45），未改动其逻辑。
  - **待拍板**：① 7423 主服务需重启才生效（旧后端下编辑/只读入口自动隐藏，不会报错）；② CLI 仍无 `ki datasource update` / `add --readonly`（本期只做 Web）。
- [2026-10-30] **`ki config init` 默认 Embedding 切到 DashScope 兼容端点**（未提交）：模板与运行时内置默认同源改为 `provider: dashscope` / `baseURL: https://maas.qianwenaiapi.com/compatible-mode/v1` / `model: qwen3.7-text-embedding-flash` / `dimension: 1024`；密钥示例统一 `${DASHSCOPE_API_KEY}`，模板、init 输出与 4 份文档均标注获取地址 `https://platform.qianwenai.com/home/api-keys`。
  - **落点**：`src/config.ts`（模板 + init message）· `src/lib/config.ts:265`（`DEFAULT_EMBEDDING` + provider 注释）· `test/config-doctor.test.ts`（默认合并 2 处 + 模板断言）· `README.md` · `docs/configuration.md`（默认表 + 2 处示例 + 安全提示）· `docs/cli.md`（init 输出 / YAML 示例 / 字段表 / apiKey 说明）· `docs/build-kb.md`。
  - **口径**：只影响新生成的配置与无配置运行时的兜底值；已存在的 `config.yaml` 不受影响。**存量 4096 维库需显式保留 `dimension: 4096` 或重建向量**（已写入文档）。`llm` 示例与 `zvec-engine` provider 内部兜底默认未改（后者生产路径不触发）。
  - **验证**：`ki config init --dir /tmp/... --force` 生成物逐项匹配 + init message 含密钥地址 · `npm run test:config-doctor` **59/59** · `npm run build` **exit 0** · 真实配置 `ki doctor` **12/12**（URL 可达、密钥有效、维度 1024 匹配、batchSize 25 被接受）。
  - **★ 注意**：工作区存在**其他会话的并行未提交改动**（`datasource-update` / `readonlyWarning` 等 5 文件），不属于本次改动，勿一并提交。
- [2026-10-30] **总览新增「定时同步」统计卡**（未提交；`web/dist` 已重建，7423 生效）：按 `product-manager` M1 流程出报告并确认后实施。
  - **口径**：已开启定时的**数据源数**（`sources[].schedule.enabled`），复用 `useDataSourceList`，0 新请求 / 0 后端改动；`missing`/`corrupt` 不计入（只进 tooltip）。
  - **副行单条**：调度器停用 > 连续失败(≥3，与数据源页「定时⚠」同阈值) > 无待执行 > 未开启；旧 daemon / 接口失败 / 首屏加载显示 `—`（失败态副行「数据源读取失败」+ title 带原因），**不得显示 0**。按用户要求**正常态不显示副行、卡片不可点击**（不展示下次运行时间，口径保留在 title）。
  - **布局**：`.ki-stats--overview` ≥1025 五等分；≤1024 第 5 张 `grid-column: span 2`；≤640 复位 `auto`（修饰类限定，避免污染「当前知识库」卡内的 `.ki-stats--pair`）。
  - **落点**：`web/src/lib/datasourceSchedule.ts`（`summarizeSchedules` / `scheduleSummaryView` / `SCHEDULE_FAILURE_WARN`）· `DashboardPage.tsx` · `ki.css` · `web/test/datasource-schedule-summary.test.mjs`（9 项）。
  - **验证**：web `tsc` 0 · `npm test` **662/662** · `npm run build` ✓ · 真机 **87/87**（`temp/verify-dashboard-schedule-card.cjs`：真实数据 1/5、正常态无副行、非链接且点击不跳转、10 档视口 1440→375 的五/两/单列与跨列、等高、无溢出 + 6 种状态 + 4 档视口 × 5 种长文案不折行 + 无 JS 错误）。
  - **★ 可复用坑①（五列单卡内宽仅 108px）**：12px 中文 ≤8 字才放得下 —— 「服务端未上报定时计划」(10 字，需 120px) 在 1025~1090 会折成两行并把整行卡撑高；改为「未上报定时计划」(84px)，完整说明进 title。
  - **★ 可复用坑②（数中文行数别用 Range）**：`Range.getClientRects().length` 在本页返回 4（同一行被拆成多个 rect），不能判折行；用 nowrap 探针量「自然宽 vs clientWidth」才可靠。
  - **遗留**：无（不展示下次运行时间后，原「超期未跑仍显示下次时间」问题自然消失）。
- [2026-10-30] **任务列表两项调整：去掉任务 ID、结果摘要与「新增文档 N 篇」横排**（未提交；`web/dist` 已重建，7423 生效）：先按用户要求把新建文档数加在摘要下方，随后用户改为「横排 + 任务列去掉 ID」。
  - **数据口径**：`task.result.createdTotal`（`create` + `suffix`，覆盖与「内容未变」不计；不受 `created` 明细截断影响）；缺失时退回 `created.length`。共用 `taskDetailModel.taskCreatedLine`（与详情「新增的文档 N 篇」同口径），`buildTaskListRow` 直接拼进 `resultSummary`（`成功 X · 跳过 Y · 未完成 Z · 新增文档 N 篇`）。
  - **任务列去 ID**：删掉 `<code>#shortId</code>`，`TaskListRowView` 随之去掉 `id`/`shortId`（完整 ID 仍在详情抽屉），顺带删掉 `.ki-task-table__task code` 与 `.ki-task-table__created` 两条死规则。
  - **★ 不显示的场景**：旧记录 / 旧 daemon 无 `created`+`createdTotal` ⇒ 摘要保持原文（不能显示成「0 篇」）；运行中无结果快照同理；新增 0 照实显示。
  - **列宽**（`table-layout: fixed` 下必须给宽，否则横排必折/必省略）：基础 `9/15/14/10/29/14/9`；≤1199 结果 35%（原 33% 会让 961 视口差 6px）、开始时间 `118px → 132px`。实测摘要自然宽 **223px**、开始时间 **108px**，1200~1300 视口原 12% 会把 `10月30日 10:55` 裁掉 4~16px（**既有缺陷，本轮顺手修**）。
  - **≤880 隐藏结果列**：761~845 视口表宽仅 655~734px，摘要列最多只有 205px，省略号会吃掉「新增文档 N 篇」。改为 ≤880 复用「任务列回退行」承载摘要（与 ≤760 同一机制），实测 761~880 回退行 0 截断。
  - **窄屏时间列（本轮一并修）**：≤760 开始时间列只有 96px，`10月30日 10:55` 自然宽 108px，`nowrap` 会溢出 **24px** 压到「持续时间」上（600/700 实测）。改为 `@media (max-width:760) .ki-task-table__time { white-space: normal }` 折成「10月30日」+「10:55」两行（行高本就由任务列撑开），顺带删掉失效的 `.ki-task-table__time small { display:none }`。
  - **验证**：web `tsc` 0 · `npm test` **653/653** · `npm run build` ✓ · 真机走查 **46/46**（`temp/verify-task-columns-nowrap.cjs`：21 档视口 1920→600 逐档「摘要/开始时间/回退行不截断」+ 760/700/600/414 四档「时间两行且不压持续时间」+ 无 JS 错误）。
  - **审查**：`review/code-review-task-list-columns.md`（A 8.6，0 阻塞；审查中发现并修掉 761~845 的截断回归）+ `review/challenge-report-task-list-columns.md`（0 高风险，🟡 若干）。
  - **遗留（未修，待拍板）**：① 大数字（`createdTotal` 4~6 位）在 881~1199 仍会截断（961 视口 6 位数裁 47px，`title` 有全量）——接受 / 允许换行 / 窄屏短文案三选一；② ≤880 回退行无 `resultTone` 色，失败任务的摘要在此区间变灰（≤760 一直是如此，本次扩大 120px）；③ 375 视口任务列只剩 **23px**（82+96+68 固定列吃掉表宽 269），需改窄屏结构。

- [2026-10-30] **docs/ 去开发叙事：设计稿迁出、两篇实现说明书合并后删除、散点删减**（未提交）：用户指出 `docs/` 里混进了大量设计/开发描写（核心概念与架构说明除外）。
  - **迁出**：`docs/ui-design/{resources-page,datasource-remove-dialog}.md` → `.plans/2026-10-27-resources-page-v2/design.md`、`.plans/2026-10-29-datasource-remove-dialog-restyle/design.md`，`docs/ui-design/` 删除；同步改 3 处代码注释（`web/src/router/routes.tsx:30`、`ResourcesPage.tsx:4`、`DataSourcePage.tsx:967`）与 3 份 plan/checklist 的 `related`。
  - **合并后删除**：`tags-design.md`(226 行) / `vector-engine-mem.md`(257 行) 只留核心概念，压成 `architecture.md` 的「向量层（zvec）」「三层标签」两节（各 ~10 行）；删掉逐文件模块表、`ZvecEngine` API 代码、旧 mem CLI 压测对比。同步修 `docs/README.md`、根 `README.md`、`configuration.md`、`query-kb.md`、`mcp-http.md` 的 5 处链接。
  - **就地删减**：`architecture.md` 去掉「v3 迁移 / 第二轮审查 P0 / 死字段清理」四段变更史与 `hot_relations` JSON 样例，保留分片布局、组键不变量、分区只做展示口径三条；`error-handling.md` 去掉「已知边界」NaN/`|| 0` 分析，`*.ts` 模块名改命令名（`ki group list` / `ki sync-relation` / `ki get-module-info`）；`markdown-multilang.md` 删「维护者：实现在哪」整节；`mcp-http.md` / `cli.md` / `configuration.md` / `group.md` / `import.md` 去掉日期标注、`REQ-` 编号、实现文件名与设计理由句。
  - **验证**：`docs/` 相对 md 链接 **0 断链**；`tags-design|vector-engine-mem|ui-design` 在 `docs/`、`web/`、根 `README.md` 下 0 残留（`archive.md`、`docs/archive/`、`.plans/` 历史记录按原样保留）。文档总量 6195 → 5239 行（-15%）。
  - **★ 未改（需拍板）**：`ui-designer` skill 的默认落盘路径仍是 `docs/ui-design/{slug}.md`，再跑该 skill 会把目录重新建出来 —— 要彻底堵住需改 skill 侧默认路径。
- [2026-10-29] **数据源「移除」确认弹窗改版（未提交；`web/dist` 已重建，7423 生效）**：用户截图反馈"单调" → PM 走查定位三处根因（无危险身份 / 5 行平铺无分组 / 黄块塞两件相反语义）→ `ui-designer` 出方案 + 静态 demo → 用户确认 → `plan-track` 落地。
  - **落地**：`DataSourcePage.tsx:966-1104`（三卡：登记 / 影响 / 附加操作；`✓ 保留` 与 `! 丢失` 分语气；底栏左侧提示随勾选切 danger 语气；损坏分支独立文案组）· `ki.css:5519-5653`（`.ki-ds-remove*` 全新，宽度 640→560，danger 顶条 3px）；class 由 `ki-dialog ki-dialog--form` 改为 `ki-dialog ki-ds-remove`。
  - **验证**：tsc 0 · 单测 **649/649** · build ✓ · 真机 **28/28**（含 route 拦 409 验失败态、Escape、添加弹窗 640/none 未被波及）· 损坏分支 **11/11**（route 伪造 corrupt，不碰磁盘）。
  - **★ 可复用坑①（媒体查询抹掉基础宽度 / 限高）**：基础规则 `width: min(560px, calc(100vw - 24px))` 被 `≤640` 里的 `width: 100%` 覆盖 → 375 下弹窗左右贴边；窄屏只该改内距与堆叠，不要重写宽度。同理 `max-height: 100%` 在父级高度 auto 时解析成 `none`，会直接抹掉 `calc(100vh - 24px)` 限高。
  - **★ 可复用坑②（深色下 `color-mix` 混色失效）**：`color-mix(in srgb, var(--ki-color-success) 10%, var(--ki-color-surface))` 在深色下 = `rgb(35,48,41)`，卡底 `rgb(33,39,36)`，Δrgb(2,9,5) → 底色语义整个丢失。浅色 10% 够用，深色需 18~22%（待办）。
  - **★ 既有缺陷（未修，待拍板）**：深色 `.ki-btn--danger`（`#d98a85` + `#fff`）对比 ≈ **2.65:1**，低于 AA 3:1；改版后这颗"点完不可撤销"的按钮成了弹窗最扎眼的短板。
  - 方案 `.plans/2026-10-29-datasource-remove-dialog-restyle/design.md`（§11 登记 3 项落地后待办；原 `docs/ui-design/datasource-remove-dialog.md`）· demo `demo/datasource-remove/index.html` · 台账 `.plans/2026-10-29-datasource-remove-dialog-restyle/`（checklist 22/22）· 审查 `review/code-review-remove-dialog.md`（A 9.2）+ `review/challenge-report-remove-dialog.md`（0 高风险阻塞）。
- [2026-10-29] **「切分参数」补说明文案（未提交；`web/dist` 已重建，7423 生效）**：用户反馈两处只有 `1000 / 150` 两个数字，看不出含义。先出 ASCII 现状/预期图并取得确认再改。
  - **数据源详情「同步参数」**：`dataSourceDetailModel.ts` 的 `切分参数` 行加 `hint`（`DetailParts` 渲染成值下方 11px 小字），文案带**实际生效**数值 —— `每段目标 1000 字符；相邻两段重叠 150 字符，避免跨段语义被切断`（跟随 `lastSync.params`，不写死）。1440 / 70vw 抽屉下 399px 单行。
  - **上传导入页「切分参数」卡展开体**：两个输入框各加 `.ki-form-hint`（`每段目标字符数（100–4000）；越小越精准、上下文越碎，越大反之` / `相邻两段重复的字符数（0–500），避免关键句被切断；需小于段长`），底部「切分规则」行保留；折叠态整卡仍 48px、与「向量化」同高（只比 `.ki-adv-card__head` 的 46px 会误判，要比整卡含描边）。
  - 语义依据 `src/lib/chunker.ts`：chunkSize 是**目标长度**（切点向后 50 字符内优先落 `\n\n → \n → 。 → ；`，找不到才硬切），所以文案用「目标」不用「最多」。
  - **验证**：web `tsc` 0 · `npm test` 649/649 · `npm run build` ✓ · 真机走查 23/23（`temp/verify-chunk-param-hints.cjs`，截图 `temp/shots/chunk-hints-*`）。
  - **★ 走查脚本坑（必记）**：`waitUntil:'networkidle'` 在本应用**必然挂死** —— 1s 级 healthz / 任务轮询让网络永不 idle，导航一直等到 30s 默认超时。统一 `domcontentloaded` + 等具体选择器；并加整体 watchdog（`KI_VERIFY_TIMEOUT_MS`，默认 120s）+ 导航 15s / 元素 8s + shell `timeout`。
  - **★ 顺带查出的既存缺陷（未修，待拍板）**：`.ki-detail { width: clamp(520px, 70vw, 100vw) }` 的 **min 520px 大于 100vw**，375 视口下抽屉实际 520px、右侧被裁 145px（`.ki-drawer` 有 `@media ≤960 → 100vw` 兜底，`.ki-detail` 没有）。建议 `max-width: 100vw`；并让 ≤640 的 `.ki-detail-params` 单列，否则窄屏下这条说明折成 5 行。
- [2026-10-29] **数据源「定时」徽标换行 + 定时同步弹窗改版（未提交；`web/dist` 已重建，7423 生效）**：用户提的两点界面问题，先出 ASCII 图 + 静态 demo 确认（`demo/datasource-schedule/index.html`，含现状/新版双版本对比与「显示可点区域」开关），再落地。
  - **列表徽标**：根因是 `.ki-ds-table` 为 `table-layout: fixed` + 第 2 列死锁 `6%`（~82px，扣 padding 后仅 58px），`目录`+`定时` 需 ~78px 只能折行。改 `th:nth-child(2)` 6% → **9.5%**，`td.ki-ds-col--type` 加 `white-space: nowrap` 兜底，`.ki-ds-sched-badge` padding `0 6` → `0 5`。实测 8.5% 在「Git + 定时⚠」最宽组合仍折行，9% 在 1400 视口贴边，故取 9.5%。
  - **列宽重排（最终）**：`15 / 9.5 / 18.5 / 15 / 16 / 9 / 6 / 11`（数据源 / 类型 / 源目录 / 落点 / 上次同步 / 状态 / 耗时 / **操作**）。操作列 9% → **11%**：`同步 + 定时` 实测 52 + 6 + 46 = **104px**，9% 在内容区 ≤1500px 时只剩 95~99px 必折两行（1400~1500 笔记本视口最常见）；11% 在 1170px 表格下留 105px，是能并排的最小档。≤1399 断点里该列固定宽 `96px → 130px`（此断点已隐藏 4 列，空间充裕）。源目录 24% → 18.5% 是本次代价：1400 视口下长路径会截断（有 title tooltip）。
  - **弹窗**：模式 / 重复的原生 radio、checkbox → `.ki-ds-sched-seg` 分段控件（热区 51×18 → 96×34，用 `aria-pressed`，与全站 `.ki-segmented` 口径一致，不用 `role=radio` 以免还要手写方向键）；设置项包 `.ki-ds-sched-panel` 浅底卡片；元信息单块两行 → `.ki-ds-sched-meta__card` 两列卡片；弹窗 520 → 560；间隔 96/96 → 120/110、时间 210 → 250；日历按钮 `::-webkit-calendar-picker-indicator` 补 6px padding。校验提示从「切进去就红字」改为灰字引导（`ki-ds-sched-tip`，仅「填了但不合法」才转 `--warn`）。关闭态不再显示矛盾的「下次运行」卡片，改 `ki-ds-sched-offnote` 一句说明。
  - **★ 可复用坑（CSS 简写吃掉下拉箭头）**：卡片内给输入框换底色时写了 `background: var(--ki-color-surface)`，`background` 简写会重置 `background-image` —— `.ki-form-select` 的下拉箭头（data-uri SVG）直接被清掉，下拉框退化成纯文本框。必须用 `background-color`。demo 里踩过一次，已同步修正。
  - **★ 可复用坑（旧结构选择器污染新结构）**：`.ki-ds-sched-meta > div { display: flex; justify-content: space-between }` 是给老「单块两行」写的；改两列卡片后 label/value 被拉成左右并排、中文标签折行。改版时把该规则随旧结构一并删除，新结构只用 `__label` / `__value` 类。
  - **验证**：web `tsc --noEmit` 0 · `npm test` **631/631** · `npm run build` ✓ · 真机走查（`temp/verify-datasource-sched-ui.cjs` + `temp/verify-datasource-actions-layout.cjs`，截图在 `temp/demo-shots/real/`）：弹窗三态（周期 / 指定时间 / 关闭）尺寸与文案逐项断言；列表 1920/1700/1600/1500/1400/1300 六档逐一断言「类型徽标同行无溢出」+「同步/定时并排」，六档全绿；1300 宽类型列隐藏、compact 徽标回到 scope 名右侧。
  - **★ 走查口径**：`table-layout: fixed` 下想验证「两个元素是否同行」，比对 `getBoundingClientRect().top` 会因 `vertical-align` 不同（徽标 `middle` vs `baseline`）差几像素而误判 —— 判据要用「top 差 < 元素自身高度」，或直接比 `td` 内容高度。
  - **★ auto-review + challenger 发现并修复的阻塞项（矮视口弹窗不可用）**：本次新增「设置区卡片 + 两列元信息」让弹窗在 375 宽下从 549 → **638px**，而 `.ki-dialog--form` 是 `max-height: none; overflow: visible` —— 375×600 视口下弹窗顶端被顶出屏幕（`top:-19`）、不可滚动、「保存」按钮点不到（`saveBottom 603 > 600`）。归属 🟧 本次激活（旧规则 + 新高度）。修复：`.ki-ds-sched-dialog` 自身 `max-height: calc(100vh - 24px)` + `overflow: hidden`，`.ki-dialog__body` 设 `min-height: 0; overflow-y: auto` + 细滚动条；复验 375×600 / 375×667 / 414×736 / 768×600 / 1280×620 五档「保存」全部可见，body 可滚到底且不被底栏遮挡。**遗留**：`.ki-dialog--form` 的 `max-height: none; overflow: visible` 是全局规则，其它表单弹窗（添加 Git 数据源）仍暴露在同一约束下，未本次处理。
  - 另修：`demo/datasource-schedule/index.html` 分段控件原用 `role="radio"` + `aria-checked`，落地实现按全站 `.ki-segmented` 口径改为 `role="group"` + `aria-pressed` —— 两份产物 ARIA 与 CSS 选择器不一致（`[aria-checked="true"]` vs `[aria-pressed="true"]`），已把 demo 对齐。
- [2026-10-29] **数据源定时同步 REQ-20261029-001：主链路已实现 + 验证收口**（未提交；daemon 未重启，需重启才生效）：先复核需求/4 个子设计/质疑报告，把严重滞后的 `.plans/2026-10-29-datasource-scheduled-sync/plan.md` 按证据回写（此前 7 个工作项全「待办」），再补验证与缺口。
  - **实现（前序已落地）**：`datasource-schedule.ts`(278 纯函数) / `datasource-scheduler.ts`(354 按需 timer + 抖动 + 分段 arm + 进程锁 + `KI_DISABLE_DATASOURCE_SCHEDULER`) / `datasource-scheduled-run.ts`(187 scope→clone 锁序 + `runWithConfigSnapshot` + 先建任务) / `datasource-task.ts`；`POST /api/datasource/schedule`（`revision` 乐观锁 → 409）；`TaskSource` 加 `scheduler`；前端 `DatasourceScheduleDialog.tsx` + `datasourceSchedule.ts` + 列表徽标/第二行/详情只读。
  - **本轮补**：`docs/cli.md:140` 文案改「手动同步冷却 30 分钟」+ 新增「定时同步」语义段；`docs/mcp-http.md` 补 `POST /api/datasource/schedule` 与 list/detail 的 `schedule`/`schedulerDisabled`；`src/datasource.ts` 直连分支补 `resetScheduleFailures`（与 daemon 路径同口径）。
  - **验证**：后端新测 **38/38**（schedule 19 / scheduler 5 / scheduled-run 3 / save 6 / api 5）· 后端 tsc 仅 2 条既存基线 · `npm run build` ✓ · web tsc 0 · `npm test` **631/631**（603+新增 28）· 隔离 daemon e2e **33/33**（`temp/verify-datasource-scheduler-e2e.cjs`：0 计划无 timer / 落盘 / 真重启保留 / 到期触发 / 启动补跑去重 / `KI_DISABLE` 关闭 / 不删文档 / 失败清零）· 页面走查 **24/24**（`temp/verify-datasource-schedule-ui.cjs`：徽标+第二行、弹窗焦点 Esc 脏确认、保存后消失、详情只读无控件、待删除仍在、顶栏 1s 级、600px 无溢出、旧 daemon 降级）。
  - **★ 可复用坑（走查/重启类验证）**：`ki <cmd>` 的包装层 `bin/ki.mjs` 用 `spawn('npx', ['jiti', ...], { stdio: 'inherit' })` 起真实进程，**杀包装层杀不掉孙进程** —— 验证脚本里 kill 后「重启」会静默连回旧 daemon，全部断言变假绿。正确做法：直接 `spawn(node_modules/.bin/jiti, ['src/mcp-server.ts', ...], { detached: true })` + `process.kill(-pid)`，并用 `healthz.pid` 逐个断言「确实是新进程」。另：焦点归还走 `requestAnimationFrame`，断言焦点必须轮询等一帧。
  - **★ 认知修正**：L5「CLI 直连同步不清零失败计数」并不存在 —— `bin/ki.mjs` 恒设 `KI_DAEMON_CLIENT=1`，CLI 同步总经 daemon RPC 走 `daemon-dispatch` 分支（原本就清零）；直连分支只在程序内/测试走到。补丁保留作一致性。
  - **L6 已做（`ki datasource list` 只读展示计划）**：表格下方追加 `定时：` 脚注（模式 + 下次/待补跑/已执行 + 连续失败，`⚠` 标 warn；**无启用计划时不打印** ⇒ 默认输出逐字符不变），`--json` 每条 `sources[].schedule`（与 `/api/datasource/list` 同口径含 `nextRunAt`）；`scheduleListSummary()` 在 `datasource-schedule.ts`，`buildDataSourceList(entries, now)` 收 `schedules` 脚注条目。**刻意不进表格**：6 列已是窄终端上限，多一列会溢出，脚注还能写全「模式+下次+连续失败」。
  - **★ 顺带查出并修掉 P0（`computeNextRun` 缺持久锚点）**：从未同步过的数据源开周期定时后 `nextRunAt` 每次读取都等于 `now + interval`、`due` 恒 false ⇒ **永不触发**。修法：`DataSourceSchedule` 增 `enabledAt`（服务端在「关闭→开启」写、关闭清空、改间隔不重置；仅一次自动关闭时一并清空，维持 `enabled=false ⇒ enabledAt=null`），`base = max(lastSync.at, lastAutoAt, enabledAt)`。探针：修复前 `now=+0/+30/+60/+300min` 全 due=false；修复后 e2e 真机用例「从未同步 + 锚点 31 分钟前 → 触发并 succeeded」通过，且接口与 CLI 的 `nextRunAt` 逐毫秒一致（这正是发现缺陷的线索：两侧相差 1.1s）。
  - **auto-review（code-review + challenger）**：报告 `review/code-review.md`（✅ 可合入 / 0 阻塞 / A）+ `review/challenge-report-code.md`（0 高风险 / 4 中）；自审修掉 2 个 🟡 —— ① 脚注直出 `at` 原文带 `T`，加 `formatAbsolute` 统一为 `YYYY-MM-DD HH:mm`；② `enabledAt` 不变式只在写路径，`normalizeDataSourceSchedule` 读路径补清。
  - **challenger C1 → 用户拍板 D1-A 已落地**：三基准（`lastSync.at` / `lastAutoAt` / `enabledAt`）全缺失 = 锚点字段出现前的旧记录或从旧快照 `restore` 回来的记录 ⇒ `computeNextRun` 返回 `{ nextRunAt: now, due: true }`，**补跑一次**后 `lastAutoAt` 落定回到正常节奏（此前会永远 `due=false`）。`docs/cli.md` / `docs/mcp-http.md` 已写该语义；单测 32/32 + e2e 45/45（真机用例：清空 `enabledAt`+`lastSync` → 补跑 1 次 → healthz 仍 `armed`）。
  - **待拍板**：L7 任务页按来源筛选（影响面表口径，徽标与样式已就位）、L9 跳过（active-task/clone-busy）后没有退避 ⇒ 每 ≤10s 重试一次（`SKIP_RETRY_MS` 目前只用于并发守卫）、challenger C2/C3/C5（关闭态 CLI 不可见 / 改间隔沿用旧锚点会立刻补跑 / 锚点不可见）、以及**建议把 P0 修复拆成独立提交**。
  - 台账：`.plans/2026-10-29-datasource-scheduled-sync/{plan,checklist}.md`（checklist 20 项 + 追加 F1–F3 全 ✅）；需求目录 `CodeWikiHub/kisearch/requirements/2026-10-29-数据源定时同步/`。
- [2026-10-28] **后台任务页新增客户端分页**（未提交；`web/dist` 已重建，7423 生效）：`web/src/pages/TasksPage.tsx` 增 `PAGE_SIZE_DEFAULT=10` 与分页栏（复用 `.ki-ds-pager`，零新 CSS），切筛选重置页码、条目变少自动收回；`total` 大于已加载（最近 200 条）时追加「仅加载最近 200 条」提示。验证：`tsc` 0 · 单测 592/592 · `build` 0 · `temp/verify-tasks-pager.cjs` 20/20。已知（既有，未修）：600px 下任务表「开始时间/持续时间」两列文字重叠。
- [2026-10-28] **侧栏页脚 MCP 端口写死 7423 → 改为动态**（未提交；`web` 已重建）：新增 `web/src/lib/daemonPort.ts::resolveMcpPort`（回环取 `/healthz.port` → 地址栏 → 协议默认，非回环反之；判据用运行期 `isLoopbackHost`，**不用** `import.meta.env.DEV`，否则 preview 会显示 4173）；`httpApi.getHealthz` **刻意不走 `req()`**（避免污染总览的 `lastRttMs`）+ `hooks.useServerInfo`；`vite.config.ts` 补齐 `preview.proxy`（原先 preview 下 `/api`、`/mcp`、`/healthz` 全 404）。验证：`daemon-port.test.mjs` 12/12 · web 单测 585/585 · `temp/verify-mcp-port-dynamic.cjs` 13/13 · preview 复验 200。待办：「资源」页 `McpSection` 仍用 `location.origin` 推端点（与侧栏不一致）、页脚版本仍取前端包版本。
- [2026-10-27] **修复 wikiSync 写回 ENOTDIR（单文件导入把 `source.dir` 记成文件路径）**（未提交；daemon 已重启）：新增 `wiki-sync.ts::resolveWikiRootDir` —— `source` 块须为目录才算数，否则记 `sourceRejected` 并兜底 `wikiSync.sourceDir`，两者都无则 fail-loud 带原因；`group-delete.ts` / `delete-relation.ts` 的重复实现收敛到该解析器。★ `delete-relation` 仅在 `from === 'source'` 时才用 `sourcePath` 定位（退化到 wikiSync 时只认命名约定，否则会硬删同名无关文件）。验证：`test/wiki-root-resolve.test.ts` 13/13 · 隔离 e2e 7/7 · 真机 MCP 复测 ENOTDIR 消失。⚠️ 行为变更：`enabled !== false && sourceDir` 也算启用 → 升级后首次写入若 wiki 目录为空会触发 `backfillWiki` 全量补齐并覆盖同名文件。
- [2026-10-27] **修复 `ki search` 未传 tags 时 topk 被 `limit × tag 数` 放大**（未提交；daemon 已重启）：引擎 `MAX_TOPK=1000` 超限直接抛错，真实 scope（123 tags）下默认 `limit=10` 已失败。新增 `SEARCH_TOPK_MAX=1000`，fulltext / 显式 tags / 未传 tags 三条路径先收敛 topk（超出在 `skipped` 显式提示），结果去重后统一 `splice(limit)`。验证：`vector-cli-functions` 37/37 · 真实 daemon `limit=1/2/5/10/12/20` 条数恰好等于 limit。⚠️ 行为变更：未传 tags 时 `limit` = 整次检索总条数上限。跟进：总 limit + `TAG_PRIORITY` 会让自定义 tag 完全不可见（待产品确认）。
- [2026-10-27] **修复 `/chat` 顶栏标题贴边**（未提交；`web` 已重建）：`ki.css` 的 `.ki-content.ki-content--chatpage { padding: 0 }` 特异性压过基类，把 AppShell 渲染在同一个 `.ki-content-inner` 里的**全站顶栏**一起拉平。改为给 `.ki-content-inner > .ki-topbar` 补 `margin`（1440 `8px 16px 0`，≤640 `16px 16px 0`），盒几何与 `/search` 逐像素一致。验证：`temp/verify-chatpage-header-inset.cjs` 26/26 · web 单测 526/526。可复用口径：给某页「去内距」要把内距退回给不属于该页的子元素，不能整块清零。

---

## 更新日志

> 每次修改本文件后追加一条记录，保留最近 10 条。

| 日期 | 更新内容 |
|------|----------|
| 2026-11-16 | 近期工作新增「侧边栏重排」：行高 42→34 / 项间距 3→2 / 组间 0→20 / 组标题弱化 / 分组改 工作台·接入与运维·知识治理；记硬口径「组间留白必须大于组标题→首项，否则组标题被读作上一组末项的兄弟项」与副作用收益（总高 779→691，解 768 高窗口页脚沉底）；索引补 `决策记录/侧边栏与导航`；删最旧一条保持 10 条 |
| 2026-10-30 | 近期工作新增「数据源只读开关 + 编辑同步参数」：后端 revision / `update` / `readonly` / `capabilities`，前端编辑弹窗 + 共用定时表单 + 添加弹窗只读开关；行内「定时」随后并入「编辑」（操作列回 15%）；验证后端 8/8 + 7/7 + 7/7、web 669/669、隔离真机 45/45；记两条可复用结论（`.ki-dialog--form` 无 limiter、隔离测试须设 `KI_DATASOURCE_CLONE_ROOT`） |
| 2026-10-30 | 近期工作新增「`ki config init` 默认 Embedding 切 DashScope」：模板与运行时默认同改为 dashscope / `maas.qianwenaiapi.com/compatible-mode/v1` / qwen3.7-text-embedding-flash / 1024，密钥示例 `${DASHSCOPE_API_KEY}` 并标注获取地址；同步 README / configuration / cli / build-kb 与 3 处测试断言；验证 init 生成物、59/59、build exit 0、真实 doctor 12/12（维度 1024） |
| 2026-10-30 | 近期工作新增「总览定时同步卡」：复用 `sources[].schedule` 派生启用数（0 后端改动）、副行五态、四态兜底显示 `—`；`.ki-stats--overview` 五等分 + ≤1024 跨 2 列；记两条可复用结论（五列单卡内宽 108px ⇒ 12px 中文 ≤8 字；`Range.getClientRects()` 数中文行数不可靠，用 nowrap 探针） |
| 2026-10-30 | 近期工作新增「任务列表：去掉任务 ID + 结果摘要横排 + 窄屏时间列」：`resultSummary` 直接拼 `· 新增文档 N 篇`、`TaskListRowView` 删除 `id`/`shortId`、列宽改 `9/15/14/10/29/14/9`（≤1199 结果 35% / 开始时间 132px，修掉 1200~1300 裁字）、≤880 隐藏结果列改由任务列回退行承载（修掉 761~845 摘要被省略）、≤760 时间折两行（修掉 24px 压到「持续时间」）；auto-review + challenger 后 tsc 0 / 653 单测 / build ✓ / 真机 46 项全绿，遗留大数字截断、≤880 失败行无色、375 任务列 23px |
| 2026-10-30 | 近期工作新增「docs/ 去开发叙事」：`docs/ui-design/` 两份设计稿迁入各自 `.plans/<任务>/design.md` 并删目录（改 3 处代码注释）、`tags-design.md` / `vector-engine-mem.md` 核心概念并入 `architecture.md` 后删除（5 处链接同步修）、`architecture` / `error-handling` / `markdown-multilang` / `mcp-http` / `cli` / `configuration` / `group` / `import` 就地删减变更史与内部编号；记一条待拍板（`ui-designer` skill 默认落盘仍在 `docs/ui-design/`）；另把「关系评分 NaN（useCount 缺失）」「冷热分区上限为负数抛 RangeError」两个缓存损坏类缺陷沉淀进 ki `错误库/关系与索引管理`，并在待决登记修法 A/B |
| 2026-10-29 | 近期工作新增「移除数据源确认弹窗改版」：PM 走查 → ui-designer 方案 + demo → plan-track 落地；三卡分组 + danger 顶条 + 底栏不可撤销提示；记 3 条可复用结论（媒体查询 `width:100%` 抹掉 `calc(100vw-24px)` 导致窄屏贴边、`.ki-dialog--form` 的 `max-height:none` 会让矮视口点不到按钮、深色下 `color-mix(success 10%, surface)` 与卡底仅差 Δrgb(2,9,5)） |
| 2026-10-29 | 近期工作新增「切分参数补说明文案」：数据源详情行加 `hint`（带实际数值）、导入页两个输入框各加 `.ki-form-hint`；记两条可复用结论 —— Playwright `networkidle` 因 1s 轮询必然挂死（改 domcontentloaded + watchdog）、`.ki-detail` 的 `clamp(520px, 70vw, 100vw)` min 大于 100vw 导致 375 视口裁切（既存缺陷，待拍板） |
| 2026-10-29 | 近期工作新增「数据源定时徽标换行 + 定时同步弹窗改版」：列宽重排为 `15/9.5/18.5/15/16/9/6/11` 让「定时」与「目录/Git」同行且「同步/定时」按钮并排、弹窗原生 radio/checkbox → 分段控件 + 设置区卡片 + 两列元信息；记两个可复用 CSS 坑（`background` 简写清掉 `.ki-form-select` 箭头、旧 `> div` flex 规则污染新卡片结构）；附静态 demo `demo/datasource-schedule/index.html` 与真机六档宽度走查证据 |
| 2026-10-29 | 近期工作新增「数据源定时同步 REQ-20261029-001 实现 + 验证收口」：含 `bin/ki.mjs` 包装层杀不掉孙进程导致「假重启」的验证坑、CLI 恒走 daemon RPC 的认知修正；后续追加 L6（`datasource list` 只读脚注 + `--json` schedule）与 P0 修复（`computeNextRun` 缺持久锚点 ⇒ 从未同步的源定时永不触发） |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **kisearch** (4167 symbols, 10592 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/kisearch/context` | Codebase overview, check index freshness |
| `gitnexus://repo/kisearch/clusters` | All functional areas |
| `gitnexus://repo/kisearch/processes` | All execution flows |
| `gitnexus://repo/kisearch/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
