/**
 * `ki-client upload` / `upload-dir` —— 把本地文档与附件推到远端 ki。
 *
 * ═══ 两条上传通道，按「内容与体积」自动选（见 `chooseChannel`）═══
 * - **multipart**：Node 内置 `FormData`，一个 part 一个文件。**只用于根目录的纯 markdown**
 *   （最快、无解包开销）。
 * - **tar.gz**：纯 Node 打 ustar + gzip（`lib/tar.ts`）。触发条件：`--archive`、单批 >32MB、
 *   **或批次里出现子目录/非 md 文件**。
 *
 * ⚠️ 最后那条是硬要求，不是优化：真机验证发现 **multipart 通道下附件一律不落盘**
 * （`{group}/assets/` 为空，md 导入成功、`errors: 0`，图静默变死链）；同一份内容改用
 * tar.gz 就正常。根因在服务端 `receiveMultipart` 一侧，客户端只能规避。
 *
 * 两条通道都受服务端 `mcp.http.uploadMaxBytes`（默认 512MB）约束，所以**超大目录靠分批**，
 * 不是靠压缩：`--batch-bytes`（默认 64MB）把文件切成多批，每批一个请求。
 *
 * ═══ 增量与「断点续传」的真实粒度 ═══
 * HTTP 协议层没有分片，请求中断就是整批丢。所以续传粒度是**文件级**：
 * 每个文件传成功后立刻记进 `~/.ki-client/state/<key>.json`，下次只补没记过的（或内容变了的）。
 * `--force` 忽略状态全传，`--no-state` 不读也不写状态。
 *
 * ═══ 目录结构靠 multipart filename / tar 内路径保留 ═══
 * 服务端对 filename 做相对路径校验（拒绝绝对路径 / `..` / 空段）后按 `<contentDir>/<rel>`
 * 落盘 —— 所以客户端**必须**把相对路径塞进 filename / tar 路径，否则 `sub/a.md` 会拍平，
 * 导入后的 Group 结构全错。
 */

import fs from 'node:fs';
import path from 'node:path';

import { ClientError } from '../errors.js';
import { getJson, pingRemote, postBinary, postMultipart } from '../http.js';
import { createTarGz } from '../lib/tar.js';
import { readState, sha256File, stateKey, writeState, type UploadState } from '../lib/state.js';
import type { ParsedArgs } from '../args.js';
import type { ResolvedRemote } from '../remote.js';

/** 与导入内核一致：正文只收 .md，附件只收白名单后缀（其余会在服务端被跳过） */
const DOC_EXT = '.md';
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif']);

/** 单批超过这个体积就走 tar.gz（压缩收益开始明显） */
const MULTIPART_MAX_BYTES = 32 * 1024 * 1024;
/** 默认分批阈值 */
const DEFAULT_BATCH_BYTES = 64 * 1024 * 1024;

interface PickedFile {
  /** 落盘相对路径（multipart 的 filename / tar 内的路径） */
  rel: string;
  abs: string;
  bytes: number;
  sha256: string;
}

interface BatchOutcome {
  index: number;
  files: number;
  bytes: number;
  channel: 'multipart' | 'tar.gz';
  taskId?: string;
  state?: string;
  error?: string;
}

interface UploadResponse {
  ok?: boolean;
  taskId?: string;
  accepted?: number;
  files?: { saved?: number; skipped?: number; skippedSample?: unknown[] };
}

/**
 * `/open/v1/import/status` 的真实结构（真机核对过，别按直觉改）：
 * `progress` 是 **0~1 的数字**（不是 `{percent}`）；`result` 用 `total / vectorized /
 * skipped / errors`（不是 `imported / failed`）。
 */
interface StatusResponse {
  ok?: boolean;
  state?: string;
  /** 处理阶段（如 persist） */
  phase?: string;
  /** 0 ~ 1 */
  progress?: number;
  error?: string;
  result?: {
    total?: number;
    vectorized?: number;
    skipped?: number;
    errors?: number;
    groups?: string[];
    groupsTotal?: number;
  };
}

