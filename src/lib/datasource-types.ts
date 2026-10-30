/**
 * 数据源（REQ-20261020-001）持久化模型。
 *
 * 单一事实源：`<kbDir>/datasource.json`（每 scope 一个文件，一 scope 一源）。
 * 数据源**不写** `group-index.json.source`（Q-C 裁决）——切分参数只存这里。
 */
import type { ImportConflictMode } from './import-conflict.js';

export type DataSourceSyncState = 'ok' | 'partial' | 'failed' | 'cancelled';

export type DataSourceStaleReason = 'source-missing' | 'source-unreadable' | 'not-recomputed';

export type DataSourceKind = 'directory' | 'git';

export type DataSourceSyncMode = 'incremental' | 'full';

export type DataSourceScheduleMode = 'interval' | 'at';
export type DataSourceScheduleUnit = 'minute' | 'hour' | 'day';
export type DataSourceScheduleRepeat = 'once' | 'daily';

/**
 * 定时计划（S-01）。配置字段由页面写；运行态字段只由调度器写。
 * ★ 运行态写回不修改 `updatedAt`；并发保存用 `revision` 做乐观锁
 *   （不能用 `updatedAt`：每次同步都会更新它）。
 */
export interface DataSourceSchedule {
  enabled: boolean;
  mode: DataSourceScheduleMode;
  /** 周期模式：用户输入值（整数） */
  intervalValue: number | null;
  intervalUnit: DataSourceScheduleUnit | null;
  /** 指定时间模式：daemon 本地时间 'YYYY-MM-DDTHH:mm'（无时区） */
  at: string | null;
  /** 指定时间模式：仅一次 / 从 at 起每天重复 */
  repeat: DataSourceScheduleRepeat | null;
  /** 配置版本；每次页面保存 +1，用于多标签页乐观锁 */
  revision: number;
  /**
   * 启用锚点：由服务端在「关闭 → 开启」时写入（客户端不可写）。
   * ★ 周期模式必须有持久锚点：从未同步过的数据源没有 `lastSync.at`，
   *   若以 `now` 当基准，`nextRunAt` 会随每次读取向后滑，`due` 永远为 false ⇒ 永不触发。
   */
  enabledAt: number | null;

  consecutiveFailures: number;
  lastAutoAt: number | null;
  /** 最近一次已执行的槽位（daily 去重；once 判断是否已执行） */
  lastAutoFor: number | null;
  lastAutoState: DataSourceSyncState | null;
  lastSkipReason: string | null;
  lastSkipAt: number | null;
}

/** 页面可编辑字段（运行态字段不接受客户端写入） */
export interface DataSourceScheduleInput {
  enabled: boolean;
  mode: DataSourceScheduleMode;
  intervalValue: number | null;
  intervalUnit: DataSourceScheduleUnit | null;
  at: string | null;
  repeat: DataSourceScheduleRepeat | null;
  /** 乐观锁：打开弹窗时的 revision；缺省不校验（兼容旧页面） */
  baseRevision?: number;
}

/** 读接口下发的计划（附带服务端计算的下次运行时间） */
export interface DataSourceScheduleView extends DataSourceSchedule {
  nextRunAt: number | null;
}

export interface DataSourceGitInfo {
  /** 仓库根绝对路径（可能是 dir 的祖先） */
  repoRoot: string;
  /** dir 相对 repoRoot 的 posix 前缀；仓库根为 '' */
  relativeRoot: string;
  /** 当前分支；detached HEAD 为 null */
  branch: string | null;
  /** 远端 URL（已去凭据）；无 remote 为 null */
  remoteUrl: string | null;
  /** 是否工具托管的 clone（S-05） */
  managed: boolean;
  /** 托管 clone 配置的远端分支；非托管为 null */
  remoteBranch: string | null;
}

export interface DataSourceGitSyncState {
  /** 下次 diff 的水位：成功同步推进；partial/失败保持旧值 */
  commit: string | null;
  /** 本次自动更新完成后、扫描开始前的 HEAD */
  runCommit: string | null;
  shortCommit: string | null;
  subject: string | null;
  /** 提交时间（epoch ms） */
  authorTime: number | null;
  /** 本次进入 onlyRelPaths 的 tracked 变更数 */
  changedCount: number;
  /** 本次全量扫描到的可导入文件数 */
  fullScanned: number;
  /** 未跟踪且可导入的文件数（不参与增量） */
  untrackedMarkdown: number;
  /** 自动更新结果 */
  update: 'updated' | 'up-to-date' | 'skipped' | 'failed';
  updateDetail?: string;
  /** fetch 结果 */
  fetch: 'ok' | 'failed' | 'skipped';
  fetchDetail?: string;
}

export interface DataSourceWarning {
  code: string;
  message: string;
}

/** 同步参数快照（= 本次实际使用的登记参数） */
export interface DataSourceSyncParams {
  group: string | null;
  conflictMode: ImportConflictMode;
  vector: boolean;
  chunkSize: number | null;
  chunkOverlap: number | null;
  /** 新增；旧快照缺省按 full */
  mode?: DataSourceSyncMode;
}

export interface DataSourcePendingDeleteItem {
  group: string;
  relation: string;
  sourcePath?: string;
  /** 该组本次没有任何文件落入 */
  untouched?: boolean;
}

