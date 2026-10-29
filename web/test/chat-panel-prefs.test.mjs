/**
 * AI 对话面板偏好（**宽度**）单测
 *
 * 锁住三条不变量：
 *   1) 宽度钳制：默认 380；下限 320；上限 min(720, 视口×50%)；
 *   2) 坏值兜底：非数值 / 空 / 越界一律收敛到合法区间（localStorage 里可能躺着任何脏数据）；
 *   3) 存储不可用（隐私模式 / setItem 抛错）时读写都不抛，读回默认值。
 *
 * 开合态已不在本模块：2026-10-14 起由 URL 承载（见 test/chat-open-url.test.mjs）。
 *
 * 运行：cd web && npm run test
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
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  chatPanelWidthUpperBound,
  clampChatPanelWidth,
  readChatPanelWidth,
  writeChatPanelWidth,
} = await vite.ssrLoadModule('/src/lib/chatPanelPrefs.ts');
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

describe('clampChatPanelWidth', () => {
  it('区间内的值原样保留', () => {
    assert.equal(clampChatPanelWidth(420, 1600), 420);
  });

  it('低于下限钳到 320', () => {
    assert.equal(clampChatPanelWidth(120, 1600), CHAT_PANEL_MIN_WIDTH);
  });

  it('高于绝对上限钳到 720（视口很宽时）', () => {
    assert.equal(clampChatPanelWidth(9999, 4000), CHAT_PANEL_MAX_WIDTH);
  });

  it('上限不超过视口一半（视口 1000 → 500）', () => {
    assert.equal(clampChatPanelWidth(9999, 1000), 500);
  });

  it('视口极窄时下限优先，不产生小于 320 的宽度', () => {
    assert.equal(clampChatPanelWidth(9999, 600), CHAT_PANEL_MIN_WIDTH);
  });

  it('非数值 / 空值 → 默认 380（脏数据兜底）', () => {
    for (const bad of ['abc', '', '  ', null, undefined, NaN, {}, []]) {
      assert.equal(clampChatPanelWidth(bad, 1600), CHAT_PANEL_DEFAULT_WIDTH, `bad=${String(bad)}`);
    }
  });

  it('视口非法（NaN / 0 / 负数）→ 退回绝对上限', () => {
    for (const vw of [NaN, 0, -100, Infinity]) {
      assert.equal(clampChatPanelWidth(9999, vw), CHAT_PANEL_MAX_WIDTH, `vw=${vw}`);
    }
  });

  it('小数取整', () => {
    assert.equal(clampChatPanelWidth(420.7, 1600), 421);
  });
});

describe('chatPanelWidthUpperBound', () => {
  it('视口一半小于绝对上限时取视口一半', () => {
    assert.equal(chatPanelWidthUpperBound(1200), 600);
  });

  it('视口很宽时取绝对上限 720', () => {
    assert.equal(chatPanelWidthUpperBound(3000), CHAT_PANEL_MAX_WIDTH);
  });

  it('视口极窄时不小于下限（避免出现上限 < 下限）', () => {
    assert.equal(chatPanelWidthUpperBound(400), CHAT_PANEL_MIN_WIDTH);
  });
});

describe('readChatPanelWidth / writeChatPanelWidth', () => {
  it('无记录 → 默认值', () => {
    assert.equal(readChatPanelWidth(1600), CHAT_PANEL_DEFAULT_WIDTH);
  });

  it('写入后按同一视口读回', () => {
    writeChatPanelWidth(520);
    assert.equal(readChatPanelWidth(1600), 520);
  });

  it('脏值 → 默认值（不抛错）', () => {
    localStorage.setItem('ki.chatPanelWidth', 'not-a-number');
    assert.equal(readChatPanelWidth(1600), CHAT_PANEL_DEFAULT_WIDTH);
  });

  it('越界值按当前视口收敛：存储 700，视口 1000 → 500', () => {
    localStorage.setItem('ki.chatPanelWidth', '700');
    assert.equal(readChatPanelWidth(1000), 500);
    // 偏好不回写存储：换回宽视口仍是用户当初的 700
    assert.equal(readChatPanelWidth(1600), 700);
  });

  it('存储不可用：读回默认、写入不抛', () => {
    installStorage({ throws: true });
    assert.equal(readChatPanelWidth(1600), CHAT_PANEL_DEFAULT_WIDTH);
    assert.doesNotThrow(() => writeChatPanelWidth(500));
  });
});


