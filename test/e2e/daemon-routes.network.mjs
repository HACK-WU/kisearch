/**
 * daemon-routes.network.mjs —— backup/export/wiki-backfill 隔离黑盒验收。
 *
 * 场景：预置一个真实 scope KB，依次通过 CLI → daemon 验证：
 *   - backup 快照存在且包含 scope 的 KB/cache 文件
 *   - backup --list 能列出刚生成的快照
 *   - export 生成可读 Markdown
 *   - wiki-backfill 首次写回、幂等跳过和 --force 覆盖
 *
 * 安全：使用隔离 HOME、配置、端口和数据目录；teardown 不调用全局 ki mcp stop。
 * 运行：npm run test:e2e:daemon-routes
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  probeHealth,
  startIsolatedDaemon,
  stopIsolatedDaemon,
} from './isolated-daemon.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const KI_BIN = path.join(REPO_ROOT, 'bin', 'ki.mjs');
const SCOPE = 'stage3-daemon-routes';
const GROUP = 'platform/docs';
const RELATION = 'daemon-route-fixture';
const CONTENT = '# daemon route fixture\n\n验证 backup、export 和 wiki-backfill 均经过共享 daemon。';

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

function parseJson(result, label) {
  assert.equal(result.status, 0, `${label} exit=${result.status} stderr=${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`${label} stdout 不是 JSON：${result.stdout}\n${error.message}`);
  }
}

test('阶段 3：backup/export/wiki-backfill daemon 路由黑盒验收', {
  skip: API_KEY ? false : '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY）',
  timeout: 180_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-stage3-daemon-routes-'));
  const isolatedHome = path.join(root, 'home');
  const dataDir = path.join(root, 'kb');
  const vectorDir = path.join(root, 'vector');
  const backupDir = path.join(root, 'backup');
  const wikiDir = path.join(root, 'wiki');
  const exportDir = path.join(root, 'export');
  const scopeDir = path.join(dataDir, SCOPE);
  const groupDir = path.join(scopeDir, GROUP);
  const configPath = path.join(root, 'config.json');
  const port = 18300 + Math.floor(Math.random() * 300);
  const defaultDaemonBefore = await probeHealth(7423);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    NODE_NO_WARNINGS: '1',
    SILICONFLOW_API_KEY: API_KEY,
  };
  const config = {
    dataDir,
    vectorDir,
    backupDir,
    embedding: {
      provider: 'siliconflow',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: Number.parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
      apiKey: '${SILICONFLOW_API_KEY}',
    },
    scopes: {
      [SCOPE]: {
        wikiSync: { enabled: true, sourceDir: wikiDir },
      },
    },
  };
  const runCli = (args) => spawnSync(
    process.execPath,
    [KI_BIN, ...args, '--config', configPath],
    { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 120_000 },
  );
  let isolatedHealth = null;

  try {
    fs.mkdirSync(isolatedHome, { recursive: true });
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(
      path.join(scopeDir, 'group-index.json'),
      JSON.stringify({ version: 1, scope: SCOPE, groups: { platform: { docs: {} } } }, null, 2),
    );
    fs.writeFileSync(
      path.join(scopeDir, 'relations-cache.json'),
      JSON.stringify({
        version: 1,
        scope: SCOPE,
        groups: { [GROUP]: { hot_relations: [{ text: RELATION, memoryId: null, memoryIds: [], tags: [] }] } },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(groupDir, 'index.json'),
      JSON.stringify({ [RELATION]: CONTENT }, null, 2),
    );

    isolatedHealth = await startIsolatedDaemon({ configPath, env, port });
    assert.equal(isolatedHealth.ok, true, '隔离 daemon healthz 应就绪');

    const backup = parseJson(runCli(['backup', SCOPE]), 'backup');
    assert.equal(backup.ok, true, JSON.stringify(backup));
    assert.equal(backup.action, 'backup');
    assert.equal(typeof backup.snapshotPath, 'string');
    assert.equal(fs.existsSync(backup.snapshotPath), true, JSON.stringify(backup));
    const tarListing = execFileSync('tar', ['-tzf', backup.snapshotPath], { encoding: 'utf8' });
    assert.match(tarListing, new RegExp(`${SCOPE}/group-index\\.json`));
    assert.match(tarListing, new RegExp(`${SCOPE}/relations-cache\\.json`));
    assert.match(tarListing, new RegExp(`${SCOPE}/${GROUP}/index\\.json`));

    const backupList = parseJson(runCli(['backup', SCOPE, '--list']), 'backup --list');
    assert.equal(backupList.ok, true, JSON.stringify(backupList));
    assert.equal(backupList.snapshots.length, 1, JSON.stringify(backupList));
    assert.equal(backupList.snapshots[0].file, path.basename(backup.snapshotPath));

    const exported = parseJson(runCli(['export', SCOPE, '--output', exportDir]), 'export');
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.deepEqual(exported.stats, { total: 1, exported: 1, empty: 0, assets: 0 });
    const exportedFile = path.join(exportDir, SCOPE, GROUP, `${RELATION}.md`);
    assert.equal(fs.existsSync(exportedFile), true, exportedFile);
    assert.match(fs.readFileSync(exportedFile, 'utf8'), /daemon route fixture/);

    const backfilled = parseJson(runCli(['wiki-backfill', SCOPE]), 'wiki-backfill');
    assert.equal(backfilled.ok, true, JSON.stringify(backfilled));
    assert.equal(backfilled.stats.total, 1, JSON.stringify(backfilled));
    assert.equal(backfilled.stats.written, 1, JSON.stringify(backfilled));
    assert.equal(backfilled.stats.existed, 0, JSON.stringify(backfilled));
    const wikiFile = path.join(wikiDir, GROUP, `${RELATION}.md`);
    assert.equal(fs.existsSync(wikiFile), true, wikiFile);
    const wikiContent = fs.readFileSync(wikiFile, 'utf8');
    assert.match(wikiContent, /daemon route fixture/);

    const idempotent = parseJson(runCli(['wiki-backfill', SCOPE]), 'wiki-backfill idempotent');
    assert.equal(idempotent.ok, true, JSON.stringify(idempotent));
    assert.equal(idempotent.stats.written, 0, JSON.stringify(idempotent));
    assert.equal(idempotent.stats.existed, 1, JSON.stringify(idempotent));
    assert.equal(fs.readFileSync(wikiFile, 'utf8'), wikiContent);

    const forced = parseJson(runCli(['wiki-backfill', SCOPE, '--force']), 'wiki-backfill --force');
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(forced.stats.written, 1, JSON.stringify(forced));
    assert.equal(forced.stats.existed, 0, JSON.stringify(forced));
    assert.match(fs.readFileSync(wikiFile, 'utf8'), /daemon route fixture/);

    const finalHealth = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(finalHealth.queue.activeWorkers, 0, JSON.stringify(finalHealth));
    assert.deepEqual(finalHealth.queue.queues, {}, JSON.stringify(finalHealth));
    t.diagnostic(`DAEMON_ROUTES_BENCHMARK ${JSON.stringify({
      backupSnapshots: backupList.snapshots.length,
      exported: exported.stats,
      wikiBackfill: {
        first: backfilled.stats,
        idempotent: idempotent.stats,
        forced: forced.stats,
      },
      queue: finalHealth.queue,
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
      assert.equal(defaultDaemonAfter?.ok, true, 'daemon 路由 E2E 不应停止默认 7423 daemon');
    }
  }
});
