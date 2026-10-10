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
  getLocalKbDir,
  getAssetsDir,
  setSource,
  ensureGroupPathInTree,
  type GroupIndexSource,
  type GroupIndex,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { parseContentTags, type PartitionConfig } from './constants.js';
import { loadCacheShape, persistCacheShape, migrateLegacyRelationsCache, hasNoRelationsData, type LegacyRelationsCacheShape } from './group-cache.js';
import { writeImportIncomplete, clearImportIncomplete, readImportIncompleteStatus, backupImportIncomplete } from './import-retry.js';
// S-01（REQ-20261009-003）：静态导入协调器 —— 回滚等**同步**路径需要同步版元数据提交窗口
import { getSharedOperationCoordinator } from './operation-coordinator.js';
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
import { buildChunkLineRanges, type FtsLocator } from './original-locator.js';
import { acquireImportLock, releaseImportLock, clearImportLock, writeInterruptMark } from './interrupt.js';
import {
  buildGroupPathContent,
  buildRelationContent,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import { assertNoPendingVectorMigration, assertVectorDimensionCompatible, generateDocId, vectorBulkStore, vectorDelete } from './vector-client.js';
import { ftsBulkStore, ftsDeleteByIds, getFtsDocId } from './fts-client.js';
import { closeFtsEngine } from './fts-client.js';
import { classifyVectorizationStop, type VectorizationStopReason } from '../zvec-engine/errors.js';
import {
  resolveImportConflict,
  validateImportConflictMode,
  validateImportConflictSuffix,
  type ImportConflictAction,
  type ImportConflictMode,
} from './import-conflict.js';
import { resolveImportBudget, preflightImportBudget, budgetViolationMessage, IMPORT_BUDGET_EXCEEDED, type ImportBudget } from './import-budget.js';
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
  /**
   * R1（REQ-20261009-001）：文件级完成度。
   * 成功单元 = 文件（全部 chunk 向量化成功才算完成），是「完成 N / 未完成 M」
   * 的唯一口径（CLI 与 Web 同源）。
   */
  files: {
    /** 本次参与导入的文件数 */
    total: number;
    /** 文件级完成（已提交元数据与原文） */
    completed: number;
    /** 未完成（未提交元数据；已写入的部分向量按 D1 回滚删除） */
    incomplete: number;
    /** 本次扫描到的文件数（分母）：恒等式 `completed + incomplete + skipped = scanned` */
    scanned: number;
    /** 未进入最终处理的文件数（过大 / chunk 超限 / hook 失败 / 冲突跳过 / 同批覆盖替换） */
    skipped: number;
    /**
     * R3（REQ-20261010-001）：增量导入下「内容未变、跳过重算」的文件数。
     * 它是 completed 的**子集**（数据本就完整在位，无需重做），故不单独占一项，
     * 恒等式 `completed + incomplete + skipped = scanned` 仍然成立。
     */
    unchanged: number;
  };
}

/** R1：未完成文件条目（文件级；已成功文件不出现在清单中） */
export interface ImportIncompleteItem {
  /** 相对源目录的文件路径 */
  path: string;
  group: string;
  relation: string;
  reason: string;
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
  /**
   * R1（REQ-20261009-001）：部分成功——已提交文件级完成的部分，但仍有未完成文件。
   * 注意退出码语义（Q2）：partial 仍属**成功**（CLI 退出码 0 + 警告），
   * 不再是「全批回滚 + 抛错」。
   */
  partial: boolean;
  /** R1：未完成文件清单（供 CLI 打印与 Web「重试未完成 N 篇」） */
  incomplete: ImportIncompleteItem[];
  /** R1：系统性停止原因（若有）——与 partial 一起解释"为什么没导完" */
  stopReason?: { kind: string; code: string; phase: 'embedding' | 'persist'; reason: string };
  /** D2：本次收到取消请求（取消与系统停止同一条提交语义） */
  cancelled?: true;
  /**
   * R2：本次是「只重试未完成子集」时的过滤账目——
   * `requested` 清单条数 / `matched` 在源目录命中并实际处理的条数 / `missing` 已找不到的路径
   * （文件被删除或改名；这些条目会在未完成清单里保留，不会静默消失）。
   */
  retryFilter?: { requested: number; matched: number; missing: string[]; invalid?: string[] };
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
  /**
   * R2（REQ-20261009-001）：**只重试这些文件**（相对源目录的路径清单）。
   * 未列出的文件本轮完全不处理（不读原文、不复制附件、不写 KB、不向量化），
   * 用于「重试未完成部分」——已完成文件不重传、不重算 embedding、不产生 `_1` 副本。
   * 缺省 = 处理全部扫描到的文件（既有行为）。
   */
  onlyRelPaths?: string[];
  /** 文档级自定义标签（逗号分隔多个）。无论是否向量化均持久化到 relation.tags（供 rebuild-vector/restore 恢复）；向量化时额外为每个导入文件每个 tag 写一条内容向量 */
  tags?: string;
  /** 附件（本地图片）收集开关（REQ-20260904-001，默认 true；false = 不复制附件，前端对图片引用显示占位块） */
  assets?: boolean;
  /** 同一 Group 下不同 sourcePath 的同名处理策略，默认 suffix。 */
  conflictMode?: ImportConflictMode;
  /** 自动后缀模板，默认 _{n}。 */
  conflictSuffix?: string;
  /** 整批预算覆盖（S0-3，REQ-20260930-002）：显式参数 > scope 配置 import.batch > 默认值 */
  budget?: ImportBudget;
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
  /** 直连 CLI 在同步退出前落下取消任务终态。 */
  onInterrupt?: () => void;
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
export function collectMarkdownFiles(sourceDir: string, extensions: string[] = DEFAULT_EXTENSIONS): { files: string[]; skippedNonMd: string[] } {
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
    // REQ-20261010-001（用户要求）：同名附件先删除再写入——`copyFileSync` 虽有截断覆盖语义，
    // 但目标是只读文件、软链或早先写入的目录时会失败/跟随软链；先删后拷让"替换"确定的成立。
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.copyFileSync(abs, dst); // 幂等重导：同名覆盖
    copied.push(rel);
  }
  return { copied, warnings };
}

/**
 * R3（REQ-20261010-001）：判定某文件「内容未变」——可安全跳过切分 / embedding / 写入。
 *
 * 判据（全部本地计算，不调用 embedding）：
 *   1. local KB 原文与本次读到的原文逐字符相同（local KB 存原文，原文一致才谈得上未变）；
 *   2. 由「本次清洗 + 切分结果」推导的 docId 集合与 `relation.memoryIds` **完全一致**——
 *      chunk 内容向量（tag `ki-search`）+ 自定义标签向量（tag=<tag>，text=**文件原文**）。
 *      id 集合一致本身即蕴含"清洗与切分结果一致"，故切分参数/清洗规则变化会被自动识别为"变了"；
 *   3. FTS 侧不处于未完成态（`ftsIndexComplete === false` 时需重做以修复全文索引）；
 *      FTS **id 集合不参与比对**（`ftsIds` 只在 --no-vector 模式写入，见函数末尾说明）；
 *   4. 仅向量模式启用（`--no-vector` 的全文口径另行处理，暂不跳过）。
 *
 * 已知取舍（用户 2026-10-10 拍板）：不校验向量是否真的存在 —— `memoryIds` 一致即认为索引可用，
 * 向量丢失的场景由 `ki restore --rebuild-vector` 兜底。
 *
 * 降级行为：若上一次导入的**标签向量**写失败（memoryIds 缺 tag id），集合对不上 → 判定"变了"
 * → 本次重做全部（浪费一次，但不丢数据、可自愈）。
 */
