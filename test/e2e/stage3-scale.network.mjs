/**
 * stage3-scale.network.mjs —— 阶段 3 真实 embedding 规模/资源基准。
 *
 * 覆盖：
 *   - 4 个 scope 的跨 scope 并发写入（6 轮，共 24 请求）
 *   - 同 scope 读写并发的排队观测
 *   - /healthz.vectorResources 的 maxOpenCollections 峰值
 *
 * 安全：使用隔离 HOME、配置和数据目录，不接触用户默认 daemon/数据；无 key 时整套 skip。
 * 运行：npm run test:e2e:stage3
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  probeHealth,
  readProcessResourceMetrics,
  startIsolatedDaemon,
  stopIsolatedDaemon,
} from './isolated-daemon.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const KI_BIN = path.join(REPO_ROOT, 'bin', 'ki.mjs');

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

const API_KEY = process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;
const SCOPES = ['stage3-a', 'stage3-b', 'stage3-c', 'stage3-d'];
const CROSS_SCOPE_ROUNDS = 6;

function parseJsonOutput(stdout) {
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(stdout.slice(first, last + 1)); } catch { return null; }
}

function summarizeOsResources(samples) {
  const supported = samples.filter((sample) => sample.supported && sample.rssKb !== null);
  if (supported.length === 0) return { supported: false, sampleCount: samples.length };
  return {
    supported: true,
    sampleCount: samples.length,
    peak: {
      rssKb: Math.max(...supported.map((sample) => sample.rssKb)),
      mmapCount: Math.max(...supported.map((sample) => sample.mmapCount)),
      fdCount: Math.max(...supported.map((sample) => sample.fdCount)),
    },
    final: supported.at(-1),
  };
}

test('阶段 3：真实 embedding 跨 scope / 同 scope 资源基准', {
  skip: API_KEY ? false : '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY）',
  timeout: 300_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-stage3-scale-'));
  const isolatedHome = path.join(root, 'home');
  const configPath = path.join(root, 'config.json');
  const port = 17400 + Math.floor(Math.random() * 500);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    NODE_NO_WARNINGS: '1',
    SILICONFLOW_API_KEY: API_KEY,
  };
  const config = {
    dataDir: path.join(root, 'kb'),
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    vector: { maxOpenCollections: 2 },
    embedding: {
      provider: 'siliconflow',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: Number.parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
      apiKey: '${SILICONFLOW_API_KEY}',
    },
    scopes: Object.fromEntries(SCOPES.map((scope) => [scope, {}])),
  };
  fs.mkdirSync(isolatedHome, { recursive: true });
  for (const directory of [config.dataDir, config.vectorDir, config.backupDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const argsWithConfig = (args) => [...args, '--config', configPath];
  const runSync = (args, timeout = 180_000) => spawnSync('node', [KI_BIN, ...argsWithConfig(args)], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout,
  });
  const run = (args, timeout = 180_000) => new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn('node', [KI_BIN, ...argsWithConfig(args)], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, elapsedMs: Math.round(performance.now() - startedAt), stdout, stderr });
    });
  });
  const defaultDaemonBefore = await probeHealth(7423);
  let isolatedHealth = null;
  const expectedWrites = new Map(SCOPES.map((scope) => [scope, []]));
  const osResourceSamples = [];
  let resourceSampler = null;

  try {
    isolatedHealth = await startIsolatedDaemon({ configPath, env, port });
    assert.equal(isolatedHealth.ok, true, '隔离 daemon healthz 应就绪');
    const sampleOsResources = () => {
      osResourceSamples.push(readProcessResourceMetrics(isolatedHealth.pid));
    };
    sampleOsResources();
    resourceSampler = setInterval(sampleOsResources, 250);

    for (const scope of SCOPES) {
      const inputPath = path.join(root, `${scope}.json`);
      fs.writeFileSync(inputPath, JSON.stringify([
        { text: `${scope} 的资源治理基准文档，描述 Collection LRU 和跨 scope 检索。`, tags: 'ki-search' },
        { text: `${scope} 的并发基准文档，描述 daemon 队列与同 scope 写入顺序。`, tags: 'ki-search' },
      ]));
      const seeded = runSync(['bulk-store', '--scope', scope, '--input', inputPath]);
      assert.equal(seeded.status, 0, `${scope} seed 失败：${seeded.stderr}`);
    }

    const crossScopeWrites = [];
    const crossStartedAt = performance.now();
    for (let round = 0; round < CROSS_SCOPE_ROUNDS; round++) {
      const batch = await Promise.all(SCOPES.map((scope) => run([
        'store', '--scope', scope, '--text', `${scope} 阶段3跨 scope 写入基准 ${round}`, '--tags', 'ki-search',
      ])));
      crossScopeWrites.push(...batch.map((result, index) => ({
        scope: SCOPES[index],
        status: result.status,
        elapsedMs: result.elapsedMs,
        queued: /已排队执行/.test(result.stderr),
      })));
      for (let index = 0; index < batch.length; index++) {
        const result = batch[index];
        const body = parseJsonOutput(result.stdout);
        const detail = `scope=${SCOPES[index]} round=${round} status=${result.status} signal=${result.signal ?? 'null'}`
          + ` stderr=${result.stderr} stdout=${result.stdout}`;
        assert.equal(body?.ok, true, `跨 scope 写入应返回 ok：${detail}`);
        assert.equal(typeof body.docId, 'string', `跨 scope 写入应返回 docId：${detail}`);
        expectedWrites.get(SCOPES[index]).push({
          text: `${SCOPES[index]} 阶段3跨 scope 写入基准 ${round}`,
          docId: body.docId,
        });
      }
    }
    const crossWallMs = Math.round(performance.now() - crossStartedAt);
    assert.ok(crossScopeWrites.every((result) => result.status === 0), JSON.stringify(crossScopeWrites));
    assert.equal(crossScopeWrites.length, SCOPES.length * CROSS_SCOPE_ROUNDS);

    for (const scope of SCOPES) {
      const recalled = await run([
        'search', '--scope', scope, '--query', '阶段3跨 scope 写入基准', '--tags', 'ki-search', '--limit', '100',
      ]);
      const body = parseJsonOutput(recalled.stdout);
      assert.equal(recalled.status, 0, `${scope} 记录守恒查询失败：${recalled.stderr}`);
      assert.equal(body?.ok, true, `${scope} 记录守恒查询应成功：${recalled.stdout}`);
      const results = body.results ?? [];
      for (const expected of expectedWrites.get(scope)) {
        assert.ok(
          results.some((result) => result.memoryId === expected.docId && (result.content ?? '').includes(expected.text)),
          `${scope} 缺少写入记录 ${expected.docId}：${JSON.stringify(body.results)}`,
        );
      }
    }

    const sameScope = await Promise.all([
      run(['search', '--scope', SCOPES[0], '--query', '同 scope 读写顺序', '--limit', '1']),
      run(['store', '--scope', SCOPES[0], '--text', `阶段3同 scope 写入 ${Date.now()}`, '--tags', 'ki-search']),
    ]);
    assert.ok(sameScope.every((result) => result.status === 0), JSON.stringify(sameScope));
    osResourceSamples.push(readProcessResourceMetrics(isolatedHealth.pid));

    const durations = crossScopeWrites.map((result) => result.elapsedMs).sort((a, b) => a - b);
    const p95Ms = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)];
    const finalHealth = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    const metrics = finalHealth.vectorResources;
    assert.ok(metrics?.peakOpenCount <= 2, JSON.stringify(metrics));
    const report = {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        embeddingModel: config.embedding.model,
        embeddingDimension: config.embedding.dimension,
        maxOpenCollections: config.vector.maxOpenCollections,
      },
      crossScopeWrites: {
        requests: crossScopeWrites.length,
        wallMs: crossWallMs,
        p95Ms,
        throughputPerSec: Number((crossScopeWrites.length / (crossWallMs / 1000)).toFixed(3)),
        queuedCount: crossScopeWrites.filter((result) => result.queued).length,
        statuses: crossScopeWrites.map((result) => result.status),
      },
      sameScope: {
        durationsMs: sameScope.map((result) => result.elapsedMs),
        queuedCount: sameScope.filter((result) => /已排队执行/.test(result.stderr)).length,
        statuses: sameScope.map((result) => result.status),
      },
      vectorResources: metrics,
      osResources: summarizeOsResources(osResourceSamples),
    };
    t.diagnostic(`STAGE3_BENCHMARK ${JSON.stringify(report)}`);
  } finally {
    let stopped;
    let defaultDaemonAfter = null;
    try {
      if (resourceSampler) clearInterval(resourceSampler);
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
      assert.equal(defaultDaemonAfter?.ok, true, '隔离测试不应停止默认 7423 daemon');
    }
  }
});
