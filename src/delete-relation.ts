#!/usr/bin/env node
/**
 * delete-relation.ts - 删除 Relation 及其关联数据
 *
 * 删除范围：
 *   1. relations-cache.json 中 groups[g].hot_relations[] 的对应条目
 *   2. 本地 KB index.json 中的对应 key
 *   3. wiki 目录下的 .md 文件
 *   4. 向量记忆（按 docId 删除，无 memoryId 时 vectorSearch 兜底严格匹配）
 *
 * 注意：不删除 group-index.json 的 Group 节点（Group 可能含其他 Relation）
 *
 * 用法:
 *   单条: npx jiti delete-relation.ts --scope <scope> --group <group> --relation <text>
 *   批量: npx jiti delete-relation.ts --scope <scope> --input <jsonFile>
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from './lib/store.js';
import {
  getRelationsCachePath,
  getLocalKbDir,
  validateScope,
} from './lib/scope.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import { vectorSearch, vectorDelete, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import { loadConfig, getScopeWikiSync, resolveScope } from './lib/config.js';
import { getSource } from './lib/scope.js';

// ─── 类型 ───

interface GroupData {
  hot_relations: Array<{
    id: string;
    text: string;
    score: number;
    useCount: number;
    lastUsedTime: number | null;
    isImported: boolean;
    memoryId?: string;
  }>;
  keywords: string[];
  max_hot_count: number;
}

interface RelationsCache {
  version: number;
  scope: string;
  partition_config: Record<string, unknown>;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

interface DeleteResult {
  relation: string;
  group: string;
  deleted: boolean;
  cacheRemoved: boolean;
  kbRemoved: boolean;
  wikiRemoved: boolean;
  memRemoved: boolean;
  memMethod: 'memoryId' | 'search' | 'skip' | 'none';
  memMemoryId?: string;
  reason?: string;
}

// ─── 核心删除逻辑 ───

export interface DeleteRelationParams {
  scope?: string;
  group: string;
  relation: string;
}

export type DeleteRelationOutcome =
  | { ok: true; result: DeleteResult }
  | { ok: false; error: string };

export async function executeDeleteRelation(params: DeleteRelationParams): Promise<DeleteRelationOutcome> {
  try {
    const { group, relation } = params;
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    validateScope(scope);

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<RelationsCache>(cachePath);
    if (!cache) {
      return { ok: false, error: 'relations-cache.json 不存在' };
    }

    // 解析 Group 路径（支持模糊补全）
    const groupIndex = readJson<Record<string, unknown>>(cachePath.replace('relations-cache.json', 'group-index.json'));
    const resolved = await resolveGroupPath(group, groupIndex as any, cache.groups, scope);
    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到任何节点` };
    }
    const resolvedGroup = resolved.resolvedPath;

    const groupData = cache.groups[resolvedGroup];
    // groupData 可能为空（cache 已清但 wiki/mem 残留），继续清理 wiki + mem

    // 查找 Relation（cache 中可能已被清空，但 wiki/mem 残留需清理）
    const relIdx = groupData ? groupData.hot_relations.findIndex(r => r.text === relation) : -1;
    const rel = relIdx >= 0 ? groupData.hot_relations[relIdx] : undefined;

    const result: DeleteResult = {
      relation,
      group: resolvedGroup,
      deleted: false,
      cacheRemoved: false,
      kbRemoved: false,
      wikiRemoved: false,
      memRemoved: false,
      memMethod: 'none',
    };

    // 1. 从 relations-cache.json 删除（若存在）
    if (relIdx >= 0 && groupData) {
      groupData.hot_relations.splice(relIdx, 1);
      result.cacheRemoved = true;
    }

    // 2. 从本地 KB index.json 删除
    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    try {
      if (fs.existsSync(localKbPath)) {
        const localKb = readJson<Record<string, string>>(localKbPath);
        if (localKb && relation in localKb) {
          delete localKb[relation];
          writeJson(localKbPath, localKb);
          result.kbRemoved = true;
        }
      }
    } catch (err) {
      result.reason = `KB 删除失败: ${(err as Error).message}`;
    }

    // 3. 删除 wiki .md 文件
    //
    // 含 "/"（或 "\\"、".."）的 relation 在 sync 入口即被 isUnsafeRelationName 拒绝、
    // 根本无法建立，故正常不会出现含非法字符的 wiki 文件。wiki 文件按 relation
    // 文件名约定定位：findWikiFile 找不到就不动，不视为"孤儿文件"。
    try {
      const wikiFile = findWikiFile(scope, resolvedGroup, relation);
      if (wikiFile && fs.existsSync(wikiFile)) {
        fs.unlinkSync(wikiFile);
        result.wikiRemoved = true;
      }
    } catch (err) {
      result.reason = `${result.reason || ''} Wiki 删除失败: ${(err as Error).message}`.trim();
    }

    // 4. 删除向量记忆（rel 可能为 undefined，无 memoryId 时走 search 兜底）
    const memOutcome = await deleteMemMemory(scope, relation, rel?.memoryId);
    result.memRemoved = memOutcome.removed;
    result.memMethod = memOutcome.method;
    if (memOutcome.memoryId) result.memMemoryId = memOutcome.memoryId;
    if (memOutcome.reason) {
      result.reason = `${result.reason || ''} ${memOutcome.reason}`.trim();
    }

    // 持久化 cache
    writeJson(cachePath, cache);

    result.deleted = result.cacheRemoved;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── 向量删除（先 memoryId 后 search 兜底） ───

async function deleteMemMemory(
  scope: string,
  relation: string,
  memoryId?: string
): Promise<{ removed: boolean; method: 'memoryId' | 'search' | 'skip' | 'none'; memoryId?: string; reason?: string }> {
  const avail = await ensureVectorAvailable();
  if (!avail.available) {
    return { removed: false, method: 'skip', reason: `向量服务不可用: ${avail.reason}` };
  }

  // 优先按 memoryId(docId) 删除
  if (memoryId) {
    try {
      const res = await vectorDelete({ scope, ids: [memoryId] });
      if (res.deleted > 0) {
        return { removed: true, method: 'memoryId', memoryId };
      }
      // 未命中（id 不存在，可能 text 变更导致 docId 漂移），继续 search 兜底
      const searchResult = await deleteBySearch(scope, relation);
      return {
        ...searchResult,
        reason: `memoryId(${memoryId}) 未命中，已尝试 search 兜底。${searchResult.reason || ''}`.trim(),
      };
    } catch (err) {
      // memoryId 删除失败，继续 search 兜底
      const e = err as Error;
      const searchResult = await deleteBySearch(scope, relation);
      return {
        ...searchResult,
        reason: `memoryId(${memoryId}) 删除失败: ${e.message}，已尝试 search 兜底。${searchResult.reason || ''}`.trim(),
      };
    }
  }

  // 无 memoryId，直接 search 兜底
  return deleteBySearch(scope, relation);
}

/**
 * search 兜底删除：用 relation 名称向量检索，严格匹配确认后删除
 *
 * 严格匹配规则：返回的 content 剥离 【标签:xxx】 前缀后，
 * relation 名称必须作为标题行的前缀出现（# 或 ### 开头，或独立行）
 * 注：不用 \b（单词边界），因为 \b 对中文字符不生效
 */
