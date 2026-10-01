---
task: 对话面板 demo→实现 整体修复（走查发现 #4~#9 清零）
status: 已完成
created: 2026-09-30
updated: 2026-09-30
related: .plans/2026-09-30-chat-tools-config/（批次 1 台账）+ demo/chat-tools-config/index.html + AGENTS.md 走查结论
---

# 执行计划：对话面板 demo→实现 整体修复

## 目标
真实应用（7433）对话面板与 demo 视觉/交互一致：composer 提示行不再显示"请输入内容"、
assistant 有头像与品牌色气泡、检索过程渲染为 demo 同款"工具时间线行 + 可展开卡片"、
配置层工具行带描述、消息入场动效生效。P2 遗留（#8 作用域下拉）有明确裁决留痕。

## 完成判据
- [x] playwright 实测：composer 空草稿提示行 = 「Enter 发送 · Shift+Enter 换行」（证据：wt_walk2 `OK W1`）
- [x] playwright 实测：assistant 消息含 `.ki-chat-avatar`，用户气泡为品牌色浅罩+右下收角（`OK W2 count=1` + D8 样式移植）
- [x] playwright 实测：检索过程为工具行（动作名 + `kb_search` 胶囊 + 状态），点击可展开卡片（入参 mode / 响应命中 / 错误），生成中与刷新回看同款（`OK W3` ×4 + live 诊断）
- [x] playwright 实测：配置层工具行带描述文案（`OK W4 count=14`）
- [x] playwright 实测：新消息入场动画存在（`OK W9 ki-msg-in`）
- [x] `cd web && npm run typecheck` exit 0；`npm run build` ✓ built in 566ms
- [x] 后端 `tsc -p tsconfig.json --noEmit` exit 0
- [x] `prompt-config.test.ts` **23 pass** + `prompt-config-routes.test.ts` **12 pass**（含 desc 全覆盖新断言）
- [x] 浏览器 console 无新增报错（`CONSOLE ERRORS: none`）

## 注意事项（执行护栏）
| # | 注意事项 | 来源 | 违反后果 |
|---|----------|------|----------|
| 1 | 不得修改 `src/lib/chat/chat-contract.ts`（冻结；决策 #13 是唯一已批例外，本任务不开新例外）；W4 只动 `prompt-config.ts` 的 `MCP_TOOL_GROUPS` 与前端类型副本 | 批次 1 护栏 #1 + 决策 #13 | **P0：契约漂移** → 前端副本与 parity 测试失准 |
| 2 | 时间线卡片只渲染**既有摘要字段**（name/mode/hits/durationMs/error）；不得把入参/响应正文 JSON 加进落盘或事件契约（完整 R12 归批次 3，待定 #9 未拍板） | 批次 1 决策 #13「落盘摘要」边界 | **P0：静默推翻用户未拍板的决策** |
| 3 | 不得破坏既有消息操作（复制/重新生成/中止/流式累积/折叠/配置层模态）；只新增渲染结构与字段 | 批次 1 护栏 #2 同款教训 | **P0：对话核心功能破坏** |
| 4 | 新样式只在 ki.css **D 段追加**，复用 `--ki-*` 令牌；不改既有规则语义（选择器修复除外） | demo 是 SSOT、ki.css 分段纪律 | P1：主题/风格漂移 |
| 5 | 每个工作项标「已完成」必须有 **build + playwright 实测截图**证据；静态读码不算 | plan-track 证据绑定 + 本任务前几轮"编译期看不见缺陷"教训 | **P0：未验证交付** |
| 6 | 不与批次 1 台账平行记账：#8 裁决引用批次 1 决策 #2，本台账只记引用行 | plan-track 原则 3 | P1：双源漂移 |

