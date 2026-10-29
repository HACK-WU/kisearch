/**
 * 检索页展示偏好单测（lib/searchPrefs.ts，REQ-20261014-003 R2 / R7）
 *
 * 锁住三条不变量：
 *   1) **默认开**：键缺失 / 坏值 / 存储不可用都回默认（Q4 裁决：混合检索默认高亮）；
 *   2) **只认 `'1'` / `'0'`**：`''`、`'true'`、`'yes'` 等一律回默认，不得被当成真值
 *      （沿用 chatPanelPrefs 的存储约定，避免"用户从没设过却显示为关"）；
 *   3) **写失败不抛**：隐私模式 / 存储禁用不能打断检索页交互（静默降级）。
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
const { DOC_HIGHLIGHT_DEFAULT, readDocHighlight, writeDocHighlight } =
  await vite.ssrLoadModule('/src/lib/searchPrefs.ts');
after(async () => vite.close());

/** 内存版 localStorage：记录写入次数，便于断言"写失败也不抛" */
function installLocalStorage(initial = {}) {
  const store = { ...initial };
  const calls = { set: 0 };
  globalThis.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      calls.set += 1;
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
  };
  return { store, calls };
}

describe('searchPrefs / 默认与读取', () => {
  it('默认开：本需求把默认值定为 true（Q4）', () => {
    assert.equal(DOC_HIGHLIGHT_DEFAULT, true);
  });

  it('键缺失 → 默认开', () => {
    installLocalStorage();
    assert.equal(readDocHighlight(), true);
  });

  it('显式关闭（\'0\'）→ false；显式开启（\'1\'）→ true', () => {
    installLocalStorage({ 'ki.searchDocHighlight': '0' });
    assert.equal(readDocHighlight(), false);
    installLocalStorage({ 'ki.searchDocHighlight': '1' });
    assert.equal(readDocHighlight(), true);
  });

  it('坏值（空串 / \'true\' / \'yes\'）不被当作真值，一律回默认', () => {
    for (const bad of ['', 'true', 'yes', '2']) {
      installLocalStorage({ 'ki.searchDocHighlight': bad });
      assert.equal(readDocHighlight(), DOC_HIGHLIGHT_DEFAULT, `坏值 ${JSON.stringify(bad)} 应回默认`);
    }
  });

  it('无 localStorage（Node 环境）→ 默认开，且不抛异常', () => {
    delete globalThis.localStorage;
    assert.equal(readDocHighlight(), true);
  });
});

describe('searchPrefs / 写入', () => {
  it('写入 \'1\' / \'0\' 并与读取往返一致', () => {
    const { store } = installLocalStorage();
    writeDocHighlight(false);
    assert.equal(store['ki.searchDocHighlight'], '0');
    assert.equal(readDocHighlight(), false);
    writeDocHighlight(true);
    assert.equal(store['ki.searchDocHighlight'], '1');
    assert.equal(readDocHighlight(), true);
  });

  it('存储不可用（setItem 抛错）→ 静默不抛，读取回默认', () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.doesNotThrow(() => writeDocHighlight(false));
    assert.equal(readDocHighlight(), true);
  });
});
