/**
 * restore-cancel.network.mjs —— 真实 embedding restore + rebuild 中途取消验收。
 *
 * 覆盖：
 *   - 隔离 daemon 执行 restore + rebuild-vector job
 *   - 401 条内容形成多批向量化
 *   - rebuild 批次执行期间请求取消
 *   - 取消后的终态、进度稳定性、队列清空和默认 daemon 存活
 *
 * 安全：使用隔离 HOME、配置、端口、KB、vector 和 backup，不接触用户默认数据。
 * 运行：npm run test:e2e:restore-cancel
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  probeHealth,
  startIsolatedDaemon,
  stopIsolatedDaemon,
} from './isolated-daemon.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const API_KEY = process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;
const SCOPE = 'stage3-restore-cancel';
const GROUP = 'restore-fixture';
const DOCUMENT_COUNT = 401;

function loadEnvFile() {
  const candidates = [path.join(REPO_ROOT, '.env.e2e'), path.join(REPO_ROOT, '.env')];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const separator = value.indexOf('=');
    if (separator <= 0) continue;
    const key = value.slice(0, separator).trim();
    const content = value.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = content;
  }
}
loadEnvFile();

const EFFECTIVE_API_KEY = process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? API_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJob(port, jobId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/restore/status?jobId=${encodeURIComponent(jobId)}`);
  const body = await response.text();
  assert.equal(response.status, 200, `restore status 应返回 200：${body}`);
  return JSON.parse(body);
}

async function requestCancel(port, jobId) {
  return await fetch(`http://127.0.0.1:${port}/api/restore/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

test('阶段 3：真实 restore/rebuild 中途取消', {
  skip: EFFECTIVE_API_KEY ? false : '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY）',
  timeout: 360_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-stage3-restore-cancel-'));
  const isolatedHome = path.join(root, 'home');
  const dataDir = path.join(root, 'kb');
  const vectorDir = path.join(root, 'vector');
  const backupDir = path.join(root, 'backup');
  const snapshotRoot = path.join(root, 'snapshot-source');
  const sourceScopeDir = path.join(snapshotRoot, SCOPE);
  const snapshotFile = path.join(root, 'restore-cancel.tar.gz');
  const configPath = path.join(root, 'config.json');
  const port = 17900 + Math.floor(Math.random() * 400);
  const defaultDaemonBefore = await probeHealth(7423);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    NODE_NO_WARNINGS: '1',
    SILICONFLOW_API_KEY: EFFECTIVE_API_KEY,
  };
  const config = {
    dataDir,
    vectorDir,
    backupDir,
    vector: { maxOpenCollections: 2 },
    embedding: {
      provider: 'siliconflow',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: Number.parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
      apiKey: '${SILICONFLOW_API_KEY}',
    },
    scopes: { [SCOPE]: {} },
  };
  let isolatedHealth = null;

  fs.mkdirSync(isolatedHome, { recursive: true });
  for (const directory of [dataDir, vectorDir, backupDir, sourceScopeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const index = {};
  const relations = [];
  for (let indexNumber = 0; indexNumber < DOCUMENT_COUNT; indexNumber++) {
    const relation = `restore-cancel-document-${String(indexNumber).padStart(4, '0')}`;
    const text = `restore cancel fixture ${indexNumber}：验证长任务在向量化批次边界取消后停止后续写入。`;
    index[relation] = text;
    relations.push({ text: relation, memoryId: null, memoryIds: [], tags: [] });
  }
  fs.mkdirSync(path.join(sourceScopeDir, GROUP), { recursive: true });
  fs.writeFileSync(
    path.join(sourceScopeDir, GROUP, 'index.json'),
    JSON.stringify(index, null, 2),
  );
  fs.writeFileSync(
    path.join(sourceScopeDir, 'relations-cache.json'),
    JSON.stringify({
      version: 1,
      scope: SCOPE,
      partition_config: {},
      groups: { [GROUP]: { hot_relations: relations, keywords: [] } },
      updatedAt: null,
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(sourceScopeDir, 'group-index.json'),
    JSON.stringify({ version: 1, scope: SCOPE, groups: { [GROUP]: {} } }, null, 2),
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  execFileSync('tar', ['-czf', snapshotFile, '-C', snapshotRoot, SCOPE], { stdio: 'ignore' });

  try {
    isolatedHealth = await startIsolatedDaemon({ configPath, env, port });
    assert.equal(isolatedHealth.ok, true);

    const runResponse = await fetch(`http://127.0.0.1:${port}/api/restore/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: SCOPE,
        snapshotFile,
        rebuildVector: true,
      }),
    });
    const runBody = await runResponse.text();
    assert.equal(runResponse.status, 202, `restore job 应返回 202：${runBody}`);
    const submitted = JSON.parse(runBody);
    assert.equal(typeof submitted.jobId, 'string');

    let cancelled = false;
    let latest;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      latest = await readJob(port, submitted.jobId);
      const job = latest.job;
      if (
        !cancelled
        && job.state === 'running'
        && job.phase === 'rebuild'
        && job.progress?.total >= DOCUMENT_COUNT
        && job.progress.done < job.progress.total
      ) {
        const cancelResponse = await requestCancel(port, submitted.jobId);
        const cancelBodyText = await cancelResponse.text();
        assert.equal(cancelResponse.status, 202, `中途取消应返回 202：${cancelBodyText}`);
        const cancelBody = JSON.parse(cancelBodyText);
        assert.equal(cancelBody.state, 'cancelling');
        cancelled = true;
      }
      if (job.state !== 'running') break;
      await sleep(250);
    }

    assert.equal(cancelled, true, `应在 rebuild 执行期间发起取消：${JSON.stringify(latest)}`);
    latest = await readJob(port, submitted.jobId);
    assert.equal(latest.job.state, 'cancelled', JSON.stringify(latest));
    assert.equal(latest.job.cancelRequested, true, JSON.stringify(latest));
    assert.ok(latest.job.progress.total >= DOCUMENT_COUNT, JSON.stringify(latest));
    assert.ok(latest.job.progress.done < latest.job.progress.total, JSON.stringify(latest));
    assert.equal(latest.job.progress.done % 200, 0, JSON.stringify(latest));

    const terminalProgress = JSON.stringify(latest.job.progress);
    const terminalFinishedAt = latest.job.finishedAt;
    await sleep(1500);
    const stable = await readJob(port, submitted.jobId);
    assert.equal(stable.job.state, 'cancelled', JSON.stringify(stable));
    assert.equal(JSON.stringify(stable.job.progress), terminalProgress, JSON.stringify(stable));
    assert.equal(stable.job.finishedAt, terminalFinishedAt, JSON.stringify(stable));

    const finalHealth = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(finalHealth.queue.activeWorkers, 0, JSON.stringify(finalHealth));
    assert.deepEqual(finalHealth.queue.queues, {}, JSON.stringify(finalHealth));
    t.diagnostic(`RESTORE_CANCEL_BENCHMARK ${JSON.stringify({
      fixtureDocuments: DOCUMENT_COUNT,
      vectorEntries: latest.job.progress.total,
      terminalProgress: latest.job.progress,
      cancelRequested: latest.job.cancelRequested,
      terminalState: latest.job.state,
      finishedAt: latest.job.finishedAt,
      stableAfterMs: 1500,
      queue: finalHealth.queue,
      vectorResources: finalHealth.vectorResources,
    })}`);
  } finally {
    let stopped;
    let defaultDaemonAfter = null;
    try {
      stopped = await stopIsolatedDaemon({ port, pid: isolatedHealth?.pid });
      if (defaultDaemonBefore?.ok === true) {
        defaultDaemonAfter = await probeHealth(7423);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(stopped?.exited, true, `隔离 daemon 未退出：${JSON.stringify(stopped)}`);
    assert.equal(stopped?.portClosed, true, `隔离 daemon 端口仍可访问：${JSON.stringify(stopped)}`);
    if (defaultDaemonBefore?.ok === true) {
      assert.equal(defaultDaemonAfter?.ok, true, 'restore cancel E2E 不应停止默认 7423 daemon');
    }
  }
});
