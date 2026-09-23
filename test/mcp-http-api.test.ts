/**
 * mcp-http-api 单元测试 —— 方案 A /api/* 路由（REQ-20260806-003）
 *
 * 覆盖：
 *   - GET  /api/health                健康报告（200）
 *   - GET  /api/doc/list              空 scope → 空列表；q 过滤；Group 路径 + 文档结构
 *   - POST /api/import/upload         文件校验（扩展名白名单/大小/路径穿越）；落盘受控目录
 *   - POST /api/import/run            参数校验（scope/uploadId 缺失 → 400；uploadId 不存在 → 400）
 *   - GET  /api/import/status         jobId 不存在 → 404
 *   - POST /api/import/cancel         jobId 不存在 → 404
 *   - /api/* 与 /mcp 隔离（非 /api 404）
 *
 * 运行：npx jiti test/mcp-http-api.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer, serveStatic } from '../src/lib/mcp-http.js';
import { getRelationsCachePath } from '../src/lib/scope.js';
import { backupScopeSnapshot } from '../src/lib/backup.js';
import { getSharedOperationCoordinator } from '../src/lib/operation-coordinator.js';
import { loadConfig, getScopeDataDir, resetConfigCache } from '../src/lib/config.js';

// ─── 测试隔离：临时 HOME，避免污染真实 ~/.ki ───
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-api-test-'));
process.env.HOME = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

function buildTestServer(_authScopes: string[] | null = null): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

let handle: { base: string; port: number; close: () => Promise<void> } | null = null;

before(async () => {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    buildServer: buildTestServer,
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  handle = {
    base: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
});

after(async () => {
  await handle?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** hot_relations 种子：字符串 = 仅文件名；对象 = 附带向量 ID（用于 vectorized 标志用例） */
type SeedRel = string | { text: string; memoryId?: string; memoryIds?: string[]; ftsIds?: string[]; ftsIndexComplete?: boolean };

/** 构造一个 scope 的 relations-cache，供 /api/doc/list 测试 */
function seedRelationsCache(scope: string, groups: Record<string, SeedRel[]>): void {
  const cachePath = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const data: Record<string, unknown> = {
    version: 1,
    scope,
    partition_config: {},
    groups: {},
    updatedAt: null,
  };
  for (const [group, rels] of Object.entries(groups)) {
    (data.groups as Record<string, unknown>)[group] = {
      hot_relations: rels.map((r) => {
        const rel = typeof r === 'string' ? { text: r } : r;
        return { id: `r-${rel.text}`, score: 1, sourcePath: `docs/${rel.text}.md`, ...rel };
      }),
      keywords: [],
    };
  }
  fs.writeFileSync(cachePath, JSON.stringify(data));
}

describe('/api/health', () => {
  it('返回健康报告（200）', async () => {
    const res = await fetch(`${handle!.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.report);
  });
});

describe('/api/search-config', () => {
  it('只返回语义检索默认 timeout（秒），不暴露 embedding 敏感配置', async () => {
    const res = await fetch(`${handle!.base}/api/search-config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, timeout: 3 });
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'apiKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'baseURL'), false);
  });

  it('配置文件中的 queryTimeoutMs 转为秒返回', async () => {
    fs.writeFileSync(
      process.env.KI_CONFIG_PATH!,
      JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock', queryTimeoutMs: 7500 } }),
    );
    resetConfigCache();
    try {
      const res = await fetch(`${handle!.base}/api/search-config`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, timeout: 7.5 });
    } finally {
      fs.writeFileSync(
        process.env.KI_CONFIG_PATH!,
        JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
      );
      resetConfigCache();
    }
  });
});

