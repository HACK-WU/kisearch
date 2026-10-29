# E2E 测试报告：Web 侧边栏 AI 对话（后端/契约面）

> requirement_ref: **REQ-20260924-001**（SR-01 后端检索与生成链 · SR-02 前端对话面板的接口面）
> 旅程定义：`tests/e2e/journey-sidebar-ai-chat.md`　｜　可复跑脚本：`tests/e2e/journey-sidebar-ai-chat.mjs`
> 复跑：`node tests/e2e/journey-sidebar-ai-chat.mjs`

## 概览

- **通过步骤：13 / 13**（teardown 不计入判定）　｜　**旅程状态：✅ PASS**
- 环境：本机 daemon `http://127.0.0.1:7423`（`ki mcp --http`，回环免鉴权）→ `env_name: local`
- 被测 scope：`default`（向量集合维度已与配置一致，含「错误库」类可检索内容）
- 链路真实性：**真实 daemon + 真实模型（qwen3.8-flash）+ 真实向量检索 + 真实落盘**，无任何 mock
- 耗时：3m 05s（含 5 次真实模型生成）

## 明细

| 步骤 | 类型 | 状态 | 关键 evidence | 失败根因 |
|------|------|------|---------------|----------|
| config_get | api | ✅ | `enabled=true model=qwen3.8-flash host=token-plan.maas.qianwenaiapi.com tools=true ack=false retrieval=true`；`maxToolRounds=3`；响应体不含 `sk-`，`baseURLHost` 无路径 | — |
| conv_create | api | ✅ | `201 {ok:true, conv:{id,scope:"default",title:"新会话"}}`，messageCount=0 | — |
| conv_list | api | ✅ | 列表含新会话，`corrupted=false` | — |
| qa_hit | api | ✅ | SSE `events=182`；`tool_start.name=kb_search`、`mode` 合法、`tool_end.hits=3 durationMs=552`；`content=296字`；`done.sources=5`、`finishReason=stop`；事件序校验 0 违规 | — |
| persist | assert | ✅ | 重新 GET：`messages=2`（user+assistant）、`assistant.sources=5`、落盘内容与流式内容**逐字节一致**、**无 `reasoning` 字段（D7 不落盘）** | — |
| qa_miss | api | ✅ | 库外问题（量子纠缠贝尔不等式）→ 正文 **含「未找到」**（3311 字，如实回答、未冒充）；检索命中=3（语义 top-k），`sources=3` 非空数组 | — |
| regenerate | api | ✅ | user 消息数 **2→2 不变**、`messageCount 4→4 不变`，重生成内容 3915 字 | — |
| edit_resend | api | ✅ | **原子截断**：`meta.discardedCount=3`，截断后 `messages=2`（被编辑 user 消息 id 保留、内容更新，其后补 1 条新 assistant） | — |
| archive | api | ✅ | 归档后 `archived=1` 可见 / `archived=0` 不可见；取消归档回到活跃列表 | — |
| rename | api | ✅ | PATCH 后 title 生效并落盘 | — |
| err_404 | api | ✅ | `404 CONVERSATION_NOT_FOUND` | — |
| err_400 | api | ✅ | 建会话缺 scope → `400 CONVERSATION_INVALID`；发消息缺 text → `400 MESSAGE_INVALID` | — |
| err_409 | api | ✅ | 生成中并发发消息 → `409 CONVERSATION_GENERATING`（P5 会话忙） | — |

## 副作用清单（供审计）

- 已创建：本次 2 个会话（`c-mumsy3rt-btt1`、`c-mumt21pu-qq0x`，均为 e2e 自建）
- 已清理：**teardown 全部删除成功**（`delete=true` ×2）✅
- 未触碰：`kb/` 知识库资产、向量集合（契约保证 `chatDir` 与 `kb/` 物理分离，本次行为与契约一致）
- 未触碰用户既有会话 `c-mumrnqgv-5q2r`（scope=default，标题 "hello"）

## 编排层修正记录（非产品缺陷，如实列出）

| # | 现象 | 判定 |
|---|------|------|
| 1 | `POST /api/chat/conversations` 返回 **201**，首版断言按 200 → 假失败 | **断言口径错**（REST 惯例；规格未约定具体码）→ 改为接受 200/201 |
| 2 | 首版把「答未找到 ⇒ 不得有 sources」当断言，`qa_miss` 假失败 | **断言口径错**：契约原文是「**无来源时不发空数组**」，并非"答未找到不能有来源"。语义检索对任何 query 都返回 top-k，模型据此判定不相关并如实说明 → 改为按契约真实条款断言 |

> 两次都是编排层问题，**未放宽任何判定标准**（改的是"检查写对"，不是"让红变绿"）。

