/**
 * doc-download-ui.test.mjs —— 「下载 .md」入口的静态守卫（2026-11-13）
 *
 * 交互在真机走查（不随仓库走），这里只挡会被"顺手清理"掉的约定：
 *   1. 下载是**读**动作：与「复制」同门禁，不能挂到写门禁上（只读库也该能下载）
 *   2. 宽条与窄屏「⋯」菜单两版入口都要有，且窄屏收起阈值要跟着上调
 *   3. 文件名必须净化平台非法字符，片段态必须在文件名上标注
 *   4. objectURL 必须释放（否则每次下载都漏一份 Blob 在内存里）
 *   5. 下载内容必须与「复制」同源（displayedContent），不另取一份
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const drawer = read('src/components/ModuleDrawer.tsx');
const css = read('src/styles/ki.css');
const browse = read('src/pages/BrowsePage.tsx');

test('下载是读动作：与「复制」同门禁，不得挂写门禁', () => {
  assert.ok(drawer.includes('ki-drawer__copy--download'), '缺少下载按钮的样式钩子类');
  const block = drawer.slice(drawer.indexOf('ki-drawer__copy--download') - 700, drawer.indexOf('ki-drawer__copy--download') + 700);
  assert.ok(block.includes('disabled={docActionsDisabled}'), '下载应与「复制」一样受 docActionsDisabled 约束（搜索态禁用）');
  assert.ok(!block.includes('docWriteDisabled'), '下载不得复用写门禁：只读库也要能下载');
  assert.ok(!block.includes('scopeReadonly'), '下载不得因只读库被禁用');
  // 窄屏菜单同样要有入口（隐藏平铺版不等于不可达）
  assert.ok(
    drawer.includes('setOverflowOpen(false); handleDownload(); }}'),
    '窄屏「⋯」菜单必须提供下载入口',
  );
});

test('下载内容与「复制」同源，且 Blob 声明为 markdown', () => {
  assert.ok(drawer.includes('const handleDownload = useCallback'), '缺少 handleDownload');
  assert.ok(drawer.includes("type: 'text/markdown;charset=utf-8'"), 'Blob 必须声明 markdown MIME + utf-8');
  assert.ok(drawer.includes('new Blob([displayedContent]'), '下载内容必须取自 displayedContent（与复制同一份正文）');
  assert.ok(!/fetch\(|getDocContent\(/.test(drawer.slice(drawer.indexOf('const handleDownload'), drawer.indexOf('const handleDownload') + 1200)),
    '下载不得再向服务端取一次原文（会出现"复制到片段、下载到全文"两套事实）');
});

test('文件名：净化非法字符 + 去重 .md + 截断 + 片段态标注', () => {
  assert.ok(drawer.includes('export function downloadFileName('), '文件名生成要独立成函数，便于复核与复用');
  assert.ok(drawer.includes('anchor.download = fileName'), '必须设置 download 属性');
  assert.ok(
    drawer.includes('downloadFileName(module, showingFallback)'),
    'handleDownload 必须走 downloadFileName（不得内联另一套命名规则）',
  );
  assert.match(drawer, /replace\(\/\[[^\]]*<>[^\]]*\]\/g, '_'\)/, '文件名必须净化 `\\ / : * ? " < > |`');
  assert.ok(drawer.includes(".replace(/\\.md$/i, '')"), '必须去掉重复的 .md（relation 可能自带扩展名）');
  assert.ok(drawer.includes(".replace(/[\\u0000-\\u001f\\u007f]/g, '')"), '必须清掉控制字符（换行/制表符会让保存异常）');
  assert.ok(drawer.includes('.slice(0, 120)'), '必须截断超长文件名（Windows 单名上限 255 字节，中文约 85 字符就顶到）');
  assert.ok(drawer.includes("'-命中片段'"), '只载入搜索命中片段时必须在文件名上标注（否则会被当全文存档）');
  assert.ok(drawer.includes('document.body.appendChild(anchor)'), '锚点必须挂进文档再 click（Firefox 对游离节点不触发下载）');
  assert.ok(drawer.includes('anchor.remove()'), '用完要摘掉锚点，不留 DOM 垃圾');
});

test('objectURL 必须释放（延迟一拍，避免 Safari 拿不到内容）', () => {
  assert.ok(drawer.includes('URL.createObjectURL('), '必须用 objectURL 承载 Blob');
  assert.ok(drawer.includes('URL.revokeObjectURL('), '必须释放 objectURL，否则每次下载漏一份 Blob 在内存里');
  assert.ok(
    /setTimeout\(\(\) => URL\.revokeObjectURL\(/.test(drawer),
    '释放必须延迟（click 返回后浏览器可能还在读内容）',
  );
});

test('窄屏收起集合包含下载，阈值已随之上调', () => {
  const current = css.indexOf('@container reader-drawer (max-width: 880px)');
  assert.ok(current > 0, '窄屏收起阈值块必须存在（当前 880）');
  assert.ok(css.slice(current, current + 1200).includes('ki-drawer__copy--download'), '「下载」要一起收进 ⋯，否则窄窗会折行');
});

test('失败要有可见反馈，不能静默', () => {
  assert.ok(drawer.includes('setDownloadFailed(true)'), '下载失败必须置失败态');
  assert.ok(drawer.includes('下载失败'), '失败提示文案必须存在（复用既有提示条）');
});

test('浏览页没有额外改动（下载是查看器自身能力，各调用方自动获得）', () => {
  // 下载不需要页面接回调：不传任何新 prop，避免出现"某些页面能下载、某些不能"的分叉
  assert.ok(!browse.includes('onDownload'), '下载不应上升为页面级 prop（查看器内部即可完成）');
});
