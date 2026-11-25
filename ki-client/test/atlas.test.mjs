// 图集远程部署（atlas upload / status）的客户端行为测试。
//
// 测的是「客户端决策」而不是服务端能力：
//   - 未变更判断只看服务端 packageSha256（不靠本地 state）
//   - --force 必须真的重传
//   - 本地体积预检要早于上传（服务端给了 maxPackageSize 就用它）
//   - 老服务端没有能力位 → 报「升级服务端」，不是让它去撞 404
//   - 服务端回传指纹与本地不一致 → 硬失败（装进去的可能不是这个包）
//
// 跑法：npm test（先 build，再 node --test test/*.test.mjs）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from '../dist/args.js';
import { runAtlas } from '../dist/commands/atlas.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ─── mock 服务端 ───
/** 每个用例前重置：`state` 决定服务端怎么答，`seen` 记录客户端实际发了什么 */
let state;
let seen;

function resetState(overrides = {}) {
  state = {
    contractVersion: 1,
    hasAtlas: true,
    maxPackageSize: 20 * 1024 * 1024,
    currentSha: null, // status 报的 packageSha256
    installedSha: null, // 上传后服务端"算出"的指纹（默认等于收到的字节）
    uploadedBy: 'open-api:tok-rw-a',
    ...overrides,
  };
  seen = [];
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method, path: url.pathname, query: url.search, contentType: req.headers['content-type'], bytes: body.length });

        const json = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (url.pathname === '/open/v1/ping') {
          const caps = { download: { asset: true, doc: true }, maxAssetSize: 5242880 };
          if (state.hasAtlas) {
            caps.atlas = { upload: true, download: false, maxPackageSize: state.maxPackageSize };
          }
          return json(200, { ok: true, contractVersion: state.contractVersion, capabilities: caps, scopes: ['demo'], readOnly: false, uploadApi: true });
        }

        if (url.pathname === '/open/v1/atlas/status') {
          if (!state.currentSha) return json(200, { ok: true, scope: 'demo', exists: false });
          return json(200, {
            ok: true,
            scope: 'demo',
            exists: true,
            title: '既有图集',
            branch: 'main',
            baseline: 'abc1234',
            packageSha256: state.currentSha,
            sha256: 'f'.repeat(64),
            packageSize: 4096,
            size: 8192,
            entries: [{ name: 'atlas.html', size: 8192 }],
            uploadedAt: '2026-11-24T00:00:00.000Z',
            uploadedBy: 'cli:root',
          });
        }

        if (url.pathname === '/open/v1/atlas/package' && req.method === 'POST') {
          const sha = state.installedSha ?? sha256(body);
          return json(200, {
            ok: true,
            scope: 'demo',
            exists: true,
            title: '远程部署测试',
            branch: 'main',
            baseline: 'abc1234',
            generatedAt: '2026-11-24T10:00:00.000Z',
            packageSha256: sha,
            sha256: 'e'.repeat(64),
            packageSize: body.length,
            size: 16384,
            entries: [{ name: 'atlas.html', size: 16384 }, { name: 'meta.json', size: 80 }],
            archived: true,
            uploadedBy: state.uploadedBy,
          });
        }

        return json(404, { ok: false, code: 'OPEN_API_NOT_FOUND', error: 'Not Found' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, token: 'tok-rw', close: () => new Promise((r) => server.close(r)) });
    });
  });
}

let server;
let tmpDir;
let zipPath;
let zipBuf;

before(async () => {
  server = await startServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-client-atlas-'));
  zipPath = path.join(tmpDir, 'atlas.zip');
  // 客户端不解析 zip（零依赖），所以内容只要是字节就行
  zipBuf = Buffer.from('PK\u0003\u0004 fake atlas package bytes for tests');
  fs.writeFileSync(zipPath, zipBuf);
});

