/**
 * S-03：调度触发的同步执行（真实 FTS-only 导入 + 跳过路径）。
 * 运行：npx jiti test/datasource-scheduled-run.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addDataSource, readDataSource, saveDataSourceSchedule } from '../src/lib/datasource.js';
import { runScheduledSync } from '../src/lib/datasource-scheduled-run.js';
import { createTaskReporter, listTaskRecords } from '../src/lib/task-registry.js';
import { closeFtsEngine } from '../src/lib/fts-client.js';

let root: string;
let configPath: string;
let savedConfigPath: string | undefined;
let sourceDir: string;
const scope = `ds-run-${process.pid}`;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-scheduled-run-'));
  const dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [scope]: {} },
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  sourceDir = path.join(root, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'run-a.md'), '# run-a\n\n定时同步测试内容。\n');
  const added = await addDataSource({ scope, dir: sourceDir, vector: false, config: loadConfig() });
  assert.equal(added.ok, true);
});

after(async () => {
  try { await closeFtsEngine(); } catch { /* ignore */ }
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runScheduledSync', () => {
  it('关闭的计划 → skipped(disabled)，不建任务', async () => {
    const saved = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: { enabled: false, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', at: null, repeat: null },
    });
    assert.equal(saved.ok, true);
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const before = listTaskRecords(loadConfig()).filter((task) => task.scope === scope).length;
    const result = await runScheduledSync({
      scope,
      slot: null,
      record: read.record,
      config: loadConfig(),
    });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reason, 'disabled');
    const afterCount = listTaskRecords(loadConfig()).filter((task) => task.scope === scope).length;
    assert.equal(afterCount, before);
  });

  it('已有 active 任务 → skipped(active-task)，不并发', async () => {
    const saved = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: { enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', at: null, repeat: null },
    });
    assert.equal(saved.ok, true);
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const blocker = createTaskReporter(loadConfig(), {
      source: 'cli',
      operation: 'import',
      scope,
    });
    blocker.update({ state: 'running', startedAt: Date.now() });
    try {
      const result = await runScheduledSync({
        scope,
        slot: null,
        record: read.record,
        config: loadConfig(),
      });
      assert.equal(result.outcome, 'skipped');
      assert.equal(result.reason, 'active-task');
      const afterRead = readDataSource(scope);
      assert.equal(afterRead.ok, true);
      if (afterRead.ok) assert.equal(afterRead.record.schedule.lastSkipReason, 'active-task');
      const scheduled = listTaskRecords(loadConfig()).filter((task) => task.scope === scope && task.source === 'scheduler');
      assert.equal(scheduled.length, 0);
    } finally {
      blocker.finish('cancelled');
    }
  });

  it('真实 FTS-only 同步 → 成功、任务 source=scheduler、不删除源文件', async () => {
    const saved = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: { enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', at: null, repeat: null },
    });
    assert.equal(saved.ok, true);
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const result = await runScheduledSync({
      scope,
      slot: null,
      record: read.record,
      config: loadConfig(),
    });
    assert.notEqual(result.outcome, 'skipped');
    assert.notEqual(result.outcome, 'failed');
    const afterRead = readDataSource(scope);
    assert.equal(afterRead.ok, true);
    if (!afterRead.ok) return;
    assert.ok(afterRead.record.schedule.lastAutoAt);
    assert.equal(afterRead.record.schedule.consecutiveFailures, 0);
    const tasks = listTaskRecords(loadConfig()).filter((task) => task.scope === scope && task.source === 'scheduler');
    assert.ok(tasks.length >= 1);
    assert.equal(tasks[0]?.operation, 'datasource-sync');
    assert.ok(['succeeded', 'partial'].includes(tasks[0]?.state ?? ''));
    // 定时同步不删源文件
    assert.equal(fs.existsSync(path.join(sourceDir, 'run-a.md')), true);
  });
});
