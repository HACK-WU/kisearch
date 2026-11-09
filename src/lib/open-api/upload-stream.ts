/**
 * 上传接收：把 HTTP 字节流落成「干净的内容目录」，交给导入内核。
 *
 * 两条分支（design S-02 §3.4）落点**必须完全相同**：
 *
 *   <uploadId>/
 *   ├── .scope                 ← scope 绑定（复用 /api 的 bindUploadScope）
 *   ├── .upload-session.json   ← 会话状态（含 jobId，见下）
 *   ├── content/               ← ★ 唯一的 sourceDir（两分支都落这里）
 *   └── .upload.tar.gz         ← 仅 tar 分支解包期间的临时文件，完成即删
 *
 * 为什么 content/ 不能省：`handleDirectImport` 的 `sourcePath` 在「sourceDir 是目录」时
 * 取相对路径，与 uploadId 无关 ⇒ 重传同结构目录是幂等覆盖；若 sourceDir 是单个文件，
 * `sourcePath` 会变成含 uploadId 的绝对路径 ⇒ 每次重试都产生副本。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getScopeImportConfig, resolveImportExtensions, type KiConfig } from '../config.js';
import { DEFAULT_MAX_FILE_SIZE_BYTES } from '../import.js';
import { isGnuTar, tarPath, tarPathArgs } from '../tar-compat.js';
import { assertSafeTarListing, readTarListing, validateTree, type TarListing } from '../safe-tar.js';
import { bindUploadScope, getUploadsRoot, sanitizeFileName, writeUploadSession } from '../mcp-http-api.js';
import { MultipartError, parseMultipart, type FileStartDecision } from './multipart.js';
import { MAX_UPLOAD_MAX_BYTES } from './constants.js';

/** 上传会话（一次请求 = 一个 uploadId） */
export interface UploadSessionDir {
  uploadId: string;
  /** `~/.ki/import-uploads/<uploadId>` */
  dir: string;
  /** `<dir>/content` —— 永远是目录，作为 handleDirectImport 的 sourceDir */
  contentDir: string;
}

export interface SkippedSample {
  rel: string;
  reason: string;
}

export interface ReceivedUpload extends UploadSessionDir {
  totalBytes: number;
  saved: number;
  skipped: number;
  /** 跳过原因样本，最多 {@link MAX_SKIPPED_SAMPLE} 条（全量在服务端日志） */
  skippedSample: SkippedSample[];
}

/** 跳过样本上限：A10 要求「最多 10 条原因样本」，同时也是 Token 预算（响应 ≤2KB）的保障 */
export const MAX_SKIPPED_SAMPLE = 10;

/** 归档闸门上限（design S-02 §3.5） */
const MAX_ARCHIVE_ENTRIES = 20_000;
/** 解包总量相对**传输字节**的上限倍数：与 4GiB 取小，构成本通道的磁盘硬边界 */
const UNPACK_RATIO = 10;
/**
 * 压缩比「可疑」阈值（仅作病态包的早期拦截，不是磁盘边界）。
 *
 * 为什么不是设计里写的 10：实测 300 个纯文本 markdown（每篇正文大量重复句式）打成 tar.gz 后
 * 是 `9215 字节 → 844090 字节`，即 **91 倍** —— gzip 对重复度高的文本轻松超过 10 倍，
 * 用 10 会**误拒正常文档包**（已真机复现）。真正的磁盘边界由上面的
 * `min(uploadMaxBytes × 10, 4GiB)` 绝对上限保证，本条只需挡住"千倍级"的病态包。
 */
const SUSPICIOUS_RATIO = 200;
/** 解包目录与文件权限：只给本用户 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 创建上传会话目录（两个分支共用），并绑定 scope */
export function createUploadSession(scope: string): UploadSessionDir {
  const uploadId = crypto.randomUUID();
  const dir = path.join(getUploadsRoot(), uploadId);
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(contentDir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
    fs.chmodSync(contentDir, DIR_MODE);
  } catch { /* 平台不支持时忽略（Windows） */ }
  if (!bindUploadScope(dir, scope)) {
    throw new ArchiveError('OPEN_API_DUPLICATE_CONTENT', `上传目录的 scope 绑定冲突（${uploadId}）；请重试`);
  }
  writeSession(dir, scope, 'uploading');
  return { uploadId, dir, contentDir };
}

/** 写会话状态（`state`/`jobId` 是两个消费方：惰性清理与前端「找回任务」） */
export function writeSession(
  dir: string,
  scope: string,
  state: 'uploading' | 'importing' | 'done' | 'failed',
  jobId?: string,
): void {
  writeUploadSession(dir, {
    scope,
    updatedAt: Date.now(),
    state,
    ...(jobId ? { jobId } : {}),
  });
}