## 建议

1. 🟡 **引用与结论一致性（体验，非正确性）**：`qa_miss` 场景下模型如实回答「未找到」，但面板仍会展示 3 条来源引用——用户看到「未找到…」旁边挂着「引用 3 处」容易困惑。建议 `qa_miss` 这类"命中但判定不相关"的终态下，来源区加一句限定（如「以下为语义近似结果，未被采用」），或按 `finishReason`/模型结论标记来源是否被采纳。
2. 🟢 **错误码可观测性**：`err_400` / `err_404` / `err_409` 的 `code` 字段与契约段位（2xxx/3xxx/4xxx）完全一致，前端可放心按 `code` 分派；建议在前端补一张 `code → 用户文案` 映射表并加契约测试（当前前端只按 HTTP 状态与少量 code 分支）。
3. 🟢 **`--dimensions` 与 doctor 的联动**：本次环境暴露的"集合维度与配置不一致"只能靠 `ki doctor --dimensions` 发现，日常 `ki doctor` 全绿 → 建议把该检查在**首次进入对话面板**时做一次轻量提示（避免用户像本次一样"先撞检索失败再排查"）。

## 未覆盖（诚实声明）

| 项 | 原因 | 归属 |
|---|---|---|
| SR-01 §2.3 预检索降级（`supportsTools=false` → `degraded` 事件） | 需改 `config.dev.yaml` 并重启 daemon，会打断当前环境 | 建议单独跑一次（可在 journey 内做参数化） |
| SR-02 §2.1–2.4 的 **DOM 语义**：D15 关闭面板不中止、来源点击回原文高亮、切页面不丢 | 需真实浏览器环境（本项目 `web/test` 只有 `node --test`，无 DOM 基建） | **UI journey**（`tests/e2e/journey-sidebar-ai-chat-ui.*`）——SR-02 slice 明确标注这两项"仍为人工验收"，是本次最值得补的缺口 |
| 越权面（P1–P7，token/scope 白名单） | 回环免鉴权，需构造多 token 与 `--host` 外网监听 | 归 SR-01 §3 第 5 项（骨架期已定义用例） |

## 复跑记录

| 时间 | 触发 | 结果 |
|------|------|------|
| 2026-09-29 23:02 | 首次执行 | **13/13 PASS**（3m05s） |
| 2026-09-29 23:15 | **多轮上下文缺陷修复后回归**（`tool-loop.ts::buildUpstreamMessages` 不再重复拼本轮 user） | **13/13 PASS**（2m24s） |
| 2026-09-29 23:27 | 注释/测试补强后回归 | ⚠️ **5/13 FAIL**（中止于 `qa_miss`；`tail` 截断未留存断言原文） |
| 2026-09-29 23:36 | 同上，带客户端超时复跑 | **13/13 PASS**（4m36s） |

> **观测到的抖动（如实记录）**：4 次里 1 次在 `qa_miss` 失败。该步是三处最"重"的一步——
> 库外问题会触发 **3 轮工具调用 + 超长推理 + ~4000 字回答**，耗时从 40s 到 2min+ 波动。
> 单轮最小复现探针（独立会话、一次提问）显示模型**回答正确**（明确「知识库中未找到相关内容」并声明推导不来自知识库）。
> **最可能的失败点是「回答须含『未找到』」这条断言**——它依赖**模型判断**（语义检索对任何 query 都返回 top-k，
> 是否声明"无命中"由模型决定），属**断言口径**问题而非产品缺陷；**但本次未留存断言原文，故不能确证**。
> 处置建议：把该断言拆成「结构性硬断言（事件序/来源非空数组/落盘一致）+ 模型行为软观测（是否声明未找到）」，
> 避免把模型抖动记成产品失败。
>
> **本次同时修复了 harness 自身缺陷**：SSE 请求补 `AbortSignal.timeout(180s)` ——
> 早期版本没有客户端超时，服务端慢/假死时 journey 会**静默挂起**（已实测踩到一次，2m12s 卡在 `qa_miss`）。
> 这正是本报告给前端提的同类问题（P1「前端 SSE 无客户端超时」），我自己的 harness 也犯了。

> 第 2 次复跑的意义：该次修复改的是**核心生成路径的上游 messages**，且本 journey 在**同一会话内跑了 4 轮**
> （`qa_hit` → `qa_miss` → `regenerate` → `edit_resend`），因此它能同时充当该修复的真实链路回归。
>
> 注意：本 journey **看不到上游请求体**，所以它无法验证「本轮 user 恰好一次」——
> 那条判据由新增的 `test/chat/multi-turn-context.test.ts`（mock 上游捕请求体）承担，两者互补。
