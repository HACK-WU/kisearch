---
task: AI 对话配置层落地（提示词 / Skill 存储与注入 + 配置 UI）
status: 进行中
created: 2026-09-30
updated: 2026-09-30
related: docs/req-chat-mcp-tools-refactor.md（REQ-20260924-001）+ docs/ui-design/chat-tools-config.md + demo/chat-tools-config/index.html
---

# 执行计划：AI 对话配置层落地（批次 1）

## 目标
把「提示词 / Skill / 工具开关」从设计变成可用能力：能存、能读、能按配置注入到对话，
并在对话面板里提供一个两级配置层（列表 → 预览 → 编辑）；**未配置时行为与现在逐字一致**。

## 批次切分（本次只做批次 1）

| 批次 | 内容 | 状态 |
|---|---|---|
| **批次 1（本期）** | 配置存储 + API + 注入生效 + 配置层 UI | 进行中 |
| 批次 2 | MCP 工具暴露给 AI（工具白名单 + scope 注入 + 移除内置 `kb_search`）+ 事件契约泛化 | 阻塞：待定 #2(暴露哪些工具) / #4(无工具时行为)；需先走 `design-craft` |
| 批次 3 | R12 工具调用展示（入参 / 响应 JSON + 展开） | 阻塞：待定 #9（落盘口径：仅生成中 / 落盘摘要 / 落盘完整） |

> 批次 1 不动事件契约、不碰 MCP、不删内置检索 —— 因此可独立验收、可随时停。

## 完成判据
- [ ] `npx jiti test/chat/prompt-config.test.ts` 全绿（新增用例）
- [ ] `npm run test:chat` 全绿（既有 9 文件不回归）
- [ ] 后端 `node_modules/.bin/tsc -p tsconfig.json --noEmit` 退出码 0
- [ ] `cd web && npm run typecheck` 退出码 0
- [ ] **兼容性**：单测断言「配置文件不存在时的注入结果」与改动前**逐字一致**
- [ ] `grep -c "PROMPT_CONFIG_INVALID" src/lib/chat/chat-contract.ts` = **0**（冻结契约未被改）
- [ ] `GET /api/chat/prompt-config` 返回默认值；`PUT` 后能读回

## 注意事项（执行护栏）
| # | 注意事项 | 来源 | 违反后果 |
|---|----------|------|----------|
| 1 | 不得修改 `src/lib/chat/chat-contract.ts`（骨架期冻结、一字不改）；本批新增的错误码先用 `chat-routes.ts` 内本地常量，并登记「待并入契约」 | 契约文件头部注释 | **P0：契约漂移** → 前端副本与 `contract-parity` 测试失准 |
| 2 | 不得删除 / 改写现有内置检索链路（`kb-search-tool.ts`、`retrieval-skill.ts`、`degradedPath`）；本批只做「追加配置」 | 用户要求「在原来的基础上添加功能」（UI 返工教训） | **P0：能力空窗 + 现有 e2e 全红** |
| 3 | 未配置时（文件不存在）注入结果必须与现在**逐字一致**；不得顺手调整既有 system 消息顺序 | 兼容性要求（既有 103 断言 + 真实对话行为） | **P0：静默改变线上行为** |
| 4 | 配置写入必须**原子写 + 保留原文件权限**（复用 `atomicWriteConfig` 范式） | 已知坑（并发 daemon 读到半截文件；配置可能含密钥） | **P0：配置损坏 / 权限泄露** |
| 5 | 长度上限必须在**服务端**强制（前端字数只是提示）；skill 名非空且唯一 | 需求负向需求（参数错误） | P1：超长内容拖垮上下文、名字冲突静默覆盖 |
| 6 | 工具白名单只接受**真实注册的 MCP 工具名**（14 个，见备注），未知名拒绝 | 代码直读 `src/lib/mcp-tools/*` | P1：拼错的名字静默失效 |

> 14 个真实工具名（读 6 / 写 6 / 删 2）：
> `ki_search` `ki_query_group` `ki_get_module_info` `ki_tag_list` `ki_scope_list` `ki_manage_index_list`
> ｜ `ki_store` `ki_bulk_store` `ki_sync_relation` `ki_bulk_sync_relation` `ki_edit_relation` `ki_manage_index_create`
> ｜ `ki_delete_relation` `ki_manage_index_delete`
> ⚠️ **demo 里只画了 5 个工具，需按这 14 个与三组口径修正**（UI 工作项内一并处理）。

