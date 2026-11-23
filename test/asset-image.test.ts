/**
 * asset-image 单元测试（REQ-20261123-008 · B0）
 *
 * 覆盖设计 §6.4 的归一化规则与 §7 的错误分支：
 *   · normalizeImageRef：`./` 前缀 / 裸相对 / 子目录 / `../` 越界 / 外链与 data URI /
 *     绝对路径 / 空 / 查询串 / %20 解码
 *   · detectImageKind：PNG / JPEG / WebP / SVG（带 XML 声明）/ 未知
 *   · resolveAssetPath：双锚点（group 注入 `..`、引用带 `..`）
 *   · resolveAssetImage：正常位图 / **双层 assets 保真** / 缺失 / 后缀与内容不符 /
 *     不支持的格式 / 超限 / SVG 只读不栅格化
 *   · resolveAssetImages：顺序保持、单个失败不中断
 *
 * 运行：npx jiti test/asset-image.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome } from './isolate-home.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { getAssetsDir } from '../src/lib/scope.js';
import {
  normalizeImageRef,
  detectImageKind,
  resolveAssetPath,
  resolveAssetImage,
  resolveAssetImages,
  buildImageList,
  executeGetImage,
  RASTER_EXTS,
  SVG_EXTS,
} from '../src/lib/asset-image.js';

// ─── 测试隔离：临时家目录 + 最小配置（与 import-assets.test.ts 同款）───
const tempHome = useTempHome('ki-asset-image-test-');
process.env.KI_CONFIG_PATH = path.join(tempHome.home, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const SCOPE = 'imgscope';
const GROUP = 'demo/basics';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const makePng = (pad = 32): Buffer => Buffer.concat([PNG_MAGIC, Buffer.alloc(pad, 7)]);
const makeJpeg = (pad = 32): Buffer => Buffer.concat([JPEG_MAGIC, Buffer.alloc(pad, 7)]);
const makeWebp = (pad = 32): Buffer =>
  Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii'), Buffer.alloc(pad, 7)]);
const makeSvg = (body = '<rect width="10" height="10"/>'): Buffer =>
  Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${body}</svg>`, 'utf8');

// ─── ① 归一化 ───────────────────────────────────────────

describe('normalizeImageRef', () => {
  it('`./assets/x.svg` 保留 assets 前缀（双层落点保真的前提）', () => {
    const r = normalizeImageRef('./assets/x.svg');
    assert.equal(r.ok, true);
    assert.equal(r.rel, 'assets/x.svg');
    assert.equal(r.ext, '.svg');
  });

  it('裸相对路径原样保留', () => {
    assert.equal(normalizeImageRef('assets/x.png').rel, 'assets/x.png');
  });

  it('子目录引用不取 basename', () => {
    const r = normalizeImageRef('images/a.png');
    assert.equal(r.rel, 'images/a.png');
  });

  it('`../` 判为越界', () => {
    const r = normalizeImageRef('../assets/x.svg');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'traversal');
  });

  it('`a/../../x.png` 归一化后同样越界', () => {
    assert.equal(normalizeImageRef('a/../../x.png').reason, 'traversal');
  });

  it('外链与 data URI 一律拒（模型侧取不到）', () => {
    assert.equal(normalizeImageRef('https://example.com/a.png').reason, 'external');
    assert.equal(normalizeImageRef('data:image/png;base64,AAAA').reason, 'external');
    // Windows 盘符也按协议形态拒掉（不会误当相对路径去拼）
    assert.equal(normalizeImageRef('C:\\Users\\a.png').reason, 'external');
  });

  it('绝对路径拒', () => {
    assert.equal(normalizeImageRef('/etc/passwd').reason, 'absolute');
  });

  it('空引用拒', () => {
    assert.equal(normalizeImageRef('').reason, 'empty');
    assert.equal(normalizeImageRef('   ').reason, 'empty');
  });

  it('去查询串与锚点', () => {
    assert.equal(normalizeImageRef('assets/a.png?v=1#x').rel, 'assets/a.png');
  });

  it('%20 解码；裸 % 不炸', () => {
    assert.equal(normalizeImageRef('assets/with%20space.png').rel, 'assets/with space.png');
    assert.equal(normalizeImageRef('assets/50%.png').rel, 'assets/50%.png');
  });

  it('多层 ./ 前缀累积剥离', () => {
    assert.equal(normalizeImageRef('././assets/x.png').rel, 'assets/x.png');
  });
});

// ─── ② 预检 ─────────────────────────────────────────────

describe('detectImageKind', () => {
  it('按魔数识别位图', () => {
    assert.equal(detectImageKind(makePng()), 'png');
    assert.equal(detectImageKind(makeJpeg()), 'jpeg');
    assert.equal(detectImageKind(makeWebp()), 'webp');
  });

  it('SVG 带 XML 声明也能识别（不做前缀匹配）', () => {
    assert.equal(detectImageKind(makeSvg()), 'svg');
  });

  it('未知内容返回 unknown', () => {
    assert.equal(detectImageKind(Buffer.from('not an image at all')), 'unknown');
  });

  it('空头部不抛错', () => {
    assert.equal(detectImageKind(Buffer.alloc(0)), 'unknown');
  });
});

// ─── ③ 路径解析（双锚点）────────────────────────────────

describe('resolveAssetPath', () => {
  before(() => ensureScopeDir(SCOPE));

  it('正常引用解析到 assets 目录内', () => {
    const r = resolveAssetPath(SCOPE, GROUP, 'assets/x.png');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.absPath.startsWith(getAssetsDir(SCOPE, GROUP)), r.absPath);
    assert.equal(r.ext, '.png');
  });

  it('group 注入 `..` 被拒（锚点一）', () => {
    const r = resolveAssetPath(SCOPE, '../evil', 'a.png');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'invalid-group');
  });

  it('group 为空被拒', () => {
    const r = resolveAssetPath(SCOPE, '', 'a.png');
    assert.equal(r.ok, false);
  });

  it('引用本身越界被拒（锚点二）', () => {
    const r = resolveAssetPath(SCOPE, GROUP, '../outside.png');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'traversal');
  });
});

// ─── ④ 读取 ─────────────────────────────────────────────

/** 造齐测试用 assets（幂等；多个 describe 各自 before 调一次，不依赖执行顺序） */
function prepareAssets(): void {
  ensureScopeDir(SCOPE);
  const dir = getAssetsDir(SCOPE, GROUP);
  // 常规落点
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'ok.png'), makePng());
  // 双层 assets：导入 `./assets/x.svg` 后的真实形态
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'nested.svg'), makeSvg());
  // 后缀与内容不符
  fs.writeFileSync(path.join(dir, 'fake.png'), makeJpeg());
  // 不支持的格式
  fs.writeFileSync(path.join(dir, 'a.gif'), Buffer.from('GIF89a', 'ascii'));
  // 超限样本
  fs.writeFileSync(path.join(dir, 'big.png'), makePng(4096));
  // 陌生格式（无后缀）
  fs.writeFileSync(path.join(dir, 'noext'), makePng());
}

