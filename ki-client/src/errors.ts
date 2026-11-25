/**
 * 客户端错误码（与服务的 `OPEN_API_*` 分开：那一层是服务端契约，这一层是本工具自己的判定）。
 *
 * 约定：**code 给程序分支，message 给人看，hint 给出路**。
 * 任何 fail-loud 的判定都必须同时给 hint，否则用户只知道"失败了"。
 */

export type ClientErrorCode =
  /** `--remote` / `KI_REMOTE` 指的名字不在配置里 */
  | 'UNKNOWN_REMOTE'
  /** 配了多个源，但这次没指定用哪个（本工具刻意不设默认源） */
  | 'NO_REMOTE_SPECIFIED'
  /** 连不上、超时、DNS 失败等传输层问题 */
  | 'REMOTE_UNREACHABLE'
  /** 该源没有可用 token（配置里没有，环境变量也没有） */
  | 'TOKEN_MISSING'
  /** 服务端契约版本过低（或字段缺失视为 0），缺少本命令需要的能力 */
  | 'CONTRACT_TOO_OLD'
  /** 配置文件解析失败 / 形状不合法 / 权限异常 */
  | 'CONFIG_INVALID'
  /** 服务端返回了非 2xx 且无法归类 */
  | 'SERVER_ERROR'
  /** 落盘时目标已存在且没给 --overwrite */
  | 'FILE_EXISTS'
  /** 命令行用法错误 */
  | 'USAGE';

export class ClientError extends Error {
  readonly code: ClientErrorCode;
  readonly hint?: string;

  constructor(code: ClientErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/** 统一出口：把 ClientError 渲染成 `错误码 + 文案 + 出路`，其他异常原样抛给上层兜底 */
export function formatError(err: unknown): string {
  if (err instanceof ClientError) {
    const lines = [`错误 ${err.code}：${err.message}`];
    if (err.hint) lines.push(`出路：${err.hint}`);
    return lines.join('\n');
  }
  return `未预期错误：${(err as Error)?.message ?? String(err)}`;
}
