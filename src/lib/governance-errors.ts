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
  /** 文档已绑在另一个**未收口**事件上：禁止静默改绑 */
  DOC_BOUND_TO_OTHER_EVENT: 1117,
  /** 单事件关联文档数超上限（MEMBER_LIMIT） */
  EVENT_MEMBER_LIMIT_EXCEEDED: 1118,
  /** `docs` 参数非法（缺失/非数组/元素缺字段）；空数组不算错 */
  EVENT_DOCS_INVALID: 1119,

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
  /** 跨库引用的范围校验（REQ-20261116-005）：运行期剔除走响应字段，保存配置时才用它报错 */
  FIND_TARGET_NOT_AUTHORIZED: 1407,
  /** 引用的目标文档在源库不存在（防伪造路径写进 refs.json 变成永远解析不到的脏引用） */
  REF_DOC_NOT_FOUND: 1408,
  /** 目标文档被**已收口**事件锁在不可检索阶段：加入后 AI 也永远读不到（未收口则放行） */
  REF_DOC_NOT_SEARCHABLE: 1409,
  /**
   * @deprecated 二期（find-runner）上线后不再返回；保留码位只为老前端 / 老日志能识别。
   * 语义：一期只有 fast 时，收到 `mode:'deep'` 显式拒绝而不是静默按 fast 跑。
   */
  FIND_DEEP_NOT_READY: 1410,
  /** 未知查找模式（不是 fast / deep） */
  FIND_MODE_INVALID: 1411,

  // ── 参考文档上传（REQ-20261118-001，1412-1416）──
  /** 请求里没有文件（`files` 为空或缺失） */
  REF_UPLOAD_NO_FILE: 1412,
  /** 单次文件数超上限（10）：显式拒绝而不是截断（截断会让人以为全传了） */
  REF_UPLOAD_TOO_MANY: 1413,
  /** 逐个文件校验失败（扩展名 / 大小 / 带路径 / 重名 / 图片附件）；`details.files` 给逐条原因 */
  REF_UPLOAD_INVALID_FILE: 1414,
  /** 落点 Group 非法（绝对路径 / `..` / 保留根键 `__root__`） */
  REF_UPLOAD_GROUP_INVALID: 1415,
  /** 请求体无法解析或超过 16MB 上限 */
  REF_UPLOAD_BAD_REQUEST: 1416,

  // ── S-03 深度查找门禁与预算（REQ-20261116-005 二期）──
  /** 未配置模型 / 模型不可用 */
  FIND_LLM_UNAVAILABLE: 1420,
  /** 未确认知识库内容外发 */
  FIND_DISCLOSURE_REQUIRED: 1421,
  /** 模型不支持工具调用 */
  FIND_TOOLS_UNSUPPORTED: 1422,
  /** `find.tools` 全关（不空转） */
  FIND_TOOLS_ALL_DISABLED: 1423,
  /** 同一事件已有深度查找在跑（**直接拒绝不复用**：查找是一次性交互） */
  FIND_BUSY: 1424,
  /** 日配额用尽 —— @deprecated 2026-11-18 每日额度取消，本码**不再抛出**（保留仅为码表稳定） */
  FIND_QUOTA_EXCEEDED: 1425,
  /** 硬超时且无候选（有候选时走 200 + `partial`） */
  FIND_TIMEOUT: 1426,
  /** 用户中止（前端已关闭，仅用于把 abort 与超时区分开） */
  FIND_CANCELED: 1427,
  /** 排队等待超过上限（同事件串行；不无限等） */
  FIND_QUEUE_TIMEOUT: 1428,

  /** 通用 / 传输层（1500-1599）── */
  /** Token 无权访问该 scope（HTTP 层 403；**不复用** DATASOURCE_LIFECYCLE_LOCKED，
   *  否则前端会弹「数据源文档锁」的错误文案） */
  FORBIDDEN_SCOPE: 1501,
  /** 文档不存在（分类变更 / 恢复等按文档定位的操作） */
  DOC_NOT_FOUND: 1502,

  // ── 事件源码分析（REQ-20261113-003 · S-03，1600-1699）──
  ANALYSIS_ALREADY_RUNNING: 1601,
  ANALYSIS_TARGET_NOT_CONFIGURED: 1602,
  ANALYSIS_TARGET_UNREADABLE: 1603,
  ANALYSIS_TOOLS_ALL_DISABLED: 1604,
  ANALYSIS_DISCLOSURE_REQUIRED: 1605,
  ANALYSIS_LLM_UNAVAILABLE: 1606,
  ANALYSIS_TOOLS_UNSUPPORTED: 1607,
  /** 用户主动停止（不是错误，但要能被前端按 code 区分文案） */
  ANALYSIS_CANCELED: 1614,
  /** 追问（B2）：问题为空或超长（4000 字） */
  ANALYSIS_ASK_QUESTION_TOO_LONG: 1615,
  /** 追问：60s 内超过 10 次（与 `ki_ask` 共用窗口） */
  ANALYSIS_ASK_RATE_LIMITED: 1616,
  /** 追问：进程级并发闸已满（与 `ki_ask` 共享，最多 2 个在途） */
  ANALYSIS_ASK_BUSY: 1617,
  /** 追问：硬超时（45s）且未产出任何内容 */
  ANALYSIS_ASK_TIMEOUT: 1618,
  /** @deprecated 2026-11-18 每日额度取消，本码**不再抛出**（保留仅为码表稳定） */
  ANALYSIS_RATE_LIMITED: 1608,
  ANALYSIS_TARGET_SYNCING: 1609,
  ANALYSIS_DRAFT_NOT_FOUND: 1610,
  ANALYSIS_LOCATION_NOT_FOUND: 1611,
  EVENT_DESCRIPTION_TOO_LONG: 1612,
  ANALYSIS_INTERRUPTED: 1613,
} as const;

