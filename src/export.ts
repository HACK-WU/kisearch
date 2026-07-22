#!/usr/bin/env node
/**
 * export.ts —— ki export 导出命令
 *
 * 将 KB scope 中的结构化数据反向导出为 Markdown 文件目录。
 * 仅使用 scope 本地数据（group-index.json + relations-cache.json + local KB index.json），
 * 不依赖 mem CLI。
 *
 * 用法：
 *   ki export <scope> --output <dir> [--root-name <name>]
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './lib/config.js';
import {
  validateScope,
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  type GroupIndex,
} from './lib/scope.js';
import { generateMarkdown } from './lib/markdown-gen.js';

// ─── 类型 ───

interface ExportOptions {
  scope: string;
  output: string;
  rootName?: string;
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
  };
  skipped: Array<{ groupPath: string; relation: string; reason: string }>;
}

interface RelationEntry {
  relation: string;
  keywords: string[];
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
  const { scope, output: outputDir, rootName } = options;

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
  let groupsToExport = groupIndex.groups;
  if (rootName) {
    if (!groupsToExport[rootName]) {
      fail(`指定的 rootName 不存在：${rootName}`);
    }
    groupsToExport = { [rootName]: groupsToExport[rootName] };
  }

  // 收集所有 Group 路径
  const groupPaths = collectGroupPaths(groupsToExport);

  const stats = { total: 0, exported: 0, empty: 0 };
  const skipped: Array<{ groupPath: string; relation: string; reason: string }> = [];

  const exportedAt = new Date().toISOString();
  const absOutputDir = path.resolve(outputDir);

  // 遍历每个 Group
  for (const groupPath of groupPaths) {
    const relations = relationsCache.groups[groupPath]?.hot_relations || [];
    if (relations.length === 0) continue;

    // 读取该 Group 的 local KB
    const localKb = readLocalKb(scope, groupPath);

    // 为每个 Relation 生成 Markdown
    for (const rel of relations) {
      stats.total++;

      const relationName = rel.text || rel.relation;
      const keywords = rel.keywords || [];
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

      // 构建输出路径
      const outputFilePath = path.join(
        absOutputDir,
        groupPath,
        `${relationName}.md`
      );

      // 确保目录存在
      fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });

      // 写入文件
      const markdown = generateMarkdown(
        groupPath,
        relationName,
        keywords,
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

const scope = args[0];
if (!scope || scope.startsWith('--')) {
  console.error('用法：ki export <scope> --output <dir> [--root-name <name>]');
  process.exit(1);
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

// 提取 --root-name
let rootName: string | undefined;
const rnIdx = args.indexOf('--root-name');
if (rnIdx !== -1 && rnIdx + 1 < args.length) {
  rootName = args[rnIdx + 1];
}

// ─── 执行 ───

try {
  const result = handleExport({ scope, output: outputDir, rootName });
  output(result as unknown as Record<string, unknown>);
} catch (err) {
  fail((err as Error).message);
}
