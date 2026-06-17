/**
 * wiki-sync.ts — sync_relation 写回外部 Wiki 文件
 *
 * Wiki 目录发现优先级：
 *   1. group-index.json 的 source 块（source.dir + source.rootName）
 *   2. config.json 中 scope 级 wikiSync（wikiSync.sourceDir）
 *   3. 都没有 → 跳过
 *
 * 写回路径计算：
 *   source 块: {source.dir}/{group去掉rootName}/{relation}.md
 *   config兜底: {wikiSync.sourceDir}/{group}/{relation}.md
 */

import fs from 'fs';
import path from 'path';
import { getSource } from './scope.js';
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
 * 解析 wiki 写回目标目录和 rootName
 *
 * @returns { sourceDir, rootName } 或 null（无法确定写回目录）
 */
function resolveWikiTarget(scope: string): { sourceDir: string; rootName: string | null } | null {
  // 优先级 1：group-index.json 的 source 块
  const source = getSource(scope);
  if (source?.dir) {
    return { sourceDir: source.dir, rootName: source.rootName || null };
  }

  // 优先级 2：config.json 的 wikiSync
  const config = loadConfig();
  const wikiSync = getScopeWikiSync(config, scope);
  if (wikiSync?.enabled && wikiSync?.sourceDir) {
    return { sourceDir: wikiSync.sourceDir, rootName: null };
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
  moduleInfo: string,
  keywords: string[]
): WikiWritebackResult {
  const target = resolveWikiTarget(scope);
  if (!target) {
    return { synced: false, reason: '无可用 wiki 写回目录（source 块和 wikiSync 均未配置）' };
  }

  // relation 路径安全校验：禁止含路径分隔符或 ..
  if (/[\/\\]/.test(relation) || relation.includes('..')) {
    return { synced: false, reason: `relation 含非法路径字符：${relation}` };
  }

  // 计算子路径：去掉 rootName 前缀
  let subPath = group;
  if (target.rootName && group.startsWith(target.rootName + '/')) {
    subPath = group.slice(target.rootName.length + 1);
  } else if (target.rootName && group === target.rootName) {
    subPath = '';
  }

  // 构建文件路径
  const fileName = `${relation}.md`;
  const filePath = subPath
    ? path.join(target.sourceDir, subPath, fileName)
    : path.join(target.sourceDir, fileName);

  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // 生成 Markdown 并写入
    const markdown = generateMarkdown(
      group,
      relation,
      keywords,
      moduleInfo,
      new Date().toISOString()
    );
    fs.writeFileSync(filePath, markdown, 'utf-8');

    return { synced: true, file: filePath };
  } catch (err) {
    return { synced: false, reason: `写回失败：${(err as Error).message}` };
  }
}
