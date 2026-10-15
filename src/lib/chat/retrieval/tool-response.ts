import { CHAT_BUDGET, type ChatToolResponse } from '../chat-contract.js';

/**
 * Preserve every JSON field and value; only the serialized response's total length is bounded.
 *
 * @param limit 本次序列化使用的字符上限（REQ-20261015-001：来自运行时配置的生效值）。
 *   **缺省 = 内置默认**，既有调用方零改动。
 */
export function serializeToolResponse(
  value: unknown,
  limit: number = CHAT_BUDGET.maxToolResponseChars,
): ChatToolResponse {
  const text = JSON.stringify(value, null, 2) ?? 'null';
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
    limit,
  };
}