export type GovernanceErrorCode = keyof typeof GOVERNANCE_CODE_NUMBERS;

/** 该类错误默认的 HTTP 状态码（4xx 一律可对外暴露；5xx 需上层决定是否脱敏） */
/**
 * 错误码 → HTTP 状态（**唯一一张表**）。
 *
 * 历史坑（2026-11-17 真机发现）：`governance-http` 曾另有一份本地 `STATUS_BY_CODE`，
 * 新增错误码时只改这边，接口实际仍返回 400（契约写 409）。两表合并后，
 * 新增码只需改这里。
 */
const HTTP_STATUS: Partial<Record<GovernanceErrorCode, number>> = {
  FORBIDDEN_SCOPE: 403,
  DOC_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  TYPE_NOT_FOUND: 404,
  TRASH_NOT_FOUND: 404,
  REF_NOT_FOUND: 404,
  FIND_TARGET_NOT_AUTHORIZED: 403,
  REF_DOC_NOT_FOUND: 404,
  REF_DOC_NOT_SEARCHABLE: 409,
  FIND_DEEP_NOT_READY: 400,
  FIND_MODE_INVALID: 400,
  FIND_LLM_UNAVAILABLE: 503,
  FIND_DISCLOSURE_REQUIRED: 409,
  FIND_TOOLS_UNSUPPORTED: 409,
  FIND_TOOLS_ALL_DISABLED: 400,
  FIND_BUSY: 409,
  FIND_QUOTA_EXCEEDED: 429,
  FIND_TIMEOUT: 504,
  FIND_CANCELED: 499,
  FIND_QUEUE_TIMEOUT: 429,
  // ── 治理域历史码（原先只在 governance-http 的本地表里，2026-11-17 合并至此单表）──
  RESTORE_NAME_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  TYPE_IN_USE: 409,
  TYPE_BUILTIN: 409,
  EVENT_CLOSED: 409,
  EVENT_NOT_CLOSED: 409,
  DATASOURCE_LIFECYCLE_LOCKED: 403,
  ANALYSIS_ALREADY_RUNNING: 409,
  ANALYSIS_TARGET_SYNCING: 409,
  ANALYSIS_DISCLOSURE_REQUIRED: 403,
  ANALYSIS_DRAFT_NOT_FOUND: 404,
  ANALYSIS_LOCATION_NOT_FOUND: 404,
  ANALYSIS_RATE_LIMITED: 429,
  ANALYSIS_ASK_QUESTION_TOO_LONG: 400,
  ANALYSIS_ASK_RATE_LIMITED: 429,
  ANALYSIS_ASK_BUSY: 429,
  ANALYSIS_ASK_TIMEOUT: 504,
  ANALYSIS_LLM_UNAVAILABLE: 503,
  REF_LIMIT_EXCEEDED: 409,
  DOC_BOUND_TO_OTHER_EVENT: 409,
  EVENT_MEMBER_LIMIT_EXCEEDED: 409,
  SEARCH_UNAVAILABLE: 503,
  TRASH_WRITE_FAILED: 500,
};

/**
 * 治理域统一错误。
 *
 * `message` 必须自解释（MCP 客户端只看到这段文本），`details` 放可机器消费的引导，
 * 例如 `EVENT_NOT_FOUND` 附 `available: [{id, shortId, title}]`，让 AI 能自我纠正而不是重试。
 */
/** 取某错误码对应的 HTTP 状态（未列入的按 400 契约错误） */
export function httpStatusFor(code: string): number {
  return (HTTP_STATUS as Record<string, number | undefined>)[code] ?? 400;
}

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
