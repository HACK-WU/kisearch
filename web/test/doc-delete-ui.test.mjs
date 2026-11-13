/**
 * doc-delete-ui.test.mjs —— 文档删除入口的静态守卫（2026-11-13）
 *
 * 交互走查在真机做（不随仓库走），这里只挡会被"顺手清理"掉的**结构性约定**：
 *   1. 删除入口与「编辑文档」同门禁（只读库置灰）+ 没有 onDeleted 的调用方不渲染 + 窄屏必须有入口
 *   2. 编辑器开着时不许删（编辑器改的就是这篇，删了之后保存会 404）
 *   3. 二次确认必须**先预检**再让点（源文件落点 / 草稿 / 数据源都要提前说清）
 *   4. 「同时删除源文件」勾选只在源文件真的存在时出现（摆出来却不删比不显示更糟）
 *   5. Esc 让给弹窗；删除成功后页面跟着收起（列表 / URL / 回执）
 *   6. 前后端契约登记齐全（路由 / 权限 / 只读门禁 / 写锁）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const drawer = read('src/components/ModuleDrawer.tsx');
const dialog = read('src/components/DocDeleteDialog.tsx');
const browse = read('src/pages/BrowsePage.tsx');
const css = read('src/styles/ki.css');
const api = read('src/api/httpApi.ts');
const serverRoute = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'mcp-http-api.ts'), 'utf-8');
const routePerm = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'auth', 'route-permissions.ts'), 'utf-8');
const scopePolicy = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'scope-policy.ts'), 'utf-8');
const serverModule = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'doc-delete.ts'), 'utf-8');

test('删除入口与「编辑文档」同一门禁，且没有 onDeleted 的调用方不渲染', () => {
  assert.match(
    drawer,
    /\{editable && group && content !== null && onDeleted && \(/,
    '宽条「删除」必须与编辑文档同门禁（editable + 有 group + 有正文 + 有人接后续导航）',
  );
  assert.ok(drawer.includes('ki-drawer__copy--danger'), '宽条删除按钮缺少样式钩子类');
  const block = drawer.slice(drawer.indexOf('ki-drawer__copy--danger') - 500, drawer.indexOf('ki-drawer__copy--danger') + 500);
  assert.ok(block.includes('docWriteDisabled'), '「删除」必须与编辑文档共用 docWriteDisabled（只读库置灰）');
  // 窄屏：菜单里也要有（隐藏平铺版不等于功能可达）
  assert.ok(
    drawer.includes('setDeleteOpen(true); }}\n                    >删除</button>'),
    '窄屏「⋯」菜单必须提供删除入口',
  );
  assert.ok(drawer.includes('ki-drawer__overflow-item--danger'), '窄屏删除项要带危险样式钩子');
});

test('编辑器开着时不许删（改的正是这篇，删了保存会 404）', () => {
  const block = drawer.slice(drawer.indexOf('ki-drawer__copy--danger') - 500, drawer.indexOf('ki-drawer__copy--danger') + 500);
  assert.ok(block.includes('editor.isOpen'), '删除按钮必须判 editor.isOpen');
  assert.ok(block.includes('请先关闭编辑器再删除'), '禁用时要说清为什么（title），不能只是变灰');
  const menuBlock = drawer.slice(drawer.indexOf('ki-drawer__overflow-item--danger') - 400, drawer.indexOf('ki-drawer__overflow-item--danger') + 400);
  assert.ok(menuBlock.includes('editor.isOpen'), '窄屏菜单项同样要判 editor.isOpen');
});

test('二次确认先预检：源文件落点 / 草稿 / 数据源都要提前说清', () => {
  assert.ok(dialog.includes('precheckDocumentDelete('), '弹窗必须在打开时跑预检（dryRun）');
  assert.ok(api.includes('dryRun: true'), '预检请求必须带 dryRun（服务端据此只读）');
  assert.ok(dialog.includes('precheck.wikiWillDelete'), '源文件是否会被删要按预检结论渲染');
  assert.ok(dialog.includes('precheck.pendingDrafts > 0'), '有草稿必须阻断并说明');
  assert.ok(dialog.includes('precheck.datasourceSource'), '数据源文档必须给出「下次同步会重新导入」的预告');
  assert.ok(dialog.includes('!precheck.exists'), '文档已不存在时必须阻断（不要删到一个不存在的目标上）');
  // 阻断必须落到按钮上，不能只显示文字
  assert.match(dialog, /const blocked = busy[\s\S]{0,400}precheck\.pendingDrafts > 0/, 'blocked 要把预检结论算进去');
  assert.ok(dialog.includes('disabled={blocked}'), '确认按钮必须受 blocked 约束');
});

test('「同时删除源文件」勾选只在源文件真的存在时出现（默认勾上）', () => {
  assert.ok(dialog.includes('const visibleWiki = precheck?.wikiPath !== undefined'), '勾选框的可见判据必须是「预检给了路径」');
  assert.ok(dialog.includes('useState(true)'), '源文件默认勾选（= CLI 与既有删除语义）');
  assert.ok(serverModule.includes('if (!fs.existsSync(file)) return { skipReason: \'file-not-found\' };'),
    '后端在源文件不存在时必须**不返回路径**（否则前端会摆一个勾了却什么都不删的复选框）');
  assert.ok(dialog.includes('wikiDelete'), '提交时必须把勾选结果传给后端');
  // 删不掉时不许渲染勾选框：勾着却什么都不做，与「出于安全不会删除」的说明互相矛盾
  assert.ok(
    dialog.includes('{visibleWiki && precheck.wikiWillDelete ? ('),
    '删不掉源文件时不得渲染勾选框，应改为一行说明',
  );
});

test('Esc 让给弹窗；删除成功后页面跟着收起并给回执', () => {
  assert.ok(dialog.includes("addEventListener('keydown', onKeyDown, true)"), '弹窗必须在捕获阶段接住 Esc');
  assert.match(
    drawer,
    /editor\.isOpen \|\| readerLinkComposerOpen \|\| moveOpen \|\| deleteOpen\) return;/,
    '弹窗打开时阅读器的 Esc 必须先退出，否则一次 Esc 关掉整个阅读器',
  );
  assert.ok(browse.includes('onDeleted={asDrawer ? undefined : handleDocDeleted}'), '页内阅读态必须接住删除结果');
  const handler = browse.slice(browse.indexOf('const handleDocDeleted'), browse.indexOf('const renderViewer'));
  assert.ok(handler.includes("invalidateQueries({ queryKey: ['docList'] })"), '删除后必须失效文档列表缓存');
  assert.ok(handler.includes('closeDocument()'), '删除后必须收起阅读区（文档已不存在，留在原地会 404）');
  assert.ok(handler.includes('setDeleteNotice('), '删除后必须给页面级回执（阅读区已关，只有页头能说明结果）');
  assert.ok(browse.includes('ki-page-head__notice'), '回执要真的渲染出来，不能只 setState');
  // 回执必须内联在路径行内：另起一行会让页头长高一行、8 秒后再缩回，正文区跟着上下跳
  assert.match(
    browse,
    /未选择文档，从左侧目录选择[\s\S]{0,600}?ki-page-head__notice/,
    '删除回执必须内联在页头路径行内（不得另起一段，否则 8 秒后页头高度回落会抖）',
  );
  // deleted:false 是「已经不存在」，回执不能写成「已删除」
  assert.ok(handler.includes('result.deleted ?'), '回执文案要区分 deleted 真伪（并发删除时不是"已删除"）');
});

test('前后端契约登记齐全（路由 / 权限 / 只读门禁 / 写锁 / 预检只读）', () => {
  assert.ok(api.includes("req<DeleteDocumentResponse>('/api/doc/delete'"), '前端必须调 /api/doc/delete');
  assert.ok(serverRoute.includes("p === '/doc/delete' && req.method === 'POST'"), '后端必须实现 POST /doc/delete');
  assert.ok(serverRoute.includes("withScopeWriteLock(scope, 'doc-relation-delete'"), '真删必须持有 scope 写锁');
  assert.ok(serverRoute.includes("rejectIfScopeReadonly(res, scope, 'http:/api/doc/delete')"), '只读库必须在 HTTP 层拦下');
  assert.ok(routePerm.includes("exact('POST', '/doc/delete', 'permission', 'knowledge.write')"), '路由权限必须登记（未登记默认 404）');
  assert.ok(scopePolicy.includes("'doc-relation-delete',"), '只读库拦截表必须登记 doc-relation-delete');
  // 预检走 read 通道：导入进行中也能打开弹窗（否则用户点删除会一直转圈）
  assert.ok(serverRoute.includes("'doc-delete-precheck'"), '预检要有独立的 operation 名');
  assert.ok(serverRoute.includes("'read',"), '预检必须走 read 通道');
});

test('样式：危险动作靠文字色区分，且窄屏收起集合包含它', () => {
  assert.ok(css.includes('.ki-drawer__copy--danger'), '缺少危险按钮样式');
  const current = css.indexOf('@container reader-drawer (max-width: 820px)');
  assert.ok(current > 0, '窄屏收起阈值块必须存在');
  assert.ok(css.slice(current, current + 900).includes('ki-drawer__copy--danger'), '「删除」要一起收进 ⋯，否则窄窗会折行');
  assert.ok(css.includes('.ki-doc-del'), '缺少删除弹窗样式');
});
