import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskReporter, getTaskRecord } from '../src/lib/task-registry.ts';
import {
  displayWidth,
  executeTaskLog,
  normalizeTaskLogArgv,
  renderList,
  renderTask,
  toJsonPayload,
} from '../src/lib/task-log-view.ts';

function withTempConfig<T>(run: (config: { dataDir: string }) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-log-'));
  try {
    return run({ dataDir: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 走一次真实 reporter 落盘，拿回被 `safeErrorSummary` 压缩后的 error */
function summaryOf(errorText: string): string | undefined {
  return withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'summary-probe', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.finish('failed', { error: errorText });
      return getTaskRecord(config, 'summary-probe')?.error;
    } finally {
      reporter.stop();
    }
  });
}

// ─── S-01：Git 失败必须被识别为 Git 类别，且不得串台成 Embedding 故障 ───

test('Git 超时不得被误报为 Embedding 超时', () => {
  assert.equal(summaryOf('clone 超时（10 分钟）'), 'Git 克隆超时');
});

test('Git 网络失败不得被误报为 Embedding 服务暂不可用', () => {
  const dns = summaryOf("无法连接远端（fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com）");
  assert.equal(dns, '无法连接远端仓库');
  const unreachable = summaryOf('无法连接远端（fatal: unable to access: network is unreachable）');
  assert.equal(unreachable, '无法连接远端仓库');
  assert.notEqual(unreachable, 'Embedding 服务暂不可用');
});

test('Git 认证失败被识别（不是兜底句）', () => {
  const text = '认证失败：请在运行 daemon 的环境中配置 SSH agent 或 credential helper（Permission denied (publickey)）';
  assert.equal(summaryOf(text), 'Git 仓库认证失败');
});

test('远端分支不存在先于仓库不存在判定', () => {
  assert.equal(summaryOf('远端分支不存在（fatal: remote branch dev not found）'), '远端分支不存在');
  assert.equal(summaryOf("仓库不存在或当前凭据无权访问（fatal: repository 'x' not found）"), '仓库不存在或无权访问');
});

test('其余 Git 失败码各有独立类别', () => {
  assert.equal(summaryOf('clone 失败：fatal: unable to write to object'), 'Git 克隆失败');
  assert.equal(summaryOf('托管目录已存在：[path]'), '托管目录已存在');
  assert.equal(summaryOf('仓库（或子目录）中没有可导入文件（md, mdx）：.'), '没有可导入的文档');
  assert.equal(summaryOf('不支持明文 http:// / git://，请使用 https 或 ssh'), 'Git 地址或协议不受支持');
  // GIT_SCHEME_UNSUPPORTED 的 file:// 分支用的是另一句文案，需单独覆盖
  assert.equal(summaryOf('本地目录请使用 --source 登记，不支持 file://'), 'Git 地址或协议不受支持');
  // INVALID_BRANCH 的两条文案（校验失败 / --branch 指向 tag）
  assert.equal(summaryOf('分支名非法：fatal: boom'), 'Git 分支不可用');
  assert.equal(summaryOf('--branch 只支持远端分支（dev 克隆后为 detached HEAD，可能是 tag/commit）'), 'Git 分支不可用');
});

test('Embedding 既有分类不被 Git 分支抢走', () => {
  assert.equal(summaryOf('embedding unavailable'), 'Embedding 服务暂不可用');
  assert.equal(summaryOf('HTTP 429: too many requests'), 'Embedding 服务限流');
  assert.equal(summaryOf('ETIMEDOUT while calling provider'), 'Embedding 服务请求超时');
});

// ─── S-03：ki log 的三态 + scope 校验 ───

test('按任务 ID 查到台账信息（含 errorCode）', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'task-ok', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
      reporter.finish('failed', { errorCode: 'GIT_NETWORK_FAILED', error: '无法连接远端（Could not resolve host）' });
    } finally {
      reporter.stop();
    }
    const { exitCode, result } = executeTaskLog(config, { taskId: 'task-ok' });
    assert.equal(exitCode, 0);
    assert.equal(result.kind, 'task');
    if (result.kind !== 'task') return;
    assert.equal(result.task.state, 'failed');
    assert.equal(result.task.stateLabel, '失败');
    assert.equal(result.task.errorCode, 'GIT_NETWORK_FAILED');
    assert.equal(result.task.error, '无法连接远端仓库');
    // 「卡在哪一步」是排障第一问，必须带出失败阶段
    assert.equal(result.task.phase, 'clone');
    assert.ok(result.task.durationMs !== undefined && result.task.durationMs >= 0);
    const text = renderTask(result.task, result.log, { expired: result.expired });
    assert.match(text, /操作\s+datasource-add-remote/);
    assert.match(text, /阶段\s+clone/);
    assert.match(text, /错误码\s+GIT_NETWORK_FAILED/);
    // S-02 之后：reporter 自动落日志，正常任务应能直接看到正文与路径
    assert.ok(result.log, '应读到运行日志');
    assert.match(text, /日志\s+\S+\.log/);
    assert.match(text, /state running phase=clone/);
  });
});

