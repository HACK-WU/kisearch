/**
 * wiki-sync.ts — sync_relation 写回外部 Wiki 文件
 *
 * Wiki 目录发现优先级（见 {@link resolveWikiRootDir}）：
 *   1. group-index.json 的 source 块（source.dir）——**须为目录**；
 *      单文件导入时该字段是文件路径，不能当目录用（否则 ENOTDIR），跳过
 *   2. config.json 中 scope 级 wikiSync（wikiSync.sourceDir）
 *   3. 都没有 → 跳过
 *
 * 写回路径计算（rootName 概念已移除，group 即完整相对路径）：
 *   source 块: {source.dir}/{group}/{relation}.md
 *   config兜底: {wikiSync.sourceDir}/{group}/{relation}.md
 */

import fs from 'fs';
import path from 'path';
import { getSource, getRelationsCachePath, getLocalKbDir, getKbDir } from './scope.js';
import { readAllGroupCaches, hasShardedLayout, getRelationsManifestPath } from './group-cache.js';
import { loadConfig, getScopeWikiSync, resolveImportExtensions } from './config.js';
import { generateMarkdown } from './markdown-gen.js';
import { isSafeGroupPath } from './import-path.js';

// ─── 类型 ───

export interface WikiWritebackResult {
  synced: boolean;
  file?: string;
  reason?: string;
}

// ─── 核心函数 ───

/**
 * relation 名合法性判定：relation 会直接作为 wiki 文件名（${relation}.md），
 * 含路径分隔符（"/"、"\\"）或 ".." 会破坏目录结构或造成路径穿越，视为非法。
 * sync_relation 入口据此直接拒绝；本文件及各文件名定位点复用同一判定避免漂移。
 */
export function isUnsafeRelationName(relation: string): boolean {
  return /[\/\\]/.test(relation) || relation.includes('..');
}

/**
 * `source` 块能否当**目录**用；不可用时返回原因。
 *
 * 单文件导入（`ki import <file>.md`）把 `source.dir` 记成**该文件的路径**
 * （import.ts 的 `source = { dir: sourceDir }`），直接当目录拼
 * `<dir>/<group>/<relation>.md` 必然 ENOTDIR（2026-10-27 线上报错）。
 *
 * 判定：
 *   - 路径存在 → 必须是目录；
 *   - 路径不存在 → 扩展名命中 scope 导入白名单时仍按「文件」处理
 *     （否则源文件被移走后，写回会在文件原位建出一个同名目录，根目录依旧错）；
 *   - 其余情况维持原有「写回时按需重建」行为。
 */
function rejectSourceDirAsWikiRoot(dir: string, importExtensions: string[]): string | null {
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (stat) {
    return stat.isDirectory() ? null : `source 块指向的是文件而不是目录：${dir}`;
  }
  const ext = path.extname(dir).toLowerCase();
  if (ext && importExtensions.some((item) => item.toLowerCase() === ext)) {
    return `source 块指向单文件导入的源文件（已不存在）：${dir}`;
  }
  return null;
}

export interface WikiRootResult {
  /** 可用的 wiki 文档根目录（绝对路径）；null = 不可用 */
  dir: string | null;
  /** 根目录来源 */
  from: 'source' | 'wiki-sync' | null;
  /** `source` 块被判为不可用时的原因（供 fail-loud 文案与诊断使用） */
  sourceRejected?: string;
}

/**
 * 解析 wiki **文档根目录**：`source` 块（须为目录）优先 → `wikiSync.sourceDir` 兜底。
 *
 * 与 {@link resolveWikiSyncTarget} 的分工：后者只认配置，供 import / group create 用
 * （导入源可能是单文件，其 source 块不能当目录）；本函数供「定位写回 / 删除的 wiki
 * 文档根」用，会先验证 `source` 块确实是目录，再决定是否让它优先。
 */
