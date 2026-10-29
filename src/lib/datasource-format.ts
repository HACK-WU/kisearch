/**
 * `datasource list` 的人类可读表格（对齐规范同 `ki scope list`）。
 *
 * 抽成纯函数放 lib：`src/datasource.ts` 顶层会 parse argv，测试无法直接 import。
 */

import { scheduleListSummary } from './datasource-schedule.js';
import type { DataSourceRecord, DataSourceSyncState } from './datasource-types.js';

export interface DataSourceListEntry {
  scope: string;
  record: DataSourceRecord;
}

export interface DataSourceListRow {
  scope: string;
  type: string;
  /** 源：托管 Git 用 `host/owner/repo › 子目录`，其余用本地路径；可能带 ` @commit` */
  source: string;
  /** SOURCE 列尾部标记（如 `[同目录]`）：恒完整显示，截断只作用于 source 本身 */
  sourceNote?: string;
  lastSync: string;
  state: string;
  pending: string;
}

export interface DataSourceListModel {
  rows: DataSourceListRow[];
  /** 多个 scope 登记同一本地目录（托管 clone 的内部路径不计入） */
  sharedDirs: { dir: string; scopes: string[] }[];
  /** 显式指定落点 Group 的数据源（null = 按顶层子目录自动，不在此列） */
  explicitGroups: { scope: string; group: string }[];
  /**
   * 已启用定时计划的数据源（只读展示）。
   * ★ 刻意不进表格：定时是"附加状态"，多一列会把 6 列的窄终端挤到溢出；
   *   放在表格脚注里能写全「模式 + 下次 + 连续失败」，也不动既有的列对齐断言。
   */
  schedules: { scope: string; text: string; warn: boolean }[];
}

