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

/**
 * 参数快照（REQ-20261019-004 S-01）：任务创建时确定的执行参数，此后不再变化。
 * ★ 与 `ImportRetryParams` 字段一一对应，但**刻意不复用其类型**——registry 是零引擎依赖的
 *   落盘层，引用 `import-retry.ts` 会把 scope/fs 依赖带进来（见 DESIGN.md D1-3）。
 * ★ 不存绝对路径：共享任务文件会被 `sanitizedText` 替换为 `[path]`，存了也读不出，
 *   且可能泄漏用户目录名。改用 `sourceKind` 枚举回答"能否事后重试"。
 */
export interface TaskParamSnapshot {
  /** 来源形态：浏览器上传（受控暂存目录，会被 TTL 清理）/ 外部目录 */
  sourceKind?: 'upload' | 'external';
  /** 数据源类型（datasource-sync） */
  type?: 'directory' | 'git';
  /** 同步模式（datasource-sync） */
  mode?: 'incremental' | 'full';
  /** 用户显式指定的落点 Group；未指定时省略 */
  group?: string;
  /** 文档级自定义标签 */
  tags?: string[];
  /** 是否写 dense 向量层（false = 仅全文索引） */
  vector?: boolean;
  /** 同名文档处理策略：incremental / suffix / overwrite / skip */
  conflictMode?: string;
  /** suffix 策略的后缀模板（仅 conflictMode='suffix' 时有意义） */
  conflictSuffix?: string;
  /** 是否启用「跳过疑似重复」 */
  skipDuplicates?: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
}

/**
 * 结果摘要（REQ-20261019-004 S-01）：任务结束时写入一次。
 * ★ 明细条数受 {@link MAX_TASK_DETAIL_ITEMS} 限制：台账文件超过 32KB 时
 *   `readRecordFile` 会返回 null ⇒ 任务从列表与详情彻底消失（不是"加载慢"）。
 */
export interface TaskResultSnapshot {
  files?: {
    /** 白名单后、剔除疑似重复前的文件数 */
    scanned: number;
    /** 文件级完成（含 unchanged） */
    completed: number;
    /** 未提交元数据的文件数 */
    incomplete: number;
    /** 未进入最终处理的文件数 */
    skipped: number;
    /** 其中内容未变、未重算的文件数（completed 的**子集**） */
    unchanged: number;
    /** 其中疑似重复被跳过的文件数（skipped 的**子集**） */
    duplicatesSkipped: number;
    /** skipped 的三类拆分：三项之和 == skipped */
    skippedReasons?: { conflict: number; duplicate: number; other: number };
  };
  /** 写入 dense 层的条目数（chunk 合并后） */
  vectorized?: number;
  /** 全文索引条目数 */
  fullTextIndexed?: number;
  /** 复制的本地图片附件数 */
  assets?: number;
  /**
   * 实际写入的 Group 列表（源目录子结构会派生多个；最多 MAX_TASK_DETAIL_ITEMS 个）。
   * ★ 与 `params.group` 不同：`params.group` 是用户显式指定，本字段是执行后真实落点。
   */
  groups?: string[];
  /** 疑似重复明细（≤ MAX_TASK_DETAIL_ITEMS） */
  duplicates?: { path: string; existingGroup: string; existingRelation: string }[];
  /** 同名冲突明细（≤ MAX_TASK_DETAIL_ITEMS） */
  conflicts?: {
    path: string;
    relation: string;
    action: 'overwrite' | 'skip' | 'suffix';
    skipReason?: string;
    /** 判定为覆盖但最终未执行（增量导入「内容未变」跳过） */
    unchanged?: boolean;
  }[];
  /** 明细是否被截断（完整数见计数） */
  truncated?: boolean;
  /** 可判别错误码（如 ALL_FILES_DUPLICATES / VECTORIZATION_STOPPED） */
  errorCode?: string;
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
  /** 参数快照（创建时写入；旧记录无此字段） */
  params?: TaskParamSnapshot;
  /** 结果摘要（结束时写入；运行中为 undefined） */
  result?: TaskResultSnapshot;
  /** 重试血缘：本任务重试自哪个任务 */
  retryOf?: string;
}