export function resolveWikiRootDir(scope: string): WikiRootResult {
  const config = loadConfig();

  // 优先级 1：group-index.json 的 source 块（须可当目录用）
  const source = getSource(scope);
  let sourceRejected: string | undefined;
  if (source?.dir) {
    const sourceDir = path.resolve(source.dir);
    const rejected = rejectSourceDirAsWikiRoot(sourceDir, resolveImportExtensions(config, scope));
    if (!rejected) return { dir: sourceDir, from: 'source' };
    sourceRejected = rejected;
  }

  // 优先级 2：config.json 的 wikiSync
  // 开关口径与 writeBackToWiki / resolveWikiSyncTarget 统一：`enabled` 缺省视为 true，
  // 只有显式 false 才算关闭（此前这里要求 enabled 真值，与写入门禁 `=== false` 不一致）。
  const wikiSync = getScopeWikiSync(config, scope);
  if (wikiSync?.enabled !== false && wikiSync?.sourceDir) {
    return { dir: path.resolve(wikiSync.sourceDir), from: 'wiki-sync', sourceRejected };
  }

  return { dir: null, from: null, sourceRejected };
}

/** 无可用目录时的 fail-loud 文案（含 source 块被拒原因） */
function noWikiRootReason(root: WikiRootResult): string {
  return root.sourceRejected
    ? `无可用 wiki 写回目录：${root.sourceRejected}，且未配置 wikiSync.sourceDir`
    : '无可用 wiki 写回目录（source 块和 wikiSync 均未配置）';
}

/**
 * 仅供 `wikiSync` 配置解析写回目标（不含 `source` 块）。
 *
 * `source` 块在单文件导入时指向**一个文件**，不能当目录用；group create / import
 * 的主动写回只认用户显式配置的 `wikiSync.sourceDir`。
 */
function resolveWikiSyncTarget(scope: string): string | null {
  const wikiSync = getScopeWikiSync(loadConfig(), scope);
  if (!wikiSync || wikiSync.enabled === false || !wikiSync.sourceDir) return null;
  return path.resolve(wikiSync.sourceDir);
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export type WikiGroupDirResult =
  | { ok: true; targetDir: string; dir: string }
  | { ok: false; reason: string };

/**
 * group create 时在 wikiSync.sourceDir 下同步创建同名目录。
 * 未配置 wikiSync / enabled=false → null（零副作用）。
 */
export function ensureWikiGroupDir(scope: string, group: string): WikiGroupDirResult | null {
  const targetDir = resolveWikiSyncTarget(scope);
  if (!targetDir) return null;
  // 与导入写回同一护栏：wiki 指向 KB 内部属配置错误，不在索引目录里建组目录
  const kbDir = path.resolve(getKbDir(scope));
  const relToKb = path.relative(kbDir, targetDir);
  if (!relToKb.startsWith('..') && !path.isAbsolute(relToKb)) {
    return { ok: false, reason: `wikiSync.sourceDir（${targetDir}）位于 KB 数据目录内，已跳过建目录` };
  }
  if (!isSafeGroupPath(group)) {
    return { ok: false, reason: `非法 Group 路径：${group}` };
  }
  const dir = group ? path.join(targetDir, group) : targetDir;
  const rel = path.relative(targetDir, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `Group 路径越出 wiki 目录：${group}` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, targetDir, dir };
  } catch (err) {
    return { ok: false, reason: `创建 wiki 目录失败：${(err as Error).message}` };
  }
}

export interface WikiImportWritebackItem {
  group: string;
  relation: string;
  content: string;
  /** 物理源文件绝对路径；已位于 wiki 目录内时跳过，避免把 wiki 自身再导一遍 */
  sourcePath?: string;
}

export interface WikiImportWritebackResult {
  targetDir: string;
  written: number;
  skipped: number;
  failed: { group: string; relation: string; reason: string }[];
  /** 失败明细超过 100 条时截断（完整条数见 failedCount） */
  failedTruncated?: boolean;
  failedCount?: number;
}

const MAX_WRITEBACK_FAILED_DETAIL = 100;

/** 去掉源文件自带的 frontmatter，避免与 generateMarkdown 生成的头形成双 YAML 块 */
function stripLeadingFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const after = content.slice(end + 4);
  if (after !== '' && !/^[\r\n]/.test(after)) return content;
  return after.replace(/^\r?\n/, '');
}