function isWanted(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === DOC_EXT) return true;
  if (!ASSET_EXT.has(ext)) return false;
  // 附件只认 assets 目录下的（与导入侧「从文档相对引用收集附件」的口径一致）
  return /(^|[\\/])assets[\\/]/.test(file);
}

function collectFromDir(root: string): Array<{ rel: string; abs: string }> {
  const picked: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !isWanted(abs)) continue;
      picked.push({ rel: path.relative(root, abs).split(path.sep).join('/'), abs });
    }
  };
  walk(root);
  return picked.sort((a, b) => a.rel.localeCompare(b.rel));
}

function collectFromPaths(paths: string[]): Array<{ rel: string; abs: string }> {
  const picked: Array<{ rel: string; abs: string }> = [];
  for (const raw of paths) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) {
      throw new ClientError('USAGE', `文件不存在：${raw}`, '路径相对当前工作目录；目录用 upload-dir');
    }
    if (fs.statSync(abs).isDirectory()) {
      throw new ClientError('USAGE', `${raw} 是目录`, '传目录请用：ki-client upload-dir <目录>');
    }
    if (!isWanted(abs)) {
      throw new ClientError(
        'USAGE',
        `${raw} 不会被导入内核接收（只收 .md 与 assets 下的图片）`,
        `可用后缀：${DOC_EXT} / ${[...ASSET_EXT].join(' ')}`,
      );
    }
    picked.push({ rel: path.basename(abs), abs });
  }
  return picked;
}

/**
 * 一个「文档单元」：一篇 md + 它正文里引用的附件。
 *
 * 为什么必须成组：导入内核按**文档的相对引用**去 `contentDir` 里找附件。附件若被切到
 * 另一批（或单独一批），那批要么被服务端判成「没有可导入的文件」整批拒收
 * （`OPEN_API_NO_VALID_FILE`），要么 md 导入成功但图全丢。真机验证踩过这个坑。
 */
export interface DocGroup {
  /** 组头文档；孤儿附件组没有 */
  doc?: PickedFile;
  assets: PickedFile[];
  /**
   * md 里引用了、但本次上传列表里没有对应文件的附件。
   *
   * 必须显式提示：服务端导入时找不到附件**不报错**（`errors: 0`），只是文档里的图变成死链，
   * 事后只能靠 `doc get` 的 `images[].supported=false` 才发现。
   */
  missing: string[];
  bytes: number;
}

const MD_REF_RE = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;