describe('/api/doc/list', () => {
  it('scope 为空（default）返回空列表', async () => {
    const res = await fetch(`${handle!.base}/api/doc/list?scope=empty-scope`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.docs, []);
    assert.equal(body.total, 0);
  });

  it('返回 Group 路径 + 文档，q 过滤生效', async () => {
    seedRelationsCache('doc-test', {
      告警收敛: ['告警收敛策略', '告警通知'],
      架构: ['系统架构'],
    });
    const res = await fetch(`${handle!.base}/api/doc/list?scope=doc-test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 3);
    assert.ok(body.docs.some((d: { name: string; group: string }) => d.name === '告警收敛策略' && d.group === '告警收敛'));

    const filtered = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-test&q=告警`)).json();
    assert.equal(filtered.total, 2);
    assert.ok(filtered.docs.every((d: { name: string }) => d.name.includes('告警')));

    const pathFiltered = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-test&q=docs%2F%E5%91%8A%E8%AD%A6%E9%80%9A%E7%9F%A5`)).json();
    assert.equal(pathFiltered.total, 1);
    assert.equal(pathFiltered.docs[0].name, '告警通知');
  });

  it('vectorized：登记了向量 ID 的为 true（多值/单值皆可），未登记的为 false', async () => {
    seedRelationsCache('doc-vec', {
      告警: [
        { text: '多值向量化', memoryIds: ['m1', 'm2'] },
        { text: '单值向量化', memoryId: 'm3' },
        { text: '空数组不算', memoryIds: [] },
        { text: '空数组覆盖陈旧单值', memoryIds: [], memoryId: 'stale-m3' },
        '未向量化',
      ],
    });
    const body = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-vec`)).json();
    const byName = new Map<string, boolean>(
      body.docs.map((d: { name: string; vectorized: boolean }) => [d.name, d.vectorized]),
    );
    assert.equal(byName.get('多值向量化'), true, 'memoryIds 非空 → 已向量化');
    assert.equal(byName.get('单值向量化'), true, 'memoryId 非空 → 已向量化（旧链路）');
    assert.equal(byName.get('空数组不算'), false, 'memoryIds 为空数组不得误判为已向量化');
    assert.equal(byName.get('空数组覆盖陈旧单值'), false, '显式空 memoryIds 应覆盖陈旧 memoryId');
    assert.equal(byName.get('未向量化'), false, '无向量 ID → 未向量化');
  });

  it('fullTextIndexed：完整状态、旧数据兼容、部分状态与 dense relation 判定正确', async () => {
    seedRelationsCache('doc-fts', {
      状态: [
        { text: '完整索引', memoryIds: [], ftsIds: ['fts-1', 'fts-2'], ftsIndexComplete: true },
        { text: '部分索引', memoryIds: [], ftsIds: ['fts-partial'], ftsIndexComplete: false },
        { text: '旧数据索引', memoryIds: [], ftsIds: ['fts-legacy'] },
        { text: '空索引', memoryIds: [], ftsIds: [] },
        { text: 'dense 文档残留 FTS ID', memoryIds: ['dense-1'], ftsIds: ['stale-fts'], ftsIndexComplete: true },
        '未登记索引',
      ],
    });
    const body = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-fts`)).json();
    const byName = new Map<string, boolean | undefined>(
      body.docs.map((d: { name: string; fullTextIndexed?: boolean }) => [d.name, d.fullTextIndexed]),
    );
    assert.equal(byName.get('完整索引'), true, '完整状态和 FTS IDs 均有效');
    assert.equal(byName.get('部分索引'), false, '明确部分状态不得显示为完整 FTS-only 索引');
    assert.equal(byName.get('旧数据索引'), true, '旧数据缺少完整状态时按非空 ftsIds 兼容');
    assert.equal(byName.get('空索引'), false, '空 ftsIds 不显示 FTS');
    assert.equal(byName.get('dense 文档残留 FTS ID'), false, 'dense relation 不作为 FTS-only 文档');
    assert.equal(byName.get('未登记索引'), false, '无 ftsIds 不显示 FTS');
  });
});

describe('/api/import/upload', () => {
  it('返回与 ki import 对齐的文档和附件策略', async () => {
    const res = await fetch(`${handle!.base}/api/import/config?scope=up-test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.extensions, ['.md']);
    assert.equal(body.assets, true);
    assert.ok(body.assetExtensions.includes('.png'));
    assert.equal(body.maxFileSize, 1024 * 1024);
    assert.equal(body.maxAssetSize, 5 * 1024 * 1024);
    assert.ok(body.maxRequestBody >= 16 * 1024 * 1024);
  });

  it('校验扩展名白名单（非 md 拒绝）', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-test', files: [{ name: 'evil.txt', content: Buffer.from('x').toString('base64') }] }),
    });
    assert.equal(res.status, 400);
  });

  it('扩展名与 ki import 默认配置一致（.markdown 未配置时拒绝）', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-test', files: [{ name: 'readme.markdown', content: Buffer.from('x').toString('base64') }] }),
    });
    assert.equal(res.status, 400);
  });

  it('拒绝路径穿越（../）', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-test', files: [{ name: '../evil.md', content: Buffer.from('x').toString('base64') }] }),
    });
    assert.equal(res.status, 400);
  });

  it('合法文件落盘受控目录并返回 uploadId', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'up-test',
        files: [
          { name: 'docs/alarm.md', content: Buffer.from('# 告警').toString('base64') },
          { name: 'b.md', content: Buffer.from('# B').toString('base64') },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.uploadId);
    assert.equal(body.total, 2);
    // 文件确实落盘到受控目录
    const abs = path.join(process.env.HOME!, '.ki', 'import-uploads', body.uploadId, 'docs', 'alarm.md');
    assert.ok(fs.existsSync(abs));
    assert.equal(fs.readFileSync(abs, 'utf-8'), '# 告警');

    const append = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'up-test',
        uploadId: body.uploadId,
        files: [{ name: 'docs/alarm.png', content: Buffer.from('fake-png').toString('base64') }],
      }),
    });
    assert.equal(append.status, 200);
    const appendBody = await append.json();
    assert.equal(appendBody.uploadId, body.uploadId);
    assert.equal(appendBody.total, 1);
    const assetAbs = path.join(process.env.HOME!, '.ki', 'import-uploads', body.uploadId, 'docs', 'alarm.png');
    assert.ok(fs.existsSync(assetAbs));

    const wrongScope = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'another-scope',
        uploadId: body.uploadId,
        files: [{ name: 'docs/other.md', content: Buffer.from('# other').toString('base64') }],
      }),
    });
    assert.equal(wrongScope.status, 400);
  });

  it('同一 uploadId 的重复路径只允许相同内容重试，不同内容不得覆盖', async () => {
    const content = Buffer.from('# stable').toString('base64');
    const changed = Buffer.from('# changed').toString('base64');
    const first = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-duplicate', files: [{ name: 'docs/retry.md', content }] }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();

    const retry = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-duplicate', uploadId: firstBody.uploadId, files: [{ name: 'docs/retry.md', content }] }),
    });
    assert.equal(retry.status, 200, '相同内容的同 uploadId 重试应保持幂等');

    const overwrite = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-duplicate', uploadId: firstBody.uploadId, files: [{ name: 'docs/retry.md', content: changed }] }),
    });
    assert.equal(overwrite.status, 400, '不同内容不得静默覆盖暂存文件');
    const overwriteBody = await overwrite.json();
    assert.match(overwriteBody.errors[0].error, /内容不同/);

    const duplicateInRequest = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'up-duplicate-request',
        files: [
          { name: 'same.md', content },
          { name: './same.md', content },
        ],
      }),
    });
    assert.equal(duplicateInRequest.status, 200, '部分成功响应仍应返回明确 errors');
    const duplicateBody = await duplicateInRequest.json();
    assert.equal(duplicateBody.total, 1);
    assert.match(duplicateBody.errors[0].error, /重复相对路径/);
  });
});

