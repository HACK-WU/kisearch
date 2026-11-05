/**
 * ModuleDrawer 的 `member` 透传守卫。
 *
 * 背景：视图模式下浏览页读正文会 409 `AMBIGUOUS_VIEW_DOC`（同一 `group+relation`
 * 在多个成员库都存在）。修法是给 `doc/get` 传 `member`（来源库），
 * 但 `ModuleDrawer` 被 **4 个页面**共用 —— 加参数必须保证其余三页的请求**逐字节不变**，
 * 否则修一个页会改坏另外三个。
 *
 * 这些断言锁的就是「可选」这件事：不传 = 不拼参数 = 行为不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('getDocContent：member 是可选参数，不传时请求里不出现 member', () => {
  const src = read('src/api/httpApi.ts');
  assert.match(src, /member\?:\s*string/, 'member 必须是可选参数（否则三个既有调用方编译就挂）');
  assert.match(
    src,
    /if \(member\) params\.set\('member', member\)/,
    '只有传了才拼进 query —— 不传时 URL 与改造前完全一致',
  );
});

test('ModuleDrawer：member 可选 prop 且原样透传给 fetcher 的第 4 参', () => {
  const src = read('src/components/ModuleDrawer.tsx');
  assert.match(src, /member\?:\s*string/, 'prop 必须可选');
  assert.match(
    src,
    /fetcher\(scope, group, module, member\)/,
    'member 必须透传；漏传则视图模式下永远拿不到正文',
  );
});

test('四个共用页里只有 BrowsePage 传 member', () => {
  const pages = ['BrowsePage', 'SearchPage', 'DataSourcePage', 'ImportPage'];
  const withMember = [];

  for (const page of pages) {
    const src = read(`src/pages/${page}.tsx`);
    // 非贪婪到 `/>`：props 里的箭头函数 `=>` 不会提前截断
    const tag = src.match(/<ModuleDrawer[\s\S]*?\/>/);
    if (!tag) continue;
    if (/\bmember=/.test(tag[0])) withMember.push(page);
  }

  assert.deepEqual(
    withMember,
    ['BrowsePage'],
    `只有浏览页需要 member（它自己解析来源库）；其余三页拿到的 scope 就是真实库，`
      + `一旦给它们也传 member 就会改变既有请求。实际：${withMember.join(', ') || '(无)'}`,
  );
});