/** 删除整个上传会话（失败/中断时调用，保证「零落盘」） */
export function cleanupUpload(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不遮盖原始错误 */ }
}

/** 归档类错误（映射到 400 + 明确错误码） */
export class ArchiveError extends Error {
  constructor(
    readonly code:
      | 'OPEN_API_ARCHIVE_UNSAFE'
      | 'OPEN_API_ARCHIVE_TOO_LARGE'
      | 'OPEN_API_ARCHIVE_BROKEN'
      | 'OPEN_API_DUPLICATE_CONTENT',
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

interface ReceiveOptions {
  config: KiConfig;
  scope: string;
  uploadMaxBytes: number;
}

/**
 * multipart 分支：逐文件流式落盘。
 *
 * 单文件失败（越界/扩展名/超上限）**只跳过该文件**，整包继续 —— 目录里混一个超大文件
 * 就全废的体验不可接受（design S-02 D-08），代价是必须把跳过原因明确回传给 agent。
 */
export async function receiveMultipart(
  req: import('node:http').IncomingMessage,
  boundary: string,
  opts: ReceiveOptions,
): Promise<ReceivedUpload> {
  const session = createUploadSession(opts.scope);
  const extensions = resolveImportExtensions(opts.config, opts.scope).map((e) => e.toLowerCase());
  const maxFileSize = getScopeImportConfig(opts.config, opts.scope)?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  const handles = new Map<string, number>();
  const sample: SkippedSample[] = [];
  // 用集合而不是计数器：同一请求里出现同名文件时（客户端重复 -F），落盘只有一份，
  // 报给调用方的 saved 也必须是「文件数」而不是「part 数」。
  const savedRels = new Set<string>();
  let skipped = 0;

  const recordSkip = (rel: string, reason: string): void => {
    skipped++;
    if (sample.length < MAX_SKIPPED_SAMPLE) sample.push({ rel, reason });
    else process.stderr.write(`[open-api] 跳过（样本已满）：${rel} —— ${reason}\n`);
  };

  const sink = {
    onFileStart(rawRel: string): FileStartDecision {
      const check = normalizeRelPath(rawRel);
      if (!check.ok) return { reject: check.reason };
      const rel = check.rel;
      const lower = rel.toLowerCase();
      if (!extensions.some((ext) => lower.endsWith(ext))) {
        return {
          reject: `扩展名不支持，文档仅允许 ${extensions.join(' / ')}（可在 scopes.<scope>.import.extensions 中调整）`,
        };
      }
      const abs = path.join(session.contentDir, rel);
      if (!abs.startsWith(session.contentDir + path.sep)) {
        return { reject: '路径越界（解析后不在上传目录内）' };
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: DIR_MODE });
        // 同名重发（curl 重复 -F 或客户端重试）：先关旧句柄再覆盖。
        // 不关会泄漏 fd（上万次即 EMFILE），且旧句柄继续指向同一 inode 但不再被写入。
        const previous = handles.get(rel);
        if (previous !== undefined) {
          try { fs.closeSync(previous); } catch { /* 已关闭 */ }
          handles.delete(rel);
        }
        const fd = fs.openSync(abs, 'w', FILE_MODE);
        handles.set(rel, fd);
      } catch (err) {
        // 客户端给的名字可能超长 / 含系统不允许的字符：这只该跳过该文件，
        // 不该让整包 500（错误来自用户输入，不是服务端故障）。
        return { reject: `无法写入该文件：${(err as Error).message}` };
      }
      return { accept: { absPath: abs, maxBytes: maxFileSize } };
    },
    onFileChunk(rel: string, chunk: Buffer): void {
      const fd = handles.get(rel);
      if (fd === undefined) return;
      fs.writeSync(fd, chunk);
    },
    onFileEnd(rel: string): void {
      const fd = handles.get(rel);
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
        handles.delete(rel);
      }
      savedRels.add(rel);
    },
    onFileRejected(rel: string, reason: string): void {
      const fd = handles.get(rel);
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
        handles.delete(rel);
      }
      // 半截文件必须删掉：否则「被跳过的文件」会以残缺内容参与后续导入
      try {
        const abs = path.join(session.contentDir, rel);
        if (abs.startsWith(session.contentDir + path.sep)) fs.rmSync(abs, { force: true });
      } catch { /* 忽略 */ }
      recordSkip(rel, reason);
    },
  };

  try {
    const result = await parseMultipart(req, boundary, sink, { maxTotalBytes: opts.uploadMaxBytes });
    // 收流异常退出时可能有未关闭的句柄
    for (const fd of handles.values()) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    handles.clear();
    return {
      ...session,
      totalBytes: result.totalBytes,
      saved: savedRels.size,
      skipped,
      skippedSample: sample,
    };
  } catch (err) {
    for (const fd of handles.values()) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    cleanupUpload(session.dir);
    throw err;
  }
}

