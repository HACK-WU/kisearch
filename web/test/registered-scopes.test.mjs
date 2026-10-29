/**
 * 总览页「显示注册 scope」卡片纯逻辑单测（2026-10-28）
 *
 * 锁住：
 *   1) 只挑 registered=true 的 scope，顺序不变（= 接口返回的字典序）；
 *   2) scopeMode 未知回退 default（旧 daemon 不返回该字段时不得误显示 strict）。
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
const {
  normalizeScopeMode,
  registeredScopesOf,
} = await vite.ssrLoadModule('/src/lib/registeredScopes.ts');
after(async () => vite.close());

const sample = [
  { scope: 'ai-docs', registered: false, wikiCount: 1882 },
  { scope: 'default', registered: true, wikiCount: 12 },
  { scope: 'kisearch', registered: true, wikiCount: 162 },
  { scope: 'probe-x', registered: false, wikiCount: 0 },
];

describe('registeredScopesOf', () => {
  it('只保留 registered=true，且保持原顺序', () => {
    assert.deepEqual(
      registeredScopesOf(sample).map((s) => s.scope),
      ['default', 'kisearch'],
    );
  });

  it('未加载 / 空列表返回空数组（调用方渲染空态，而不是崩）', () => {
    assert.deepEqual(registeredScopesOf(undefined), []);
    assert.deepEqual(registeredScopesOf(null), []);
    assert.deepEqual(registeredScopesOf([]), []);
  });

  it('不丢字段（wikiCount / wikiSync 等由组件继续消费）', () => {
    const wiki = { enabled: true, writableDir: '/tmp/wiki', writableFrom: 'wiki-sync' };
    const [hit] = registeredScopesOf([{ scope: 'a', registered: true, wikiCount: 3, wikiSync: wiki }]);
    assert.equal(hit.wikiCount, 3);
    assert.equal(hit.wikiSync, wiki);
  });
});

describe('normalizeScopeMode', () => {
  it('只认 strict，其余一律回退 default', () => {
    assert.equal(normalizeScopeMode('strict'), 'strict');
    assert.equal(normalizeScopeMode('default'), 'default');
    for (const bad of [undefined, null, '', 'STRICT', 'strick']) {
      assert.equal(normalizeScopeMode(bad), 'default', String(bad));
    }
  });
});
