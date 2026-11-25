/**
 * `/open/v1/atlas/*` 契约测试（2026-11-25 · 图集远程部署）。
 *
 * 覆盖「远程部署能不能安全落地」，而不是图集内容对不对（那是 atlas-package.test.ts 的事）：
 *   - 正常上传 → 200 + `packageSha256` 与本地算的一致（这是「装进去的确实是这个包」的硬证据）
 *   - status 与上传响应同形；`sha256`（entry）与 `packageSha256`（zip）是两个字段，不能混
 *   - 重复上传 → `archived:true`，且 archive 只留 1 版
 *   - **前置校验必须早于收流**：只读库 / 库不存在 / 越权 / 只读 token / Content-Type
 *   - 坏包矩阵 → `OPEN_API_ATLAS_PACKAGE_INVALID` + `atlasCode`（14xx）
 *   - 上限口径 = `min(uploadMaxBytes, MAX_ZIP_BYTES)`（**不是** `MAX_API_BODY` 的 16MiB）
 *   - 开关：`uploadApi=false` 时 package 与 status 一并 404
 *   - ping 回显 `capabilities.atlas`（客户端据此决定能不能传、传多大）
 *
 * 未覆盖：视图名拒绝（视图由独立的视图文件定义，造它要写盘改全局视图表；
 * 该判定复用 `isViewName`，与 `/open/v1/doc`、`/open/v1/import` 同源）。
 *
 * 运行：npx jiti test/open-api-atlas.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { resetConfigCache } from '../src/lib/config.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';
import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.ts';
import { ensureScopeDir } from '../src/lib/store.ts';
import { archiveDir, atlasDir, readStatus } from '../src/lib/atlas/index.ts';

// ─── 测试库 ───
const TAG = `${Date.now()}`.slice(-6);
const SCOPE = `atlas-oa-${TAG}`;
const SCOPE_RO = `atlas-oar-${TAG}`;
const SCOPE_MISSING = `atlas-oam-${TAG}`; // 故意不建目录
// 归档用例要「干净的首装」，与 SCOPE 分开：SCOPE 在更早的用例里已经装过包了
const SCOPE_ARCH = `atlas-oaa-${TAG}`;

registerTestScope(SCOPE);
registerTestScope(SCOPE_RO);
registerTestScope(SCOPE_ARCH);

// ─── token ───
const TOKENS: Record<string, TokenAuth> = {
  'tok-rw': { id: 'tok-rw-abcdef123456', scopes: ['all'], readOnly: false },
  'tok-ro': { id: 'tok-ro-abcdef123456', scopes: ['all'], readOnly: true },
  'tok-limited': { id: 'tok-limited-xyz', scopes: ['some-other-scope'], readOnly: false },
};

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

// ─── zip 构造（与 atlas-package.test.ts 同款：手写 PK 字段，避免引第三方依赖）───
const HTML_OK = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>'
  + '<body><script>window.__cfg={"baked": true,"title":"远程部署测试"};</script>ok</body></html>';

function buildZip(files: Array<{ name: string; data: string | Buffer }>, method = 0): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = zlib.crc32(data);
    const stored = method === 0 ? data : zlib.deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const okZip = (html = HTML_OK): Buffer => buildZip([
  { name: 'atlas.html', data: html },
  { name: 'meta.json', data: '{"title":"远程部署测试","branch":"main","baseline":"abc1234"}' },
]);

const sha256Of = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

// ─── server ───
interface Handle { base: string; close: () => Promise<void> }

let open: Handle;
let closed: Handle;
let tiny: Handle; // uploadMaxBytes 极小，验证上限取 min()

async function start(opts: { uploadApi: boolean; uploadMaxBytes: number }): Promise<Handle> {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    resolveClientAddr: () => '127.0.0.1',
    resolveTokenAuth: (t: string) => TOKENS[t],
    uploadApi: opts.uploadApi,
    uploadMaxBytes: opts.uploadMaxBytes,
    buildServer: buildTestServer,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { port } = httpServer.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

interface Reply { status: number; body: any }

async function call(
  base: string,
  pathname: string,
  init: { method?: string; token?: string; contentType?: string; body?: Buffer } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  if (init.contentType) headers['Content-Type'] = init.contentType;
  const res = await fetch(`${base}${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body ? { body: init.body } : {}),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const upload = (base: string, scope: string, zip: Buffer, token = 'tok-rw', contentType = 'application/zip'): Promise<Reply> =>
  call(base, `/open/v1/atlas/package?scope=${encodeURIComponent(scope)}`, {
    method: 'POST', token, contentType, body: zip,
  });

/** 把某个 scope 标记为只读（写回测试配置 + 清配置缓存） */
function markReadonly(scope: string): void {
  const cfg = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8')) as Record<string, unknown>;
  const list = new Set<string>(Array.isArray(cfg.scopeReadonly) ? (cfg.scopeReadonly as string[]) : []);
  list.add(scope);
  cfg.scopeReadonly = [...list];
  fs.writeFileSync(testConfigPath, JSON.stringify(cfg), 'utf-8');
  resetConfigCache();
}

