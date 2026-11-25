/**
 * sidebar-nav-groups.test.mjs —— 侧栏分组结构的静态守卫（2026-11-25 IA 重排）
 *
 * 背景：侧栏分组、项顺序、图标与文案都写在 `AppShell.tsx` 的常量里，没有数据文件；
 * 之前没有任何测试锁住它们（`write-merge-tabs.test.mjs` 只测 `navItemActive`），
 * 于是「资源该不该在运维组」「视图叫什么」这类结论只活在一次对话里，改一次要重新问一遍。
 *
 * 锁四件事（用户 2026-11-25 拍板的 IA）：
 *   1) 四组顺序：工作台 → 接入与运维 → 知识治理 → 帮助与接入；
 *   2) 「资源」只在末组出现一次，不再混在「接入与运维」里；
 *   3) 「视图」文案（原「知识视图」）—— 防回退；
 *   4) `NAV_MAIN` 并入 `NAV_HELP`，否则 `/resources` 的顶栏 H1 会落到兜底的「总览」。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const shellSrc = readFileSync(path.join(webRoot, 'src/layouts/AppShell.tsx'), 'utf8');

/** 切出 `const NAME: NavItem[] = [ ... ];` 的块（不跨到下一个常量） */
function extractNavConst(name) {
  const head = `const ${name}: NavItem[] = [`;
  const start = shellSrc.indexOf(head);
  assert.notEqual(start, -1, `AppShell.tsx 缺少 ${name} 常量`);
  const end = shellSrc.indexOf('\n];', start);
  assert.notEqual(end, -1, `${name} 常量的数组没有正常闭合`);
  return shellSrc.slice(start, end);
}

describe('侧栏分组结构（2026-11-25 IA 重排）', () => {
  it('分组渲染顺序：工作台 → 接入与运维 → 知识治理 → 帮助与接入', () => {
    const at = (needle) => {
      const i = shellSrc.indexOf(needle);
      assert.notEqual(i, -1, `侧栏缺少「${needle}」`);
      return i;
    };
    const 工作台 = at("label: '工作台', items: NAV_WORKSPACE");
    const 运维 = at("label: '接入与运维', items: NAV_OPS");
    const 治理 = at('aria-label="知识治理"');
    const 帮助 = at('aria-label="帮助与接入"');
    assert.ok(工作台 < 运维, '「工作台」必须在「接入与运维」之前');
    assert.ok(运维 < 治理, '「接入与运维」必须在「知识治理」之前');
    assert.ok(治理 < 帮助, '「帮助与接入」必须在「知识治理」之后（置最底）');
  });

  it('「资源」只在末组出现一次，不再属于接入与运维', () => {
    const ops = extractNavConst('NAV_OPS');
    const help = extractNavConst('NAV_HELP');
    assert.ok(!ops.includes("'/resources'"), '资源必须从「接入与运维」移出（静态手册与有状态管理页不同类）');
    assert.match(help, /to: '\/resources', label: '资源'/, '「帮助与接入」必须承载资源入口');
    // 全文件只允许一处 /resources 导航项（防止两组都渲染，用户看到两个「资源」）
    assert.equal(shellSrc.split("to: '/resources'").length - 1, 1, '/resources 在侧栏只能有一个入口');
  });

  it('「视图」文案（原「知识视图」）不回退', () => {
    const ops = extractNavConst('NAV_OPS');
    assert.match(ops, /to: '\/views', label: '视图'/, "「/views」的侧栏与 H1 文案必须是「视图」");
    assert.ok(!shellSrc.includes("label: '知识视图'"), '导航文案不得回退成「知识视图」（正文/CLI/docs 仍用全称，不在本文件）');
  });

  it('NAV_MAIN 并入 NAV_HELP —— 否则 /resources 的顶栏 H1 落到「总览」', () => {
    assert.match(
      shellSrc,
      /const NAV_MAIN: NavItem\[\] = \[\.\.\.NAV_WORKSPACE, \.\.\.NAV_OPS, \.\.\.NAV_HELP\]/,
      'NAV_MAIN 必须包含 NAV_HELP，它是 currentLabel 的唯一查表源',
    );
  });
});