/** 单类明细上限：20 条 × ~120B ≈ 2.4KB，远小于 32KB 文件上限 */
export const MAX_TASK_DETAIL_ITEMS = 20;

/** 可更新字段白名单（`params` 在 args 就绪后单独写入一次；`result` 只在 finish 时写） */
type TaskPatch = Partial<Pick<TaskRecord,
  'state' | 'phase' | 'progress' | 'error' | 'recoveryHint' | 'partialCommitted'
  | 'startedAt' | 'finishedAt' | 'indexReadiness' | 'params' | 'result'>>;

export interface TaskReporter {
  update(patch: TaskPatch): boolean;
  progress(progress: TaskProgress): boolean;
  finish(state: Exclude<TaskState, 'queued' | 'running' | 'unknown'>, options?: {
    error?: string;
    recoveryHint?: string;
    partialCommitted?: number;
    /** 结果摘要；与 `errorCode` 一起写入 `record.result` */
    result?: TaskResultSnapshot;
    /** 可判别错误码（会合并进 result.errorCode，便于 UI 单点读取） */
    errorCode?: string;
  }): void;
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

const MAX_SNAPSHOT_TEXT = 200;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * 相对路径净化（REQ-20261019-004 S-01）：绝对路径 / 含 `..` / 空值 / 超长一律拒绝。
 * ★ 与 `import.ts` 的 `sanitizeRelPath` **同判据但不同实现**：后者在 import 模块内部，
 *   落盘层引用它会把导入链路的依赖带进来（见 DESIGN.md D1-3）。
 */
function safeRelPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const rel = value.trim().replace(/\\/g, '/');
  if (!rel || rel.length > MAX_SNAPSHOT_TEXT) return undefined;
  if (rel.startsWith('/') || /^[A-Za-z]:\//.test(rel)) return undefined;
  if (rel.split('/').includes('..')) return undefined;
  return rel;
}

function countish(value: unknown): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : undefined;
}

