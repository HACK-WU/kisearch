import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskLogWriter } from './task-log.js';
import type { TaskLogWriter } from './task-log.js';
import type { KiConfig } from './config.js';

export type TaskSource = 'cli' | 'daemon' | 'web' | 'scheduler';

export type TaskOperatorType = 'user' | 'local' | 'cli' | 'daemon' | 'token' | 'scheduler' | 'legacy';

/** 任务发起者快照（REQ-20261103-001 · S-05）；创建时写入，之后不可变 */
export interface TaskOperator {
  type: TaskOperatorType;
  label: string;
  userId?: string;
  tokenId?: string;
}
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
  /**
   * 本次**新建**的文档（`create` + `suffix`；`overwrite` 不计），上限见 MAX_SNAPSHOT_CREATED。
   * ★ 用 `[group, relation]` 二元组而不是对象：台账单文件上限 32KB，
   *   带键名的对象约 120 字节/条，250 篇中文路径就会把任务文件撑爆（读侧直接判不可读）。
   */
  created?: [string, string][];
  /** 本次新建文档总数（未被 created 截断影响） */
  createdTotal?: number;
  /** `created` 是否被截断 */
  createdTruncated?: boolean;
  /**
   * 本次**变更**（被覆盖重写）的文档，格式同 `created`（二元组省字节）。
   * ★ 只记标识，不含内容/差异；上限 {@link MAX_SNAPSHOT_MODIFIED} 比 created 小，
   *   因为 32KB 台账预算已被 created 占用大半（见 `fitToBudget` 裁剪顺序）。
   */
  modified?: [string, string][];
  /** 本次变更文档总数（未被 modified 截断影响） */
  modifiedTotal?: number;
  /** `modified` 是否被截断 */
  modifiedTruncated?: boolean;
  /**
   * S-05：`datasource-add-remote` 成功后自动入队的首次同步任务 ID。
   * 页面据此跟随首次同步；为 null = 入队失败（登记仍成功，需手动同步）。
   */
  syncTaskId?: string | null;
  /** S-05：数据源已登记成功，但 scopeReadonly 写入失败（只读未生效，需按提示补设） */
  readonlyWarning?: string;
  /** 可判别错误码（如 ALL_FILES_DUPLICATES / VECTORIZATION_STOPPED） */
  errorCode?: string;
}

export interface TaskRecord {
  id: string;
  source: TaskSource;
  /** 发起者快照；旧记录没有此字段 ⇒ 视为 legacy（展示 `—`） */
  operator?: TaskOperator;
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

/**
 * 新建文档明细的独立上限：比 `MAX_TASK_DETAIL_ITEMS` 大得多——
 * 用户要看的是"这次新增了哪些目录下的文档"，20 条在 250 篇的真实导入里毫无意义。
 * 值受 32KB 单文件上限约束（二元组约 40~60 字节/条），仍由 `fitToBudget` 兜底裁剪。
 */
export const MAX_SNAPSHOT_CREATED = 400;

/**
 * 变更文档明细的独立上限：比 created 小（created 已占预算大半）。
 * 超出只丢明细，`modifiedTotal` 仍然精确 —— 页面显示「共 N 篇，明细未保留」。
 */
export const MAX_SNAPSHOT_MODIFIED = 200;

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
  /**
   * [S-02] 主动往任务运行日志写一行 INFO。
   * 任务 JSON 只存压缩后的错误类别，原文落这里；writer 不可用时为 no-op。
   */
  note(text: string): void;
  stop(): void;
}

/**
 * 终态任务记录保留时长（7 天）；`/api/tasks` 用它作为 `retainedForMs` 返回给前端，
 * 前端「最近任务保留 X」文案据此渲染，不另存副本。
 *
 * ★ 与运行日志 `LOG_TTL_MS`（`task-log.ts`）同窗口：台账先过期时 `ki log` 只能走
 *   「从日志头行恢复元信息」的降级路径，两个保留期不一致会让事后排查莫名缺字段。
 */
