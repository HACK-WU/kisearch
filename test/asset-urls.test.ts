/**
 * asset-urls.test.ts —— 附件双链接取址（REQ-20261124-002 · S-04）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/asset-urls.test.ts
 *
 * 钉住降级方案的关键约束：
 *   - `apiUrl` 走 `/open/v1/asset`（对外契约面，Bearer-only）
 *   - `humanUrl` 走 `/api/asset`（浏览器语义，给人点开）
 *   - **`webEnabled=false` 也要能拼**（`requireWeb: false`）——API 端点与前端产物无关，
 *     这是与 `docUrl` 唯一的差别（`docUrl` 要求开了 `--web` 才有页面可点）
 *   - `publicUrl` 的子路径（反代 `/ki`）必须保留
 *   - ref 里的 `/`、中文、`#` 一律由 URLSearchParams 编码
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assetUrls, type DocLinkContext } from '../src/lib/mcp-tools/doc-link.js';
import type { WebRuntime } from '../src/lib/mcp-runtime.js';

const OFF: WebRuntime = { webEnabled: false, publicUrl: null };
const WEB: WebRuntime = { webEnabled: true, publicUrl: null };
const PUBLIC: WebRuntime = { webEnabled: false, publicUrl: 'https://ki.example.com/ki' };

const TARGET = { scope: 'img-demo', group: 'demo', path: 'shots/composer.png' };

function ctx(headers: Record<string, string>): DocLinkContext {
  return { requestInfo: { headers } };
}

function parse(url: string | undefined): URL {
  assert.ok(url, '期望生成链接，实际 undefined');
  return new URL(url);
}

describe('assetUrls：取址门槛与路径', () => {
  it('webEnabled=false 仍能拼出两条链接（与 docUrl 的差别所在）', () => {
    const { apiUrl, humanUrl } = assetUrls(TARGET, ctx({ host: '127.0.0.1:7423' }), OFF);
    assert.equal(parse(apiUrl).pathname, '/open/v1/asset');
    assert.equal(parse(humanUrl).pathname, '/api/asset');
  });

  it('webEnabled=true 行为一致（不与前端开关耦合）', () => {
    const a = assetUrls(TARGET, ctx({ host: '127.0.0.1:7423' }), WEB);
    const b = assetUrls(TARGET, ctx({ host: '127.0.0.1:7423' }), OFF);
    assert.deepEqual(a, b);
  });

  it('publicUrl 的子路径（反代 /ki）必须保留', () => {
    const { apiUrl, humanUrl } = assetUrls(TARGET, {}, PUBLIC);
    assert.equal(parse(apiUrl).pathname, '/ki/open/v1/asset');
    assert.equal(parse(humanUrl).pathname, '/ki/api/asset');
    assert.equal(parse(apiUrl).origin, 'https://ki.example.com');
  });

  it('三条 query 参数完整（scope / group / path）', () => {
    const u = parse(assetUrls(TARGET, ctx({ host: '127.0.0.1:7423' }), OFF).apiUrl);
    assert.equal(u.searchParams.get('scope'), TARGET.scope);
    assert.equal(u.searchParams.get('group'), TARGET.group);
    assert.equal(u.searchParams.get('path'), TARGET.path);
  });
});

describe('assetUrls：编码与降级', () => {
  it('ref 含子目录 / 中文 / # / 空格 → 由 URLSearchParams 编码并可原样还原', () => {
    const tricky = 'assets/image/知识库录入/a b#1.png';
    const u = parse(assetUrls({ ...TARGET, path: tricky }, ctx({ host: '127.0.0.1:7423' }), OFF).apiUrl);
    assert.equal(u.searchParams.get('path'), tricky);
    assert.ok(!u.search.includes(' '), '空格必须被编码，不能裸出现在 query');
  });

  it('既无 publicUrl 也无请求头 → 返回空对象（不产出占位地址）', () => {
    assert.deepEqual(assetUrls(TARGET, {}, OFF), {});
  });

  it('scope / group / path 任一为空 → 返回空对象', () => {
    const h = ctx({ host: '127.0.0.1:7423' });
    assert.deepEqual(assetUrls({ ...TARGET, scope: '' }, h, OFF), {});
    assert.deepEqual(assetUrls({ ...TARGET, group: '' }, h, OFF), {});
    assert.deepEqual(assetUrls({ ...TARGET, path: '' }, h, OFF), {});
  });

  it('publicUrl 非法（非 http/https）→ 返回空对象', () => {
    assert.deepEqual(assetUrls(TARGET, {}, { webEnabled: true, publicUrl: 'ftp://x/y' }), {});
  });
});
