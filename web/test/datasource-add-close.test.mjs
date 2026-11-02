/**
 * 添加 Git 数据源弹窗的关闭口径（2026-11-02）。
 *
 * 结论（用户拍板）：**关闭就是关闭，不做二次确认** —— 表单重填成本低，不是危险操作。
 * 四个入口（遮罩 / ✕ / Esc / 「取消」）都直接关，谁也别加确认条。
 *
 * 背景：第一版按「脏表单二次确认」实现（对齐编辑弹窗的 discardOpen），
 * 用户明确否掉，改为直接关。本测试同时守住「别再把它加回来」。
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
  const from = page.lastIndexOf('className="ki-overlay', start);
  return page.slice(from, start);
}

describe('添加 Git 数据源弹窗：关闭即关闭', () => {
  it('遮罩点击直接关闭', () => {
    assert.match(
      addOverlayBlock(),
      /onMouseDown=\{\(event\) => \{\s*if \(event\.target === event\.currentTarget\) setAddOpen\(false\);/,
      '点遮罩应直接关闭',
    );
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