export const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 非终态任务的「心跳存活窗口」——心跳停超过此值即判定进程已死，记录直接清理。
 *
 * ★ 刻意与 `TASK_TTL_MS` 解耦：daemon 崩溃 / 被 kill 的任务永远停在 `running`，
 *   读侧 30s 后就把它改判为 `unknown`，而 `unknown` 属前端顶栏「需关注」徽章的
 *   失败档（`web/src/lib/taskNotice.ts` 的 `FAILURE_STATES`）。若这里跟随保留期
 *   改成 7 天，一次崩溃就会让红徽章挂满一周、任务列表里躺一条假死记录。
 *   维持 1 小时 = 与「保留期仍是 1 小时」时的心跳行为完全一致。
 */
const TASK_HEARTBEAT_TTL_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MAX_TASK_FILES = 2_000;
const MAX_SCAN_FILES = 10_000;
const MAX_TASK_FILE_BYTES = 32 * 1024;
const TASK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
/** 台账文件名（`<id>.json`）：必须与 `TASK_ID_RE` 同源，改一处就要改另一处 */
const TASK_FILE_RE = /^[A-Za-z0-9-]{1,128}\.json$/;

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

const OPERATOR_TYPES: readonly TaskOperatorType[] = [
  'user', 'local', 'cli', 'daemon', 'token', 'scheduler', 'legacy',
];

