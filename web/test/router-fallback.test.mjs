/**
 * 路由兜底单测（router/routes.tsx + styles/ki.css）
 *
 * 背景（2026-11-23，事件 #70）：`<Routes>` 无匹配项时渲染 `null` —— 手输错路由，或整站挂在
 * 子路径下而前缀没被正确处理（URL 是 `/ki/browse`），都表现为「整页空白 + 控制台无报错」，
 * 用户拿不到任何线索。锁住三件事，任何人重排路由表时都会在此显形：
 *   1) `<Routes>` 末尾有**顶层** `path="*"`（嵌套在 AppShell 里的 `*` 接不住 `/browseX`）；
 *   2) 兜底页把**实际访问的路径**渲染出来（前缀配错时这是唯一线索）；
 *   3) `.ki-notfound*` 样式存在（结构对但没居中/排版同样是坏页面）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const routesSrc = readFileSync(path.join(webRoot, 'src/router/routes.tsx'), 'utf8');
const cssSrc = readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');

describe('未匹配路由兜底（事件 #70）', () => {
  it('路由表末尾有 catch-all，且位于 AppShell 那个 Route 之外', () => {
    // 宽松匹配：允许换行与多余空白，避免纯格式调整造成假红（语义约束交给下面两条断言）
    assert.match(routesSrc, /<Route\s+path="\*"[\s\S]{0,40}NotFoundPage/);
    // 兜底必须是顶层路由：AppShell 闭合之后（嵌套在里面的 `*` 接不住根级 splat）
    assert.ok(
      routesSrc.indexOf('path="*"') > routesSrc.lastIndexOf('</Route>'),
      'catch-all 必须写在 AppShell 的 </Route> 之后',
    );
  });

  it('兜底页把实际访问路径（含 query）渲染出来 —— 前缀配错时唯一线索', () => {
    const body = routesSrc.slice(routesSrc.indexOf('function NotFoundPage'));
    assert.match(body, /location\.pathname/);
    assert.match(body, /location\.search/);
    assert.match(body, /回到总览/);
  });

  it('兜底页样式存在（否则结构对、观感坏）', () => {
    assert.match(cssSrc, /\.ki-notfound \{/);
    assert.match(cssSrc, /\.ki-notfound__path \{/);
  });
});