test('scope 与任务不符时报错而不是静默查不到', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'task-scope', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.finish('failed', { error: 'clone 超时（10 分钟）' });
    } finally {
      reporter.stop();
    }
    const mismatch = executeTaskLog(config, { taskId: 'task-scope', scope: 'docs' });
    assert.equal(mismatch.exitCode, 2);
    assert.equal(mismatch.result.kind, 'invalid');
    if (mismatch.result.kind === 'invalid') assert.match(mismatch.result.message, /属于 scope ai-docs/);

    const match = executeTaskLog(config, { taskId: 'task-scope', scope: 'ai-docs' });
    assert.equal(match.exitCode, 0);
  });
});

test('非法任务 ID 与不存在的任务分别给出退出码', () => {
  withTempConfig((config) => {
    const invalid = executeTaskLog(config, { taskId: 'bad id!' });
    assert.equal(invalid.exitCode, 2);
    assert.equal(invalid.result.kind, 'invalid');

    const missing = executeTaskLog(config, { taskId: 'no-such-task' });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.result.kind, 'not-found');
    // fail-loud：必须给出路，不能只报"未找到"
    if (missing.result.kind === 'not-found') assert.ok(missing.result.next.length >= 3);
  });
});

test('列表模式：scope 过滤与 --failed 过滤，且过滤先于裁剪', () => {
  withTempConfig((config) => {
    const ok = createTaskReporter(config, { id: 'a-ok', source: 'web', operation: 'datasource-sync', scope: 'ai-docs' });
    ok.finish('succeeded');
    ok.stop();
    const bad = createTaskReporter(config, { id: 'b-bad', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs' });
    bad.finish('failed', { errorCode: 'CLONE_FAILED', error: 'clone 失败：fatal: boom' });
    bad.stop();
    const other = createTaskReporter(config, { id: 'c-other', source: 'web', operation: 'import', scope: 'docs' });
    other.finish('failed', { error: 'HTTP 429: too many requests' });
    other.stop();

    const all = executeTaskLog(config, { limit: 10 });
    assert.equal(all.result.kind, 'list');
    if (all.result.kind === 'list') assert.equal(all.result.rows.length, 3);

    const scoped = executeTaskLog(config, { scope: 'ai-docs' });
    if (scoped.result.kind === 'list') assert.equal(scoped.result.rows.length, 2);

    // limit=1 但只有 1 条失败 → 仍应返回那条失败（不能先裁剪成 1 条成功再过滤）
    const failed = executeTaskLog(config, { scope: 'ai-docs', failed: true, limit: 1 });
    assert.equal(failed.result.kind, 'list');
    if (failed.result.kind === 'list') {
      assert.equal(failed.result.rows.length, 1);
      assert.equal(failed.result.rows[0].state, 'failed');
      assert.equal(failed.result.rows[0].errorCode, 'CLONE_FAILED');
    }
  });
});

test('没有任何任务时列表给出空态文案', () => {
  withTempConfig((config) => {
    const { exitCode, result } = executeTaskLog(config, {});
    assert.equal(exitCode, 0);
    assert.equal(result.kind, 'list');
    if (result.kind !== 'list') return;
    assert.equal(result.rows.length, 0);
    assert.match(renderList(result), /当前没有任务记录/);
  });
});

// ─── 渲染对齐（中文占 2 列；用 String.length 补空格会让键值对与表格错位）───

/** 取某显示列位置的字符（用于断言列边界） */
function charAtDisplay(line: string, col: number): string | undefined {
  let width = 0;
  for (const ch of line) {
    if (width === col) return ch;
    width += displayWidth(ch);
    if (width > col) return '<跨列宽字符>';
  }
  return undefined;
}

test('displayWidth 把 CJK 按 2 列计', () => {
  assert.equal(displayWidth('操作'), 4);
  assert.equal(displayWidth('知识库'), 6);
  assert.equal(displayWidth('错误码'), 6);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(''), 0);
});

test('单任务输出所有键值行的值统一从第 13 列起始', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'align', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now() });
      reporter.finish('failed', { errorCode: 'GIT_NETWORK_FAILED', error: '无法连接远端仓库' });
    } finally {
      reporter.stop();
    }
    const { result } = executeTaskLog(config, { taskId: 'align' });
    assert.equal(result.kind, 'task');
    if (result.kind !== 'task') return;
    const kvLines = renderTask(result.task, null)
      .split('\n')
      .filter((line) => line.startsWith('  ') && !line.startsWith('  | '));
    assert.ok(kvLines.length >= 8, `键值行数量异常：${kvLines.length}`);
    for (const line of kvLines) {
      const char = charAtDisplay(line, 12);
      assert.ok(char !== undefined && char !== ' ', `列未对齐：${JSON.stringify(line)}`);
    }
  });
});

