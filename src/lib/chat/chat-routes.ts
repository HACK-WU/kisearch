/**
 * chat 模块 HTTP 路由（API-01 ~ API-14，图片 API-09/10 后置 V2）
 *
 * ═══ 设计意图：单一入口，挂载点极薄 ═══
 * `mcp-http-api.ts` 的 if 链只需加**一行**：
 * ```ts
 * if (await handleChatRoutes(req, res, url, ctx)) return;
 * ```
 * 理由：该文件已 1065 行，逐条加分支会持续放大（且它归 SR-01 独占，见 ownership）。
 *
 * ═══ 通用语义契约（所有接口适用）═══
 * · 响应外壳：`{ok:true,...}` / `{ok:false,error,code,details?}`（**不引入** `{code,data,message}`）
 * · 字段命名：`camelCase`
 * · 鉴权：Bearer Token → scope 集合；**按 id 操作时越权返回 403 而非 404**（防状态码探测）
 * · 越权白名单：仅**带 `scope` 参数的 GET**（API-02、API-04、API-14）需登记
 *   （`src/lib/mcp-http-api.ts` 的只读接口列表）
 * · 排队：**CRUD 与生成请求均不入队**；只有生成期间的**检索工具调用**入队
 *   （口径见 `api/INDEX.md` §1 修订表 / S07 §3.6）
 * · 幂等：见各接口（读类幂等；API-03/08/11/12 非幂等；API-05/06/13/14 幂等）
 * · 空值：会话不存在 → 404 `CONVERSATION_NOT_FOUND`（授权范围内查不到）
 * · 错误：落盘失败 → 500 `CHAT_WRITE_FAILED`（**不返回部分成功**）
 * · 超时：生成类接口受 `CHAT_BUDGET` 约束（整体 300s / 首块 30s）
 *
 * @see api/INDEX.md · api/retrieval.md · api/config.md
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由上下文（由 `mcp-http-api.ts` 注入，避免本模块反向依赖它） */
export interface ChatRouteContext {
  /** 已鉴权的 scope 集合；null = 鉴权未启用 */
  authScopes: string[] | null;
  /** 当前请求配置快照（沿用 `runWithConfigSnapshot` 语义） */
  configSnapshot: unknown;
  /** 配置文件路径（供 fail-loud 文案引用）；未传时由实现自行解析 */
  configPath?: string;
}

/**
 * chat 路由总入口。
 *
 * · 返回 `true` = 已处理（调用方应 `return`，不再走后续 if 链）
 * · 返回 `false` = 路径不在 `/api/chat/*` 范围
 * · **不抛错**：所有异常须在内部映射为 `{ok:false,code}` + 合适 HTTP 码
 */
export async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ChatRouteContext,
): Promise<boolean> {
  throw new Error(`STUB:SR-01:handleChatRoutes`);
}

// ─────────────────────────────────────────────────────────────
// 配置（API-01 / API-13）
// ─────────────────────────────────────────────────────────────

/**
 * API-01 `GET /api/chat/config`
 *
 * · 越权白名单：**不登记**（不带 scope 参数；误加会导致该接口恒被 scope 校验拦截）
 * · **未就绪时仍返回 200 + `ok:true`**：配置缺失是可预期的产品状态，
 *   由 `enabled:false` 表达（面板据此显示配置指引而非错误提示）
 */
export async function handleConfigGet(res: ServerResponse, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConfigGet`);
}

/**
 * API-13 `POST /api/chat/config/ack` —— 隐私确认（T12）
 *
 * · 幂等：重复确认结果一致
 * · `ack !== true` → 400 `API_ERROR`（不接受"取消确认"，撤销入口在配置文件）
 * · 配置不可写 → 500 `CHAT_WRITE_FAILED`；**前端不得据此放行**（未持久化 = 下次仍会问）
 */
export async function handleConfigAck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  throw new Error(`STUB:SR-01:handleConfigAck`);
}

// ─────────────────────────────────────────────────────────────
// 会话 CRUD（API-02 ~ API-07）
// ─────────────────────────────────────────────────────────────

/** API-02 `GET /api/chat/conversations?scope=&archived=0&limit=&cursor=` —— 越权白名单：**登记** */
export async function handleConversationList(res: ServerResponse, url: URL, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationList`);
}

