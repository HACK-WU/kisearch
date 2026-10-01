# E2E Journey：Web 侧边栏 AI 对话（真实 daemon + 真实模型 + 真实检索）

> requirement_ref: **REQ-20260924-001**（SR-01 后端检索与生成链 · SR-02 前端对话面板）
> 判据来源：`sub-requirements/SR-01-后端检索与生成链/slice.md` §2 场景 / §3 验收标准、
> `sub-requirements/SR-02-前端对话面板/slice.md` §2 场景 / §3 验收标准、
> 契约 SSOT `src/lib/chat/chat-contract.ts`（SSE 事件序 / ChatConfigOk / 错误码 / 预算）
>
> 环境：本机 daemon（`ki mcp --http`，默认 `127.0.0.1:7423`，回环免鉴权）
> 凭证：无 token（回环免鉴权）；模型密钥由 daemon 侧 `config.dev.yaml` 持有，**不进本文件**
> env 注入：`.env.e2e`（`KI_E2E_BASE_URL` / `KI_E2E_FRONTEND_URL` / `KI_E2E_SCOPE`）
>
> 复跑：`node tests/e2e/journey-sidebar-ai-chat.mjs`

## 覆盖范围

| 需求场景 | 来源 | 对应步骤 |
|---|---|---|
| 文本问答带检索 + 来源引用 + 落盘可复原 | SR-01 §2.1 | `qa_hit` → `persist` |
| 检索无命中必须如实回答（不得冒充） | SR-01 §2.2 | `qa_miss` |
| 重新生成不新增 user 消息 / 编辑重发原子截断 | SR-01 §2.4 | `regenerate` / `edit_resend` |
| 面板可用的前置状态（配置就绪、检索可用） | SR-02 §2.1 / §2.5 | `config_get` |
| 会话管理（列表/归档/改名/删除） | SR-01 接口面 + SR-02 §2.1 | `conv_create` / `conv_list` / `archive` / `rename` / `teardown` |
| 错误面（404/400/409） | 契约错误码段 | `err_404` / `err_400` / `err_409` |

> **不在本 journey 内**：SR-01 §2.3 预检索降级（需改 `supportsTools=false` 重启 daemon）、
> SR-02 §2.2–2.4 的 DOM 语义（D15 关闭不中止 / 来源点击回原文）→ 归 **UI journey**
> （`journey-sidebar-ai-chat-ui.md`，浏览器驱动）。

## Steps

| id | type | name | depends_on | produces | assert 要点 |
|----|------|------|------------|----------|-------------|
| config_get | api | `GET /api/chat/config` | - | model, maxToolRounds | ok:true；enabled:true；model 非空；**baseURLHost 仅主机名**（不含 apiKey、不含路径）；ackRequired:false；retrievalEnabled:true；maxToolRounds=3 |
| conv_create | api | 建会话 | config_get | conv_id | ok:true；conv.id 非空；scope 相符；messageCount=0；archived=false |
| conv_list | api | 列表含新会话 | conv_create | - | 列表含 conv_id 且 corrupted=false |
| qa_hit | api | 提问知识库内的问题（SSE） | conv_create | content_hit,sources_hit | 事件序合法（meta 首；tool_start/tool_end 成对；sources 至多一次且在 done 前；done 收尾）；tool_start.name=kb_search；mode∈{fulltext,hybrid}；content 非空；done.sources 非空；snippet ≤200 字 |
| persist | assert | 落盘与刷新复原 | qa_hit | - | GET 会话：messages=[user,assistant]；assistant.sources 非空；**任何消息都不含 reasoning 字段（D7）**；messageCount=2 |
| qa_miss | api | 提问知识库外的事（SSE） | qa_hit | - | 正文如实说明「未找到相关内容」；**不带 sources**（无来源不发） |
| regenerate | api | 重新生成（SSE） | qa_miss | - | **不新增 user 消息**：完成后 messageCount 与生成前一致 |
| edit_resend | api | 编辑 user 消息并重发（SSE） | regenerate | - | **原子截断**：该 user 消息之后的消息被删除（用 meta.discardedCount 或 messageCount 证明） |
| archive | api | 归档 / 取消归档 | conv_create | - | archived 翻转；archived=1 列表可见、archived=0 不可见 |
| rename | api | 改标题 | conv_create | - | PATCH 后 title 生效 |
| err_404 | api | 未知会话发消息 | - | - | 404 + code=CONVERSATION_NOT_FOUND |
| err_400 | api | 非法入参 | - | - | 建会话缺 scope→400 CONVERSATION_INVALID；发消息缺 text→400 MESSAGE_INVALID |
| err_409 | api | 生成中并发发消息 | qa_hit | - | 409 + code=CONVERSATION_GENERATING（时序相关，`on_fail: continue`，不计入判定） |
| teardown | teardown | 删除本次创建的会话 | - | - | 删除 ok:true；**幂等**（二次删除仍 ok:true） |

## 副作用与清理

- 创建：`KI_E2E_SCOPE` 下若干会话（`{chatDir}/{scope}/c-*.json`）
- 清理：`teardown` 逐个 DELETE；**不触碰 `kb/` 与向量集合**（契约保证 `chatDir` 与 `kb/` 分离）
- 不写入知识库、不做破坏性写操作

## 判定

- 旅程步骤（不含 teardown）全部 ✅ → **PASS**；任一 FAIL → 旅程 FAIL 并定位
- `err_409` 为时序探针，`continue` 语义，不计入判定
