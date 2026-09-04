#!/usr/bin/env node
/**
 * export.ts —— ki export 导出命令
 *
 * 将 KB scope 中的结构化数据反向导出为 Markdown 文件目录。
 * 仅使用 scope 本地数据（group-index.json + relations-cache.json + local KB index.json），
 * 不依赖 mem CLI。
 *
 * 用法：
 *   ki export <scope> --output <dir> [--group <path>] [--yes]
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './lib/config.js';
import {
  validateScope,
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  getAssetsDir,
  type GroupIndex,
} from './lib/scope.js';
import { generateMarkdown } from './lib/markdown-gen.js';
import { detectUnknownFlags, toErrorPayload } from './lib/cli-args.js';
import { checkWritable } from './lib/preflight.js';
// ─── 类型 ───

interface ExportOptions {
  scope: string;
  output: string;
  /** 指定导出的 group 路径（可选）。缺省时全量导出，顶层目录名 = scope name */
  group?: string;
}

interface ExportResult {
  ok: boolean;
  action: 'export';
  scope: string;
  outputDir: string;
  stats: {
    total: number;
    exported: number;
    empty: number;
    /** 随导出复制的附件文件数（REQ-20260904-001） */
    assets: number;
  };
  skipped: Array<{ groupPath: string; relation: string; reason: string }>;
}

interface RelationEntry {
  /** relation 名称（relations-cache.json 的 hot_relations[].text 字段） */
  text: string;
  memoryId?: string;
  sourcePath?: string;
}

interface LocalKbIndex {
  [relation: string]: string | { moduleInfo?: string; content?: string; [key: string]: unknown };
}

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(msg: string): never {
  output({ ok: false, error: msg });
  process.exit(1);
}

// ─── 遍历 Group 树 ───

/**
 * 递归遍历 Group 树，收集所有 Group 路径
 */
function collectGroupPaths(
  groups: Record<string, Record<string, unknown>>,
  prefix: string = ''
): string[] {
  const paths: string[] = [];

  for (const [name, children] of Object.entries(groups)) {
    const currentPath = prefix ? `${prefix}/${name}` : name;
    paths.push(currentPath);

    if (children && typeof children === 'object') {
      const childPaths = collectGroupPaths(
        children as Record<string, Record<string, unknown>>,
        currentPath
      );
      paths.push(...childPaths);
    }
  }

  return paths;
}

/**
 * 判断 group 路径是否存在于 Group 树中
 */
function groupExists(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): boolean {
  const segs = groupPath.split('/').filter(Boolean);
  if (segs.length === 0) return false;
  let current: unknown = groups[segs[0]];
  if (current === undefined) return false;
  for (let i = 1; i < segs.length; i++) {
    if (typeof current !== 'object' || current === null) return false;
    current = (current as Record<string, unknown>)[segs[i]];
    if (current === undefined) return false;
  }
  return true;
}

/**
 * 从 Group 树中提取指定 group 路径下的子树（作为新的顶层树）
 */
function extractSubtree(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): Record<string, Record<string, unknown>> {
  const segs = groupPath.split('/').filter(Boolean);
  let current: unknown = groups;
  for (const seg of segs) {
    if (typeof current !== 'object' || current === null) return {};
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return {};
  }
  if (typeof current !== 'object' || current === null) return {};
  return current as Record<string, Record<string, unknown>>;
}

// ─── 读取 relations-cache.json ───

interface RelationsCache {
  version: number;
  scope: string;
  groups: Record<string, { hot_relations: RelationEntry[] }>;
}

function readRelationsCache(scope: string): RelationsCache {
  const cachePath = getRelationsCachePath(scope);
  if (!fs.existsSync(cachePath)) {
    fail(
      `relations-cache.json 不存在：${cachePath}\n请先执行 import 导入数据`
    );
  }

  const raw = fs.readFileSync(cachePath, 'utf-8');
  const data = JSON.parse(raw);

  return {
    version: data.version || 1,
    scope: data.scope || scope,
    groups: data.groups || {},
  };
}