async function deleteBySearch(scope: string, relation: string): Promise<{ removed: boolean; method: 'search'; memoryId?: string; reason?: string }> {
  try {
    // 用 relation 名称做查询
    const results = await vectorSearch({
      scope,
      query: relation,
      limit: 10,
      tags: 'ki-search',
    });

    if (results.length === 0) {
      return { removed: false, method: 'search', reason: `search 无结果，mem 中可能无此记忆` };
    }

    // 严格匹配：content 剥离标签前缀后，relation 名称作为标题前缀出现
    // 边界规则：relation 后必须是非字母数字字符（中英文均排除）或行尾，
    // 避免 "加密" 误匹配 "### 加密工具"（\b 对中文无效，用自定义边界）
    const boundary = '(?=[^a-zA-Z0-9\\u4e00-\\u9fa5]|$)';
    const matched = results.filter(r => {
      const content = r.content || '';
      const cleanContent = content.replace(/^【标签:[^】]*】\s*/, '');
      const titlePatterns = [
        new RegExp(`^#\\s*${escapeRegExp(relation)}${boundary}`, 'mu'),
        new RegExp(`^###\\s*${escapeRegExp(relation)}${boundary}`, 'mu'),
        new RegExp(`^${escapeRegExp(relation)}${boundary}`, 'mu'),
      ];
      return titlePatterns.some(p => p.test(cleanContent));
    });

    if (matched.length === 0) {
      return { removed: false, method: 'search', reason: `search 返回 ${results.length} 条但无严格匹配（relation 名称未作为标题前缀出现）` };
    }

    if (matched.length > 1) {
      return { removed: false, method: 'search', reason: `search 严格匹配到 ${matched.length} 条，无法确定删除目标，需人工确认` };
    }

    // 唯一匹配，执行删除
    const target = matched[0];
    const res = await vectorDelete({ scope, ids: [target.memoryId] });
    if (res.deleted === 0) {
      return { removed: false, method: 'search', memoryId: target.memoryId, reason: `vectorDelete 未删除任何条目（id=${target.memoryId}）` };
    }
    return { removed: true, method: 'search', memoryId: target.memoryId };
  } catch (err) {
    return { removed: false, method: 'search', reason: `search 兜底失败: ${(err as Error).message}` };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── wiki 文件定位 ───

/**
 * 根据 config.json 的 wikiSync 配置定位 wiki 文件路径
 * 优先级与 wiki-sync.ts 的 resolveWikiTarget 一致：
 *   1. group-index.json 的 source 块（source.dir + source.rootName）
 *   2. config.json 中 scope 级 wikiSync.sourceDir
 */
function findWikiFile(scope: string, group: string, relation: string): string | null {
  let sourceDir: string | null = null;
  let rootName: string | null = null;

  // 优先级 1：group-index.json 的 source 块
  const source = getSource(scope);
  if (source?.dir) {
    sourceDir = source.dir;
    rootName = source.rootName || null;
  }

  // 优先级 2：config.json 的 wikiSync
  if (!sourceDir) {
    const config = loadConfig();
    const wikiSync = getScopeWikiSync(config, scope);
    if (wikiSync?.enabled && wikiSync?.sourceDir) {
      sourceDir = wikiSync.sourceDir;
    }
  }

  if (!sourceDir) return null;

  // 计算子路径：去掉 rootName 前缀（与 wiki-sync.ts 一致）
  let subPath = group;
  if (rootName && group.startsWith(rootName + '/')) {
    subPath = group.slice(rootName.length + 1);
  } else if (rootName && group === rootName) {
    subPath = '';
  }

  const filePath = subPath
    ? path.join(sourceDir, subPath, `${relation}.md`)
    : path.join(sourceDir, `${relation}.md`);

  return fs.existsSync(filePath) ? filePath : null;
}

// ─── 批量删除 ───

interface BatchDeleteItem {
  group: string;
  relation: string;
}

export async function executeBatchDelete(scope: string | undefined, items: BatchDeleteItem[]): Promise<{
  ok: boolean;
  results: DeleteResult[];
  total: number;
  failed: number;
}> {
  const results: DeleteResult[] = [];
  let failed = 0;

  for (const item of items) {
    const outcome = await executeDeleteRelation({
      scope,
      group: item.group,
      relation: item.relation,
    });
    if (outcome.ok) {
      results.push(outcome.result);
      if (!outcome.result.deleted) failed++;
    } else {
      results.push({
        relation: item.relation,
        group: item.group,
        deleted: false,
        cacheRemoved: false,
        kbRemoved: false,
        wikiRemoved: false,
        memRemoved: false,
        memMethod: 'none',
        reason: outcome.error,
      });
      failed++;
    }
  }

  return { ok: true, results, total: items.length, failed };
}

// ─── CLI ───

const program = new Command();

program
  .name('delete-relation')
  .description('删除 Relation 及其关联数据（cache + KB + wiki + mem）')
  .option('--scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('--group <group>', 'Group 路径')
  .option('--relation <relation>', 'Relation 名称')
  .option('--input <input>', 'JSON 输入文件路径（批量模式，格式 {"items":[{"group","relation"}]}）')
  .action(async (opts) => {
    try {
      if (opts.input) {
        const inputData = JSON.parse(fs.readFileSync(opts.input, 'utf-8'));
        const items: BatchDeleteItem[] = inputData.items;
        if (!Array.isArray(items)) {
          console.log(JSON.stringify({ ok: false, error: '输入文件格式错误：缺少 items 数组' }, null, 2));
          await closeEngine();
          process.exit(1);
        }
        const result = await executeBatchDelete(opts.scope, items);
        console.log(JSON.stringify(result, null, 2));
        await closeEngine();
        return;
      }

      if (!opts.group || !opts.relation) {
        console.log(JSON.stringify({ ok: false, error: '单条模式需提供 --group 和 --relation' }, null, 2));
        await closeEngine();
        process.exit(1);
      }

      const result = await executeDeleteRelation({
        scope: opts.scope,
        group: opts.group,
        relation: opts.relation,
      });
      console.log(JSON.stringify(result, null, 2));
      await closeEngine();
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
      await closeEngine();
      process.exit(1);
    }
  });

const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
