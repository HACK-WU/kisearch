/**
 * open-api-upload-wiki-writeback.test.ts —— 「上传即回写」
 *
 * 背景（2026-11-13 用户报障）：对外上传接口 `POST /open/v1/import/upload` 导入成功，
 * 但 `scopes.<scope>.wikiSync.sourceDir` 下没有任何文件。根因是 HTTP 三条链路共用的
 * `runImportJob` 从未把 `wikiWriteback` 传给导入内核，只有 CLI `ki import` 传了 true。
 *
 * 覆盖：
 *   A. 对外上传端到端（真实走 handleOpenApiImportUpload）→ 导入完成后 wiki 目录出现文档
 *   B. `/open/v1/import/status` 的 result 暴露 wikiWriteback 计数（不含服务端路径）
 *   C. 不传 wikiWriteback（数据源同步口径）→ 零写回
 *   D. Web 上传两个入口（分步 finalize / `/api/import/run`）都传了 true（源码守卫）
 *
 * 运行：npx jiti test/open-api-upload-wiki-writeback.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { handleOpenApiImportUpload, handleOpenApiImportStatus } from '../src/lib/open-api/routes/import.js';
import type { OpenApiContext } from '../src/lib/open-api/index.js';
import { createJob, getJobById, runImportJob } from '../src/lib/mcp-http-api.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-openapi-wiki-'));
// 上传暂存根目录取自 os.homedir()（~/.ki/import-uploads），把 HOME 指到临时目录避免污染真实家目录
process.env.HOME = tmpRoot;

const scope = `openapi-wiki-${Date.now()}`;
const wikiDir = path.join(tmpRoot, 'wiki');
fs.mkdirSync(wikiDir, { recursive: true });
registerTestScope(scope);
const rawConfig = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
rawConfig.scopes[scope] = { wikiSync: { enabled: true, sourceDir: wikiDir } };
fs.writeFileSync(testConfigPath, JSON.stringify(rawConfig), 'utf-8');
resetConfigCache();
ensureScopeDir(scope);

const BOUNDARY = '----ki-test-boundary';

function multipartBody(filename: string, content: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n`
    + `Content-Type: text/markdown\r\n\r\n${content}\r\n--${BOUNDARY}--\r\n`,
    'utf8',
  );
}

function fakeReq(buffer: Buffer): http.IncomingMessage {
  const req = Readable.from([buffer]) as unknown as http.IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
  };
  return req;
}

function fakeRes(): { res: http.ServerResponse; state: { status: number; body: string; ended: boolean } } {
  const state = { status: 0, body: '', ended: false };
  const res = {
    get writableEnded(): boolean { return state.ended; },
    writeHead(code: number): unknown { state.status = code; return res; },
    end(chunk?: string): void { if (chunk) state.body += chunk; state.ended = true; },
  };
  return { res: res as unknown as http.ServerResponse, state };
}

function openApiContext(): OpenApiContext {
  return {
    resolveTokenAuth: () => undefined,
    uploadApi: true,
    uploadMaxBytes: 16 * 1024 * 1024,
    config: loadConfig(),
  };
}

async function waitForJob(taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJobById(taskId);
    if (job && (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled')) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`导入任务 ${taskId} 超时未结束`);
}

after(() => {
  try { fs.rmSync(getKbDir(scope), { recursive: true, force: true }); } catch { /* best effort */ }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('A. 对外上传接口：导入完成后写回 wiki', () => {
  it('POST /open/v1/import/upload → wikiSync.sourceDir 出现文档，job.result 带 wikiWriteback', async () => {
    const { res, state } = fakeRes();
    await handleOpenApiImportUpload({
      req: fakeReq(multipartBody('uploaded.md', '# 对外上传的文档\n\n正文内容。\n')),
      res,
      url: new URL(`http://127.0.0.1/open/v1/import/upload?scope=${scope}&group=${encodeURIComponent('上传组')}&vector=0`),
      ctx: openApiContext(),
      principal: { scopes: [scope], readOnly: false },
    });

    assert.equal(state.status, 200, `上传应受理：${state.body}`);
    const accepted = JSON.parse(state.body) as { ok: boolean; taskId: string };
    assert.equal(accepted.ok, true);
    assert.ok(accepted.taskId, '响应必须带 taskId');

    const job = await waitForJob(accepted.taskId);
    assert.equal(job.state, 'done', `导入应成功：${job.error ?? ''}`);

    const dest = path.join(wikiDir, '上传组', 'uploaded.md');
    assert.equal(fs.existsSync(dest), true, '导入完成后 wiki 目录应出现同名文档');
    const text = fs.readFileSync(dest, 'utf-8');
    assert.match(text, /^---\ngroupPath: 上传组\nrelation: uploaded\nexportedAt: /);
    assert.ok(text.includes('对外上传的文档'), '写回内容应是导入的正文');
  });

  it('GET /open/v1/import/status → result.wikiWriteback 给出计数（不含 targetDir）', async () => {
    const srcDir = path.join(tmpRoot, 'status-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'status-doc.md'), '# 状态用例\n\n正文。\n', 'utf-8');
    const job2 = createJob(scope, 'import', loadConfig(), {
      operator: { type: 'token', label: 'Token test' },
      source: 'open-api',
    });
    await runImportJob(job2, {
      scope,
      sourceDir: srcDir,
      group: '状态组',
      vector: false,
      wikiWriteback: true,
    }, loadConfig());
    assert.equal(job2.state, 'done', `导入应成功：${job2.error ?? ''}`);

    const statusRes = fakeRes();
    await handleOpenApiImportStatus({
      req: fakeReq(Buffer.alloc(0)),
      res: statusRes.res,
      url: new URL(`http://127.0.0.1/open/v1/import/status?taskId=${job2.id}`),
      ctx: openApiContext(),
      principal: { scopes: [scope], readOnly: false },
    });

    assert.equal(statusRes.state.status, 200);
    const payload = JSON.parse(statusRes.state.body) as {
      result?: { wikiWriteback?: Record<string, unknown> };
    };
    assert.deepEqual(payload.result?.wikiWriteback, { written: 1, skipped: 0, failed: 0 });
    assert.equal('targetDir' in (payload.result?.wikiWriteback ?? {}), false, '对外响应不得暴露服务端路径');
  });
});

describe('B. 不传 wikiWriteback（数据源同步口径）：零写回', () => {
  it('runImportJob 缺省 → 结果无 wikiWriteback，wiki 目录不新增文件', async () => {
    const srcDir = path.join(tmpRoot, 'ds-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'ds-doc.md'), '# 数据源口径\n\n正文。\n', 'utf-8');

    const job = createJob(scope, 'import', loadConfig(), {
      operator: { type: 'token', label: 'Token test' },
      source: 'open-api',
    });
    await runImportJob(job, { scope, sourceDir: srcDir, group: '数据源组', vector: false }, loadConfig());

    assert.equal(job.state, 'done');
    assert.equal((job.result as { wikiWriteback?: unknown }).wikiWriteback, undefined);
    assert.equal(fs.existsSync(path.join(wikiDir, '数据源组', 'ds-doc.md')), false);
  });
});

describe('C. Web 上传两个入口都传 wikiWriteback（源码守卫）', () => {
  const source = fs.readFileSync(new URL('../src/lib/mcp-http-api.ts', import.meta.url), 'utf-8');
  const openApiSource = fs.readFileSync(new URL('../src/lib/open-api/routes/import.ts', import.meta.url), 'utf-8');

  it('分步 finalize 与 /api/import/run 都显式开启', () => {
    const occurrences = source.match(/wikiWriteback: true,/g) ?? [];
    assert.equal(occurrences.length, 2, 'Web 上传与对外上传两条入口都必须传 true');
  });

  it('对外上传路由传 true', () => {
    assert.match(openApiSource, /wikiWriteback: true,/);
  });
});
