/**
 * SVG 栅格化（REQ-20261123-008 · B3）
 *
 * 守四件容易写错的事：
 *   ① worker 入口能被找到（`.mjs` 与 `import.meta.url` 拼接写错时，只有运行时爆）
 *   ② 输出宽度受上限约束（否则一张超大 SVG 会烧掉几倍 token）
 *   ③ 同一文件二次取图**命中缓存**（缓存失效或 key 写错会让复杂图每次重渲 2.5s）
 *   ④ 畸形 SVG 走 `IMAGE_RENDER_FAILED` 而不是抛到调用方（必须降级成可读文案）
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/svg-raster.test.ts`
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  rasterizeSvgFile,
  rasterCacheKey,
  RASTER_MAX_WIDTH,
  __rasterCacheSize,
  __rasterWorkerPath,
  __resetRasterState,
} from '../src/lib/svg-raster.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-raster-test-'));

/** 生成一个能渲染的最小 SVG（宽高可变） */
function writeSvg(name: string, width: number, height: number, body = ''): string {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<rect width="${width}" height="${height}" fill="#f0f0f0"/>`
      + `<text x="10" y="30" font-size="16">中文测试</text>`
      + `${body}</svg>`,
    'utf8',
  );
  return p;
}

before(() => __resetRasterState());
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言
  }
});

describe('svg-raster · worker 入口', () => {
  it('worker 路径指向真实存在的 .mjs（不是 .ts）', () => {
    const p = __rasterWorkerPath();
    assert.ok(p.endsWith('svg-raster.worker.mjs'), `实际：${p}`);
    assert.equal(fs.existsSync(p), true, 'worker 文件必须能被 new Worker 直接加载');
  });
});

describe('svg-raster · 渲染', () => {
  it('把 SVG 画成 PNG，且宽度不超过上限', async () => {
    const file = writeSvg('wide.svg', 3000, 900);
    const r = await rasterizeSvgFile(file, rasterCacheKey('t', 'g', 'wide.svg'));
    assert.equal(r.ok, true, r.ok ? '' : `失败：${r.message}`);
    if (!r.ok) return;
    assert.equal(r.width, RASTER_MAX_WIDTH, '按宽缩放应正好压到上限');
    assert.ok(r.height > 0 && r.height < r.width);
    // PNG magic
    assert.deepEqual([...r.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('同一文件二次取图命中缓存（不重渲）', async () => {
    const file = writeSvg('cached.svg', 400, 200);
    const key = rasterCacheKey('t', 'g', 'cached.svg');

    const first = await rasterizeSvgFile(file, key);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.cached, false, '首次应为实际渲染');

    const second = await rasterizeSvgFile(file, key);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.cached, true, '二次应命中缓存');
    assert.equal(second.png.length, first.png.length);
    assert.ok(__rasterCacheSize() >= 1);
  });

  it('文件内容变化（mtime/size 变）→ 不复用旧缓存', async () => {
    const file = writeSvg('mutate.svg', 200, 200);
    const key = rasterCacheKey('t', 'g', 'mutate.svg');
    const a = await rasterizeSvgFile(file, key);
    assert.equal(a.ok, true);

    // 改内容 + 改 mtime：真实场景是文档重导覆盖 assets
    writeSvg('mutate.svg', 200, 200, '<circle cx="50" cy="50" r="40" fill="red"/>');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);

    const b = await rasterizeSvgFile(file, key);
    assert.equal(b.ok, true);
    if (!b.ok) return;
    assert.equal(b.cached, false, '内容变了必须重渲');
  });

  it('畸形 SVG → IMAGE_RENDER_FAILED（不抛到调用方）', async () => {
    const p = path.join(dir, 'broken.svg');
    fs.writeFileSync(p, '<svg><rect', 'utf8');
    const r = await rasterizeSvgFile(p, rasterCacheKey('t', 'g', 'broken.svg'));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_RENDER_FAILED');
    assert.match(r.message, /渲染失败|读取/);
  });

  it('文件不存在 → IMAGE_RENDER_FAILED', async () => {
    const r = await rasterizeSvgFile(path.join(dir, 'nope.svg'), rasterCacheKey('t', 'g', 'nope.svg'));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_RENDER_FAILED');
  });

  it('源文件超 4MB → IMAGE_TOO_LARGE（不浪费渲染）', async () => {
    const p = path.join(dir, 'huge.svg');
    fs.writeFileSync(p, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<!-- pad -->'.repeat(500_000)}</svg>`, 'utf8');
    const r = await rasterizeSvgFile(p, rasterCacheKey('t', 'g', 'huge.svg'));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_TOO_LARGE');
  });
});