## 工作项
| # | 工作项 | 状态 | 证据 | 备注 |
|---|--------|------|------|------|
| 1 | 配置数据模型 + 存储：`src/lib/chat/prompt-config.ts`（模型 / 默认值 / 读 / 写 / 校验 / 原子写） | 已完成 | 新增 `src/lib/chat/prompt-config.ts`（~330 行）+ `test/chat/prompt-config.test.ts` → **19 pass / 0 fail**；`tsc -p tsconfig.json --noEmit` exit 0；守 #1 → `grep -c PROMPT_CONFIG_INVALID src/lib/chat/chat-contract.ts` = **0**（契约未改）· 守 #2 → `git status src/lib/chat/retrieval/ chat-contract.ts chat-routes.ts` 干净（内置链路未碰）· 守 #3 → 单测「兼容性」组用 `buildSystemMessages` 逐字比对通过 · 守 #4 → 单测断言 0600 权限保留 · 守 #5 → 超长在 `savePromptConfig` 服务端拒绝 · 守 #6 → 未知工具名报错 | 落盘 `{chatDir}/prompt-config.json`；默认值复用既有 `RETRIEVAL_SKILL_PROMPT` 作内置 skill 文案 |
| 2 | 配置 API：`GET` / `PUT /api/chat/prompt-config` 挂进 `chat-routes.ts` | 待办 | - | GET 同时返回 defaults（供"恢复默认"）；错误码先本地常量（守 #1） |
| 3 | 注入生效：`buildSystemMessages` 接受配置，按序注入「内置 skill → 基础提示词 → 用户 skill → 会话 prompt」 | 待办 | - | 未配置时输出与现在逐字一致（守 #3） |
| 4 | 前端配置层：⚙ 入口 + 两级配置层（列表 → 预览 → 编辑）+ skill 增删 + 工具开关（**14 个真实工具 · 三组**） | 待办 | - | 结构对齐 `demo/chat-tools-config/index.html`；样式并入 `ki.css`（`ki-chat-cfg*`） |
| 5 | 回归：新增单测 + `test:chat` + 后端 tsc + 前端 typecheck | 待办 | - | - |

## 决策与偏差
| # | 事项 | 决策 / 偏差 | 原因 |
|---|------|------------|------|
| 1 | 存储位置 | `{chatDir}/prompt-config.json` | chatDir 派生自 dataDir（与 `kb/` 分离、测试可隔离）；根目录放文件不会与 `{scope}/` 目录冲突 |
| 2 | 作用域层级 | 本批**只做全局**；模型留 `scope` 字段但恒为 `"global"` | 待定 #5 未决；先做全局可独立验收，后续加 scope 级不破坏已落盘数据 |
| 3 | 新错误码 | 先用 `chat-routes.ts` 本地常量 `PROMPT_CONFIG_INVALID`，**不改契约文件** | 守 #1；并登记为「待并入契约」（批次 2 走 design 时一并处理） |
| 4 | 工具开关语义 | 本批**只存不生效**（存起来、UI 可配；真正生效在批次 2） | 批次 2 才暴露 MCP 工具；避免"开关看着生效其实没用"的误导 —— UI 上标注"批次 2 生效" |
| 5 | 默认基础提示词 | 默认 **空字符串**（不是 demo 里那句示例文案） | 现在没有这条配置 → 默认也**不能**多注入一段，否则破坏"未配置时逐字一致"（守 #3）。demo 里那句改为 UI 的 placeholder 示例 |
| 6 | 默认时间戳 | 内置项用固定常量 `1970-01-01T00:00:00.000Z`（不是 `new Date()`） | 让"默认配置"可比较：测试可断言、`deepEqual` 能过、后续"恢复默认"判定幂等 |

## 进度日志
- 2026-09-30 00:58 建档；批次切分与护栏已定；工具白名单按代码实读取准 14 个（demo 的 5 个属错漏，已记为工作项 4 的修正项）
- 2026-09-30 00:59 开工 工作项 1（配置模型与存储）
- 2026-09-30 01:05 **工作项 1 完成**：`prompt-config.ts` + 19 条单测全绿；`tsc` exit 0；`test:chat` 10 文件 **122 断言 0 失败**（原 103 + 新 19）。**下次从「工作项 2：配置 API」继续**（挂进 `chat-routes.ts`，错误码先用本地常量）
