/**
 * `datasource list` 人类可读表格的单测。
 *
 * 锁住这些行为（防止回退到 tab 硬拼 / 中文列错位 / 时间退回 UTC ISO /
 * 非 TTY 被硬裁 / 控制字符直出终端）：
 *  1. 所有行 LAST SYNC 列起点一致（对齐）；行尾刻意不补空格，故不用"整行等宽"
 *  2. SOURCE 是唯一可伸缩列；窄终端截断路径但**标记完整保留**
 *  3. `columns = 0`（重定向/管道）不截断
 *  4. 行组装口径：托管 Git 显仓库身份、同目录标记、待删 0 与"未计算"分开
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataSourceList,
  clipMiddle,
  displayWidth,
  formatLocalMinute,
  renderDataSourceTable,
  sanitizeTerminalText,
  shortRemote,
  type DataSourceListRow,
} from '../src/lib/datasource-format.js';
import type { DataSourceLastSync, DataSourceRecord, DataSourceSchedule } from '../src/lib/datasource-types.js';
import { defaultDataSourceSchedule } from '../src/lib/datasource-schedule.js';

function syncOf(over: Partial<DataSourceLastSync> = {}): DataSourceLastSync {
  return {
    at: 1750000000000,
    durationMs: 1200,
    state: 'ok',
    params: { group: null, conflictMode: 'incremental', vector: true, chunkSize: null, chunkOverlap: null, mode: 'full' },
    result: {
      files: { scanned: 3, fullScanned: 3, changed: 3, completed: 3, unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
      vectorized: 3,
      fullTextIndexed: 3,
      groups: [],
      conflicts: [],
      failures: [],
    },
    seenRels: [],
    pendingDelete: {
      computedAt: 1750000000000,
      total: 0,
      overLimit: false,
      truncated: false,
      items: [],
      candidateSourcePaths: [],
      untouchedGroups: [],
      unableCount: 0,
      eligibleCount: 0,
      stale: false,
      staleReason: null,
      blocked: null,
    },
    ...over,
  };
}

function recordOf(over: Partial<DataSourceRecord> & { scope: string; dir: string }): DataSourceRecord {
  return {
    version: 2,
    type: 'directory',
    group: null,
    conflictMode: 'incremental',
    conflictSuffix: '_{n}',
    vector: true,
    chunkSize: null,
    chunkOverlap: null,
    createdAt: 1750000000000,
    updatedAt: 1750000000000,
    lastSync: null,
    ...over,
  };
}

const GIT_INFO = {
  repoRoot: '/tmp/repo',
  relativeRoot: 'docs',
  branch: 'main',
  remoteUrl: 'https://github.com/foo/bar.git',
  managed: true,
  remoteBranch: 'main',
};

describe('displayWidth', () => {
  it('ASCII 按 1 列、中文与全角按 2 列', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('已同步'), 6);
    assert.equal(displayWidth('部分完成'), 8);
    assert.equal(displayWidth('a已b'), 4);
  });
});

describe('sanitizeTerminalText', () => {
  it('剥掉 ESC/BEL 等控制字符与双向覆盖字符', () => {
    // OSC 整段剔除：不能只删 ESC/BEL，否则会残留可读载荷 `]0;PWNED`
    assert.equal(sanitizeTerminalText('\x1b]0;PWNED\x07/tmp/x'), '/tmp/x');
    assert.equal(sanitizeTerminalText('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(sanitizeTerminalText('a\u202Eb'), 'ab');
    assert.equal(sanitizeTerminalText('正常/中文路径'), '正常/中文路径');
  });
});

describe('shortRemote', () => {
  it('保留 host，去 .git / 占位 user / www', () => {
    assert.equal(shortRemote('https://github.com/HACK-WU/blog.git'), 'github.com/HACK-WU/blog');
    assert.equal(shortRemote('https://www.github.com/HACK-WU/blog'), 'github.com/HACK-WU/blog');
    assert.equal(shortRemote('git@github.com:HACK-WU/blog.git'), 'github.com/HACK-WU/blog');
    assert.equal(shortRemote('ssh://git@host:22/team/sub/project.git'), 'host/team/sub/project');
  });

  it('不同 host 的同名仓库不会显示成同一串', () => {
    assert.notEqual(shortRemote('https://gh.example.com/team/api'), shortRemote('https://gl.example.com/team/api'));
  });

  it('解析不出时原样返回（不吞信息）', () => {
    assert.equal(shortRemote('/local/path/repo'), '/local/path/repo');
  });
});

describe('formatLocalMinute', () => {
  it('形如 YYYY-MM-DD HH:mm，不含 ISO 的 T/Z 与毫秒', () => {
    const text = formatLocalMinute(1750000000000);
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(!text.includes('T'));
    assert.ok(!text.includes('Z'));
  });

  it('非有限值不渲染 NaN', () => {
    assert.equal(formatLocalMinute(Number.POSITIVE_INFINITY), '—');
    assert.equal(formatLocalMinute(Number.NaN), '—');
  });
});

describe('clipMiddle', () => {
  it('不超宽时原样返回', () => {
    assert.equal(clipMiddle('/a/b', 20), '/a/b');
  });

  it('超宽时中间省略且保留尾部', () => {
    const out = clipMiddle('/root/very/long/nested/path/file.md', 20);
    assert.ok(displayWidth(out) <= 20, `宽度应 <= 20，实际 ${displayWidth(out)}: ${out}`);
    assert.ok(out.includes('…'));
    assert.ok(out.endsWith('file.md'), `尾部应保留，实际: ${out}`);
  });

  it('宽度不足时退化为单字符省略号', () => {
    assert.equal(clipMiddle('/root/abc', 1), '…');
  });

  it('中文路径按显示宽度截断（不被字符数误导）', () => {
    // 12 列按字符数算能放下 12 个汉字（宽 24），按显示宽度只能放 6 个——后者才是终端事实
    const out = clipMiddle('/根目录/中文子目录/文件.md', 12);
    assert.ok(displayWidth(out) <= 12, `宽度应 <= 12，实际 ${displayWidth(out)}: ${out}`);
    assert.ok(out.includes('…'));
    assert.ok(out.endsWith('.md'), `尾部应保留扩展名，实际: ${out}`);
    assert.ok(Array.from(out).length < 12, `不应按字符数截断，实际字符数 ${Array.from(out).length}`);
  });
});

describe('buildDataSourceList', () => {
  it('托管 Git 显示 仓库身份 › 子目录 @commit，且不算「同目录」', () => {
    const model = buildDataSourceList([
      { scope: 'g1', record: recordOf({ scope: 'g1', dir: '/tmp/a', type: 'git', git: GIT_INFO, lastSync: syncOf({ git: { commit: 'c1', runCommit: 'c1', shortCommit: '8032fdb', subject: 's', authorTime: 1, changedCount: 1, fullScanned: 1, untrackedMarkdown: 0, update: 'up-to-date', fetch: 'ok' } }) }) },
      { scope: 'g2', record: recordOf({ scope: 'g2', dir: '/tmp/a', type: 'git', git: { ...GIT_INFO, managed: true }, lastSync: syncOf({ git: { commit: 'c1', runCommit: 'c1', shortCommit: '8032fdb', subject: 's', authorTime: 1, changedCount: 1, fullScanned: 1, untrackedMarkdown: 0, update: 'up-to-date', fetch: 'ok' } }) }) },
    ]);
    assert.equal(model.rows[0].source, 'github.com/foo/bar › docs @8032fdb');
    assert.equal(model.rows[0].sourceNote, undefined);
    assert.equal(model.sharedDirs.length, 0);
  });

  it('多个非托管 scope 登记同一目录：逐行标记 + 汇总', () => {
    const model = buildDataSourceList([
      { scope: 'a', record: recordOf({ scope: 'a', dir: '/tmp/shared' }) },
      { scope: 'b', record: recordOf({ scope: 'b', dir: '/tmp/shared' }) },
      { scope: 'c', record: recordOf({ scope: 'c', dir: '/tmp/other' }) },
    ]);
    assert.deepEqual(model.rows.map((r) => r.sourceNote), ['[同目录]', '[同目录]', undefined]);
    assert.deepEqual(model.sharedDirs, [{ dir: '/tmp/shared', scopes: ['a', 'b'] }]);
  });

  it('待删区分 0 / 有候选 / 未计算', () => {
    const withTotal = syncOf({ pendingDelete: { ...syncOf().pendingDelete, total: 12 } });
    const stale = syncOf({ pendingDelete: { ...syncOf().pendingDelete, total: 0, stale: true } });
    const blocked = syncOf({ pendingDelete: { ...syncOf().pendingDelete, total: 0, blocked: 'GATE_SCALE' } });
    const model = buildDataSourceList([
      { scope: 'has', record: recordOf({ scope: 'has', dir: '/tmp/1', lastSync: withTotal }) },
      { scope: 'stale', record: recordOf({ scope: 'stale', dir: '/tmp/2', lastSync: stale }) },
      { scope: 'blocked', record: recordOf({ scope: 'blocked', dir: '/tmp/3', lastSync: blocked }) },
      { scope: 'clean', record: recordOf({ scope: 'clean', dir: '/tmp/4', lastSync: syncOf() }) },
    ]);
    assert.deepEqual(model.rows.map((r) => r.pending), ['12', '未算', '未算', '-']);
  });

  it('从未同步：时间列写明、状态与待删占位', () => {
    const model = buildDataSourceList([{ scope: 'n', record: recordOf({ scope: 'n', dir: '/tmp/n' }) }]);
    assert.equal(model.rows[0].lastSync, '从未同步');
    assert.equal(model.rows[0].state, '-');
    assert.equal(model.rows[0].pending, '-');
  });

  it('只收集显式落点 Group', () => {
    const model = buildDataSourceList([
      { scope: 'x', record: recordOf({ scope: 'x', dir: '/tmp/x', group: 'wiki/API' }) },
      { scope: 'y', record: recordOf({ scope: 'y', dir: '/tmp/y' }) },
    ]);
    assert.deepEqual(model.explicitGroups, [{ scope: 'x', group: 'wiki/API' }]);
  });

  it('定时计划：只收启用中的，关闭/缺字段都不进脚注（默认用户输出不变）', () => {
    const now = new Date(2026, 9, 29, 10, 0).getTime();
    const withSchedule = (scope: string, schedule: Partial<DataSourceSchedule> | undefined) => ({
      scope,
      record: recordOf({
        scope,
        dir: `/tmp/${scope}`,
        ...(schedule === undefined ? {} : { schedule: { ...defaultDataSourceSchedule(), ...schedule } }),
      }),
    });
    const off = buildDataSourceList([withSchedule('off', { enabled: false })], now);
    assert.deepEqual(off.schedules, []);
    const legacy = buildDataSourceList([{ scope: 'old', record: recordOf({ scope: 'old', dir: '/tmp/old' }) }], now);
    assert.deepEqual(legacy.schedules, [], '缺 schedule 字段（旧记录/旧夹具）不得抛错');

    const model = buildDataSourceList([
      // 正常保存过的计划都带启用锚点（无锚点的旧记录见 datasource-schedule 的「待补跑」用例）
      withSchedule('daily-x', { enabled: true, mode: 'interval', intervalValue: 2, intervalUnit: 'hour', enabledAt: now }),
      withSchedule('off', { enabled: false }),
      withSchedule('sick', { enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', enabledAt: now, consecutiveFailures: 3 }),
    ], now);
    assert.deepEqual(model.schedules, [
      { scope: 'daily-x', text: '每2小时 · 下次 12:00', warn: false },
      { scope: 'sick', text: '每30分钟 · 下次 10:30 · 连续失败 3 次', warn: true },
    ]);
  });
});

describe('renderDataSourceTable', () => {
  const ROWS: DataSourceListRow[] = [
    { scope: 'alpha', type: 'dir', source: '/root/learning/langchain', sourceNote: '[同目录]', lastSync: '2026-10-27 11:14', state: '已同步', pending: '-' },
    { scope: 'blog-es', type: 'git', source: 'github.com/HACK-WU/blog › Elasticsearch @8032fdb', lastSync: '2026-10-27 11:14', state: '部分完成', pending: '12' },
    { scope: 'never', type: 'dir', source: '/root/very/long/nested/path/for/clipping', lastSync: '从未同步', state: '-', pending: '-' },
  ];

  /** 数据行在 lines 中的位置：标题 / sep / header / sep 之后 */
  const dataLinesOf = (lines: string[]): string[] => lines.slice(4, 4 + ROWS.length);

  /**
   * 每个数据行里 LAST SYNC 值的起始显示列。
   * 行尾刻意不补空格，所以不能用"整行等宽"断言；列起点一致才是对齐的本质。
   */
  const lastSyncOffsets = (lines: string[]): number[] => dataLinesOf(lines).map((line, i) => {
    const idx = line.indexOf(ROWS[i].lastSync);
    assert.ok(idx > 0, `应能在行内找到 LAST SYNC 值: ${line}`);
    return displayWidth(line.slice(0, idx));
  });

  it('有表头、有分隔线、无制表符（不再用 tab 拼接）', () => {
    const text = renderDataSourceTable(ROWS, 120).join('\n');
    for (const header of ['SCOPE', 'TYPE', 'SOURCE', 'LAST SYNC', 'STATE', 'PENDING']) assert.ok(text.includes(header));
    assert.ok(text.includes('─'));
    assert.ok(!text.includes('\t'), '输出不应包含制表符');
  });

  it('LAST SYNC 列起点对齐（中文状态列不错位）', () => {
    const offsets = lastSyncOffsets(renderDataSourceTable(ROWS, 120));
    assert.ok(offsets.every((o) => o === offsets[0]), `列起点不一致: ${JSON.stringify(offsets)}`);
  });

  it('columns=0（重定向/管道）不截断任何路径', () => {
    const lines = renderDataSourceTable(ROWS, 0);
    const text = lines.join('\n');
    assert.ok(text.includes('/root/learning/langchain'), '非 TTY 不应截断路径');
    assert.ok(text.includes('github.com/HACK-WU/blog › Elasticsearch @8032fdb'));
  });

  it('窄终端截断路径但标记完整保留，且列起点仍对齐', () => {
    const narrow = renderDataSourceTable(ROWS, 80);
    const offsets = lastSyncOffsets(narrow);
    assert.ok(offsets.every((o) => o === offsets[0]), `窄终端列起点不一致: ${JSON.stringify(offsets)}`);
    for (const line of narrow) {
      assert.ok(displayWidth(line) <= 80, `窄终端不应超过 80 列（${displayWidth(line)}）: ${line}`);
    }
    const alphaLine = dataLinesOf(narrow).find((line) => line.includes('alpha'))!;
    assert.ok(alphaLine.includes('[同目录]'), `标记应完整保留: ${alphaLine}`);
    assert.ok(alphaLine.includes('…'), `路径应被截断: ${alphaLine}`);
  });

  it('超长 scope 被截断，不挤压 SOURCE 到不可读', () => {
    const rows: DataSourceListRow[] = [{
      scope: 'x'.repeat(56),
      type: 'dir',
      source: '/root/learning/langchain',
      lastSync: '2026-10-27 11:14',
      state: '已同步',
      pending: '-',
    }];
    const line = renderDataSourceTable(rows, 120)[4];
    assert.ok(line.includes('…'), `超长 scope 应被截断: ${line}`);
    assert.ok(line.includes('/root/learning/langchain'), `SOURCE 不应被压没: ${line}`);
    assert.ok(displayWidth(line) <= 120, `不应超过 120 列: ${displayWidth(line)}`);
  });

  it('控制字符不会进入输出', () => {
    const rows: DataSourceListRow[] = [{
      scope: 'a', type: 'dir', source: '/tmp/\x1b]0;PWNED\x07dir', lastSync: '2026-10-27 11:14', state: '已同步', pending: '-',
    }];
    const text = renderDataSourceTable(rows, 120).join('\n');
    assert.ok(!/\x1b/.test(text), '不应含 ESC');
    assert.ok(!/\x07/.test(text), '不应含 BEL');
  });
});
