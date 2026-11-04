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

/**
 * 一条「仓库子目录 → 落点 Group」映射（REQ-20261104-002）。
 *
 * - `subdir`：仓库内相对路径，空串 = 仓库根；
 * - `group`：落点 Group 前缀，null = 按该子目录内的顶层目录自动命名。
 */
export interface DataSourceMappingItem {
  subdir: string;
  group: string | null;
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
  /**
   * 落点 Group（**单值兼容位**）。
   *
   * 多映射记录下它等于 `mappings[0].group`；判断"本次用的是哪套落点"一律看
   * {@link mappings}，不要用这个字段 —— 它只为了让旧读方（旧页面 / 旧 CLI）不崩。
   */
  group: string | null;
  /** 本次同步实际使用的映射快照（REQ-20261104-002；旧快照缺省 = 由 group 合成 1 条） */
  mappings?: DataSourceMappingItem[];
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

/** 一次同步的结果快照（页面详情据此渲染，不读 TTL 到期即清的任务台账） */
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
  /**
   * 本次**变更**的文档（走了 `overwrite` 覆盖重写路径的）。
   * ★ 只记文档标识，**不含内容与差异**（用户 2026-11-04 定：后端不采集被修改的内容）。
   * 上限沿用导入侧 `MAX_MODIFIED_DETAIL`，完整条数见 `modifiedTotal`。
   */
  modified?: { group: string; relation: string }[];
  modifiedTotal?: number;
  modifiedTruncated?: boolean;
  conflicts: { path: string; relation: string; action: string; unchanged?: boolean }[];
  failures: { path: string; reason: string }[];
}

export interface DataSourceLastSync {
  at: number;
  durationMs: number;
  state: DataSourceSyncState;
  /** 对应任务台账（7 天内可查；过期不影响本快照） */
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
  /**
   * 3 = 支持多映射（REQ-20261104-002）；2 = 单子目录 + 单落点。
   * 读入时 v2 自动迁移为「1 条映射」，写回时一律 v3。
   */
  version: 3;
  scope: string;
  /** directory = 普通目录（全量）；git = 仓库（增量） */
  type: DataSourceKind;
  /**
   * 绝对路径（add 时 resolve，~ 已展开）。
   *
   * ★ 多映射下它是 **`mappings[0]` 的目录**（兼容位）：`checkSourceDir`、待删路径、
   *   CLI list 等既有消费方读这一处，换掉它们的读取口径收益远小于风险。
   *   真正的目录集合请用 `mappings` + `git.repoRoot` 推导。
   */
  dir: string;
  /** type='git' 时必填 */
  git?: DataSourceGitInfo;
  /**
   * 落点 Group（**单值兼容位**，等于 `mappings[0].group`）。
   * 判断落点一律看 {@link mappings}；该字段只保证旧读方不崩。
   */
  group: string | null;
  /**
   * 映射列表（REQ-20261104-002）：1..N 条，至少 1 条。
   * `normalizeRecord` 保证它恒非空 —— 旧记录由 `git.relativeRoot` + `group` 合成。
   */
  mappings: DataSourceMappingItem[];
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
  /** 单值兼容位（= `mappings[0].group`） */
  group: string | null;
  /** 映射列表（1..N）。旧 daemon 不下发 → 页面降级为 1 条并置灰编辑 */
  mappings: DataSourceMappingItem[];
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