/** 递归复制目录（REQ-20260904-001：export 携带 group 级附件）；返回复制的文件数 */
function copyDirRecursive(src: string, dst: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

// ─── 读取 group-index.json ───

function readGroupIndex(scope: string): GroupIndex {
  const indexPath = getGroupIndexPath(scope);
  if (!fs.existsSync(indexPath)) {
    fail(`group-index.json 不存在：${indexPath}`);
  }

  const raw = fs.readFileSync(indexPath, 'utf-8');
  const data = JSON.parse(raw);

  return {
    version: data.version || 1,
    scope: data.scope || scope,
    groups: data.groups || {},
    updatedAt: data.updatedAt || null,
    source: data.source || null,
  };
}

// ─── 读取 local KB ───

function readLocalKb(scope: string, groupPath: string): LocalKbIndex | null {
  const indexPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── 主逻辑 ───

function handleExport(options: ExportOptions): ExportResult {
  const { scope, output: outputDir, group } = options;

  validateScope(scope);

  const config = loadConfig();
  const scopeDataDir = getScopeDataDir(config, scope);

  if (!fs.existsSync(scopeDataDir)) {
    fail(`scope 数据目录不存在：${scopeDataDir}`);
  }

  // 读取数据源
  const groupIndex = readGroupIndex(scope);
  const relationsCache = readRelationsCache(scope);

  // 确定要导出的 Group 路径
  // 显式 --group：只导出该 group 路径下的子树；缺省：导出全量
  let groupsToExport = groupIndex.groups;
  if (group) {
    if (!groupExists(groupIndex.groups, group)) {
      fail(`指定的 group 不存在：${group}`);
    }
    groupsToExport = extractSubtree(groupIndex.groups, group);
  }

  // 收集所有 Group 路径
  // 显式 --group：collectGroupPaths 必须传 prefix 保留完整路径——relations-cache 的
  // groups 键与 local KB 路径均为完整 groupPath（如 'wiki/docs'），剥前缀会全部 miss；
  // 且显式包含 group 自身（REQ-09「导出 X/Y 及其全部子目录」含根本身的 relations）
  let groupPaths: string[];
  if (group) {
    groupPaths = [group, ...collectGroupPaths(groupsToExport, group)];
  } else {
    groupPaths = collectGroupPaths(groupsToExport);
  }

  // 输出路径规则：
  //   - 显式 --group A/B：父目录名 = group 最后一段（B），丢 A/ 前缀
  //   - 缺省：顶层目录名 = scope name
  const exportRoot = group
    ? (group.split('/').filter(Boolean).pop() || group)
    : scope;
  // 冲突说明：单次导出内 groupPaths 来自 Group 树的唯一路径，映射后天然无重复；
  // 跨次导出到同一输出目录由 CLI-04（输出目录非空需 --yes）拦截覆盖。
  const relPathFor = (groupPath: string): string => {
    if (!group) {
      // 缺省全量：顶层名 = scope name，后面接完整 groupPath
      return path.join(scope, groupPath);
    }
    // 显式 --group：父目录名 = group 最后一段；groupPath 去掉该 group 前缀后接其后
    const segs = groupPath.split('/').filter(Boolean);
    const rootSegs = group.split('/').filter(Boolean);
    const rest = segs.slice(rootSegs.length);
    return path.join(exportRoot, ...rest);
  };

  const stats = { total: 0, exported: 0, empty: 0, assets: 0 };
  const skipped: Array<{ groupPath: string; relation: string; reason: string }> = [];

  const exportedAt = new Date().toISOString();
  const absOutputDir = path.resolve(outputDir);

  // NEG-07：写盘前预检输出目录可写性（避免途中 EACCES 产生半截产物）
  checkWritable(absOutputDir);

  // 遍历每个 Group
  for (const groupPath of groupPaths) {
    const relations = relationsCache.groups[groupPath]?.hot_relations || [];
    if (relations.length === 0) continue;

    // 读取该 Group 的 local KB
    const localKb = readLocalKb(scope, groupPath);

    // 附件携带（REQ-20260904-001）：group 级 assets 目录随导出复制，使导出产物中的图片引用自包含。
    // 落盘于 <out>/<group>/ 下（与 md 同级、保持原相对结构）：md 内 `images/x.png` 解析为
    // <out>/<group>/images/x.png；若多加一层 assets/ 则导出后全部断链。
    const assetsSrc = getAssetsDir(scope, groupPath);
    if (fs.existsSync(assetsSrc)) {
      stats.assets += copyDirRecursive(assetsSrc, path.join(absOutputDir, relPathFor(groupPath)));
    }

    // 为每个 Relation 生成 Markdown
    for (const rel of relations) {
      stats.total++;

      const relationName = rel.text;
      const rawContent = localKb?.[relationName];
      let content: string | null = null;
      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (rawContent && typeof rawContent === 'object') {
        content = rawContent.moduleInfo || rawContent.content || null;
      }

      if (!content) {
        stats.empty++;
      }

      // 构建输出路径（父目录命名规则见 relPathFor）
      const outputFilePath = path.join(
        absOutputDir,
        relPathFor(groupPath),
        `${relationName}.md`
      );

      // 确保目录存在
      fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });

      // 写入文件
      const markdown = generateMarkdown(
        groupPath,
        relationName,
        content,
        exportedAt
      );
      fs.writeFileSync(outputFilePath, markdown, 'utf-8');

      if (content) {
        stats.exported++;
      }
    }
  }

  return {
    ok: true,
    action: 'export',
    scope,
    outputDir: absOutputDir,
    stats,
    skipped,
  };
}

