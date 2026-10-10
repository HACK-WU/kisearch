import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KiConfig } from './config.js';

export type TaskSource = 'cli' | 'daemon' | 'web';
export type TaskState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export interface TaskProgress {
  phase?: string;
  done: number;
  total: number;
  persisted?: number;
  failed?: number;
  cancelled?: number;
  notProcessed?: number;
  metadataPending?: number;
}

/**
 * S-03/R6（REQ-20261009-003）：索引就绪判据（A11 交叉口径），与 `index-maintenance.ts`
 * 的 `IndexReadiness` **结构同构**（此处不复用其类型：registry 是零引擎依赖的落盘层）。
 *   - `denseIndexed`：主判据 —— dense 索引实体 ≥1；
 *   - `completeness`：引擎自报信号（**仅参考**：该信号曾恒为 0，单看会误判"从未建"）；
 *   - `unknown`：读取失败/超时 ⇒ **≠ 未建**（与 N9 同源语义，展示文案必须区分）。
 */
export interface TaskIndexReadiness {
  denseIndexed: boolean;
  completeness?: { dense?: number; fts?: number; scalar?: number };
  unknown?: boolean;
  reason?: string;
}

export interface TaskRecord {
  id: string;
  source: TaskSource;
  operation: string;
  scope: string;
  state: TaskState;
  phase?: string;
  progress?: TaskProgress;
  error?: string;
  recoveryHint?: string;
  partialCommitted?: number;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** S-03/R6：索引就绪判据（导入类任务在整理落定后写入；缺失 = 本次未产生整理） */
  indexReadiness?: TaskIndexReadiness;
}

export interface TaskReporter {
  update(patch: Partial<Pick<TaskRecord, 'state' | 'phase' | 'progress' | 'error' | 'recoveryHint' | 'partialCommitted' | 'startedAt' | 'finishedAt' | 'indexReadiness'>>): void;
  progress(progress: TaskProgress): void;
  finish(state: Exclude<TaskState, 'queued' | 'running' | 'unknown'>, options?: { error?: string; recoveryHint?: string; partialCommitted?: number }): void;
  stop(): void;
}

/** 任务记录保留时长；`/api/tasks` 用它作为 retainedForMs 返回给前端。 */
export const TASK_TTL_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MAX_TASK_FILES = 2_000;
const MAX_SCAN_FILES = 10_000;
const MAX_TASK_FILE_BYTES = 32 * 1024;
const TASK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

function getTaskDir(config: Pick<KiConfig, 'dataDir'>): string {
  return path.join(config.dataDir, '.ki-tasks');
}

function ensureTaskDir(config: Pick<KiConfig, 'dataDir'>): string {
  const dir = getTaskDir(config);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('任务状态目录不是安全的本地目录'), { code: 'TASK_REGISTRY_UNSAFE' });
  }
  try { fs.chmodSync(dir, 0o700); } catch { /* 文件系统不支持 chmod 时仍使用原子写入 */ }
  return dir;
}

function taskPath(config: Pick<KiConfig, 'dataDir'>, id: string): string {
  if (!TASK_ID_RE.test(id)) throw Object.assign(new Error('非法任务 ID'), { code: 'TASK_ID_INVALID' });
  return path.join(getTaskDir(config), `${id}.json`);
}

