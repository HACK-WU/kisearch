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
- [x] `npx jiti test/chat/prompt-config.test.ts` → **19 pass**；`test/chat/prompt-config-routes.test.ts` → **12 pass**
- [ ] `npm run test:chat` 全绿（既有 9 文件不回归）— ⚠️ **部分不可达**：`acceptance-sr01` / `contract-sr01` / `data-flow` / `e2e-sr02-sources` 四个文件依赖**缺失的** `.delivery/mocks/mock-search.mjs` 而无法启动（既有环境缺陷，见决策 #8）；**可运行的 7 个文件 77 断言全绿**
- [x] 后端 `node_modules/.bin/tsc -p tsconfig.json --noEmit` 退出码 0（前置：`npm run build:zvec-engine`，见决策 #9）
- [x] `cd web && npm run typecheck` 退出码 0（工作项 4 落地后达成；`npm run build` 亦通过）
- [x] **兼容性**：单测断言「配置文件不存在时的注入结果」与改动前**逐字一致**（工作项 1 的「兼容性」组）
- [x] `grep -c "PROMPT_CONFIG_INVALID" src/lib/chat/chat-contract.ts` = **0**（冻结契约未被改；测试内自带该自检）
- [x] `GET /api/chat/prompt-config` 返回默认值；`PUT` 后能读回（路由级测试覆盖）

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
| 2 | 配置 API：`GET` / `PUT /api/chat/prompt-config` 挂进 `chat-routes.ts` | 已完成 | `chat-routes.ts` 新增 2 个 handler + 路由分派（+88 行）；新增 `test/chat/prompt-config-routes.test.ts` → **12 pass / 0 fail**；`node_modules/.bin/tsc -p tsconfig.json --noEmit` **exit 0**（前置 `npm run build:zvec-engine`）· 守 #1 → 测试内自检「`chat-contract.ts` 不含 `PROMPT_CONFIG_INVALID`」通过 · 守 #2 → 只新增不修改，可运行的 7 个既有 chat 测试文件 **77 断言全绿** · 守 #3 → `GET` 未配置时 `config === defaults` 且**不创建配置文件** · 守 #4 → 复用 `savePromptConfig`（原子写 + 保留权限，工作项 1 已测）· 守 #5 → `prompt` 4001 字 → 400 且**不落盘** · 守 #6 → 未知工具名 `ki_serach` → 400 + details | `GET` 一次返回 `config / defaults / limits / issue` 四块；`PUT` 为**整体替换**语义；错误码为本地常量 |
| 3 | 注入生效：`buildSystemMessages` 接受配置，按序注入「内置 skill → 基础提示词 → 用户 skill → 会话 prompt」 | 已完成 | `retrieval-skill.ts::buildSystemMessages` 增加第 2 参数（**默认值 = 既有单块** → 既有调用方零影响）；`tool-loop.ts`：`LoopRuntime.systemBlocks` + `resolveRuntime` 解析 + `buildUpstreamMessages(input, systemBlocks)` + 两处构造点（主流程/降级路径）；`prompt-config.test.ts` +4 断言（**含「未配置时与既有单参调用逐字一致」**）→ **23 pass / 0 fail**；`e2e-sr01-edit` **6 pass**（真实链路未破坏）；`tsc -p tsconfig.json --noEmit` exit 0 · 守 #2 → 内置检索链路只加参数未改写 · 守 #3 → 新用例逐字比对通过 | **未改冻结的 `ToolLoopInput` 签名**：配置块走内部 `LoopRuntime`（与其余运行期字段同款做法） |
| 4 | 前端配置层：⚙ 入口 + 两级配置层（列表 → 预览 → 编辑）+ skill 增删 + 工具开关（**14 个真实工具 · 三组**） | 已完成 | 新增 `web/src/chat/usePromptConfig.ts`（加载/草稿基线/保存/字段级错误）+ `PromptConfigLayer.tsx`（列表 + 工具三组 + 底栏保存 + 危险确认）+ `PromptConfigModal.tsx`（新增/编辑/提示词共用，`createPortal` 到 body）；改 `chatContract.ts`（+58 行类型副本）、`chatApi.ts`（`getPromptConfig`/`savePromptConfig` + `ChatApiError.details`）、`ChatPanel.tsx`（⚙ 入口 + 挂载）；`ki.css` 并入 demo 的配置层样式（C 段 2412-2629 + 用户补的 D5 段 2694-2756 + 精简 reduced-motion，`2319 → 2609` 行）；后端补 `toolGroups` 下发（+3 行 + 测试断言）。**判据**：`cd web && npm run typecheck` **exit 0**、`npm run build` **✓ built in 547ms**、后端 `tsc` exit 0、路由测试 **12 pass** · 守 #1 → 后端 `chat-contract.ts` **未动**（改的是前端类型副本，允许扩展） | 与 demo 现状对齐（含用户新增的 `__item-ic` / `__group-dot` / `__group-n` / `__modal-head` / `__modal-sub` / `__item-meta--mod`）；**工具开关仍标注「批次 2 生效」**（守决策 #4）。**真机走查已完成**（决策 #11）：14 工具三组 / 模态 fixed 居中（720×720 @1680×1000）/ 提示词 20 字保存并**读回落盘** / 新增 skill 落盘（`skill-munuld26`）/ 危险开关确认后落盘（`ki_store` 在开启列表）/ Esc 三级分层，截图存 `.pm-shots/e2e-01~06*.png`；期间抓出并修掉 2 个缺陷（svg 尺寸致横向溢出、确认卡 Esc 失效） |
| 5 | 回归：新增单测 + `test:chat` + 后端 tsc + 前端 typecheck | 已完成 | `prompt-config.test.ts` **23 pass** + `prompt-config-routes.test.ts` **12 pass**；`test:chat` 可运行的 **7 文件 81 断言 0 失败**（4 文件因缺失 `.delivery/mocks/` 无法启动，决策 #8）；后端 `tsc` **exit 0**；前端 `typecheck` **exit 0** + `build` 成功 | `test:chat` 的"全绿"受既有环境缺陷限制，已如实标注在完成判据第 2 条 |

