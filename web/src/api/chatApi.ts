/**
 * chatApi.ts —— `/api/chat/*` 接口封装 + SSE 解析
 *
 * ═══ 通用语义契约 ═══
 * · 通道：同源 `fetch`（dev 经 Vite proxy → 7423）；**浏览器绝不直连第三方模型**
 * · SSE 用 `fetch` + `ReadableStream`（**不用 `EventSource`**：它只支持 GET、无法带请求体、无法中途 abort）
 * · 事件分派：按 `data.type`（**不使用 SSE `event:` 字段**，见 api/INDEX.md §1）
 * · 错误：非 2xx → 抛 `ChatApiError`（带 `code`）；流中 `{type:'error'}` → 作为事件产出，**不抛**
 * · 空值：列表无数据 → `{items: [], nextCursor: null}`（不返回 null）
 * · 幂等：读类幂等；`createConversation` / `streamMessage` / `streamRegenerate` / `streamEditMessage` 非幂等
 * · 中止：`AbortSignal` 触发 → 流正常结束（后端发 `aborted` 事件）
 *
 * @see api/INDEX.md · api/retrieval.md
 */

import type { ChatConfigOk, ChatEvent, ConversationFile, ConversationSummary } from '@/api/chatContract';

/** chat 接口基础路径（导出以便其他模块复用，避免多处硬编码） */
export const CHAT_API_BASE = '/api/chat';

/** 契约错误（HTTP 层）；流内错误以 `{type:'error'}` 事件表达 */
export class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ChatApiError';
  }
}

/** 统一错误载体（对齐 api/INDEX.md §1）：`{ ok:false, error, code?, details? }` */
interface ApiErrorBody {
  ok?: false;
  error?: string;
  code?: string;
  details?: { field: string; message: string }[];
}

/** 非 2xx 响应体 → `ChatApiError`（尽量带上后端 `code`，供 UI 按码映射文案） */
async function toApiError(res: Response): Promise<ChatApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* 非 JSON（如 404 HTML）：保留 HTTP 状态即可 */
  }
  const message = body?.error ?? `HTTP ${res.status}`;
  return new ChatApiError(res.status, body?.code, message);
}

/**
 * JSON 请求封装（复刻 `httpApi.ts` 的 `req<T>` 模式，但错误带 `code`）。
 *
 * 为什么不直接复用 `httpApi.req`：它抛的是 `Object.assign(new Error(...), {status, body})`，
 * 没有 `code` 字段；而本模块的错误码分段（1xxx~4xxx）是 UI 分支的唯一依据。
 */
async function reqJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

const jsonBody = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) });

// ─── 配置（API-01 / API-13）────────────────────────────────

/**
 * GET `/api/chat/config`。**未就绪时仍 200**（`enabled:false`），不抛错。
 *
 * 消费方须区分三个正交状态：`enabled`（能否对话）/ `supportsTools`（走哪条检索路径）/ `ackRequired`（是否需先确认）。
 */
export async function getChatConfig(): Promise<ChatConfigOk> {
  return reqJson<ChatConfigOk>(`${CHAT_API_BASE}/config`);
}

/** POST `/api/chat/config/ack` —— 隐私确认（T12）。幂等 */
export async function ackDisclosure(): Promise<{ ok: true; kbDisclosureAck: true }> {
  return reqJson<{ ok: true; kbDisclosureAck: true }>(
    `${CHAT_API_BASE}/config/ack`,
    jsonBody({ ack: true }),
  );
}

// ─── 会话 CRUD（API-02 ~ API-07 / API-14）──────────────────

/**
 * @param scope 会话归属 scope（**同时是检索边界**，见 N23）
 * @param opts.archived 是否看已归档（默认 false）
 * @param opts.cursor `{updatedAt}__{id}` 复合游标
 */