/**
 * 导入成功后将文档按 wiki 格式写回 `wikiSync.sourceDir`。
 *
 * 与 `sync_relation` 写回的区别：
 *  - 只认 `wikiSync`（不读 `source` 块——导入源可能是单个文件）；
 *  - **不覆盖已存在文件**（幂等：只补缺，不刷新手写 wiki）；
 *  - 不触发 autoBackfill（导入只同步本次成功导入的文档）。
 *
 * 未配置 wikiSync / enabled=false → null（零副作用）。
 */
export function writeImportedDocsToWiki(
  scope: string,
  items: WikiImportWritebackItem[],
): WikiImportWritebackResult | null {
  const targetDir = resolveWikiSyncTarget(scope);
  if (!targetDir || items.length === 0) return null;

  // 配置错误（wiki 指向 KB 内部）时拒绝写回，避免把 wiki 文档写进本地索引目录
  const kbDir = path.resolve(getKbDir(scope));
  const relToKb = path.relative(kbDir, targetDir);
  if (!relToKb.startsWith('..') && !path.isAbsolute(relToKb)) {
    process.stderr.write(`提示：wikiSync.sourceDir（${targetDir}）位于 KB 数据目录内，已跳过导入写回\n`);
    return null;
  }

  const result: WikiImportWritebackResult = { targetDir, written: 0, skipped: 0, failed: [] };
  const exportedAt = new Date().toISOString();
  for (const item of items) {
    if (!isSafeGroupPath(item.group) || isUnsafeRelationName(item.relation)) {
      result.skipped++;
      continue;
    }
    if (item.sourcePath && isPathInside(targetDir, item.sourcePath)) {
      result.skipped++;
      continue;
    }
    const dest = item.group
      ? path.join(targetDir, item.group, `${item.relation}.md`)
      : path.join(targetDir, `${item.relation}.md`);
    const rel = path.relative(targetDir, dest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      result.skipped++;
      continue;
    }
    if (fs.existsSync(dest)) {
      result.skipped++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(
        dest,
        generateMarkdown(item.group, item.relation, stripLeadingFrontmatter(item.content), exportedAt),
        'utf-8',
      );
      result.written++;
    } catch (err) {
      result.failed.push({ group: item.group, relation: item.relation, reason: (err as Error).message });
    }
  }
  // 磁盘满等系统性故障会让 failed 与导入文件数同量级；明细截断，条数单独给
  if (result.failed.length > MAX_WRITEBACK_FAILED_DETAIL) {
    result.failedCount = result.failed.length;
    result.failed = result.failed.slice(0, MAX_WRITEBACK_FAILED_DETAIL);
    result.failedTruncated = true;
  }
  return result;
}

/**
 * 将 sync_relation 写入的 moduleInfo 同步写回到外部 Wiki 文件
 *
 * 失败不抛异常，仅返回 { synced: false, reason }
 */
export function writeBackToWiki(
  scope: string,
  group: string,
  relation: string,
  moduleInfo: string
): WikiWritebackResult {
  return writeBackToWikiInner(scope, group, relation, moduleInfo, true);
}

/**
 * 写回实现（内部）。
 * @param allowAutoBackfill 本次调用是否允许触发自动补齐——backfill 内部逐条写回
 *        时必须传 false，否则"目录为空 → backfill → 逐条写回 → 又检测目录为空"
 *        会无限递归；且 backfill 写入首条后目录即非空，递归也无必要。
 */
