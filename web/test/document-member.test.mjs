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

test('ModuleDrawer：写入口（编辑/添加链接/移动/删除）必须用来源库 docScope', () => {
  const src = read('src/components/ModuleDrawer.tsx');
  // 三个来源逐级回落：调用方解析的 member → 读正文回填的 scope → 导航值。
  // 必须是 `||`：`member` 可能来自 URL（`&member=` → `''`），`??` 挡不住空串，
  // 空串会让请求变成 `scope=`，后端 resolveScope('') 回落 default 库 → 退回「文档不存在」。
  assert.match(
    src,
    /const docScope = member \|\| resolvedScope \|\| scope;/,
    'docScope 必须按 member → resolvedScope → scope 回落，且空串视为未给',
  );
  assert.match(src, /member: docScope,/, '编辑器请求必须带真实库，否则保存被 VIEW_NOT_WRITABLE 拒');
  // 正文里的图片：/api/asset 只认 dataDir/<库名>，视图名会让整篇图片 404
  assert.match(src, /assetBase=\{group \? \{ scope: docScope, group,/, '图片 assetBase 必须用真实库');
  // 只读判定：视图名查不到 scopes[].readonly，也匹配不到 memberMeta[].scope
  assert.match(src, /useScopeReadonly\(docScope\)/, '只读判定必须查真实库');
  assert.match(src, /useViewMemberReadonly\(topScope, docScope\)/, '视图成员只读判定必须传成员库');
  assert.match(src, /docScope=\{docScope\}/, '添加链接：加载/保存当前这篇必须走真实库');
  assert.equal(
    (src.match(/scope=\{docScope\}/g) ?? []).length,
    2,
    '移动与删除弹窗都必须拿真实库（视图名会让预检返回 exists:false 假回执）',
  );

  const tagOf = (name) => {
    const matched = src.match(new RegExp(`<${name}[\\s\\S]*?/>`));
    assert.ok(matched, `找不到 <${name}' 标签`);
    return matched[0];
  };
  // 反向锁：这两个弹窗没有「跨库搜索」语义，吃到导航 scope 就是回归
  for (const name of ['DocMoveDialog', 'DocDeleteDialog']) {
    assert.ok(!/scope=\{scope\}/.test(tagOf(name)), `<${name}> 不得再吃导航 scope（视图下会写错库）`);
  }
});

test('AppShell：DocumentEditor 吃来源库，列表缓存仍按导航 scope 失效', () => {
  const src = read('src/layouts/AppShell.tsx');
  assert.match(src, /scope=\{editorRequest\.member \|\| editorRequest\.scope\}/, '编辑器 scope 必须是真实库');
  assert.match(
    src,
    /key=\{`\$\{editorRequest\.member \|\| editorRequest\.scope\}/,
    'key 必须含 member：同 scope 里两个成员库的同名文档要重挂载',
  );
  assert.match(
    src,
    /invalidateQueries\(\{ queryKey: \['docList', editorRequest\.scope\] \}\)/,
    'docList 的 queryKey 挂的是导航 scope，失效必须沿用它（换成 member 将失效错键）',
  );
});

test('ReaderLinkComposer：搜索走视图、读写当前文档走 docScope', () => {
  const src = read('src/components/ReaderLinkComposer.tsx');
  assert.match(src, /docScope\?: string/, 'docScope 必须可选（ref 模式与单库调用方不传）');
  assert.match(src, /const editScope = docScope \|\| scope;/, '缺省回落 scope（空串同样视为未给）');
  assert.match(src, /getEditableDocument\(editScope, group, relation\)/, '读取待编辑原文必须用真实库');
  assert.match(src, /scope: editScope, group, relation, content,/, '保存必须用真实库');
  assert.match(src, /useDocSearch\(scope, searchQ\)/, '目标文档搜索必须保持全视图（收窄成成员库会漏）');
});

test('后端读通道：doc/edit GET 与 doc/delete 预检都挡住视图名', () => {
  const src = read('../src/lib/mcp-http-api.ts');
  assert.match(src, /function rejectIfScopeView\(/, '必须有统一的视图门禁 helper');
  assert.match(src, /rejectIfScopeView\(res, scope, 'doc-edit-read', requestConfig\)/,
    'doc/edit GET 不过写锁，视图名会报成 404「文档不存在」');
  assert.match(src, /rejectIfScopeView\(res, scope, 'doc-delete-precheck', requestConfig\)/,
    'doc/delete 预检不过写锁，视图名会返回 200 exists:false 假回执');
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

test('聊天来源引用：scope 从命中透传到抽屉（否则视图下取图按视图名 404）', () => {
  // 后端：SourceRef 加可选 scope，toSourceRefs 从命中里填
  const contract = read('../src/lib/chat/chat-contract.ts');
  assert.match(contract, /export interface SourceRef \{[\s\S]*?\n {2}scope\?: string;/, 'SourceRef 必须有可选 scope');

  const projection = read('../src/lib/chat/retrieval/projection.ts');
  assert.match(
    projection,
    /const h = hit as \{ group\?: string; relation\?: string; scope\?: string \};/,
    '视图检索时命中自带来源库，投影要把它读出来',
  );
  assert.match(projection, /\.\.\.\(h\.scope \? \{ scope: h\.scope \} : \{\}\)/, '无 scope 时不得凭空写字段');

  // 前端：契约镜像 + 抽屉透传
  assert.match(read('src/api/chatContract.ts'), /export interface SourceRef \{[\s\S]*?\n {2}scope\?: string;/, '前端 SourceRef 必须与后端同形');
  const panel = read('src/chat/ChatPanel.tsx');
  assert.match(panel, /member: ref\.scope/, '点开来源必须带上真实库');
  assert.match(panel, /member=\{viewing\.member\}/, '抽屉要拿到来源库（undefined 由 ModuleDrawer 回落）');
  assert.match(panel, /key=\{`\$\{scope\}:\$\{viewing\.member \?\? ''\}/, 'key 含 member：两个成员库的同名文档要重挂载');
});
