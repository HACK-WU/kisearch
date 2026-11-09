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
  | 'OPEN_API_SCOPE_READONLY';
