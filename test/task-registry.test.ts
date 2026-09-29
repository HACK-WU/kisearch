import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskReporter, getTaskRecord } from '../src/lib/task-registry.ts';

test('终态首次落盘失败后保持进程活跃并重试写入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-retry-'));
  const config = { dataDir: root };
  const id = 'terminal-retry';
  const reporter = createTaskReporter(config, { id, source: 'cli', operation: 'import', scope: 'default' });
  const file = path.join(root, '.ki-tasks', `${id}.json`);
  const backup = `${file}.backup`;
  try {
    reporter.update({ state: 'running' });
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    reporter.finish('failed', { error: 'embedding unavailable' });
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    const record = getTaskRecord(config, id);
    assert.equal(record?.state, 'failed');
    assert.match(record?.error ?? '', /Embedding 服务暂不可用/);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('共享任务记录不保存 provider 原始错误内容', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-error-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, { id: 'safe-error', source: 'cli', operation: 'import', scope: 'default' });
  try {
    reporter.finish('failed', { error: 'HTTP 429: input document contains PRIVATE_SENTENCE; 成功 2，失败 1，未处理 3' });
    const record = getTaskRecord(config, 'safe-error');
    assert.equal(record?.error, 'Embedding 服务限流；成功 2，失败 1，未处理 3');
    assert.doesNotMatch(fs.readFileSync(path.join(root, '.ki-tasks', 'safe-error.json'), 'utf8'), /PRIVATE_SENTENCE/);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