// ─── 参数解析 ───

const args = process.argv.slice(2);

/** 帮助文本：-h/--help 与未知参数时共用 */
const EXPORT_HELP = `ki export - 导出 KB scope 为 Wiki Markdown

用法：
  ki export <scope> --output <dir> [--group <path>] [--yes]

选项：
  --output <dir>      导出输出目录（必填）
  --group <path>      指定导出的 Group 路径（父目录名取 group 最后一段；缺省全量导出，顶层名 = scope name）
  --yes               确认覆盖已存在的输出目录（缺省则拒绝覆盖）
  -h, --help          显示帮助`;

// -h/--help：打印帮助后直接退出（-h 不带 -- 前缀，detectUnknownFlags 拦不住）
if (args.includes('-h') || args.includes('--help')) {
  console.log(EXPORT_HELP);
  process.exit(0);
}

// 未知参数检测（NEG-01）：knownFlags 含全部已知 flag（--yes 为布尔），valueFlags 仅为带值参数
detectUnknownFlags(args, ['--output', '--group', '--yes'], ['--output', '--group'], EXPORT_HELP);

const scope = args[0];
if (!scope || scope.startsWith('--')) {
  fail('用法：ki export <scope> --output <dir> [--group <path>]');
}

// 提取 --output
let outputDir: string | undefined;
const outIdx = args.indexOf('--output');
if (outIdx !== -1 && outIdx + 1 < args.length) {
  outputDir = args[outIdx + 1];
}

if (!outputDir) {
  fail('缺少 --output 参数');
}

// 提取 --group
let group: string | undefined;
const gIdx = args.indexOf('--group');
if (gIdx !== -1 && gIdx + 1 < args.length) {
  group = args[gIdx + 1];
}

// 提取 --yes
const yes = args.includes('--yes');

// CLI-04：破坏性写盘确认——输出目录已存在且非空时，无 --yes 拒绝（防误覆盖）
const absOutputDir = path.resolve(outputDir);
if (fs.existsSync(absOutputDir) && !yes) {
  const entries = fs.readdirSync(absOutputDir);
  if (entries.length > 0) {
    output({
      ok: false,
      error: `输出目录已存在且非空（${entries.length} 项）：${absOutputDir}。覆盖前请确认：ki export ${scope} --output ${outputDir} --yes`,
      requireConfirm: true,
    });
    process.exit(1);
  }
}

// ─── 执行 ───

try {
  const result = handleExport({ scope, output: outputDir, group });
  output(result as unknown as Record<string, unknown>);
} catch (err) {
  // 统一错误契约（NEG-04）：携带 code 的错误（如 PreflightError）一并回显
  output(toErrorPayload(err));
  process.exit(1);
}