/**
 * tar.gz 分支：流式落包 → 三重闸门 → 解包 → 复检符号链接。
 *
 * `uploadMaxBytes` 只约束**传输字节**，解包后体积由闸门单独把关（zip-bomb 防护）。
 */
export async function receiveTar(
  req: import('node:http').IncomingMessage,
  opts: ReceiveOptions,
): Promise<ReceivedUpload> {
  const session = createUploadSession(opts.scope);
  const tarFile = path.join(session.dir, '.upload.tar.gz');
  const extensions = resolveImportExtensions(opts.config, opts.scope).map((e) => e.toLowerCase());

  try {
    const totalBytes = await streamToFile(req, tarFile, opts.uploadMaxBytes);

    // ①② 同一份清单只读一遍：越界/链接校验 + 条目数与解包体积统计
    //     （512MB 的包每多跑一次 `tar -tzf` 就多解压一次整个流，不能各校验各读）
    let listing: TarListing;
    try {
      listing = readTarListing(tarFile);
    } catch (err) {
      // 底层错误里含 tar 命令行与**服务端本地绝对路径**，只进日志，不回给调用方。
      process.stderr.write(`[open-api] 归档读取失败：${(err as Error).message}\n`);
      throw new ArchiveError(
        'OPEN_API_ARCHIVE_BROKEN',
        '归档无法解析：可能不是 tar.gz，或文件在传输中损坏。若你上传的是单个文件，请改用 multipart/form-data（curl -F "files=@a.md"）',
      );
    }
    try {
      assertSafeTarListing(listing);
    } catch (err) {
      throw new ArchiveError('OPEN_API_ARCHIVE_UNSAFE', (err as Error).message);
    }

    // ② zip-bomb 闸门：条目数 + 解包总量（含压缩比）
    const archive = inspectArchive(listing);
    if (archive.entries > MAX_ARCHIVE_ENTRIES) {
      throw new ArchiveError(
        'OPEN_API_ARCHIVE_TOO_LARGE',
        `归档条目数 ${archive.entries} 超过上限 ${MAX_ARCHIVE_ENTRIES}`,
        { entries: archive.entries, entriesLimit: MAX_ARCHIVE_ENTRIES },
      );
    }
    const unpackLimit = Math.min(opts.uploadMaxBytes * UNPACK_RATIO, MAX_UPLOAD_MAX_BYTES);
    if (archive.unpackedBytes !== null) {
      if (archive.unpackedBytes > unpackLimit) {
        throw new ArchiveError(
          'OPEN_API_ARCHIVE_TOO_LARGE',
          `解包后约 ${archive.unpackedBytes} 字节，超过上限 ${unpackLimit}（传输 ${totalBytes} 字节）。`
          + '超过 mcp.http.uploadMaxBytes 的 10 倍视为可疑压缩包，请调大上限或分批上传',
          { unpackedBytes: archive.unpackedBytes, unpackLimit, totalBytes },
        );
      }
      if (totalBytes > 0 && archive.unpackedBytes > totalBytes * SUSPICIOUS_RATIO) {
        throw new ArchiveError(
          'OPEN_API_ARCHIVE_TOO_LARGE',
          `压缩比异常（传输 ${totalBytes} 字节 → 解包 ${archive.unpackedBytes} 字节，超过 ${SUSPICIOUS_RATIO} 倍），已拒收。`
          + '正常的 markdown/图片归档远达不到该倍数；若确有超高压缩比的文本包，请分批上传',
          { unpackedBytes: archive.unpackedBytes, totalBytes },
        );
      }
    } else {
      process.stderr.write('[open-api] 当前 tar 非 GNU 实现，跳过解包体积预检（仍受条目数与解包后扫描约束）\n');
    }

    // ③ 解包 → 复检符号链接
    try {
      execFileSync('tar', [...tarPathArgs(), '-xzf', tarPath(tarFile), '-C', tarPath(session.contentDir)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      // 同上：解包失败的真实原因可能带本地路径，只进日志
      process.stderr.write(`[open-api] 归档解包失败：${(err as Error).message}\n`);
      throw new ArchiveError('OPEN_API_ARCHIVE_BROKEN', '归档解包失败（文件损坏或格式不支持），请重新用 `tar czf - -C ./docs .` 打包后再传');
    }
    const contentReal = fs.realpathSync(session.contentDir);
    try {
      validateTree(session.contentDir, contentReal);
    } catch (err) {
      throw new ArchiveError('OPEN_API_ARCHIVE_UNSAFE', (err as Error).message);
    }

    // ④ 扫描统计（saved/skipped 与 multipart 分支保持同一口径，便于 agent 统一处理）
    const { saved, skipped, skippedSample, unpackedBytes } = scanContent(session.contentDir, extensions);
    if (unpackedBytes > unpackLimit) {
      throw new ArchiveError(
        'OPEN_API_ARCHIVE_TOO_LARGE',
        `解包后实际占用 ${unpackedBytes} 字节，超过上限 ${unpackLimit}`,
        { unpackedBytes, unpackLimit },
      );
    }

    if (saved === 0) {
      cleanupUpload(session.dir);
      return { ...session, totalBytes, saved: 0, skipped, skippedSample };
    }
    return { ...session, totalBytes, saved, skipped, skippedSample };
  } catch (err) {
    cleanupUpload(session.dir);
    throw err;
  } finally {
    // 包本身不再需要（解包内容已在 content/）；失败路径上面已整目录清理
    try { if (fs.existsSync(tarFile)) fs.rmSync(tarFile, { force: true }); } catch { /* 忽略 */ }
  }
}

/** 把请求体流式写盘，边写边计字节；超上限立刻中断并抛 413 */
async function streamToFile(
  req: import('node:http').IncomingMessage,
  file: string,
  maxBytes: number,
): Promise<number> {
  const fd = fs.openSync(file, 'w', FILE_MODE);
  let total = 0;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      total += chunk.length;
      if (total > maxBytes) {
        throw new MultipartError(
          'OPEN_API_PAYLOAD_TOO_LARGE',
          `请求体超过上限 ${maxBytes} 字节（已收 ${total} 字节）。`
          + '可调大 mcp.http.uploadMaxBytes；若经过反向代理，还需同步调大其 client_max_body_size',
          { actual: total, limit: maxBytes },
        );
      }
      fs.writeSync(fd, chunk);
    }
    return total;
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

interface ArchiveInspection {
  entries: number;
  /** 解包后总字节；非 GNU tar 无法可靠解析 → null（调用方退化为保守策略） */
  unpackedBytes: number | null;
}

/** 用已读出的清单算条目数 + 解包总字节（不重新解包；体积仅 GNU tar 可解析） */
function inspectArchive(listing: TarListing): ArchiveInspection {
  const entries = listing.entries.length;
  if (entries === 0) throw new ArchiveError('OPEN_API_ARCHIVE_BROKEN', '归档为空（没有可导入的文件）');

  if (!isGnuTar()) return { entries, unpackedBytes: null };
  let sum = 0;
  let parsed = 0;
  for (const line of listing.verboseLines) {
    // GNU 布局：<mode> <owner/group> <size> <yyyy-mm-dd> <hh:mm> <name>
    const m = /^\S{10}\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s/.exec(line);
    if (!m) continue;
    sum += Number(m[1]);
    parsed++;
  }
  return { entries, unpackedBytes: parsed === 0 ? null : sum };
}

/** 扫描解包后的内容：统计可导入文件、跳过明细与实际占用字节 */
function scanContent(
  root: string,
  extensions: string[],
): { saved: number; skipped: number; skippedSample: SkippedSample[]; unpackedBytes: number } {
  let saved = 0;
  let skipped = 0;
  let unpackedBytes = 0;
  const sample: SkippedSample[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      // 链接条目已在条目级校验被拒；这里仍跳过（不导入、不跟随）
      if (!entry.isFile()) continue;
      const size = fs.statSync(abs).size;
      unpackedBytes += size;
      if (extensions.some((ext) => rel.toLowerCase().endsWith(ext))) {
        saved++;
      } else {
        skipped++;
        if (sample.length < MAX_SKIPPED_SAMPLE) {
          sample.push({ rel, reason: `扩展名不支持，文档仅允许 ${extensions.join(' / ')}` });
        }
      }
    }
  };
  walk(root, '');
  return { saved, skipped, skippedSample: sample, unpackedBytes };
}

/** 相对路径校验：拒绝绝对路径 / `..` / 空段；返回归一后的 posix 路径 */
function normalizeRelPath(input: string): { ok: true; rel: string } | { ok: false; reason: string } {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw) return { ok: false, reason: '文件名为空' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, reason: '拒绝绝对路径（filename 必须是相对路径）' };
  }
  const segments = raw.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return { ok: false, reason: '路径越界（含 .. / 空段 / . 段）' };
  }
  let rel: string;
  try {
    rel = sanitizeFileName(segments.join('/'));
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true, rel: rel.split(path.sep).join('/') };
}
