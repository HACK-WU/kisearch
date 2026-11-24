/**
 * 图集错误码与异常。
 *
 * 为什么单独一段 14xx 而不复用 governance-errors：
 * 图集不属于知识治理域（分类/生命周期/事件/回收站），混进去会让治理错误表失去边界；
 * 但号段必须与全局不冲突——1001~1011 生命周期、1101~1122 事件、1201~1202 可见性、
 * 1301~1312 回收站，14xx 空闲，图集独占。
 */
import type { AtlasZipEntry } from './types.js';

export const ATLAS_CODES = {
  /** zip 结构损坏 / 非 HTML / 缺 baked / 含外链 */
  PACKAGE_INVALID: 1401,
  /** 包内根目录没有 .html，或有多个 */
  ENTRY_NOT_FOUND: 1402,
  /** zip>20MB / 解压总量>50MB / entry>10MB */
  TOO_LARGE: 1403,
  /** 条目路径含 `..`、绝对路径、符号链接 */
  UNSAFE_ENTRY: 1404,
  /** 该 scope 尚未上传图集 */
  NOT_FOUND: 1405,
  /** 文件存在但损坏（0 字节 / meta 不可读） */
  CORRUPTED: 1406,
  /** zip64 / 加密 / 非 STORE|DEFLATE */
  UNSUPPORTED_ZIP: 1407,
} as const;

export type AtlasCodeKey = keyof typeof ATLAS_CODES;

/**
 * 对外错误码名：`ATLAS_` + key。
 * 必须带前缀——裸 `NOT_FOUND` 会和通用 404 混在一起，agent 按码分支时分不清是
 * 「图集没装」还是「路由不存在」（设计 S02 §3.4 的口径）。
 */
export function atlasCodeName(key: AtlasCodeKey): string {
  return `ATLAS_${key}`;
}

export class AtlasError extends Error {
  readonly code: number;
  readonly key: AtlasCodeKey;
  /** 可直接展示给用户的「下一步怎么办」 */
  readonly hint?: string;

  constructor(key: AtlasCodeKey, message: string, hint?: string) {
    super(message);
    this.name = 'AtlasError';
    this.key = key;
    this.code = ATLAS_CODES[key];
    this.hint = hint;
  }
}

/** 错误码 → HTTP 状态（HTTP 通道用；CLI 通道只用 code 与 hint） */
export function atlasHttpStatus(code: number): number {
  switch (code) {
    case ATLAS_CODES.NOT_FOUND:
      return 404;
    case ATLAS_CODES.CORRUPTED:
      return 500;
    case ATLAS_CODES.TOO_LARGE:
      return 413;
    default:
      return 400;
  }
}

/**
 * 对外文案的统一出口：带上错误码与可选条目清单。
 *
 * CLI 与 HTTP 都必须走这里，避免两处各拼一套文案（设计 D3：两条入口共用内核，
 * 文案分叉会让 agent 难以按错误码分支处理）。
 */
export function describeAtlasError(err: AtlasError, entries?: AtlasZipEntry[]): string {
  const head = `${err.message}（${atlasCodeName(err.key)} · ${err.code}）`;
  const parts = [head];
  if (err.hint) parts.push(`→ ${err.hint}`);
  if (entries && entries.length > 0) {
    const names = entries.slice(0, 8).map((e) => e.name).join(', ');
    parts.push(`包内条目：${names}${entries.length > 8 ? ` …共 ${entries.length} 个` : ''}`);
  }
  return parts.join('\n');
}