function sanitizeOperator(value: TaskOperator | undefined): TaskOperator | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const type = OPERATOR_TYPES.includes(value.type) ? value.type : 'legacy';
  const label = sanitizedText(value.label, 80) ?? '—';
  const userId = sanitizedText(value.userId, 80);
  const tokenId = sanitizedText(value.tokenId, 80);
  return {
    type,
    label,
    ...(userId ? { userId } : {}),
    ...(tokenId ? { tokenId } : {}),
  };
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
  /**
   * ★ Git 数据源的错误必须**前置判定**（REQ-20261102 任务诊断日志 S-01）：
   *   下面 embedding 白名单里的「超时」「NETWORK」会吃掉 git 的失败串 ——
   *   `clone 超时（10 分钟）` → 误报「Embedding 服务请求超时」；
   *   `无法连接远端（… network is unreachable）` → 误报「Embedding 服务暂不可用」。
   *   判定一律用 Git 独有词（不走 `NETWORK` / `超时` 这类通用词），避免反向污染 embedding 分类。
   */
  if (/GIT_CLONE_TIMEOUT|clone 超时/.test(value)) category = 'Git 克隆超时';
  else if (/GIT_NETWORK_FAILED|无法连接远端|could not resolve host/i.test(value)) category = '无法连接远端仓库';
  else if (/GIT_AUTH_FAILED|认证失败：请在运行 daemon/.test(value)) category = 'Git 仓库认证失败';
  else if (/GIT_BRANCH_NOT_FOUND|远端分支不存在/.test(value)) category = '远端分支不存在';
  else if (/GIT_REPO_NOT_FOUND|仓库不存在或当前凭据无权访问/.test(value)) category = '仓库不存在或无权访问';
  else if (/CLONE_TARGET_EXISTS|托管目录已存在/.test(value)) category = '托管目录已存在';
  else if (/SOURCE_EMPTY|没有可导入文件/.test(value)) category = '没有可导入的文档';
  else if (/GIT_SCHEME_UNSUPPORTED|不支持明文 http|不支持该 Git 传输协议|本地目录请使用 --source/.test(value)) category = 'Git 地址或协议不受支持';
  else if (/INVALID_BRANCH|分支名非法|只支持远端分支/.test(value)) category = 'Git 分支不可用';
  else if (/CLONE_FAILED|clone 失败/.test(value)) category = 'Git 克隆失败';
  else if (/SCOPE_OPERATION_BUSY|已有导入或还原任务/.test(value)) category = '同一知识库已有写入任务，请等待后重试';
  else if (/embedding\.apiKey|API[_ -]?KEY.*未配置/i.test(value)) category = 'Embedding API Key 未配置或不可用';
  else if (/VECTOR_DIMENSION_MISMATCH|维度.*(?:不匹配|变化)|dimension mismatch/i.test(value)) category = '当前 embedding 与已有向量集合维度不匹配';
  else if (/\b(?:HTTP[_ ]?(?:401|403)|UNAUTHORIZED|FORBIDDEN|鉴权失败)\b/i.test(value)) category = 'Embedding 服务鉴权失败';
  else if (/\b(?:HTTP[_ ]?429|RATE_LIMIT)\b|限流/i.test(value)) category = 'Embedding 服务限流';
  else if (/\b(?:HTTP[_ ]?400|20015)\b|参数无效/i.test(value)) category = 'Embedding 请求参数无效，请检查模型、批大小与输入';
  else if (/\b(?:TIMEOUT|ETIMEDOUT)\b|超时/i.test(value)) category = 'Embedding 服务请求超时';
  else if (/\b(?:ECONNREFUSED|ENOTFOUND|NETWORK)\b|provider unavailable|embedding unavailable|服务不可用/i.test(value)) category = 'Embedding 服务暂不可用';
  else if (/\bENOSPC\b|磁盘空间不足/i.test(value)) category = '存储空间不足';
  else if (/取消|CANCELLED/i.test(value)) category = '任务已取消';
  else if (/\bINVALID_SUBDIR\b|子目录不存在|子目录.*越出/i.test(value)) category = '仓库子目录不存在或不可用';
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
  const createdRaw = (Array.isArray(input.created) ? input.created : [])
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const group = safeRelPath(entry[0]);
      const relation = sanitizedText(entry[1], MAX_SNAPSHOT_TEXT);
      return group && relation ? [group, relation] as [string, string] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null);
  if (createdRaw.length > MAX_SNAPSHOT_CREATED) out.createdTruncated = true;
  const created = createdRaw.slice(0, MAX_SNAPSHOT_CREATED);
  if (created.length > 0) out.created = created;
  if (countish(input.createdTotal) !== undefined) out.createdTotal = countish(input.createdTotal);
  if (input.createdTruncated === true) out.createdTruncated = true;
  // 变更明细：与 created 同格式（二元组）、同白名单校验 —— 读侧不认就会把写入的字段丢掉
  const modifiedRaw = (Array.isArray(input.modified) ? input.modified : [])
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const group = safeRelPath(entry[0]);
      const relation = sanitizedText(entry[1], MAX_SNAPSHOT_TEXT);
      return group && relation ? [group, relation] as [string, string] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null);
  if (modifiedRaw.length > MAX_SNAPSHOT_MODIFIED) out.modifiedTruncated = true;
  const modified = modifiedRaw.slice(0, MAX_SNAPSHOT_MODIFIED);
  if (modified.length > 0) out.modified = modified;
  if (countish(input.modifiedTotal) !== undefined) out.modifiedTotal = countish(input.modifiedTotal);
  if (input.modifiedTruncated === true) out.modifiedTruncated = true;
  if (input.truncated === true) out.truncated = true;
  if (input.syncTaskId === null) out.syncTaskId = null;
  else if (typeof input.syncTaskId === 'string' && TASK_ID_RE.test(input.syncTaskId)) out.syncTaskId = input.syncTaskId;
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
  const trimmed: TaskRecord = { ...record, result: withoutDetails };
  if (sizeOf(trimmed) <= limit) return trimmed;
  /**
   * 变更明细先于新建明细裁（两级都保留 total ⇒ 页面仍能显示「共 N 篇，明细未保留」）。
   * ★ 必须进这条链：只加字段不裁剪的话，超预算时它不会被删 → 文件仍 > 32KB →
   *   `readRecordFile` 判不可读 → 任务从列表静默消失。
   */
  const withoutModified: TaskResultSnapshot = { ...withoutDetails };
  // 只在「本来真的有变更明细」时才标 truncated：否则一个从未有过变更的任务
  // 被裁到这里会显示「明细未完整显示」，把"没有"说成"丢了"。
  const hadModified = Array.isArray(withoutModified.modified);
  delete withoutModified.modified;
  const trimmedModified: TaskRecord = {
    ...record,
    result: { ...withoutModified, ...(hadModified ? { modifiedTruncated: true } : {}) },
  };
  if (sizeOf(trimmedModified) <= limit) return trimmedModified;
  // 新建明细放在最后砍：它是用户主动要看的（「新增了哪些目录」），
  // 但宁可丢明细也不能让整个任务文件超限（超了任务会从列表静默消失）
  const withoutCreated: TaskResultSnapshot = { ...withoutModified };
  delete withoutCreated.created;
  return {
    ...record,
    // created 侧保持既有语义（原实现无条件标记），只让 modified 这一档按实际情况标
    result: { ...withoutCreated, ...(hadModified ? { modifiedTruncated: true } : {}), createdTruncated: true },
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
      || !['cli', 'daemon', 'web', 'scheduler'].includes(parsed.source)
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
    /** 发起者快照；缺省 = legacy（旧调用方/旧任务） */
    operator?: TaskOperator;
    /** 重试血缘：本任务重试自哪个任务（缺省 = 非重试任务） */
    retryOf?: string;
  },
): TaskReporter {
  const now = Date.now();
  const operator = sanitizeOperator(input.operator);
  const record: TaskRecord = {
    id: input.id ?? crypto.randomUUID(),
    source: input.source,
    ...(operator ? { operator } : {}),
    operation: sanitizedText(input.operation, 80) ?? 'unknown',
    scope: sanitizedText(input.scope, 120) ?? 'unknown',
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    ...(typeof input.retryOf === 'string' && TASK_ID_RE.test(input.retryOf) ? { retryOf: input.retryOf } : {}),
  };
  writeRecord(config, record, true);
  /**
   * [S-02] 任务运行日志：**原始**错误落这里（task JSON 只存 `safeErrorSummary` 压缩后的类别）。
   * ★ 刻在 reporter 内部接入 —— 10 个调用点零改动，新增入口自动获得日志（见设计 S-02 D-5）。
   * ★ writer 为 null（目录不可写 / 磁盘满 / 符号链接）时全部退化为 no-op，绝不影响任务执行。
   */
  const log: TaskLogWriter | null = createTaskLogWriter(config, {
    id: record.id,
    source: record.source,
    operation: record.operation,
    scope: record.scope,
    createdAt: record.createdAt,
    pid: process.pid,
    ...(record.operator?.label ? { operator: record.operator.label } : {}),
  });
  log?.event('queued');
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
    /**
     * [S-02] 只记**状态 / 阶段迁移**（writer 内部按 state+phase 去重）：
     * 心跳 `update({})`（5s）与纯进度更新不产生任何日志 IO。
     * ★ 错误原文不在这里记 —— 只在 `finish()` 写，避免压缩版与原文两处混写。
     */
    log?.event(updated.state, updated.phase !== undefined ? { phase: updated.phase } : undefined);
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
      /**
       * [S-02] 终态日志：`options.error` 是 `safeErrorSummary` **压缩之前**的原文 ——
       * 这正是本子需求存在的意义（task JSON 存类别、日志存原文）。
       * 顺序：先记状态迁移（让 writer 的内部去重对齐，随后 `update()` 里的 event 会跳过），
       * 再记错误详情。两行语义不同：卡在哪一步 + 为什么。
       * 先写日志再写台账：台账写失败会进 `pendingFinish` 重试，日志只记一次事实。
       */
      log?.event(state, {
        ...(record.phase ? { phase: record.phase } : {}),
        ...(options.errorCode !== undefined ? { code: options.errorCode } : {}),
      });
      if (options.error) log?.error(options.errorCode, options.error, options.recoveryHint);
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
    note: (text: string) => {
      log?.note(text);
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      log?.close();
    },
  };
}