describe('/api/import/run + status', () => {
  it('run 缺参数 → 400', async () => {
    const res = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('run uploadId 不存在 → 400', async () => {
    const res = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'x', uploadId: 'no-such-id' }),
    });
    assert.equal(res.status, 400);
  });

  it('run 透传非法冲突策略，并在 job 结果中 fail-loud', async () => {
    const upload = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict', files: [{ name: 'a.md', content: Buffer.from('# a').toString('base64') }] }),
    });
    assert.equal(upload.status, 200);
    const uploadBody = await upload.json();
    const run = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict', uploadId: uploadBody.uploadId, vector: false, conflictMode: 'invalid' }),
    });
    assert.equal(run.status, 202);
    const runBody = await run.json();

    let statusBody: { job?: { state: string; error?: string } } = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await fetch(`${handle!.base}/api/import/status?jobId=${encodeURIComponent(runBody.jobId)}`);
      statusBody = await status.json();
      if (statusBody.job?.state !== 'running') break;
    }
    assert.equal(statusBody.job?.state, 'failed');
    assert.match(statusBody.job?.error ?? '', /允许值/);
  });

  it('run 透传冲突策略，并在成功结果中返回冲突明细', async () => {
    const firstUpload = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict-result', files: [{ name: 'foo.md', content: Buffer.from('# first').toString('base64') }] }),
    });
    const firstBody = await firstUpload.json();
    const firstRun = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict-result', uploadId: firstBody.uploadId, group: 'api-group', vector: false }),
    });
    const firstRunBody = await firstRun.json();

    const waitJob = async (jobId: string): Promise<{ state: string; result?: { stats?: { conflicts?: number }; conflicts?: { action?: string }[] }; error?: string }> => {
      // FTS-only 首次创建 zvec Collection 需要启动独立 worker，允许 2s 冷启动窗口。
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const status = await fetch(`${handle!.base}/api/import/status?jobId=${encodeURIComponent(jobId)}`);
        const body = await status.json();
        if (body.job?.state !== 'running') return body.job;
      }
      throw new Error('job 等待超时');
    };

    const firstJob = await waitJob(firstRunBody.jobId);
    assert.equal(firstJob.state, 'done', firstJob.error);

    const secondUpload = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict-result', files: [{ name: '*foo*.md', content: Buffer.from('# second').toString('base64') }] }),
    });
    const secondBody = await secondUpload.json();
    const secondRun = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'run-conflict-result', uploadId: secondBody.uploadId, group: 'api-group', vector: false, conflictMode: 'suffix', conflictSuffix: '-copy_{n}' }),
    });
    const secondRunBody = await secondRun.json();
    const secondJob = await waitJob(secondRunBody.jobId);

    assert.equal(secondJob.state, 'done', secondJob.error);
    assert.equal(secondJob.result?.stats?.conflicts, 1);
    assert.equal(secondJob.result?.conflicts?.[0]?.action, 'suffix');
  });

  it('status jobId 不存在 → 404', async () => {
    const res = await fetch(`${handle!.base}/api/import/status?jobId=no-such-job`);
    assert.equal(res.status, 404);
  });

  it('cancel jobId 不存在 → 404', async () => {
    const res = await fetch(`${handle!.base}/api/import/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'no-such-job' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('/api/restore job', () => {
  it('run 缺 scope → 400', async () => {
    const res = await fetch(`${handle!.base}/api/restore/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rebuildVector: true }),
    });
    assert.equal(res.status, 400);
  });

  it('status/cancel 不存在 job → 404', async () => {
    const status = await fetch(`${handle!.base}/api/restore/status?jobId=no-such-restore-job`);
    assert.equal(status.status, 404);
    const cancel = await fetch(`${handle!.base}/api/restore/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'no-such-restore-job' }),
    });
    assert.equal(cancel.status, 404);
  });

  it('restore job 完成后可查询结果与 restore 阶段进度', async () => {
    const scope = 'restore-job';
    const config = loadConfig();
    const scopeDir = getScopeDataDir(config, scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(getRelationsCachePath(scope), JSON.stringify({ version: 1, scope, groups: {} }));
    const snapshot = backupScopeSnapshot(config.backupDir, scope, scopeDir);
    fs.writeFileSync(path.join(scopeDir, 'changed-after-snapshot.txt'), 'changed');

    const run = await fetch(`${handle!.base}/api/restore/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, snapshotFile: snapshot }),
    });
    assert.equal(run.status, 202);
    const { jobId } = await run.json();
    let status: any;
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${handle!.base}/api/restore/status?jobId=${jobId}`)).json();
      if (status.job.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.job.state, 'done', JSON.stringify(status));
    assert.equal(status.job.operation, 'restore-snapshot');
    assert.equal(status.job.result.action, 'restore_snapshot');
    assert.equal(fs.existsSync(path.join(scopeDir, 'changed-after-snapshot.txt')), false);
  });

  it('取消排队中的 restore：批次未开始写入且最终状态为 cancelled', async () => {
    const scope = 'restore-cancel-job';
    const gate = getSharedOperationCoordinator().submit(
      { operation: 'test-gate', params: { scope } },
      async () => { await new Promise((resolve) => setTimeout(resolve, 100)); },
      scope,
    );
    const run = await fetch(`${handle!.base}/api/restore/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, snapshotFile: '/tmp/should-not-be-read.tar.gz' }),
    });
    assert.equal(run.status, 202);
    const { jobId } = await run.json();
    const cancel = await fetch(`${handle!.base}/api/restore/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    assert.equal(cancel.status, 202);
    await gate;
    let status: any;
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${handle!.base}/api/restore/status?jobId=${jobId}`)).json();
      if (status.job.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.job.state, 'cancelled', JSON.stringify(status));
    assert.equal(status.job.operation, 'restore-snapshot');
    assert.equal(status.job.cancelRequested, true);
  });
});

