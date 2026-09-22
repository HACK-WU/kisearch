/**
 * import.ts —— S-04：统一导入命令的核心实现（直导模式）
 *
 * 批次 3（REQ-04）删除 ai-results.json 输入契约后，本文件仅保留直导链路：
 *   Phase 2: bulkVectorize       → 调 vectorBulkStore 批量向量化
 *   Phase 3: ensureGroups        → 按 groupPath 建 Group 树
 *   Phase 4: writeRelations      → 写 relations-cache + local KB（含 memoryId/sourcePath）
 *   Phase 5: recordSource        → 写 group-index.source 块（含切分参数）
 *
 * 幂等追加语义承载增量更新：同 sourcePath 覆盖、同名不同 sourcePath 跳过、新文件导入。
 */

import fs from 'fs';
import path from 'path';

import {
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  getAssetsDir,
  setSource,
  ensureGroupPathInTree,
  type GroupIndexSource,
  type GroupIndex,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { parseContentTags, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';
import { splitIntoChunks, MAX_CHUNKS_PER_FILE, type Chunk } from './chunker.js';
import {
  buildChunkEntries,
  deriveChunkRelation,
  deriveChunkSourcePath,
  deriveRelationText,
  toPosix,
} from './chunk-entries.js';

import { deriveGroupPath, type ScanResultEntry } from './ai-results.js';

// 保持既有对外契约：这些工具原先定义在本模块，统一迁到 chunk-entries（与 rebuild 共用）后继续 re-export
export { deriveChunkRelation, deriveChunkSourcePath, deriveRelationText, toPosix };
import { bulkVectorize } from './batch-vectorize.js';
import { cleanMarkdownText, runCleanHooks, type CleanRules } from './clean.js';
import { acquireImportLock, releaseImportLock, clearImportLock, writeInterruptMark } from './interrupt.js';
import {
  buildGroupPathContent,
  buildRelationContent,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import { generateDocId, vectorBulkStore, vectorDelete } from './vector-client.js';
import { ftsBulkStore, ftsDeleteByIds, getFtsDocId } from './fts-client.js';
import { closeFtsEngine } from './fts-client.js';
import {
  resolveImportConflict,
  validateImportConflictMode,
  validateImportConflictSuffix,
  type ImportConflictAction,
  type ImportConflictMode,
} from './import-conflict.js';
import {
  logPhaseStart,
  logPhaseDone,
  logProgress,
  logInfo,
  logWarn,
  logSummary,
} from './progress.js';

// ─── 类型 ───────────────────────────────────────────────

export interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
}

export interface RelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

export interface ImportContext {
  scope: string;
  sourceDir: string;
  group: string;
  entries: ScanResultEntry[];
  /** path → memoryId（成功向量化的条目） */
  memoryMap: Map<string, string>;
  /** Phase 3 创建/确认的 Group 路径（含 group 前缀） */
  groups: Set<string>;
}

export interface ImportStats {
  total: number;
  vectorized: number;
  errors: number;
  /** 被跳过的文件数（过大 / chunk 超限），结构化输出可观测（体验修复） */
  skipped: number;
  /** 是否写入 dense 向量层（false = --no-vector FTS-only 模式） */
  vector: boolean;
  /** 已复制进 KB 的本地图片附件数（REQ-20260904-001；--no-assets 或配置关闭时为 0） */
  assets: number;
  /** 同一 Group 下不同 sourcePath 的真实同名冲突数量。 */
  conflicts: number;
  /** 写入 FTS-only Collection 的 chunk 文档数（--no-vector 模式）。 */
  fullTextIndexed: number;
}

export interface ImportConflict {
  path: string;
  originalRelation: string;
  relation: string;
  action: ImportConflictAction;
}

export interface ImportResult {
  ok: true;
  action: 'import';
  scope: string;
  stats: ImportStats;
  errors: { path: string; error: string }[];
  conflicts: ImportConflict[];
  groups: string[];
  source: GroupIndexSource;
}

export interface HandleDirectImportArgs {
  scope: string;
  /** 外部 Wiki 根目录或单个 Markdown 文件（绝对路径） */
  sourceDir: string;
  /** 目标 Group 落点（幂等追加；不存在时自动新建，含父路径）。可选：缺省时目录导入按顶层子目录名各建根节点，单文档导入用 scope name */
  group?: string;
  /** 切分参数：目标长度（字符），默认 1000 */
  chunkSize?: number;
  /** 切分参数：重叠字符数，默认 150 */
  chunkOverlap?: number;
  /** 单文件大小上限（字节），超限跳过并告警；默认 1MB（config `import.maxFileSize` 可配） */
  maxFileSizeBytes?: number;
  /** FTS-only 模式开关：false 时跳过 dense/embedding，写入独立全文 Collection；默认 true */
  vector?: boolean;
  /** 清洗总开关（false = --no-clean，关闭全部清洗含 hooks）；默认 true */
  cleanEnabled?: boolean;
  /** 内置清洗规则覆盖（--clean-rules 解析结果） */
  cleanRules?: Partial<import('./clean.js').CleanRules>;
  /** 文档级自定义标签（逗号分隔多个）。无论是否向量化均持久化到 relation.tags（供 rebuild-vector/restore 恢复）；向量化时额外为每个导入文件每个 tag 写一条内容向量 */
  tags?: string;
  /** 附件（本地图片）收集开关（REQ-20260904-001，默认 true；false = 不复制附件，前端对图片引用显示占位块） */
  assets?: boolean;
  /** 同一 Group 下不同 sourcePath 的同名处理策略，默认 suffix。 */
  conflictMode?: ImportConflictMode;
  /** 自动后缀模板，默认 _{n}。 */
  conflictSuffix?: string;
  /** daemon HTTP job 使用：报告可观测进度；不影响 CLI 输出。 */
  onProgress?: (progress: {
    phase: 'scan' | 'vectorize' | 'persist';
    done: number;
    total: number;
    persisted?: number;
    metadataPending?: number;
    failed?: number;
    cancelled?: number;
  }) => void;
  /** daemon HTTP job 使用：在当前批次完成后安全中止，不强行打断 zvec/embedding 调用。 */
  abortSignal?: AbortSignal;
}

// ─── 工具函数 ───────────────────────────────────────────
//
// relation/chunk 命名与 chunk 条目构造统一收敛在 chunk-entries.ts（import 与
// rebuild 共用同一实现，避免两条链路的向量粒度/文本漂移）；本模块只做 re-export。

/**
 * 推导文件的 groupPath（rootName 概念移除后的落点规则）
 *
 * - 显式 --group（非空）：沿用旧语义——group 作为统一根前缀，文件相对子目录挂其下。
 *   `deriveGroupPath(group, rel)` = `group` 或 `group/<子目录>`。
 * - 缺省 --group（空）：
 *   - 目录导入：文件的相对目录即 groupPath（顶层子目录名 = 根节点）；根目录下的顶层 .md 归 scope name 根。
 *   - 单文件导入：groupPath = scope name。
 *
 * @param group 显式 group（可空）
 * @param rel 文件相对 sourceDir 的 posix 路径
 * @param scope scope name（缺省 group 时的兜底根）
 */
function resolveGroupForSource(group: string, rel: string, scope: string): string {
  if (group) {
    return deriveGroupPath(group, rel);
  }
  // 缺省 group：取文件相对目录为 groupPath（顶层子目录名即根节点）
  const dir = path.posix.dirname(toPosix(rel));
  return dir === '.' ? scope : dir;
}

// ─── 直导（原文直导 + 切分）工具 ─────────────────────────

/** 默认格式白名单：.md（REQ-08，可配置扩展 .markdown 等） */
export const DEFAULT_EXTENSIONS = ['.md'];
export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;

/** 图片附件后缀白名单（REQ-20260904-001：仅本地相对路径引用会被复制进 KB） */
export const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif'];

/** 单附件默认大小上限：5MB（config scopes.<scope>.import.maxAssetSize 可覆盖） */
export const DEFAULT_MAX_ASSET_SIZE = 5 * 1024 * 1024;

/**
 * 递归收集 sourceDir 下白名单格式文件（相对路径，posix 风格）+ 非白名单跳过统计（REQ-08）
 * @param sourceDir 源目录
 * @param extensions 格式白名单（默认 [.md]）；传空数组时用默认
 * @returns files=白名单文件列表；skippedNonMd=非白名单文件相对路径列表（汇总提示用）
 */
function collectMarkdownFiles(sourceDir: string, extensions: string[] = DEFAULT_EXTENSIONS): { files: string[]; skippedNonMd: string[] } {
  const out: string[] = [];
  const skippedNonMd: string[] = [];
  const exts = extensions.length > 0 ? extensions.map((e) => e.toLowerCase()) : DEFAULT_EXTENSIONS;
  const isAllowed = (name: string): boolean => exts.some((e) => name.toLowerCase().endsWith(e));

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录与备份目录
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (isAllowed(entry.name)) {
          out.push(toPosix(path.relative(sourceDir, abs)));
        } else {
          // 非白名单文件：跳过并汇总（REQ-08；隐藏文件/临时文件不报）
          if (!entry.name.startsWith('.')) skippedNonMd.push(toPosix(path.relative(sourceDir, abs)));
        }
      }
    }
  };
  walk(sourceDir);
  return { files: out.sort(), skippedNonMd };
}

