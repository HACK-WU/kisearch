/**
 * import-upload-policy.ts —— 上传文件「逐条校验」的单一实现。
 *
 * 为什么独立成模块（与 `http-body.ts` 同一处置，勿搬回 `mcp-http-api.ts`）：
 *   1. **判据只能有一份**：事件参考文档上传（`governance-http.ts`）与
 *      `/api/import/upload` 必须按同一套规则判扩展名 / 大小 / 重名，
 *      各写一份必然漂移成「网页能传、事件页不能传」这类最难排的矛盾；
 *   2. **反向依赖会成环**：`mcp-http-api.ts` 已静态 import `governance-http.ts`，
 *      后者不能再 import 前者；校验逻辑放这里，两边都只单向依赖本模块。
 *
 * 文案契约：抛出的 `Error.message` **直接展示给用户**（前端逐条回显），改动前先确认调用方。
 */

import path from 'node:path';

/** 一次上传请求的校验口径（由 scope 的 import 配置解析而来） */
export interface UploadFilePolicy {
  /** 文档扩展名白名单（含点，大小写不敏感） */
  extensions: string[];
  /** 附件扩展名（含点）；`assetsEnabled=false` 时忽略 */
  assetExtensions: string[];
  assetsEnabled: boolean;
  /** 单文档上限（字节） */
  maxFileSizeBytes: number;
  /** 单附件上限（字节） */
  maxAssetSizeBytes: number;
  /**
   * 是否允许子目录（缺省 `true`）。
   *
   * 事件参考文档上传传 `false`：需求明确「不能上传目录」。前端只给文件选择器，
   * 但接口是公开的 —— 名字里带 `/` 或 `\` 的请求必须在服务端拒掉。
   */
  allowSubdirs?: boolean;
}

export interface UploadFileInput {
  name?: string;
  content?: string;
}

export interface ValidatedUploadFile {
  /** 净化后的落盘名（可能含子目录） */
  name: string;
  buf: Buffer;
  isAsset: boolean;
}

/**
 * 只允许相对路径文件名（支持子目录），拒绝绝对路径与穿越。
 *
 * ★ 保留在 `mcp-http-api.ts` 的既有具名导出（`open-api/upload-stream.ts` 在用），
 *   这里定义、那边再导出一次，不另起第二份实现。
 */
export function sanitizeFileName(name: string): string {
  const normalized = path.normalize(name);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`非法的文件名（拒绝路径穿越）：${name}`);
  }
  return normalized;
}

/**
 * 校验单个上传文件，返回待落盘的内容。
 *
 * 判定顺序与原 `/api/import/upload` 逐字一致（改顺序会改变用户看到的错误文案）：
 *   文件名非空 → （禁子目录）→ 扩展名白名单 → base64 解码 → 大小上限 → 文件名净化 → 批内重名。
 *
 * @param seen 本批已通过校验的名字集合。**本函数只读不写** —— 由调用方在真正落盘成功后
 *   再 `seen.add(v.name)`，保持"写失败不算重复"的既有语义。
 */
export function validateUploadFile(
  input: UploadFileInput,
  policy: UploadFilePolicy,
  seen: Set<string>,
): ValidatedUploadFile {
  const name = input.name ?? '';
  const content = input.content ?? '';
  if (!name) throw new Error('缺少文件名');

  if (policy.allowSubdirs === false && (name.includes('/') || name.includes('\\'))) {
    throw new Error(`不支持上传目录或子路径（${name}）；请只选择文件`);
  }

  const ext = path.extname(name).toLowerCase();
  const allowedExt = new Set(policy.extensions.map((e) => e.toLowerCase()));
  const assetExt = new Set(policy.assetExtensions.map((e) => e.toLowerCase()));
  const isDocument = allowedExt.has(ext);
  const isAsset = policy.assetsEnabled && assetExt.has(ext);
  if (!isDocument && !isAsset) {
    const assetHint = policy.assetsEnabled ? `；附件允许 ${[...assetExt].join('/')}` : '';
    throw new Error(`不支持的扩展名（${ext || '(无)'}），文档仅允许 ${[...allowedExt].join('/')}${assetHint}`);
  }

  const buf = Buffer.from(content, 'base64');
  const maxBytes = isAsset ? policy.maxAssetSizeBytes : policy.maxFileSizeBytes;
  if (buf.length > maxBytes) {
    throw new Error(`文件超过大小上限（${Math.round(maxBytes / 1024)}KB）`);
  }

  const safeName = sanitizeFileName(name);
  if (seen.has(safeName)) {
    throw new Error(`当前请求包含重复相对路径：${safeName}`);
  }
  return { name: safeName, buf, isAsset };
}