## 决策与偏差
| # | 事项 | 决策 / 偏差 | 原因 |
|---|------|------------|------|
| 1 | 存储位置 | `{chatDir}/prompt-config.json` | chatDir 派生自 dataDir（与 `kb/` 分离、测试可隔离）；根目录放文件不会与 `{scope}/` 目录冲突 |
| 2 | 作用域层级 | 本批**只做全局**；模型留 `scope` 字段但恒为 `"global"` | 待定 #5 未决；先做全局可独立验收，后续加 scope 级不破坏已落盘数据 |
| 3 | 新错误码 | 先用 `chat-routes.ts` 本地常量 `PROMPT_CONFIG_INVALID`，**不改契约文件** | 守 #1；并登记为「待并入契约」（批次 2 走 design 时一并处理） |
| 4 | 工具开关语义 | 本批**只存不生效**（存起来、UI 可配；真正生效在批次 2） | 批次 2 才暴露 MCP 工具；避免"开关看着生效其实没用"的误导 —— UI 上标注"批次 2 生效" |
| 5 | 默认基础提示词 | 默认 **空字符串**（不是 demo 里那句示例文案） | 现在没有这条配置 → 默认也**不能**多注入一段，否则破坏"未配置时逐字一致"（守 #3）。demo 里那句改为 UI 的 placeholder 示例 |
| 6 | 默认时间戳 | 内置项用固定常量 `1970-01-01T00:00:00.000Z`（不是 `new Date()`） | 让"默认配置"可比较：测试可断言、`deepEqual` 能过、后续"恢复默认"判定幂等 |
| 7 | 保存时的时间戳口径 | `savePromptConfig` 给**所有** skill 打**同一次**保存时间（不只改动的那条） | 整体替换语义 = 一次保存动作，口径单一。**衍生约束**：前端「恢复默认」的判定须比较**内容**而非整对象（否则 `at` 必然不等）；路由测试已按此写。若将来要"精确到哪条改过"，需改为按内容 diff 决定 `at` |
| 8 | `.delivery/mocks/` 缺失 | 4 个既有 chat 测试文件（`acceptance-sr01` `contract-sr01` `data-flow` `e2e-sr02-sources`）**无法启动**（`Cannot find module '../../.delivery/mocks/mock-search.mjs'`） | **既有环境缺陷**（该目录不在仓库内），非本批引入。不影响本批正确性——可运行的 7 文件 77 断言全绿。**待用户确认**：`.delivery/` 是有意移除（交付物已归档）还是环境未就绪？ |
| 9 | 验证前置（tsc） | 跑 `tsc -p tsconfig.json --noEmit` 前须先 `npm run build:zvec-engine` | `src/lib/`（`fts-client` / `health-check` / `vector-client`）import 了 `dist/zvec-engine/index.js`；未构建时会报 **22 个既有错误**，掩盖真实结果。本批首次运行即踩到（判定为既有问题后补齐前置，随后 exit 0） |
| 10 | 工具分组由服务端下发 | `GET /prompt-config` 响应补 `toolGroups`（工作项 4 落地时补） | 工具名的 SSOT 在 `src/lib/mcp-tools/`；前端自己写一份 14 个工具的分组清单**必然随工具增减而漂移**。`limits` 同理（前端不硬编码字数上限）。这是**工作项 2 完成后**新增的字段 —— 已同步补测试断言（3 组、14 个、只有只读组不危险） |
| 13 | **契约变更**：`ChatMessage` 新增 `progress?: ChatProgressStep[]` | 由走查 #11 驱动，**经用户明确要求**（"检索的过程痕迹要保留，不要刷新就没了"）。这是**对护栏 #1 的有意例外**：批次 1 期间契约冻结，但该需求只有落盘才能满足（内存版实测"生成后立即消失"可解、"刷新即失"不可解）。**边界收紧**：只落**步骤级摘要**（工具名 / 模式 / 命中数 / 失败原因），**不含查询串与片段正文** → 不触碰 `ChatMessage` 的两条结构性不变量（不含 reasoning / 不含检索原始结果）。前端类型副本同步；`buildAssistantMessage` 与两条落盘路径（正常 / 中止）均带上。**待定 #9 就此拍定一半**：选「落盘摘要」；完整 R12（入参 / 响应 JSON + 展开）仍归批次 3 |
| 12 | 联调实例接真实模型（用户提供 `~/.codebuddy/models.json`） | 在 `/tmp/ki-e2e/config.yaml` 加 `llm:` 段（`baseURL: https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`、`model: qwen3.8-flash`、`supportsTools: true`、`kbDisclosureAck: true`），**apiKey 用 `${KI_CHAT_KEY}` 引用、明文只经环境变量传入**（配置落盘无密钥）。`GET /api/chat/config` → `enabled:true` + `ackRequired:false` | **真实对话补验了遗留观察项①**：把基础提示词临时改为「必须以 [CFG-OK] 开头」→ 真跑一轮（新会话 `c-munuqsbs-ku5w`，6.3s，事件 `meta/reasoning/content/usage/done`）→ assistant 回复**确实以 `[CFG-OK]` 开头** ⇒ **配置注入在真实对话中生效**（不再只有单测逐字比对为证）。**同时暴露一条真实反馈**：模型回复里说「你提到的 `ki_query_group` 和 `ki_search` 在我这里并不存在」—— 它读到的是 skill 内容里引用的工具名，而批次 1 **工具未暴露**（仅内置 `kb_search`）。这是**预期边界**，但说明"skill 里写 `ki_*` 工具名"在批次 1 会给模型造成困惑 → 值得在批次 2 的 UI/文案里呼应。**联调实例起停**（密钥不落盘，故重启必须带 env，否则 `enabled` 会变 false）：`kill <pid>` 后 `KI_CONFIG_PATH=/tmp/ki-e2e/config.yaml KI_CHAT_KEY="$(node -e 'process.stdout.write(require("/root/.codebuddy/models.json").models[0].apiKey)')" npx jiti src/mcp-server.ts --http --daemon --host 127.0.0.1 --port 7433 --web` |
| 11 | 真机 UI 走查（**已做**，经用户授权） | 起**独立实例**，全程未动用户的 7423：`KI_CONFIG_PATH=/tmp/ki-e2e/config.yaml`（内含独立 `dataDir`/`chatDir`）+ `npx jiti src/mcp-server.ts --http --daemon --host 127.0.0.1 --port 7433 --web`（**按要求不用 `ki` 命令**）；浏览器直接开 `http://127.0.0.1:7433/` —— daemon 的 `--web` 托管 `web/dist`，**因此无需改 vite proxy**（比预想少一步）。走查后已停实例、端口已释放；`~/.ki/` 里唯一的 lock 属 7423（pid 1402390），未触碰。 | **真机抓出 2 个编译期看不见的缺陷，均已修**：① chevron `<svg>` 漏 `width/height` 属性 → 退回 SVG 默认 300px 宽，把 `__item-main` 挤成 **0 宽**并撑破容器（层内横向溢出 **95px**）→ 改为在 CSS 里给 `.ki-chat-cfg__chev` 定尺寸（比逐处加属性更防漏）；② 危险确认卡打开时 **Esc 完全无效**（分层逻辑写了"交给它处理"但没人处理，demo 有、落地漏了）→ 层内 Esc 改为三级「确认卡 → 模态 → 层」。走查数据留在 `/tmp/ki-e2e/`（可随时删） |

