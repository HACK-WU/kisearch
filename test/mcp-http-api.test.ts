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
import crypto from 'node:crypto';
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
import { createTaskReporter, getTaskRecord } from '../src/lib/task-registry.js';

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

  it('embedding 探测不可执行时降级为 warn，不得让 /api/health 变成服务异常', async () => {
    // 本用例配置无 apiKey → 探测跳过。这里必须仍是 200 + 完整报告：
    // 曾经外层 10s deadline 小于探测最坏耗时，慢 embedding 会让接口回 400，
    // 前端据此把正常运行的 daemon 报成「MCP HTTP 未就绪」。
    const res = await fetch(`${handle!.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const embNames = ['URL 连通性', '密钥有效性', '维度匹配'];
    const embItems = body.report.items.filter((i: { name: string }) => embNames.includes(i.name));
    assert.equal(embItems.length, 3);
    assert.ok(
      embItems.every((i: { status: string }) => i.status === 'warn'),
      `embedding 不可用只该告警，实际：${JSON.stringify(embItems)}`,
    );
  });
});

describe('/api/tasks 与 /api/vector/status', () => {
  it('跨调用读取任务进度，心跳过期显示 unknown，维度 GET 只读快照', async () => {
    const config = loadConfig();
    const taskId = `api-task-${crypto.randomUUID()}`;
    const reporter = createTaskReporter(config, {
      id: taskId,
      source: 'cli',
      operation: 'restore --rebuild-vector',
      scope: 'api_task_scope',
    });
    reporter.progress({ phase: 'queued', done: 0, total: 5 });
    assert.equal(getTaskRecord(config, taskId)?.state, 'queued', '排队进度不能提前标记为运行中');
    reporter.update({ state: 'running', startedAt: Date.now() });
    reporter.progress({ phase: 'embedding', done: 2, total: 5, persisted: 2, notProcessed: 3 });
    reporter.update({ error: 'Bearer hidden-token api_key=hidden-key source=/srv/private/upload/doc.md' });
    const taskFile = path.join(config.dataDir, '.ki-tasks', `${taskId}.json`);

    try {
      const listResponse = await fetch(`${handle!.base}/api/tasks?limit=10`);
      assert.equal(listResponse.status, 200);
      const listBody = await listResponse.json() as any;
      const listed = listBody.tasks.find((task: any) => task.id === taskId);
      assert.equal(listed.state, 'running');
      assert.equal(listed.progress.notProcessed, 3);

      const expired = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      expired.heartbeatAt = Date.now() - 31_000;
      fs.writeFileSync(taskFile, JSON.stringify(expired));
      const detailResponse = await fetch(`${handle!.base}/api/tasks/${taskId}`);
      assert.equal(detailResponse.status, 200);
      const detailBody = await detailResponse.json() as any;
      assert.equal(detailBody.task.state, 'unknown');
      assert.doesNotMatch(JSON.stringify(detailBody), /hidden-token|hidden-key|\/srv\/private\/upload/);
      assert.equal(getTaskRecord(config, taskId)?.state, 'unknown');

      const agedOut = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      agedOut.heartbeatAt = Date.now() - 60 * 60 * 1000 - 1;
      fs.writeFileSync(taskFile, JSON.stringify(agedOut));
      const expiredResponse = await fetch(`${handle!.base}/api/tasks/${taskId}`);
      assert.equal(expiredResponse.status, 404);
      assert.equal(getTaskRecord(config, taskId), null);

      const dimensionResponse = await fetch(`${handle!.base}/api/vector/status?scope=api_task_scope`);
      assert.equal(dimensionResponse.status, 200);
      assert.equal((await dimensionResponse.json() as any).status.state, 'unknown');
    } finally {
      reporter.stop();
    }
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

  it('S0-2：单 Group >500 篇分页——total 为真实匹配数、truncated 与剩余页一致、offset 翻页取全', async () => {
    const GROUP_TOTAL = 505;
    seedRelationsCache('doc-page', {
      大组: Array.from({ length: GROUP_TOTAL }, (_, i) => `分页文档-${String(i).padStart(3, '0')}`),
    });

    // 首页：旧行为 total=截断长度(500) 且恒 truncated:false → 静默丢 5 篇；修复后 total=505
    const first = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-page&group=大组`)).json();
    assert.equal(first.total, GROUP_TOTAL, 'total 必须是真实匹配数而非截断页长度');
    assert.equal(first.docs.length, 500, '默认页大小 500');
    assert.equal(first.truncated, true, '还有剩余页时 truncated:true');
    assert.equal(first.offset, 0);

    // 翻页取全：offset=500 取剩余 5 篇
    const second = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-page&group=大组&offset=500`)).json();
    assert.equal(second.docs.length, 5, '剩余页应含 5 篇');
    assert.equal(second.truncated, false, '取完最后一页 truncated:false');
    assert.equal(second.total, GROUP_TOTAL);
    const names = [...first.docs, ...second.docs].map((d: { name: string }) => d.name);
    assert.equal(new Set(names).size, GROUP_TOTAL, '两页聚合后应覆盖全部 505 篇且无重复');

    // 自定义 limit + offset 组合
    const mid = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-page&group=大组&limit=100&offset=100`)).json();
    assert.equal(mid.docs.length, 100);
    assert.equal(mid.truncated, true);
    assert.equal(mid.total, GROUP_TOTAL);
    assert.equal(mid.docs[0].name, '分页文档-100', 'offset 窗口起点正确');

    // 无 group 路径同样分页一致（旧行为 total 本就正确，此处锁回归）
    const allFirst = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-page`)).json();
    assert.equal(allFirst.total, GROUP_TOTAL);
    assert.equal(allFirst.docs.length, 500);
    assert.equal(allFirst.truncated, true);
    const allSecond = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-page&offset=500`)).json();
    assert.equal(allSecond.docs.length, 5);
    assert.equal(allSecond.truncated, false);
  });

  it('批次 2 R7：新布局（relations/ 分片，无旧单文件）doc/list 正常——旧实现恒空', async () => {
    const { writeGroupCacheBatch } = await import('../src/lib/group-cache.js');
    writeGroupCacheBatch('doc-sharded', new Map([
      ['g1', {
        version: 1, scope: 'doc-sharded',
        hot_relations: [
          { id: 'r-甲', text: '分片文档甲', score: 1, sourcePath: 'docs/甲.md', memoryIds: ['m-1'] },
          { id: 'r-乙', text: '分片文档乙', score: 1, ftsIds: ['f-1'], ftsIndexComplete: true },
        ],
        keywords: [],
      }],
      ['g2/sub', {
        version: 1, scope: 'doc-sharded',
        hot_relations: [{ id: 'r-丙', text: '深层文档丙', score: 1, memoryIds: ['m-3'], tags: ['t1'] }],
        keywords: [],
      }],
    ]));

    // 新布局下旧单文件不存在（writeGroupCacheBatch 已把 '{}' 旧壳迁移为 .bak）
    // ——旧 buildDocList 锚定旧文件恒返回空列表（Browse 全空），修复后正常聚合
    const list = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-sharded`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.total, 3, '新布局 doc/list 不再恒空');
    const byName = new Set(list.docs.map((d: { name: string }) => d.name));
    assert.ok(byName.has('分片文档甲'));
    assert.ok(byName.has('深层文档丙'));
    const jia = list.docs.find((d: { name: string }) => d.name === '分片文档甲');
    assert.equal(jia.group, 'g1');
    assert.equal(jia.vectorized, true);
    assert.equal(jia.fullTextIndexed, false);

    // group 精确过滤 + tags 聚合路径
    const g2 = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-sharded&group=g2/sub`)).json();
    assert.equal(g2.total, 1);
    assert.equal(g2.docs[0].name, '深层文档丙');
    assert.ok((g2.tags as string[]).includes('t1'), '新布局 tags 聚合同步正常');
  });
});

