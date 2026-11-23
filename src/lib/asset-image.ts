/**
 * 知识库图片读取内核（REQ-20261123-008 · B0）
 *
 * 职责只有三件：
 *   ① 归一化「文档正文里的图片引用」（DESIGN §6.4 六步）
 *   ② 双锚点校验（防路径穿越，与 `/api/asset` 同源口径）
 *   ③ 读字节 + 预检（魔数 / SVG 根元素）
 *
 * **不做**：栅格化（B3 `svg-raster.ts`）、上下文注入（B2 `tool-loop.ts`）、
 * 张数限流（工具层按 D6 做）—— 内核只回答"这张图能不能读到、字节是什么"。
 *
 * ═══ 为什么归一化不能取 basename ═══
 * 实测（2026-11-23 抽样 consul / ai-docs 两个 scope）：导入侧把 `./assets/x.svg`
 * 原样复制进 `{group}/assets/`，落点是 `{group}/assets/assets/x.svg`（**双层**）——
 * 与 `/api/asset` 的 `path.join(assetsDir, decoded)` 恰好自洽。若这里取 basename，
 * 双层与 `assets/image/知识库录入/xxx.png` 这类子目录形态都会找不到文件。
 *
 * ═══ 为什么不复用 `/api/asset` 的处理函数 ═══
 * 那个函数是 HTTP 处理器（写响应头、返回状态码），且对"外链形态"走的是 404 而非
 * 明确判协议。本模块要的是可被工具层调用的纯逻辑 + 结构化错误码，故独立实现同一套
 * 锚点校验；两者的一致性由测试锁定（`test/asset-image.test.ts` 与
 * `test/import-assets.test.ts` 的 `/api/asset` 用例共同覆盖）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAssetsDir, getKbDir } from './scope.js';
// 引用提取复用导入侧同源实现（已覆盖 markdown `![]()` 与 HTML `<img src>`、跳过代码围栏）
import { extractImageRefs } from './import.js';
// SVG 栅格化（worker_threads；同步 CPU 调用不能留在主线程）
import { rasterizeSvgFile, rasterCacheKey } from './svg-raster.js';

// ─── 常量 ───────────────────────────────────────────────

/** 附件后缀 → MIME（与 `/api/asset` 的 ASSET_MIME 同源；后缀集合对应 import.ts 的 ASSET_EXTENSIONS） */
export const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** 可直接发给上游视觉模型的位图后缀 */
export const RASTER_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * 需服务端栅格化后才能发给上游的后缀。
 * 上游对 `data:image/svg+xml` 直接 400（实测 `UnidentifiedImageError`），
 * 故 SVG 永远不能原样下发，只能交给 B3 渲染成 PNG。
 */
export const SVG_EXTS: ReadonlySet<string> = new Set(['.svg']);

/** 单张图片字节上限（与 REQ-20261123-006 的 `maxImageBytes` 默认一致） */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 预检读取的头部字节数 —— 足够容纳 PNG/JPEG/WebP 魔数与 SVG 的 `<svg` 根元素 */
const HEAD_BYTES = 512;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `scheme:` 形态（含 `http:` / `data:` / Windows 盘符 `C:`）—— 一律视为非本地引用 */
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

// ─── 类型 ───────────────────────────────────────────────

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg' | 'unknown';

export type ImageErrorCode =
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_FORMAT_UNSUPPORTED'
  | 'IMAGE_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_READ_FAILED';

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

export interface ResolvedImage {
  /** 归一化后的相对路径（与清单里的 `ref` 一致） */
  ref: string;
  mime: string;
  bytes: number;
  buffer: Buffer;
  /** 已通过预检的实际内容类型 */
  kind: Exclude<ImageKind, 'unknown'>;
}

export type ResolveResult =
  | { ok: true; image: ResolvedImage }
  | { ok: false; code: ImageErrorCode; message: string };

export interface ResolveOptions {
  /** 单张上限；缺省 4MB */
  maxBytes?: number;
}

// ─── ① 归一化 ───────────────────────────────────────────

/**
 * 归一化文档正文里的图片引用。**纯字符串处理，不碰文件系统**（便于表驱动单测）。
 *
 * 规则严格按 DESIGN §6.4：
 *   · 去查询串 / 锚点；URL 解码失败按原样（文件名含裸 `%` 时不至于永远失败）
 *   · `./` 前缀剥掉（累积多层也剥）
 *   · 协议形态（`https:` / `data:` / `C:`）与绝对路径一律拒 —— 前者模型取不到，后者越界
 *   · `path.posix.normalize` 后仍以 `..` 开头 ⇒ 越界
 *   · **不取 basename**（见文件头"为什么不能取 basename"）
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

// ─── ② 路径解析 + 双锚点 ────────────────────────────────

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

// ─── ③ 预检 ─────────────────────────────────────────────

/**
 * 按头部字节判定真实内容类型（**不信后缀**）。
 *
 * 预检的作用是避免"清单标 supported、取图才失败"让模型白扑空一轮（评审 N4）。
 * 它只读 512 字节，代价可忽略。
 */
