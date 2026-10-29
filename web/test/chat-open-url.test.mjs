/**
 * AI 对话面板 URL 标记单测（lib/chatOpenUrl.ts）
 *
 * 背景（2026-10-14 用户裁决）：开合态的**跨刷新载体**从 localStorage 改为本标签页 URL 的
 * `chat=1` —— localStorage 同源跨标签页共享，两个标签页各开一份对话时，一个关掉会让另一个
 * 刷新后也被关掉（用户报的 Bug）。锁住三条不变量：
 *   1) 只有 `'1'` 视为打开（缺失 / `0` / `true` 等脏值一律关闭）；
 *   2) 打开写入 `chat=1`、关闭**移除**（不写 `chat=0`，与 `reader` 一样保持 URL 干净）；
 *   3) 合并写：页面自己的参数（scope/group/relation/anchor/reader）一个都不能丢。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { CHAT_OPEN_PARAM, chatOpenFromSearch, withChatOpenParam } =
  await vite.ssrLoadModule('/src/lib/chatOpenUrl.ts');
after(async () => vite.close());

describe('chatOpenFromSearch：只有 "1" 是打开', () => {
  it('缺失 / 空串 → 关闭（与「面板默认关闭」口径一致）', () => {
    assert.equal(chatOpenFromSearch(''), false);
    assert.equal(chatOpenFromSearch('scope=kisearch'), false);
  });

  it('chat=1 → 打开（带不带前缀 ? 都认）', () => {
    assert.equal(chatOpenFromSearch('chat=1'), true);
    assert.equal(chatOpenFromSearch('?chat=1'), true);
    assert.equal(chatOpenFromSearch('scope=kisearch&chat=1'), true);
  });

  it('脏值一律按关闭（手改 URL 不该把面板炸开）', () => {
    for (const bad of ['0', 'true', 'yes', '', ' 1', '1 ']) {
      assert.equal(chatOpenFromSearch(`chat=${encodeURIComponent(bad)}`), false, `chat=${bad}`);
    }
  });

  it('参数名契约', () => {
    assert.equal(CHAT_OPEN_PARAM, 'chat');
  });
});

describe('withChatOpenParam：打开写入 / 关闭移除', () => {
  it('打开写入 chat=1', () => {
    assert.equal(withChatOpenParam('', true).toString(), 'chat=1');
    assert.equal(withChatOpenParam('scope=kisearch', true).toString(), 'scope=kisearch&chat=1');
  });

  it('关闭移除 chat（不写 chat=0）', () => {
    assert.equal(withChatOpenParam('chat=1', false).toString(), '');
    assert.equal(withChatOpenParam('reader=1&chat=1', false).toString(), 'reader=1');
    assert.equal(withChatOpenParam('', false).toString(), '');
  });

  it('幂等：重复写同一状态不叠加参数', () => {
    assert.equal(withChatOpenParam('chat=1', true).toString(), 'chat=1');
    assert.equal(withChatOpenParam('', false).toString(), '');
  });
});

describe('withChatOpenParam：合并写不丢页面参数', () => {
  const browse = 'scope=kisearch&group=a%2Fb&relation=doc%2Fmd&anchor=%E4%B8%80&reader=1';

  it('打开：原参数保序保留', () => {
    assert.equal(withChatOpenParam(browse, true).toString(), `${browse}&chat=1`);
  });

  it('关闭：原参数一个不少', () => {
    assert.equal(withChatOpenParam(`${browse}&chat=1`, false).toString(), browse);
  });

  it('接受 URLSearchParams 实例（AppShell 用 setSearchParams 的函数式更新）', () => {
    const next = withChatOpenParam(new URLSearchParams('scope=kisearch'), true);
    assert.equal(next.get('scope'), 'kisearch');
    assert.equal(next.get('chat'), '1');
  });
});
