/**
 * task-log.ts —— 任务运行日志落盘（REQ 2026-11-02 任务诊断日志 · S-02）
 *
 * 落点：`{dataDir}/.ki-tasks/logs/<taskId>.log`（与任务台账**同父目录但独立子目录**）
 *
 * 为什么独立文件、不进 task JSON：
 *   task JSON 有 32KB 预算（`MAX_TASK_FILE_BYTES`），超限时 `readRecordFile` 直接返回 null
 *   ⇒ 任务会从列表「静默消失」。日志体积不可控，绝不能塞进去。
 *
 * 为什么独立 TTL（两者现在同为 7 天，但清理机制不同，必须各自管）：
 *   1. 台账按终态时间**惰性**清理，且只有被读取时才触发；日志按文件 mtime 清理。
 *   2. 日志另有 50MB 总量硬上限与单文件滚动，可能**先于**保留期被挤掉 ——
 *      那时台账还在，`ki log` 只是没有正文可读。
 *   3. 保持独立后，两个保留期将来可以各自调整而不互相牵连。
 *
 * 铁律：
 *   1. 任何 IO / 权限 / 磁盘错误**都不得向上抛** —— 日志问题不能把业务任务拖下水
 *      （所有入口 catch 后降级为 no-op，30s 节流告警一次）。
 *   2. 落盘前必须脱敏（Bearer / token= / api_key= / access_token / URL userinfo）；
 *      绝对路径**保留** —— 它是排障第一定位信息，且文件是 0600 本地文件。
 *   3. 心跳不产生任何 IO（不写行、不 stat、不清理）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KiConfig } from './config.js';

/** 单文件达此大小滚动到 `.log.1`（只留 1 段旧档） */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** 保留期：与 `TASK_TTL_MS` 同为 7 天，但清理机制独立（见文件头） */
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 文件数上限（数量上限，**不是**容量承诺） */
const MAX_LOG_FILES = 200;
/** 总量硬约束：先到者触发（200 × 2MB = 400MB 与 50MB 不可能同时成立，容量一律以 50MB 为准） */
const MAX_LOG_TOTAL_BYTES = 50 * 1024 * 1024;
/** 读取上限：超出只读尾部，避免一次把超大文件拉进内存 */
const MAX_READ_BYTES = 1024 * 1024;
/** 清理节流（进程内） */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/** 单条消息写入上限 */
const MAX_MESSAGE_CHARS = 4000;

const TASK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

let lastPruneAt = 0;
let lastWarnAt = 0;

// ─── 脱敏 ───

/**
 * 凭据脱敏。**路径不脱敏**（见文件头铁律 2）。
 * 导出供 `ki log` 输出侧二次使用（读取时再过一层，防历史日志或手工编辑绕过写入侧）。
 */
export function redactForLog(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;&]+/gi, '$1=[redacted]')
    // 单独 `key=`：加词边界，不能吃掉 `keyword=`
    .replace(/\bkey\s*[:=]\s*[^\s,;&]+/gi, 'key=[redacted]')
    .replace(/(https?:\/\/)[^@\s/]+(?::[^@\s/]*)?@/gi, '$1')
    .replace(/(ssh:\/\/)[^@\s/]+(?::[^@\s/]*)?@/gi, '$1')
    .replace(/\b([A-Za-z0-9._-]+):[^@\s]+@/g, '$1@');
}

// ─── 路径与目录 ───

function getLogDir(config: Pick<KiConfig, 'dataDir'>): string {
  return path.join(config.dataDir, '.ki-tasks', 'logs');
}

export function taskLogPath(config: Pick<KiConfig, 'dataDir'>, id: string): string {
  if (!TASK_ID_RE.test(id)) {
    throw Object.assign(new Error('非法任务 ID'), { code: 'TASK_ID_INVALID' });
  }
  return path.join(getLogDir(config), `${id}.log`);
}

/** 确保日志目录存在且安全（0700 / 非符号链接）；失败抛错，由调用方降级 */
function ensureLogDir(config: Pick<KiConfig, 'dataDir'>): string {
  const dir = getLogDir(config);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('任务日志目录不是安全的本地目录'), { code: 'TASK_LOG_UNSAFE' });
  }
  try { fs.chmodSync(dir, 0o700); } catch { /* 文件系统不支持 chmod 时仍可写 */ }
  return dir;
}

function warnOnce(message: string): void {
  if (Date.now() - lastWarnAt < 30_000) return;
  lastWarnAt = Date.now();
  try {
    process.stderr.write(`[ki] ${message}\n`);
  } catch { /* stderr 不可写时静默 */ }
}

// ─── 写入 ───

export interface TaskLogMeta {
  id: string;
  source: string;
  operation: string;
  scope: string;
  createdAt: number;
  pid?: number;
  /** 发起者展示标签（REQ-20261103-001）；旧日志缺省 */
  operator?: string;
}