export function detectImageKind(head: Buffer): ImageKind {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // SVG 是文本：可能带 BOM / XML 声明 / 注释，故不做前缀匹配，直接找根元素
  const text = head.toString('utf8', 0, Math.min(head.length, HEAD_BYTES)).toLowerCase();
  if (text.includes('<svg')) return 'svg';
  return 'unknown';
}

/** 后缀 → 期望的内容类型（用于"后缀与内容是否相符"的判定） */
function kindOfExt(ext: string): ImageKind | null {
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.svg') return 'svg';
  return null;
}

// ─── ④ 读取 ─────────────────────────────────────────────

/**
 * 读取一张图片的原始字节。
 *
 * 返回的 `kind` 决定上层怎么用：`raster` 系列可直接 base64 下发；`svg` 必须交给 B3 栅格化。
 * 本函数**不判断格式是否被上游接受**（那是调用方的事）—— 但会拒掉「后缀不在附件白名单」
 * 与「内容与后缀不符」两类，避免把二进制垃圾当图片发出去。
 */
export async function resolveAssetImage(
  scope: string,
  group: string,
  rawRef: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const resolved = resolveAssetPath(scope, group, rawRef);
  if (!resolved.ok) {
    return { ok: false, code: 'IMAGE_INVALID', message: resolved.message };
  }

  if (!ASSET_MIME[resolved.ext]) {
    return {
      ok: false,
      code: 'IMAGE_FORMAT_UNSUPPORTED',
      message: `不支持的附件类型（${resolved.ext || '无后缀'}）`,
    };
  }
  if (!RASTER_EXTS.has(resolved.ext) && !SVG_EXTS.has(resolved.ext)) {
    return {
      ok: false,
      code: 'IMAGE_FORMAT_UNSUPPORTED',
      message: `${resolved.ext} 暂不支持（当前仅 PNG / JPEG / WebP / SVG）`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved.absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 仅 ENOENT 判"不存在"；EACCES / EISDIR 等真实故障 fail-loud，不伪装成"没导入"
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'IMAGE_NOT_FOUND',
        message: `图片不在 assets 目录中（导入时可能未开启附件收集）：${resolved.rel}`,
      };
    }
    return { ok: false, code: 'IMAGE_READ_FAILED', message: `读取图片失败（${code}）：${resolved.rel}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'IMAGE_READ_FAILED', message: `不是普通文件：${resolved.rel}` };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      message: `图片 ${Math.round(stat.size / 1024)}KB 超过上限 ${Math.round(maxBytes / 1024)}KB`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(resolved.absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, code: 'IMAGE_READ_FAILED', message: `读取图片失败（${code}）：${resolved.rel}` };
  }

  const kind = detectImageKind(buffer.subarray(0, HEAD_BYTES));
  const expect = kindOfExt(resolved.ext);
  if (kind === 'unknown' || (expect !== null && kind !== expect)) {
    return {
      ok: false,
      code: 'IMAGE_INVALID',
      message: `文件内容与后缀不符（后缀 ${resolved.ext || '无'}，实际识别为 ${kind}）：${resolved.rel}`,
    };
  }

  return {
    ok: true,
    image: {
      ref: resolved.rel,
      mime: ASSET_MIME[resolved.ext] ?? 'application/octet-stream',
      bytes: buffer.length,
      buffer,
      kind,
    },
  };
}

/**
 * 批量读取（`ki_get_image` 的入参是 `refs[]`）。
 *
 * · **保持入参顺序**（调用方依赖"返回数组与 `refs` 同序"做展示与占位映射）
 * · 单个失败**不中断**整批 —— 让调用方能对失败项逐个给可读原因
 * · 串行执行：栅格化（B3）本身就串行，这里并发读文件也只会在 worker 队列上排队，
 *   反而让失败原因与顺序更难对齐
 */
export async function resolveAssetImages(
  scope: string,
  group: string,
  refs: readonly string[],
  opts: ResolveOptions = {},
): Promise<Array<{ ref: string; result: ResolveResult }>> {
  const out: Array<{ ref: string; result: ResolveResult }> = [];
  for (const ref of refs) {
    out.push({ ref, result: await resolveAssetImage(scope, group, ref, opts) });
  }
  return out;
}

// ─── ⑤ 清单（工具返回体用） ──────────────────────────────

/**
 * 工具返回体里的单个图片条目（DESIGN §6.1）。
 *
 * **不含 width/height**：清单阶段不解析图片头（D3）—— 尺寸由 `ki_get_image` 成功时附带。
 */
export interface ToolImageRef {
  /** 1-based，正文首次出现顺序（同 ref 重复引用只保留首个） */
  index: number;
  /** 归一化后的相对路径（原样回传给 `ki_get_image` 作为 `refs` 元素） */
  ref: string;
  mime?: string;
  bytes?: number;
  /** 是否可被取图（格式白名单 + 文件存在 + 预检通过，三者皆满足） */
  supported: boolean;
  /** `supported:false` 时的可读原因（可直接给模型看） */
  reason?: string;
}

/**
 * 从文档正文生成图片清单。
 *
 * 设计要点：
 * · 引用提取复用 `extractImageRefs`（import.ts，已覆盖 markdown 与 `<img src>`、跳过代码围栏）
 * · **按归一化后的 `ref` 去重**：同一张图在正文里可能被引用多次，模型不需要看到重复条目
 * · 单个条目出错不抛 —— 清单是附加信息，坏一张图不能让整篇文档读不出来
 * · 每个条目 1 次 `stat` + 1 次 512 字节读（预检），N 张图 = 2N 次 IO；N 通常 < 10，可接受
 */
export async function buildImageList(
  scope: string,
  group: string,
  markdown: string,
): Promise<ToolImageRef[]> {
  let rawRefs: string[];
  try {
    rawRefs = extractImageRefs(markdown);
  } catch {
    // 解析器异常不该让读文档失败（正文才是主产出）
    return [];
  }
  if (rawRefs.length === 0) return [];

  const seen = new Set<string>();
  const out: ToolImageRef[] = [];
  for (const raw of rawRefs) {
    const parsed = normalizeImageRef(raw);
    // 不合法的引用也列出来（标 supported:false + 原因）—— 让模型知道"这里本该有张图"
    const key = parsed.ok ? `ok:${parsed.rel}` : `bad:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!parsed.ok) {
      out.push({
        index: out.length + 1,
        ref: shorten(raw, 120),
        supported: false,
        reason: parsed.message,
      });
      continue;
    }
    const described = await describeImage(scope, group, parsed.rel, parsed.ext);
    out.push({ index: out.length + 1, ...described });
  }
  return out;
}

