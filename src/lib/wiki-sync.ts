/**
 * wiki-sync.ts — sync_relation 写回外部 Wiki 文件
 *
 * Wiki 目录发现优先级：
 *   1. group-index.json 的 source 块（source.dir）
 *   2. config.json 中 scope 级 wikiSync（wikiSync.sourceDir）
 *   3. 都没有 → 跳过
 *
 * 写回路径计算（rootName 概念已移除，group 即完整相对路径）：
 *   source 块: {source.dir}/{group}/{relation}.md
 *   config兜底: {wikiSync.sourceDir}/{group}/{relation}.md
 */

import fs from 'fs';
import path from 'path';
import { getSource, getRelationsCachePath, getLocalKbDir } from './scope.js';
import { loadConfig, getScopeWikiSync } from './config.js';
import { generateMarkdown } from './markdown-gen.js';

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
 * 解析 wiki 写回目标目录
 *
 * @returns sourceDir 或 null（无法确定写回目录）
 */
function resolveWikiTarget(scope: string): string | null {
  // 优先级 1：group-index.json 的 source 块
  const source = getSource(scope);
  if (source?.dir) {
    return source.dir;
  }

  // 优先级 2：config.json 的 wikiSync
  const config = loadConfig();
  const wikiSync = getScopeWikiSync(config, scope);
  if (wikiSync?.enabled && wikiSync?.sourceDir) {
    return wikiSync.sourceDir;
  }

  return null;
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

  const sourceDir = resolveWikiTarget(scope);
  if (!sourceDir) {
    return { synced: false, reason: '无可用 wiki 写回目录（source 块和 wikiSync 均未配置）' };
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
  const targetDir = resolveWikiTarget(scope);
  if (!targetDir) {
    return {
      ok: false, action: 'wiki-backfill', scope,
      error: '无可用 wiki 写回目录（source 块和 wikiSync 均未配置），请先配置 wikiSync.sourceDir 或执行一次导入',
      stats, skipped,
    };
  }

  // relations-cache 不存在 → scope 尚无任何数据
  const cachePath = getRelationsCachePath(scope);
  if (!fs.existsSync(cachePath)) {
    return {
      ok: false, action: 'wiki-backfill', scope,
      error: `relations-cache 不存在（${cachePath}）：scope 尚无数据可补齐`,
      stats, skipped,
    };
  }

  let cache: { groups?: Record<string, { hot_relations?: Array<{ text: string }> }> };
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return { ok: false, action: 'wiki-backfill', scope, error: `relations-cache 解析失败：${cachePath}`, stats, skipped };
  }

  for (const [groupPath, groupData] of Object.entries(cache.groups ?? {})) {
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