/** API-03 `POST /api/chat/conversations` —— 非幂等（每次产生新会话） */
export async function handleConversationCreate(req: IncomingMessage, res: ServerResponse, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationCreate`);
}

/**
 * API-04 `GET /api/chat/conversations/:id` —— 越权白名单：**登记**
 *
 * · `:id` 查找**只允许在 token 授权 scope 集合内遍历**；命中后再次校验 `scope`
 * · 越权 → **403 而非 404**（防状态码探测他 scope 会话是否存在）
 */
export async function handleConversationGet(res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationGet`);
}

/** API-05 `PATCH /api/chat/conversations/:id` —— 改 title/systemPrompt；幂等；无字段可改 → 400 */
export async function handleConversationPatch(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationPatch`);
}

/** API-06 `POST /api/chat/conversations/:id/archive` —— 归档/恢复；幂等 */
export async function handleConversationArchive(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationArchive`);
}

/** API-07 `DELETE /api/chat/conversations/:id` —— 物理删除 + 级联删本地图片（**绝不动 kb/**）；幂等 */
export async function handleConversationDelete(res: ServerResponse, id: string): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationDelete`);
}

/**
 * API-14 `DELETE /api/chat/conversations?scope=` —— 清空该 scope 全部会话（N8）
 *
 * · 越权白名单：**登记**（带 scope 参数）
 * · 幂等：无会话时 `deleted: 0` + 200
 * · ★ 绝不触碰 `kb/{scope}/`
 */
export async function handleConversationsClear(res: ServerResponse, url: URL, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationsClear`);
}

// ─────────────────────────────────────────────────────────────
// 生成类（API-08 / API-11 / API-12）—— 三者共用 SSE 写出与事件序
// ─────────────────────────────────────────────────────────────

/**
 * API-08 `POST /api/chat/conversations/:id/messages` —— 发消息（SSE）
 *
 * · 非幂等（每次写一条 user 消息）
 * · 前置：`kbDisclosureAck === true`，否则 403 `DISCLOSURE_REQUIRED`
 * · 前置：会话非生成中，否则 409 `CONVERSATION_GENERATING`
 * · 事件序见 `chat-contract.ts` 的 `CHAT_EVENT_ORDER_RULES`
 */
export async function handleConversationMessages(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationMessages`);
}

/**
 * API-11 `POST /api/chat/conversations/:id/regenerate` —— 重新生成（SSE）
 *
 * · **不新增 user 消息**（R23）
 * · 删除最后一条 assistant 后重新生成 → `messageCount` 不变
 * · 无任何消息 → 400 `CONVERSATION_INVALID`
 */
export async function handleConversationRegenerate(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleConversationRegenerate`);
}

/**
 * API-12 `PATCH /api/chat/conversations/:id/messages/:msgId` —— 编辑并重发（SSE）
 *
 * · **原子截断**（N21）：同一把会话锁内完成"截断 + 替换 + 落盘"
 * · `:msgId` 指向 assistant → 400 `MESSAGE_INVALID`；不存在 → 404 `MESSAGE_NOT_FOUND`
 * · `meta.discardedCount` = 被截断的消息数
 */
export async function handleMessageEdit(req: IncomingMessage, res: ServerResponse, id: string, msgId: string, ctx: ChatRouteContext): Promise<void> {
  throw new Error(`STUB:SR-01:handleMessageEdit`);
}

// ─────────────────────────────────────────────────────────────
// SSE 写出（三个生成类接口共用，**唯一实现点**）
// ─────────────────────────────────────────────────────────────

/**
 * 把 `ChatEvent` 事件流转写为 SSE 响应。
 *
 * · 头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、
 *   `X-Accel-Buffering: no`
 * · 帧格式：`data: {"type":...}\n\n`（**不使用 SSE `event:` 字段**，前端按 `data.type` 分派）
 * · 契约：**只转发不重排**；`meta` 必须是首帧
 */
export async function writeSseStream(res: ServerResponse, events: AsyncIterable<unknown>): Promise<void> {
  throw new Error(`STUB:SR-01:writeSseStream`);
}