/** 单个条目的探查：不抛错，一切异常都折成 `supported:false` + 原因 */
async function describeImage(
  scope: string,
  group: string,
  rel: string,
  ext: string,
): Promise<Omit<ToolImageRef, 'index'>> {
  const base = { ref: rel };

  const resolved = resolveAssetPath(scope, group, rel);
  if (!resolved.ok) {
    return { ...base, supported: false, reason: resolved.message };
  }

  const mime = ASSET_MIME[ext];
  if (!mime) {
    return { ...base, supported: false, reason: `不支持的附件类型（${ext || '无后缀'}）` };
  }
  const isRaster = RASTER_EXTS.has(ext);
  const isSvg = SVG_EXTS.has(ext);
  if (!isRaster && !isSvg) {
    return { ...base, mime, supported: false, reason: `${ext} 暂不支持（仅 PNG / JPEG / WebP / SVG）` };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved.absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ...base,
      mime,
      supported: false,
      reason: code === 'ENOENT'
        ? '文件缺失（导入时可能未开启附件收集）'
        : `读取失败（${code}）`,
    };
  }
  if (!stat.isFile()) {
    return { ...base, mime, supported: false, reason: '不是普通文件' };
  }
  if (stat.size > DEFAULT_MAX_IMAGE_BYTES) {
    return {
      ...base,
      mime,
      bytes: stat.size,
      supported: false,
      reason: `超过单张上限（${Math.round(stat.size / 1024)}KB > ${Math.round(DEFAULT_MAX_IMAGE_BYTES / 1024)}KB）`,
    };
  }

  let head: Buffer;
  try {
    head = await readHead(resolved.absPath, HEAD_BYTES);
  } catch (err) {
    return { ...base, mime, bytes: stat.size, supported: false, reason: `读取失败（${(err as NodeJS.ErrnoException).code}）` };
  }
  const kind = detectImageKind(head);
  const expect = kindOfExt(ext);
  if (kind === 'unknown' || (expect !== null && kind !== expect)) {
    return { ...base, mime, bytes: stat.size, supported: false, reason: '文件疑似损坏（内容与后缀不符）' };
  }

  return { ...base, mime, bytes: stat.size, supported: true };
}