after(async () => {
  await server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const remote = () => ({ name: 'test', url: server.base, token: server.token, source: 'config' });

/** 捕获 console.log（命令的成功输出全走它） */
async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

const runUpload = (argv) => capture(() => runAtlas(parseArgs(['atlas', 'upload', ...argv]), remote()));
const runStatus = (argv) => capture(() => runAtlas(parseArgs(['atlas', 'status', ...argv]), remote()));

/** 断言抛出的 ClientError 码与文案 */
async function expectError(promise, code, includes) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}：${err.message}`);
    if (includes) assert.ok(err.message.includes(includes), `文案应包含「${includes}」，实际：${err.message}`);
    return err;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

test('正常上传：发 Content-Type: application/zip，回显与本地 CLI 同构', async () => {
  resetState({ currentSha: null });
  const { code, out } = await runUpload(['--scope', 'demo', '--file', zipPath]);

  assert.equal(code, 0);
  const posted = seen.find((s) => s.path === '/open/v1/atlas/package');
  assert.ok(posted, '应该发出一次上传请求');
  assert.equal(posted.method, 'POST');
  assert.equal(posted.contentType, 'application/zip');
  assert.equal(posted.bytes, zipBuf.length, '传的必须是原字节，不能重新编码');
  assert.ok(posted.query.includes('scope=demo'), `scope 走 query：${posted.query}`);

  assert.ok(out.includes('已安装到 demo/.atlas/'), out);
  assert.ok(out.includes('基线   main@abc1234'), out);
  assert.ok(out.includes('上一版已归档到 archive/'), out);
  assert.ok(out.includes(`via remote=test (${server.base})`), out);
});

test('--title 随 query 发出（不是只在输出里回显）', async () => {
  resetState({ currentSha: null });
  await runUpload(['--scope', 'demo', '--file', zipPath, '--title', '兜底标题']);
  const posted = seen.find((s) => s.path === '/open/v1/atlas/package');
  assert.ok(posted, '应该发出上传请求');
  assert.ok(posted.query.includes('title='), `title 必须进 query：${posted.query}`);
  assert.ok(decodeURIComponent(posted.query).includes('兜底标题'), `title 值要原样带上：${posted.query}`);
});

test('未变更（服务端指纹相同）→ 跳过且不发上传请求，退出码 0', async () => {
  resetState({ currentSha: sha256(zipBuf) });
  const { code, out } = await runUpload(['--scope', 'demo', '--file', zipPath]);

  assert.equal(code, 0);
  assert.equal(seen.filter((s) => s.path === '/open/v1/atlas/package').length, 0, '跳过时不该发上传');
  assert.ok(out.includes('已是最新，跳过上传'), out);
});

test('--force 越过未变更判断，真的重传', async () => {
  resetState({ currentSha: sha256(zipBuf) });
  const { code } = await runUpload(['--scope', 'demo', '--file', zipPath, '--force']);

  assert.equal(code, 0);
  assert.equal(seen.filter((s) => s.path === '/open/v1/atlas/package').length, 1, '--force 必须真的传');
});

test('本地体积预检：超过服务端 maxPackageSize 就不传（省一次往返）', async () => {
  resetState({ currentSha: null, maxPackageSize: 16 });
  const err = await expectError(
    runUpload(['--scope', 'demo', '--file', zipPath]),
    'USAGE',
    '超过服务端上限',
  );
  assert.equal(seen.filter((s) => s.path === '/open/v1/atlas/package').length, 0);
  assert.ok(err.hint.length > 0, '必须给出路');
});

test('老服务端（无 atlas 能力位）→ CONTRACT_TOO_OLD 并指路升级', async () => {
  resetState({ hasAtlas: false });
  const err = await expectError(
    runUpload(['--scope', 'demo', '--file', zipPath]),
    'CONTRACT_TOO_OLD',
    '不支持图集远程部署',
  );
  assert.ok(err.hint.includes('升级'), `出路应指向升级服务端，实际：${err.hint}`);
  assert.equal(seen.filter((s) => s.path === '/open/v1/atlas/package').length, 0);
});

test('服务端回传指纹与本地不一致 → 硬失败（装进去的可能不是这个包）', async () => {
  resetState({ currentSha: null, installedSha: 'a'.repeat(64) });
  await expectError(
    runUpload(['--scope', 'demo', '--file', zipPath]),
    'SERVER_ERROR',
    '包指纹与本地不一致',
  );
});

test('本地文件不存在 → USAGE（先报参数错，不先连一次远端）', async () => {
  resetState({});
  const before = seen.length;
  await expectError(
    runUpload(['--scope', 'demo', '--file', path.join(tmpDir, 'nope.zip')]),
    'USAGE',
    '文件不存在',
  );
  assert.equal(seen.length, before, '本地校验失败时不该发出任何请求');
});

test('缺参数：--scope / --file / 未知子命令', async () => {
  resetState({});
  await expectError(runUpload(['--file', zipPath]), 'USAGE', '缺参数：scope');
  await expectError(runUpload(['--scope', 'demo']), 'USAGE', '缺参数：file');
  await expectError(capture(() => runAtlas(parseArgs(['atlas', 'nope']), remote())), 'USAGE', '不认识的 atlas 子命令');
});

test('--json：结构化输出带 skipped 字段（与 upload 命令同一范式）', async () => {
  resetState({ currentSha: null });
  const { out } = await runUpload(['--scope', 'demo', '--file', zipPath, '--json']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped, false);
  assert.equal(parsed.remote, 'test');
  assert.equal(parsed.packageSha256, sha256(zipBuf));
  assert.equal(parsed.packageSize, zipBuf.length);
});

test('--json（跳过态）：skipped:true 且带服务端现有指纹', async () => {
  resetState({ currentSha: sha256(zipBuf) });
  const { out } = await runUpload(['--scope', 'demo', '--file', zipPath, '--json']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.packageSha256, sha256(zipBuf));
});

test('atlas status：已部署 → 回显基线/体积/上传方；未部署 → 退出码 0 + 给路', async () => {
  resetState({ currentSha: sha256(zipBuf) });
  const deployed = await runStatus(['--scope', 'demo']);
  assert.equal(deployed.code, 0);
  assert.ok(deployed.out.includes('demo 已部署图集'), deployed.out);
  assert.ok(deployed.out.includes('by cli:root'), deployed.out);

  resetState({ currentSha: null });
  const empty = await runStatus(['--scope', 'demo']);
  assert.equal(empty.code, 0, '「没部署」不是错误，脚本里 status && upload 的写法不该被它打断');
  assert.ok(empty.out.includes('尚未部署图集'), empty.out);
  assert.ok(empty.out.includes('ki-client atlas upload'), empty.out);
});

test('atlas status 缺 scope → USAGE', async () => {
  resetState({});
  await expectError(runStatus([]), 'USAGE', '缺参数：scope');
});
