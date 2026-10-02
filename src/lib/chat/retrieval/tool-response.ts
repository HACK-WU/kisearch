import { CHAT_BUDGET, type ChatToolResponse } from '../chat-contract.js';

/** Preserve every JSON field and value; only the serialized response's total length is bounded. */
export function serializeToolResponse(value: unknown): ChatToolResponse {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const limit = CHAT_BUDGET.maxToolResponseChars;
  const marker = `\n…[工具返回超过 ${limit} 字符，已截断]`;
  let originalChars = 0;
  let prefix = '';
  // Count Unicode code points and never split a surrogate pair or allocate an unbounded array.
  for (const char of text) {
    if (originalChars < limit - marker.length) prefix += char;
    originalChars += 1;
  }
  return {
    text: originalChars > limit ? prefix + marker : text,
    originalChars,
    truncated: originalChars > limit,
  };
}
