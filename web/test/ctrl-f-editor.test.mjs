/**
 * AppShell 全局 Ctrl+F 判定链的源码守卫（2026-11-12）。
 *
 * 背景：编辑器（`.ki-editor-overlay`，主体是 textarea）从阅读抽屉里打开时，
 * `.ki-drawer` 仍在 ⇒ 原判定链先命中「文档内查找」，查找栏展开在**被编辑器盖住**的
 * 抽屉里，用户看到的是「按 Ctrl+F 没反应」。
 *
 * 不变量：编辑器判定必须存在，且**早于**查看器判定（顺序错了就等于没加）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(path.join(webRoot, 'src/layouts/AppShell.tsx'), 'utf8');

describe('AppShell 全局 Ctrl+F：编辑器让位浏览器原生查找', () => {
  it('存在编辑器判定且直接 return（不 preventDefault）', () => {
    assert.match(
      src,
      /if \(document\.querySelector\('\.ki-editor-overlay'\)\) return;/,
      '必须在 handler 里显式让位，不能只靠注释说明',
    );
  });

  it('编辑器判定早于抽屉判定（顺序错了等于没加）', () => {
    // 只看 handler 函数体内：注释 / 其它函数里出现同样字面量时不该干扰顺序判定
    const start = src.indexOf('const handler = (e: KeyboardEvent)');
    const end = src.indexOf('window.addEventListener', start);
    assert.ok(start > 0 && end > start, '未定位到 Ctrl+F handler');
    const body = src.slice(start, end);
    const editorAt = body.indexOf("querySelector('.ki-editor-overlay')");
    const drawerAt = body.indexOf("querySelector('.ki-drawer')");
    assert.ok(editorAt > 0, 'handler 内未找到编辑器判定');
    assert.ok(drawerAt > 0, 'handler 内未找到抽屉判定');
    assert.ok(editorAt < drawerAt, `编辑器判定(${editorAt}) 必须早于抽屉判定(${drawerAt})`);
  });
});
