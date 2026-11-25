/**
 * sidebar-nav-icons.test.mjs —— 侧栏图标的三条静态守卫（2026-11-25 用户拍板）
 *
 * 背景：知识治理三项自 6e5465b 起照「接入与运维」倒序借用 layers / clock / database，
 * 与「视图」「后台任务」「数据源」三对全撞 —— 侧栏靠图标做第一层扫视辨识，
 * 同形等于逼用户逐字读标签。当时没有任何测试约束图标选择，且治理三项是组件内联数组
 * （不在 NAV_* 常量里），`sidebar-nav-groups.test.mjs` 只 extractNavConst，抓不到它们。
 *
 * 锁三件事：
 *   1) 同一侧栏内 icon 不得重复；
 *   2) 每个 icon 名必须在 icons.tsx 的 PATHS 里 —— Icon 组件对未知名称**静默返回 null**
 *      （icons.tsx 的 `if (!path) return null`），写错名字只会得到一个没有图标的入口，永不报错；
 *   3) 治理三项的映射不回退（分类 sliders / 事件 warn / 回收站 trash）。
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
const iconsSrc = readFileSync(path.join(webRoot, 'src/components/icons.tsx'), 'utf8');

/** 侧栏里出现的全部图标字面量（NAV_* 常量与治理组内联数组都算） */
function navIcons() {
  return [...shellSrc.matchAll(/icon:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
}

/** icons.tsx 里 PATHS 表登记过的图标名 */
function iconPathKeys() {
  const start = iconsSrc.indexOf('const PATHS');
  assert.notEqual(start, -1, 'icons.tsx 缺少 PATHS 表');
  const end = iconsSrc.indexOf('\n};', start);
  assert.notEqual(end, -1, 'PATHS 表没有正常闭合');
  const block = iconsSrc.slice(start, end);
  return new Set([...block.matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:/gm)].map((m) => m[1]));
}

describe('侧栏图标（2026-11-25 拍板：分类 sliders / 事件 warn / 回收站 trash）', () => {
  it('同一侧栏内图标两两不重复', () => {
    const icons = navIcons();
    assert.ok(icons.length >= 13, `侧栏至少 13 个入口，实际只抓到 ${icons.length} 个 icon 字面量`);

    const seen = new Set();
    const dup = new Set();
    for (const name of icons) {
      if (seen.has(name)) dup.add(name);
      seen.add(name);
    }
    assert.deepEqual(
      [...dup],
      [],
      `侧栏图标重复：${[...dup].join('、')} —— 图标是第一层扫视信号，同形让相邻入口无法区分`,
    );
  });

  it('每个图标名都在 icons.tsx 的 PATHS 里（否则 Icon 静默渲染空白）', () => {
    const keys = iconPathKeys();
    const missing = [...new Set(navIcons())].filter((name) => !keys.has(name));
    assert.deepEqual(
      missing,
      [],
      `这些图标名在 icons.tsx 里不存在：${missing.join('、')} —— Icon 组件会静默返回 null，入口会没有图标`,
    );
  });

  it('知识治理三项的图标映射不回退', () => {
    const govStart = shellSrc.indexOf('aria-label="知识治理"');
    assert.notEqual(govStart, -1, '侧栏缺少「知识治理」分组');
    const gov = shellSrc.slice(govStart, shellSrc.indexOf('</nav>', govStart));

    assert.match(gov, /label: '分类', icon: 'sliders'/, '「分类」必须是 sliders（本页管的是调档，不是目录）');
    assert.match(gov, /label: '事件', icon: 'warn'/, '「事件」必须是 warn');
    assert.match(gov, /label: '回收站', icon: 'trash'/, '「回收站」必须是 trash（新增图标）');

    // 反向锁：曾被采纳又推翻的组合，不得悄悄回来
    for (const [label, bad] of [
      ['分类', 'layers'],
      ['分类', 'folder'],
      ['事件', 'clock'],
      ['回收站', 'database'],
    ]) {
      assert.ok(
        !new RegExp(`label: '${label}', icon: '${bad}'`).test(shellSrc),
        `「${label}」不得使用 ${bad} —— 会与运维组撞形（layers=视图 / clock=后台任务 / database=数据源），folder 则暗示目录树`,
      );
    }
  });
});