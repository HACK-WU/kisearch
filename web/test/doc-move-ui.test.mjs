/**
 * doc-move-ui.test.mjs —— 文档移动入口的静态守卫（REQ-20261112-002）
 *
 * 交互走查在真机做（不随仓库走），这里只挡会被"顺手清理"掉的**结构性约定**：
 *   1. 移动入口与「编辑文档」同门禁（只读库必须置灰，且窄屏必须仍有入口）
 *   2. 目标 Group 必须复用导入页的 GroupPathSelect（不许另造一套选择器）
 *   3. 弹窗 body 不许设 overflow（会把选择器下拉面板裁掉）
 *   4. Esc 必须让给弹窗（否则一次 Esc 连阅读器一起收掉）
 *   5. 移动成功后页面要跟着搬家（URL / 列表 / 目录），否则等于"文档不见了"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const drawer = read('src/components/ModuleDrawer.tsx');
const dialog = read('src/components/DocMoveDialog.tsx');
const browse = read('src/pages/BrowsePage.tsx');
const css = read('src/styles/ki.css');
const api = read('src/api/httpApi.ts');
const serverRoute = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'mcp-http-api.ts'), 'utf-8');
const routePerm = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'auth', 'route-permissions.ts'), 'utf-8');
const scopePolicy = fs.readFileSync(path.join(root, '..', 'src', 'lib', 'scope-policy.ts'), 'utf-8');

test('移动入口与「编辑文档」同一门禁，且窄屏「⋯」菜单里有同名条目', () => {
  // 宽条版本：三个条件缺一不可（不要退化成"永远显示"）
  assert.match(
    drawer,
    /\{editable && group && content !== null && onMoved && \(/,
    '宽条「移动」必须与编辑文档同门禁（editable + 有 group + 有正文 + 有人接后续导航）',
  );
  assert.ok(drawer.includes('ki-drawer__copy--move'), '宽条移动按钮缺少样式钩子类');
  // 只读库：必须走 docWriteDisabled（含 scopeReadonly），不能只判 editable
  const moveBlock = drawer.slice(drawer.indexOf('ki-drawer__copy--move') - 400, drawer.indexOf('ki-drawer__copy--move') + 400);
  assert.ok(moveBlock.includes('docWriteDisabled'), '「移动」必须与编辑文档共用 docWriteDisabled（只读库置灰）');
  // 窄屏：菜单里也要有（隐藏平铺版不等于功能可达）
  assert.ok(
    drawer.includes("setMoveOpen(true); }}\n                    >移动</button>"),
    '窄屏「⋯」菜单必须提供「移动」入口',
  );
});

test('窄屏收起集合包含移动按钮（阈值上调而不是硬塞）', () => {
  // 阈值随新动作单调上调：620（初版）→ 700（加「移动」）→ 820（加「删除」，2026-11-13）。
  // 断言只看「当前阈值块内包含移动」+「旧阈值已不存在」，避免每加一个动作就要改死数字。
  const current = css.indexOf('@container reader-drawer (max-width: 820px)');
  assert.ok(current > 0, '窄屏收起阈值块必须存在（当前 820）');
  const block = css.slice(current, current + 900);
  assert.ok(block.includes('ki-drawer__copy--move'), '「移动」要一起收进 ⋯，否则窄窗会把这排挤成两行');
  assert.ok(!css.includes('@container reader-drawer (max-width: 620px)'), '旧阈值 620 必须同步上调（新增动作约 76px）');
  assert.ok(!css.includes('@container reader-drawer (max-width: 700px)'), '旧阈值 700 必须随「删除」上调（又一个动作约 76px）');
});

test('目标 Group 复用导入页的 GroupPathSelect，且弹窗不被 overflow 裁剪', () => {
  assert.ok(dialog.includes("from '@/components/GroupPathSelect'"), '必须复用 GroupPathSelect（导入页那份实现）');
  assert.ok(dialog.includes('groupError('), 'Group 校验必须复用 validators.groupError');
  // 只看 JSX 调用本身：注释里提到 selectOnly 属说明，不算传参
  const usage = dialog.match(/<GroupPathSelect[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(usage.length > 0, '弹窗里必须真的渲染 GroupPathSelect');
  assert.ok(!usage.includes('selectOnly'), '移动允许输入新路径新建 Group（与导入页一致），不应传 selectOnly');
  const bodyRule = css.match(/\.ki-move__body\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.ok(bodyRule.length > 0, '.ki-move__body 规则必须存在');
  assert.ok(!bodyRule.includes('overflow'), '.ki-move__body 不得设 overflow：下拉面板是常规流定位，会被裁掉');
});

test('Esc 让给弹窗；移动后页面跟随搬家', () => {
  // 早退列表会随新弹窗增长（2026-11-13 加了 deleteOpen）：断言「moveOpen 在内」，不锁死整行写法
  assert.match(
    drawer,
    /editor\.isOpen \|\| readerLinkComposerOpen \|\| moveOpen[^;]*\) return;/,
    '弹窗打开时阅读器的 Esc 必须先退出，否则一次 Esc 关掉整个阅读器',
  );
  assert.ok(browse.includes('onMoved={asDrawer ? undefined : handleDocMoved}'), '页内阅读态必须接住移动结果');
  const handler = browse.slice(browse.indexOf('const handleDocMoved'), browse.indexOf('const renderViewer'));
  assert.ok(handler.includes("invalidateQueries({ queryKey: ['docList'] })"), '移动后必须失效文档列表缓存');
  assert.ok(handler.includes('writeBrowseUrl('), '移动后必须把新位置写回 URL（否则刷新落空）');
  assert.ok(handler.includes('setActiveGroup('), '移动后左侧目录要选中新组');
});

test('前后端契约登记齐全（路由 / 权限 / 只读门禁 / 写锁）', () => {
  assert.ok(api.includes("req<MoveDocumentResponse>('/api/doc/move'"), '前端必须调 /api/doc/move');
  assert.ok(serverRoute.includes("p === '/doc/move' && req.method === 'POST'"), '后端必须实现 POST /doc/move');
  assert.ok(serverRoute.includes("withScopeWriteLock(scope, 'doc-move-write'"), '移动必须持有 scope 写锁');
  assert.ok(routePerm.includes("exact('POST', '/doc/move', 'permission', 'knowledge.write')"), '路由权限必须登记（未登记默认 404）');
  assert.ok(scopePolicy.includes("'doc-move-write',"), '只读库拦截表必须登记 doc-move-write');
});

test('弹窗自己接 Esc；成功回执跨「重挂载」不丢', () => {
  // 弹窗打开时阅读器的 Esc 链会早退，若弹窗不自带 Esc，按 Esc 会毫无反应
  assert.ok(dialog.includes("addEventListener('keydown', onKeyDown, true)"), '弹窗必须在捕获阶段接住 Esc');
  // 移动会改 group/relation ⇒ ModuleDrawer 的 key 变了会重挂载，组件内的提示会随旧实例丢失
  assert.ok(drawer.includes('initialNotice?: string'), '查看器要支持页面移交的一次性回执');
  assert.ok(browse.includes('initialNotice={asDrawer ? undefined : moveNotice}'), '页面必须把回执交给重挂载后的新实例');
  assert.ok(browse.includes('setMoveNotice('), '页面要在移动成功时生成回执文案');
});

test('通用「根目录」选项：组件级开关，只有移动弹窗开启（2026-11-12）', () => {
  const picker = read('src/components/GroupPathSelect.tsx');
  assert.ok(picker.includes('rootOption?: { value: string; label: string }'), '选择器要提供通用的根选项入参');
  assert.match(picker, /role="treeitem"[\s\S]{0,400}rootOption\.label/, '根选项要作为树里的一行渲染');
  // 保留键不许铺给用户：输入框在选中根时显示 label（留空供改路径），不显示 __root__
  assert.ok(picker.includes('rootSelected ? \'\' : value'), '选中根目录时输入框不能显示 __root__');
  assert.ok(dialog.includes('rootOption={{ value: ROOT_GROUP_KEY'), '移动弹窗要开启根目录选项');

  // 其它调用方不得顺手开启：导入页/写入页的「Group 留空」本身就是根，
  // 多一个选项会让人分不清「留空自动分组」和「真的落在根」
  for (const rel of [
    'src/pages/ImportPage.tsx',
    'src/pages/WritePage.tsx',
    'src/components/DatasourceMappingsEditor.tsx',
  ]) {
    assert.ok(!read(rel).includes('rootOption'), `${rel} 不应传 rootOption（会改变既有留空语义）`);
  }
});
