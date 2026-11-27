/**
 * topbar-popover-dismiss.test.mjs —— 顶栏浮层「点外部收起」的源码契约（2026-11-27）
 *
 * web 单测不渲染 React（无 jsdom），按仓库既有做法做**源码契约断言**。
 * 钉住两件事：
 * 1. ScopeSelect / 服务健康 / 用户菜单 / 图集成员库切换**共用**一个收起重器，别再各写一份；
 * 2. 那个钩子必须是「捕获阶段 mousedown + window blur」——
 *    前者防祖先 stopPropagation（事件上传弹窗曾整片失效），
 *    后者是 iframe 页（/atlas 图集）唯一能观测到的信号（父 document 收不到任何鼠标事件）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const hook = read('src/lib/useDismissOnOutside.ts');
const picker = read('src/components/ScopeSelect.tsx');
const appShell = read('src/layouts/AppShell.tsx');
const atlasHeader = read('src/components/AtlasHeaderActions.tsx');

describe('① 顶栏四个浮层共用收起重器', () => {
  it('ScopeSelect 走 useDismissOnOutside', () => {
    assert.match(picker, /useDismissOnOutside\(rootRef, open,/);
  });

  it('服务健康浮层走 useDismissOnOutside', () => {
    assert.match(appShell, /useDismissOnOutside\(rootRef, open, \(\) => setOpen\(false\)\)/);
  });

  it('用户菜单走 useDismissOnOutside', () => {
    assert.match(appShell, /useDismissOnOutside\(userMenuRef, userMenuOpen,/);
  });

  it('图集成员库切换走 useDismissOnOutside', () => {
    assert.match(atlasHeader, /useDismissOnOutside\(rootRef, open,/);
  });
});

describe('② 钩子必须是「捕获阶段 mousedown + window blur」', () => {
  it('mousedown 挂捕获阶段，任何祖先阻断冒泡都不影响', () => {
    assert.match(hook, /document\.addEventListener\('mousedown', onPointerDown, true\)/);
    assert.match(hook, /document\.removeEventListener\('mousedown', onPointerDown, true\)/);
  });

  it('监听 window blur：iframe 内的点击只有这个信号', () => {
    assert.match(hook, /window\.addEventListener\('blur', onWindowBlur\)/);
    assert.match(hook, /window\.removeEventListener\('blur', onWindowBlur\)/);
  });

  it('不用 click：收起态展示层被点后会换成 input，同一 click 里 contains 已脱节点会误关', () => {
    assert.ok(!/addEventListener\('click'/.test(hook), '钩子不应监听 click');
  });

  it('只在展开时挂监听，收起态立刻解绑', () => {
    assert.match(hook, /if \(!open\) return undefined;/);
  });
});