## 进度日志
- 2026-09-30 00:58 建档；批次切分与护栏已定；工具白名单按代码实读取准 14 个（demo 的 5 个属错漏，已记为工作项 4 的修正项）
- 2026-09-30 00:59 开工 工作项 1（配置模型与存储）
- 2026-09-30 01:05 **工作项 1 完成**：`prompt-config.ts` + 19 条单测全绿；`tsc` exit 0；`test:chat` 10 文件 **122 断言 0 失败**（原 103 + 新 19）。**下次从「工作项 2：配置 API」继续**（挂进 `chat-routes.ts`，错误码先用本地常量）
- 2026-09-30 16:15 **工作项 2 完成**：配置 API（`GET`/`PUT /api/chat/prompt-config`）挂进 `chat-routes.ts`（+88 行），新增路由级测试 **12 断言全绿**，`tsc` exit 0。
  环境侧两件事已登记为决策：#8 缺 `.delivery/mocks/` 致 4 个既有测试文件无法启动（既有缺陷）、#9 `tsc` 需先 `npm run build:zvec-engine`。
  期间**用户自行调整了 demo**（新增 `ki-chat-cfg__item-ic(--prompt/--skill)`、`__group-dot`、`__group-n`、`__modal-head`、`__modal-sub`、`__row`、`__item-meta--mod` 等类）→ 工作项 4 落地时**以 demo 现状为蓝本**。
  **下次从「工作项 3：注入生效」继续**：把 `promptConfigSystemBlocks` 接进 `buildSystemMessages` 的调用处，未配置时输出逐字一致（守 #3）