describe('--web 静态服务', () => {
  it('根路径返回 index.html；未知 /api/* 不 fallback；SPA fallback 生效', async () => {
    // 独立的 webDir 服务（复用同一 server，但 webDir 需要在 createMcpHttpServer 时传入——
    // 这里直接用文件系统验证 serveStatic 行为：起一个带 webDir 的独立服务）
    const webDir = path.join(tmpHome, 'webdist');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>ki-web</html>');
    fs.writeFileSync(path.join(webDir, 'app.js'), 'console.log(1)');
    const siblingWebDir = path.join(tmpHome, 'webdist-evil');
    fs.mkdirSync(siblingWebDir, { recursive: true });
    fs.writeFileSync(path.join(siblingWebDir, 'secret.txt'), 'must-not-leak');
    fs.symlinkSync(path.join(siblingWebDir, 'secret.txt'), path.join(webDir, 'linked-secret.txt'));

    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: false,
      buildServer: buildTestServer,
      webDir,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // 根路径 → index.html
      const root = await fetch(`${base}/`);
      assert.equal(root.status, 200);
      assert.ok((await root.text()).includes('ki-web'));

      // 静态资源 → app.js
      const js = await fetch(`${base}/app.js`);
      assert.equal(js.status, 200);
      assert.ok((await js.text()).includes('console.log'));

      // SPA fallback：非 /api 非 /mcp 的 GET 404 → index.html
      const spa = await fetch(`${base}/some/route`);
      assert.equal(spa.status, 200);
      assert.ok((await spa.text()).includes('ki-web'));

      // 编码后的 .. 不能借 startsWith(webRoot) 的前缀误判读到相邻目录。
      const traversal = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: addr.port, path: '/%2e%2e/webdist-evil/secret.txt' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
      });
      assert.notEqual(traversal.body, 'must-not-leak');
      assert.ok([200, 403].includes(traversal.status));

      // 直接把原始编码路径交给静态服务，锁定 segment 边界校验本身（HTTP URL
      // 解析器会先规范化 %2e%2e，无法仅靠 fetch 覆盖这一分支）。
      const direct = { statusCode: 0, body: '', writeHead(status: number) { this.statusCode = status; }, end(body?: Buffer | string) { this.body = body?.toString() ?? ''; } };
      serveStatic(direct as any, webDir, '/%2e%2e/webdist-evil/secret.txt');
      assert.equal(direct.statusCode, 403);
      assert.notEqual(direct.body, 'must-not-leak');

      const linked = await fetch(`${base}/linked-secret.txt`);
      assert.equal(linked.status, 403);
      assert.notEqual(await linked.text(), 'must-not-leak');

      // /api/* 未匹配 → JSON 404（不 fallback HTML）
      const api = await fetch(`${base}/api/nope`);
      assert.equal(api.status, 404);
      const apiBody = await api.json();
      assert.equal(apiBody.ok, false);
    } finally {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe('/api/* 与 /mcp 隔离', () => {
  it('未知 /api/xxx → JSON 404（非 fallback）', async () => {
    const res = await fetch(`${handle!.base}/api/unknown`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it('/mcp 仍正常（POST initialize 可达）', async () => {
    const res = await fetch(`${handle!.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(res.status, 200);
  });
});

describe('/api/* 鉴权（对外绑定 + 本地豁免）', () => {
  /** 起一个 authEnabled=true 的 server，注入 clientAddr 模拟来源 */
  async function startAuthServer(clientAddr: string): Promise<{ base: string; port: number; close: () => Promise<void> }> {
    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: true,
      token: 'secret-token',
      buildServer: buildTestServer,
      webDir: null,
      resolveClientAddr: () => clientAddr,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${addr.port}`,
      port: addr.port,
      close: async () => {
        await closeAllSessions();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    };
  }

  it('本地来源（127.0.0.1）+ 无 token → /api/health 200（本地豁免）', async () => {
    const srv = await startAuthServer('127.0.0.1');
    try {
      const res = await fetch(`${srv.base}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      await srv.close();
    }
  });

  it('远程来源（192.168.1.10）+ 无 token → /api/health 401', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`);
      assert.equal(res.status, 401);
    } finally {
      await srv.close();
    }
  });

  it('远程来源 + 错误 token → /api/health 401', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`, { headers: { Authorization: 'Bearer wrong-token' } });
      assert.equal(res.status, 401);
    } finally {
      await srv.close();
    }
  });

  it('远程来源 + 正确 token → /api/health 200', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`, { headers: { Authorization: 'Bearer secret-token' } });
      assert.equal(res.status, 200);
    } finally {
      await srv.close();
    }
  });
});