export interface TaskLogWriter {
  /** INFO 级主动打点 */
  note(text: string): void;
  /** 状态/阶段迁移；内部去重，重复调用不产生重复行 */
  event(state: string, detail?: Record<string, string | number | undefined>): void;
  /** 终态行：错误码 + **未压缩**的原文 */
  error(code: string | undefined, message: string, hint?: string): void;
  close(): void;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 多行消息：首行原样，续行加 `  | ` 前缀（便于 `grep '^20'` 只取事件行） */
function inlineMessage(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const clipped = normalized.length > MAX_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_MESSAGE_CHARS)}…[已截断]`
    : normalized;
  return clipped.split('\n').join('\n  | ');
}

function formatDetail(detail: Record<string, string | number | undefined> | undefined): string {
  if (!detail) return '';
  const parts = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== '')
    // 值同样过脱敏：`event()` 是公开能力，将来传入 URL/token 时不能靠调用方自觉
    .map(([k, v]) => `${k}=${redactForLog(String(v)).replace(/\s+/g, ' ')}`);
  return parts.length > 0 ? `${parts.join(' ')} ` : '';
}

/**
 * 创建写入器。**任何失败都返回 null**（调用方无需 try/catch）。
 */
export function createTaskLogWriter(
  config: Pick<KiConfig, 'dataDir'>,
  meta: TaskLogMeta,
): TaskLogWriter | null {
  let file: string;
  try {
    ensureLogDir(config);
    file = taskLogPath(config, meta.id);
    // 清理节流：每进程 10 分钟最多一次，且只在"确实要写"时触发（建 writer 即要写）
    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      try { pruneTaskLogs(config); } catch { /* 清理失败不影响写入 */ }
    }
    if (!fs.existsSync(file)) {
      const head = JSON.stringify({
        v: 1,
        id: meta.id,
        source: meta.source,
        operation: meta.operation,
        scope: meta.scope,
        createdAt: toIso(meta.createdAt),
        ...(meta.pid !== undefined ? { pid: meta.pid } : {}),
        ...(meta.operator ? { operator: meta.operator } : {}),
      });
      fs.writeFileSync(file, `${head}\n`, { mode: 0o600 });
    }
  } catch (error) {
    warnOnce(`任务日志不可用（任务继续执行，仅缺日志）：${(error as Error)?.message ?? 'unknown'}`);
    return null;
  }

  let lastState: string | undefined;
  let lastPhase: string | undefined;
  let broken = false;

  const append = (line: string): void => {
    if (broken) return;
    try {
      // 滚动检查只在此处（真正要写时才 stat）——心跳不经过这里
      const stat = fs.statSync(file);
      if (stat.size >= MAX_LOG_BYTES) {
        try { fs.renameSync(file, `${file}.1`); } catch { /* 旧档覆盖失败则继续追加 */ }
      }
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      broken = true;
      warnOnce(`任务日志写入中断（任务继续执行）：${(error as Error)?.message ?? 'unknown'}`);
    }
  };

  return {
    note(text: string): void {
      if (!text.trim()) return;
      append(`${toIso(Date.now())} INFO  note ${inlineMessage(redactForLog(text))}`);
    },
    event(state: string, detail?: Record<string, string | number | undefined>): void {
      const phase = detail?.phase !== undefined ? String(detail.phase) : undefined;
      // 去重：状态与阶段都没变就不是"迁移"，不写（心跳与纯进度更新走这条路）
      if (state === lastState && phase === lastPhase) return;
      lastState = state;
      lastPhase = phase;
      append(`${toIso(Date.now())} INFO  state ${state} ${formatDetail(detail)}`.trimEnd());
    },
    error(code: string | undefined, message: string, hint?: string): void {
      /**
       * code 也要清洗：`task.finish` 的调用方会直接传 `err.code`（可能是任意字符串），
       * 含空格/换行会把单行日志结构打断。task JSON 侧有 `ERROR_CODE_RE` 校验，日志侧此前没有。
       */
      const safeCode = code ? String(code).replace(/[\s,;]+/g, '_') : '';
      const codePart = safeCode ? `code=${safeCode} ` : '';
      const hintPart = hint ? ` hint=${inlineMessage(redactForLog(hint))}` : '';
      append(`${toIso(Date.now())} ERROR failed ${codePart}msg=${inlineMessage(redactForLog(message))}${hintPart}`);
    },
    close(): void { /* 同步追加写入，无需 flush */ },
  };
}

// ─── 读取 ───

export interface TaskLogReadResult {
  path: string;
  /** 头行解析结果；头行损坏时为 null */
  head: TaskLogMeta | null;
  /** 已按 tailLines 截取的事件行（不含头行） */
  lines: string[];
  totalLines: number;
  /** 存在 `.log.1` 旧档（发生过滚动） */
  rotated: boolean;
  bytes: number;
}

/**
 * 读日志。文件不存在返回 null（不抛）。
 */
export function readTaskLog(
  config: Pick<KiConfig, 'dataDir'>,
  id: string,
  tailLines = 100,
): TaskLogReadResult | null {
  let file: string;
  try {
    file = taskLogPath(config, id);
  } catch {
    return null;
  }
  let raw: string;
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    size = stat.size;
    if (size <= MAX_READ_BYTES) {
      raw = fs.readFileSync(file, 'utf8');
    } else {
      // 超大文件只读尾部：git 报错的关键信息在尾部
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES);
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
        raw = buffer.toString('utf8');
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  } catch {
    return null;
  }

  const trimmed = raw.replace(/^\uFEFF/, '');
  const allLines = trimmed.split('\n');
  // 末尾换行会留下空串，去掉
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  let head: TaskLogMeta | null = null;
  let body = allLines;
  const first = allLines[0];
  if (first && first.startsWith('{')) {
    try {
      const parsed = JSON.parse(first) as Partial<TaskLogMeta> & { v?: number };
      if (parsed && typeof parsed.id === 'string') {
        head = {
          id: parsed.id,
          source: String(parsed.source ?? 'unknown'),
          operation: String(parsed.operation ?? 'unknown'),
          scope: String(parsed.scope ?? 'unknown'),
          createdAt: typeof parsed.createdAt === 'string' ? Date.parse(parsed.createdAt) : 0,
          ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
          ...(typeof parsed.operator === 'string' ? { operator: parsed.operator } : {}),
        };
        body = allLines.slice(1);
      }
    } catch { /* 头行损坏：不当作元信息，全部按正文处理 */ }
  }

  const max = Math.max(0, Math.min(10_000, tailLines));
  const tail = max === 0 ? [] : body.slice(Math.max(0, body.length - max));
  let rotated = false;
  try { rotated = fs.existsSync(`${file}.1`); } catch { /* ignore */ }

  return {
    path: file,
    head,
    // 出口再过一层脱敏（双保险：历史日志 / 手工编辑）
    lines: tail.map((line) => redactForLog(line)),
    totalLines: body.length,
    rotated,
    bytes: size,
  };
}

/**
 * 列表模式用的轻量存在性判断（只 stat，不读内容 —— 列表最多 100 行）。
 */
export type TaskLogPresence = 'yes' | 'no' | 'rotated';

export function hasTaskLog(config: Pick<KiConfig, 'dataDir'>, id: string): TaskLogPresence {
  try {
    const file = taskLogPath(config, id);
    if (fs.existsSync(`${file}.1`)) return 'rotated';
    return fs.existsSync(file) ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

// ─── 清理 ───

/**
 * 按保留期 / 文件数 / 总量清理。返回被删数量与释放字节（不抛）。
 *
 * 三道上限**同时生效、先到者触发**：普通日志 1–20KB 时受文件数约束；
 * 有 2MB 满档日志时 50MB 先到，实际只留约 25 个满档文件。
 */
export function pruneTaskLogs(config: Pick<KiConfig, 'dataDir'>): { removed: number; bytes: number } {
  const dir = getLogDir(config);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }
  type Item = { file: string; mtimeMs: number; size: number; isRolled: boolean };
  const items: Item[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.log') && !entry.name.endsWith('.log.1')) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      items.push({ file, mtimeMs: stat.mtimeMs, size: stat.size, isRolled: entry.name.endsWith('.log.1') });
    } catch { /* 并发删除，跳过 */ }
  }

  let removed = 0;
  let bytes = 0;
  const drop = (item: Item): void => {
    try {
      fs.unlinkSync(item.file);
      removed += 1;
      bytes += item.size;
    } catch { /* next run retries */ }
  };

  // 1) 保留期
  const now = Date.now();
  const kept: Item[] = [];
  for (const item of items) {
    if (now - item.mtimeMs > LOG_TTL_MS) drop(item);
    else kept.push(item);
  }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs); // 旧 → 新

  // 2) 文件数（按主日志计，`.1` 跟随其主档一起算一组）
  const mainCount = () => kept.filter((item) => !item.isRolled).length;
  let cursor = 0;
  while (mainCount() > MAX_LOG_FILES && cursor < kept.length) {
    const item = kept[cursor];
    if (item.isRolled) { cursor += 1; continue; }
    const rolled = kept.find((other) => other.file === `${item.file}.1`);
    drop(item);
    if (rolled) drop(rolled);
    kept.splice(kept.indexOf(item), 1);
    if (rolled) {
      const idx = kept.indexOf(rolled);
      if (idx >= 0) kept.splice(idx, 1);
    }
  }

  // 3) 总量（硬约束）
  let total = kept.reduce((sum, item) => sum + item.size, 0);
  for (const item of kept) {
    if (total <= MAX_LOG_TOTAL_BYTES) break;
    drop(item);
    total -= item.size;
  }

  return { removed, bytes };
}
