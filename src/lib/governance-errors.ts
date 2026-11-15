/**
 * 知识治理 · 错误码登记表（B0 冻结，之后只增不改）
 *
 * 设计来源：design/S06 §3.5（按子需求分段，防撞码）。
 * 对外契约用**语义字符串**（可 grep、可读）；数值仅作分配与撞码检测用，
 * 不出现在响应体里（见 S06 建议 N1 的取舍）。
 *
 * 新增错误码规则：
 *   1. 先在本表登记，号段必须落在对应子需求的区间内；
 *   2. 不得复用已存在的号；
 *   3. `test/governance-contract.test.ts` 会断言号唯一且区间正确。
 */

export const GOVERNANCE_CODE_NUMBERS = {
  // ── S-01 分类（1000-1099）──
  LIFECYCLE_INVALID: 1001,
  TTL_INVALID: 1002,
  TTL_REQUIRED: 1003,
  EVENT_REQUIRED: 1004,
  LIFECYCLE_ARG_CONFLICT: 1005,
  DATASOURCE_LIFECYCLE_LOCKED: 1006,
  PRESET_NAME_TAKEN: 1007,
  PRESET_BUILTIN: 1008,
  GROUP_DEFAULT_EVENT_UNSUPPORTED: 1009,
  LIFECYCLE_STATE_INVALID: 1010,
  /** 预设档位越界：`LifecyclePreset.kind` 只允许 wiki / temp（event 必须落到具体事件，预设表达不了） */
  PRESET_KIND_INVALID: 1011,

  // ── S-02 事件（1100-1199）──
  EVENT_NOT_FOUND: 1101,
  EVENT_CLOSED: 1102,
  EVENT_NOT_CLOSED: 1103,
  STAGE_NOT_FOUND: 1104,
  STAGE_DISABLED: 1105,
  STAGE_UNCHANGED: 1106,
  STAGE_DELETE_FORBIDDEN: 1107,
  TERMINAL_STAGE_CANNOT_DISABLE: 1108,
  TYPE_NOT_FOUND: 1109,
  TYPE_BUILTIN: 1110,
  TYPE_IN_USE: 1111,
  TYPE_STAGES_TOO_FEW: 1112,
  TYPE_STAGES_TOO_MANY: 1113,
  REVISION_CONFLICT: 1114,
  DOC_ACTION_REQUIRED: 1115,
  EVENT_STAGE_ORPHANED: 1116,

  // ── S-03 可见性（1200-1299）──
  VISIBILITY_INVALID: 1201,
  VISIBILITY_PARTIAL: 1202,

  // ── S-04 回收站（1300-1399）──
  TRASH_WRITE_FAILED: 1301,
  TRASH_NOT_FOUND: 1302,
  RESTORE_NAME_CONFLICT: 1303,
  RESTORE_REBUILD_FAILED: 1304,
  EMPTY_SELECTION: 1305,
  PURGE_CONFIRM_MISMATCH: 1306,
  TRASH_SETTINGS_INVALID: 1307,
  /** 快照拿不到正文：进站会得到空文档，必须中止删除（fail-closed） */
  TRASH_CONTENT_MISSING: 1308,

  // ── S-05 参考文档（1400-1499）──
  REF_ALREADY_ASSOCIATED: 1401,
  REF_ALREADY_ADDED: 1402,
  REF_NOT_FOUND: 1403,
  SEARCH_UNAVAILABLE: 1404,
  /** 参考文档条数超上限：此前误用 `REF_ALREADY_ADDED` 表达，语义错（不是"重复加入"） */
  REF_LIMIT_EXCEEDED: 1405,
  /** refs/search 收到 query：该路由已收窄为「只出 AI 候选」，手动按名搜索改走 /governance/docs/search */
  REF_SEARCH_QUERY_UNSUPPORTED: 1406,

  // ── 通用 / 传输层（1500-1599）──
  /** Token 无权访问该 scope（HTTP 层 403；**不复用** DATASOURCE_LIFECYCLE_LOCKED，
   *  否则前端会弹「数据源文档锁」的错误文案） */
  FORBIDDEN_SCOPE: 1501,
  /** 文档不存在（分类变更 / 恢复等按文档定位的操作） */
  DOC_NOT_FOUND: 1502,
} as const;

export type GovernanceErrorCode = keyof typeof GOVERNANCE_CODE_NUMBERS;

/** 该类错误默认的 HTTP 状态码（4xx 一律可对外暴露；5xx 需上层决定是否脱敏） */
const HTTP_STATUS: Partial<Record<GovernanceErrorCode, number>> = {
  FORBIDDEN_SCOPE: 403,
  DOC_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  TYPE_NOT_FOUND: 404,
  TRASH_NOT_FOUND: 404,
  REF_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  RESTORE_NAME_CONFLICT: 409,
  REF_LIMIT_EXCEEDED: 409,
  SEARCH_UNAVAILABLE: 503,
  TRASH_WRITE_FAILED: 500,
};

/**
 * 治理域统一错误。
 *
 * `message` 必须自解释（MCP 客户端只看到这段文本），`details` 放可机器消费的引导，
 * 例如 `EVENT_NOT_FOUND` 附 `available: [{id, shortId, title}]`，让 AI 能自我纠正而不是重试。
 */
export class GovernanceError extends Error {
  readonly code: GovernanceErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: GovernanceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 400;
    if (details) this.details = details;
  }

  toResponse(): { ok: false; code: GovernanceErrorCode; message: string; [k: string]: unknown } {
    return { ok: false, code: this.code, message: this.message, ...(this.details ?? {}) };
  }
}

/** 判断任意 error 是否治理域错误（HTTP 分发与 MCP 工具共用） */
export function isGovernanceError(err: unknown): err is GovernanceError {
  return err instanceof GovernanceError;
}