/**
 * 待删候选（同步时算出、**未执行**）。删除时服务端按当前源目录重算，
 * 并与这里的 `token` 比对；失配即 409。
 */
export interface DataSourcePendingDelete {
  /** 候选指纹（sha256 前 16 位）；`total>0` 即有（含超限，供分批删除） */
  token?: string;
  computedAt: number;
  total: number;
  /** 候选 > 单次上限（明细只给前 500） */
  overLimit: boolean;
  truncated: boolean;
  items: DataSourcePendingDeleteItem[];
  /**
   * 全量候选的 sourcePath（≤500 时等于 items；超限时是完整的 >500 条）。
   * 删除接口重算时以它（∪ 本次扫描）为基线——**不能用 seenRels**：
   * 同步成功后 seenRels 已更新为本次扫描，直接用它会把候选清零。
   */
  candidateSourcePaths: string[];
  untouchedGroups: string[];
  /** 库中无 sourcePath 的文档数（永不进候选） */
  unableCount: number;
  /** 候选基线内可判定文档数（闸门 B 分母 / 页面比例口径） */
  eligibleCount: number;
  /** 源目录不可读 / 本次未重算：保留上一版候选并标记 */
  stale: boolean;
  staleReason: DataSourceStaleReason | null;
  /** 'EMPTY_SOURCE' | 'GATE_COORD' | 'GATE_SCALE' | 'ERROR'（不产候选的原因） */
  blocked: string | null;
  skipDetail?: string;
}

/** 一次同步的结果快照（页面详情据此渲染，不读 1h TTL 的任务台账） */
export interface DataSourceResultSnapshot {
  files: {
    /** 导入管线本次处理基准（子集导入时 = 变更数） */
    scanned: number;
    /** 全量扫描数 */
    fullScanned: number;
    /** 本次变更数（全量同步 = fullScanned） */
    changed: number;
    completed: number;
    unchanged: number;
    skipped: number;
    incomplete: number;
    duplicatesSkipped: number;
  };
  vectorized: number;
  fullTextIndexed: number;
  groups: string[];
  /**
   * 本次**新建**的文档（`create` + `suffix`；`overwrite` 不计）。
   * 上限沿用导入侧 `MAX_CREATED_DETAIL`，完整条数见 `createdTotal`。
   */
  created?: { group: string; relation: string }[];
  createdTotal?: number;
  createdTruncated?: boolean;
  conflicts: { path: string; relation: string; action: string; unchanged?: boolean }[];
  failures: { path: string; reason: string }[];
}

export interface DataSourceLastSync {
  at: number;
  durationMs: number;
  state: DataSourceSyncState;
  /** 对应任务台账（1h 内可查；过期不影响本快照） */
  taskId?: string;
  params: DataSourceSyncParams;
  result: DataSourceResultSnapshot;
  /**
   * 候选基线：上一次**成功**（ok/partial）同步时全量扫描到的 rel 列表。
   * 候选只在它里面找（Q14）——避免把其他通道导入的文档列为待删。
   */
  seenRels: string[];
  pendingDelete: DataSourcePendingDelete;
  /** Git 数据源专有 */
  git?: DataSourceGitSyncState;
  /** 本次同步的可展示警告（fetch/update/untracked/fallback） */
  warnings?: DataSourceWarning[];
}

export interface DataSourceRecord {
  version: 2;
  scope: string;
  /** directory = 普通目录（全量）；git = 仓库（增量） */
  type: DataSourceKind;
  /** 绝对路径（add 时 resolve，~ 已展开） */
  dir: string;
  /** type='git' 时必填 */
  git?: DataSourceGitInfo;
  /** null = 按顶层子目录自动落点 */
  group: string | null;
  conflictMode: ImportConflictMode;
  conflictSuffix: string;
  /** false = --no-vector（仅 FTS） */
  vector: boolean;
  /** null = 默认 1000 */
  chunkSize: number | null;
  /** null = 默认 150 */
  chunkOverlap: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * 配置修订号：仅在**登记 / 编辑同步参数**时 +1。
   * 同步、定时保存、调度写回都不改它 —— 否则一次定时保存就会让打开中的编辑表单 409。
   * 旧记录缺省 = 0（normalizeRecord 补）。
   */
  revision: number;
  /** 定时计划（缺省 = 关闭；normalizeRecord 会补默认值） */
  schedule: DataSourceSchedule;
  lastSync: DataSourceLastSync | null;
}

/** `GET /api/datasource/list` 的一行（摘要素材） */
export interface DataSourceSummary {
  scope: string;
  type: DataSourceKind;
  dir: string;
  /** 列表摘要（不执行 git 命令；来自记录与 lastSync.git） */
  git?: {
    repoRoot: string;
    relativeRoot: string;
    branch: string | null;
    shortCommit: string | null;
    commitTime: number | null;
    untrackedMarkdown: number;
  };
  group: string | null;
  conflictMode: ImportConflictMode;
  vector: boolean;
  registeredAt: number;
  updatedAt: number;
  lastSync: {
    at: number;
    durationMs: number;
    state: DataSourceSyncState;
    files: DataSourceResultSnapshot['files'];
    pendingDelete: { total: number; overLimit: boolean; stale: boolean; blocked: string | null };
  } | null;
  running: boolean;
  stale: boolean;
  /** 定时计划视图（旧 daemon 不下发；页面据此隐藏入口） */
  schedule?: DataSourceScheduleView;
}