test('列表表头与数据行的列边界一致', () => {
  withTempConfig((config) => {
    const first = createTaskReporter(config, {
      id: 'list-a', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    first.finish('failed', { errorCode: 'CLONE_FAILED', error: 'clone 失败：x' });
    first.stop();
    const { result } = executeTaskLog(config, {});
    assert.equal(result.kind, 'list');
    if (result.kind !== 'list') return;
    const lines = renderList(result).split('\n');
    const header = lines.find((line) => line.startsWith('任务ID'));
    assert.ok(header, '缺少表头');
    const row = lines.find((line) => line.startsWith('list-a'));
    assert.ok(row, '缺少数据行');
    // 六列起点：任务ID 10 / 操作 24 / 状态 10 / 结束时间 21 / 错误码 18 / 日志 8
    for (const boundary of [10, 34, 44, 65, 83, 91]) {
      for (const line of [header!, row!]) {
        const char = charAtDisplay(line, boundary);
        assert.ok(char !== undefined && char !== ' ', `第 ${boundary} 列错位：${JSON.stringify(line)}`);
      }
    }
    // 「日志」列取值
    assert.match(header!, /日志/);
    assert.match(row!, /有|已滚动|无/);
  });
});

test('台账过期但日志仍在：过期降级仍可读（exit 0）', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'expire-me', source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
      reporter.finish('failed', {
        errorCode: 'GIT_NETWORK_FAILED',
        error: '无法连接远端（Could not resolve host: x.invalid）',
      });
    } finally {
      reporter.stop();
    }
    // 模拟台账过期清理：只删 JSON，日志留着
    fs.rmSync(path.join(config.dataDir, '.ki-tasks', 'expire-me.json'));

    const { exitCode, result } = executeTaskLog(config, { taskId: 'expire-me' });
    assert.equal(exitCode, 0, '台账过期不应判「找不到」');
    assert.equal(result.kind, 'task');
    if (result.kind !== 'task') return;
    assert.equal(result.expired, true);
    assert.equal(result.metaUnreadable, false);
    assert.equal(result.task.scope, 'ai-docs');
    assert.ok(result.log?.lines.some((line) => /Could not resolve host/.test(line)));
    const text = renderTask(result.task, result.log, { expired: true });
    assert.match(text, /台账已过期/);
    assert.match(text, /Could not resolve host/);
  });
});

