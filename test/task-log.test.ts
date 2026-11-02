import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createTaskLogWriter,
  pruneTaskLogs,
  readTaskLog,
  redactForLog,
  taskLogPath,
} from '../src/lib/task-log.ts';
import { createTaskReporter, getTaskRecord } from '../src/lib/task-registry.ts';

function withTemp<T>(run: (config: { dataDir: string }) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-log-'));
  try {
    return run({ dataDir: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const META = {
  id: 'log-basic',
  source: 'web',
  operation: 'datasource-add-remote',
  scope: 'ai-docs',
  createdAt: 1_700_000_000_000,
};

// ─── 写入 / 读取 ───

test('writer 写头行，状态迁移去重，阶段变化才追加', () => {
  withTemp((config) => {
    const writer = createTaskLogWriter(config, META);
    assert.ok(writer, 'writer 应可用');
    writer!.event('running', { phase: 'clone' });
    writer!.event('running', { phase: 'clone' });   // 完全重复 → 不写
    writer!.event('running', { phase: 'vector' });  // 阶段变了 → 写

    const log = readTaskLog(config, META.id, 100);
    assert.ok(log);
    assert.equal(log!.head?.scope, 'ai-docs');
    assert.equal(log!.head?.operation, 'datasource-add-remote');
    assert.equal(log!.head?.id, META.id);
    assert.equal(log!.lines.length, 2, `期望 2 行，实际 ${JSON.stringify(log!.lines)}`);
    assert.match(log!.lines[0], /state running phase=clone/);
    assert.match(log!.lines[1], /state running phase=vector/);
    assert.equal(log!.rotated, false);
  });
});

test('tail 只取最后 N 行，totalLines 保留真实总数', () => {
  withTemp((config) => {
    const writer = createTaskLogWriter(config, META)!;
    for (const phase of ['a', 'b', 'c', 'd', 'e']) writer.event('running', { phase });
    const log = readTaskLog(config, META.id, 2)!;
    assert.equal(log.lines.length, 2);
    assert.equal(log.totalLines, 5);
    assert.match(log.lines[1], /phase=e/);
  });
});

test('读取不存在的日志返回 null（不抛）', () => {
  withTemp((config) => {
    assert.equal(readTaskLog(config, 'nope', 10), null);
    assert.equal(readTaskLog(config, '../escape', 10), null);
    assert.throws(() => taskLogPath(config, 'a/b'), /非法任务 ID/);
  });
});

// ─── 核心价值：原文落日志，task JSON 只存类别 ───

test('reporter 把未压缩的原始错误写进日志，task JSON 只留压缩类别', () => {
  withTemp((config) => {
    const raw = "无法连接远端（Cloning into '/tmp/x'...\nfatal: unable to access 'https://no-such.invalid/a/b.git/': Could not resolve host: no-such.invalid）";
    const reporter = createTaskReporter(config, {
      id: 'log-raw', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
      reporter.finish('failed', { errorCode: 'GIT_NETWORK_FAILED', error: raw, recoveryHint: '检查网络后再试' });
    } finally {
      reporter.stop();
    }

    const log = readTaskLog(config, 'log-raw', 100)!;
    const body = log.lines.join('\n');
    // 原文（git stderr 关键行）在日志里
    assert.match(body, /Could not resolve host: no-such\.invalid/);
    assert.match(body, /code=GIT_NETWORK_FAILED/);
    assert.match(body, /hint=检查网络后再试/);
    // 换行保留为续行前缀，便于 grep '^20' 只取事件行
    assert.match(body, /\n {2}\| fatal: unable to access/);

    // task JSON 只存类别
    const record = getTaskRecord(config, 'log-raw')!;
    assert.equal(record.error, '无法连接远端仓库');
    // 护栏 E1：原文绝不进 task JSON
    const taskJson = fs.readFileSync(path.join(config.dataDir, '.ki-tasks', 'log-raw.json'), 'utf8');
    assert.doesNotMatch(taskJson, /Could not resolve host/);
  });
});

test('成功任务也留一条终态日志（含 errorCode）', () => {
  withTemp((config) => {
    const reporter = createTaskReporter(config, {
      id: 'log-ok', source: 'web', operation: 'datasource-sync', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
      reporter.finish('succeeded', { errorCode: 'SYNC_ENQUEUE_FAILED' });
    } finally {
      reporter.stop();
    }
    const log = readTaskLog(config, 'log-ok', 20)!;
    assert.match(log.lines.join('\n'), /state succeeded/);
    assert.match(log.lines.join('\n'), /code=SYNC_ENQUEUE_FAILED/);
  });
});

test('note() 写入 INFO 行；心跳不产生新行', async () => {
  // 单独建临时目录（withTemp 是同步语义，不能包 async —— 否则 finally 会在 await 前执行）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-task-log-hb-'));
  const config = { dataDir: root };
  const reporter = createTaskReporter(config, {
    id: 'log-note', source: 'web', operation: 'import', scope: 'ai-docs',
  });
  try {
    reporter.note('开始处理 3 个文件');
    const before = readTaskLog(config, 'log-note', 50)!.lines.length;
    // 心跳是 5s 一次；等一个周期确认没有新增
    await new Promise((resolve) => setTimeout(resolve, 5_600));
    const after = readTaskLog(config, 'log-note', 50)!.lines.length;
    assert.equal(after, before, '心跳不得产生日志行（护栏 E4）');
    // 第一行是创建时的 state queued，note 在其后
    assert.match(readTaskLog(config, 'log-note', 50)!.lines.join('\n'), /note 开始处理 3 个文件/);
  } finally {
    reporter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 脱敏 ───

test('redactForLog 抹掉凭据但保留绝对路径', () => {
  assert.equal(redactForLog('Authorization: Bearer sk-abc123'), 'Authorization: Bearer [redacted]');
  assert.equal(redactForLog('api_key=sk-live-1'), 'api_key=[redacted]');
  assert.equal(redactForLog('access_token=abc'), 'access_token=[redacted]');
  assert.equal(redactForLog('https://user:pw@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(redactForLog('ssh://git@github.com/a/b.git'), 'ssh://github.com/a/b.git');
  // 单独 key=（embedding 常见 ?key=xxx），但不能吃掉 keyword
  assert.equal(redactForLog('?key=secret-value&x=1'), '?key=[redacted]&x=1');
  assert.equal(redactForLog('keyword=keep-me'), 'keyword=keep-me');
  // 路径保留：排障第一定位信息
  assert.equal(redactForLog("clone 到 /root/.ki/datasources/ai-docs 失败"), 'clone 到 /root/.ki/datasources/ai-docs 失败');
});

test('落盘内容不含凭据（端到端）', () => {
  withTemp((config) => {
    const reporter = createTaskReporter(config, {
      id: 'log-secret', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.finish('failed', {
        error: 'fatal: unable to access https://user:pw@github.com/a/b.git/ (api_key=sk-live-9, Bearer sk-x)',
      });
    } finally {
      reporter.stop();
    }
    const raw = fs.readFileSync(taskLogPath(config, 'log-secret'), 'utf8');
    assert.doesNotMatch(raw, /pw@/);
    assert.doesNotMatch(raw, /sk-live-9/);
    assert.doesNotMatch(raw, /Bearer sk-x/);
    // 读取侧再过一层，防历史日志/手工编辑绕过写入侧
    const log = readTaskLog(config, 'log-secret', 50)!;
    assert.doesNotMatch(log.lines.join('\n'), /sk-live-9/);
  });
});

test('event 的 detail 值脱敏，error 的 code 清洗（不破行结构）', () => {
  withTemp((config) => {
    const writer = createTaskLogWriter(config, META)!;
    writer.event('running', { phase: 'clone', url: 'https://user:pw@github.com/a/b.git' });
    writer.error('BAD CODE\nINJECT', 'boom');
    const log = readTaskLog(config, META.id, 50)!;
    const body = log.lines.join('\n');
    // detail 里的 URL userinfo 被抹掉
    assert.doesNotMatch(body, /pw@/);
    // code 里的空白被压成下划线，且每行仍以时间戳开头（没有多出半截行）
    assert.match(body, /code=BAD_CODE_INJECT/);
    for (const line of log.lines) assert.match(line, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── 降级：日志不得阻断业务任务 ───

test('日志目录不可用时 writer 为 null，任务仍能正常落终态', () => {
  withTemp((config) => {
    const taskDir = path.join(config.dataDir, '.ki-tasks');
    fs.mkdirSync(taskDir, { recursive: true });
    // 用同名**文件**占住 logs 目录位置 → mkdir 失败
    fs.writeFileSync(path.join(taskDir, 'logs'), 'occupied');

    assert.equal(createTaskLogWriter(config, META), null);

    const reporter = createTaskReporter(config, {
      id: 'log-degraded', source: 'web', operation: 'import', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', phase: 'vector' });
      reporter.finish('failed', { error: 'HTTP 429: too many requests' });
    } finally {
      reporter.stop();
    }
    // 任务台账照常
    const record = getTaskRecord(config, 'log-degraded')!;
    assert.equal(record.state, 'failed');
    assert.equal(record.error, 'Embedding 服务限流');
    // 日志确实没写出来
    assert.equal(readTaskLog(config, 'log-degraded', 10), null);
  });
});

// ─── 滚动 ───

test('单文件超 2MB 时滚动出 .log.1', () => {
  withTemp((config) => {
    const writer = createTaskLogWriter(config, META)!;
    writer.event('running', { phase: 'clone' });
    const file = taskLogPath(config, META.id);
    // 预写超额内容，模拟长任务
    fs.appendFileSync(file, `${'x'.repeat(1024)}\n`.repeat(2_100));
    writer.note('触发滚动');

    assert.ok(fs.existsSync(`${file}.1`), '应生成 .log.1');
    const log = readTaskLog(config, META.id, 10)!;
    assert.equal(log.rotated, true);
    assert.match(log.lines.join('\n'), /note 触发滚动/);
  });
});

// ─── 清理 ───

test('pruneTaskLogs 删除超过保留期的日志，保留新日志', () => {
  withTemp((config) => {
    for (const id of ['keep-me', 'drop-me']) {
      const writer = createTaskLogWriter(config, { ...META, id })!;
      writer.note('hello');
    }
    const stale = taskLogPath(config, 'drop-me');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const result = pruneTaskLogs(config);
    assert.ok(result.removed >= 1);
    assert.ok(result.bytes > 0);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(taskLogPath(config, 'keep-me')));
  });
});

test('pruneTaskLogs 按文件数上限清理最旧日志', () => {
  withTemp((config) => {
    const dir = path.join(config.dataDir, '.ki-tasks', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() - 60 * 60 * 1000;
    const HEAD = '{"v":1,"source":"web","operation":"op","scope":"s","createdAt":"2026-11-02T00:00:00.000Z"}\n';
    for (let i = 0; i < 205; i += 1) {
      const file = path.join(dir, `bulk-${String(i).padStart(3, '0')}.log`);
      fs.writeFileSync(file, HEAD);
      const at = new Date(base + i * 1000); // 序号越大越新
      fs.utimesSync(file, at, at);
    }

    const result = pruneTaskLogs(config);
    assert.ok(result.removed >= 5, `应至少删 5 个，实际 ${result.removed}`);
    const left = fs.readdirSync(dir).filter((name) => name.endsWith('.log'));
    assert.ok(left.length <= 200, `应 ≤200，实际 ${left.length}`);
    // 最旧的先删，最新的留下
    assert.equal(fs.existsSync(path.join(dir, 'bulk-000.log')), false);
    assert.equal(fs.existsSync(path.join(dir, 'bulk-204.log')), true);
  });
});

test('pruneTaskLogs 对不存在的目录不抛', () => {
  withTemp((config) => {
    assert.deepEqual(pruneTaskLogs(config), { removed: 0, bytes: 0 });
  });
});
