/**
 * views-page.test.mjs —— 知识视图页的静态守卫（REQ-20261104-004）
 *
 * 这里测的是"页面源码必须满足的约束"（项目已有同类守卫：datasource-add-close.test.mjs）。
 * 行为正确性由 test/views-api.test.ts 覆盖（接口层），本文件只挡三类回归：
 *   1. 前端自己比对 userId 判权限（§1.6：必然与后端漂移）
 *   2. 删除确认的遮罩被绑上关闭行为（违反 2026-11-04 既有口径）
 *   3. 照搬 demo 的 pv-* 外壳类（与 AppShell 双源）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const page = read('src/pages/ViewsPage.tsx');
const apiClient = read('src/api/viewsApi.ts');
const css = read('src/styles/views.css');
/** 选库交互已下沉到公共组件（视图页与 Token 创建表单共用） */
const picker = read('src/components/ScopeMultiPicker.tsx');

test('写权限只用后端 canEdit / mine，页面不比对 userId', () => {
  assert.ok(!/userId\s*===/.test(page), '页面不得自行比对 userId');
  assert.ok(!/currentUser\.id/.test(page), '页面不得读当前用户 id 做权限判断');
  assert.ok(page.includes('v.canEdit'), '应使用后端 canEdit 控制按钮');
  assert.ok(page.includes('v.mine'), '应使用后端 mine 渲染「我的」标识');
});

test('canEdit=false 时按钮禁用并带说明，而不是隐藏', () => {
  assert.ok(/disabled=\{!v\.canEdit\}/.test(page), '编辑按钮应按 canEdit 禁用');
  assert.ok(page.includes('仅创建者或管理员可修改该视图'), '禁用态应有 title 说明');
});

test('删除确认的遮罩不绑定关闭行为（只能取消 / 删除）', () => {
  const m = /className="views-modal-backdrop"[^>]*>/.exec(page);
  assert.ok(m, '应存在遮罩元素');
  assert.ok(!/onClick/.test(m[0]), '遮罩不得绑定 onClick 关闭');
});

test('页面复用 AppShell，不照搬 demo 的 pv-* 外壳与内联令牌兜底', () => {
  assert.ok(page.includes("'@/styles/views.css'"), '应引入页面样式');
  assert.ok(!/pv-/.test(page), '不得出现 demo 的 pv-* 类名');
  assert.ok(!/ki-fallback/.test(page), '不得照搬 demo 的令牌兜底逻辑');
});

test('影响面按 R-05 口径由后端计算，页面只展示', () => {
  assert.ok(apiClient.includes('/api/views/impact'), '影响面应由后端接口提供');
  assert.ok(!/members\.every/.test(page), '页面不得自己算影响面（口径必须单点）');
});

test('维度不一致只标「已确认」，且后果说明与配色齐备', () => {
  assert.ok(page.includes("tags.push('维度不一致')"), '成员 chip 应追加「维度不一致」后缀');
  assert.ok(/dimensionState === 'mismatch'/.test(page), '判据必须是后端已确认的 mismatch');
  assert.ok(!/dimensionState\s*!==\s*'ok'/.test(page), '不得用 !ok 把 unknown 也标成不一致');
  assert.ok(page.includes('语义检索会直接跳过该库'), 'hover 应说明「语义检索直接跳过」的后果');
  assert.ok(page.includes('--rebuild-vector --yes'), 'hover 应给出修复命令');
  assert.ok(page.includes('views-chip--dim-mismatch'), '应有专属配色类');
  assert.ok(css.includes('.views-chip--dim-mismatch'), 'CSS 变体应存在');
});

test('维度三态逐个可见：unknown 必须与 ok 区分，且能定位到具体 scope', () => {
  assert.ok(page.includes("dimensionState === 'unknown'"), '页面应识别未确认成员');
  assert.ok(page.includes("tags.push('维度未确认')"), 'unknown 的 chip 必须逐个追加后缀');
  assert.ok(page.includes('没有可用的维度检查快照'), 'unknown 的 hover 应说明原因');
  assert.ok(page.includes('views-chip--dim-unknown'), 'unknown 应有专属样式类');
  assert.ok(css.includes('.views-chip--dim-unknown'), 'CSS 变体应存在');
  // 只给一个数字仍看不出是哪个库：行级提示必须列名字 + title 全量
  assert.ok(page.includes('个库维度未确认：'), '行级提示应带库名列表');
  assert.ok(page.includes('hover 看全部'), '应提示 hover 可看全量名单');
  assert.ok(page.includes('views-row__warn--dim'), '未确认提示应有独立样式');
});

test('编辑态同步：已选成员与候选面板复用同一份维度状态', () => {
  assert.ok(page.includes('dimensionByScope'), '应由 /api/views 的 memberMeta 聚合，避免两处产出');
  assert.ok(page.includes("' · 维度未确认'"), '编辑表单已选 chip 也应标出未确认');
  assert.ok(page.includes('ScopeMultiPicker'), '选库交互应走公共组件（与 Token 创建表单共用一份实现）');
  assert.ok(picker.includes('sp-picker__opt-meta'), '候选面板应保持渲染');
});
