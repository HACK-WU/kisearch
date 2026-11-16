/**
 * agent 问答来源分组（REQ-20261116-003 · B0）
 *
 * 覆盖需求里最容易被改坏的三件事：
 * 1. 分组按来源渲染（本地 + 各 Token），且**不渲染任何写操作**（只读契约）；
 * 2. 「临期」用 retainDaysLeft 判定，**不用 contextExpired**（续接 TTL 10 分钟，恒亮无意义）；
 * 3. 搜索跨组过滤、过滤后不给「还有 N 条」（数字会误导）。
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
let AgentAskGroups;

const DAY = 86_400_000;
const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * DAY).toISOString();
const item = (id, title, { daysLeft = 7, ago = 0 } = {}) => ({
  id, title, rounds: 2, messageCount: 4,
  createdAt: iso(ago), lastActiveAt: iso(ago), retainUntil: iso(-daysLeft),
  retainDaysLeft: daysLeft, contextExpired: true, corrupted: false,
});

/** 三组 fixture：本地 3 条（含 1 条临期）、codex 1 条但总 12 条、cursor 1 条 */
const MOCK_GROUPS = [
  {
    id: 'local', kind: 'local', label: '本地连接', tokenDeleted: false,
    count: 3, hasMore: false, nextCursor: null,
    items: [
      item('a1', 'ki 导入流程分几个阶段？'),
      item('a2', 'daemon 启动报 worker not open 怎么查？'),
      item('a3', 'MCP 客户端调用超时是多少？', { daysLeft: 1, ago: 6 }),
    ],
  },
  {
    id: 'token:ab12cd34', kind: 'token', label: 'codex', tokenId: 'ab12cd34',
    tokenDeleted: false, count: 12, hasMore: true, nextCursor: 'x',
    items: [item('k1', 'ki 导入流程分几个阶段？')],
  },
  {
    id: 'token:ef567890', kind: 'token', label: 'cursor', tokenId: 'ef567890',
    tokenDeleted: false, count: 2, hasMore: true, nextCursor: 'y',
    items: [item('r1', '检索结果为什么带不到来源？')],
  },
];

before(async () => {
  vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ AgentAskGroups } = await vite.ssrLoadModule('/src/chat/AgentAskGroups.tsx'));
});

after(async () => { await vite?.close(); });

function render(props) {
  return renderToStaticMarkup(createElement(AgentAskGroups, { onSelect: () => {}, ...props }));
}

describe('agent 问答分组渲染', () => {
  it('按来源渲染本地连接与各 Token 分组', () => {
    const html = render({ groups: MOCK_GROUPS });
    assert.match(html, /本地连接/);
    assert.match(html, /codex/);
    assert.match(html, /cursor/);
    // 类型徽标区分"本机"与"Token"
    assert.match(html, /本机/);
    assert.match(html, /Token/);
    // 分组头必须是可折叠按钮（<p> 无法键盘操作）
    assert.match(html, /<button[^>]*class="ki-ask-grp[^"]*"[^>]*aria-expanded="true"/);
  });

  it('只读契约：不渲染改名 / 归档 / 删除入口', () => {
    const html = render({ groups: MOCK_GROUPS });
    assert.doesNotMatch(html, /ki-chat-conv__acts/);
    assert.doesNotMatch(html, /重命名/);
    assert.doesNotMatch(html, /归档会话/);
    assert.doesNotMatch(html, /删除会话/);
  });

  it('临期用 retainDaysLeft 判定，且不把 contextExpired 当列表状态', () => {
    const html = render({ groups: MOCK_GROUPS });
    assert.match(html, /仅剩 1 天/, 'retainDaysLeft<=1 的条目应出现「仅剩 N 天」');
    // 续接 TTL（10 分钟）对所有历史条目都为 true，绝不能变成「已过期」标签
    assert.doesNotMatch(html, /已过期/);
  });

  it('搜索跨组过滤：只剩命中的分组与条目', () => {
    const html = render({ groups: MOCK_GROUPS, keyword: '导入' });
    assert.match(html, /本地连接/);
    assert.match(html, /codex/);
    assert.doesNotMatch(html, /cursor/, '无命中的分组应整组消失');
    // 过滤后不给「还有 N 条」——剩余条数不可知，点开也未必有命中
    assert.doesNotMatch(html, /还有 \d+ 条/);
  });

  it('无数据时不渲染任何占位（左栏只剩人工会话）', () => {
    assert.equal(render({ groups: [] }), '');
  });

  it('错误态给出重试入口', () => {
    const html = render({ groups: MOCK_GROUPS, error: 'boom', onRetry: () => {} });
    assert.match(html, /Agent 问答加载失败/);
    assert.match(html, /重试/);
  });
});