describe('resolveAssetImage', () => {
  before(prepareAssets);

  it('正常位图：返回字节与 MIME', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'images/ok.png');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.image.mime, 'image/png');
    assert.equal(r.image.kind, 'png');
    assert.equal(r.image.ref, 'images/ok.png');
    assert.ok(r.image.bytes > 0);
  });

  it('双层 assets 保真：`./assets/x.svg` 命中 assets/assets/x.svg', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, './assets/nested.svg');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.image.ref, 'assets/nested.svg');
    assert.equal(r.image.kind, 'svg');
  });

  it('文件缺失 → IMAGE_NOT_FOUND（文案可读）', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'assets/missing.png');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_NOT_FOUND');
    assert.match(r.message, /assets/);
  });

  it('后缀与内容不符 → IMAGE_INVALID（不信后缀）', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'fake.png');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_INVALID');
  });

  it('不支持的格式 → IMAGE_FORMAT_UNSUPPORTED', async () => {
    const gif = await resolveAssetImage(SCOPE, GROUP, 'a.gif');
    assert.equal(gif.ok, false);
    if (gif.ok) return;
    assert.equal(gif.code, 'IMAGE_FORMAT_UNSUPPORTED');

    const noext = await resolveAssetImage(SCOPE, GROUP, 'noext');
    assert.equal(noext.ok, false);
    if (noext.ok) return;
    assert.equal(noext.code, 'IMAGE_FORMAT_UNSUPPORTED');
  });

  it('超过上限 → IMAGE_TOO_LARGE', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'big.png', { maxBytes: 1024 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_TOO_LARGE');
  });

  it('外链 → IMAGE_INVALID（不尝试代理）', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'https://example.com/a.png');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'IMAGE_INVALID');
  });

  it('SVG 在 B0 只读不栅格化（kind=svg，交给 B3）', async () => {
    const r = await resolveAssetImage(SCOPE, GROUP, 'assets/nested.svg');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.image.kind, 'svg');
    // 白名单常量对外可见，供清单生成判定
    assert.equal(SVG_EXTS.has('.svg'), true);
    assert.equal(RASTER_EXTS.has('.png'), true);
    assert.equal(RASTER_EXTS.has('.svg'), false);
  });
});

// ─── ⑤ 清单 ─────────────────────────────────────────────