function sanitizedText(value: unknown, max = 400): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(^|[\s([{:：='"])(?:\/[^\s,;)}，。；'"]+|[A-Za-z]:\\[^\s,;)}，。；'"]+)/g, '$1[path]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max);
}

/** 共享任务文件只保存可枚举的故障类别，避免 provider 原文回显输入内容。 */
function safeErrorSummary(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let category: string;
  const importFailures = /^(\d+) 项导入处理有错误$/.exec(value);
  if (/SCOPE_OPERATION_BUSY|已有导入或还原任务/.test(value)) category = '同一知识库已有写入任务，请等待后重试';
  else if (/embedding\.apiKey|API[_ -]?KEY.*未配置/i.test(value)) category = 'Embedding API Key 未配置或不可用';
  else if (/VECTOR_DIMENSION_MISMATCH|维度.*(?:不匹配|变化)|dimension mismatch/i.test(value)) category = '当前 embedding 与已有向量集合维度不匹配';
  else if (/\b(?:HTTP[_ ]?(?:401|403)|UNAUTHORIZED|FORBIDDEN|鉴权失败)\b/i.test(value)) category = 'Embedding 服务鉴权失败';
  else if (/\b(?:HTTP[_ ]?429|RATE_LIMIT)\b|限流/i.test(value)) category = 'Embedding 服务限流';
  else if (/\b(?:HTTP[_ ]?400|20015)\b|参数无效/i.test(value)) category = 'Embedding 请求参数无效，请检查模型、批大小与输入';
  else if (/\b(?:TIMEOUT|ETIMEDOUT)\b|超时/i.test(value)) category = 'Embedding 服务请求超时';
  else if (/\b(?:ECONNREFUSED|ENOTFOUND|NETWORK)\b|provider unavailable|embedding unavailable|服务不可用/i.test(value)) category = 'Embedding 服务暂不可用';
  else if (/\bENOSPC\b|磁盘空间不足/i.test(value)) category = '存储空间不足';
  else if (/取消|CANCELLED/i.test(value)) category = '任务已取消';
  else if (/\b(?:ZVEC_WRITE_ERROR|COLLECTION_UNWRITABLE|METADATA_PERSIST_FAILED)\b|集合不可写/i.test(value)) category = '向量集合或元数据写入失败';
  else if (importFailures) category = `${importFailures[1]} 项导入处理有错误`;
  else category = '任务失败，请查看发起端的命令输出或服务日志';
  const counts = /成功\s*(\d+)[，,]\s*失败\s*(\d+)[，,]\s*未处理\s*(\d+)/.exec(value);
  return counts ? `${category}；成功 ${counts[1]}，失败 ${counts[2]}，未处理 ${counts[3]}` : category;
}

function normalizeProgress(progress: TaskProgress): TaskProgress {
  const finite = (value: unknown): number | undefined => Number.isFinite(value) ? Math.max(0, Number(value)) : undefined;
  return {
    ...(typeof progress.phase === 'string' ? { phase: sanitizedText(progress.phase, 80) } : {}),
    done: finite(progress.done) ?? 0,
    total: finite(progress.total) ?? 0,
    ...(finite(progress.persisted) !== undefined ? { persisted: finite(progress.persisted) } : {}),
    ...(finite(progress.failed) !== undefined ? { failed: finite(progress.failed) } : {}),
    ...(finite(progress.cancelled) !== undefined ? { cancelled: finite(progress.cancelled) } : {}),
    ...(finite(progress.notProcessed) !== undefined ? { notProcessed: finite(progress.notProcessed) } : {}),
    ...(finite(progress.metadataPending) !== undefined ? { metadataPending: finite(progress.metadataPending) } : {}),
  };
}

function writeRecord(config: Pick<KiConfig, 'dataDir'>, record: TaskRecord, createOnly = false): void {
  const dir = ensureTaskDir(config);
  const file = taskPath(config, record.id);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw Object.assign(new Error('任务状态文件不是普通文件'), { code: 'TASK_REGISTRY_UNSAFE' });
    }
    if (createOnly) throw Object.assign(new Error('任务 ID 已存在'), { code: 'TASK_ID_EXISTS' });
  } else if (!createOnly) {
    throw Object.assign(new Error('任务状态文件已丢失，拒绝重建活动任务'), { code: 'TASK_REGISTRY_MISSING' });
  }
  const temporary = path.join(dir, `.${record.id}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function readRecordFile(file: string, expectedId: string): TaskRecord | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TASK_FILE_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TaskRecord;
    if (!parsed || parsed.id !== expectedId || !TASK_ID_RE.test(parsed.id)
      || !['cli', 'daemon', 'web'].includes(parsed.source)
      || !['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'].includes(parsed.state)
      || typeof parsed.operation !== 'string' || typeof parsed.scope !== 'string'
      || !Number.isFinite(parsed.createdAt) || !Number.isFinite(parsed.updatedAt) || !Number.isFinite(parsed.heartbeatAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Register first, then expose safe state updates and an independent heartbeat. */
export function createTaskReporter(
  config: Pick<KiConfig, 'dataDir'>,
  input: { id?: string; source: TaskSource; operation: string; scope: string },
): TaskReporter {
  const now = Date.now();
  const record: TaskRecord = {
    id: input.id ?? crypto.randomUUID(),
    source: input.source,
    operation: sanitizedText(input.operation, 80) ?? 'unknown',
    scope: sanitizedText(input.scope, 120) ?? 'unknown',
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
  };
  writeRecord(config, record, true);
  let stopped = false;
  let lastWriteWarningAt = 0;
  const reportWriteFailure = (error: unknown): void => {
    if (Date.now() - lastWriteWarningAt < 30_000) return;
    lastWriteWarningAt = Date.now();
    process.stderr.write(`[ki] 任务状态暂不能更新：${sanitizedText((error as Error)?.message, 180) ?? 'unknown'}\n`);
  };
  const update = (patch: Partial<Pick<TaskRecord, 'state' | 'phase' | 'progress' | 'error' | 'recoveryHint' | 'partialCommitted' | 'startedAt' | 'finishedAt' | 'indexReadiness'>>): boolean => {
    if (stopped) return false;
    const updated: TaskRecord = {
      ...record,
      ...patch,
      ...(patch.phase !== undefined ? { phase: sanitizedText(patch.phase, 80) } : {}),
      ...(patch.error !== undefined ? { error: safeErrorSummary(patch.error) } : {}),
      ...(patch.recoveryHint !== undefined ? { recoveryHint: sanitizedText(patch.recoveryHint, 240) } : {}),
      ...(patch.progress !== undefined ? { progress: normalizeProgress(patch.progress) } : {}),
      // S-03/R6：就绪判据同样过卫生化（`reason` 可能来自引擎/超时错误文本）
      ...(patch.indexReadiness !== undefined
        ? {
            indexReadiness: {
              ...patch.indexReadiness,
              ...(patch.indexReadiness.reason !== undefined
                ? { reason: sanitizedText(patch.indexReadiness.reason, 180) }
                : {}),
            },
          }
        : {}),
      updatedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    try {
      writeRecord(config, updated);
      Object.assign(record, updated);
      return true;
    } catch (error) {
      reportWriteFailure(error);
      return false;
    }
  };
  let pendingFinish: Partial<Pick<TaskRecord, 'state' | 'phase' | 'progress' | 'error' | 'recoveryHint' | 'partialCommitted' | 'startedAt' | 'finishedAt' | 'indexReadiness'>> | undefined;
  let pendingFinishRetries = 0;
  const timer = setInterval(() => {
    if (pendingFinish) {
      if (update(pendingFinish)) {
        pendingFinish = undefined;
        stopped = true;
        clearInterval(timer);
      } else if (++pendingFinishRetries >= 3) {
        process.stderr.write('[ki] 任务已结束，但终态无法写入任务登记文件；请以命令输出为准。\n');
        pendingFinish = undefined;
        stopped = true;
        clearInterval(timer);
      }
      return;
    }
    update({});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    update,
    progress: (progress) => update({
      // daemon 在进入共享队列时会先发 phase=queued；在 coordinator 真正开始前，
      // 任务仍然排队，不能被进度事件提前显示为运行中。
      state: record.state === 'queued' ? 'queued' : 'running',
      progress,
      phase: progress.phase,
    }),
    finish: (state, options = {}) => {
      const terminalPatch = {
        state,
        finishedAt: Date.now(),
        ...(options.error ? { error: options.error } : {}),
        ...(options.recoveryHint ? { recoveryHint: options.recoveryHint } : {}),
        ...(Number.isFinite(options.partialCommitted) ? { partialCommitted: options.partialCommitted } : {}),
      } satisfies Partial<Pick<TaskRecord, 'state' | 'finishedAt' | 'error' | 'recoveryHint' | 'partialCommitted'>>;
      if (update(terminalPatch)) {
        stopped = true;
        clearInterval(timer);
      } else {
        // 终态落盘失败时继续保活并重试，避免记录永久停在 running 或被误当成功。
        pendingFinish = terminalPatch;
        timer.ref?.();
      }
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function listTaskRecords(config: Pick<KiConfig, 'dataDir'>, limit = MAX_TASK_FILES): TaskRecord[] {
  let dir: string;
  try {
    dir = ensureTaskDir(config);
  } catch (error) {
    throw Object.assign(new Error(`任务状态暂不可读：${(error as Error).message}`), { code: 'TASK_REGISTRY_UNAVAILABLE', status: 503 });
  }
  let names = fs.readdirSync(dir).filter((name) => /^[A-Za-z0-9-]{1,128}\.json$/.test(name));
  if (names.length > MAX_SCAN_FILES) {
    // 先按文件修改时间清理明显过期记录，避免大量旧文件让列表永久不可读。
    const threshold = Date.now() - TASK_TTL_MS;
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < threshold) fs.unlinkSync(file);
      } catch { /* 并发 owner 可能刚替换或删除文件 */ }
    }
    names = fs.readdirSync(dir).filter((name) => /^[A-Za-z0-9-]{1,128}\.json$/.test(name));
    if (names.length > MAX_SCAN_FILES) {
      throw Object.assign(new Error('任务记录过多，请稍后重试'), { code: 'TASK_REGISTRY_LIMIT', status: 503 });
    }
  }
  const now = Date.now();
  const records: TaskRecord[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    const file = path.join(dir, name);
    const record = readRecordFile(file, id);
    if (!record) continue;
    const active = record.state === 'queued' || record.state === 'running';
    if ((active && now - record.heartbeatAt > TASK_TTL_MS)
      || (!active && now - (record.finishedAt ?? record.updatedAt) > TASK_TTL_MS)) {
      try { fs.unlinkSync(file); } catch { /* next read retries */ }
      continue;
    }
    if (active && now - record.heartbeatAt > STALE_AFTER_MS) {
      records.push({ ...record, state: 'unknown' });
    } else {
      records.push(record);
    }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(MAX_TASK_FILES, limit)));
}

export function getTaskRecord(config: Pick<KiConfig, 'dataDir'>, id: string): TaskRecord | null {
  if (!TASK_ID_RE.test(id)) return null;
  let dir: string;
  try { dir = ensureTaskDir(config); } catch { return null; }
  const record = readRecordFile(path.join(dir, `${id}.json`), id);
  if (!record) return null;
  const now = Date.now();
  const active = record.state === 'queued' || record.state === 'running';
  if ((active && now - record.heartbeatAt > TASK_TTL_MS)
    || (!active && now - (record.finishedAt ?? record.updatedAt) > TASK_TTL_MS)) return null;
  if (active && now - record.heartbeatAt > STALE_AFTER_MS) {
    return { ...record, state: 'unknown' };
  }
  return record;
}
