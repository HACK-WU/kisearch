/**
 * HTTP 层测试（`http.ts`）：起一个本地 server 做真实请求，覆盖纯函数测不到的分支。
 *
 * 守的是四类容易坏、且坏得不明显的地方：
 *   1. 服务端 `OPEN_API_*` 码与 hint 必须原样透出（不能让用户只看到「HTTP 401」）
 *   2. 二进制下载必须字节一致（截断/多包一层 buffer 都算失败）
 *   3. multipart 的字段名必须是 `files`、filename 必须是相对路径（服务端靠它还原目录）
 *   4. 字段缺失视为 `contractVersion: 0`（版本协商口径，不能按 undefined 继续）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { assertCapability, getBinary, getJson, pingRemote, postMultipart } from '../dist/http.js';
import { ClientError } from '../dist/errors.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('payload')]);
let server;
let base;

function remote(overrides = {}) {
  return { name: 'test', url: base, token: 'tok', source: 'config', ...overrides };
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/open/v1/ping') {
      if (req.headers.authorization !== 'Bearer tok') return json(401, { ok: false, code: 'OPEN_API_TOKEN_REQUIRED', error: 'no token' });
      if (url.searchParams.get('scope') === 'old') return json(200, { ok: true });
      if (url.searchParams.get('scope') === 'off') {
        return json(200, { ok: true, contractVersion: 1, capabilities: { download: { asset: false, doc: true }, maxAssetSize: 5 } });
      }
      return json(200, {
        ok: true,
        contractVersion: 1,
        capabilities: { download: { asset: true, doc: true }, maxAssetSize: 1024 },
      });
    }

    if (url.pathname === '/open/v1/asset') {
      if (url.searchParams.get('path') === 'missing.png') {
        return json(404, { ok: false, code: 'OPEN_API_NOT_FOUND', error: '附件不存在或类型不受支持', hint: '检查 ref' });
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
      res.end(PNG);
      return;
    }

    if (url.pathname === '/open/v1/import/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('binary');
        json(200, {
          ok: true,
          taskId: 't1',
          filenames: [...body.matchAll(/name="files"; filename="([^"]*)"/g)].map((m) => m[1]),
          contentType: req.headers['content-type'] ?? '',
        });
      });
      return;
    }

    if (url.pathname === '/open/v1/import/upload-archive' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let entries = null;
        try {
          entries = zlib.gunzipSync(raw).length;
        } catch {
          entries = -1;
        }
        json(200, {
          ok: true,
          taskId: 't2',
          contentType: req.headers['content-type'] ?? '',
          gunzippedBytes: entries,
        });
      });
      return;
    }

    return json(404, { ok: false, code: 'OPEN_API_NOT_FOUND', error: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function expectCode(fn, code) {
  try {
    return fn();
  } catch (err) {
    assert.ok(err instanceof ClientError, `期望 ClientError，实际 ${err?.constructor?.name}`);
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`);
    return err;
  }
}

describe('getJson：错误码与 hint 透出', () => {
  it('200 正常解析', async () => {
    const body = await getJson(remote(), '/open/v1/ping');
    assert.equal(body.ok, true);
  });

  it('401 → SERVER_ERROR，消息里带服务端 code', async () => {
    await assert.rejects(
      () => getJson(remote({ token: 'wrong' }), '/open/v1/ping'),
      (err) => {
        assert.equal(err.code, 'SERVER_ERROR');
        assert.match(err.message, /OPEN_API_TOKEN_REQUIRED/);
        return true;
      },
    );
  });

  it('404 的服务端 hint 优先于内置默认出路', async () => {
    await assert.rejects(
      () => getJson(remote(), '/open/v1/asset', { path: 'missing.png' }),
      (err) => {
        assert.equal(err.hint, '检查 ref', '应透传服务端 hint');
        return true;
      },
    );
  });

  it('连不上 → REMOTE_UNREACHABLE（与其他失败区分）', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(
      () => getJson({ name: 'dead', url: `http://127.0.0.1:${port}`, token: 't', source: 'config' }, '/open/v1/ping'),
      (err) => {
        assert.equal(err.code, 'REMOTE_UNREACHABLE');
        return true;
      },
    );
  });
});

describe('getBinary：字节一致', () => {
  it('下载的字节与服务端发送的完全相同', async () => {
    const { bytes, contentType } = await getBinary(remote(), '/open/v1/asset', { path: 'a.png' });
    assert.equal(bytes.equals(PNG), true);
    assert.equal(contentType, 'image/png');
  });
});

describe('postMultipart：字段名与相对路径', () => {
  it('part 名必须是 files，filename 保留相对路径', async () => {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('# A\n')]), 'sub/a.md');
    form.append('files', new Blob([Buffer.from('img')]), 'assets/x.png');
    const res = await postMultipart(remote(), '/open/v1/import/upload', form);
    assert.deepEqual(res.filenames, ['sub/a.md', 'assets/x.png']);
    assert.match(res.contentType, /^multipart\/form-data; boundary=/);
  });
});

describe('pingRemote：版本与能力位协商', () => {
  it('正常回显 contractVersion 与 capabilities', async () => {
    const info = await pingRemote(remote());
    assert.equal(info.contractVersion, 1);
    assert.equal(info.capabilities.asset, true);
    assert.equal(info.capabilities.maxAssetSize, 1024);
  });

  it('字段缺失视为版本 0、能力全 false（不能按 undefined 继续）', async () => {
    const old = await pingRemote(remote(), 'old');
    assert.equal(old.contractVersion, 0);
    assert.equal(old.capabilities.asset, false);
    assert.equal(old.capabilities.doc, false);
    assert.equal(old.capabilities.maxAssetSize, null);
  });

  it('只有能力位被关时，版本仍为 1（两者独立判定）', async () => {
    const off = await pingRemote(remote(), 'off');
    assert.equal(off.contractVersion, 1);
    assert.equal(off.capabilities.asset, false);
    assert.equal(off.capabilities.doc, true);
  });
});

describe('assertCapability：能力不足要明说升级服务端', () => {
  it('版本 0 → CONTRACT_TOO_OLD', () => {
    expectCode(
      () => assertCapability({ contractVersion: 0, capabilities: { asset: false, doc: false, maxAssetSize: null }, raw: {} }, 'asset', 'r'),
      'CONTRACT_TOO_OLD',
    );
  });

  it('能力位关闭 → CONTRACT_TOO_OLD 且提到 downloadApi', () => {
    const err = expectCode(
      () => assertCapability({ contractVersion: 1, capabilities: { asset: false, doc: true, maxAssetSize: null }, raw: {} }, 'asset', 'r'),
      'CONTRACT_TOO_OLD',
    );
    assert.match(err.hint, /downloadApi/);
  });

  it('能力开启 → 不抛', () => {
    assert.doesNotThrow(() => assertCapability(
      { contractVersion: 1, capabilities: { asset: true, doc: true, maxAssetSize: null }, raw: {} },
      'doc',
      'r',
    ));
  });
});