/** 归一化 md 里的图片引用，使之能与「上传相对路径」对上 */
export function normalizeRef(raw: string): string {
  let text = raw.trim().split(/[?#]/)[0] ?? '';
  try {
    text = decodeURIComponent(text);
  } catch {
    // 含裸 % 的文件名：保持原样
  }
  while (text.startsWith('./')) text = text.slice(2);
  return text.replace(/\\/g, '/');
}

/** 抽取一篇 markdown 引用的本地附件路径（外链跳过） */
export function extractImageRefs(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(MD_REF_RE)) {
    const ref = normalizeRef(match[1] ?? '');
    if (ref && !/^[a-z][a-z0-9+.-]*:/i.test(ref)) found.add(ref);
  }
  for (const match of markdown.matchAll(HTML_IMG_RE)) {
    const ref = normalizeRef(match[1] ?? '');
    if (ref && !/^[a-z][a-z0-9+.-]*:/i.test(ref)) found.add(ref);
  }
  return [...found];
}

/**
 * 把文件列表按「文档单元」分组（md + 它引用的附件）。
 *
 * 未被任何 md 引用的附件（孤儿）并入第一组：单独发一批会被服务端整批拒收，
 * 而丢掉它们又会让用户在不知情的情况下少传文件。
 */
export function groupDocs(files: PickedFile[]): DocGroup[] {
  const byPath = new Map(files.map((item) => [item.rel, item]));
  const claimed = new Set<string>();
  const groups: DocGroup[] = [];

  for (const doc of files) {
    if (!doc.rel.toLowerCase().endsWith(DOC_EXT)) continue;
    const assets: PickedFile[] = [];
    const missing: string[] = [];
    let markdown = '';
    try {
      markdown = fs.readFileSync(doc.abs, 'utf-8');
    } catch {
      // 读不出来就当没有附件，正文照传（服务端会报读不到）
    }
    for (const ref of extractImageRefs(markdown)) {
      const hit = byPath.get(ref);
      if (!hit || hit.rel === doc.rel) {
        // 引用了但本次没带这个文件：服务端会静默丢图，这里记下来由调用方提示
        if (!hit) missing.push(ref);
        continue;
      }
      if (claimed.has(hit.rel)) continue;
      assets.push(hit);
      claimed.add(hit.rel);
    }
    groups.push({
      doc,
      assets,
      missing,
      bytes: doc.bytes + assets.reduce((sum, item) => sum + item.bytes, 0),
    });
  }

  const orphans = files.filter((item) => !item.rel.toLowerCase().endsWith(DOC_EXT) && !claimed.has(item.rel));
  if (orphans.length > 0) {
    const orphanBytes = orphans.reduce((sum, item) => sum + item.bytes, 0);
    if (groups.length === 0) {
      groups.push({ assets: orphans, missing: [], bytes: orphanBytes });
    } else {
      const first = groups[0]!;
      first.assets.push(...orphans);
      first.bytes += orphanBytes;
    }
  }
  return groups;
}

/** 人类可读体积（400B 不该显示成 0.0MB） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 选上传通道。
 *
 * ═══ 为什么「有附件就必须 tar.gz」（真机验证的坑）═══
 * 对真服务端实测：**multipart 通道下附件一律不落盘**（`{group}/assets/` 里没有文件），
 * 而 md 本身导入成功 → 文档里的图变成死链，且服务端不报错（`errors: 0`）。
 * 同一份内容改用 tar.gz 就正常（`{group}/assets/assets/a.svg`）。
 * 原因在服务端 `receiveMultipart` 一侧（属独立缺陷），客户端只能先规避：
 * **只要批次里出现子目录路径或非 md 文件，就走 tar.gz**。
 * 纯根目录 md 仍走 multipart（更快、无解包开销）。
 */
export function chooseChannel(
  files: Array<{ rel: string }>,
  batchBytes: number,
  forceArchive: boolean,
): 'multipart' | 'tar.gz' {
  if (forceArchive) return 'tar.gz';
  if (batchBytes > MULTIPART_MAX_BYTES) return 'tar.gz';
  if (files.some((file) => file.rel.includes('/'))) return 'tar.gz';
  if (files.some((file) => !file.rel.toLowerCase().endsWith(DOC_EXT))) return 'tar.gz';
  return 'multipart';
}

/** 按累计原始字节切批（单文件超阈值时独占一批，让服务端去报超限） */
export function planBatches<T extends { bytes: number }>(files: T[], maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length > 0 && size + file.bytes > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function runUpload(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const [sub, ...rest] = args.positionals;
  const isDirMode = sub === 'upload-dir';
  if (!isDirMode && sub !== 'upload') {
    throw new ClientError(
      'USAGE',
      '用法：ki-client upload <文件...> | upload-dir <目录>',
      '两者都支持 --scope / --group / --tags / --lifecycle / --archive / --batch-bytes',
    );
  }

  const scope = args.string('scope')?.trim();
  if (!scope) throw new ClientError('USAGE', '缺参数：scope', '用法：ki-client upload --scope <库> <文件...>');
  if (rest.length === 0) {
    throw new ClientError(
      'USAGE',
      `缺${isDirMode ? '目录' : '文件'}参数`,
      isDirMode ? 'ki-client upload-dir --scope <库> <目录>' : 'ki-client upload --scope <库> a.md',
    );
  }

  const rootDir = isDirMode ? path.resolve(rest[0]!) : process.cwd();
  const raw = isDirMode ? collectFromDir(rootDir) : collectFromPaths(rest);
  if (raw.length === 0) {
    throw new ClientError('USAGE', '没有可上传的文件（只收 .md 与 assets 下的图片）', '确认目录里确实有 markdown');
  }

  // 写操作必须先说清楚「发给谁」（多源下这是最重要的一行）
  console.log(`via remote=${remote.name} (${remote.url})`);

  const info = await pingRemote(remote, scope);
  if (info.raw.uploadApi === false) {
    throw new ClientError(
      'CONTRACT_TOO_OLD',
      `源 "${remote.name}" 关闭了上传接口`,
      '让运维用 ki mcp restart --upload-api 打开，或改配置 mcp.http.uploadApi: true',
    );
  }
  const serverMax = typeof info.raw.limits === 'object' && info.raw.limits !== null
    ? (info.raw.limits as { maxRequestBody?: unknown }).maxRequestBody
    : undefined;
  const serverCap = typeof serverMax === 'number' && serverMax > 0 ? serverMax : undefined;

  // 指纹 + 增量过滤
  const picked: PickedFile[] = [];
  let skipped = 0;
  let state: UploadState | undefined;
  let stateId: string | undefined;
  const useState = isDirMode && !args.bool('no-state');
  if (useState) {
    stateId = stateKey({ remote: remote.name, url: remote.url, scope, group: args.string('group'), dir: rootDir });
    state = readState(stateId);
  }

  for (const item of raw) {
    const digest = sha256File(item.abs);
    const record = state?.files[item.rel];
    if (!args.bool('force') && record?.sha256 === digest.sha256) {
      skipped += 1;
      continue;
    }
    picked.push({ rel: item.rel, abs: item.abs, bytes: digest.size, sha256: digest.sha256 });
  }

  if (skipped > 0) {
    console.log(`跳过 ${skipped} 个未变化的文件（内容指纹相同；--force 可强制重传）`);
  }
  if (picked.length === 0) {
    console.log('没有需要上传的文件（全部未变化）');
    return 0;
  }

  const batchLimit = Number(args.string('batch-bytes') ?? args.string('batchBytes') ?? '') || DEFAULT_BATCH_BYTES;
  if (!Number.isFinite(batchLimit) || batchLimit <= 0) {
    throw new ClientError('USAGE', '--batch-bytes 必须是正整数', '示例：--batch-bytes 33554432（32MB）');
  }
  if (serverCap !== undefined && batchLimit > serverCap) {
    console.log(`提示：--batch-bytes ${formatBytes(batchLimit)} 超过服务端单请求上限 ${formatBytes(serverCap)}，按服务端上限切批`);
  }
  const effectiveLimit = serverCap !== undefined ? Math.min(batchLimit, serverCap) : batchLimit;
  // 先按「md + 它引用的附件」成组，再按体积切批：附件与 md 被拆到不同批次会让附件全丢
  // （真机验证：纯附件批次被服务端判成 OPEN_API_NO_VALID_FILE，md 里的图成为死链）
  const groups = groupDocs(picked);
  const missingRefs = groups.flatMap((group) =>
    group.missing.map((ref) => `${group.doc?.rel ?? '(附件)'} → ${ref}`));
  if (missingRefs.length > 0) {
    console.log(`警告：${missingRefs.length} 处图片引用找不到对应文件，服务端会静默丢这些图（不报错）：`);
    for (const line of missingRefs.slice(0, 10)) console.log(`  - ${line}`);
    if (missingRefs.length > 10) console.log(`  ... 另有 ${missingRefs.length - 10} 处`);
  }
  const batches = planBatches(groups, effectiveLimit);

  const query: Record<string, string | undefined> = {
    scope,
    group: args.string('group'),
    tags: args.string('tags'),
    lifecycle: args.string('lifecycle'),
    ttlDays: args.string('ttl-days') ?? args.string('ttlDays'),
    event: args.string('event'),
    chunkSize: args.string('chunk-size') ?? args.string('chunkSize'),
    chunkOverlap: args.string('chunk-overlap') ?? args.string('chunkOverlap'),
  };

  const outcomes: BatchOutcome[] = [];
  for (const [index, batch] of batches.entries()) {
    // 批内是「文档单元」，发送时展开成文件列表（md 在前、附件紧随）
    const files = batch.flatMap((group) => (group.doc ? [group.doc, ...group.assets] : group.assets));
    const batchBytes = batch.reduce((sum, group) => sum + group.bytes, 0);
    const channel = chooseChannel(files, batchBytes, args.bool('archive'));
    const useArchive = channel === 'tar.gz';
    const label = `第 ${index + 1}/${batches.length} 批：${batch.length} 组 / ${files.length} 个文件 ${formatBytes(batchBytes)} → ${channel}`;

    try {
      const response = useArchive
        ? await postBinary<UploadResponse>(
          remote,
          '/open/v1/import/upload',
          createTarGz(files.map((item) => ({ path: item.rel, content: fs.readFileSync(item.abs), mtime: fs.statSync(item.abs).mtimeMs }))),
          'application/gzip',
          query,
        )
        : await postMultipart<UploadResponse>(remote, '/open/v1/import/upload', buildForm(files), query);

      outcomes.push({ index, files: files.length, bytes: batchBytes, channel, ...(response.taskId ? { taskId: response.taskId } : {}) });
      console.log(`${label} ✓${response.taskId ? ` taskId=${response.taskId}` : ''}`);

      // 成功才落状态：失败的批次下次要重传
      if (state && stateId) {
        const at = new Date().toISOString();
        for (const item of files) state.files[item.rel] = { sha256: item.sha256, size: item.bytes, at };
        writeState(stateId, state);
      }

      if (args.bool('wait') && response.taskId) {
        const code = await waitForTask(remote, response.taskId, false);
        if (code !== 0) outcomeMarkFailed(outcomes, index, '导入失败');
      }
    } catch (err) {
      const reason = err instanceof ClientError ? `${err.code}: ${err.message}` : String((err as Error).message);
      outcomes.push({ index, files: batch.length, bytes: batchBytes, channel, error: reason });
      console.log(`${label} ✗ ${reason}`);
    }
  }

  const failed = outcomes.filter((item) => item.error);
  if (args.bool('json')) {
    console.log(JSON.stringify({ ok: failed.length === 0, remote: remote.name, skipped, batches: outcomes }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }

  console.log(`\n上传结束：成功 ${outcomes.length - failed.length} 批 / 失败 ${failed.length} 批${skipped > 0 ? ` / 跳过 ${skipped} 个文件` : ''}`);
  if (failed.length > 0) {
    console.log('失败的批次未写入增量状态，重跑同一命令即可补齐');
    for (const item of failed) console.log(`  - 第 ${item.index + 1} 批：${item.error}`);
  }
  return failed.length === 0 ? 0 : 1;
}

function buildForm(batch: PickedFile[]): FormData {
  const form = new FormData();
  for (const item of batch) {
    form.append('files', new Blob([fs.readFileSync(item.abs)]), item.rel);
  }
  return form;
}

function outcomeMarkFailed(outcomes: BatchOutcome[], index: number, reason: string): void {
  const target = outcomes.find((item) => item.index === index);
  if (target) target.error = reason;
}

/** 轮询导入进度；终态成功返回 0，失败/超时返回 1 */
export async function waitForTask(remote: ResolvedRemote, taskId: string, asJson: boolean): Promise<number> {
  const deadline = Date.now() + 10 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const status = await getJson<StatusResponse>(remote, '/open/v1/import/status', { taskId });
    const state = status.state ?? 'unknown';
    const phase = status.phase ? ` [${status.phase}]` : '';
    const pct = typeof status.progress === 'number' ? ` ${Math.round(status.progress * 100)}%` : '';
    if (state !== last) {
      if (!asJson) console.log(`  状态：${state}${phase}${pct}`);
      last = state;
    }
    if (state === 'done' || state === 'completed' || state === 'success') {
      if (asJson) console.log(JSON.stringify({ ok: true, taskId, status }, null, 2));
      else {
        const r = status.result;
        console.log(r
          ? `  导入完成：共 ${r.total ?? 0} 篇 / 向量化 ${r.vectorized ?? 0} / 跳过 ${r.skipped ?? 0} / 失败 ${r.errors ?? 0}`
          : '  导入完成');
      }
      return 0;
    }
    if (state === 'failed' || state === 'error' || state === 'canceled') {
      if (asJson) console.log(JSON.stringify({ ok: false, taskId, status }, null, 2));
      else console.log(`  导入失败：${status.error ?? state}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('等待超时（10 分钟）；任务可能仍在跑，用 status 子命令继续查');
  return 1;
}