test('台账过期且日志头损坏：不崩，标注元信息不可读', () => {
  withTempConfig((config) => {
    const logsDir = path.join(config.dataDir, '.ki-tasks', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // 头行不是 JSON ⇒ readTaskLog 的 head 为 null，而台账也不存在
    fs.writeFileSync(
      path.join(logsDir, 'broken-head.log'),
      'not-json\n2026-11-02T00:00:00.000Z INFO  state queued\n',
    );
    const { exitCode, result } = executeTaskLog(config, { taskId: 'broken-head' });
    assert.equal(exitCode, 0, '日志存在就不该判找不到');
    assert.equal(result.kind, 'task');
    if (result.kind !== 'task') return;
    assert.equal(result.expired, true);
    assert.equal(result.metaUnreadable, true);
    assert.equal(result.task.id, 'broken-head');
    assert.equal(result.task.operation, 'unknown');
    const text = renderTask(result.task, result.log, { expired: true, metaUnreadable: true });
    assert.match(text, /台账已过期/);
    assert.match(text, /日志头行损坏/);
  });
});

test('--tail 0 只给元信息与总行数，不输出正文', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'tail-zero', source: 'web', operation: 'import', scope: 'ai-docs',
    });
    try {
      reporter.update({ state: 'running', phase: 'vector' });
      reporter.finish('failed', { error: 'HTTP 429: too many requests' });
    } finally {
      reporter.stop();
    }
    const { result } = executeTaskLog(config, { taskId: 'tail-zero', tail: 0 });
    assert.equal(result.kind, 'task');
    if (result.kind !== 'task') return;
    assert.equal(result.log?.lines.length, 0);
    const text = renderTask(result.task, result.log, {});
    assert.match(text, /--tail 0：不显示正文/);
    assert.doesNotMatch(text, /state running/);
  });
});

test('-id 归一化为 --id，且不把 -i / -d 静默当别名', () => {
  assert.deepEqual(
    normalizeTaskLogArgv(['--scope', 'ai-docs', '-id', 'abc']),
    ['--scope', 'ai-docs', '--id', 'abc'],
  );
  assert.deepEqual(normalizeTaskLogArgv(['-i', '-d']), ['-i', '-d']);
  assert.deepEqual(normalizeTaskLogArgv(['--id', 'abc']), ['--id', 'abc']);
});

test('--json 载荷：ok / exitCode 跟随结果类型，且平铺结果字段', () => {
  withTempConfig((config) => {
    const found = executeTaskLog(config, { taskId: 'no-such' });
    const payload = toJsonPayload(found.result, found.exitCode);
    assert.equal(payload.ok, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.kind, 'not-found');
    assert.ok(Array.isArray(payload.next));

    const list = executeTaskLog(config, {});
    const listPayload = toJsonPayload(list.result, list.exitCode);
    assert.equal(listPayload.ok, true);
    assert.equal(listPayload.exitCode, 0);
    assert.ok(Array.isArray(listPayload.rows));
  });
});

test('操作者：台账快照、日志头与 ki log 输出', () => {
  withTempConfig((config) => {
    const reporter = createTaskReporter(config, {
      id: 'task-operator',
      source: 'web',
      operator: { type: 'user', label: 'alice', userId: 'u-1' },
      operation: 'import',
      scope: 'demo',
    });
    try {
      reporter.update({ state: 'running', startedAt: Date.now() });
      const record = getTaskRecord(config, 'task-operator');
      assert.equal(record?.operator?.label, 'alice');
      assert.equal(record?.operator?.userId, 'u-1');

      const { result } = executeTaskLog(config, { taskId: 'task-operator' });
      assert.equal(result.kind, 'task');
      if (result.kind === 'task') {
        assert.equal(result.task.operator, 'alice');
        const text = renderTask(result.task, null);
        assert.match(text, /操作者\s+alice/);
      }
    } finally {
      reporter.stop();
    }
  });
});
