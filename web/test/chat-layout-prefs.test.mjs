/**
 * 对话页布局偏好（内容宽度模式 + 左栏折叠态）单测 —— REQ-20261016-004
 *
 * 锁住四条不变量：
 *   1) 默认：宽度 `center`（用户拍板「默认是居中」）、左栏展开；
 *   2) 脏值兜底：**只认字面量**（`full` / `true`），其余一律回默认 —— localStorage 里可能躺着任何东西；
 *   3) 存储不可用（隐私模式 / setItem 抛错）时读写都不抛，读回默认值；
 *   4) 两个偏好互不干扰（写一个不影响另一个）。
 *
 * ⚠️ 这里只锁「偏好层」；「窄屏不回写偏好」由 `CHAT_PAGE_SIDE_MIN_VIEWPORT` 在组件里把关，
 *    属走查范围（temp/verify-chat-layout-prefs.cjs），不在纯逻辑单测内。
 *
 * 加载方式与 `chat-panel-prefs.test.mjs` 一致：vite `ssrLoadModule` 直载 TS 源码。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
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
const {
  CHAT_CONTENT_WIDTH_DEFAULT,
  parseChatContentWidth,
  readChatContentWidth,
  writeChatContentWidth,
  parseSideCollapsed,
  readChatpageSideCollapsed,
  writeChatpageSideCollapsed,
} = await vite.ssrLoadModule('/src/lib/chatLayoutPrefs.ts');
after(async () => vite.close());

/** 最小 localStorage 替身；`throws: true` 模拟隐私模式 / 存储被禁用 */
function installStorage({ throws = false } = {}) {
  const map = new Map();
  globalThis.localStorage = {
    getItem(key) {
      if (throws) throw new Error('storage blocked');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throws) throw new Error('storage blocked');
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throws) throw new Error('storage blocked');
      map.delete(key);
    },
  };
  return map;
}

beforeEach(() => installStorage());

describe('内容宽度模式 · parseChatContentWidth', () => {
  it('只认字面量 full，其余一律回 center（默认居中）', () => {
    assert.equal(parseChatContentWidth('full'), 'full');
    for (const bad of ['center', 'FULL', 'Full', ' full', 'full ', '', '  ', null, undefined, 0, 1, true, {}, []]) {
      assert.equal(parseChatContentWidth(bad), CHAT_CONTENT_WIDTH_DEFAULT, `bad=${String(bad)}`);
    }
  });

  it('默认值是 center', () => {
    assert.equal(CHAT_CONTENT_WIDTH_DEFAULT, 'center');
  });
});

describe('内容宽度模式 · 读写', () => {
  it('无记录 → 默认 center', () => {
    assert.equal(readChatContentWidth(), CHAT_CONTENT_WIDTH_DEFAULT);
  });

  it('写入 full 后读回 full；再写回 center 亦生效', () => {
    writeChatContentWidth('full');
    assert.equal(readChatContentWidth(), 'full');
    writeChatContentWidth('center');
    assert.equal(readChatContentWidth(), 'center');
  });

  it('存储里的脏值 → 默认 center（不抛错）', () => {
    localStorage.setItem('ki.chatContentWidth', 'wide');
    assert.equal(readChatContentWidth(), CHAT_CONTENT_WIDTH_DEFAULT);
  });

  it('存储不可用：读回默认、写入不抛', () => {
    installStorage({ throws: true });
    assert.equal(readChatContentWidth(), CHAT_CONTENT_WIDTH_DEFAULT);
    assert.doesNotThrow(() => writeChatContentWidth('full'));
  });
});

describe('左栏折叠态 · parseSideCollapsed', () => {
  it('只认字面量 true，其余一律展开', () => {
    assert.equal(parseSideCollapsed('true'), true);
    for (const bad of ['false', 'TRUE', 'True', ' true', 'true ', '1', '', '  ', null, undefined, 1, 0, true, {}, []]) {
      assert.equal(parseSideCollapsed(bad), false, `bad=${String(bad)}`);
    }
  });
});

describe('左栏折叠态 · 读写', () => {
  it('无记录 → 展开（不会把新用户丢进「找不到会话列表」的状态）', () => {
    assert.equal(readChatpageSideCollapsed(), false);
  });

  it('写入 true 后读回 true；写 false 可恢复展开', () => {
    writeChatpageSideCollapsed(true);
    assert.equal(readChatpageSideCollapsed(), true);
    writeChatpageSideCollapsed(false);
    assert.equal(readChatpageSideCollapsed(), false);
  });

  it('存储里的脏值 → 展开（不抛错）', () => {
    localStorage.setItem('ki.chatpageSideCollapsed', 'yes');
    assert.equal(readChatpageSideCollapsed(), false);
  });

  it('存储不可用：读回展开、写入不抛', () => {
    installStorage({ throws: true });
    assert.equal(readChatpageSideCollapsed(), false);
    assert.doesNotThrow(() => writeChatpageSideCollapsed(true));
  });
});

describe('两个偏好互不干扰', () => {
  it('写宽度不影响折叠态，写折叠不影响宽度', () => {
    writeChatContentWidth('full');
    writeChatpageSideCollapsed(true);
    assert.equal(readChatContentWidth(), 'full');
    assert.equal(readChatpageSideCollapsed(), true);

    writeChatContentWidth('center');
    assert.equal(readChatContentWidth(), 'center');
    assert.equal(readChatpageSideCollapsed(), true, '改宽度不得连带改动折叠态');

    writeChatpageSideCollapsed(false);
    assert.equal(readChatContentWidth(), 'center', '改折叠不得连带改动宽度');
  });
});