function writeBackToWikiInner(
  scope: string,
  group: string,
  relation: string,
  moduleInfo: string,
  allowAutoBackfill: boolean
): WikiWritebackResult {
  // 门禁：wikiSync.enabled 显式为 false 时禁用一切写回。
  // 此前该开关只对 fallback 路径生效——scope 导入过（source.dir 存在）时
  // enabled=false 也会继续写文件，与字段语义矛盾，此处统一拦截。
  // wikiSync 未配置（null）时维持原行为（enabled 缺省视为 true）。
  const wikiSync = getScopeWikiSync(loadConfig(), scope);
  if (wikiSync?.enabled === false) {
    return { synced: false, reason: 'wikiSync.enabled=false 已禁用 wiki 写回' };
  }

  const root = resolveWikiRootDir(scope);
  const sourceDir = root.dir;
  if (!sourceDir) {
    return { synced: false, reason: noWikiRootReason(root) };
  }

  // 自动补齐：目标目录不存在或为空 → 视为"wiki 尚未初始化"，
  // 先全量补齐历史关系再写本次条目（wikiSync.autoBackfill 显式 false 关闭）。
  // 仅在缺省幂等模式下跳过已存在文件，与手动 ki wiki-backfill 行为一致。
  if (allowAutoBackfill && wikiSync?.autoBackfill !== false) {
    let isEmpty = false;
    try {
      isEmpty = !fs.existsSync(sourceDir) || fs.readdirSync(sourceDir).length === 0;
    } catch { /* stat 失败按非空处理，走正常写回 */ }
    if (isEmpty) {
      const bf = backfillWiki(scope);
      if (bf.ok && bf.stats.written + bf.stats.existed > 0) {
        process.stderr.write(
          `提示：wiki 目录不存在或为空，已自动补齐 ${bf.stats.written} 个历史关系文件` +
          `（目标：${bf.targetDir}，可用 wikiSync.autoBackfill: false 关闭自动补齐）\n`
        );
      }
    }
  }

  // 防御性兜底：正常情况下 sync_relation 入口已用 isUnsafeRelationName 拒绝含
  // "/"、"\\"、".." 的非法 relation；此处再校验一次，避免其他调用方绕过入口校验。
  if (isUnsafeRelationName(relation)) {
    return { synced: false, reason: `relation 含非法路径字符：${relation}` };
  }

  // 构建文件路径（group 即完整相对路径，rootName 概念已移除，不做前缀剥离）
  const fileName = `${relation}.md`;
  const filePath = group
    ? path.join(sourceDir, group, fileName)
    : path.join(sourceDir, fileName);

  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // 生成 Markdown 并写入
    const markdown = generateMarkdown(
      group,
      relation,
      moduleInfo,
      new Date().toISOString()
    );
    fs.writeFileSync(filePath, markdown, 'utf-8');

    return { synced: true, file: filePath };
  } catch (err) {
    return { synced: false, reason: `写回失败：${(err as Error).message}` };
  }
}

// ─── 历史补齐（backfill） ──────────────────────────────

export interface WikiBackfillResult {
  ok: boolean;
  action: 'wiki-backfill';
  scope: string;
  error?: string;
  /** 实际写回的目标目录（成功时） */
  targetDir?: string;
  /** existed：已存在而跳过的文件数（缺省幂等模式；--force 时为 0） */
  stats: { total: number; written: number; skipped: number; empty: number; existed: number };
  skipped: Array<{ groupPath: string; relation: string; reason: string }>;
}

