/**
 * 附件引用的归一化与双锚点路径解析（REQ-20261124-002 前置层抽出）。
 *
 * 为什么从 `asset-image.ts` 抽出来：那个文件依赖 `import.js`（引用提取）与
 * `svg-raster.js`（worker_threads），而 `/open/v1/asset` 只需要"把 ref 解析成
 * 可读绝对路径"这一件事。直接从 `asset-image.js` import 会把导入内核与 SVG worker
 * 拉进 HTTP 模块图（`open-api/routes/ping.ts` 的动态 import 就为躲同一件事）。
 *
 * 本文件只依赖 `node:path` 与 `scope.js`（纯路径计算），可被 HTTP 层安全引用。
 *
 * ═══ 为什么归一化不能取 basename ═══
 * 实测（2026-11-23 抽样 consul / ai-docs 两个 scope）：导入侧把 `./assets/x.svg`
 * 原样复制进 `{group}/assets/`，落点是 `{group}/assets/assets/x.svg`（**双层**）——
 * 与 `/api/asset` 的 `path.join(assetsDir, decoded)` 恰好自洽。若这里取 basename，
 * 双层与 `assets/image/知识库录入/xxx.png` 这类子目录形态都会找不到文件。
 */

import path from 'node:path';

import { getAssetsDir, getKbDir } from './scope.js';

/** `scheme:` 形态（含 `http:` / `data:` / Windows 盘符 `C:`）—— 一律视为非本地引用 */
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 归一化结果。
 *
 * 刻意写成**判别联合**而不是「`ok: boolean` + 可选字段」：后者在 `if (!parsed.ok)` 之后
 * 拿不到 `rel: string` 的收窄，调用方只能靠 `!` 断言 —— 那种断言把"必然有值"的保证
 * 从类型系统搬进了人脑，改一处忘一处就会在运行时拼出 `undefined` 路径。
 */
export type ImageRefParse =
  | {
    ok: true;
    /** 归一化后的相对路径（posix 分隔、已 strip `./`）—— 也是回传给模型的 `ref` 与缓存 key 的一部分 */
    rel: string;
    /** 小写后缀（含点）；无后缀时为空串 */
    ext: string;
  }
  | {
    ok: false;
    /** 机器可读原因 */
    reason: 'empty' | 'external' | 'absolute' | 'traversal';
    /** 可读文案（可直接给模型看） */
    message: string;
  };

export type AssetPathOk = { ok: true; rel: string; absPath: string; ext: string };
export type AssetPathFail = {
  ok: false;
  reason: 'empty' | 'external' | 'absolute' | 'traversal' | 'invalid-group';
  message: string;
};

/** 文案里的原始引用可能很长（base64 data URI 之类），截断后再进错误信息 */
export function shorten(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 归一化文档正文里的图片引用。**纯字符串处理，不碰文件系统**（便于表驱动单测）。
 *
 * 规则：
 *   · 去查询串 / 锚点；URL 解码失败按原样（文件名含裸 `%` 时不至于永远失败）
 *   · `./` 前缀剥掉（累积多层也剥）
 *   · 协议形态（`https:` / `data:` / `C:`）与绝对路径一律拒 —— 前者模型取不到，后者越界
 *   · `path.posix.normalize` 后仍以 `..` 开头 ⇒ 越界
 *   · **不取 basename**（见文件头）
 */
export function normalizeImageRef(raw: string): ImageRefParse {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty', message: '图片引用为空' };

  let rest = trimmed.split(/[?#]/, 1)[0] ?? '';
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // 与 /api/asset 对称：解码失败按原样，不让一个裸 % 让整张图永远读不到
  }
  rest = rest.trim();
  if (!rest) return { ok: false, reason: 'empty', message: '图片引用为空' };

  if (PROTOCOL_RE.test(rest)) {
    return { ok: false, reason: 'external', message: `不支持外部地址（${shorten(rest)}）：只能引用知识库内的图片` };
  }
  if (path.posix.isAbsolute(rest) || path.win32.isAbsolute(rest)) {
    return { ok: false, reason: 'absolute', message: `不支持绝对路径（${shorten(rest)}）` };
  }

  while (rest.startsWith('./')) rest = rest.slice(2);

  const rel = path.posix.normalize(rest);
  if (rel === '..' || rel.startsWith('../') || rel.includes('/../')) {
    return { ok: false, reason: 'traversal', message: `引用越出 assets 目录（${shorten(trimmed)}）` };
  }
  if (!rel || rel === '.') return { ok: false, reason: 'empty', message: '图片引用为空' };

  return { ok: true, rel, ext: path.posix.extname(rel).toLowerCase() };
}

/**
 * 把引用解析成"实际可读的绝对路径"，同时完成两道越界防护：
 *
 *   锚点一：`assetsDir` 必须落在该 scope 的 KB 根内（`group` 被注入 `../` 时挡住）
 *   锚点二：`resolved` 必须落在 `assetsDir` 内（引用本身带 `..` 时挡住）
 *
 * 与 `/api/asset` 口径一致，差别只在返回结构化原因而非 HTTP 状态码。
 */
export function resolveAssetPath(scope: string, group: string, rawRef: string): AssetPathOk | AssetPathFail {
  const g = (group ?? '').trim();
  // group 原样进 path.join 会搬移锚点 → 拒绝绝对路径与含 `..` / `.` / 空段的 group
  if (!g || path.isAbsolute(g) || g.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) {
    return { ok: false, reason: 'invalid-group', message: `Group 不合法（${shorten(group || '(空)')}）` };
  }

  const parsed = normalizeImageRef(rawRef);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message };

  const kbRoot = path.resolve(getKbDir(scope));
  const assetsDir = path.resolve(getAssetsDir(scope, g));
  if (assetsDir !== kbRoot && !assetsDir.startsWith(kbRoot + path.sep)) {
    return { ok: false, reason: 'invalid-group', message: 'Group 解析后越出知识库根目录' };
  }

  const absPath = path.normalize(path.join(assetsDir, parsed.rel));
  if (absPath !== assetsDir && !absPath.startsWith(assetsDir + path.sep)) {
    return { ok: false, reason: 'traversal', message: `引用越出该 Group 的 assets 目录（${shorten(rawRef)}）` };
  }

  return { ok: true, rel: parsed.rel, absPath, ext: parsed.ext };
}