function isContentUnchanged(args: {
  fileText: string;
  previousLocalText?: string;
  previousRelation?: Relation;
  entries: { text: string }[];
  /** 本次导入的自定义标签：标签变了集合就对不上 → 视为"变了"并重做 */
  tags: string[];
  scope: string;
}): boolean {
  const previous = args.previousRelation;
  if (!previous) return false;
  if (typeof args.previousLocalText !== 'string' || args.previousLocalText !== args.fileText) return false;
  if (previous.ftsIndexComplete === false) return false;
  const stored = new Set(relationMemoryIds(previous));
  if (stored.size === 0) return false;
  const expected = new Set<string>();
  for (const entry of args.entries) expected.add(generateDocId(entry.text, args.scope, 'ki-search'));
  for (const tag of args.tags) expected.add(generateDocId(args.fileText, args.scope, tag));
  if (expected.size !== stored.size) return false;
  for (const id of expected) if (!stored.has(id)) return false;
  // 全文索引为何**不**纳入 id 集合比对（challenger 质疑 2026-10-10 的处置）：
  // `ftsIds` 只在 `--no-vector`（FTS-only）模式写入，向量模式下恒为空 —— 若把它纳入判据，
  // 判定永远不成立、增量导入整体失效（实测：二次导入 unchanged 由 2 变 0）。
  // 而 FTS-only 模式本就不启用跳过（本函数只在 `vector` 为真时被调用），所以不存在
  // "跳过导致全文索引长期不修"的路径；上一个 FTS-only 导入留下的 relation 因 memoryIds 为空
  // 必然判"变了" → 会正常重做并转成 dense。
  return true;
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
  const { withScopeWriteLock } = await import('./scope-write-lock.js');
  return withScopeWriteLock(args.scope, 'import', () => handleDirectImportUnlocked(args));
}