// ─── 附件（本地图片）收集（REQ-20260904-001）───────────────

/** markdown 图片语法：![alt](url) / ![alt](url "title")；URL 允许含空格（形态 2，导入侧宽松收集，前端渲染时再编码） */
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
/** HTML 写法：<img src="url"> / <img src='url'> / <img src=url> */
const HTML_IMG_RE = /<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)["']?/gi;

/** 剥离 markdown 图片 URL 尾部的 title 部分（` "..."` / ` '...'`） */
function stripImageTitle(raw: string): string {
  return raw.replace(/\s+["'][^"']*["']\s*$/, '').trim();
}

/** 归一化图片引用 URL：剥 CommonMark 尖括号 destination（`![a](<p q.png>)`）、去尾部 title 与 #fragment */
function normalizeRefUrl(raw: string): string {
  let u = stripImageTitle(raw).trim();
  const angled = /^<([\s\S]*)>$/.exec(u);
  if (angled) u = angled[1].trim();
  return u.replace(/#.*$/, '');
}

/**
 * 按代码围栏（``` / ~~~）切分，仅对围栏外文本执行 extract（P2：防代码块内的示例图片
 * 被当真实引用收集 → 无谓告警；前端同源保护见 MarkdownPreview.encodeImageSpaces）
 */
function outsideCodeFences(md: string, extract: (seg: string) => void): void {
  const lines = md.split('\n');
  let inFence = false;
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      extract(buf.join('\n'));
      buf = [];
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    buf.push(line);
  }
  flush();
}

/** 提取 md 原文中的全部图片引用 URL（markdown 语法 + HTML <img src>；围栏外；不去重、不过滤） */
export function extractImageRefs(mdText: string): string[] {
  const out: string[] = [];
  outsideCodeFences(mdText, (seg) => {
    // 顺序语义：先遍历完 markdown 语法、再遍历 HTML <img>（非文档出现顺序）
    for (const m of seg.matchAll(MD_IMAGE_RE)) out.push(normalizeRefUrl(m[1]));
    for (const m of seg.matchAll(HTML_IMG_RE)) out.push(normalizeRefUrl(m[1]));
  });
  return out.filter((u) => u.length > 0);
}

/** 是否为“可收集的本地相对路径”：排除任何 scheme（http/https/file/data）、协议相对、posix/windows 绝对路径与锚点 */
export function isCollectibleRelativeAsset(url: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return false;
  if (url.startsWith('/')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(url)) return false;
  if (url.startsWith('#')) return false;
  return true;
}

export interface AssetCollectResult {
  /** 已复制的附件相对路径（相对 assets 目录，posix 风格） */
  copied: string[];
  /** 未复制原因（导入汇总告警用；外链/绝对路径不在此列，属不支持形态由前端占位提示） */
  warnings: string[];
}

/**
 * 收集并复制 md 引用的本地图片附件到 group 级 assets 目录（REQ-20260904-001）
 *
 * 安全边界（两道）：
 *   1. 源侧：解析后必须落在 sourceDir 内——禁止借导入读取源目录之外的宿主机文件；
 *   2. 目标侧：复制目标必须落在 assetsDir 内——防 `../` 路径穿越写出。
 * 外链 / 绝对路径 / file:// 一律不复制（静默跳过，前端对这些形态显示占位提示）。
 * 保持相对 md 的目录结构（images/x.png → assets/images/x.png），使前端可直接用原 URL 寻址。
 */
export function collectAndCopyAssets(opts: {
  sourceDir: string;
  mdDir: string;
  mdLabel: string;
  assetsDir: string;
  urls: string[];
  maxAssetBytes: number;
}): AssetCollectResult {
  const copied: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const srcRoot = path.resolve(opts.sourceDir);
  const dstRoot = path.resolve(opts.assetsDir);
  for (const raw of opts.urls) {
    if (!isCollectibleRelativeAsset(raw)) continue;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* 非法百分号编码按原样处理 */ }
    const rel = toPosix(decoded);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.resolve(opts.mdDir, decoded);
    if (abs !== srcRoot && !abs.startsWith(srcRoot + path.sep)) {
      warnings.push(`附件引用超出源目录已跳过（${rel}）：${opts.mdLabel}`);
      continue;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      warnings.push(`附件引用未命中源目录文件已跳过（${rel}）：${opts.mdLabel}`);
      continue;
    }
    // 符号链接复检：stat/copyFileSync 跟随软链 → 源目录内后缀伪装的软链可越界读宿主机文件。
    // 用 realpath 复检解析后仍须在 sourceDir 内（允许指向源目录内部的软链）。
    let realAbs: string;
    try {
      realAbs = fs.realpathSync(abs);
    } catch {
      warnings.push(`附件读取失败已跳过（${rel}）：${opts.mdLabel}`);
      continue;
    }
    if (realAbs !== srcRoot && !realAbs.startsWith(srcRoot + path.sep)) {
      warnings.push(`附件符号链接指向源目录外已跳过（${rel}）：${opts.mdLabel}`);
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (!ASSET_EXTENSIONS.includes(ext)) {
      warnings.push(`附件后缀不在白名单已跳过（${rel}，白名单：${ASSET_EXTENSIONS.join(', ')}）：${opts.mdLabel}`);
      continue;
    }
    const size = fs.statSync(abs).size;
    if (size > opts.maxAssetBytes) {
      warnings.push(`附件过大已跳过（${size} bytes > ${opts.maxAssetBytes}）：${rel}（${opts.mdLabel}）`);
      continue;
    }
    const dst = path.resolve(dstRoot, rel);
    if (!dst.startsWith(dstRoot + path.sep)) {
      warnings.push(`附件目标路径越界已跳过（${rel}）：${opts.mdLabel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst); // 幂等重导：同名覆盖
    copied.push(rel);
  }
  return { copied, warnings };
}

/** 读取文件内容并按参数切分；未超限返回单 chunk */
export function readFileToChunks(absPath: string, chunkSize: number, chunkOverlap: number): Chunk[] {
  const text = fs.readFileSync(absPath, 'utf-8');
  return splitIntoChunks(text, { chunkSize, overlap: chunkOverlap });
}

/** 直导入口：把 sourceDir 下的 Markdown 目录直接导入（无 AI 依赖，方案 D：local KB 文件原文 + memoryIds 多值；幂等追加） */
export async function handleDirectImport(
  args: HandleDirectImportArgs
): Promise<ImportResult> {
  const scope = args.scope;
  const sourceDir = path.resolve(args.sourceDir);
  // group 缺省时传空串，由 resolveGroupForSource 根据 source 类型（目录/单文件）推断
  const group = (args.group ?? '').trim();
  const chunkSize = args.chunkSize ?? 1000;
  const chunkOverlap = args.chunkOverlap ?? 150;
  const vector = args.vector !== false;
  const conflictMode = validateImportConflictMode(args.conflictMode);
  const conflictSuffix = validateImportConflictSuffix(args.conflictSuffix);
  // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则（批次 3 接入实际清洗）
  // 清洗开关与规则的**最终值**在读取 scope 配置后再定（见下方 cleanCfg 处）：
  // CLI 显式参数优先、配置补齐——rebuild 链路的清洗来源只有配置，两者必须同源。
  let cleanEnabled = args.cleanEnabled !== false;
  let cleanRules: CleanRules | undefined = args.cleanRules;
  // 文档级自定义标签：逗号分隔、去空、去重、过滤内部保留 tag（ki-search/ki-relation/ki-path）
  const customTags = parseContentTags(args.tags);
  // NEG：显式传入 --tags 但解析后为空（全为保留标签/空白）→ 提示，避免用户误以为打标生效
  if (args.tags && customTags.length === 0) {
    logWarn('--tags 解析后无有效标签（内部保留标签 ki-search/ki-relation/ki-path 不可用作自定义标签；已忽略，本次不打标）');
  }

  let processedFileCount = 0;
  let totalFileCount = 0;
  let cleanedUp = false;
  let lockAcquired = false;
  let onInterrupt: ((signal: NodeJS.Signals) => void) | null = null;
  // handleDirectImport 既被独立 CLI 调用，也被 daemon owner 调用。后者不能
  // 注册会直接 process.exit 的进程级信号处理器，否则 `ki mcp stop` 在导入中
  // 会绕过 HTTP 优雅关闭，遗留 zvec worker/LOCK。daemon 任务使用 abortSignal
  // 取消；只有独立 CLI 保留 Ctrl+C/TERM 的旧语义。
  const installProcessSignalHandler = process.env.KI_DAEMON_OWNER !== '1';
  const cleanupCancelledImport = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (lockAcquired) {
        writeInterruptMark(scope, { processedFiles: processedFileCount, totalFiles: totalFileCount, signal: 'CANCEL' });
        clearImportLock(scope);
        lockAcquired = false;
      }
      if (onInterrupt) {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
      }
    } catch { /* 取消反馈不应覆盖主错误 */ }
  };
  const checkCancelled = () => {
    if (!args.abortSignal?.aborted) return;
    cleanupCancelledImport();
    throw Object.assign(new Error(`导入已取消（已完成 ${processedFileCount}/${totalFileCount} 个文件；当前批次已结束）`), {
      code: 'IMPORT_CANCELLED',
    });
  };
  checkCancelled();

  // 单文件导入支持：sourceDir 可为单个 .md 文件（缺省 group 时用 scope name）
  const sourceIsFile = fs.existsSync(sourceDir) && fs.statSync(sourceDir).isFile();
  if (!fs.existsSync(sourceDir) || (!sourceIsFile && !fs.statSync(sourceDir).isDirectory())) {
    throw new Error(`sourceDir 不存在或不是目录/文件：${sourceDir}`);
  }

  // 0) 准备 scope 目录 + 并发锁 + 信号捕获 + 预读索引（REQ-01/02，N4）
  //    REQ-08：格式白名单 + 大小上限从 config scopes.<scope>.import 读取（默认 .md / 1MB）
  ensureScopeDir(scope);
  // 并发导入锁（N4）：同 scope 并发导入拒绝；SIGKILL 残留锁自动清理
  if (!acquireImportLock(scope)) {
    throw new Error(`scope "${scope}" 已有导入进行中（import.lock 存在），请等待完成或清理锁文件后重试`);
  }
  lockAcquired = true;
  // REQ-01：SIGINT/SIGTERM 捕获 → 写中断标记 + 明确提示；SIGKILL 不可捕获由 probe 兜底（双路径）
  let interrupted = false;
  /** 中断时可读的进度状态（文件处理循环中更新；信号回调是同步的，无法读异步循环内变量） */
  if (installProcessSignalHandler) {
    onInterrupt = (signal: NodeJS.Signals) => {
      if (interrupted) return;
      interrupted = true;
      try {
        writeInterruptMark(scope, { processedFiles: processedFileCount, totalFiles: totalFileCount, signal });
        process.stderr.write(`\n⚠ 导入已中断（${signal}），已写中断标记（已完成 ${processedFileCount}/${totalFileCount} 个文件）。重新导入或执行 ki restore <scope> --rebuild-vector 恢复\n`);
        // 中断路径同步清锁（N4：避免 SIGTERM 后 import.lock 残留）；保留中断标记供引导（不清标记）
        clearImportLock(scope);
        lockAcquired = false;
      } catch { /* 标记/锁清理失败不阻断退出 */ }
      process.exit(130);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
  }

  try {
  const { loadConfig, getScopeImportConfig, getScopeCleanConfig } = await import('./config.js');
  const cfg = loadConfig();
  const importCfg = getScopeImportConfig(cfg, scope);
  const extensions = importCfg?.extensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = args.maxFileSizeBytes ?? importCfg?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES; // 默认 1MB（REQ-08）
  // REQ-20260904-001：附件收集开关（--no-assets / config assets:false 关闭）与单附件上限（默认 5MB）
  const assetsEnabled = args.assets !== false && importCfg?.assets !== false;
  const maxAssetBytes = importCfg?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE;
  // REQ-07：外部清洗 hook（config scopes.<scope>.clean.hooks；--no-clean 时全部关闭）
  // 清洗规则来源合并：CLI 显式参数 > 配置 clean.rules > 内置默认。
  // rebuild 只能读到配置，若此处不消费配置，两条链路的清洗结果仍会漂移。
  const cleanCfg = getScopeCleanConfig(cfg, scope);
  cleanEnabled = cleanEnabled && cleanCfg?.enabled !== false;
  cleanRules = cleanRules ?? cleanCfg?.rules;
  const cleanHooks = cleanEnabled ? (cleanCfg?.hooks ?? []) : [];
  // 单文件导入：sourceDir 指向单个文件时，files 只含该文件（相对路径 = basename）
  // 后缀仍需命中 extensions 白名单（REQ-08），未命中 fail-loud 报错而非静默导入
  if (sourceIsFile && !extensions.some((e) => sourceDir.toLowerCase().endsWith(e))) {
    throw new Error(`不支持的文件格式：${sourceDir}（格式白名单：${extensions.join(', ')}）`);
  }
  const { files, skippedNonMd } = sourceIsFile
    ? { files: [toPosix(path.basename(sourceDir))], skippedNonMd: [] as string[] }
    : collectMarkdownFiles(sourceDir, extensions);
  if (files.length === 0) {
    throw new Error(`未发现 .md 文件（格式白名单：${extensions.join(', ')}）：${sourceDir}`);
  }
  if (skippedNonMd.length > 0) {
    logWarn(`跳过 ${skippedNonMd.length} 个不支持格式的文件：${skippedNonMd.slice(0, 10).join(', ')}${skippedNonMd.length > 10 ? ` ...等 ${skippedNonMd.length} 个` : ''}`);
  }

  const relationsCachePath0 = getRelationsCachePath(scope);
  const relationsCache0 = readJson<RelationsCache>(relationsCachePath0);
  if (!relationsCache0) {
    throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
  }

  logInfo(`扫描到 ${files.length} 个文件（chunkSize=${chunkSize}, overlap=${chunkOverlap}）`);

  // 1) 方案 D 逐文件：前置检查 → 写 local KB 文件原文 → 清洗 → 切分 → 构造向量化条目
  //    文件级 relation 记录：{ groupPath, relation(文件级), sourcePath(文件路径), memoryIds(向量化后回填) }
  const fileRecords: {
    rel: string;
    groupPath: string;
    relation: string;
    previousRelation?: Relation;
    previousLocalText?: string;
    chunks: Chunk[];          // 清洗后切分结果（向量化输入）
    entries: ScanResultEntry[]; // 向量化条目（text=清洗后 chunk）
  }[] = [];
  const skipped: string[] = [];
  const conflicts: ImportConflict[] = [];
  /** 当前批次已接受的文件级 relation；避免同一批上传内重名漏判。 */
  const plannedRelations = new Map<string, Relation[]>();
  /** 附件收集告警（未命中/超限/越界等，循环后汇总）与已落盘的唯一附件集合（REQ-20260904-001） */
  const assetWarnings: string[] = [];
  /** 用 Set 去重：同一附件被多篇 md 引用时仅计一次（复制为同名覆盖，计数语义 = 落盘文件数） */
  const assetCopied = new Set<string>();
  totalFileCount = files.length; // 中断标记总文件数（REQ-01）
  args.onProgress?.({ phase: 'scan', done: 0, total: files.length });

  for (const rel of files) {
    checkCancelled();
    // 单文件导入：rel 是 basename，absPath 即 sourceDir 本身（避免 xxx.md/xxx.md 的 ENOTDIR）
    const absPath = sourceIsFile ? sourceDir : path.resolve(sourceDir, rel);
    const stat = fs.statSync(absPath);
    // 前置检查（先于写 local KB）：大小超限 / chunk 超限 / relation 冲突
    if (stat.size > maxFileSizeBytes) {
      skipped.push(rel);
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: files.length });
      logWarn(`文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}）：${rel}，可手动切分后导入`);
      continue;
    }
    const fileText = fs.readFileSync(absPath, 'utf-8');
    const groupPath = resolveGroupForSource(group, rel, scope);
    const originalRelation = deriveRelationText(rel); // 文件级 relation（basename 去 .md）
    const groupData = relationsCache0.groups[groupPath];
    const currentBatchRelations = plannedRelations.get(groupPath) ?? [];
    const resolution = resolveImportConflict({
      relations: [...(groupData?.hot_relations ?? []), ...currentBatchRelations],
      baseRelation: originalRelation,
      sourcePath: rel,
      mode: conflictMode,
      suffix: conflictSuffix,
    });
    if (resolution.action === 'skip') {
      conflicts.push({ path: rel, originalRelation, relation: resolution.relation, action: 'skip' });
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: files.length });
      logWarn(`relation 冲突已跳过（同 group "${groupPath}" 下已有 "${originalRelation}"）：${rel}`);
      continue;
    }
    const relation = resolution.relation;
    const previousRelation = groupData?.hot_relations.find((item) => item.text === relation);
    let previousLocalText = readLocalKb(scope, groupPath)[relation];
    // 同一批次内显式 overwrite 的两个不同 sourcePath 会解析到同一个逻辑 relation。
    // 后者应替换前者，不能让前者也进入向量化后变成无 relation 挂载的孤儿向量。
    const replacedBatchRecord = resolution.action === 'overwrite'
      ? fileRecords.find((item) => item.groupPath === groupPath && item.relation === relation)
      : undefined;
    if (replacedBatchRecord) {
      previousLocalText = replacedBatchRecord.previousLocalText;
      const replacedIndex = fileRecords.indexOf(replacedBatchRecord);
      if (replacedIndex >= 0) fileRecords.splice(replacedIndex, 1);
    }
    if (resolution.conflicted) {
      conflicts.push({ path: rel, originalRelation, relation, action: resolution.action as ImportConflictAction });
    }
    if (resolution.action === 'overwrite' && resolution.existing) {
      // 同 sourcePath 幂等重导或显式覆盖：允许重新写入 local KB + 向量化。
      logWarn(`文件已存在，幂等重导覆盖（${rel}）`);
    }
    // 方案 D：第一步直接写 local KB（文件级原文，未清洗）
    writeLocalKb(scope, groupPath, relation, fileText);

    // 清洗（方案 D：清洗只作用于向量化输入；local KB 存原文）
    // 执行顺序：内置规则 → 外部 hooks（REQ-07）；hook 全失败 → P-7 回滚 local KB + skipped
    let textForVector = cleanEnabled ? cleanMarkdownText(fileText, cleanRules) : fileText;
    if (cleanEnabled && cleanHooks.length > 0) {
      const hookResult = await runCleanHooks(textForVector, cleanHooks);
      if (!hookResult.ok) {
        // P-7：所有 hooks 均失败 → 不写入向量 + local KB 回滚（删除已写原文），文件计入 skipped
        skipped.push(rel);
        logWarn(`清洗 hook 失败已跳过（${rel}）：${hookResult.failedHooks.join(', ')}，已回滚 local KB`);
        removeFromLocalKb(scope, groupPath, relation);
        processedFileCount++;
        args.onProgress?.({ phase: 'scan', done: processedFileCount, total: files.length });
        continue;
      }
      textForVector = hookResult.text;
    }

    // chunk 与条目构造统一走共享实现（chunk-entries）：rebuild 使用同一套命名/条目规则，
    // 保证两条链路产出相同的 chunkRelation 与 docId（此前 rebuild 各自内联，导致产物漂移）。
    const { chunks, entries } = buildChunkEntries({
      fileKey: rel,
      groupPath,
      text: textForVector,
      chunkSize,
      chunkOverlap,
      relationName: relation,
    });
    if (chunks.length > MAX_CHUNKS_PER_FILE) {
      skipped.push(rel);
      logWarn(`文件切分 chunk 数超限已跳过（${chunks.length} > ${MAX_CHUNKS_PER_FILE}）：${rel}，可增大 --chunk-size 或手动拆分后导入`);
      removeFromLocalKb(scope, groupPath, relation); // 超限同样回滚（保持一致性）
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: files.length });
      continue;
    }
    // 附件收集（REQ-20260904-001）：置于两个回滚点（hook 失败 / chunk 超限）之后 → 被跳过文件不产生孤儿附件，无需回滚
    if (assetsEnabled) {
      const assetResult = collectAndCopyAssets({
        // 单文件导入时 sourceDir 是文件路径，源根应取其所在目录（否则同级图片全部判为越界）
        sourceDir: sourceIsFile ? path.dirname(absPath) : sourceDir,
        mdDir: path.dirname(absPath),
        mdLabel: rel,
        assetsDir: getAssetsDir(scope, groupPath),
        urls: extractImageRefs(fileText),
        maxAssetBytes,
      });
      for (const copiedRel of assetResult.copied) assetCopied.add(`${groupPath}::${copiedRel}`);
      assetWarnings.push(...assetResult.warnings);
    }
    fileRecords.push({
      rel,
      groupPath,
      relation,
      previousRelation: previousRelation ? cloneRelation(previousRelation) : undefined,
      previousLocalText: typeof previousLocalText === 'string' ? previousLocalText : undefined,
      chunks,
      entries,
    });
    const planned = plannedRelations.get(groupPath) ?? [];
    const plannedIndex = planned.findIndex((item) => item.text === relation);
    const plannedRelation: Relation = {
      id: `planned_${groupPath}_${relation}`,
      text: relation,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
      sourcePath: rel,
    };
    if (plannedIndex >= 0) planned[plannedIndex] = plannedRelation;
    else planned.push(plannedRelation);
    plannedRelations.set(groupPath, planned);
    processedFileCount++;
    // 进度 = 已处理文件数（O-01 文件数分母）。不传 detail（文件名）：避免 TTY \r 刷新时
    // 长路径残留叠加成乱码（bug-impact-analysis），进度条仅显示文件数 + 百分比。
    logProgress(fileRecords.length, files.length);
    args.onProgress?.({ phase: 'scan', done: processedFileCount, total: files.length });
  }
  if (skipped.length > 0) {
    logWarn(`跳过 ${skipped.length} 个文件（过大或 chunk 超限）：${skipped.join(', ')}`);
  }
  const skippedConflicts = conflicts.filter((item) => item.action === 'skip');
  if (skippedConflicts.length > 0) {
    logWarn(`跳过 ${skippedConflicts.length} 个文件（relation 冲突）：${skippedConflicts.map((item) => item.path).join(', ')}`);
  }
  if (assetWarnings.length > 0) {
    logWarn(`附件收集告警 ${assetWarnings.length} 条：${assetWarnings.slice(0, 10).join('；')}${assetWarnings.length > 10 ? ` ...等 ${assetWarnings.length} 条` : ''}`);
  }
  if (fileRecords.length === 0) {
    const skippedConflictCount = conflicts.filter((item) => item.action === 'skip').length;
    // 纯 skip 冲突不是系统失败：返回结构化冲突明细，让 CLI/HTTP/Web 都能告诉用户
    // 哪些文件被跳过；其他“没有可导入文件”场景继续 fail-loud。
    if (skipped.length === 0 && skippedConflictCount > 0) {
      releaseImportLock(scope);
      lockAcquired = false;
      return {
        ok: true,
        action: 'import',
        scope,
        stats: {
          total: 0,
          vectorized: 0,
          errors: 0,
          skipped: skippedConflictCount,
          vector,
          assets: 0,
          conflicts: conflicts.length,
          fullTextIndexed: 0,
        },
        errors: [],
        conflicts,
        groups: [],
        source: { dir: sourceDir, chunkSize, chunkOverlap },
      };
    }
    throw new Error(`无可导入文件（全部被跳过：过大/超限/冲突 ${skipped.length + skippedConflictCount} 个）`);
  }

  // 汇总全部向量化条目（chunk 粒度，供 bulkVectorize）
  const entries: ScanResultEntry[] = fileRecords.flatMap((r) => r.entries);
  logInfo(`切分完成：共 ${entries.length} 个 chunk（来自 ${fileRecords.length} 个文件，跳过 ${skipped.length + conflicts.filter((item) => item.action === 'skip').length}）`);

  // 2) Phase 2~5
  const TOTAL = 5;
  const memoryMap = new Map<string, string>();
  checkCancelled();
  args.onProgress?.({ phase: 'vectorize', done: 0, total: Math.max(entries.length, 1) });

  // ── 预读 group-index（relations-cache 已在步骤 0 预读为 relationsCache0）──
  const groupIndexPath = getGroupIndexPath(scope);
  const relationsCachePath = getRelationsCachePath(scope);
  const groupIndex = readGroupIndex(scope);
  if (!groupIndex) {
    throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
  }
  const relationsCache = relationsCache0;

  // ── Phase 2：先写新向量，成功后再清理受影响文档的旧向量 ──
  // 关键不变量：不再清空整个 Scope；新向量失败时旧 relation/local KB/向量仍可恢复。
  logPhaseStart(2, TOTAL, '向量化 ...');
  // --no-vector：跳过 dense/embedding，memoryIds 为空；正文索引在后续 FTS-only 阶段写入。
  const vectorizeResult = !vector
    ? { ok: new Map<string, string>(), errors: [] }
    : await bulkVectorize(entries, scope, {
        timeoutMs: 60_000 + entries.length * 10_000,
        abortSignal: args.abortSignal,
        onVectorProgress: (progress) => {
          args.onProgress?.({
            phase: 'vectorize',
            done: Math.min(entries.length, progress.done),
            total: entries.length,
            persisted: progress.persisted,
            metadataPending: progress.metadataPending,
            failed: progress.failed,
            cancelled: progress.cancelled,
          });
        },
      });
  checkCancelled();
  args.onProgress?.({ phase: 'vectorize', done: entries.length, total: Math.max(entries.length, 1) });

  // ── 文档级自定义 tag 向量写入（可选）：为每个成功导入文件写一条 tag 内容向量 ──
  // 机制对齐 sync-relation：text=文件原文、tags=自定义 tag（每个 tag 各一条），
  // 使 `ki search -t <tag>` 能召回导入文件。tag 向量 docId 回填到文件级 relation 的 memoryIds。
  let tagMemoryMap = new Map<string, string[]>();
  const tagErrors: { path: string; error: string }[] = [];
  const vectorCleanupErrors: { path: string; error: string }[] = [];
  const failedRecords = new Set<typeof fileRecords[number]>();
  for (const rec of fileRecords) {
    if (vector && rec.entries.some((entry) => !vectorizeResult.ok.has(entry.path))) {
      failedRecords.add(rec);
    }
  }
  checkCancelled();
  if (vector && customTags.length > 0) {
    logPhaseStart(2, TOTAL, `写入自定义标签向量（${customTags.join(', ')}）...`);
    const tagEntries: { text: string; tags: string; group: string }[] = [];
    const tagRecords = fileRecords.filter((rec) => !failedRecords.has(rec));
    // fileRecords 含清洗后原文（textForVector）用于向量化；local KB 存原始 fileText
    for (const rec of tagRecords) {
      const origText = fs.readFileSync(sourceIsFile ? sourceDir : path.resolve(sourceDir, rec.rel), 'utf-8');
      for (const t of customTags) {
        tagEntries.push({ text: origText, tags: t, group: rec.groupPath });
      }
    }
    if (tagEntries.length > 0) {
      try {
        const tagResult = await vectorBulkStore({ scope, entries: tagEntries }, { abortSignal: args.abortSignal });
        // 聚合到 文件 → [tag memoryIds]（成功条目按 index 回推文件/标签）
        const newMap = new Map<string, string[]>();
        for (const item of tagResult.results) {
          const rec = tagRecords[Math.floor(item.index / customTags.length)];
          if (!rec) continue;
          if (item.success && item.memoryId) {
            const arr = newMap.get(rec.rel) ?? [];
            arr.push(item.memoryId);
            newMap.set(rec.rel, arr);
          } else {
            failedRecords.add(rec);
            tagErrors.push({ path: rec.rel, error: `标签向量写入失败：${item.error || 'unknown error'}` });
          }
        }
        tagMemoryMap = newMap;
        logInfo(`自定义标签向量写入完成：成功 ${tagResult.results.filter((r) => r.success).length}/${tagEntries.length}`);
      } catch (err) {
        for (const rec of tagRecords) {
          failedRecords.add(rec);
          tagErrors.push({ path: rec.rel, error: `标签向量写入失败：${(err as Error).message}` });
        }
        logWarn(`自定义标签向量写入失败：${(err as Error).message}`);
      }
    }
    logPhaseDone(2, TOTAL, `标签向量写入完成`);
  }

  const allKnownVectorIds = new Set<string>();
  for (const [groupPath, groupData] of Object.entries(relationsCache0.groups)) {
    for (const relation of groupData.hot_relations) {
      for (const id of relationMemoryIds(relation)) allKnownVectorIds.add(id);
    }
  }
  // 同批次不同文件可能因内容/标签完全相同而共享确定性 docId；失败文件回滚时，
  // 不能把仍被本批次成功文件使用的新 ID 一并删掉。
  for (const rec of fileRecords) {
    if (failedRecords.has(rec)) continue;
    for (const entry of rec.entries) {
      const id = vectorizeResult.ok.get(entry.path);
      if (id) allKnownVectorIds.add(id);
    }
    for (const id of tagMemoryMap.get(rec.rel) ?? []) allKnownVectorIds.add(id);
  }

  // 回滚本批次内未完成向量化的文件：只删除本次新写入且不属于其他已有/成功文件的 ID。
  for (const rec of failedRecords) {
    const oldIds = new Set(relationMemoryIds(rec.previousRelation));
    const newIds = [
      ...rec.entries.map((entry) => vectorizeResult.ok.get(entry.path)).filter((id): id is string => !!id),
      ...(tagMemoryMap.get(rec.rel) ?? []),
    ];
    const rollbackIds = newIds.filter((id) => !oldIds.has(id) && !allKnownVectorIds.has(id));
    restoreLocalKb(scope, rec.groupPath, rec.relation, rec.previousLocalText);
    await deleteVectorIds(scope, rollbackIds, `回滚文档 ${rec.rel} 的新向量`);
  }

  const activeFileRecords = fileRecords.filter((rec) => !failedRecords.has(rec));
  if (vector && activeFileRecords.length === 0) {
    const failureDetails = [...vectorizeResult.errors, ...tagErrors]
      .slice(0, 5)
      .map((item) => `${item.path}: ${item.error}`)
      .join('；');
    throw new Error(
      `本次导入的 ${fileRecords.length} 个文件均未完成向量化；旧文档已保留，请修复 embedding 后重试` +
      (failureDetails ? `。失败详情：${failureDetails}` : ''),
    );
  }
  const activeEntries = activeFileRecords.flatMap((rec) => rec.entries);
  const activeEntryPaths = new Set(activeEntries.map((entry) => entry.path));
  const activeMergedMap = new Map(
    [...vectorizeResult.ok].filter(([entryPath]) => activeEntryPaths.has(entryPath)),
  );

  // --no-vector 不再意味着“只写 KB”：清洗后的 chunk 写入独立 FTS-only
  // Collection。FTS ID 与 hybrid memoryId 分离，避免给 no-vector 文档伪造 dense 向量。
  const fullTextErrors: { path: string; error: string }[] = [];
  let fullTextIndexed = 0;
  const fullTextIdsByKey = new Map<string, string[]>();
  if (!vector && activeFileRecords.length > 0) {
    const ftsEntries = activeFileRecords.flatMap((rec) => rec.entries.flatMap((entry) => [
      { text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag: 'ki-search' },
      ...customTags.map((tag) => ({ text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag })),
    ]));
    try {
      const ftsResult = await ftsBulkStore(ftsEntries);
      const storedIds = new Set(ftsResult.ids);
      fullTextIndexed = ftsResult.ids.length;
      for (const rec of activeFileRecords) {
        const expected = rec.entries.flatMap((entry) => [
          getFtsDocId({ text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag: 'ki-search' }),
          ...customTags.map((tag) => getFtsDocId({ text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag })),
        ]);
        const newIds = expected.filter((id) => storedIds.has(id));
        const oldIds = rec.previousRelation?.ftsIds ?? [];
        const complete = newIds.length === expected.length;
        // 只有新索引完整时才清理旧索引；部分失败保留旧 ID，避免覆盖导入丢召回。
        fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, [...new Set(complete ? newIds : [...oldIds, ...newIds])]);
        if (complete) {
          const staleIds = oldIds.filter((id) => !newIds.includes(id));
          if (staleIds.length > 0) {
            const deleted = await ftsDeleteByIds({ scope, ids: staleIds });
            if (deleted.failed > 0) fullTextErrors.push({ path: rec.rel, error: `旧全文索引清理失败 ${deleted.failed} 条` });
          }
        } else {
          fullTextErrors.push({ path: rec.rel, error: `全文索引部分写入成功（${newIds.length}/${expected.length}）` });
        }
      }
      if (ftsResult.failed > 0 && fullTextErrors.length === 0) {
        fullTextErrors.push({ path: '<batch>', error: `全文索引写入失败 ${ftsResult.failed} 条` });
      }
    } catch (err) {
      fullTextErrors.push({ path: '<fts>', error: `全文索引写入失败：${(err as Error).message}` });
    }
  }
  if (vector && activeFileRecords.length > 0) {
    // 文档从 --no-vector 切换回 hybrid 时，先成功写入 dense，再清理该 relation
    // 以前的 FTS-only 文档；删除失败则保留 ftsIds，避免缓存宣称已清理。
    for (const rec of activeFileRecords) {
      const oldIds = rec.previousRelation?.ftsIds ?? [];
      if (oldIds.length === 0) continue;
      try {
        const deleted = await ftsDeleteByIds({ scope, ids: oldIds });
        if (deleted.failed > 0) {
          fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, oldIds);
          fullTextErrors.push({ path: rec.rel, error: `切换到向量模式时旧全文索引清理失败 ${deleted.failed} 条` });
        } else {
          fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, []);
        }
      } catch (err) {
        fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, oldIds);
        fullTextErrors.push({ path: rec.rel, error: `切换到向量模式时旧全文索引清理失败：${(err as Error).message}` });
      }
    }
  }

  // 关系/路径辅助向量也先写新值，再进入旧向量清理；若某个 relation 的新辅助向量
  // 写失败，则保留该 relation 的旧辅助向量，避免先删后写造成导航索引空洞。
  checkCancelled();
  const pathEntries: PathVectorizeEntry[] = [];
  const groupSet = new Set<string>();
  for (const e of activeEntries) {
    const groupPath = e.groupPath;
    groupSet.add(groupPath);
    pathEntries.push({
      text: buildRelationContent(e.chunkRelation || deriveChunkRelation(e.path.split('#')[0], Number(e.path.split('#')[1])), groupPath),
      tag: 'ki-relation',
      scope,
      group: groupPath,
    });
  }
  for (const groupPath of groupSet) {
    pathEntries.push({ text: buildGroupPathContent(groupPath), tag: 'ki-path', scope });
  }
  const failedRelationPathTexts = new Set<string>();
  const auxiliaryErrors: { path: string; error: string }[] = [];
  if (vector && pathEntries.length > 0) {
    const pathResult = await bulkStorePaths(pathEntries, { abortSignal: args.abortSignal });
    const relationPathTexts = new Set(pathEntries.filter((entry) => entry.tag === 'ki-relation').map((entry) => entry.text));
    for (const item of pathResult.errors) {
      if (relationPathTexts.has(item.text)) failedRelationPathTexts.add(item.text);
      auxiliaryErrors.push({ path: item.text, error: `路径向量写入失败：${item.error}` });
    }
    logInfo(`路径向量写入完成：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
  }

  // 仅清理受影响 relation 的旧内容/标签向量；被其他 relation 共享的确定性 docId 不删除。
  if (vector) {
    const targetKeys = new Set(activeFileRecords.map((rec) => `${rec.groupPath}\u0000${rec.relation}`));
    const protectedVectorIds = new Set<string>();
    const protectedPathIds = new Set<string>();
    for (const [groupPath, groupData] of Object.entries(relationsCache0.groups)) {
      for (const relation of groupData.hot_relations) {
        const key = `${groupPath}\u0000${relation.text}`;
        if (targetKeys.has(key)) continue;
        for (const id of relationMemoryIds(relation)) protectedVectorIds.add(id);
        for (let i = 1; i <= relationContentVectorCount(relation); i += 1) {
          protectedPathIds.add(generateDocId(
            buildRelationContent(`${relation.text}-${String(i).padStart(2, '0')}`, groupPath),
            scope,
            'ki-relation',
          ));
        }
      }
    }

    const staleIds = new Set<string>();
    for (const rec of activeFileRecords) {
      const oldIds = relationMemoryIds(rec.previousRelation);
      const newIds = new Set([
        ...rec.entries.map((entry) => activeMergedMap.get(entry.path)).filter((id): id is string => !!id),
        ...(tagMemoryMap.get(rec.rel) ?? []),
      ]);
      for (const id of oldIds) {
        if (!newIds.has(id) && !protectedVectorIds.has(id)) staleIds.add(id);
      }

      const oldRelationName = rec.previousRelation?.text ?? rec.relation;
      const relationPathTexts = new Set(
        rec.entries
          .map((entry) => entry.chunkRelation)
          .filter((chunkRelation): chunkRelation is string => !!chunkRelation)
          .map((chunkRelation) => buildRelationContent(chunkRelation, rec.groupPath)),
      );
      const relationPathWriteFailed = [...relationPathTexts].some((text) => failedRelationPathTexts.has(text));
      const newPathIds = new Set(
        rec.entries
          .map((entry) => entry.chunkRelation)
          .filter((chunkRelation): chunkRelation is string => !!chunkRelation)
          .map((chunkRelation) => generateDocId(buildRelationContent(chunkRelation, rec.groupPath), scope, 'ki-relation')),
      );
      for (let i = 1; i <= relationContentVectorCount(rec.previousRelation); i += 1) {
        if (relationPathWriteFailed) break;
        const oldPathId = generateDocId(
          buildRelationContent(`${oldRelationName}-${String(i).padStart(2, '0')}`, rec.groupPath),
          scope,
          'ki-relation',
        );
        if (!newPathIds.has(oldPathId) && !protectedPathIds.has(oldPathId)) staleIds.add(oldPathId);
      }
    }
    // 旧向量清理是收尾动作：若底层只部分删除，仍要把新 relation/local KB
    // 一起落盘，避免出现“KB 已更新但 cache 仍指向旧 memoryIds”的更大不一致；
    // 未删除的旧 ID 会通过 errors 显式反馈，后续可重试清理。
    await deleteVectorIds(scope, staleIds, '清理受影响文档旧向量', false, vectorCleanupErrors);
  }

  // 取消请求在向量化批次完成后生效。
  checkCancelled();

  // ── Phase 3/4：Group 树 + relation-cache（串行，KB 写入近实时无并行损失）──
  checkCancelled();
  args.onProgress?.({ phase: 'persist', done: 0, total: 1 });
  // groups 初始集：缺省 group 时为空（由 phase3EnsureGroups 从 entries 反推），显式 group 时含该根
  const ctx: ImportContext = {
    scope,
    sourceDir,
    group,
    entries: activeEntries,
    memoryMap,
    groups: new Set<string>(group ? [group] : []),
  };
  logPhaseStart(3, TOTAL, '构建 Group 树 ...');
  phase3EnsureGroups(ctx, groupIndex);
  logPhaseDone(3, TOTAL, `Group 树构建完成，涉及 ${ctx.groups.size} 个 Group`);

  logPhaseStart(4, TOTAL, `写入元数据（${ctx.entries.length} 条 relations）...`);
  phase4WriteRelations(ctx, relationsCache);
  for (const rec of activeFileRecords) {
    const rel = relationsCache.groups[rec.groupPath]?.hot_relations.find((item) => item.text === rec.relation);
    const ftsIds = fullTextIdsByKey.get(`${rec.groupPath}\u0000${rec.relation}`);
    if (rel && ftsIds) rel.ftsIds = ftsIds;
  }
  // 方案 D 回填：按文件聚合全部 chunk memoryId → 写入文件级 relation 的 memoryIds 多值；
  // 自定义 tag 无论是否向量化都持久化到 relation.tags（与 sync-relation 一致，供后续重建恢复）
  const mergedMap = activeMergedMap;
  if (mergedMap.size > 0 || tagMemoryMap.size > 0 || customTags.length > 0) {
    for (const rec of activeFileRecords) {
      // 该文件全部 chunk 的 memoryId（按 sourcePath 文件#N 匹配）
      const ids = rec.entries
        .map((e) => mergedMap.get(e.path))
        .filter((id): id is string => !!id);
      const groupData = relationsCache.groups[rec.groupPath];
      const rel = groupData?.hot_relations.find((r) => r.text === rec.relation);
      if (rel) {
        // 追加文档级自定义 tag 向量的 docId（使 -t <tag> 可召回）
        const tagIds = tagMemoryMap.get(rec.rel) ?? [];
        const allIds = [...ids, ...tagIds];
        if (allIds.length > 0) {
          rel.memoryIds = allIds;
          rel.memoryId = allIds[0]; // 兼容单值消费方
        }
        // 持久化自定义 tag 到 KB 层（relation.tags），供 rebuild-vector/restore 恢复 tag 向量
        rel.tags = customTags.length > 0 ? customTags : undefined;
      }
    }
  }
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
  args.onProgress?.({ phase: 'persist', done: 1, total: 1 });
  logPhaseDone(4, TOTAL, '元数据写入完成');
  const kbResult = ctx;

  // Phase 5: 记录 source（含切分参数持久化 H-18；不再依赖 git commit——增量由幂等追加承载）
  logPhaseStart(5, TOTAL, '记录 source ...');
  const source: GroupIndexSource = {
    dir: sourceDir,
    chunkSize,
    chunkOverlap,
  };
  setSource(scope, source);
  logPhaseDone(5, TOTAL, `source 已记录（dir=${sourceDir}）`);

  const importErrors = [...vectorizeResult.errors, ...tagErrors, ...auxiliaryErrors, ...vectorCleanupErrors, ...fullTextErrors];
  logSummary(`直导完成：files=${files.length}  chunks=${entries.length}  vectorized=${mergedMap.size}  fulltext=${fullTextIndexed}  skipped=${skipped.length + failedRecords.size}  errors=${importErrors.length}  assets=${assetCopied.size}${vector ? '' : '  [FTS-only:不写dense]'}${assetsEnabled ? '' : '  [附件收集已关闭]'}`);

  // REQ-02 生命周期②：成功导入清除中断标记 + 释放导入锁（N4）
  releaseImportLock(scope);
  lockAcquired = false;
  if (onInterrupt) {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }

  return {
    ok: true,
    action: 'import',
    scope,
    stats: {
      total: entries.length,
      vectorized: mergedMap.size,
      errors: importErrors.length,
      // skipped 合并：过大/超限/hook 失败 + relation 冲突（REQ-06：冲突计入 skipped）
      skipped: skipped.length + conflicts.filter((item) => item.action === 'skip').length + failedRecords.size,
      vector,
      assets: assetCopied.size,
      conflicts: conflicts.length,
      fullTextIndexed,
    },
    errors: importErrors,
    conflicts,
    groups: [...kbResult.groups].sort(),
    source,
  };
  } finally {
    if (process.env.KI_DAEMON_OWNER !== '1') await closeFtsEngine(scope);
    // 任意失败（配置/扫描/向量化/元数据写入）都必须释放 import.lock，
    // 否则下一次导入会被误判为“仍有任务运行”。取消路径已提前清锁，
    // 这里通过 lockAcquired 保证幂等；成功路径 releaseImportLock 同样会置 false。
    if (lockAcquired) {
      clearImportLock(scope);
      lockAcquired = false;
    }
    if (onInterrupt) {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
    }
  }
}

// ─── Group 树构建 ───────────────────────────────────────

// ensureGroupPathInTree 已提取到 scope.ts 作为公共函数

// ─── relations-cache 操作 ───────────────────────────────

function ensureCacheGroup(cache: RelationsCache, groupPath: string): GroupData {
  if (!cache.groups[groupPath]) {
    cache.groups[groupPath] = {
      hot_relations: [],
      keywords: [],
    };
  }
  return cache.groups[groupPath];
}

function generateNextId(cache: RelationsCache): string {
  let maxNum = 0;
  for (const data of Object.values(cache.groups)) {
    for (const rel of data.hot_relations) {
      const m = rel.id.match(/^rel_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
  }
  return `rel_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * upsert：以 (groupPath + relationText) 为主键
 * REQ-05（批次 3）：不再写入 keywords / isFullText（旧数据字段只读兼容）
 * 方案 D（REQ-20260807-001）：文件级 relation 挂 memoryIds 多值
 */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  memoryIds: string[] | null | undefined,
  sourcePath: string | null | undefined,
  tags?: string[]
): void {
  const groupData = ensureCacheGroup(cache, groupPath);
  let rel = groupData.hot_relations.find((r) => r.text === relationText);

  if (!rel) {
    rel = {
      id: generateNextId(cache),
      text: relationText,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
    };
    groupData.hot_relations.push(rel);
  } else {
    // 已存在：刷新为导入态，不做评分回退（与 import-kb 行为一致）
    rel.isImported = true;
  }
  // 方案 D：持久化全部 chunk docId（文件级 relation 多值）
  // 向量化失败/--no-vector 时 memoryIds 为空数组（文件级 relation 记录仍存在，sourcePath 必写）
  if (Array.isArray(memoryIds)) {
    rel.memoryIds = memoryIds;
    if (memoryIds.length > 0) rel.memoryId = memoryIds[0]; // 兼容单值消费方（取第一个）
  }
  if (sourcePath) rel.sourcePath = sourcePath;
  // 持久化自定义 tag 到 KB 层（relation.tags），供 rebuild-vector/restore 恢复 tag 向量
  if (tags && tags.length > 0) rel.tags = tags;
  else rel.tags = undefined; // 清空已删除的 tag（无 tag 时不留字段）
}

// ─── local KB 操作 ───────────────────────────────────────

function loadLocalKb(localKbPath: string): Record<string, unknown> {
  if (!fs.existsSync(localKbPath)) return {};
  return readJson<Record<string, unknown>>(localKbPath) || {};
}

function readLocalKb(scope: string, groupPath: string): Record<string, unknown> {
  return loadLocalKb(getLocalKbDir(scope, groupPath));
}

function cloneRelation(relation: Relation): Relation {
  return {
    ...relation,
    ...(relation.memoryIds ? { memoryIds: [...relation.memoryIds] } : {}),
    ...(relation.ftsIds ? { ftsIds: [...relation.ftsIds] } : {}),
    ...(relation.tags ? { tags: [...relation.tags] } : {}),
  };
}

function relationMemoryIds(relation: Relation | undefined): string[] {
  if (!relation) return [];
  const ids = Array.isArray(relation.memoryIds) ? [...relation.memoryIds] : [];
  if (ids.length === 0 && relation.memoryId) ids.push(relation.memoryId);
  return [...new Set(ids)];
}

function relationContentVectorCount(relation: Relation | undefined): number {
  if (!relation) return 0;
  return Math.max(0, relationMemoryIds(relation).length - (relation.tags?.length ?? 0));
}

function restoreLocalKb(
  scope: string,
  groupPath: string,
  relationText: string,
  previousText: string | undefined,
): void {
  if (previousText !== undefined) {
    writeLocalKb(scope, groupPath, relationText, previousText);
  } else {
    removeFromLocalKb(scope, groupPath, relationText);
  }
}

async function deleteVectorIds(
  scope: string,
  ids: Iterable<string>,
  label: string,
  strict = true,
  errors?: { path: string; error: string }[],
): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return;
  const result = await vectorDelete({ scope, ids: uniqueIds });
  if (result.errors.length > 0) {
    const message = `${label}失败：${result.errors.map((item) => `${item.id}: ${item.reason}`).join('; ')}`;
    errors?.push({ path: '<vector-cleanup>', error: message });
    if (strict) throw new Error(message);
    logWarn(message);
  }
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

/** 从 local KB 删除单条记录（P-7 hook 失败回滚用）；返回是否真的删了 */
function removeFromLocalKb(scope: string, groupPath: string, relationText: string): boolean {
  const localKbPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(localKbPath)) return false;
  const localKb = loadLocalKb(localKbPath);
  if (!(relationText in localKb)) return false;
  delete localKb[relationText];
  writeJson(localKbPath, localKb);
  return true;
}

// ─── Phase 实现 ─────────────────────────────────────────

/** Phase 3: ensure groups */
function phase3EnsureGroups(
  ctx: ImportContext,
  groupIndex: GroupIndex
): void {
  for (const e of ctx.entries) {
    ensureGroupPathInTree(groupIndex, e.groupPath);
    // 将完整路径及所有父级都加入 groups（如 'wiki/部署运维' → 'wiki' + 'wiki/部署运维'）
    const segments = e.groupPath.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      ctx.groups.add(segments.slice(0, i).join('/'));
    }
  }
}

/** Phase 4（方案 D）：只写 relations-cache 文件级 relation（local KB 已在导入第 1 步写入文件原文） */
function phase4WriteRelations(
  ctx: ImportContext,
  cache: RelationsCache
): void {
  // 文件级 relation 聚合：同 group 下相同 relation 名（文件级，basename 去扩展名）→ 一条记录
  const fileRelMap = new Map<string, { groupPath: string; relation: string; sourcePath: string }>();
  for (const e of ctx.entries) {
    // 从 entry.path（文件#N）还原文件路径
    const fileKey = e.path.includes('#') ? e.path.split('#')[0] : e.path;
    // 文件级 relation 优先取 entry 携带的逻辑名称；自动后缀时它可能不同于
    // sourcePath 的 basename。旧/rebuild 条目没有该字段时回退到 basename。
    const fileRelation = e.fileRelation ?? deriveRelationText(fileKey);
    fileRelMap.set(fileKey, { groupPath: e.groupPath, relation: fileRelation, sourcePath: fileKey });
  }

  let i = 0;
  const total = fileRelMap.size;
  for (const { groupPath, relation, sourcePath } of fileRelMap.values()) {
    i++;
    // 不传 sourcePath detail：避免 TTY \r 刷新长路径残留叠加成乱码（与全量导入进度一致）
    logProgress(i, total);
    // 方案 D：文件级 relation 挂 memoryIds（向量化完成后由回填逻辑写入），此处先建空记录占位
    upsertRelation(cache, groupPath, relation, [], sourcePath);
  }
}