export const SYNC_STATE_LABEL: Record<DataSourceSyncState, string> = {
  ok: '已同步',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * 剥掉终端控制字符与双向覆盖字符。
 * 两个理由：① 目录名/Group 名可含 ESC 序列，直出会改写窗口标题（OSC 注入）；
 * ② 不可见字节会被 charWidth 按 1 列计，让整行对齐偏移。
 */
export function sanitizeTerminalText(text: string): string {
  return text
    // OSC：ESC ] ... BEL / ST —— 整段剔除，否则剥离 ESC 后会残留可读载荷（如 `]0;PWNED`）
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g, '')
    // CSI：ESC [ 参数 终止符
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其余 C0/C1 控制字符与双向覆盖字符
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** 全角/中文占 2 列——按字符数 pad 会让中文状态列错位 */
export function charWidth(ch: string): number {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

export function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 中间省略：路径尾部（仓库名/文件名/子目录）比前缀更有信息量 */
export function clipMiddle(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  if (max <= 1) return '…';
  const chars = Array.from(text);
  let tail = '';
  let tailWidth = 0;
  const tailBudget = Math.min(Math.floor(max * 0.45), 24);
  for (let i = chars.length - 1; i >= 0 && tailWidth < tailBudget; i -= 1) {
    tail = chars[i] + tail;
    tailWidth += charWidth(chars[i]);
  }
  let head = '';
  let headWidth = 0;
  const headBudget = max - 1 - tailWidth;
  for (let i = 0; i < chars.length && headWidth < headBudget; i += 1) {
    const w = charWidth(chars[i]);
    if (headWidth + w > headBudget) break;
    head += chars[i];
    headWidth += w;
  }
  return `${head}…${tail}`;
}

/** 本地时区 `YYYY-MM-DD HH:mm`；非有限值（损坏记录）返回 `—` 而不是 `NaN` */
export function formatLocalMinute(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 远端 URL → `host/owner/repo`（去 .git / 占位 user / www）；解析不出时原样返回 */
export function shortRemote(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const scp = cleaned.match(/^[^\s@/]+@([^\s:/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(cleaned);
    const host = parsed.hostname.replace(/^www\./i, '');
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    return pathname ? `${host}/${pathname}` : host;
  } catch {
    return cleaned;
  }
}

/**
 * 记录 → 表格行（含同目录标记、仓库身份、待删口径）+ 启用中的定时计划脚注。
 * `now` 可注入，便于测试「待补跑 / 同日 / 跨日」三种展示而不依赖真实时钟。
 */
export function buildDataSourceList(entries: DataSourceListEntry[], now = Date.now()): DataSourceListModel {
  const scopeByDir = new Map<string, string[]>();
  for (const { scope, record } of entries) {
    if (record.git?.managed) continue;
    const list = scopeByDir.get(record.dir);
    if (list) list.push(scope);
    else scopeByDir.set(record.dir, [scope]);
  }

  const rows = entries.map(({ scope, record }): DataSourceListRow => {
    const sync = record.lastSync;
    const git = record.git;
    let source = record.dir;
    if (git?.managed && git.remoteUrl) {
      const repo = shortRemote(git.remoteUrl);
      source = git.relativeRoot ? `${repo} › ${git.relativeRoot}` : repo;
    }
    if (sync?.git?.shortCommit) source += ` @${sync.git.shortCommit}`;
    const isSharedDir = !git?.managed && (scopeByDir.get(record.dir)?.length ?? 0) > 1;
    const pending = sync?.pendingDelete;
    return {
      scope,
      type: record.type === 'git' ? 'git' : 'dir',
      source,
      ...(isSharedDir ? { sourceNote: '[同目录]' } : {}),
      lastSync: sync ? formatLocalMinute(sync.at) : '从未同步',
      state: sync ? (SYNC_STATE_LABEL[sync.state] ?? sync.state) : '-',
      // 0 与「未计算」是两件事：stale（未重算）/ blocked（被闸门拦）不能读成"没有待删"
      pending: !pending ? '-' : pending.total > 0 ? String(pending.total) : pending.stale || pending.blocked ? '未算' : '-',
    };
  });

  return {
    rows,
    sharedDirs: [...scopeByDir.entries()]
      .filter(([, scopes]) => scopes.length > 1)
      .map(([dir, scopes]) => ({ dir, scopes })),
    explicitGroups: entries
      .filter(({ record }) => record.group !== null)
      .map(({ scope, record }) => ({ scope, group: record.group as string })),
    // 旧记录/旧测试夹具可能没有 schedule 字段：缺省视为未配置，不进脚注
    schedules: entries
      .map(({ scope, record }) => ({
        scope,
        summary: scheduleListSummary({ schedule: record.schedule, lastSyncAt: record.lastSync?.at ?? null, now }),
      }))
      .filter(({ summary }) => summary.enabled)
      .map(({ scope, summary }) => ({ scope, text: summary.text, warn: summary.warn })),
  };
}

const HEADERS = ['SCOPE', 'TYPE', 'SOURCE', 'LAST SYNC', 'STATE', 'PENDING'] as const;
const SOURCE_INDEX = 2;
const INDENT = '  ';
const GAP = 2;
/** SOURCE 列里**路径部分**的最小宽度（标记另计，恒保留） */
const MIN_SOURCE_WIDTH = 16;
/** SCOPE 无长度上限（字符集受控但长度不限），超长会把整表 SOURCE 压没 */
const MAX_SCOPE_WIDTH = 28;

/**
 * 渲染为可直接逐行 console.log 的文本行。
 *
 * `columns` = 终端宽度；**0 或非正数表示不限制**（重定向/管道：没有"屏幕宽度"这回事，
 * 按 120 硬裁会把路径截断成不可读的一小段）。
 */
export function renderDataSourceTable(rows: DataSourceListRow[], columns: number): string[] {
  const clean = sanitizeTerminalText;
  const noteOf = (row: DataSourceListRow): string => (row.sourceNote ? ` ${clean(row.sourceNote)}` : '');
  const pathOf = (row: DataSourceListRow): string => clean(row.source);
  const cellsOf = (row: DataSourceListRow): string[] => [
    clean(row.scope), clean(row.type), pathOf(row) + noteOf(row), clean(row.lastSync), clean(row.state), clean(row.pending),
  ];

  const widths: number[] = HEADERS.map((h) => displayWidth(h));
  for (const row of rows) {
    cellsOf(row).forEach((cell, i) => {
      widths[i] = Math.max(widths[i], displayWidth(cell));
    });
  }
  widths[0] = Math.min(widths[0], MAX_SCOPE_WIDTH);

  const maxNoteWidth = rows.reduce((max, row) => Math.max(max, displayWidth(noteOf(row))), 0);
  const otherWidth = widths.reduce((sum, w, i) => (i === SOURCE_INDEX ? sum : sum + w), 0);
  const available = columns > 0
    ? Math.max(MIN_SOURCE_WIDTH + maxNoteWidth, columns - INDENT.length - otherWidth - GAP * (widths.length - 1))
    : Number.MAX_SAFE_INTEGER;
  widths[SOURCE_INDEX] = Math.min(widths[SOURCE_INDEX], available);

  const sep = '─'.repeat(INDENT.length + widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1));

  const headerLine = INDENT + HEADERS
    .map((h, i) => (i === HEADERS.length - 1 ? h : padDisplay(h, widths[i]) + ' '.repeat(GAP)))
    .join('');

  const dataLines = rows.map((row) => {
    const note = noteOf(row);
    const pathWidth = Math.max(1, widths[SOURCE_INDEX] - displayWidth(note));
    const sourceCell = padDisplay(clipMiddle(pathOf(row), pathWidth) + note, widths[SOURCE_INDEX]);
    return INDENT
      + padDisplay(clipMiddle(clean(row.scope), widths[0]), widths[0]) + ' '.repeat(GAP)
      + padDisplay(clean(row.type), widths[1]) + ' '.repeat(GAP)
      + sourceCell + ' '.repeat(GAP)
      + padDisplay(clean(row.lastSync), widths[3]) + ' '.repeat(GAP)
      + padDisplay(clean(row.state), widths[4]) + ' '.repeat(GAP)
      + clean(row.pending);
  });

  return [
    `数据源（${rows.length} 个）`,
    sep,
    headerLine,
    sep,
    ...dataLines,
    sep,
  ];
}
