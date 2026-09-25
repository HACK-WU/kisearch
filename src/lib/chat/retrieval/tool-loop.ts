/**
 * 工具调用循环（S07 §3.4 / §3.7）
 *
 * 本模块是 **D13 的核心：检索问答的编排者**。产出物是 SSE 事件流，
 * 由 `chat-routes.ts` 原样转发（路由层不做业务判断）。
 *
 * ═══ 流程（实现须严格按此顺序）═══
 * ```text
 * 1. 构造 messages：system(检索 skill + 会话 systemPrompt) + 历史(仅 content) + 本轮 user
 * 2. round = 0
 * 3. loop:
 *     上游流 →
 *       ├─ content 流   → 直接转发 {type:'content'}（边收边发）
 *       ├─ reasoning 流 → 转发 {type:'reasoning'}（**不落盘**）
 *       └─ 回合结束：
 *           ├─ 有 tool_calls 且 round < maxRounds →
 *           │    · 发 {type:'tool_start', name, query, mode}
 *           │    · runKbSearch（★ 内部入队）
 *           │    · 发 {type:'tool_end', hits, durationMs}
 *           │    · 投影 → 追加 assistant(tool_calls) + tool(projection) 消息
 *           │    · round += 1 → 继续 loop
 *           └─ 无 tool_calls（或达上限）→ 结束
 * 4. 落盘 assistant 消息（content + sources）
 * ```
 *
 * ═══ 四条硬约束 ═══
 * 1. **`reasoning` 绝不进 `messages`**（N12）
 * 2. **`sources` 只落来源引用，原始检索结果不落盘/不回传**（N22）
 * 3. **达 `maxRounds` 后强制作答**（N19）—— 不发错误，直接进入"无 tool_calls"分支
 * 4. **`tool` 消息内容必须是瘦身投影**（原始结果会显著放大上下文）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`llm.supportsTools !== false`；隐私已确认（`kbDisclosureAck === true`）
 * · 后置：产出以 `done` 或 `error` 结尾的完整事件序（见 chat-contract 的 `CHAT_EVENT_ORDER_RULES`）
 * · 空值：检索无命中 → 不发 `sources`（**不发空数组**），由 skill 反幻觉规则引导模型如实作答
 * · 错误：检索抛错 → **不中断生成**，发 `{type:'tool_end', error}` 后继续（模型可见失败并自行说明）
 * · 中止：`signal` 触发 → 发 `{type:'aborted'}`，已累积内容由调用方落盘（`aborted:true`）
 * · 幂等：非幂等
 * · 并发：同会话由 `chat-store` 的会话锁串行；**生成期间不持锁**
 * · 事务：单会话单次落盘
 * · 副作用：检索（只读，入 coordinator）+ 上游调用 + 最终落盘
 *
 * @see design/S07_检索与工具调用_DESIGN.md
 */

import type { ChatEvent, ConversationFile } from '../chat-contract.js';

export interface ToolLoopInput {
  scope: string;
  /** 会话（含历史消息；构造上游 messages 时**只用 content**） */
  conv: ConversationFile;
  /** 本轮用户输入（可能来自新增或编辑重发） */
  userText: string;
  /** 会话自定义 system prompt */
  convSystemPrompt: string;
  signal?: AbortSignal;
}

/**
 * 工具路径：模型自行决定是否检索（R18/R19）。
 *
 * 产出的事件序（正常）：
 * `meta → [tool_start → tool_end]* → reasoning* → content* → sources? → usage → done`
 */
export async function* runToolLoop(input: ToolLoopInput): AsyncGenerator<ChatEvent> {
  throw new Error(`STUB:SR-01:runToolLoop`);
}

/**
 * 预检索降级路径（T10 已拍板：**预检索一次 + 明示**）。
 *
 * 触发条件（任一）：
 * · `llm.supportsTools === false`（用户手填）
 * · 上游首次返回工具不支持类错误（`ToolsUnsupportedError`）
 * · 工具循环连续 2 轮检索均抛错（检索不可用）
 *
 * 行为：
 * 1. daemon 代跑一次检索（`query = userText`，`mode = hybrid`，`limit = 5`）
 * 2. 投影后作为**上下文注入**（拼在本轮 user 消息之前）
 * 3. 发 `{type:'degraded', reason:'tools-unsupported'|'retrieval-unavailable'}`
 * 4. 检索本身失败 → **不注错**，改发 `reason:'retrieval-unavailable'`，
 *    并由 skill 反幻觉规则 2 保证模型前置「本次未检索」
 */
export async function* runPreRetrievalFallback(input: ToolLoopInput): AsyncGenerator<ChatEvent> {
  throw new Error(`STUB:SR-01:runPreRetrievalFallback`);
}
