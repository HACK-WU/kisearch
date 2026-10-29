import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskReporter, getTaskRecord, MAX_TASK_DETAIL_ITEMS } from '../src/lib/task-registry.ts';

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

test('参数快照与结果摘要落盘：errorCode 并入 result，绝对路径被丢弃', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-snapshot-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'snapshot', source: 'web', operation: 'import', scope: 'default', retryOf: 'retry-source',
  });
  try {
    reporter.update({
      state: 'running',
      params: {
        sourceKind: 'upload',
        group: 'raw',
        tags: ['产品', 'v2'],
        vector: false,
        conflictMode: 'suffix',
        conflictSuffix: '_{n}',
        skipDuplicates: true,
      },
    });
    reporter.finish('succeeded', {
      result: {
        files: {
          scanned: 3, completed: 2, incomplete: 1, skipped: 0,
          unchanged: 1, duplicatesSkipped: 0,
          skippedReasons: { conflict: 0, duplicate: 0, other: 0 },
        },
        groups: ['raw'],
        // 绝对路径必须被 safeRelPath 丢弃，不得进入共享台账
        duplicates: [{ path: '/etc/passwd', existingGroup: 'raw', existingRelation: 'leak' }],
      },
      errorCode: 'ALL_FILES_DUPLICATES',
    });
    const record = getTaskRecord(config, 'snapshot');
    assert.equal(record?.retryOf, 'retry-source');
    assert.equal(record?.params?.sourceKind, 'upload');
    assert.equal(record?.params?.vector, false);
    assert.equal(record?.params?.conflictSuffix, '_{n}');
    assert.deepEqual(record?.params?.tags, ['产品', 'v2']);
    assert.equal(record?.result?.errorCode, 'ALL_FILES_DUPLICATES');
    assert.equal(record?.result?.files?.unchanged, 1);
    assert.equal(record?.result?.duplicates, undefined, '绝对路径条目必须被丢弃');
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('明细超过上限时被截断并标记 truncated，台账仍可读（32KB 护栏）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-budget-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, { id: 'budget', source: 'web', operation: 'import', scope: 'default' });
  try {
    const many = Array.from({ length: 200 }, (_, index) => ({
      path: `docs/file-${index}-with-a-fairly-long-name.md`,
      existingGroup: 'raw',
      existingRelation: `doc-${index}`,
    }));
    reporter.finish('succeeded', { result: { duplicates: many } });
    const record = getTaskRecord(config, 'budget');
    assert.equal(record?.result?.duplicates?.length, MAX_TASK_DETAIL_ITEMS);
    assert.equal(record?.result?.truncated, true);
    const size = fs.statSync(path.join(root, '.ki-tasks', 'budget.json')).size;
    assert.ok(size < 32 * 1024, `台账文件必须小于 32KB（实际 ${size}）`);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('预算按 UTF-8 字节计算：中文明细超限时必须被裁剪（不能按字符串长度判断）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-bytes-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, { id: 'bytes', source: 'web', operation: 'import', scope: 'default' });
  try {
    // 每条 ≈ 1800 字节（中文 3 字节/字），20 条 ≈ 36KB > 32KB；
    // 但字符数只有 ~12000 ⇒ 用 String.length 判断会误以为没超限（这就是本用例要锁的点）
    const chinese = '中'.repeat(200);
    const many = Array.from({ length: MAX_TASK_DETAIL_ITEMS }, (_, index) => ({
      path: `${'中'.repeat(180)}-${index}.md`,
      existingGroup: chinese,
      existingRelation: chinese,
    }));
    reporter.finish('succeeded', { result: { duplicates: many } });
    const file = path.join(root, '.ki-tasks', 'bytes.json');
    const size = fs.statSync(file).size;
    assert.ok(size < 32 * 1024, `台账文件必须小于 32KB（实际 ${size}）`);
    const record = getTaskRecord(config, 'bytes');
    assert.ok(record, '超预算裁剪后记录必须仍可读（否则任务会静默消失）');
    assert.equal(record?.result?.duplicates, undefined, '超限明细必须被裁掉');
    assert.equal(record?.result?.truncated, true);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('无法识别的 errorCode 与冲突 action 被丢弃', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-strict-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, { id: 'strict', source: 'web', operation: 'import', scope: 'default' });
  try {
    reporter.finish('failed', {
      result: {
        errorCode: 'lowerCaseCode',
        conflicts: [{ path: 'a.md', relation: 'a_1', action: 'renamed' as never }],
      },
    });
    const record = getTaskRecord(config, 'strict');
    assert.equal(record?.result?.errorCode, undefined);
    assert.equal(record?.result?.conflicts, undefined);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