/** 读取 group 的 local KB index.json（relation → 内容映射） */
function readLocalKbIndex(scope: string, groupPath: string): Record<string, unknown> | null {
  const indexPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 历史补齐：将 KB 中已有 Relations 全量写回 Wiki。
 *
 * 背景：writeBackToWiki 是事件驱动的（sync_relation 写入时逐条写回），
 * 开启 wikiSync 后不会自动补齐此前导入/写入的历史关系——本函数遍历
 * relations-cache 全部 group（平铺完整路径键），从 local KB 取每条
 * relation 的内容，逐条复用 writeBackToWiki 落盘。
 *
 * 幂等语义：缺省跳过已存在文件（只补缺、不刷新——exportedAt 时间戳
 * 不会变动，避免 git 管理的 wiki 目录产生脏 diff）；opts.force=true
 * 时全量覆盖写（刷新 exportedAt）。
 *
 * 前置（fail-loud）：
 *   - wikiSync.enabled 显式 false → 拒绝（与单条写回同一门禁）
 *   - 无可用 wiki 目标目录（source 块与 wikiSync 均未配置）→ 拒绝
 */
export function backfillWiki(scope: string, opts: { force?: boolean } = {}): WikiBackfillResult {
  const stats = { total: 0, written: 0, skipped: 0, empty: 0, existed: 0 };
  const skipped: WikiBackfillResult['skipped'] = [];

  // 门禁与目标目录 fail-fast（与 writeBackToWiki 同语义，提前给出整体错误而非逐条 reason）
  if (getScopeWikiSync(loadConfig(), scope)?.enabled === false) {
    return {
      ok: false, action: 'wiki-backfill', scope,
      error: 'wikiSync.enabled=false 已禁用 wiki 写回，如需补齐请先开启（enabled: true）',
      stats, skipped,
    };
  }
  const root = resolveWikiRootDir(scope);
  const targetDir = root.dir;
  if (!targetDir) {
    return {
      ok: false, action: 'wiki-backfill', scope,
      error: `${noWikiRootReason(root)}，请先配置 wikiSync.sourceDir 或执行一次目录导入`,
      stats, skipped,
    };
  }

  // 批次 2（W8）：全量读双轨（backfill 天然全量；本函数只读 relations 不写元数据）
  const all = (() => {
    try {
      return readAllGroupCaches(scope);
    } catch (err) {
      return err as Error;
    }
  })();
  if (all instanceof Error) {
    return { ok: false, action: 'wiki-backfill', scope, error: `relations 元数据解析失败：${(all as Error).message}`, stats, skipped };
  }
  // 批次 2 审查 P2：判定必须布局感知，否则「已迁移但 0 组」的空 scope 会被误判为未初始化
  // （命令从"幂等成功、0 补齐"变成失败，且文案指向已不存在的旧文件）。
  if (all.size === 0 && !hasShardedLayout(scope) && !fs.existsSync(getRelationsCachePath(scope))) {
    return {
      ok: false, action: 'wiki-backfill', scope,
      error: `relations 元数据不存在（${getRelationsManifestPath(scope)} / ${getRelationsCachePath(scope)}）：scope 尚无数据可补齐`,
      stats, skipped,
    };
  }

  for (const [groupPath, groupData] of all) {
    const relations = groupData?.hot_relations ?? [];
    if (relations.length === 0) continue;
    const localKb = readLocalKbIndex(scope, groupPath);

    for (const rel of relations) {
      stats.total++;
      const relationName = rel.text;

      // 与 writeBackToWiki 同一安全判定：脏数据含路径分隔符时跳过（防路径穿越）
      if (isUnsafeRelationName(relationName)) {
        stats.skipped++;
        skipped.push({ groupPath, relation: relationName, reason: 'relation 含非法路径字符' });
        continue;
      }

      const raw = localKb?.[relationName];
      const moduleInfo = typeof raw === 'string'
        ? raw
        : ((raw as { moduleInfo?: string; content?: string } | null)?.moduleInfo
          ?? (raw as { content?: string } | null)?.content
          ?? null);
      if (!moduleInfo) {
        stats.empty++;
        skipped.push({ groupPath, relation: relationName, reason: 'local KB 无内容（可能仅向量层写入）' });
        continue;
      }

      // 幂等（Q1）：缺省跳过已存在文件——generateMarkdown 的 exportedAt 为当前时间，
      // 无脑覆盖会刷新全部已存在文件（git 管理的 wiki 目录每次执行产生全量脏 diff）。
      // 路径构造与 writeBackToWiki 一致（同规则同步维护）。
      if (!opts.force) {
        const destPath = groupPath
          ? path.join(targetDir, groupPath, `${relationName}.md`)
          : path.join(targetDir, `${relationName}.md`);
        if (fs.existsSync(destPath)) {
          stats.existed++;
          continue;
        }
      }

      const r = writeBackToWikiInner(scope, groupPath, relationName, moduleInfo, false);
      if (r.synced) {
        stats.written++;
      } else {
        stats.skipped++;
        skipped.push({ groupPath, relation: relationName, reason: r.reason ?? '写回失败' });
      }
    }
  }

  return { ok: true, action: 'wiki-backfill', scope, targetDir, stats, skipped };
}