export async function listConversations(
  scope: string,
  opts?: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ scope });
  // `archived` 在契约里是 `0` | `1`（不是布尔）
  if (opts?.archived !== undefined) params.set('archived', opts.archived ? '1' : '0');
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.cursor) params.set('cursor', opts.cursor);

  const res = await reqJson<{ items?: ConversationSummary[]; nextCursor?: string | null }>(
    `${CHAT_API_BASE}/conversations?${params.toString()}`,
  );
  // 空值契约：无数据 → 空数组 + null 游标（不返回 null）
  return { items: res.items ?? [], nextCursor: res.nextCursor ?? null };
}

/** @param input `title` ≤48 字、`systemPrompt` ≤4000 字；均可不传（title 默认取首条用户消息前 24 字） */
export async function createConversation(
  scope: string,
  input?: { title?: string; systemPrompt?: string },
): Promise<{ conv: Pick<ConversationFile, 'id' | 'title' | 'systemPrompt' | 'createdAt' | 'updatedAt'> }> {
  return reqJson(`${CHAT_API_BASE}/conversations`, jsonBody({ scope, ...(input ?? {}) }));
}

/** @param id 会话 id；越权时后端返回 **403 而非 404**（防状态码探测） */
export async function getConversation(
  id: string,
): Promise<{ conv: ConversationFile }> {
  return reqJson<{ conv: ConversationFile }>(
    `${CHAT_API_BASE}/conversations/${encodeURIComponent(id)}`,
  );
}

/** @param patch 至少一项；`PATCH` 无任何可改字段 → 400 `CONVERSATION_INVALID` */
export async function patchConversation(
  id: string,
  patch: { title?: string; systemPrompt?: string },
): Promise<{ conv: Pick<ConversationFile, 'id' | 'title' | 'systemPrompt' | 'updatedAt'> }> {
  return reqJson(`${CHAT_API_BASE}/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** @param archived `true` = 归档（软删）；`false` = 恢复 */
export async function archiveConversation(
  id: string,
  archived: boolean,
): Promise<{ conv: Pick<ConversationFile, 'id' | 'archived' | 'archivedAt'> }> {
  return reqJson(
    `${CHAT_API_BASE}/conversations/${encodeURIComponent(id)}/archive`,
    jsonBody({ archived }),
  );
}

/** 物理删除（前端须二次确认）；后端级联删本地图片，**绝不动 kb/** */
export async function deleteConversation(id: string): Promise<{ ok: true }> {
  return reqJson<{ ok: true }>(`${CHAT_API_BASE}/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * DELETE `/api/chat/conversations?scope=` —— 清空全部（N8）。幂等。
 *
 * @param scope 目标 scope；**绝不触碰 `kb/{scope}/`**
 */
export async function clearConversations(scope: string): Promise<{ ok: true; deleted: number }> {
  return reqJson<{ ok: true; deleted: number }>(
    `${CHAT_API_BASE}/conversations?${new URLSearchParams({ scope }).toString()}`,
    { method: 'DELETE' },
  );
}

// ─── 生成类（API-08 / API-11 / API-12）—— 三者共用 SSE 解析 ────

/**
 * SSE 逐帧解析：把 `Response.body` 转成 `ChatEvent` 异步迭代器。
 *
 * ═══ 为什么必须逐帧 yield ═══
 * 若等整条流读完再返回，R8 的"首字 1s 量级"与 R11a 的"每一秒都有反馈"都无法满足。
 *
 * ═══ 分帧规则 ═══
 * · 以 `\n\n` 为帧分隔（兼容 `\r\n\r\n`）
 * · 只取 `data:` 前缀行的载荷；**忽略 SSE `event:` / `id:` / 注释行**（契约规定按 `data.type` 分派）
 * · 非法 JSON 帧**跳过而非中断**（单帧坏数据不应让整轮对话丢失）
 */
async function* readSseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const body = res.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 统一换行后按空行切帧
      let sep = findFrameEnd(buffer);
      while (sep) {
        const raw = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.next);
        const payload = extractDataPayload(raw);
        if (payload !== null) {
          const ev = parseEvent(payload);
          if (ev) yield ev;
        }
        sep = findFrameEnd(buffer);
      }
    }

    // 流结束时冲刷残留帧（后端未以空行收尾时的兜底）
    const tail = extractDataPayload(buffer);
    if (tail !== null) {
      const ev = parseEvent(tail);
      if (ev) yield ev;
    }
  } finally {
    // 中止或正常结束都要释放读锁，避免连接悬挂
    try {
      reader.releaseLock();
    } catch {
      /* reader 已释放 */
    }
  }
}