## 工作项
| # | 工作项 | 状态 | 证据 | 备注 |
|---|--------|------|------|------|
| 1 | W1 composer 提示行（#5）：空草稿时保留快捷键提示，仅"有内容且被阻塞"才显示阻塞原因（`ChatPanel.tsx` blocked 计算 + hint 行） | 已完成 | playwright 实测：hint = 「Enter 发送 · Shift+Enter 换行」且 placeholder 保留「请输入内容」（`/tmp/wt/pt_panel.png`）；守 #5 → 真机验证 | 走查认定"双输入框"错觉的真实来源 |
| 2 | W2 头像与气泡（#6）：`ChatPanel.tsx` assistant meta 补 `.ki-chat-avatar`（历史 + 流式两处）；ki.css 移植 demo D3 段为 D8（avatar/用户气泡品牌罩/msg-in 动画/行内 code） | 已完成 | playwright 实测：`.ki-chat-avatar` count=1、computed `animation-name: ki-msg-in`（W9 一并验证）；截图 `/tmp/wt/pt_panel.png` | D3 段 ki.css 原为 0 处（已核实），现 D8 移植 |
| 3 | W3 工具时间线卡片（#4）：ki.css 移植 demo A/B 段为 D9（`tl__stat/act/tool/--tool-fail` + `ki-chat-tool__*` + `ki-tool-in` keyframes + reduced-motion 扩展）；`ChatPanel.tsx` start/end 合并行（`buildTimeline`）+ `ToolRow`/`ToolCard`/`JsonCode`；`chatStore.ts`/`useChatStream.ts` step 透传 name/query/mode/hits/durationMs/error | 已完成 | **流式路径**：5s 时 3 条合并行「检索知识库 kb_search 失败」+ 展开卡显示入参/进行中（`/tmp/wt/pt_live_diag.png`）；**落盘路径**：刷新后行仍在、展开卡含「入参 mode hybrid / 错误 向量检索暂不可用」+ 可收起（`/tmp/wt/pt_timeline_card.png`）；console 无报错；守 #2 → 卡片只渲染摘要字段 | 只渲染摘要字段（守 #2）；行数为**合并后**口径（同会话 6 步 → 3 行） |
| 4 | W4 工具行描述（#7）：`prompt-config.ts` `McpToolGroup` 增 `descs`（14 工具短描述，文案对齐 demo）→ `toolGroups` 下发 → 前端类型副本（可选，兼容旧 daemon）+ `PromptConfigLayer.tsx` 渲染 `__tool-desc` + 路由测试断言全 14 非空 | 已完成 | API 实测 `descs.ki_search = "混合 / 字面检索知识库"`；UI 实测 `.ki-chat-cfg__tool-desc` count=14（`/tmp/wt/pt_cfg_desc.png`）；`prompt-config-routes.test.ts` 12 pass（含新断言）；守 #1 → 只动 `prompt-config.ts`，`chat-contract.ts` 未碰 | desc 属 UI 文案非工具契约；前端可选链防旧 daemon |
| 5 | W5 #8 作用域下拉裁决 | 取消 | 引用批次 1 台账决策 #2：「本批**只做全局**；模型留 `scope` 字段但恒为 `"global"`」→ 作用域下拉归批次 2（待定 #5 未拍板前加了就是假开关） | 走查 #8 就此闭环 |
| 6 | W6 全量回归：web typecheck/build + 后端 tsc + prompt-config 两测试 + playwright 全流程截图对照 demo + console 无报错 + 窄屏不溢出 | 已完成 | web `typecheck` exit 0 + `build` ✓；后端 `tsc` exit 0；可运行 7 测试文件 **81 断言 0 失败**（10+10+6+7+13+12+23，与批次 1 基线一致）；playwright 走查 11 项全 OK、`CONSOLE ERRORS: none`、窄屏 overflow=0px | 4 个 `.delivery/mocks` 依赖文件仍属批次 1 决策 #8 既有缺陷 |

## 决策与偏差
| # | 事项 | 决策 / 偏差 | 原因 |
|---|------|------------|------|
| 1 | 时间线卡片数据边界 | 展开卡片只展示 入参(mode) / 响应(hits·耗时) / 错误(error) 三段摘要，不画 demo 的完整 JSON | 待定 #9 只批了「落盘摘要」（批次 1 决策 #13）；完整 R12 归批次 3 |
| 2 | 流式 durationMs | 事件不带耗时的，前端按 start/end 时间戳本地计算；不带就不显示 | 不扩服务端事件（守 #1/#2） |
| 3 | 卡片「入参」query 只在**生成中**可见 | 流式事件带 query → 卡片显示；落盘摘要**不含 query**（批次 1 决策 #13 边界）→ 刷新后入参只剩 mode | 守 #2：不新增落盘字段；差异如实呈现 |
| 4 | 折叠标题步数改为**合并后**行数 | 「检索过程 · N 步」原按 start+end 各计 1 步（6 步）；现一次调用 = 一行（3 步），与 demo 行口径一致 | demo 是 SSOT；步数对不上行数会被当 bug |
| 5 | 前端 `PromptToolGroup.descs` 定为**可选** | 类型 `descs?` + 可选链渲染 | 用户可能在跑旧 daemon（响应无该字段），必填会在运行时炸 |

## 进度日志
- 2026-09-30 19:30 建档。事实核对完成：D3/D4 段在 ki.css 为 0 处；`MCP_TOOL_GROUPS` 无 desc；流式事件有 mode/hits/error；`ChatProgressStep` = {phase,name?,mode?,hits?,durationMs?,error?}。#8 按批次 1 决策 #2 归批次 2（W5 留痕）。**下次从 W1 开始逐项实施**
- 2026-09-30 20:10 W1~W4 全部实施并实测：ki.css 追加 D8/D9（+100 行）；ChatPanel 合并行 + ToolRow/ToolCard/JsonCode + 头像 ×2；chatStore/useChatStream step 透传摘要字段；prompt-config.ts descs 14 条 + 前端可选渲染 + 测试断言。回归：web typecheck/build ✓、后端 tsc ✓、81 断言 0 失败、playwright 走查 11 项全 OK、console 无报错、窄屏 0 溢出。7433 实例已重启加载新代码（nohup+setsid 脱离会话，pid 见 `ss -tlnp | grep 7433`）。W5 取消留痕（批次 1 决策 #2）。**任务主体完成 → 进入自评审（checklist 回填）→ auto-review**
- 2026-09-30 20:40 **自评审完成：20/20 通过**。评审期抓出并修复 1 项：F3 reduced-motion 块放在 D8/D9 之前被源序覆盖（媒体查询不加特异性）→ 移到两段之后 → 双向复验通过。E1 核验注意：`chat-contract.ts` 工作区 +28 行属批次 1 决策 #13（内容 + mtime 双重核对），本任务零触碰。**下一步：auto-review（Step 4 收尾链）**