/**
 * 台账目录溢出（文件数 > `maxFiles`）时的**按数量删档**，返回删除条数。
 * 导出仅为单测覆盖（`listTaskRecords` 唯一调用方，不要从别处调用）。
 *
 * **为什么需要这一段**：`listTaskRecords` 原先只按保留期删过期文件。保留期还是 1 小时时，
 * 超 1 万个文件意味着 1 小时内产生 1 万个任务，删过期几乎必然把数量降下来——能自愈。
 * 保留期改成 7 天后，阈值同样是 7 天：若 7 天内累积超 1 万个文件，**一个都不算过期**，
 * 清理后仍然超限 ⇒ 抛 `TASK_REGISTRY_LIMIT`（503），而且不会自愈（新任务还在产生）。
 * 这一段按 mtime 从旧到新删到 `maxFiles - margin`，把"永久不可读"变回"最旧的先让位"。
 *
 * ★ **不碰 `keepRecentMs` 内修改过的文件**：活任务的心跳每 5s 刷新 mtime，
 *   按数量硬删会把正在跑的任务记录删掉（任务还在跑、记录却没了，比报错更糟）。
 *   因此极端情况（全部都是新文件）仍会走到 503 —— 有意的 fail-loud，不是漏改。
 */
export function pruneOverflowingTaskDir(
  dir: string,
  maxFiles: number,
  keepRecentMs: number,
  margin = 1_000,
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => TASK_FILE_RE.test(name));
  } catch {
    return 0;
  }
  if (names.length <= maxFiles) return 0;
  const entries: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, mtimeMs: stat.mtimeMs });
    } catch { /* 并发 owner 可能刚替换或删除文件 */ }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const target = Math.max(0, maxFiles - margin);
  const now = Date.now();
  let remaining = entries.length;
  let removed = 0;
  for (const entry of entries) {
    if (remaining <= target) break;
    if (now - entry.mtimeMs < keepRecentMs) break;
    try {
      fs.unlinkSync(entry.file);
      remaining -= 1;
      removed += 1;
    } catch { /* next read retries */ }
  }
  return removed;
}