- 2026-09-30 16:40 **工作项 3 完成**：注入链路接通（`buildSystemMessages(conv, blocks)` + `LoopRuntime.systemBlocks`）。
  关键设计：**不改冻结的 `ToolLoopInput`**，配置块走内部 runtime（与既有运行期字段同款）；`buildSystemMessages` 默认参数 = 既有单块 → 既有调用方与「未配置」运行时**逐字不变**（新增用例断言）。
  验证：`prompt-config.test.ts` **23 pass**（+4）、`e2e-sr01-edit` **6 pass**（真实链路）、可运行 7 文件 **81 断言 0 失败**、`tsc` exit 0。
  **下次从「工作项 4：前端配置层」继续** —— 落地前必须先读一遍 demo 现状（用户已自行改过：`__item-ic` / `__group-dot` / `__group-n` / `__modal-head` / `__modal-sub` / `__row` / `__item-meta--mod` 等），并以 `web/src/chat/` 现有组件与 `ki.css` 的既有 token/类名为准做增量
- 2026-09-30 17:20 **工作项 4 + 5 完成**（批次 1 代码落地全通）：
  前端新增 `usePromptConfig.ts` / `PromptConfigLayer.tsx` / `PromptConfigModal.tsx`，改 `chatContract.ts` / `chatApi.ts` / `ChatPanel.tsx`；`ki.css` 并入配置层样式（`2319 → 2609` 行，取 demo C 段 + 用户补的 D5 段）。
  后端补 `toolGroups` 下发（决策 #10）。**判据全过**：web `typecheck` exit 0、`build` 成功、后端 `tsc` exit 0、路由测试 12 pass、`test:chat` 可运行 7 文件 81 断言 0 失败。
  落地要点：编辑模态走 `createPortal` 到 body（与 `DocumentEditor` 一致，避免被面板 `overflow` 裁剪）；**未改冻结的 `ToolLoopInput` / 后端 `chat-contract.ts`**。
  ⚠️ **唯一未做**：浏览器真机 UI 走查（daemon 仍是旧版 404，需重启，见决策 #11）——接手第一件事。
  **批次 1 剩余**：真机走查 → 若通过则可交接验收；批次 2/3 仍阻塞于待拍板项（#2/#4/#9）。
