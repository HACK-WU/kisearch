/**
 * 手动压缩上下文 —— 摘要生成（REQ-20261013-001 R8）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：调用方已确认会话可压缩（条数够、未在生成中）；本模块**不读写会话文件**
 * · 出参：摘要文本（**非空**）；任何异常一律抛错，**不返回空串**
 * · 空值：未配置模型 → `ChatDisabledError`（由路由层决定"改用截断式"还是报错）
 * · 错误：上游失败 / 摘要为空 → 抛错 ⇒ 压缩失败**不落盘**（由 store 保证）
 *
 * ★ 为什么把摘要生成独立成模块：
 *   1. `chat-store` 保持"纯存储"（不认识 LLM），避免存储层依赖网络；
 *   2. 摘要提示词与截断口径集中一处，便于单测与后续迭代。
 */

import type { ChatMessage } from './chat-contract.js';
import { CHAT_BUDGET } from './chat-contract.js';
import { ChatDisabledError, resolveLlmStatus, streamChat, type ChatTurn } from './llm-client.js';
import { loadConfig } from '../config.js';

/** 摘要输出上限（tokens）——够写 500~800 字摘要，且不反过来撑大上下文 */
export const COMPACT_SUMMARY_MAX_TOKENS = 800;

/**
 * 送进摘要器的原文上限（字符）。
 *
 * ★ 必须有：否则"压缩"这一步自己就会把上游上下文打爆（会话越长越容易），
 *   且用户会看到一次莫名其妙的 400。超出时**只截尾部**（保留更早出现的内容？
 *   不 —— 保留**较晚**的内容，因为它离当前话题更近），并在摘要提示里说明被截断。
 */
export const COMPACT_INPUT_MAX_CHARS = 60_000;

/** 摘要系统提示（口径写死：只做事实压缩，不许续写、不许编造） */
const SUMMARY_SYSTEM_PROMPT = [
  '你是一个对话压缩器。请把用户提供的「待压缩对话」整理成一份**简明的事实摘要**，供后续继续对话使用。',
  '要求：',
  '1. 只保留事实性信息：用户的目标与偏好、已确认的结论、关键数据/路径/命令、未解决的问题与待办；',
  '2. 不得添加原文没有的信息，不得编造，不得继续回答对话中的问题；',
  '3. 按主题分段（可用简短小标题），不要逐条复述对话；',
  '4. 直接输出摘要正文，不要任何寒暄或"以下是摘要"之类的前后缀；',
  '5. 使用与原对话相同的语言。',
].join('\n');

/**
 * 把待压缩消息渲染成摘要器输入。
 *
 * · 只取 `role` + `content`（与上游 messages 同口径：reasoning 不落盘、sources 是展示用）
 * · 超长时保留**较晚**的部分（离当前话题更近）并在开头注明截断
 */
export function buildCompactionTranscript(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : '助手';
    lines.push(`【${who}】${m.content}`);
  }
  const full = lines.join('\n\n');
  if (full.length <= COMPACT_INPUT_MAX_CHARS) return full;
  const tail = full.slice(full.length - COMPACT_INPUT_MAX_CHARS);
  return `（注意：本次待压缩内容较长，以下仅保留**最后 ${COMPACT_INPUT_MAX_CHARS} 字符**，更早内容已省略）\n\n${tail}`;
}

/**
 * 生成压缩摘要。
 *
 * @throws ChatDisabledError 未配置模型（路由层据此改走截断式或拒绝）
 * @throws {Error} 上游失败 / 摘要为空（fail-loud：宁可压缩失败，也不静默丢历史）
 */
export async function summarizeForCompaction(
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const cfg = loadConfig();
  const status = resolveLlmStatus(cfg, cfg._configPath ?? '');
  if (!status.enabled) {
    throw new ChatDisabledError('未配置模型：无法生成摘要（可用截断式压缩，或先配置 llm 段）');
  }
  const llm = cfg.llm!;
  const transcript = buildCompactionTranscript(messages);

  const turns: ChatTurn[] = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: `待压缩对话：\n\n${transcript}` },
  ];

  let out = '';
  for await (const part of streamChat(turns, {
    signal,
    requestTimeoutMs: llm.requestTimeoutMs ?? CHAT_BUDGET.requestTimeoutMs,
    firstByteTimeoutMs: llm.firstByteTimeoutMs ?? CHAT_BUDGET.firstByteTimeoutMs,
    llm: {
      baseURL: llm.baseURL,
      apiKey: llm.apiKey,
      model: llm.model,
      temperature: llm.temperature,
      maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
    },
  })) {
    // reasoning 不参与摘要（它可能很长且与事实摘要无关）；只收 content
    if (part.type === 'content') out += part.text;
  }

  const summary = out.trim();
  if (summary.length === 0) {
    throw new Error('摘要生成为空（上游未返回正文）：已放弃本次压缩，会话未被修改');
  }
  return summary;
}