async function handleDirectImportUnlocked(
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
  /** R3（REQ-20261010-001）：增量导入跳过重算的文件数（内容未变；计入 completed，单列可观测） */
  let unchangedFileCount = 0;
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
  /**
   * 取消请求的**统一收口**（D2，REQ-20261009-001）：进入向量写入阶段之后再收到取消，
   * 不再抛错丢弃全批——改为记下取消标记，让已完成（文件级）的部分继续提交、未完成
   * 清单随结果返回。原因：原实现在此处抛错会留下「向量已写入、元数据未落盘」的
   * 第三种中间态（能搜到、看不到），与系统停止路径分叉成两套语义。
   * 前置阶段（扫描/切分/原文 flush 之前）仍保留 fail-fast 抛错——那时没有任何
   * 已完成文件可提交。
   */
  let cancelRequested = false;
  const noteCancel = () => {
    if (args.abortSignal?.aborted) cancelRequested = true;
  };
  checkCancelled();
  assertNoPendingVectorMigration(scope);
  // 上传后的本地 KB/缓存修改前一次性拒绝维度冲突，避免每个文件重复失败。
  if (vector) await assertVectorDimensionCompatible(scope);

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
        args.onInterrupt?.();
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

  // 批次 2（W1）：预读改双轨（loadCurrentLayoutCache 统一入口）——新布局从分片聚合
  // 重建内存结构；旧布局读旧单文件（随后写入时惰性迁移）。内存结构 RelationsCache
  // 形状不变，全流程（冲突检测/upsert/回填）无需改动。
  let relationsCache0: RelationsCache;
  try {
    // 双轨读统一入口（group-cache.loadCacheShape）：新布局分片聚合 / 旧布局旧单文件。
    // 第二轮审查 P1：原实现自带一份手抄双读，与公共兼容层构成第二套语义（易漂移）。
    relationsCache0 = loadCacheShape(scope) as unknown as RelationsCache;
  } catch (err) {
    // 兼容旧报错文案（scope 未初始化的既有提示）；「数据在但读失败（损坏）」原样透出
    if (hasNoRelationsData(scope)) {
      throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
    }
    throw err;
  }

  // S0-3（REQ-20260930-002）：整批预算预检——读取任何文件内容/写入 KB 之前，
  // 仅凭文件清单 + stat 做三项检查（文件数/总字节/预计 chunk 数），超限 fail-loud。
  // 预估 chunk 用原始字节数上界近似（清洗只删不增），真实 chunk 数由扫描阶段产出。
  {
    // 先解析预算：bytes/chunks 两项均被显式关闭时跳过 stat 循环
    //（文件数检查仅用 files.length，大目录免白白付一轮 stat）
    const budget = resolveImportBudget(args.budget, importCfg?.batch);
    const needStat = budget.maxBatchBytes !== undefined || budget.maxBatchChunks !== undefined;
    let preflightBytes = 0;
    let preflightChunks = 0;
    if (needStat) {
      for (const rel of files) {
        const absPath = sourceIsFile ? sourceDir : path.resolve(sourceDir, rel);
        try {
          const size = fs.statSync(absPath).size;
          preflightBytes += size;
          preflightChunks += Math.ceil(size / chunkSize) + 1;
        } catch (err) {
          // collect 与 stat 之间的瞬态删除：不计入字节，扫描阶段会以既有口径
          //（单文件跳过/报错）处理——预检不为竞态窗口整批 fail
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new Error(`文件不可读：${absPath}（${(err as Error).message}）`);
        }
      }
    }
    const preflight = preflightImportBudget({
      files,
      totalBytes: preflightBytes,
      estimatedChunks: preflightChunks,
      budget,
    });
    if (!preflight.ok) {
      const err = new Error(budgetViolationMessage(preflight));
      (err as Error & { code?: string }).code = IMPORT_BUDGET_EXCEEDED;
      throw err;
    }
    if (needStat) {
      logInfo(`整批预算预检通过：files=${preflight.stats.fileCount} bytes=${preflight.stats.totalBytes} estChunks=${preflight.stats.estimatedChunks}`);
    }
  }

  // 仅在文件通过所有可跳过的前置处理、即将覆盖 local KB 时才失效旧状态；
  // 这样取消或跳过未触碰文件不会留下永久 incomplete。
  const ftsCompletionBeforeImport = new Map<string, boolean | undefined>();

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
  /** D7：组级原文写缓冲（groupPath → relation → 原文）；扫描循环内只进缓冲，
   *  扫描结束后每组一次 loadLocalKb+合并+writeJson 落盘（O(文档数)→O(组数)）。
   *  键在循环前由 ensureGroupBuffer 预建，避免热路径重复判空。 */
  const pendingKbWrites = new Map<string, Map<string, string>>();
  const ensureGroupBuffer = (groupPath: string): Map<string, string> => {
    let buf = pendingKbWrites.get(groupPath);
    if (!buf) {
      buf = new Map<string, string>();
      pendingKbWrites.set(groupPath, buf);
    }
    return buf;
  };
  /** 当前批次已接受的文件级 relation；避免同一批上传内重名漏判。 */
  const plannedRelations = new Map<string, Relation[]>();
  /** 附件收集告警（未命中/超限/越界等，循环后汇总）与已落盘的唯一附件集合（REQ-20260904-001） */
  const assetWarnings: string[] = [];
  /** 用 Set 去重：同一附件被多篇 md 引用时仅计一次（复制为同名覆盖，计数语义 = 落盘文件数） */
  const assetCopied = new Set<string>();
  // R2（REQ-20261009-001）：只重试未完成子集——名单外的文件本轮完全不处理（不读原文、
  // 不复制附件、不写 KB、不向量化，也不计入 skipped/errors）。未命中的清单条目
  //（源文件已删除/改名）单独记账，不静默消失。
  // P1（review）：重试清单可能被手工编辑或外部污染 → 在**核心层**统一净化（绝对路径 /
  // `..` 段 / 空值 / 超长一律拒绝），让 CLI、daemon、HTTP 三端获得同一防护（HTTP 侧另有校验）。
  const sanitizeRelPath = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const rel = value.trim();
    if (!rel || rel.length > 4096) return null;
    if (path.isAbsolute(rel)) return null;
    if (rel.split(/[\\/]/).includes('..')) return null;
    return rel;
  };
  const requestedRaw = Array.isArray(args.onlyRelPaths) ? args.onlyRelPaths : null;
  const invalidRelPaths: string[] = [];
  const requestedRels = new Set<string>();
  for (const raw of requestedRaw ?? []) {
    const rel = sanitizeRelPath(raw);
    if (rel) requestedRels.add(rel);
    else invalidRelPaths.push(String(raw));
  }
  if (requestedRaw && requestedRaw.length > 0 && requestedRels.size === 0) {
    throw new Error(
      `onlyRelPaths 的 ${requestedRaw.length} 条路径全部非法（绝对路径 / 含 .. / 空值或超长），`
      + '已拒绝执行以免误处理整批文件；请检查重试清单或重新导入',
    );
  }
  const onlySet = requestedRels.size > 0 ? requestedRels : null;
  const fileSet = new Set(files);
  const retryFilter = onlySet
    ? {
      requested: onlySet.size,
      matched: 0,
      missing: [...onlySet].filter((rel) => !fileSet.has(rel)),
      ...(invalidRelPaths.length > 0 ? { invalid: invalidRelPaths } : {}),
    }
    : undefined;
  if (retryFilter && retryFilter.missing.length > 0) {
    logWarn(`重试清单中有 ${retryFilter.missing.length} 个文件在当前源目录找不到（已删除或改名）：${retryFilter.missing.slice(0, 5).join('、')}${retryFilter.missing.length > 5 ? ' …' : ''}`);
  }
  if (invalidRelPaths.length > 0) {
    logWarn(`重试清单中有 ${invalidRelPaths.length} 条非法路径已忽略（绝对路径 / 含 .. / 空值或超长）：${invalidRelPaths.slice(0, 5).join('、')}${invalidRelPaths.length > 5 ? ' …' : ''}`);
  }
  if (onlySet && retryFilter && retryFilter.missing.length === onlySet.size) {
    throw new Error(
      `重试清单中的 ${onlySet.size} 个文件在当前源目录均不存在（已删除或改名）：${[...onlySet].slice(0, 5).join('、')}`
      + `；请确认 --source 指向原目录`,
    );
  }
  /** 本轮实际处理的文件（重试模式下 = 清单 ∩ 源目录）——进度分母/中断标记分母都必须用它，
   * 否则子集重试会显示 done 3/100 永不达 100%（复审 P2），中断标记也记全量。 */
  const effectiveFiles = onlySet ? files.filter((rel) => onlySet.has(rel)) : files;
  if (retryFilter) retryFilter.matched = effectiveFiles.length;

  totalFileCount = effectiveFiles.length; // 中断标记总文件数（REQ-01）
  args.onProgress?.({ phase: 'scan', done: 0, total: effectiveFiles.length });

  for (const rel of effectiveFiles) {
    checkCancelled();
    // 单文件导入：rel 是 basename，absPath 即 sourceDir 本身（避免 xxx.md/xxx.md 的 ENOTDIR）
    const absPath = sourceIsFile ? sourceDir : path.resolve(sourceDir, rel);
    const stat = fs.statSync(absPath);
    // 前置检查（先于写 local KB）：大小超限 / chunk 超限 / relation 冲突
    if (stat.size > maxFileSizeBytes) {
      skipped.push(rel);
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
      logWarn(`文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}）：${rel}，可手动切分后导入`);
      continue;
    }
    const fileText = fs.readFileSync(absPath, 'utf-8');
    const groupPath = resolveGroupForSource(group, rel, scope);
    const originalRelation = deriveRelationText(rel); // 文件级 relation（basename 去 .md）
    const groupData = relationsCache0.groups[groupPath];
    const currentBatchRelations = plannedRelations.get(groupPath) ?? [];
    // R2（REQ-20261010-001）：库中已有关系与本批已计划关系**分开传**——本批重复 rel 不再
    // 走「同 sourcePath 幂等覆盖」，而是当作撞名交给用户所选策略（否则 skip/suffix 失效）。
    const resolution = resolveImportConflict({
      relations: groupData?.hot_relations ?? [],
      batchRelations: currentBatchRelations,
      baseRelation: originalRelation,
      sourcePath: rel,
      mode: conflictMode,
      suffix: conflictSuffix,
    });
    if (resolution.action === 'skip') {
      conflicts.push({ path: rel, originalRelation, relation: resolution.relation, action: 'skip' });
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
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
    const previousRelationSnapshot = previousRelation ? cloneRelation(previousRelation) : undefined;
    const previousFtsKey = `${groupPath}\u0000${relation}`;
    if (previousRelationSnapshot && ftsCompletionBeforeImport.has(previousFtsKey)) {
      const previousCompletion = ftsCompletionBeforeImport.get(previousFtsKey);
      if (previousCompletion === undefined) delete previousRelationSnapshot.ftsIndexComplete;
      else previousRelationSnapshot.ftsIndexComplete = previousCompletion;
    }
    if (resolution.action === 'overwrite' && resolution.existing) {
      // 同 sourcePath 幂等重导或显式覆盖：允许重新写入 local KB + 向量化。
      logWarn(`文件已存在，幂等重导覆盖（${rel}）`);
    }
    // 清洗（方案 D：清洗只作用于向量化输入；local KB 存原文）
    // 执行顺序：内置规则 → 外部 hooks（REQ-07）；hook 全失败时保留旧 local KB。
    let textForVector = cleanEnabled ? cleanMarkdownText(fileText, cleanRules) : fileText;
    if (cleanEnabled && cleanHooks.length > 0) {
      const hookResult = await runCleanHooks(textForVector, cleanHooks);
      if (!hookResult.ok) {
        // P-7：所有 hooks 均失败 → 不写入向量，也不覆盖旧 local KB，文件计入 skipped。
        skipped.push(rel);
        logWarn(`清洗 hook 失败已跳过（${rel}）：${hookResult.failedHooks.join(', ')}，未覆盖旧 local KB`);
        processedFileCount++;
        args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
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
      // chunk 超限发生在覆盖之前，旧 local KB 与索引状态均保持不变。
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
      continue;
    }
    // 文件已通过所有可跳过的前置处理，即将覆盖 local KB。旧 FTS relation 先持久化
    // incomplete，防止进程在原文变更后中断仍把旧索引展示为完整。
    if (previousRelationSnapshot?.ftsIds?.length) {
      if (!ftsCompletionBeforeImport.has(previousFtsKey)) {
        ftsCompletionBeforeImport.set(previousFtsKey, previousRelationSnapshot.ftsIndexComplete);
      }
      const cached = relationsCache0.groups[groupPath]?.hot_relations.find((item) => item.text === relation);
      if (cached) {
        cached.ftsIndexComplete = false;
        // 批次 2：incomplete 预标记立即落盘（中断安全语义保持；新布局=分片批写，
        // 旧布局=整文件回退），不并入批末。
        persistTouchedGroups(scope, relationsCache0, new Set([groupPath]));
      }
    }
    // 方案 D：文件级原文（未清洗）仅在检查通过后写入。
    // D7（批次 2）：写入组级内存缓冲——同组 N 篇聚合为每 KB index.json 一次落盘
    //（原逐篇读改写整个 index.json，111 篇的组 = 111 次读改写 4.5MB）。
    // 中断安全性：缓冲在 hook 失败/chunk 超限回滚点**之后**才并入，被跳过文件不进缓冲；
    // 进程中断时本批缓冲丢失 → local KB 保持导入前状态，与旧"逐篇写"的已写部分
    // 相比少了部分推进，但幂等重导语义不变（重跑全量覆盖）。
    // 附件收集（REQ-20260904-001）：置于两个回滚点（hook 失败 / chunk 超限）之后 → 被跳过文件不产生孤儿附件，无需回滚。
    // R3：置于「内容未变」判定**之前** —— 正文未变但引用的图片已改时，附件仍会替换（同名先删后写）。
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
    // R3（REQ-20261010-001）：增量导入——内容未变则跳过切分 / embedding / 写入 / 原文重写
    // （附件已按上面照常复制）。计完成而非跳过：该文件的数据本就完整在位。
    if (conflictMode === 'incremental' && vector
      && isContentUnchanged({
        fileText,
        previousLocalText: typeof previousLocalText === 'string' ? previousLocalText : undefined,
        previousRelation: previousRelationSnapshot,
        entries,
        tags: customTags,
        scope,
      })) {
      unchangedFileCount += 1;
      logInfo(`内容未变，增量跳过重算（${rel}）`);
      processedFileCount++;
      args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
      continue;
    }
    ensureGroupBuffer(groupPath).set(relation, fileText);
    fileRecords.push({
      rel,
      groupPath,
      relation,
      previousRelation: previousRelationSnapshot,
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
    logProgress(fileRecords.length, effectiveFiles.length);
    args.onProgress?.({ phase: 'scan', done: processedFileCount, total: effectiveFiles.length });
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
  if (unchangedFileCount > 0) {
    logInfo(`增量导入：${unchangedFileCount} 个文件内容未变，已跳过重算（不重切分 / 不重算 embedding / 不重写向量与原文）`);
  }
  // R3：整批都未变（且没有其他待处理文件）不是"无可导入文件"，而是增量导入的正常终态——必须成功返回。
  // 该分支**不做任何写入**（含不更新 group-index.source、不写 local KB/向量/元数据）——
  // 这正是增量导入"零重算"的含义；files.total 因此为 0，而 completed = 未变文件数。
  if (fileRecords.length === 0 && unchangedFileCount > 0) {
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
        skipped: skipped.length + conflicts.filter((item) => item.action === 'skip').length,
        vector,
        assets: assetCopied.size,
        conflicts: conflicts.length,
        // 整批未变时无任何写入，全文索引自然为 0
        fullTextIndexed: 0,
        files: {
          total: 0,
          completed: unchangedFileCount,
          incomplete: 0,
          scanned: effectiveFiles.length,
          skipped: Math.max(0, effectiveFiles.length - unchangedFileCount),
          unchanged: unchangedFileCount,
        },
      },
      partial: false,
      incomplete: [],
      errors: [],
      conflicts,
      groups: [],
      source: { dir: sourceDir, chunkSize, chunkOverlap },
    };
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
          files: { total: 0, completed: 0, incomplete: 0, scanned: 0, skipped: 0, unchanged: 0 },
        },
        partial: false,
        incomplete: [],
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

  // D7（批次 2）：flush 组级原文缓冲——每组一次 loadLocalKb+合并+writeJson
  //（替代逐篇读改写；O(文档数)→O(组数) 落盘）。回滚路径（hook 失败等）不走缓冲、
  // 已即时写回，此 flush 只含最终接受导入的文件。
  //
  // S-01（REQ-20261009-003）已知残留中间态：本 flush 不在「元数据提交窗口」内，
  // 因此从这一刻到 Phase 4 提交 relations 分片之间，**覆盖导入的文档可能出现
  // "正文已新、列表元数据仍旧"**（用户拍板选项 b 时接受的形态）。
  // 反向的"列表里有、点开 404"不会发生：正常路径不删 KB，删除只出现在回滚路径，
  // 且回滚会同步落盘分片（见 restoreLocalKb / persistTouchedGroups 调用点）。
  for (const [groupPath, relations] of pendingKbWrites) {
    if (relations.size === 0) continue;
    const localKbPath = getLocalKbDir(scope, groupPath);
    fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
    const localKb = loadLocalKb(localKbPath);
    for (const [relationText, content] of relations) {
      localKb[relationText] = content;
    }
    writeJson(localKbPath, localKb);
  }
  pendingKbWrites.clear();

  // 2) Phase 2~5
  const TOTAL = 5;
  const memoryMap = new Map<string, string>();
  checkCancelled();
  args.onProgress?.({ phase: 'vectorize', done: 0, total: Math.max(entries.length, 1) });

  // ── 预读 group-index（relations 元数据已在步骤 0 预读为 relationsCache0）──
  const groupIndexPath = getGroupIndexPath(scope);
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
  noteCancel(); // D2：向量已开始写入 → 取消转为"提交已完成 + 未完成清单"
  args.onProgress?.({ phase: 'vectorize', done: Math.max(0, entries.length - (vectorizeResult.notProcessed ?? 0)), total: Math.max(entries.length, 1) });

  // ── 文档级自定义 tag 向量写入（可选）：为每个成功导入文件写一条 tag 内容向量 ──
  // 机制对齐 sync-relation：text=文件原文、tags=自定义 tag（每个 tag 各一条），
  // 使 `ki search -t <tag>` 能召回导入文件。tag 向量 docId 回填到文件级 relation 的 memoryIds。
  let tagMemoryMap = new Map<string, string[]>();
  const tagErrors: { path: string; error: string }[] = [];
  const vectorCleanupErrors: { path: string; error: string }[] = [];
  const failedRecords = new Set<typeof fileRecords[number]>();
  let systemStopReason: VectorizationStopReason | undefined = vectorizeResult.stopReason;
  let systemStopStats: {
    scope: string;
    phase: 'embedding' | 'persist';
    total: number;
    succeeded: number;
    failed: number;
    notProcessed: number;
    partialCommitted: number;
  } | undefined;
  const partialCommittedIds = new Set<string>();
  if (systemStopReason) {
    const notProcessed = vectorizeResult.notProcessed ?? 0;
    systemStopStats = {
      scope,
      phase: vectorizeResult.stopReason?.phase ?? 'embedding',
      total: entries.length,
      succeeded: vectorizeResult.ok.size,
      failed: vectorizeResult.failed ?? Math.max(0, vectorizeResult.errors.length - notProcessed),
      notProcessed,
      partialCommitted: 0,
    };
  }
  // R1（REQ-20261009-001，用户拍板 Q1）：**文件级完成判定，不做全批连坐**——
  // 系统性向量故障时也只把「存在未成功 chunk」的文件算未完成，其余文件照常提交
  // （原实现在此把全批塞进 failedRecords，导致已成功的文件也被回滚删除）。
  // 零完成（activeFileRecords 为空）仍走下方既有失败分支，不会把"全失败"当成功。
  for (const rec of fileRecords) {
    if (vector && rec.entries.some((entry) => !vectorizeResult.ok.has(entry.path))) {
      failedRecords.add(rec);
    }
  }
  noteCancel(); // D2：取消不再丢弃已写入的向量
  if (vector && !systemStopReason && customTags.length > 0) {
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
            // R1（REQ-20261009-001，P0-2）：标签向量属**辅助向量**——写失败不再把文件标为
            // 「未完成」（否则正文向量已成功的文档会被回滚删除、整批不可用）。降级为记账 +
            // 提示重建：正文照常提交可浏览/可检索，仅 `ki search -t <tag>` 暂时召回不到该文件。
            tagErrors.push({
              path: rec.rel,
              error: `标签向量写入失败：${item.error || 'unknown error'}（不影响正文，可用 ki rebuild-vector 重建标签向量）`,
            });
          }
        }
        tagMemoryMap = newMap;
        if (tagResult.stopReason) {
          systemStopReason = tagResult.stopReason;
          systemStopStats = {
            scope,
            phase: tagResult.stopReason.phase,
            total: tagEntries.length,
            succeeded: tagResult.succeeded,
            failed: tagResult.failed,
            notProcessed: tagResult.notProcessed ?? 0,
            partialCommitted: 0,
          };
          if ((tagResult.notProcessed ?? 0) > 0) {
            tagErrors.push({
              path: '<tags>',
              error: `标签向量有 ${tagResult.notProcessed} 条未处理（系统性停止：${tagResult.stopReason.kind}/${tagResult.stopReason.code}）；正文已提交，标签可用 ki rebuild-vector 重建`,
            });
          }
          logWarn(`标签向量系统性停止（${tagResult.stopReason.kind}/${tagResult.stopReason.code}）：成功 ${tagResult.succeeded}/${tagEntries.length}，已降级为辅助向量缺失（不影响正文可用性）`);
        }
        logInfo(`自定义标签向量写入完成：成功 ${tagResult.results.filter((r) => r.success).length}/${tagEntries.length}`);
      } catch (err) {
        systemStopReason = classifyVectorizationStop(err as Error, 'embedding');
        systemStopStats = {
          scope,
          phase: 'embedding',
          total: tagEntries.length,
          succeeded: 0,
          failed: tagEntries.length,
          notProcessed: 0,
          partialCommitted: 0,
        };
        // R1（P0-2）：同上——批量调用失败只让「标签向量」缺失，不标文件未完成、不回滚正文。
        for (const rec of tagRecords) {
          tagErrors.push({
            path: rec.rel,
            error: `标签向量写入失败：${(err as Error).message}（不影响正文，可用 ki rebuild-vector 重建标签向量）`,
          });
        }
        logWarn(`自定义标签向量写入失败：${(err as Error).message}（已降级：正文照常提交，标签可用 ki rebuild-vector 重建）`);
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
    for (const id of await deleteVectorIds(scope, rollbackIds, `回滚文档 ${rec.rel} 的新向量`, false, vectorCleanupErrors)) {
      partialCommittedIds.add(id);
    }
  }

  // 向量化失败的文件已恢复旧 local KB，且其旧 FTS ID 未被清理；恢复原完成标记。
  // 活跃文件仍保持 incomplete，直到 Phase 4 持久化本次最终 dense/FTS 状态。
  let ftsStatusRestored = false;
  const restoredGroups = new Set<string>();
  for (const rec of failedRecords) {
    const previous = rec.previousRelation;
    if (!previous?.ftsIds?.length) continue;
    const relation = relationsCache0.groups[rec.groupPath]?.hot_relations.find((item) => item.text === rec.relation);
    if (!relation) continue;
    if (previous.ftsIndexComplete === undefined) delete relation.ftsIndexComplete;
    else relation.ftsIndexComplete = previous.ftsIndexComplete;
    ftsStatusRestored = true;
    restoredGroups.add(rec.groupPath);
  }
  // 批次 2：中断安全回写改分片——只写被触达的组（旧布局则保持旧写整文件的回退语义）
  if (ftsStatusRestored) persistTouchedGroups(scope, relationsCache0, restoredGroups);

  // R1（REQ-20261009-001）：系统性停止**不再抛错回滚全批**——已完成（文件级）的部分
  // 继续走 Phase 3/4/5 提交并对外可用，未完成清单随结果返回（CLI 退出码 0 + 警告、
  // Web 任务 partial，与 Q2「CLI/Web 同口径」一致）。
  // 停止信息保留在结果里（stopReason + stats.files），供两端展示与"只重试未完成"使用。
  let stopReport: { kind: string; code: string; phase: 'embedding' | 'persist'; reason: string } | undefined;
  if (systemStopReason) {
    const stats = systemStopStats ?? {
      scope,
      phase: 'embedding' as const,
      total: entries.length,
      succeeded: vectorizeResult.ok.size,
      failed: vectorizeResult.failed ?? Math.max(0, vectorizeResult.errors.length - (vectorizeResult.notProcessed ?? 0)),
      notProcessed: vectorizeResult.notProcessed ?? 0,
      partialCommitted: 0,
    };
    stats.partialCommitted = partialCommittedIds.size;
    stopReport = {
      kind: systemStopReason.kind,
      code: systemStopReason.code,
      phase: stats.phase,
      reason: systemStopReason.reason,
    };
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
  const fullTextLocatorsByKey = new Map<string, FtsLocator[]>();
  const fullTextCompleteByKey = new Map<string, boolean>();
  if (!vector && activeFileRecords.length > 0) {
    // 先按未完成处理；FTS 批次失败、或只写入了部分 entries 时不能沿用旧成功状态。
    // 对覆盖已有 Relation 的情况，先原子持久化 false：进程若在 FTS 写入后、Phase 4 前中断，
    // 页面也不会继续把可能已部分覆盖的旧索引显示为完整。新 Relation 尚未登记，无需预写。
    // 批次 2：persistedCache 改双轨读（新布局=分片聚合，旧布局=旧文件）；
    // 预写改分片单组写（persistTouchedGroups）。
    const persistedCache = loadCacheShape(scope) as unknown as RelationsCache;
    let completionInvalidated = false;
    const invalidatedGroups = new Set<string>();
    for (const rec of activeFileRecords) {
      fullTextCompleteByKey.set(`${rec.groupPath}\u0000${rec.relation}`, false);
      const cached = persistedCache.groups[rec.groupPath]?.hot_relations.find((item) => item.text === rec.relation);
      if (cached) {
        cached.ftsIndexComplete = false;
        completionInvalidated = true;
        invalidatedGroups.add(rec.groupPath);
      }
      const inMemory = relationsCache.groups[rec.groupPath]?.hot_relations.find((item) => item.text === rec.relation);
      if (inMemory) inMemory.ftsIndexComplete = false;
    }
    if (completionInvalidated) persistTouchedGroups(scope, persistedCache, invalidatedGroups);
    const ftsEntries = activeFileRecords.flatMap((rec) => rec.entries.flatMap((entry) => [
      { text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag: 'ki-search' },
      ...customTags.map((tag) => ({ text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag })),
    ]));
    try {
      const ftsResult = await ftsBulkStore(ftsEntries);
      const storedIds = new Set(ftsResult.ids);
      fullTextIndexed = ftsResult.ids.length;
      for (const rec of activeFileRecords) {
        const chunkRanges = buildChunkLineRanges(
          // local KB 保存的就是这份未清洗原文；这里读取 source 文件，避免把清洗文本误当原文。
          fs.readFileSync(sourceIsFile ? sourceDir : path.resolve(sourceDir, rec.rel), 'utf-8'),
          rec.chunks,
        );
        const expectedEntries = rec.entries.flatMap((entry, entryIndex) => [
          { entryIndex, entry, fts: { text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag: 'ki-search' as const } },
          ...customTags.map((tag) => ({ entryIndex, entry, fts: { text: entry.text, scope, group: rec.groupPath, relation: rec.relation, tag } })),
        ]);
        const expected = expectedEntries.map(({ fts }) => getFtsDocId(fts));
        const newIds = expected.filter((id) => storedIds.has(id));
        const oldIds = rec.previousRelation?.ftsIds ?? [];
        let complete = newIds.length === expected.length;
        let trackedIds = complete ? [...newIds] : [...oldIds, ...newIds];
        const newLocators: FtsLocator[] = expectedEntries.flatMap(({ entryIndex }, index) => {
          const range = chunkRanges.get(rec.chunks[entryIndex].index);
          if (!range) return [];
          const id = expected[index];
          return [{ ftsId: id, sourcePath: rec.rel, chunkIndex: rec.chunks[entryIndex].index, ...range }];
        }).filter((locator) => storedIds.has(locator.ftsId));
        const oldLocators = rec.previousRelation?.ftsLocators ?? [];
        if (complete) {
          const staleIds = oldIds.filter((id) => !newIds.includes(id));
          if (staleIds.length > 0) {
            try {
              const deleted = await ftsDeleteByIds({ scope, ids: staleIds });
              if (deleted.failed > 0) {
                complete = false;
                trackedIds = [...newIds, ...deleted.failedIds];
                fullTextErrors.push({ path: rec.rel, error: `旧全文索引清理失败 ${deleted.failed} 条` });
              }
            } catch (err) {
              complete = false;
              trackedIds = [...newIds, ...staleIds];
              fullTextErrors.push({ path: rec.rel, error: `旧全文索引清理失败：${(err as Error).message}` });
            }
          }
        }
        if (newIds.length !== expected.length) {
          fullTextErrors.push({ path: rec.rel, error: `全文索引部分写入成功（${newIds.length}/${expected.length}）` });
        }
        fullTextCompleteByKey.set(`${rec.groupPath}\u0000${rec.relation}`, complete);
        const trackedIdSet = new Set(trackedIds);
        fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, [...trackedIdSet]);
        const locatorMap = new Map<string, FtsLocator>();
        for (const locator of [...oldLocators, ...newLocators]) {
          if (trackedIdSet.has(locator.ftsId)) locatorMap.set(locator.ftsId, locator);
        }
        fullTextLocatorsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, [...locatorMap.values()]);
      }
      if (ftsResult.failed > 0 && fullTextErrors.length === 0) {
        fullTextErrors.push({ path: '<batch>', error: `全文索引写入失败 ${ftsResult.failed} 条` });
      }
    } catch (err) {
      fullTextErrors.push({ path: '<fts>', error: `全文索引写入失败：${(err as Error).message}` });
    }
  }
  // 关系/路径辅助向量也先写新值，再进入旧向量清理；若某个 relation 的新辅助向量
  // 写失败，则保留该 relation 的旧辅助向量，避免先删后写造成导航索引空洞。
  noteCancel(); // D2：取消不再丢弃已写入的向量
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
  // R1（REQ-20261009-001）：本次运行已系统性停止 / 已取消时**跳过关系与路径辅助向量**。
  // 必要性（不只是省一次请求）：该阶段自带"失败即回滚本批已提交内容"的收尾（见下方
  // pathResult.stopReason 分支）——嵌 provider 仍不可用时它会删掉刚提交成功的正文向量，
  // 把 R1 的"部分可用"抵消掉。辅助向量可由 `ki rebuild-vector` 重建，不影响已完成文档
  // 的浏览与检索。
  if (vector && !systemStopReason && !cancelRequested && pathEntries.length > 0) {
    const pathResult = await bulkStorePaths(pathEntries, { abortSignal: args.abortSignal });
    if (pathResult.stopReason) {
      // R1（REQ-20261009-001，P1-1）：辅助向量阶段**降级而非整批回滚**——正文/标签向量此时
      // 均已成功写入，回滚它们等于把「已完成」重新变成「不可用」（用户视角与修复前一致：文档消失）。
      // 降级口径：① 未写入成功的 `ki-relation` 条目登记为「路径写入失败」，使下方旧向量清理
      // 保留其旧索引（导航仍可用，不产生空洞）；② 汇总一条 error 说明辅助向量缺失并给重建出路；
      // ③ 正文/标签/元数据照常提交。
      const stopRelationPathTexts = new Set(
        pathEntries.filter((entry) => entry.tag === 'ki-relation').map((entry) => entry.text),
      );
      let pathUnwritten = 0;
      for (const entry of pathEntries) {
        if (pathResult.ok.has(entry.text)) continue;
        pathUnwritten += 1;
        if (stopRelationPathTexts.has(entry.text)) failedRelationPathTexts.add(entry.text);
      }
      auxiliaryErrors.push({
        path: '<ki-path/ki-relation>',
        error: `关系/路径辅助向量未全部写入（${pathResult.stopReason.kind}/${pathResult.stopReason.code}）：`
          + `成功 ${pathResult.ok.size}，未写入 ${pathUnwritten}；未写入部分沿用旧索引，可用 ki rebuild-vector 重建（不影响已完成文档的浏览与检索）`,
      });
      logWarn(`关系/路径辅助向量系统性停止（${pathResult.stopReason.kind}/${pathResult.stopReason.code}）：成功 ${pathResult.ok.size}/${pathEntries.length}，已降级为辅助索引缺失（正文不受影响）`);
    }
    const relationPathTexts = new Set(pathEntries.filter((entry) => entry.tag === 'ki-relation').map((entry) => entry.text));
    for (const item of pathResult.errors) {
      if (relationPathTexts.has(item.text)) failedRelationPathTexts.add(item.text);
      auxiliaryErrors.push({ path: item.text, error: `路径向量写入失败：${item.error}` });
    }
    logInfo(`路径向量写入完成：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
  } else if (vector && (systemStopReason || cancelRequested) && pathEntries.length > 0) {
    auxiliaryErrors.push({
      path: '<ki-path/ki-relation>',
      error: `本次运行${cancelRequested ? '已取消' : '因系统性向量故障停止'}，关系/路径辅助向量已跳过；`
        + '可用 `ki rebuild-vector` 重建（不影响已完成文档的浏览与检索）',
    });
  }

  if (vector && activeFileRecords.length > 0) {
    // 正文、标签和路径辅助向量均收束后，再清理旧 FTS-only 索引。
    for (const rec of activeFileRecords) {
      const oldIds = rec.previousRelation?.ftsIds ?? [];
      const oldLocators = rec.previousRelation?.ftsLocators ?? [];
      if (oldIds.length === 0) continue;
      try {
        const deleted = await ftsDeleteByIds({ scope, ids: oldIds });
        if (deleted.failed > 0) {
          const remainingIds = deleted.failedIds.length > 0 ? deleted.failedIds : oldIds;
          fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, remainingIds);
          fullTextLocatorsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, oldLocators.filter((locator) => remainingIds.includes(locator.ftsId)));
          fullTextErrors.push({ path: rec.rel, error: `切换到向量模式时旧全文索引清理失败 ${deleted.failed} 条` });
        } else {
          fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, []);
          fullTextLocatorsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, []);
        }
      } catch (err) {
        fullTextIdsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, oldIds);
        fullTextLocatorsByKey.set(`${rec.groupPath}\u0000${rec.relation}`, oldLocators);
        fullTextErrors.push({ path: rec.rel, error: `切换到向量模式时旧全文索引清理失败：${(err as Error).message}` });
      }
    }
  }

  // 仅清理受影响 relation 的旧内容/标签/路径向量；FTS-only 覆盖只在新 FTS 完整后
  // 执行 dense 清理。被其他 relation 共享的确定性 docId 不删除。
  const denseIdsAfterCleanup = new Map<string, string[]>();
  for (const rec of activeFileRecords) {
    denseIdsAfterCleanup.set(`${rec.groupPath}\u0000${rec.relation}`, relationMemoryIds(rec.previousRelation));
  }
  {
    const cleanupRecords = activeFileRecords.filter((rec) =>
      vector || fullTextCompleteByKey.get(`${rec.groupPath}\u0000${rec.relation}`) === true,
    );
    const targetKeys = new Set(cleanupRecords.map((rec) => `${rec.groupPath}\u0000${rec.relation}`));
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
    for (const rec of cleanupRecords) {
      const oldIds = relationMemoryIds(rec.previousRelation);
      const newIds = vector
        ? new Set([
            ...rec.entries.map((entry) => activeMergedMap.get(entry.path)).filter((id): id is string => !!id),
            ...(tagMemoryMap.get(rec.rel) ?? []),
          ])
        : new Set<string>();
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
      const newPathIds = new Set(vector ?
        rec.entries
          .map((entry) => entry.chunkRelation)
          .filter((chunkRelation): chunkRelation is string => !!chunkRelation)
          .map((chunkRelation) => generateDocId(buildRelationContent(chunkRelation, rec.groupPath), scope, 'ki-relation'))
        : [],
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
    const failedVectorIds = new Set(await deleteVectorIds(scope, staleIds, '清理受影响文档旧向量', false, vectorCleanupErrors));
    if (!vector) {
      for (const rec of cleanupRecords) {
        const key = `${rec.groupPath}\u0000${rec.relation}`;
        const oldIds = relationMemoryIds(rec.previousRelation);
        // 仅保留未删除且不再被其他 relation 引用的 ID；共享 ID 从当前 relation 脱挂，
        // 但由其实际所有者继续追踪。FTS 不完整的文档不进入 cleanupRecords，保留全部旧 ID。
        denseIdsAfterCleanup.set(key, oldIds.filter((id) => failedVectorIds.has(id) && !protectedVectorIds.has(id)));
      }
    }
  }

  // 取消请求在向量化批次完成后生效（D2：只记标记，仍走提交——元数据写入是毫秒级，
  // 跳过它才是真正的数据不一致来源）。
  noteCancel();

  // ── Phase 3/4：Group 树 + relation-cache（串行，KB 写入近实时无并行损失）──
  noteCancel();
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
    const ftsLocators = fullTextLocatorsByKey.get(`${rec.groupPath}\u0000${rec.relation}`);
    if (rel && ftsIds) rel.ftsIds = ftsIds;
    if (rel && ftsLocators) rel.ftsLocators = ftsLocators;
    if (rel && vector) {
      if (rel.ftsIds?.length) rel.ftsIndexComplete = false;
      else delete rel.ftsIndexComplete;
    }
    else if (rel) rel.ftsIndexComplete = fullTextCompleteByKey.get(`${rec.groupPath}\u0000${rec.relation}`) ?? false;
    if (rel && !vector) {
      const remainingDenseIds = denseIdsAfterCleanup.get(`${rec.groupPath}\u0000${rec.relation}`) ?? [];
      rel.memoryIds = remainingDenseIds;
      if (remainingDenseIds.length > 0) rel.memoryId = remainingDenseIds[0];
      else delete rel.memoryId;
    }
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
  // S-01（REQ-20261009-003）：**元数据提交窗口**——只在真实落盘这几行挡同 scope 的读任务；
  // 向量化长尾（Phase 2）与 Group 树构建（Phase 3）不挡读。目的：读不再等整段导入，
  // 同时避免"列表里在、点开 404"这类跨文件中间态（选项 b）。
  await getSharedOperationCoordinator().runMetadataCommit(scope, () => {
    writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
    // 批次 2（W1）：元数据落盘改 per-Group 分片——旧布局先惰性迁移，再批写全量组
    //（内存 relationsCache 为全量聚合，批写保证分片与内存一致）。批内共享一次 bump + 一次失效。
    migrateLegacyRelationsCache(scope);
    persistTouchedGroups(scope, relationsCache, new Set(Object.keys(relationsCache.groups)));
  });
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
  logSummary(`直导完成：files=${files.length}  chunks=${entries.length}  vectorized=${mergedMap.size}  fulltext=${fullTextIndexed}  skipped=${skipped.length + failedRecords.size}  unchanged=${unchangedFileCount}  errors=${importErrors.length}  assets=${assetCopied.size}${vector ? '' : '  [FTS-only:不写dense]'}${assetsEnabled ? '' : '  [附件收集已关闭]'}`);

  // REQ-02 生命周期②：成功导入清除中断标记 + 释放导入锁（N4）
  releaseImportLock(scope);
  lockAcquired = false;
  if (onInterrupt) {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }

  // R1：未完成清单（文件级）——逐文件给出路径/组/relation 与原因，供 CLI 打印与
  // Web「重试未完成 N 篇」使用。已完成的文件不出现在此清单（守 #1/#4）。
  const vectorErrorByPath = new Map<string, string>();
  for (const item of vectorizeResult.errors) {
    if (item?.path && !vectorErrorByPath.has(item.path)) vectorErrorByPath.set(item.path, item.error);
  }
  const incompleteList = [...failedRecords].map((rec) => {
    const detail = rec.entries.map((entry) => vectorErrorByPath.get(entry.path)).find((value) => !!value);
    return {
      path: rec.rel,
      group: rec.groupPath,
      relation: rec.relation,
      reason: detail
        ?? (stopReport ? `向量化终止（${stopReport.kind}/${stopReport.code}）：${stopReport.reason}` : '存在未完成的 chunk'),
    };
  }).sort((a, b) => (a.path + a.relation).localeCompare(b.path + b.relation));

  // R2（REQ-20261009-001）：维护 scope 级「未完成清单」——部分成功则覆盖写入
  // （供 CLI `--retry-incomplete` / Web「重试未完成」跨会话使用），全量成功则删除。
  const retryParams = {
    group: group || undefined,
    chunkSize: source.chunkSize,
    chunkOverlap: source.chunkOverlap,
    vector,
    tags: args.tags,
    conflictMode: args.conflictMode,
    conflictSuffix: args.conflictSuffix,
  };
  // P1/P2（review）：清单是 scope 级单文件——覆盖/清除前先比对来源目录，跨源时先把旧清单
  // 备份为 `.ki-import-incomplete.prev.json` 并告警（不静默抹掉上一批的未完成项）；
  // 写入失败必须告警（否则用户以为还能 --retry-incomplete，实际没有清单）。
  const previousRetryStatus = readImportIncompleteStatus(scope);
  const previousRecord = previousRetryStatus.record;
  const crossSource = Boolean(previousRecord && previousRecord.sourceDir !== sourceDir);
  if (failedRecords.size > 0) {
    if (crossSource) {
      const prevPath = backupImportIncomplete(scope);
      logWarn(
        `上一批未完成清单来自另一源目录（${previousRecord!.sourceDir}，${previousRecord!.items.length} 项）：`
        + `已备份为 ${prevPath ?? '备份失败（已被本次覆盖）'}；如需先处理旧批次：ki import --source ${previousRecord!.sourceDir} --retry-incomplete`,
      );
    }
    const written = writeImportIncomplete(scope, {
      version: 1,
      scope,
      createdAt: new Date().toISOString(),
      sourceDir,
      params: retryParams,
      items: incompleteList,
      ...(stopReport ? { stopReason: stopReport } : {}),
      ...(cancelRequested ? { cancelled: true } : {}),
    });
    if (!written) {
      logWarn('未完成清单未能落盘：本次未完成文件将无法通过 --retry-incomplete 找回，请检查 scope 目录权限与磁盘空间');
    }
  } else if (crossSource) {
    const prevPath = backupImportIncomplete(scope);
    logWarn(
      `本批全部成功，但上一批未完成清单来自另一源目录（${previousRecord!.sourceDir}，${previousRecord!.items.length} 项）：`
      + `已保留为 ${prevPath ?? '备份失败（主清单未清除）'}，未随本批结果一并丢弃`,
    );
  } else {
    clearImportIncomplete(scope);
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
      // R1：文件级完成度（CLI/Web 展示「完成 N / 未完成 M」的唯一口径）
      files: {
        total: fileRecords.length,
        // R3：增量跳过的文件数据本就完整在位 —— 计入 completed（否则会破坏 R1 的恒等式）
        completed: fileRecords.length - failedRecords.size + unchangedFileCount,
        incomplete: failedRecords.size,
        // P2（review）：补分母与跳过数，使「扫描 = 完成 + 未完成 + 跳过」可自洽核算
        scanned: effectiveFiles.length,
        skipped: Math.max(0, effectiveFiles.length - fileRecords.length - unchangedFileCount),
        unchanged: unchangedFileCount,
      },
    },
    /** R1：部分成功（提交了已完成文件，但仍有未完成文件） */
    partial: failedRecords.size > 0,
    /** R1：未完成文件清单（文件级；已成功文件不在此列） */
    incomplete: incompleteList,
    /** R1：系统性停止原因（若有）——连同 partial 一起用于两端展示 */
    ...(stopReport ? { stopReason: stopReport } : {}),
    /** D2：本次是否收到取消请求（取消与系统停止走同一条提交语义） */
    ...(cancelRequested ? { cancelled: true } : {}),
    /** R2：只重试子集的过滤账目（缺省=处理全部） */
    ...(retryFilter ? { retryFilter } : {}),
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
    else delete rel.memoryId;
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
    ...(relation.ftsLocators ? { ftsLocators: relation.ftsLocators.map((locator) => ({ ...locator })) } : {}),
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
  // S-01（REQ-20261009-003）：回滚会**删除 KB 条目**，必须落在「元数据提交窗口」内——
  // 否则读（已可旁路导入长任务）可能与删除并发，出现"列表里在、点开 404"（challenger 质疑 C1）。
  getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
    if (previousText !== undefined) {
      writeLocalKb(scope, groupPath, relationText, previousText);
    } else {
      removeFromLocalKb(scope, groupPath, relationText);
    }
  });
}

function makeVectorizationStopError(
  stopReason: VectorizationStopReason,
  stats: { scope: string; phase: 'embedding' | 'persist'; total: number; succeeded: number; failed: number; notProcessed: number; partialCommitted: number },
): Error & { code: string; stopReason: VectorizationStopReason; stats: typeof stats } {
  const error = new Error(
    `scope "${stats.scope}" ${stats.phase} 阶段因系统性向量故障停止（${stopReason.kind}/${stopReason.code}）：${stopReason.reason}；`
    + `成功 ${stats.succeeded}，失败 ${stats.failed}，未处理 ${stats.notProcessed}，补偿未完成 ${stats.partialCommitted}`
  ) as Error & { code: string; stopReason: VectorizationStopReason; stats: typeof stats };
  error.code = 'VECTORIZATION_STOPPED';
  error.stopReason = stopReason;
  error.stats = stats;
  return error;
}

async function deleteVectorIds(
  scope: string,
  ids: Iterable<string>,
  label: string,
  strict = true,
  errors?: { path: string; error: string }[],
): Promise<string[]> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return [];
  let result: Awaited<ReturnType<typeof vectorDelete>>;
  try {
    result = await vectorDelete({ scope, ids: uniqueIds });
  } catch (err) {
    const message = `${label}失败：${(err as Error).message}`;
    errors?.push({ path: '<vector-cleanup>', error: message });
    if (strict) throw new Error(message);
    logWarn(message);
    return uniqueIds;
  }
  // vectorDelete 已把 NOT_FOUND 归一化为幂等成功，这里直接用 failedIds
  const failedErrors = result.errors;
  const failedIds = result.failedIds;
  if (failedIds.length > 0) {
    const message = `${label}失败：${failedErrors.map((item) => `${item.id}: ${item.reason}`).join('; ') || `${failedIds.length} 条未确认删除`}`;
    errors?.push({ path: '<vector-cleanup>', error: message });
    if (strict) throw new Error(message);
    logWarn(message);
  }
  return failedIds;
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

/**
 * 批次 2 helper：把内存 cache 中「被触达的组」落到当前布局（中断安全预写/回写专用）。
 *
 * 第二轮审查 P1 修复：原实现是本函数的手抄副本，且**未做 Map 键归一**——新布局下
 * 若触达组键与分片键写法不一致（历史 `项目根/` 前缀），`cache.groups[groupPath]`
 * 取不到值 → `continue` 静默跳过落盘，import 的三个中断安全点（FTS 预标记 / 失败回滚 /
 * 路径向量回滚）对该组全部失效。现统一委托 group-cache.persistCacheShape（单一实现）。
 */
function persistTouchedGroups(scope: string, cache: RelationsCache, touchedGroups: Set<string>): void {
  // S-01（REQ-20261009-003）：分片落盘必须落在「元数据提交窗口」内——
  // 覆盖两条路径：① 正常路径（Phase 4 已在外层开窗，此处靠重入计数）；② **失败回滚路径**
  //（此前未开窗，且读已可旁路 engine-only 长任务 → 可能与"重落分片/删 KB"并发，
  //  出现"列表里在、点开 404"；challenger 质疑 C1）。
  getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
    persistCacheShape(scope, cache as unknown as LegacyRelationsCacheShape, touchedGroups);
  });
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
