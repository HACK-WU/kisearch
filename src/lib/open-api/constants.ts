/**
 * 第三方开放 API（`/open/v1/*`）的常量单一真相。
 *
 * 只放「跨模块必须一致」的值：路径前缀、默认上限。放在独立文件而不是散在
 * config-schema / mcp-http 里，是因为同一组数字要被配置校验、lock 回显、
 * `/open/v1/ping` 的 limits 三处共用 —— 三份拷贝必然漂移。
 *
 * 命名空间与鉴权语义见 design/S01；流式接收与上限语义见 design/S02。
 */

/** 第三方程序 API 的 URL 前缀（与 `/api/*`、`/mcp` 平级隔离） */
export const OPEN_API_PREFIX = '/open/v1';

/**
 * 上传接口单次请求体上限的默认值（512MB）。
 *
 * ★ 只约束**传输字节**，不约束 tar 解包后的体积 —— 解包侧的规模由
 * `S-02 §3.5` 的三重闸门单独把关，不能用本值代替。
 */
export const DEFAULT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

/**
 * `mcp.http.uploadMaxBytes` 的合法上界（4GiB）。
 *
 * 取 4GiB 而不是更大：单次请求的临时磁盘峰值 = 包 + 解包内容，上界继续放大会让
 * 一次手滑的上传打满磁盘；4GiB 与导入内核的单批总字节默认值
 * （`import-budget.ts` 的 `DEFAULT_MAX_BATCH_BYTES`）对齐，不会出现
 * 「传得进来但导不进去」的组合。
 */
export const MAX_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * 上传通道的路径前缀（开关只拦这里，`/open/v1/ping` 不受影响）。
 *
 * 单独成常量是因为「哪些路径算上传」必须与「开关关掉后 404 的范围」严格一致：
 * 手工拼字符串的写法在加了 `import/status` 之后很容易漏掉一条。
 */
export const OPEN_API_UPLOAD_PATH = `${OPEN_API_PREFIX}/import`;

/**
 * 只读取件端点（2026-11-24 · REQ-20261124-002）：附件原始字节 + 文档正文与附图清单。
 *
 * 与 `OPEN_API_UPLOAD_PATH` 语义相反：`downloadApi` 关闭时这**两个**路径一律 404
 * （不泄露接口存在性），`ping` / `events` 不受影响。
 */
export const OPEN_API_READ_PATHS: readonly string[] = [
  `${OPEN_API_PREFIX}/asset`,
  `${OPEN_API_PREFIX}/doc`,
] as const;

/**
 * `/open/v1` 契约版本：**破坏性变更**才 +1，与 `package.json` 的发布版本解耦
 * （否则每次发版都等于宣称契约变更，客户端无法据此判断兼容性）。
 *
 * 客户端口径：字段缺失视为 `0` = 不支持任何取件能力 → 报 `CONTRACT_TOO_OLD`。
 */
export const CONTRACT_VERSION = 1;

/** `ping` 回显的能力位：客户端据此决定能不能取件、按什么上限分块 */
export interface OpenApiCapabilities {
  download: {
    /** `GET /open/v1/asset` 是否可用 */
    asset: boolean;
    /** `GET /open/v1/doc` 是否可用 */
    doc: boolean;
  };
  /** 单附件上限（与 `limits.maxAssetSize` 同源同值）；`null` = 该基准库未配置 */
  maxAssetSize: number | null;
}

/**
 * 第三方 API 错误码（按子需求号段划分，防撞码）。
 *
 * 号段：S-01（命名空间与鉴权）10xx / S-02（流式接收与导入）11xx / S-03（开关）12xx。
 * 响应体统一 `{ ok: false, code, error }`；`code` 是给程序分支用的稳定标识，
 * `error` 才是给人看的文案 —— agent 侧不要靠文案匹配。
 */
export type OpenApiErrorCode =
  // S-01 鉴权与路由
  | 'OPEN_API_TOKEN_REQUIRED'
  | 'OPEN_API_TOKEN_INVALID'
  | 'OPEN_API_TOKEN_READONLY'
  | 'OPEN_API_SCOPE_FORBIDDEN'
  | 'OPEN_API_NOT_FOUND'
  | 'OPEN_API_METHOD_NOT_ALLOWED'
  | 'OPEN_API_INTERNAL'
  /** daemon 身份漂移（409）：重试无用，必须重启 daemon（文案里给的路由就是出路） */
  | 'OPEN_API_DAEMON_DRIFT'
  /** 参数缺失/非法（400）：如缺少 taskId、scope 拼错 */
  | 'OPEN_API_BAD_REQUEST'
  /** 把视图名当 scope 写入（400）：视图是只读的检索范围，不是可写落点 */
  | 'OPEN_API_VIEW_NOT_WRITABLE'
  /**
   * 把视图名当 scope 读取（400，2026-11-24 · REQ-20261124-002）：
   * 视图在 MCP 侧可用、在取件侧不可寻址 —— 必须给区分性文案，
   * 否则用户看到「文档不存在」会误判数据丢失（推演 P3）。
   */
  | 'OPEN_API_VIEW_UNSUPPORTED'
  /**
   * 附件路径越界（403）：group 段非法（`..` / `.` / 空段 / 绝对路径）或 ref 解析越出 assets 目录。
   * 与 404 区分：403 表示「你给的路径本身不合法」，404 表示「路径合法但文件不在」。
   */
  | 'OPEN_API_PATH_FORBIDDEN'
  /**
   * 端点已注册但实现未就绪（501）。
   * 仅出现在骨架期（REQ-20261124-002 前置层），S-02 / S-03 填充实现后不再返回。
   */
  | 'OPEN_API_NOT_IMPLEMENTED'
  // S-02 上传与导入（W6/W7 使用）
  | 'OPEN_API_UNSUPPORTED_CONTENT_TYPE'
  | 'OPEN_API_BAD_MULTIPART'
  | 'OPEN_API_PAYLOAD_TOO_LARGE'
  | 'OPEN_API_NO_VALID_FILE'
  | 'OPEN_API_ARCHIVE_UNSAFE'
  | 'OPEN_API_ARCHIVE_TOO_LARGE'
  | 'OPEN_API_ARCHIVE_BROKEN'
  | 'OPEN_API_TASK_NOT_FOUND'
  | 'OPEN_API_INVALID_CHUNK'
  | 'OPEN_API_DUPLICATE_CONTENT'
  | 'OPEN_API_STORAGE_FAILED'
  | 'OPEN_API_SCOPE_READONLY'
  /**
   * 分类参数非法（400，2026-11-16）：`lifecycle` 取值不在 wiki/temp/event、
   * `temp` 缺 `ttlDays`、`wiki` 带了伴随字段、`ttlDays` 越界或 `event` 缺失。
   * `extra.reason` 给内部码（`TTL_REQUIRED` 等），便于精确分支。
   */
  | 'OPEN_API_INVALID_LIFECYCLE'
  /** 绑定的事件不存在（400）：`extra.available` 列出未收口事件（最多 5 个） */
  | 'OPEN_API_EVENT_NOT_FOUND'
  /** 绑定的事件已收口（400）：已收口事件不再接收新文档 */
  | 'OPEN_API_EVENT_CLOSED';
