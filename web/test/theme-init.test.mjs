/**
 * 主题初始化单测（lib/theme.ts 的 applyStoredTheme）
 *
 * 背景（2026-11-23，事件 #70 修复的配套）：写 `<body data-theme>` 有两个入口 ——
 * `main.tsx` 首渲染前初始化、AppShell 的切换器。此前只有后者，而**登录页**与
 * **「页面不存在」兜底页**渲染在 AppShell 之外，暗色用户会看到亮色页面（实测 body 无
 * data-theme、背景仍是 #f5f6f3）。锁住四条不变量：
 *   1) localStorage 键名保持 `ki-theme` —— 改名会让老用户的偏好静默丢失；
 *   2) 已存 dark / light → body 属性与之一致；
 *   3) 键缺失或值非法 → 落 light，不能让 body 处于无属性状态；
 *   4) 无 document（SSR / node 环境）时不抛错。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
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
const { applyStoredTheme, THEME_STORAGE_KEY } = await vite.ssrLoadModule('/src/lib/theme.ts');
after(async () => vite.close());

const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
const lsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

/** 注入最小 document / localStorage 桩，模拟浏览器侧 */
function withBrowserEnv(stored, fn) {
  const body = { dataset: {} };
  Object.defineProperty(globalThis, 'document', {
    value: { body },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => (key === THEME_STORAGE_KEY ? stored : null),
      setItem: () => {},
      removeItem: () => {},
    },
    configurable: true,
    writable: true,
  });
  try {
    fn(body);
  } finally {
    restore();
  }
}

function restore() {
  if (docDesc) Object.defineProperty(globalThis, 'document', docDesc);
  else delete globalThis.document;
  if (lsDesc) Object.defineProperty(globalThis, 'localStorage', lsDesc);
  else delete globalThis.localStorage;
}

afterEach(restore);

describe('applyStoredTheme：把已保存的偏好落到 <body data-theme>', () => {
  it('localStorage 键名保持 ki-theme（改名会让老用户偏好静默丢失）', () => {
    assert.equal(THEME_STORAGE_KEY, 'ki-theme');
  });

  it('已存 dark → body 属性为 dark', () => {
    withBrowserEnv('dark', (body) => {
      applyStoredTheme();
      assert.equal(body.dataset.theme, 'dark');
    });
  });

  it('已存 light → body 属性为 light', () => {
    withBrowserEnv('light', (body) => {
      applyStoredTheme();
      assert.equal(body.dataset.theme, 'light');
    });
  });

  it('键缺失 → 落 light（不能留无属性状态，否则暗色 CSS 变量与 SVG 判色都会跑偏）', () => {
    withBrowserEnv(null, (body) => {
      applyStoredTheme();
      assert.equal(body.dataset.theme, 'light');
    });
  });

  it('值非法（如 blue）→ 落 light，不把非法值写进 body', () => {
    withBrowserEnv('blue', (body) => {
      applyStoredTheme();
      assert.equal(body.dataset.theme, 'light');
    });
  });

  it('无 document（SSR / node）时不抛错', () => {
    assert.doesNotThrow(() => applyStoredTheme());
  });
});
