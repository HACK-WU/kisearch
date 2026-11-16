/**
 * agent 问答只读详情（REQ-20261116-003 · B0.5）
 *
 * 守三件事：
 * 1. **只读**：不渲染 textarea / 编辑 / 重发 / 反馈（`ka-*` 的写入方只有 MCP 通道）；
 * 2. **背景**：只有带 `background` 的那一轮才出现「提问前提」，且不渲染成原始字段名；
 * 3. **来源与 Token 删除兜底**：来源 chip 可渲染；`tokenDeleted` 时文案要说明"Token 已删除"。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
let vite;
let AgentAskDetail;

const AT = '2026-11-16T04:00:00.000Z';

/** 一轮带背景 + 一轮追问（第 2 轮没有 background，用来守"只有带的那轮才渲染"） */
const DETAIL = {
  id: 'ka-m9x2k1-3f7a91c4d8e2b5a607f3c1d9e8b4a2f6',
  scope: 'kisearch-memory',
  origin: { kind: 'local', label: '本地连接', tokenDeleted: false },
  createdAt: AT,
  lastActiveAt: AT,
  retainUntil: '2026-11-23T04:00:00.000Z',
  messages: [
    {
      role: 'user', content: 'ki 导入流程分几个阶段？', at: AT,
      background: '项目 kisearch 0.1.0，正在把 3 个 Git 仓库的文档迁进来。',
    },
    {
      role: 'assistant', content: '分三个阶段：预检、解析与切分、建索引。', at: AT,
      sources: [
        { group: '部署运维', doc: '构建知识库', lineStart: 12, lineEnd: 40, snippet: '三段式' },
        { group: '专题记忆', doc: '数据流', lineStart: 8, lineEnd: 22, snippet: '链路' },
      ],
    },
    { role: 'user', content: '第二阶段支持增量吗？', at: AT },
    { role: 'assistant', content: '支持，同一 sourcePath 重导即覆盖更新。', at: AT },
  ],
};

const mockDetailFor = () => DETAIL;

before(async () => {
  vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ AgentAskDetail } = await vite.ssrLoadModule('/src/chat/AgentAskDetail.tsx'));
});

after(async () => { await vite?.close(); });

const DETAIL_ID = 'ka-m9x2k1-3f7a91c4d8e2b5a607f3c1d9e8b4a2f6';

function render(detail) {
  return renderToStaticMarkup(createElement(AgentAskDetail, { detail }));
}

describe('agent 问答只读详情', () => {
  it('渲染来源条、提问背景与来源 chip', () => {
    const html = render(mockDetailFor(DETAIL_ID));
    assert.match(html, /本地连接/, '本地来源应显示分组名');
    assert.match(html, /只读/);
    assert.match(html, /ki-ask-bg__label[^>]*>[\s\S]*?提问前提 · \d+ 字/, '背景块应带字数');
    assert.match(html, /ki-chat-srcs/, '助手消息下方应有来源列表');
  });

  it('只读契约：不渲染输入框与消息级写操作', () => {
    const html = render(mockDetailFor(DETAIL_ID));
    assert.doesNotMatch(html, /<textarea/);
    assert.doesNotMatch(html, /ki-chat-composer/);
    assert.doesNotMatch(html, /ki-chat-msg__acts/);
    assert.doesNotMatch(html, /保存并重发/);
  });

  it('只有带 background 的那一轮出现背景块（同一会话第二轮没有）', () => {
    const detail = mockDetailFor(DETAIL_ID);
    const withBg = detail.messages.filter((m) => m.background).length;
    const html = render(detail);
    const rendered = (html.match(/ki-ask-bg__label/g) ?? []).length;
    assert.equal(rendered, withBg, '背景块数量应等于带 background 的消息数');
  });

  it('Token 已删除时给出兜底文案（分组名 + 「已删除」）', () => {
    const detail = mockDetailFor(DETAIL_ID);
    const html = render({
      ...detail,
      origin: { kind: 'token', tokenId: 'ab12cd34', label: 'codex', tokenDeleted: true },
    });
    assert.match(html, /codex/);
    assert.match(html, /该 Token 已删除/);
  });
});