/** 定位一帧结束：返回帧内容结束位置与下一帧起点；无完整帧返回 null */
function findFrameEnd(buf: string): { index: number; next: number } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, next: crlf + 4 };
  return { index: lf, next: lf + 2 };
}

/** 帧文本 → `data:` 载荷（多行 data 按 SSE 规范拼接）；无 data 行返回 null */
function extractDataPayload(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue; // 忽略 event: / id: / 注释行
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/** 载荷 JSON → `ChatEvent`；缺 `type` 或非法 JSON 时返回 null（跳过该帧） */
function parseEvent(payload: string): ChatEvent | null {
  try {
    const obj = JSON.parse(payload) as ChatEvent | null;
    if (!obj || typeof obj !== 'object' || typeof (obj as { type?: unknown }).type !== 'string') {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

/**
 * 生成类统一入口：POST 一条 SSE 流并逐帧产出事件。
 *
 * 三个 API（08/11/12）只在路径与请求体上不同，**解析逻辑必须共用**——
 * 各写一份会在事件协议演进时漏改其中一处。
 */
async function* postSse(
  path: string,
  body: unknown | undefined,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(path, {
    method: 'POST',
    // 12 字/10s 级长流：显式声明期望 SSE，便于代理不缓冲
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  // 流建立前失败 → HTTP 错误（带 code）；建立后失败 → error 事件（不抛）
  if (!res.ok) throw await toApiError(res);

  yield* readSseEvents(res, signal);
}

/**
 * API-08 发消息。产出**完整事件序**（含 `meta` 首帧与 `done`/`error` 末帧）。
 *
 * ⚠️ 契约：实现必须**逐帧解析并 yield**（不得等整条流结束再返回），
 * 否则 R8 的"首字 1s 量级"与 R11a 的"每一秒都有反馈"无法满足。
 *
 * @param convId 会话 id（后端保证同一会话的写入串行化）
 * @param text 1~20000 字；空白 → 400 `MESSAGE_INVALID`
 * @param signal 中止信号（切会话 / 点停止 / 删会话时触发）
 */
export async function* streamMessage(
  convId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  yield* postSse(
    `${CHAT_API_BASE}/conversations/${encodeURIComponent(convId)}/messages`,
    { text },
    signal,
  );
}

/** API-11 重新生成（**不新增 user 消息**，R23）；后端替换最后一条 assistant，`messageCount` 不变 */
export async function* streamRegenerate(
  convId: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  yield* postSse(
    `${CHAT_API_BASE}/conversations/${encodeURIComponent(convId)}/regenerate`,
    {}, // 契约：请求体无（`{}` 可接受）
    signal,
  );
}

/**
 * API-12 编辑并重发（N21 原子截断由后端保证）。
 *
 * `meta.discardedCount` 告知被丢弃的轮数 → UI 应在操作前提示"将丢弃其后 N 轮"。
 *
 * @param msgId 必须是 **user 消息**；指向 assistant → 400 `MESSAGE_INVALID`
 */
export async function* streamEditMessage(
  convId: string,
  msgId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(
    `${CHAT_API_BASE}/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
      signal,
    },
  );
  if (!res.ok) throw await toApiError(res);
  yield* readSseEvents(res, signal);
}
