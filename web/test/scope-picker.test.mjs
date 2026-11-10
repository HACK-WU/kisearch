/**
 * scope-picker.test.mjs —— 知识库多选下拉的静态守卫（2026-11-10）
 *
 * 该交互原来内嵌在 ViewsPage，Token 创建表单另有一套扁平 chips；抽出
 * components/ScopeMultiPicker.tsx 后两处共用一份。本文件挡四类回退：
 *   1. 有人又给某个调用方另写一套选择器（回到两份实现）
 *   2. Esc 的 stopPropagation 被"清理"掉 → Token 弹窗会被连带关掉
 *   3. 候选项回到 Tab 序 → 弹窗里键盘用户被上百个候选困住
 *   4. picker 样式又分叉回页面级 css（Token 弹窗拿不到）
 *
 * 交互行为的真机验证在 /tmp 的走查脚本里（不随仓库走），这里只挡结构性回归。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const picker = read('src/components/ScopeMultiPicker.tsx');
const pickerCss = read('src/styles/scope-picker.css');
const app = read('src/App.tsx');
const viewsPage = read('src/pages/ViewsPage.tsx');
const tokenSection = read('src/components/UserTokenSection.tsx');
const viewsCss = read('src/styles/views.css');
const usersCss = read('src/styles/users-v2.css');

test('两个调用方共用同一份实现，不再各写一套', () => {
  assert.ok(tokenSection.includes("from '@/components/ScopeMultiPicker'"), 'Token 创建表单应使用公共组件');
  assert.ok(tokenSection.includes('<ScopeMultiPicker'), 'Token 创建表单应渲染公共组件');
  assert.ok(viewsPage.includes("from '@/components/ScopeMultiPicker'"), '视图页应使用公共组件');
  assert.ok(viewsPage.includes('<ScopeMultiPicker'), '视图页应渲染公共组件');
  // 旧的扁平 chips 不能复活
  assert.ok(!tokenSection.includes('u2-scope-chips'), 'Token 表单不应回到扁平 chips');
  assert.ok(!tokenSection.includes('ki-chip--on'), 'Token 表单不应回到可点击 ki-chip');
  assert.ok(!usersCss.includes('.u2-scope-chips'), '扁平 chips 的样式应一并删除');
});

test('组件不发请求：数据源由调用方决定', () => {
  assert.ok(!/kiScopeList|fetch\(|useQuery/.test(picker), '组件不得自己拉 scope 列表（视图页与 Token 的口径不同）');
});

test('Esc 必须 stopPropagation，否则 Token 弹窗会被连带关掉', () => {
  const escBlock = /if \(e\.key === 'Escape' && open\) \{[\s\S]{0,400}?\n    \}/.exec(picker);
  assert.ok(escBlock, '应存在 Esc 收起候选的分支');
  assert.ok(escBlock[0].includes('e.stopPropagation()'), 'Esc 分支必须 stopPropagation（外壳 UserDialog 在 window 上监听 Esc）');
  assert.ok(escBlock[0].includes('setOpen(false)'), 'Esc 只收起候选，不关闭外层');
});

test('候选项不进 Tab 序（键盘走 ↑↓ + 回车）', () => {
  const optBlock = /className=\{`sp-picker__opt[^`]*`\}/.exec(picker);
  assert.ok(optBlock, '应存在候选项按钮');
  assert.ok(/tabIndex=\{-1\}/.test(picker), '候选项必须 tabIndex={-1}，否则弹窗内要按上百次 Tab 才能走出');
  // ↑↓ / Enter 必须保留，否则去掉 Tab 后就无法键盘选择了
  assert.ok(picker.includes("e.key === 'ArrowDown'") && picker.includes("e.key === 'ArrowUp'"), '必须保留 ↑↓ 选择');
  assert.ok(/e\.key === 'Enter'/.test(picker), '必须保留回车添加');
  assert.ok(picker.includes('preventDefault'), '↑↓/回车要 preventDefault，否则光标跳首尾或触发提交');
});

test('ARIA combobox 关联完整：Tab 不可达必须由 activeDescendant 补偿', () => {
  assert.ok(picker.includes('useId'), '同页可能有多个 picker，id 需用 useId 保证唯一');
  assert.ok(/role="combobox"/.test(picker), '输入框应为 combobox');
  assert.ok(picker.includes('aria-controls={listboxId}'), '应关联候选列表');
  assert.ok(picker.includes('aria-activedescendant={activeOptionId}'), '必须指出现高亮项，否则屏幕阅读器感知不到 ↑↓ 停在哪');
  assert.ok(/role="listbox"/.test(picker) && /role="option"/.test(picker), '候选区应为 listbox + option');
  assert.ok(picker.includes('aria-selected={i === activeIndex}'), '高亮项要标 aria-selected');
});

test('候选面板恒为浮层：不挤压下方内容，且必须 fixed + 跟随滚动', () => {
  assert.ok(
    /\.sp-picker__panel\s*\{[\s\S]*?position:\s*fixed/.test(pickerCss),
    '必须 fixed：Token 弹窗有 .u2-inline-panel/.u2-dialog__body/.u2-dialog/.ki-dialog 四层 overflow，'
    + '视图页有 .views-card，absolute 会被裁掉（实测 200px → 83px / 99px）',
  );
  assert.ok(pickerCss.includes('z-index: 150'), '层级取 150：高于页面内下拉 30~120，低于侧栏 990 / 聊天面板 1030');
  assert.ok(!pickerCss.includes('--floating'), '不再有浮层开关变体（两处调用方都用浮层）');
  assert.ok(!tokenSection.includes('floating') && !viewsPage.includes('floating'), '调用方不再需要开关');
  assert.ok(
    picker.includes("addEventListener('scroll', reposition, true)"),
    '容器内部滚动（弹窗 body / 页面）要用 capture 才收得到，否则浮层与输入框脱位',
  );
  assert.ok(picker.includes("addEventListener('resize', reposition)"), '窗口缩放要重算位置');
  assert.ok(picker.includes('useLayoutEffect'), '首帧必须在 paint 前定位，否则会闪一下在文档流里');
});

test('样式单一来源：picker 类不再只写在页面级 css 里', () => {
  assert.ok(app.includes("'./styles/scope-picker.css'"), '样式需在 App.tsx 全局引入（Token 弹窗不在视图页路由内）');
  assert.ok(pickerCss.includes('.sp-picker__panel'), '全局样式应含候选面板');
  assert.ok(pickerCss.includes('.sp-picker__opt--active'), '全局样式应含键盘高亮态');
  assert.ok(pickerCss.includes('.sp-chip--pick'), '全局样式应含可移除 chip');
  assert.ok(!/\.views-picker/.test(viewsCss), 'views.css 不应再持有 picker 样式（已迁至 scope-picker.css）');
  assert.ok(!/\.views-tag/.test(viewsCss), 'views.css 不应再持有 picker 徽标样式');
  // 列表行的只读 chips 必须留在 views.css（它和可点击 picker chip 是两回事）
  assert.ok(viewsCss.includes('.views-chip--dim-mismatch'), '列表行 chip 的状态配色应保留');
});
