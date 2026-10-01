import type { ChatEvent } from '../../../src/lib/chat/chat-contract.js';

const meta = (): ChatEvent => ({ type: 'meta', conversationId: 'c-mock-0001', messageId: 'm2', model: 'mock-model' });
const source = { group: 'kisearch', doc: 'ki_search 用法', lineStart: 12, lineEnd: 18, snippet: 'ki_search 支持全文检索。' };
const done = (sources: typeof source[] = []): ChatEvent => ({ type: 'done', messageId: 'm2', finishReason: 'stop', sources });

export function retrievalAnswerFlow(): ChatEvent[] {
  return [
    meta(),
    { type: 'tool_start', name: 'kb_search', query: 'ki_search', mode: 'fulltext' },
    { type: 'tool_end', hits: 1, durationMs: 2 },
    { type: 'reasoning', text: '根据已检索的知识回答。' },
    { type: 'content', text: '（mock）根据知识库，' },
    { type: 'content', text: '`ki_search` 支持 `mode=fulltext`。' },
    { type: 'sources', sources: [source] },
    { type: 'usage', promptTokens: 10, completionTokens: 20 },
    done([source]),
  ];
}

export function degradedFlow(): ChatEvent[] {
  return [meta(), { type: 'degraded', reason: 'tools-unsupported', message: '本次未使用工具检索' }, { type: 'content', text: '（mock）降级回答' }, done()];
}

export function retrievalUnavailableFlow(): ChatEvent[] {
  return [meta(), { type: 'tool_start', name: 'kb_search', query: 'x', mode: 'fulltext' },
    { type: 'tool_end', hits: 0, durationMs: 2, error: '检索不可用' },
    { type: 'degraded', reason: 'retrieval-unavailable', message: '本次检索不可用' },
    { type: 'content', text: '（mock）无法检索，已明确提示' }, done()];
}

export function abortedFlow(): ChatEvent[] {
  return [meta(), { type: 'content', text: '（mock 部分回答）' }, { type: 'aborted', messageId: 'm2' }];
}