/** 只读文件头部 n 字节（预检用，不把整张图读进内存） */
async function readHead(absPath: string, n: number): Promise<Buffer> {
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ─── ⑥ 取图执行（对外 MCP 与内部对话共用） ──────────────

/**
 * 单张图片的载荷。**base64 只在调用栈内存里流转**：不落盘、不进 `tool_end` 事件、
 * 不写会话文件 —— 否则 4MB 图会把落盘体积放大数倍（DESIGN §6.3）。
 */
export interface ToolImagePayload {
  mimeType: string;
  /** 纯 base64（不带 `data:` 前缀） */
  data: string;
  /** 归一化后的相对路径，供模型/页面辨认是哪张 */
  ref: string;
  bytes: number;
  /** 仅在能确定时给出（位图读头 / SVG 栅格化输出） */
  width?: number;
  height?: number;
  /** SVG 栅格化时的来源格式；位图缺省 */
  sourceFormat?: string;
}

/** 取图结果（`kind` 是精确判别标记，见 chat/retrieval/tool-image.ts 的说明） */
export interface GetImageResult {
  kind: 'images';
  text: string;
  images: ToolImagePayload[];
}

/** 单次取图张数上限（DESIGN D6；与工具 schema 的 maxItems 保持一致） */
export const MAX_IMAGES_PER_CALL = 3;

export interface GetImageParams {
  scope: string;
  group: string;
  /** 1~3 个 ref（`images[].ref` 原样回传） */
  refs: readonly string[];
  maxBytes?: number;
  /**
   * 是否允许 SVG（B2 阶段为 false —— 栅格化在 B3 接入）。
   * 打开后 SVG 会走 `svg-raster`，未打开时返回可读的"暂不支持"。
   */
  allowSvg?: boolean;
}

/**
 * 取图执行层：把 `refs` 读成 base64 载荷，**部分失败不整体失败**。
 *
 * 返回 `text` 摘要里逐条说明成败 —— 让模型知道"3 张里第 2 张缺失"，而不是只看到 2 张图
 * 却以为本来就只有 2 张（DESIGN §7 的 fail-loud 口径）。
 */
export async function executeGetImage(params: GetImageParams): Promise<GetImageResult> {
  const { scope, group, refs } = params;
  const pairs = await resolveAssetImages(scope, group, refs, { maxBytes: params.maxBytes });

  const images: ToolImagePayload[] = [];
  const failures: Array<{ ref: string; code: string; message: string }> = [];

  for (const { ref, result } of pairs) {
    if (!result.ok) {
      failures.push({ ref, code: result.code, message: result.message });
      continue;
    }
    // SVG 不能原样下发（上游对 `data:image/svg+xml` 直接 400），必须服务端栅格化成 PNG
    if (result.image.kind === 'svg') {
      if (params.allowSvg !== true) {
        failures.push({
          ref,
          code: 'IMAGE_FORMAT_UNSUPPORTED',
          message: 'SVG 需服务端栅格化，当前调用未开启（该格式不能原样发给模型，会被上游拒绝）',
        });
        continue;
      }
      const located = resolveAssetPath(scope, group, ref);
      if (!located.ok) {
        failures.push({ ref, code: 'IMAGE_INVALID', message: located.message });
        continue;
      }
      const raster = await rasterizeSvgFile(located.absPath, rasterCacheKey(scope, group, located.rel));
      if (!raster.ok) {
        failures.push({ ref, code: raster.code, message: raster.message });
        continue;
      }
      images.push({
        mimeType: 'image/png',
        data: raster.png.toString('base64'),
        ref: result.image.ref,
        bytes: raster.png.length,
        width: raster.width,
        height: raster.height,
        sourceFormat: 'image/svg+xml',
      });
      continue;
    }
    images.push({
      mimeType: result.image.mime,
      data: result.image.buffer.toString('base64'),
      ref: result.image.ref,
      bytes: result.image.bytes,
    });
  }

  return {
    kind: 'images',
    text: summarizeGetImage(images, failures),
    images,
  };
}

/** 摘要文案：成功/失败都要说清，不能只报"读到了 N 张" */
function summarizeGetImage(
  images: readonly ToolImagePayload[],
  failures: readonly { ref: string; code: string; message: string }[],
): string {
  if (images.length === 0 && failures.length === 0) return '未读取任何图片（refs 为空）';
  const okPart = images.length > 0
    ? `已读取 ${images.length} 张图片：${images.map((i) => `${i.ref}（${i.mimeType}，${Math.round(i.bytes / 1024)}KB）`).join('、')}`
    : '没有成功读取任何图片';
  if (failures.length === 0) return okPart;
  const failPart = failures.map((f) => `${f.ref}：${f.message}`).join('；');
  return `${okPart}。以下 ${failures.length} 张未成功：${failPart}`;
}

// ─── 小工具 ─────────────────────────────────────────────

/** 文案里的原始引用可能很长（base64 data URI 之类），截断后再进错误信息 */
function shorten(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