describe('buildImageList', () => {
  before(prepareAssets);

  it('无图文档返回空数组（不产生 images 字段的依据）', async () => {
    const list = await buildImageList(SCOPE, GROUP, '# 纯文本\n没有任何图');
    assert.equal(list.length, 0);
  });

  it('按正文顺序给 index，存在与缺失分别标注', async () => {
    const md = [
      '开头 ![存在的图](images/ok.png)',
      '中间 ![缺的图](assets/missing.png)',
    ].join('\n');
    const list = await buildImageList(SCOPE, GROUP, md);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.index, 1);
    assert.equal(list[0]!.ref, 'images/ok.png');
    assert.equal(list[0]!.supported, true);
    assert.equal(list[0]!.mime, 'image/png');
    assert.equal(list[1]!.index, 2);
    assert.equal(list[1]!.supported, false);
    assert.match(list[1]!.reason ?? '', /缺失/);
  });

  it('同一张图重复引用只出现一次（按归一化后的 ref 去重）', async () => {
    const md = '![a](./images/ok.png)\n![a again](images/ok.png)';
    const list = await buildImageList(SCOPE, GROUP, md);
    assert.equal(list.length, 1);
  });

  it('外链标 supported:false 且原因可读（不静默丢弃）', async () => {
    const list = await buildImageList(SCOPE, GROUP, '![外链](https://example.com/a.png)');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.supported, false);
    assert.match(list[0]!.reason ?? '', /外部地址/);
  });

  it('SVG 在 B1 即按最终设计标 supported:true（栅格化在 B3 接上）', async () => {
    const list = await buildImageList(SCOPE, GROUP, '![图](./assets/nested.svg)');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.ref, 'assets/nested.svg');
    assert.equal(list[0]!.mime, 'image/svg+xml');
    assert.equal(list[0]!.supported, true);
  });

  it('HTML <img> 写法同样进清单', async () => {
    const list = await buildImageList(SCOPE, GROUP, '<img src="images/ok.png" alt="x">');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.ref, 'images/ok.png');
  });

  it('代码围栏内的图片语法不算引用', async () => {
    const md = ['```md', '![示例](images/ok.png)', '```'].join('\n');
    const list = await buildImageList(SCOPE, GROUP, md);
    assert.equal(list.length, 0);
  });
});

// ─── ⑥ 取图执行（ki_get_image 的内部实现）──────────────

describe('executeGetImage', () => {
  before(prepareAssets);

  it('正常取图：返回判别形状 + base64 载荷 + 可读摘要', async () => {
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['images/ok.png'] });
    assert.equal(r.kind, 'images');
    assert.equal(r.images.length, 1);
    const img = r.images[0]!;
    assert.equal(img.mimeType, 'image/png');
    assert.equal(img.ref, 'images/ok.png');
    assert.ok(img.data.length > 0);
    // 纯 base64（不带 data: 前缀）—— 前缀由上层拼
    assert.equal(img.data.startsWith('data:'), false);
    assert.match(r.text, /images\/ok\.png/);
  });

  it('部分失败不整体失败：成功的照给，失败的写进摘要', async () => {
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['images/ok.png', 'assets/missing.png'] });
    assert.equal(r.images.length, 1, '成功的那张仍要返回');
    assert.match(r.text, /未成功/);
    assert.match(r.text, /assets\/missing\.png/);
  });

  it('全部失败：images 为空但摘要逐条说明原因', async () => {
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['assets/missing.png'] });
    assert.equal(r.images.length, 0);
    assert.match(r.text, /没有成功读取/);
    assert.match(r.text, /缺失|不在 assets/);
  });

  it('SVG 在 allowSvg 未开时被拒并说明"需栅格化"（开关语义）', async () => {
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['assets/nested.svg'] });
    assert.equal(r.images.length, 0);
    assert.match(r.text, /栅格化/);
  });

  it('SVG + allowSvg:true → 栅格化成 PNG，并标注来源格式与渲染尺寸（B3）', async () => {
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['assets/nested.svg'], allowSvg: true });
    assert.equal(r.images.length, 1, r.text);
    const img = r.images[0]!;
    assert.equal(img.mimeType, 'image/png', '不能把 svg 原样下发（上游会 400）');
    assert.equal(img.sourceFormat, 'image/svg+xml');
    assert.equal(img.ref, 'assets/nested.svg');
    assert.ok((img.width ?? 0) > 0 && (img.height ?? 0) > 0, '栅格化后应给出渲染尺寸');
    assert.ok(img.bytes > 0);
  });

  it('载荷保持入参顺序（多张时）', async () => {
    fs.mkdirSync(path.join(getAssetsDir(SCOPE, GROUP), 'images'), { recursive: true });
    fs.writeFileSync(path.join(getAssetsDir(SCOPE, GROUP), 'images', 'ok2.png'), makePng());
    const r = await executeGetImage({ scope: SCOPE, group: GROUP, refs: ['images/ok2.png', 'images/ok.png'] });
    assert.deepEqual(r.images.map((i) => i.ref), ['images/ok2.png', 'images/ok.png']);
  });
});

// ─── ⑦ 批量 ─────────────────────────────────────────────

describe('resolveAssetImages', () => {
  before(() => ensureScopeDir(SCOPE));

  it('保持入参顺序，单个失败不中断', async () => {
    const list = await resolveAssetImages(SCOPE, GROUP, [
      'images/ok.png',
      'assets/missing.png',
      'assets/nested.svg',
    ]);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((x) => x.ref), ['images/ok.png', 'assets/missing.png', 'assets/nested.svg']);
    assert.equal(list[0]!.result.ok, true);
    assert.equal(list[1]!.result.ok, false);
    assert.equal(list[2]!.result.ok, true);
  });
});
