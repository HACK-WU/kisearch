/**
 * 添加 Git 数据源弹窗的关闭口径（2026-11-02 定、2026-11-04 修订）。
 *
 * 结论：
 *  1. **点遮罩不关闭**（2026-11-04 用户真机反馈后修订）：表单有 Scope / 仓库地址 / 分支 /
 *     子目录 / Group 五处输入，误点遮罩就整套丢失 —— 这是缺陷，不是便利。
 *  2. 关闭入口只有三个**显式**动作：✕ / Esc /「取消」，都直接关，**不做二次确认**
 *     （表单重填成本低，不是危险操作；2026-11-02 用户拍板否掉过确认条）。
 *
 * 历史：第一版按「脏表单二次确认」实现（对齐编辑弹窗的 discardOpen），用户否掉改「直接关」；
 * 第二版把遮罩也算作关闭入口，用户实测后判定为 bug，故遮罩退出关闭入口、确认条仍不加。
 * 本测试同时守住两件事：遮罩别再加回关闭、确认条别再冒出来。
 *
 * 源码守卫：组件无可剥离的纯逻辑，按字符串守契约。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const page = fs.readFileSync(path.join(webRoot, 'src/pages/DataSourcePage.tsx'), 'utf8');

/** 添加弹窗的遮罩块（后面紧跟弹窗 section，用于与页面其它 overlay 区分） */
function addOverlayBlock() {
  const start = page.indexOf('id="ki-ds-add-form"');
  assert.ok(start > 0, '未找到添加弹窗');
  // 越过注释块再找 className，避免命中文案注释里的 "setAddOpen(false)"
  const from = page.lastIndexOf('{addOpen ? (', start);
  assert.ok(from > 0, '未找到添加弹窗的渲染分支');
  return page.slice(from, start);
}

describe('添加 Git 数据源弹窗：关闭口径', () => {
  it('点遮罩不关闭（防误触丢表单）', () => {
    assert.doesNotMatch(addOverlayBlock(), /setAddOpen\(false\)/, '遮罩不应关闭弹窗');
  });

  /**
   * 遮罩必须是**纯容器**：mousedown / pointerdown / click 任一挂上即等于把误触关闭加回来。
   * 断言到"整个 div 只有 className"这一粒度 —— 加 data-* 之类的属性也会红，
   * 逼改动方明确决定"这个属性会不会顺带关掉弹窗"。
   */
  it('遮罩只带 className，不挂任何指针事件', () => {
    const block = addOverlayBlock();
    assert.ok(
      block.includes('<div className="ki-overlay ki-overlay--show ki-overlay--front">'),
      '遮罩应保持纯容器形式（<div className="ki-overlay ki-overlay--show ki-overlay--front">）',
    );
    assert.doesNotMatch(block, /on(Mouse|Pointer|Click|Touch|Key)\w*=/, '遮罩不应挂任何交互事件');
  });

  it('遮罩仍在本文件内联（被抽成组件时守卫会静默失效，必须同步迁移）', () => {
    assert.match(addOverlayBlock(), /ki-overlay--front/, '遮罩被抽走了 → 请把本测试一并迁移到新组件');
  });

  it('标题栏 ✕ 直接关闭', () => {
    assert.match(
      page,
      /aria-label="关闭添加表单" onClick=\{\(\) => setAddOpen\(false\)\}/,
      '✕ 应直接关闭',
    );
  });

  it('Esc 直接关闭', () => {
    assert.match(
      page,
      /if \(event\.key === 'Escape'\) setAddOpen\(false\);/,
      'Esc 应直接关闭（不要走 ref 或确认态）',
    );
  });

  it('footer「取消 / 关闭」直接关闭', () => {
    const label = page.indexOf("{addBusy ? '关闭' : '取消'}");
    assert.ok(label > 0, '按钮文案应随提交态切换');
    // onClick 写在子节点之前（JSX 属性在 text 前面）
    assert.match(
      page.slice(Math.max(0, label - 300), label),
      /onClick=\{\(\) => setAddOpen\(false\)\}/,
      'footer 按钮应直接关闭',
    );
  });

  it('不引入二次确认（脏表单不拦、不加确认条）', () => {
    assert.doesNotMatch(page, /addDiscardOpen/, '不应再出现确认态 state');
    assert.doesNotMatch(page, /放弃已填写/, '不应再出现「放弃已填写」确认文案');
    assert.doesNotMatch(page, /requestCloseAdd/, '关闭应直接调 setAddOpen(false)，不经中间层');
  });
});
