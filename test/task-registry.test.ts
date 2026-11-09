import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskReporter, getTaskRecord, listTaskRecords, markInterruptedTasks, pruneOverflowingTaskDir, MAX_TASK_DETAIL_ITEMS } from '../src/lib/task-registry.ts';
import { hasTaskLog } from '../src/lib/task-log.ts';

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

test('变更明细进入 32KB 裁剪链：超限先裁 modified 但保留计数，台账仍可读', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-modified-budget-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'modified-budget', source: 'web', operation: 'datasource-sync', scope: 'default',
  });
  try {
    // 中文路径：每条约 720 字节（3 字节/字），400+400 条远超 32KB
    const bulky = (): [string, string][] => Array.from({ length: 400 }, (_, index) => [
      `${'中'.repeat(120)}-${index}`,
      `${'文'.repeat(120)}-${index}`,
    ]);
    reporter.finish('succeeded', {
      result: {
        modified: bulky(),
        modifiedTotal: 400,
        created: bulky(),
        createdTotal: 400,
      },
    });
    const record = getTaskRecord(config, 'modified-budget');
    assert.ok(record, '超预算裁剪后记录必须仍可读（否则任务会静默消失）');
    const size = fs.statSync(path.join(root, '.ki-tasks', 'modified-budget.json')).size;
    assert.ok(size < 32 * 1024, `台账文件必须小于 32KB（实际 ${size}）`);
    // 变更明细先于新建明细被裁，但计数保留 ⇒ 页面可显示「共 N 篇，明细未保留」
    assert.equal(record?.result?.modified, undefined, '超限的变更明细必须被裁掉');
    assert.equal(record?.result?.modifiedTruncated, true);
    assert.equal(record?.result?.modifiedTotal, 400);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有变更明细的任务被裁到最末档时，不得虚标 modifiedTruncated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-no-modified-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'no-modified', source: 'web', operation: 'import', scope: 'default',
  });
  try {
    // 只有超大的 created（中文），没有 modified ⇒ 裁到最后一档也不该出现「变更明细被裁」
    const bulky = Array.from({ length: 400 }, (_, index) => [
      `${'中'.repeat(120)}-${index}`,
      `${'文'.repeat(120)}-${index}`,
    ]) as [string, string][];
    reporter.finish('succeeded', { result: { created: bulky, createdTotal: 400 } });
    const record = getTaskRecord(config, 'no-modified');
    assert.ok(record, '裁剪后记录必须仍可读');
    assert.ok(fs.statSync(path.join(root, '.ki-tasks', 'no-modified.json')).size < 32 * 1024);
    assert.equal(record?.result?.modifiedTruncated, undefined, '从来没有变更明细，不能说成「明细被裁」');
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 保留期（2026-11-02：终态 1 小时 → 7 天，心跳窗口刻意不跟随）─────────────

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 直接写台账文件：需要伪造时间戳，走 reporter 只能拿到 now */
function seedRecord(root: string, record: Record<string, unknown>): void {
  const dir = path.join(root, '.ki-tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(record.id)}.json`), JSON.stringify(record), 'utf8');
}

function recordOf(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    id, source: 'cli', operation: 'import', scope: 'default', state: 'succeeded',
    createdAt: now, updatedAt: now, heartbeatAt: now, ...overrides,
  };
}

test('保留期 7 天：终态任务结束 3 天后仍可查、8 天后才过期', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-ttl-'));
  const config = { dataDir: root };
  const now = Date.now();
  try {
    seedRecord(root, recordOf('recent-failed', {
      state: 'failed', finishedAt: now - 3 * DAY, updatedAt: now - 3 * DAY, heartbeatAt: now - 3 * DAY,
    }));
    seedRecord(root, recordOf('expired-ok', {
      state: 'succeeded', finishedAt: now - 8 * DAY, updatedAt: now - 8 * DAY, heartbeatAt: now - 8 * DAY,
    }));

    assert.equal(getTaskRecord(config, 'recent-failed')?.state, 'failed', '3 天前的终态记录必须还在（旧口径 1 小时就会消失）');
    assert.equal(getTaskRecord(config, 'expired-ok'), null, '超过 7 天必须过期');

    const visible = listTaskRecords(config).map((task) => task.id);
    assert.ok(visible.includes('recent-failed'));
    assert.ok(!visible.includes('expired-ok'));
    assert.equal(fs.existsSync(path.join(root, '.ki-tasks', 'expired-ok.json')), false, '列表读取应顺带清掉过期文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('心跳窗口不跟随保留期：未终态任务心跳停 2 小时即清理，活着的老任务仍保留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-heartbeat-'));
  const config = { dataDir: root };
  const now = Date.now();
  try {
    // daemon 崩溃留下的假 running：心跳停在 2 小时前
    seedRecord(root, recordOf('dead-running', {
      state: 'running', createdAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR, heartbeatAt: now - 2 * HOUR,
    }));
    // 真在跑的老任务：3 天前创建，但心跳是 10 秒前
    seedRecord(root, recordOf('live-running', {
      state: 'running', createdAt: now - 3 * DAY, updatedAt: now - 10 * 1000, heartbeatAt: now - 10 * 1000,
    }));

    assert.equal(
      getTaskRecord(config, 'dead-running'), null,
      '心跳超过 1 小时必须判死并清理（若跟随 7 天保留期，这条假 running 会挂一周）',
    );
    assert.equal(getTaskRecord(config, 'live-running')?.state, 'running', '心跳新鲜的任务不受创建时间影响');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('服务重启收尾：遗留 queued/running 改判 failed 并写明原因，终态记录与幂等性都锁住', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-interrupt-'));
  const config = { dataDir: root };
  const now = Date.now();
  try {
    seedRecord(root, recordOf('stale-queued', {
      state: 'queued', createdAt: now - 60_000, updatedAt: now - 2_000, heartbeatAt: now - 2_000,
    }));
    seedRecord(root, recordOf('stale-running', {
      state: 'running', createdAt: now - 60_000, updatedAt: now - 2_000, heartbeatAt: now - 2_000,
      params: { sourceKind: 'external', group: 'raw' },
    }));
    seedRecord(root, recordOf('done-failed', {
      state: 'failed', finishedAt: now - DAY, updatedAt: now - DAY, heartbeatAt: now - DAY,
    }));
    seedRecord(root, recordOf('done-ok', {
      state: 'succeeded', finishedAt: now - DAY, updatedAt: now - DAY, heartbeatAt: now - DAY,
    }));

    assert.deepEqual(markInterruptedTasks(config).sort(), ['stale-queued', 'stale-running']);

    const rescued = getTaskRecord(config, 'stale-running');
    assert.equal(rescued?.state, 'failed');
    assert.equal(rescued?.error, '任务在执行中被服务重启打断，结果未落定');
    assert.match(rescued?.recoveryHint ?? '', /重新发起该操作/);
    assert.equal(rescued?.result?.errorCode, 'SERVICE_RESTART_INTERRUPTED');
    assert.ok((rescued?.finishedAt ?? 0) > now - 5_000, '终态时间应写成收尾时刻');
    // 原有快照必须保留：否则用户连"做到哪一步"都看不到
    assert.equal(rescued?.params?.group, 'raw');
    assert.equal(hasTaskLog(config, 'stale-running'), 'yes', '日志正文要留一行，否则排障时像是没跑过');

    // 终态记录不能被误改（心跳同样陈旧）
    assert.equal(getTaskRecord(config, 'done-failed')?.state, 'failed');
    assert.equal(getTaskRecord(config, 'done-ok')?.state, 'succeeded');

    // 幂等：第二次启动没有非终态记录可改
    assert.deepEqual(markInterruptedTasks(config), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('服务重启收尾：台账目录尚不存在时不抛错（不能挡住服务启动）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-interrupt-empty-'));
  try {
    assert.deepEqual(markInterruptedTasks({ dataDir: path.join(root, 'not-created-yet') }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('台账溢出兜底：按数量从旧删到上限，但心跳窗口内的文件一个都不碰（活任务）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-overflow-'));
  const dir = path.join(root, '.ki-tasks');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const stale = new Date(Date.now() - 2 * HOUR);
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(dir, `old-${i}.json`);
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, stale, stale);
    }
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `new-${i}.json`), '{}');

    // 上限 6、留余量 2 ⇒ 目标 4；共 10 个 ⇒ 需减 6，但窗口内只有 0 个可动
    const removed = pruneOverflowingTaskDir(dir, 6, HOUR, 2);
    assert.equal(removed, 5, '只删得掉窗口外的 5 个旧文件');
    const left = fs.readdirSync(dir).sort();
    assert.equal(left.length, 5);
    assert.ok(left.every((name) => name.startsWith('new-')), '心跳窗口内的文件必须全部保留');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('台账溢出兜底：未超上限时不做任何删除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-overflow-noop-'));
  const dir = path.join(root, '.ki-tasks');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `t-${i}.json`), '{}');
    assert.equal(pruneOverflowingTaskDir(dir, 10, HOUR), 0);
    assert.equal(fs.readdirSync(dir).length, 3);
  } finally {
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
test('大目录导入超预算时保留 created 样本，不得整批丢弃（2026-11-09 现场回归）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-created-sample-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'created-sample', source: 'web', operation: 'import', scope: 'xpert-experts',
  });
  try {
    // 复刻现场：614 篇真实目录 → 快照 400 条；group 为长中文路径（每条 ~120 字节），
    // 400 条约 35KB，刚好越过 32KB-512 的裁剪阈值 —— 旧实现会把 created 整批删掉。
    const groups = [
      '前端专题/Xpert 工作台专家/sub-experts/工作区子专家/implementation',
      '后端专题/平台底座与集成专家/sub-experts/基础字典与客户端壳子专家/implementation',
      '后端专题/平台底座与集成专家/sub-experts/集成与扩展点子专家/test',
    ];
    const created = Array.from({ length: 500 }, (_, index) => [
      groups[index % groups.length],
      `文档-${index}-${'名'.repeat(8)}`,
    ]) as [string, string][];
    reporter.finish('succeeded', {
      result: { created, createdTotal: 614, groups: [...new Set(groups)] },
    });

    const record = getTaskRecord(config, 'created-sample');
    assert.ok(record, '裁剪后记录必须仍可读（否则任务会从列表静默消失）');
    const size = fs.statSync(path.join(root, '.ki-tasks', 'created-sample.json')).size;
    assert.ok(size < 32 * 1024, `台账文件必须小于 32KB（实际 ${size}）`);

    const kept = record?.result?.created ?? [];
    assert.ok(kept.length > 0, '超预算时必须保留 created 样本，不能整批丢弃（否则页面只剩「明细未保留」）');
    assert.ok(kept.length < created.length, `样本必须少于原始条数（实际保留 ${kept.length}）`);
    assert.equal(record?.result?.createdTruncated, true, '保留样本时必须标记明细被截断');
    assert.equal(record?.result?.createdTotal, 614, '总数不受样本裁剪影响');
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('来源 open-api 的任务记录必须可读（新增 TaskSource 值必须同步读侧白名单）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-open-api-source-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'open-api-source', source: 'open-api', operation: 'import', scope: 'default',
    operator: { type: 'token', label: 'Token abc123' },
  });
  try {
    reporter.finish('succeeded', { result: { created: [['__root__', 'a']], createdTotal: 1 } });
    const record = getTaskRecord(config, 'open-api-source');
    // 读侧白名单漏加 'open-api' 时这里返回 null —— 任务会从列表静默消失，比不被识别更糟
    assert.ok(record, '新增来源必须同步 task-registry 读侧白名单，否则任务不可读');
    assert.equal(record?.source, 'open-api');
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