before(async () => {
  ensureScopeDir(SCOPE);
  ensureScopeDir(SCOPE_RO);
  ensureScopeDir(SCOPE_ARCH);
  markReadonly(SCOPE_RO);

  open = await start({ uploadApi: true, uploadMaxBytes: 8 * 1024 * 1024 });
  closed = await start({ uploadApi: false, uploadMaxBytes: 8 * 1024 * 1024 });
  tiny = await start({ uploadApi: true, uploadMaxBytes: 1024 });
});

after(async () => {
  await open?.close();
  await closed?.close();
  await tiny?.close();
  fs.rmSync(atlasDir(SCOPE), { recursive: true, force: true });
  cleanupTestConfig();
  resetConfigCache();
});

describe('正常路径', () => {
  it('① 上传成功：packageSha256 与本地一致，sha256 是 entry 的，exists 为真', async () => {
    const zip = okZip();
    const localSha = sha256Of(zip);
    const r = await upload(open.base, SCOPE, zip);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.scope, SCOPE);
    assert.equal(r.body.exists, true);
    assert.equal(r.body.packageSha256, localSha, 'packageSha256 必须等于 zip 字节的 sha256');
    // 两个指纹语义不同：entry 的 sha256 不等于 zip 的（否则字段没意义）
    assert.notEqual(r.body.sha256, localSha, 'sha256 是 entry html 的指纹，不应等于 zip 的');
    assert.equal(r.body.packageSize, zip.length);
    assert.equal(r.body.title, '远程部署测试');
    assert.equal(r.body.branch, 'main');
    assert.equal(r.body.baseline, 'abc1234');
    assert.equal(r.body.archived, false, '首次安装没有上一版可归档');
    // uploadedBy 三源可区分：本地 cli: / Web http:web / 远程 open-api:
    assert.equal(r.body.uploadedBy, 'open-api:tok-rw-a', '取 tokenId 前 8 位');
  });

  it('② status 与上传响应同形（同一套字段名）', async () => {
    const up = await upload(open.base, SCOPE, okZip());
    const st = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE}`, { token: 'tok-rw' });

    assert.equal(st.status, 200);
    assert.equal(st.body.ok, true);
    assert.equal(st.body.exists, true);
    assert.equal(st.body.packageSha256, up.body.packageSha256);
    assert.equal(st.body.sha256, up.body.sha256);
    assert.equal(st.body.packageSize, up.body.packageSize);
  });

  it('③ 未部署的库：exists:false 且不建目录（不是错误）', async () => {
    const st = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE_RO}`, { token: 'tok-rw' });
    assert.equal(st.status, 200);
    assert.equal(st.body.exists, false);
    assert.equal(st.body.ok, true);
  });

  it('④ 重复上传：archived:true，archive 只留 1 版', async () => {
    const r1 = await upload(open.base, SCOPE_ARCH, okZip());
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.archived, false, '干净库的首装不该有归档');
    const r2 = await upload(open.base, SCOPE_ARCH, okZip());
    assert.equal(r2.status, 200);
    assert.equal(r2.body.archived, true);

    const files = fs.readdirSync(archiveDir(SCOPE_ARCH)).filter((f) => f.endsWith('.zip'));
    assert.equal(files.length, 1, `archive 应只留 1 版，实际 ${files.length}`);
  });

  it('④-b `title` 参数只在包内没声明标题时兜底（auto-review 抓到的失效参数）', async () => {
    // 包内既无 meta.json、内嵌 config 也不带 title → title 才会由 opts.meta 补上
    const noTitleHtml = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head>'
      + '<body><script>window.__cfg={"baked": true};</script>ok</body></html>';
    const bare = buildZip([{ name: 'atlas.html', data: noTitleHtml }]);
    const r = await call(open.base, `/open/v1/atlas/package?scope=${SCOPE_ARCH}&title=${encodeURIComponent('兜底标题')}`, {
      method: 'POST', token: 'tok-rw', contentType: 'application/zip', body: bare,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, '兜底标题', '--title 必须真的传到内核，而不是只在客户端回显');

    // 反向：包内已声明标题时，title 不得覆盖（内核既有优先级：包内 > 内嵌 > 调用方）
    const declared = await call(open.base, `/open/v1/atlas/package?scope=${SCOPE_ARCH}&title=${encodeURIComponent('不该生效')}`, {
      method: 'POST', token: 'tok-rw', contentType: 'application/zip', body: okZip(),
    });
    assert.equal(declared.status, 200, JSON.stringify(declared.body));
    assert.equal(declared.body.title, '远程部署测试', '包内声明优先，title 只兜底');
  });

  it('⑤ 旧 meta（无 packageSha256）可读，不报错', async () => {
    // 模拟 2026-11-25 之前写入的 meta：手工删掉字段
    const metaFile = path.join(atlasDir(SCOPE), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as Record<string, unknown>;
    const before = readStatus(SCOPE).meta?.packageSha256;
    assert.ok(before && before.length === 64);
    delete meta.packageSha256;
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf-8');

    const st = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE}`, { token: 'tok-rw' });
    assert.equal(st.status, 200);
    assert.equal(st.body.exists, true);
    assert.equal(st.body.packageSha256, undefined, '字段缺失就该缺失，不要伪造');
  });
});

describe('前置校验（必须早于收流）', () => {
  it('⑥ 只读库 → 403 OPEN_API_SCOPE_READONLY 且出路指向解除只读', async () => {
    const r = await upload(open.base, SCOPE_RO, okZip());
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_SCOPE_READONLY');
    // 服务端不给 hint 时客户端会回落到「未授权」通用文案，那是错的出路（真机 2026-11-25 踩到）
    assert.ok(typeof r.body.hint === 'string' && r.body.hint.includes('--off'), `出路应指向解除只读，实际：${r.body.hint}`);
  });

  it('⑦ 库不存在 → 404 OPEN_API_ATLAS_SCOPE_NOT_FOUND，且不凭空建目录', async () => {
    const r = await upload(open.base, SCOPE_MISSING, okZip());
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'OPEN_API_ATLAS_SCOPE_NOT_FOUND');
    assert.equal(fs.existsSync(atlasDir(SCOPE_MISSING)), false, '拼错的库名不能被就地创建');
  });

  it('⑦-b status 查不存在的库也要 404（否则「库名拼错」会被当成「没装图集」）', async () => {
    const r = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE_MISSING}`, { token: 'tok-rw' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, 'OPEN_API_ATLAS_SCOPE_NOT_FOUND');
    // 越权优先于存在性：未授权 Token 不得靠 404/200 的差异探测库是否存在
    const forbidden = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE_MISSING}`, { token: 'tok-limited' });
    assert.equal(forbidden.status, 403, '未授权时必须先回 403，不能泄露库存在性');
    assert.equal(forbidden.body.code, 'OPEN_API_SCOPE_FORBIDDEN');
  });

  it('⑧ 越权 token → 403 SCOPE_FORBIDDEN 且不回显 scope 名', async () => {
    const r = await upload(open.base, SCOPE, okZip(), 'tok-limited');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_SCOPE_FORBIDDEN');
    assert.ok(!JSON.stringify(r.body).includes(SCOPE), '响应不得回显 scope 名（防库名枚举）');
  });

  it('⑨ 只读 token 的 POST → 403 TOKEN_READONLY（全局鉴权层先拦）', async () => {
    const r = await upload(open.base, SCOPE, okZip(), 'tok-ro');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_READONLY');
  });

  it('⑩ 无 token → 401', async () => {
    const r = await upload(open.base, SCOPE, okZip(), '');
    assert.equal(r.status, 401);
  });

  it('⑪ Content-Type 不是 zip → 415，且列出接受值', async () => {
    const r = await upload(open.base, SCOPE, okZip(), 'tok-rw', 'application/json');
    assert.equal(r.status, 415);
    assert.equal(r.body.code, 'OPEN_API_UNSUPPORTED_CONTENT_TYPE');
    assert.ok(Array.isArray(r.body.accepted) && r.body.accepted.includes('application/zip'));
  });

  it('⑫ 空 body → 400（不是 500）', async () => {
    const r = await call(open.base, `/open/v1/atlas/package?scope=${SCOPE}`, {
      method: 'POST', token: 'tok-rw', contentType: 'application/zip', body: Buffer.alloc(0),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OPEN_API_BAD_REQUEST');
  });

  it('⑬ scope 格式非法 → 400（提前拦，不冒成 500）', async () => {
    const r = await upload(open.base, 'bad scope/../x', okZip());
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OPEN_API_BAD_REQUEST');
  });
});

describe('上限口径 = min(uploadMaxBytes, MAX_ZIP_BYTES)', () => {
  it('⑭ 超过服务端请求体上限 → 413 + atlasCode 1403（不是 16MiB 那个默认值）', async () => {
    // tiny 实例 uploadMaxBytes=1024：正常包（~500B）能过，撑到 2KB 就必须被拦
    const big = buildZip([{ name: 'atlas.html', data: HTML_OK + 'x'.repeat(2048) }]);
    assert.ok(big.length > 1024);

    const r = await upload(tiny.base, SCOPE, big);
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.code, 'OPEN_API_ATLAS_PACKAGE_INVALID');
    assert.equal(r.body.atlasCode, 1403);
    assert.equal(r.body.atlasKey, 'ATLAS_TOO_LARGE');
    assert.equal(r.body.limit, 1024, '上限取 min(1024, 20MB)=1024');
  });

  it('⑮ 上限内的小包能正常装上（证明 ⑭ 是上限而不是别的错）', async () => {
    const small = buildZip([{ name: 'atlas.html', data: HTML_OK }]);
    assert.ok(small.length < 1024);
    const r = await upload(tiny.base, SCOPE, small);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe('坏包矩阵', () => {
  it('⑯ 未 baked 的包 → 400 + atlasCode 1401', async () => {
    const noBaked = buildZip([{ name: 'atlas.html', data: '<html><body>no baked</body></html>' }]);
    const r = await upload(open.base, SCOPE, noBaked);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OPEN_API_ATLAS_PACKAGE_INVALID');
    assert.equal(r.body.atlasCode, 1401);
    assert.equal(r.body.atlasKey, 'ATLAS_PACKAGE_INVALID');
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('1401'), '文案里要带数字码，排障表按它查');
    // 内核抛错时不一定带 hint；缺了必须由端点补上，否则客户端回落成「查看服务端日志」
    assert.ok(typeof r.body.hint === 'string' && r.body.hint.includes('pack_atlas'), `出路应指向重新打包，实际：${r.body.hint}`);
  });

  it('⑰ 目录包（html 在子目录）→ 400 + atlasCode 1402', async () => {
    const nested = buildZip([{ name: 'dist/atlas.html', data: HTML_OK }]);
    const r = await upload(open.base, SCOPE, nested);
    assert.equal(r.status, 400);
    assert.equal(r.body.atlasCode, 1402);
    assert.equal(r.body.atlasKey, 'ATLAS_ENTRY_NOT_FOUND');
  });

  it('⑱ 非 zip 字节 → 400 + 14xx（不是 500）', async () => {
    const r = await upload(open.base, SCOPE, Buffer.from('this is definitely not a zip'));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OPEN_API_ATLAS_PACKAGE_INVALID');
    assert.ok(typeof r.body.atlasCode === 'number' && r.body.atlasCode >= 1400 && r.body.atlasCode < 1500);
  });

  it('⑲ 坏包不破坏已装好的版本', async () => {
    const good = await upload(open.base, SCOPE, okZip());
    const goodSha = good.body.packageSha256;
    await upload(open.base, SCOPE, Buffer.from('junk'));
    const st = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE}`, { token: 'tok-rw' });
    assert.equal(st.body.packageSha256, goodSha, '失败的上传不能动到已装版本');
  });
});

