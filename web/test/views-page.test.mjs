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