function normalizeParams(input: TaskParamSnapshot | undefined): TaskParamSnapshot | undefined {
  if (!input) return undefined;
  const out: TaskParamSnapshot = {};
  if (input.sourceKind === 'upload' || input.sourceKind === 'external') out.sourceKind = input.sourceKind;
  if (input.type === 'git' || input.type === 'directory') out.type = input.type;
  if (input.mode === 'incremental' || input.mode === 'full') out.mode = input.mode;
  const group = safeRelPath(input.group);
  if (group) out.group = group;
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map((tag) => sanitizedText(tag, 80))
    .filter((tag): tag is string => Boolean(tag))
    .slice(0, MAX_TASK_DETAIL_ITEMS);
  if (tags.length > 0) out.tags = tags;
  if (typeof input.vector === 'boolean') out.vector = input.vector;
  const conflictMode = sanitizedText(input.conflictMode, 40);
  if (conflictMode) out.conflictMode = conflictMode;
  if (out.conflictMode === 'suffix') {
    const suffix = sanitizedText(input.conflictSuffix, 40);
    if (suffix) out.conflictSuffix = suffix;
  }
  if (typeof input.skipDuplicates === 'boolean') out.skipDuplicates = input.skipDuplicates;
  if (countish(input.chunkSize) !== undefined) out.chunkSize = countish(input.chunkSize);
  if (countish(input.chunkOverlap) !== undefined) out.chunkOverlap = countish(input.chunkOverlap);
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeResult(input: TaskResultSnapshot | undefined): TaskResultSnapshot | undefined {
  if (!input) return undefined;
  const out: TaskResultSnapshot = {};
  const files = input.files;
  if (files && typeof files === 'object') {
    const scanned = countish(files.scanned) ?? 0;
    const completed = countish(files.completed) ?? 0;
    const incomplete = countish(files.incomplete) ?? 0;
    const skipped = countish(files.skipped) ?? 0;
    const unchanged = countish(files.unchanged) ?? 0;
    const duplicatesSkipped = countish(files.duplicatesSkipped) ?? 0;
    const reasons = files.skippedReasons;
    out.files = {
      scanned, completed, incomplete, skipped, unchanged, duplicatesSkipped,
      ...(reasons && typeof reasons === 'object'
        ? {
            skippedReasons: {
              conflict: countish(reasons.conflict) ?? 0,
              duplicate: countish(reasons.duplicate) ?? 0,
              other: countish(reasons.other) ?? 0,
            },
          }
        : {}),
    };
  }
  if (countish(input.vectorized) !== undefined) out.vectorized = countish(input.vectorized);
  if (countish(input.fullTextIndexed) !== undefined) out.fullTextIndexed = countish(input.fullTextIndexed);
  if (countish(input.assets) !== undefined) out.assets = countish(input.assets);
  const groupsRaw = (Array.isArray(input.groups) ? input.groups : [])
    .map(safeRelPath)
    .filter((group): group is string => Boolean(group));
  if (groupsRaw.length > MAX_TASK_DETAIL_ITEMS) out.truncated = true;
  const groups = groupsRaw.slice(0, MAX_TASK_DETAIL_ITEMS);
  if (groups.length > 0) out.groups = groups;
  const duplicatesRaw = (Array.isArray(input.duplicates) ? input.duplicates : [])
    .map((item) => {
      const rel = safeRelPath(item?.path);
      const existingGroup = safeRelPath(item?.existingGroup);
      const existingRelation = sanitizedText(item?.existingRelation, MAX_SNAPSHOT_TEXT);
      return rel && existingGroup && existingRelation
        ? { path: rel, existingGroup, existingRelation }
        : null;
    })
    .filter((item): item is { path: string; existingGroup: string; existingRelation: string } => item !== null);
  if (duplicatesRaw.length > MAX_TASK_DETAIL_ITEMS) out.truncated = true;
  const duplicates = duplicatesRaw.slice(0, MAX_TASK_DETAIL_ITEMS);
  if (duplicates.length > 0) out.duplicates = duplicates;
  const conflictsRaw = (Array.isArray(input.conflicts) ? input.conflicts : [])
    .map((item) => {
      const rel = safeRelPath(item?.path);
      const relation = sanitizedText(item?.relation, MAX_SNAPSHOT_TEXT);
      const action = item?.action;
      if (!rel || !relation) return null;
      if (action !== 'overwrite' && action !== 'skip' && action !== 'suffix') return null;
      const skipReason = item.skipReason === 'already-imported' || item.skipReason === 'same-name'
        ? item.skipReason
        : undefined;
      return {
        path: rel,
        relation,
        action,
        ...(skipReason ? { skipReason } : {}),
        ...(item.unchanged === true ? { unchanged: true } : {}),
      };
    })
    .filter((item): item is { path: string; relation: string; action: 'overwrite' | 'skip' | 'suffix'; skipReason?: 'already-imported' | 'same-name' } => item !== null);
  if (conflictsRaw.length > MAX_TASK_DETAIL_ITEMS) out.truncated = true;
  const conflicts = conflictsRaw.slice(0, MAX_TASK_DETAIL_ITEMS);
  if (conflicts.length > 0) out.conflicts = conflicts;
  if (input.truncated === true) out.truncated = true;
  if (typeof input.errorCode === 'string' && ERROR_CODE_RE.test(input.errorCode)) out.errorCode = input.errorCode;
  return out;
}

/**
 * 落盘前按字节预算裁剪明细（REQ-20261019-004 G1）。
 * ★ 必须：`readRecordFile` 对 `size > MAX_TASK_FILE_BYTES` 返回 null ⇒ 超限任务会**静默消失**。
 * 降级顺序：先砍 conflicts → 再砍 duplicates → 最后只留计数（`truncated` 标记共存）。
 */
function fitToBudget(record: TaskRecord): TaskRecord {
  if (!record.result) return record;
  const limit = MAX_TASK_FILE_BYTES - 512;
  /**
   * ★ 必须按 **UTF-8 字节** 算，不能用 `String.length`（UTF-16 码元数）：
   *   中文在 UTF-8 下 3 字节 / 1 码元，按长度算会低估约 3 倍，
   *   而读侧 `readRecordFile` 用的是 `stat.size`（真实字节数）——
   *   低估会让"以为没超"的记录落盘后超限，任务直接从列表消失。
   */
  const sizeOf = (value: TaskRecord): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (sizeOf(record) <= limit) return record;
  const withoutConflicts: TaskResultSnapshot = { ...record.result, truncated: true };
  delete withoutConflicts.conflicts;
  const candidate: TaskRecord = { ...record, result: withoutConflicts };
  if (sizeOf(candidate) <= limit) return candidate;
  const withoutDetails: TaskResultSnapshot = { ...withoutConflicts };
  delete withoutDetails.duplicates;
  return { ...record, result: withoutDetails };
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
  // 唯一落盘入口：超预算时裁剪明细，避免文件 >32KB 后被 readRecordFile 判为不可读（任务消失）
  const payload = JSON.stringify(fitToBudget(record));
  const temporary = path.join(dir, `.${record.id}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, payload, 'utf8');
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
  input: {
    id?: string;
    source: TaskSource;
    operation: string;
    scope: string;
    /** 重试血缘：本任务重试自哪个任务（缺省 = 非重试任务） */
    retryOf?: string;
  },
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
    ...(typeof input.retryOf === 'string' && TASK_ID_RE.test(input.retryOf) ? { retryOf: input.retryOf } : {}),
  };
  writeRecord(config, record, true);
  let stopped = false;
  let lastWriteWarningAt = 0;
  const reportWriteFailure = (error: unknown): void => {
    if (Date.now() - lastWriteWarningAt < 30_000) return;
    lastWriteWarningAt = Date.now();
    process.stderr.write(`[ki] 任务状态暂不能更新：${sanitizedText((error as Error)?.message, 180) ?? 'unknown'}\n`);
  };
  const update = (patch: TaskPatch): boolean => {
    if (stopped) return false;
    const updated: TaskRecord = {
      ...record,
      ...patch,
      ...(patch.phase !== undefined ? { phase: sanitizedText(patch.phase, 80) } : {}),
      ...(patch.error !== undefined ? { error: safeErrorSummary(patch.error) } : {}),
      ...(patch.recoveryHint !== undefined ? { recoveryHint: sanitizedText(patch.recoveryHint, 240) } : {}),
      ...(patch.progress !== undefined ? { progress: normalizeProgress(patch.progress) } : {}),
      // REQ-20261019-004：参数快照 / 结果摘要同样过卫生化（相对路径、标签、错误码白名单）
      ...(patch.params !== undefined ? { params: normalizeParams(patch.params) } : {}),
      ...(patch.result !== undefined ? { result: normalizeResult(patch.result) } : {}),
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
  let pendingFinish: TaskPatch | undefined;
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
      /**
       * REQ-20261019-004：`errorCode` 统一并入 `result.errorCode`——UI 只需读一个位置；
       * 失败路径即使没有结果摘要（`toResultSnapshot` 返回 undefined），也落一个只含错误码的
       * result，避免"错误码存在别处"的两套读法。
       */
      const mergedResult = options.result !== undefined || options.errorCode !== undefined
        ? {
            ...(options.result ?? {}),
            ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
          }
        : undefined;
      const terminalPatch = {
        state,
        finishedAt: Date.now(),
        ...(options.error ? { error: options.error } : {}),
        ...(options.recoveryHint ? { recoveryHint: options.recoveryHint } : {}),
        ...(Number.isFinite(options.partialCommitted) ? { partialCommitted: options.partialCommitted } : {}),
        ...(mergedResult !== undefined ? { result: mergedResult } : {}),
      } satisfies TaskPatch;
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
