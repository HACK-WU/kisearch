/**
 * 映射表组件渲染（REQ-20261104-002 / 工作项 18）
 *
 * 用 SSR 渲染真实组件，锁住三件纯函数测不到的事：
 *  1. 只剩 1 条时 ✕ 是 **disabled**（不是隐藏 —— 隐藏会让人以为功能没做）；
 *  2. 校验错误以 `role="alert"` 呈现，而不是只把输入框标红；
 *  3. 达到上限时「添加映射」被禁用且文案说明原因。
 *
 * ★ 只验证 DOM 结构与文案，不验证视觉（像素）；视觉走查需真机浏览器。
 * 运行：cd web && node --test test/datasource-mappings-render.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { DatasourceMappingsEditor } = await vite.ssrLoadModule('/src/components/DatasourceMappingsEditor.tsx');
const { MAX_MAPPINGS, validateMappingRows } = await vite.ssrLoadModule('/src/lib/datasourceMappings.ts');
after(async () => vite.close());

function render(props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client }, React.createElement(DatasourceMappingsEditor, props)),
  );
}

const base = { idPrefix: 't', scope: '', onChange: () => {}, disabled: false };

describe('DatasourceMappingsEditor 渲染', () => {
  it('1 条映射：✕ 禁用并说明「至少保留 1 条映射」', () => {
    const html = render({ ...base, rows: [{ subdir: 'docs/guide', group: '指南' }], error: null });
    assert.match(html, /aria-label="至少保留 1 条映射"/);
    assert.match(html, /title="至少保留 1 条映射"/);
    // 禁用态：✕ 按钮带 disabled
    const removeBtn = html.slice(html.indexOf('aria-label="至少保留 1 条映射"'));
    assert.match(removeBtn.slice(0, 120), /disabled/);
    assert.match(html, /1 条 · 至少 1 条，最多 20 条/);
  });

  it('2 条映射：两个子目录输入 + 每条一个可用的 ✕', () => {
    const html = render({
      ...base,
      rows: [{ subdir: 'docs/guide', group: '指南' }, { subdir: 'docs/api', group: '' }],
      error: null,
    });
    assert.match(html, /aria-label="第 1 条映射的仓库子目录"/);
    assert.match(html, /aria-label="第 2 条映射的仓库子目录"/);
    assert.match(html, /aria-label="删除第 1 条映射"/);
    assert.match(html, /添加映射/);
    assert.doesNotMatch(html, /至少保留 1 条映射/);
    // 多映射时提示「只导入这几条」
    assert.match(html, /本次将只导入这 2 个子目录/);
  });

  it('校验错误：role="alert" + 原始文案，且出错输入带 aria-invalid', () => {
    const rows = [{ subdir: 'docs', group: 'a' }, { subdir: 'docs/guide', group: 'b' }];
    const error = validateMappingRows(rows);
    const html = render({ ...base, rows, error });
    assert.equal(error.code, 'MAPPING_OVERLAP');
    assert.match(html, /role="alert"/);
    assert.match(html, /互相包含/);
    assert.match(html, /aria-invalid="true"/);
    // 出错时不再显示"会扫描整个仓库"这类提示
    assert.doesNotMatch(html, /本次会扫描整个仓库/);
  });

  it('达到上限：添加按钮禁用并给出原因', () => {
    const rows = Array.from({ length: MAX_MAPPINGS }, (_, i) => ({ subdir: `d${i}`, group: '' }));
    const html = render({ ...base, rows, error: null });
    // `disabled` 在 <button> 开标签上，位于文案之前 —— 整段匹配，别只截文案后半段
    assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>已达上限 ${MAX_MAPPINGS} 条</button>`));
  });

  it('单条根映射：提示「本次会扫描整个仓库」', () => {
    const html = render({ ...base, rows: [{ subdir: '', group: '' }], error: null });
    assert.match(html, /本次会扫描整个仓库/);
  });
});