- 2026-09-30 17:45 **真机走查完成**（决策 #11，经授权起 7433 独立实例，未动 7423）：
  走查链路全通 —— 入口不折行（60×26）/ 层内 **14 工具 · 三组** / 模态 `position:fixed` **页面居中**（720×720 @1680×1000）/ 提示词编辑 20 字 → 层保存 → **后端读回 + 落盘 `/tmp/ki-e2e/chat/prompt-config.json`** / 新增 skill（焦点自动落名称框、计数联动 `2 / 20 启用`）→ 落盘 `skill-munuld26` / 危险开关二次确认后落盘（`ki_store`）/ Esc 三级分层。
  **抓出并修复 2 个编译期看不见的缺陷**：① chevron `svg` 漏尺寸 → 横向溢出 95px；② 确认卡 Esc 失效。修复后复验：层内溢出 **0**、Esc 关卡正常。
  **批次 1 判定：可交接验收**（自评审 17/17，见 checklist.md）。批次 2/3 仍阻塞于待拍板项（#2/#4/#9）。
- 2026-09-30 18:20 **走查驱动的第三轮修复**（用户逐条反馈真机画面 → 定位 → 改 → 同视口复验）：
  ① **markdown 排版缺失**（`MarkdownPreview` 未自带 `.ki-markdown` 钩子 → 列表 `padding-left` 被 reset 清零、`code`/`pre`/引用无样式）→ 由组件自带钩子，一处修好 5 个使用处；
  ② **消息操作条无按钮观感**（`.ki-chat-act` 为 `border:none + transparent + 24px`）→ 补边框 / 28px 点击区 / hover / `focus-visible` 环；
  ③ **「本次未检索」措辞不准**（该 reason 实为"检索未成功"，与「已达检索轮次上限」并列时看似自相矛盾）→ 后端 `tool-loop.ts` 两处 + 前端 `DEGRADED_LABELS` 同步改为「本次检索未成功」。**`retrieval-skill.ts` 里的同款文案刻意未动**：那是护栏 E2/E3 锁住的注入锚点（改它 = 变更所有用户的内置行为 + 破坏逐字一致基准），需单独拍板；
  ④ **检索过程落盘**（决策 #13）：`ChatMessage.progress` + 后端累积 + 前端折叠渲染。**实测**：刷新页面后「检索过程 · 6 步」仍在，步骤文案与生成期间一致（复用 `useChatStream` 同一套文案函数）。
  验证：web `typecheck` exit 0 / `build` ✓ / 后端 `tsc` exit 0 / 路由测试 **12 pass** / 真机复验通过。
  ⚠️ 自评审因 ④ 的契约变更由 17/17 调整为 **16/17**（E1 降为「部分」，理由见 checklist）。