describe('开关与能力位', () => {
  it('⑳ uploadApi=false：package 与 status 一并 404（不泄露接口存在性）', async () => {
    const up = await upload(closed.base, SCOPE, okZip());
    assert.equal(up.status, 404);
    assert.equal(up.body.code, 'OPEN_API_NOT_FOUND');

    const st = await call(closed.base, `/open/v1/atlas/status?scope=${SCOPE}`, { token: 'tok-rw' });
    assert.equal(st.status, 404, 'status 属上传流程，与 package 同侧');
  });

  it('㉑ ping 回显 capabilities.atlas（含真实包上限）', async () => {
    const r = await call(open.base, `/open/v1/ping?scope=${SCOPE}`, { token: 'tok-rw' });
    assert.equal(r.status, 200);
    assert.equal(r.body.capabilities.atlas.upload, true);
    assert.equal(r.body.capabilities.atlas.maxPackageSize, 20 * 1024 * 1024);
    // 取回端点尚未上线，能力位必须说实话
    assert.equal(r.body.capabilities.atlas.download, false);
  });

  it('㉒ ping 在 uploadApi=false 时仍可用（诊断入口不被写开关关死）', async () => {
    const r = await call(closed.base, `/open/v1/ping?scope=${SCOPE}`, { token: 'tok-rw' });
    assert.equal(r.status, 200);
    assert.equal(r.body.capabilities.atlas.upload, false);
  });

  it('㉓ 方法不符 → 405 且带 Allow', async () => {
    const r = await call(open.base, `/open/v1/atlas/status?scope=${SCOPE}`, { method: 'POST', token: 'tok-rw' });
    assert.equal(r.status, 405);
    assert.equal(r.body.code, 'OPEN_API_METHOD_NOT_ALLOWED');
  });
});