export function listTaskRecords(config: Pick<KiConfig, 'dataDir'>, limit = MAX_TASK_FILES): TaskRecord[] {
  let dir: string;
  try {
    dir = ensureTaskDir(config);
  } catch (error) {
    throw Object.assign(new Error(`任务状态暂不可读：${(error as Error).message}`), { code: 'TASK_REGISTRY_UNAVAILABLE', status: 503 });
  }
  let names = fs.readdirSync(dir).filter((name) => TASK_FILE_RE.test(name));
  if (names.length > MAX_SCAN_FILES) {
    // ① 先按文件修改时间清理明显过期记录，避免大量旧文件让列表永久不可读。
    const threshold = Date.now() - TASK_TTL_MS;
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < threshold) fs.unlinkSync(file);
      } catch { /* 并发 owner 可能刚替换或删除文件 */ }
    }
    // ② 仍超限：按数量兜底（保留期口径删不掉时的唯一自愈路径，见函数注释）
    pruneOverflowingTaskDir(dir, MAX_SCAN_FILES, TASK_HEARTBEAT_TTL_MS);
    names = fs.readdirSync(dir).filter((name) => TASK_FILE_RE.test(name));
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
    if ((active && now - record.heartbeatAt > TASK_HEARTBEAT_TTL_MS)
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

/** 服务重启打断任务时的台账文案（写死，不经 `safeErrorSummary` 压缩，保证用户看到原话） */
const INTERRUPTED_ERROR = '任务在执行中被服务重启打断，结果未落定';
const INTERRUPTED_HINT = '重新发起该操作；已完成的部分不会回滚，重复执行按同名/幂等策略处理';

/**
 * 服务重启收尾：把上一个进程遗留的 `queued` / `running` 记录改判为 `failed`，注明中断原因。
 *
 * **为什么需要**：daemon 的 job 表是**进程内 Map**（`mcp-http-api.ts` 的 `jobs`），重启即全丢；
 * 而台账里的记录会永远停在 `running` —— 心跳随进程停止 ⇒ 30s 后读侧改判 `unknown`
 * ⇒ 1 小时后按心跳窗口**物理删除**。用户看到的是「转着转着变成状态未知，然后没了」，
 * 既不知道原因，也不知道该不该重发。
 *
 * **判据**：HTTP 单例锁保证启动瞬间本进程尚无任何任务 ⇒ 台账里所有非终态记录都属于
 * 已退出的进程，**一律改判**。刻意不按 `STALE_AFTER_MS` 筛：重启可能只要 2 秒，
 * 按 30s 阈值筛会漏掉"刚重启"的记录，而那条记录同样永远不会再跑。
 *
 * **不抛错**：台账问题不能挡住服务启动；单条失败只跳过该条（下次启动会再试）。
 * 返回被改判的任务 ID，供启动日志输出。
 */
export function markInterruptedTasks(config: Pick<KiConfig, 'dataDir'>): string[] {
  const marked: string[] = [];
  let dir: string;
  let names: string[];
  try {
    dir = ensureTaskDir(config);
    names = fs.readdirSync(dir).filter((name) => TASK_FILE_RE.test(name));
  } catch {
    return marked;
  }
  const now = Date.now();
  for (const name of names) {
    const id = name.slice(0, -5);
    const record = readRecordFile(path.join(dir, name), id);
    if (!record || (record.state !== 'queued' && record.state !== 'running')) continue;
    const next: TaskRecord = {
      ...record,
      state: 'failed',
      finishedAt: now,
      updatedAt: now,
      error: INTERRUPTED_ERROR,
      recoveryHint: INTERRUPTED_HINT,
      // 结构化错误码：让「重启中断」在数据层可判别（前端码表未收录时回落原文，不会吞文案）
      result: { ...record.result, errorCode: 'SERVICE_RESTART_INTERRUPTED' },
    };
    try {
      // 日志正文也留一行：排障时先看日志，只有台账记录会让人觉得"没跑过"
      const writer = createTaskLogWriter(config, {
        id: record.id,
        source: record.source,
        operation: record.operation,
        scope: record.scope,
        createdAt: record.createdAt,
        ...(record.operator?.label ? { operator: record.operator.label } : {}),
      });
      writer?.error('SERVICE_RESTART_INTERRUPTED', INTERRUPTED_ERROR, INTERRUPTED_HINT);
      writer?.close();
      writeRecord(config, next);
      marked.push(id);
    } catch { /* 单条失败不影响其余记录，也不阻断启动 */ }
  }
  return marked;
}

export function getTaskRecord(config: Pick<KiConfig, 'dataDir'>, id: string): TaskRecord | null {
  if (!TASK_ID_RE.test(id)) return null;
  let dir: string;
  try { dir = ensureTaskDir(config); } catch { return null; }
  const record = readRecordFile(path.join(dir, `${id}.json`), id);
  if (!record) return null;
  const now = Date.now();
  const active = record.state === 'queued' || record.state === 'running';
  if ((active && now - record.heartbeatAt > TASK_HEARTBEAT_TTL_MS)
    || (!active && now - (record.finishedAt ?? record.updatedAt) > TASK_TTL_MS)) return null;
  if (active && now - record.heartbeatAt > STALE_AFTER_MS) {
    return { ...record, state: 'unknown' };
  }
  return record;
}