describe('/api/import/upload', () => {
  it('最后一批在后端启动导入，重复提交返回同一个 jobId', async () => {
    const uploadId = crypto.randomUUID();
    const send = (batchIndex: number, finalize = false): Promise<Response> => fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ki-Upload-Id': uploadId },
      body: JSON.stringify({
        scope: 'up-auto-finalize', uploadId, batchIndex, batchCount: 2,
        files: [{ name: `part-${batchIndex}.md`, content: Buffer.from(`# Part ${batchIndex}`).toString('base64') }],
        ...(finalize ? { finalize: { group: 'auto', vector: false } } : {}),
      }),
    });

    const first = await send(0);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).jobId, undefined);
    const pendingStatus = await fetch(`${handle!.base}/api/import/upload-status?${new URLSearchParams({ scope: 'up-auto-finalize', uploadId })}`);
    assert.equal(pendingStatus.status, 200);
    assert.equal((await pendingStatus.json()).state, 'uploading');
    const final = await send(1, true);
    assert.equal(final.status, 200);
    const completed = await final.json();
    assert.ok(completed.jobId);
    const recovered = await fetch(`${handle!.base}/api/import/upload-status?${new URLSearchParams({ scope: 'up-auto-finalize', uploadId })}`);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).jobId, completed.jobId, '丢失最后一批响应后可通过 uploadId 找回任务');
    const wrongScope = await fetch(`${handle!.base}/api/import/upload-status?${new URLSearchParams({ scope: 'another-scope', uploadId })}`);
    assert.equal(wrongScope.status, 404);
    assert.equal((await (await send(1, true)).json()).jobId, completed.jobId);

    const legacyRun = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-auto-finalize', uploadId, vector: false }),
    });
    assert.equal(legacyRun.status, 202);
    assert.equal((await legacyRun.json()).jobId, completed.jobId);
  });

  it('批次未齐或过早提交时不启动导入', async () => {
    const uploadId = crypto.randomUUID();
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ki-Upload-Id': uploadId },
      body: JSON.stringify({
        scope: 'up-incomplete', uploadId, batchIndex: 0, batchCount: 2,
        files: [{ name: 'part.md', content: Buffer.from('# Part').toString('base64') }],
        finalize: { vector: false },
      }),
    });
    assert.equal(res.status, 400, '非最后一批不可提交导入');

    const secondId = crypto.randomUUID();
    const missingFirst = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ki-Upload-Id': secondId },
      body: JSON.stringify({
        scope: 'up-incomplete', uploadId: secondId, batchIndex: 1, batchCount: 2,
        files: [{ name: 'last.md', content: Buffer.from('# Last').toString('base64') }],
        finalize: { vector: false },
      }),
    });
    assert.equal(missingFirst.status, 400);
  });

  it('下一次新上传顺手清理过期暂存目录', async () => {
    const root = path.join(process.env.HOME!, '.ki', 'import-uploads');
    const oldId = crypto.randomUUID();
    const oldDir = path.join(root, oldId);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, '.scope'), 'up-old');
    fs.writeFileSync(path.join(oldDir, '.upload-session.json'), JSON.stringify({
      scope: 'up-old', state: 'uploading', updatedAt: Date.now() - 25 * 60 * 60 * 1000,
    }));
    const importedDir = path.join(root, crypto.randomUUID());
    fs.mkdirSync(importedDir, { recursive: true });
    fs.writeFileSync(path.join(importedDir, '.scope'), 'up-imported');
    fs.writeFileSync(path.join(importedDir, 'source.md'), '# source');
    fs.writeFileSync(path.join(importedDir, '.upload-session.json'), JSON.stringify({
      scope: 'up-imported', state: 'done', jobId: crypto.randomUUID(),
      updatedAt: Date.now() - 25 * 60 * 60 * 1000,
    }));
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-new', files: [{ name: 'new.md', content: Buffer.from('# New').toString('base64') }] }),
    });
    assert.equal(res.status, 200);
    const newBody = await res.json();
    for (let attempt = 0; attempt < 50 && fs.existsSync(oldDir); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(path.join(root, newBody.uploadId, 'new.md')), true);
    assert.equal(fs.existsSync(path.join(importedDir, 'source.md')), true, '已导入文件作为源目录保留');
  });

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

