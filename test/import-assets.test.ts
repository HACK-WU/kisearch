/**
 * import-assets 单元测试 —— 本地图片附件收集与 /api/asset 路由（REQ-20260904-001）
 *
 * 覆盖：
 *   - extractImageRefs：markdown 语法 / HTML <img> / 含空格路径 / title 剥离
 *   - isCollectibleRelativeAsset：外链 / 协议相对 / posix 与 windows 绝对路径 / 锚点 排除
 *   - collectAndCopyAssets：正常复制（保持目录结构）、外链与绝对路径静默跳过、
 *     源目录外逃逸拒绝、目标路径穿越拒绝、大小超限、后缀白名单、未命中、重复引用去重
 *   - GET /api/asset：200 + 正确 MIME / 缺失 404 JSON（不伪装）/ 穿越 403 / 缺参 400
 *
 * 运行：npx jiti test/import-assets.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  extractImageRefs,
  isCollectibleRelativeAsset,
  collectAndCopyAssets,
  ASSET_EXTENSIONS,
} from '../src/lib/import.js';
import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { getAssetsDir } from '../src/lib/scope.js';
import { ensureScopeDir } from '../src/lib/store.js';

// ─── 测试隔离：临时 HOME，避免污染真实 ~/.ki ───
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-assets-test-'));
process.env.HOME = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePng(size = 64): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size, 7)]);
}

// ─── 纯函数：引用提取与形态判定 ───

describe('extractImageRefs', () => {
  it('提取 markdown 语法与 HTML <img> 两类写法', () => {
    const md = [
      '![架构图](images/arch.png)',
      '<img src="images/b.png" alt="B">',
      "![单引号](images/c.png 'title')",
      '正文 ![含空格](images/d e.png) 混排',
    ].join('\n');
    const refs = extractImageRefs(md);
    // 顺序语义：先遍历完 markdown 语法、再遍历 HTML <img>（非文档出现顺序）
    assert.deepEqual(refs, ['images/arch.png', 'images/c.png', 'images/d e.png', 'images/b.png']);
  });

  it('剥离尾部 title 且保留 URL 本体', () => {
    assert.deepEqual(extractImageRefs('![a](img/x.png "说明文字")'), ['img/x.png']);
  });

  it('无图片引用返回空数组', () => {
    assert.deepEqual(extractImageRefs('# 标题\n\n普通 [链接](docs/a.md) 不含图片。'), []);
  });

  it('尖括号 destination 与 #fragment 归一化', () => {
    assert.deepEqual(extractImageRefs('![alt](<images/deploy topo.png>)'), ['images/deploy topo.png']);
    assert.deepEqual(extractImageRefs('![alt](images/a.png#section)'), ['images/a.png']);
  });

  it('代码围栏内的示例图片不被提取', () => {
    const md = '```md\n![示例](images/fake.png)\n```\n\n![真实](images/real.png)';
    assert.deepEqual(extractImageRefs(md), ['images/real.png']);
  });
});

describe('isCollectibleRelativeAsset', () => {
  it('相对路径可收集', () => {
    assert.equal(isCollectibleRelativeAsset('images/a.png'), true);
    assert.equal(isCollectibleRelativeAsset('./img/a.png'), true);
    assert.equal(isCollectibleRelativeAsset('../img/a.png'), true); // 是否越界由 collectAndCopyAssets 判定
  });
  it('外链 / 协议相对 / 绝对路径 / 锚点 均排除', () => {
    assert.equal(isCollectibleRelativeAsset('https://cdn.example.com/a.png'), false);
    assert.equal(isCollectibleRelativeAsset('http://host/a.png'), false);
    assert.equal(isCollectibleRelativeAsset('//host/a.png'), false);
    assert.equal(isCollectibleRelativeAsset('file:///root/a.png'), false);
    assert.equal(isCollectibleRelativeAsset('data:image/png;base64,xxx'), false);
    assert.equal(isCollectibleRelativeAsset('/root/a.png'), false);
    assert.equal(isCollectibleRelativeAsset('C:\\img\\a.png'), false);
    assert.equal(isCollectibleRelativeAsset('#anchor'), false);
  });
});

// ─── collectAndCopyAssets：安全边界与复制语义 ───

describe('collectAndCopyAssets', () => {
  const src = fs.mkdtempSync(path.join(tmpHome, 'src-'));
  const dst = fs.mkdtempSync(path.join(tmpHome, 'dst-'));
  fs.mkdirSync(path.join(src, 'images'), { recursive: true });
  fs.writeFileSync(path.join(src, 'images', 'arch.png'), makePng());
  fs.writeFileSync(path.join(src, 'images', 'with space.png'), makePng());
  fs.writeFileSync(path.join(src, 'images', 'note.txt'), 'not an image');
  fs.writeFileSync(path.join(src, 'big.png'), makePng(2048));
  // 源目录之外的文件：用于验证逃逸拒绝
  const outside = path.join(tmpHome, 'outside-secret.png');
  fs.writeFileSync(outside, makePng());

  const run = (urls: string[], maxAssetBytes = 1024) =>
    collectAndCopyAssets({
      sourceDir: src,
      mdDir: src,
      mdLabel: 'doc.md',
      assetsDir: dst,
      urls,
      maxAssetBytes,
    });

  it('正常复制并保持目录结构', () => {
    const r = run(['images/arch.png']);
    assert.deepEqual(r.copied, ['images/arch.png']);
    assert.deepEqual(r.warnings, []);
    assert.equal(fs.existsSync(path.join(dst, 'images', 'arch.png')), true);
  });

  it('含空格文件名可复制', () => {
    const r = run(['images/with space.png']);
    assert.deepEqual(r.copied, ['images/with space.png']);
    assert.equal(fs.existsSync(path.join(dst, 'images', 'with space.png')), true);
  });

  it('外链与绝对路径静默跳过（不复制、不告警）', () => {
    const r = run(['https://cdn.example.com/a.png', '/etc/passwd', 'file:///root/x.png']);
    assert.deepEqual(r.copied, []);
    assert.deepEqual(r.warnings, []);
  });

  it('源目录外逃逸拒绝并告警', () => {
    const r = run(['../outside-secret.png']);
    assert.deepEqual(r.copied, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /超出源目录/);
  });

  it('目标路径穿越拒绝并告警', () => {
    const r = run(['images/..%2F..%2Fevil.png']);
    assert.deepEqual(r.copied, []);
    assert.ok(r.warnings.some((w) => /越界|超出源目录|未命中/.test(w)));
  });

  it('大小超限跳过并告警', () => {
    const r = run(['big.png'], 1024);
    assert.deepEqual(r.copied, []);
    assert.match(r.warnings[0], /附件过大/);
  });

  it('后缀白名单外跳过并告警', () => {
    const r = run(['images/note.txt']);
    assert.deepEqual(r.copied, []);
    assert.match(r.warnings[0], /后缀不在白名单/);
    assert.ok(ASSET_EXTENSIONS.includes('.png'));
  });

  it('未命中源文件跳过并告警', () => {
    const r = run(['images/missing.png']);
    assert.deepEqual(r.copied, []);
    assert.match(r.warnings[0], /未命中源目录/);
  });

  it('同一 URL 重复引用只复制一次', () => {
    const r = run(['images/arch.png', 'images/arch.png']);
    assert.deepEqual(r.copied, ['images/arch.png']);
  });

  it('符号链接指向源目录外拒绝并告警（防后缀伪装软链越界读宿主机文件）', () => {
    const link = path.join(src, 'images', 'link.png');
    if (!fs.existsSync(link)) fs.symlinkSync(outside, link);
    const r = run(['images/link.png']);
    assert.deepEqual(r.copied, []);
    assert.match(r.warnings[0], /符号链接指向源目录外/);
  });
});

// ─── GET /api/asset 路由 ───

const SCOPE = 'asset-route-test';
const GROUP = 'g1';

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

let base = '';
let closeServer: (() => Promise<void>) | null = null;

before(async () => {
  ensureScopeDir(SCOPE);
  const assetsDir = getAssetsDir(SCOPE, GROUP);
  fs.mkdirSync(path.join(assetsDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'images', 'arch.png'), makePng());

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    buildServer: buildTestServer,
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  closeServer = async () => {
    await closeAllSessions();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
});

after(async () => {
  if (closeServer) await closeServer();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/asset', () => {
  const q = (p: string) =>
    `${base}/api/asset?scope=${SCOPE}&group=${encodeURIComponent(GROUP)}&path=${encodeURIComponent(p)}`;

  it('命中附件返回 200 + image/png', async () => {
    const res = await fetch(q('images/arch.png'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 8).equals(PNG_MAGIC), true);
  });

  it('缺失附件返回 404 JSON（不伪装成 200 + HTML）', async () => {
    const res = await fetch(q('images/nope.png'));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });

  it('路径穿越返回 403', async () => {
    const res = await fetch(q('../../../../etc/passwd'));
    assert.equal(res.status, 403);
  });

  it('缺 group/path 参数返回 400', async () => {
    const res = await fetch(`${base}/api/asset?scope=${SCOPE}`);
    assert.equal(res.status, 400);
  });

  // P0 回归锁：group 原样进 path.join 会搬移前缀校验锚点 → 跨 scope 越权 / KB 外读取
  it('group 含 .. 穿越返回 400', async () => {
    const res = await fetch(`${base}/api/asset?scope=${SCOPE}&group=${encodeURIComponent('../evil')}&path=images/arch.png`);
    assert.equal(res.status, 400);
  });

  it('group 为绝对路径返回 400', async () => {
    const res = await fetch(`${base}/api/asset?scope=${SCOPE}&group=${encodeURIComponent('/etc')}&path=passwd`);
    assert.equal(res.status, 400);
  });

  it('group 含空段（a//b）返回 400', async () => {
    const res = await fetch(`${base}/api/asset?scope=${SCOPE}&group=${encodeURIComponent('a//b')}&path=images/arch.png`);
    assert.equal(res.status, 400);
  });

  it('非图片后缀返回 404（后缀白名单）', async () => {
    const res = await fetch(q('images/arch.png.txt'));
    assert.equal(res.status, 404);
  });

  it('含空格 path 经双重编码 round-trip 命中', async () => {
    const assetsDir = getAssetsDir(SCOPE, GROUP);
    fs.writeFileSync(path.join(assetsDir, 'images', 'with space.png'), makePng());
    // 前端 encodeImageSpaces + URLSearchParams 会双编码空格 → 服务端 searchParams 解一次 + 手动解一次
    const res = await fetch(`${base}/api/asset?scope=${SCOPE}&group=${encodeURIComponent(GROUP)}&path=${encodeURIComponent('images/with%20space.png')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/png/);
  });
});