describe('/api/vector/status/refresh', () => {
  it('引擎可用时正常刷新：200 + status，且不出现 degraded 标记（R8 接线）', async () => {
    const res = await fetch(`${handle!.base}/api/vector/status/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'vector-refresh-ok' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; status?: { scope?: string }; degraded?: unknown };
    assert.equal(body.ok, true);
    assert.ok(body.status, '应返回 status 快照');
    assert.equal(body.degraded, undefined, '未超时时不得出现降级标记（避免误标 stale）');
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
    const taskResponse = await fetch(`${handle!.base}/api/tasks/${firstRunBody.jobId}`);
    assert.equal(taskResponse.status, 200);
    const taskBody = await taskResponse.json() as any;
    assert.equal(taskBody.task.source, 'web');
    assert.equal(taskBody.task.operation, 'import');
    assert.equal(taskBody.task.scope, 'run-conflict-result');
    assert.equal(taskBody.task.state, 'succeeded');

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

  it('R4：同目录二次导入 + conflictMode skip → 零处理单元（全部"已存在"跳过，带 skipReason）', async () => {
    const scope = 'run-conflict-skip';
    const files = [
      { name: 'a.md', content: Buffer.from('# A\n旧正文').toString('base64') },
      { name: 'b.md', content: Buffer.from('# B\n内容B').toString('base64') },
    ];
    // FTS-only 首次创建 zvec Collection 需独立 worker 冷启动，给足等待窗口
    const waitJob = async (jobId: string): Promise<any> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const status = await fetch(`${handle!.base}/api/import/status?jobId=${encodeURIComponent(jobId)}`);
        const body = await status.json();
        if (body.job?.state !== 'running') return body.job;
      }
      throw new Error('job 等待超时');
    };
    const importOnce = async (conflictMode?: string): Promise<any> => {
      const upload = await fetch(`${handle!.base}/api/import/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, files }),
      });
      const uploadBody = await upload.json();
      const run = await fetch(`${handle!.base}/api/import/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, uploadId: uploadBody.uploadId, vector: false, ...(conflictMode ? { conflictMode } : {}) }),
      });
      const runBody = await run.json();
      return waitJob(runBody.jobId);
    };

    const first = await importOnce();
    assert.equal(first.state, 'done', first.error);
    assert.equal(first.result?.stats?.total, 2);

    // 用户现场：同一目录（同名同 sourcePath）二次导入，选「跳过同名文件」
    const second = await importOnce('skip');
    assert.equal(second.state, 'done', second.error);
    assert.equal(second.result?.stats?.total, 0, 'skip 重导不得产出处理单元');
    assert.equal(second.result?.stats?.vectorized, 0);
    assert.deepEqual(
      second.result?.conflicts?.map((item: any) => [item.action, item.skipReason]),
      [['skip', 'already-imported'], ['skip', 'already-imported']],
    );
    assert.deepEqual(second.result?.stats?.files, { total: 0, completed: 0, incomplete: 0, scanned: 2, skipped: 2, unchanged: 0 });
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

describe('/api/tasks scope 授权', () => {
  it('列表先按 scope 过滤，详情对无权任务返回统一 404', async () => {
    const config = loadConfig();
    const allowedScope = `tasks-auth-${crypto.randomUUID().slice(0, 8)}`;
    const deniedScope = `tasks-denied-${crypto.randomUUID().slice(0, 8)}`;
    const allowedTaskId = `task-${crypto.randomUUID()}`;
    const deniedTaskId = `task-${crypto.randomUUID()}`;
    const allowed = createTaskReporter(config, {
      id: allowedTaskId, source: 'cli', operation: 'import', scope: allowedScope,
    });
    const denied = createTaskReporter(config, {
      id: deniedTaskId, source: 'web', operation: 'restore', scope: deniedScope,
    });
    allowed.finish('succeeded');
    denied.finish('failed', { error: 'private failure' });

    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: true,
      buildServer: buildTestServer,
      webDir: null,
      resolveClientAddr: () => '192.168.1.10',
      resolveTokenScopes: (token) => token === 'scoped-token' ? [allowedScope] : undefined,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const headers = { Authorization: 'Bearer scoped-token' };
    try {
      const list = await fetch(`${base}/api/tasks?limit=1`, { headers });
      assert.equal(list.status, 200);
      const body = await list.json() as any;
      assert.equal(body.total, 1);
      assert.equal(body.tasks.length, 1);
      assert.equal(body.tasks[0].scope, allowedScope);

      const hidden = await fetch(`${base}/api/tasks/${deniedTaskId}`, { headers });
      assert.equal(hidden.status, 404);
      assert.equal((await hidden.json() as any).code, 'TASK_NOT_FOUND');

      const vectorStatus = await fetch(`${base}/api/vector/status?scope=${deniedScope}`, { headers });
      assert.equal(vectorStatus.status, 403);
    } finally {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe('/api/tags', () => {
  // R8 二期（REQ-20261009-003）：本组锁**响应形状与关键不变量**；
  // 超时降级 + 队列槽放行的**真实撞锁**验证在 temp/verify-r8-tags-timeout.ts（flock 占锁法）。
  it('形状正确；未超时时不得出现 degraded 标记（degraded 只表示 timeout）', async () => {
    const res = await fetch(`${handle!.base}/api/tags?scope=default`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok: boolean; tags: { tag: string; count: number }[]; scope: string; error?: string; degraded?: unknown;
    };
    assert.equal(body.scope, 'default', '响应必须回显 scope（前端按它归并标签缓存）');
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(Array.isArray(body.tags), 'tags 必须是数组');
    assert.equal(body.degraded, undefined, '未超时不得出现 degraded（真实失败也不得带 —— 只 timeout 才带）');
    if (body.ok) {
      // 成功路径：内部保留 tag 必须被过滤（ki-search / ki-relation / ki-path）
      const reserved = new Set(['ki-search', 'ki-relation', 'ki-path']);
      for (const t of body.tags) assert.ok(!reserved.has(t.tag), `内部保留 tag 泄漏：${t.tag}`);
    } else {
      // 失败路径（如"向量服务暂不可用"）：不得返回标签，且必须给 error 文案
      assert.deepEqual(body.tags, [], '失败时不得返回标签');
      assert.equal(typeof body.error, 'string');
    }
  });
});
