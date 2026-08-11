#!/usr/bin/env node
/**
 * sync-relation.ts - 关系回写
 *
 * 接收 AI 提供的 relation + 模块信息，校验后写入缓存 + 本地 KB。
 * 支持单条模式和批量模式。
 *
 * 批次 3（REQ-05/09）：keywords 机制与 isFullText 字段已删除。
 *
 * 用法:
 *   单条: npx jiti sync-relation.ts --scope <scope> --group <group> --relation <text>
 *         --module-info <markdown>
 *   批量: npx jiti sync-relation.ts --scope <scope> --input <jsonFile>
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './lib/store.js';
import {
  getRelationsCachePath,
  getLocalKbDir,
  getGroupIndexPath,
  validateScope,
} from './lib/scope.js';
import type { GroupIndex } from './lib/scope.js';
import { calculateScore, recordUse } from './lib/scoring.js';
import type { Relation } from './lib/scoring.js';
import type { PartitionConfig } from './lib/constants.js';
import { DEFAULT_PARTITION_CONFIG, parseContentTags } from './lib/constants.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import { buildRelationContent } from './lib/path-vectorize.js';
import { vectorBulkStore, vectorDelete, generateDocId, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import { writeBackToWiki, isUnsafeRelationName } from './lib/wiki-sync.js';
import { loadConfig, resolveScope } from './lib/config.js';

// 向后兼容 re-export：parseContentTags 已统一提取到 lib/constants.js，
// 保留本模块导出供既有测试/外部依赖引用。
export { parseContentTags };

// ─── 类型定义 ───

interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
  max_hot_count: number;
}

interface RelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

interface SyncResult {
  relation: string;
  evicted: string | null;
  wikiSynced?: boolean;
  wikiFile?: string;
}

interface BatchItem {
  group: string;
  relation: string;
  module_info: string;
}

// ─── 辅助函数 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * 生成下一个 Relation ID
 * 格式：rel_{自增序号}，基于全局已有 ID 的最大值
 */
function generateNextId(cache: RelationsCache): string {
  let maxNum = 0;
  for (const data of Object.values(cache.groups)) {
    for (const rel of data.hot_relations) {
      const match = rel.id.match(/^rel_(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return `rel_${String(maxNum + 1).padStart(3, '0')}`;
}

// ─── Group 树自动补建 ───

/**
 * 确保 Group 路径在 group-index.json 的 groups 树中完整存在
 * 如果路径中的某些节点尚未创建，自动补建
 *
 * @example "配置/API" → 自动创建 "配置" 和 "API" 节点
 * @example "BK-Monitor-Wiki/部署运维" → 自动创建 "BK-Monitor-Wiki" 和 "部署运维"
 */
function ensureGroupPath(scope: string, groupPath: string): void {
  const indexPath = getGroupIndexPath(scope);
  const data = readGroupIndex(scope);
  if (!data) return;

  const segments = groupPath.split('/').filter(Boolean);
  if (segments.length === 0) return;

  let modified = false;
  let parent: Record<string, unknown> = data.groups as Record<string, unknown>;

  for (const seg of segments) {
    if (!(seg in parent)) {
      parent[seg] = {};
      modified = true;
    }
    parent = parent[seg] as Record<string, unknown>;
  }

  if (modified) {
    writeJson(indexPath, data as unknown as Record<string, unknown>);
  }
}

// ─── 核心同步逻辑 ───

function syncSingleRelation(
  cache: RelationsCache,
  scope: string,
  group: string,
  relationText: string,
  moduleInfo: string
): SyncResult {
  const config = cache.partition_config || DEFAULT_PARTITION_CONFIG;

  // 1. 确保 Group 路径在 group-index.json 树中完整存在（自动补建缺失节点）
  ensureGroupPath(scope, group);

  // 2. 确保 group 数据在 relations-cache 中存在
  if (!cache.groups[group]) {
    cache.groups[group] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: config.maxHotCount,
    };
  }
  const groupData = cache.groups[group];

  // 3. 查找或创建 Relation
  let existingRel = groupData.hot_relations.find((r) => r.text === relationText);
  let evicted: string | null = null;
  const now = Date.now();

  if (existingRel) {
    // 将重复同步记为一次使用（受 5min 防刷限制），
    // 以保证 lastUsedTime 能反映最近一次同步，供后续 query-group 计入新兴热区。
    const updated = recordUse(existingRel, now);
    existingRel.useCount = updated.useCount;
    existingRel.lastUsedTime = updated.lastUsedTime;
    existingRel.score = calculateScore(
      existingRel.useCount,
      existingRel.lastUsedTime,
      now,
      config.halfLifeHours
    );
    // 重新按 score 降序
    groupData.hot_relations.sort((a, b) => b.score - a.score);
  } else {
    // 创建新 Relation
    const newRel: Relation = {
      id: generateNextId(cache),
      text: relationText,
      score: calculateScore(0, null, now, config.halfLifeHours),
      useCount: 0,
      lastUsedTime: null,
      isImported: false,
    };

    // 4. 检查是否需要淘汰
    if (groupData.hot_relations.length >= config.maxHotCount) {
      // 找 score 最低的 Relation
      let minIdx = 0;
      for (let i = 1; i < groupData.hot_relations.length; i++) {
        if (groupData.hot_relations[i].score < groupData.hot_relations[minIdx].score) {
          minIdx = i;
        }
      }

      const evictedRel = groupData.hot_relations[minIdx];
      evicted = evictedRel.text;

      groupData.hot_relations.splice(minIdx, 1);
    }

    // 5. 添加新 Relation
    groupData.hot_relations.push(newRel);

    // 按 score 降序排列
    groupData.hot_relations.sort((a, b) => b.score - a.score);
  }

  // 6. 写入本地 KB
  const localKbPath = getLocalKbDir(scope, group);
  const localKbDir = path.dirname(localKbPath);
  fs.mkdirSync(localKbDir, { recursive: true });

  let localKb: Record<string, string> = {};
  if (fs.existsSync(localKbPath)) {
    const existing = readJson<Record<string, string>>(localKbPath);
    if (existing) localKb = existing;
  }
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);

  return {
    relation: relationText,
    evicted,
  };
}

// ─── 批量模式 ───

function syncBatch(
  scope: string,
  inputFile: string,
  vector = true
): void {
  if (!fs.existsSync(inputFile)) {
    output({ ok: false, error: `输入文件不存在：${inputFile}` });
    process.exit(1);
  }

  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const items: BatchItem[] = inputData.items;

  if (!Array.isArray(items)) {
    output({ ok: false, error: '输入文件格式错误：缺少 items 数组' });
    process.exit(1);
  }

  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<RelationsCache>(cachePath);

  if (!cache) {
    output({ ok: false, error: 'relations-cache.json 不存在' });
    process.exit(1);
  }

  const results: SyncResult[] = [];
  let failed = 0;

  for (const item of items) {
    try {
      // 检查空 module-info
      if (!item.module_info || !item.module_info.trim()) {
        console.warn(`警告：Relation "${item.relation}" 的模块信息不能为空，已跳过`);
        results.push({
          relation: item.relation || '(空)',
          evicted: null,
        });
        failed++;
        continue;
      }

      // relation 名含 "/"、"\\"、".." 会破坏 wiki 文件路径，与空 module-info 同等处理：跳过并计入 failed
      if (isUnsafeRelationName(item.relation || '')) {
        console.warn(`警告：Relation "${item.relation}" 含非法路径字符（不能包含 "/"、"\\" 或 ".."），已跳过`);
        results.push({
          relation: item.relation || '(空)',
          evicted: null,
        });
        failed++;
        continue;
      }

      const result = syncSingleRelation(
        cache,
        scope,
        item.group,
        item.relation,
        item.module_info
      );

      // Wiki 写回（容错）
      try {
        const wikiResult = writeBackToWiki(
          scope, item.group, item.relation, item.module_info
        );
        result.wikiSynced = wikiResult.synced;
        if (wikiResult.synced) result.wikiFile = wikiResult.file;
      } catch {
        result.wikiSynced = false;
      }

      results.push(result);
    } catch (err) {
      results.push({
        relation: item.relation,
        evicted: null,
      });
      failed++;
    }
  }

  // 统一 WAL 持久化
  writeJson(cachePath, cache);

  output({
    ok: true,
    scope,
    results,
    total: items.length,
    failed,
    // 非向量化模式透出：批量模式当前不做向量写入；--no-vector 时明确标注（供调用方感知）
    ...(vector === false ? { vector: false, vectorNote: '非向量化模式（--no-vector），仅写 KB 层' } : {}),
  });
}

// ─── MCP / CLI 共享纯函数 ───

export interface SyncRelationParams {
  scope?: string;
  group: string;
  relation: string;
  moduleInfo: string;
  /** 是否写入向量层（ki-search / ki-relation）。false = 非向量化（仅 KB 层，不产生 memoryId） */
  vector?: boolean;
  /** 文档内容的自定义标签（逗号分隔多个）。ki-search 始终默认写入；自定义 tags 额外各写一条内容向量 */
  tags?: string;
}

export type SyncRelationResult =
  | { ok: true; scope: string; relation: string; evicted: string | null; hint?: string; vectorPending?: boolean; vectorStored?: boolean; vectorReason?: string; wikiSynced?: boolean; wikiFile?: string; wikiReason?: string }
  | { ok: false; error: string };

// ─── 向量写入（一次批量 embed，await 完成后返回） ───

/**
 * 向量写入：一次 vectorBulkStore 批量写 ki-relation 路径向量 + ki-search 语义向量，
 * 并把 ki-search 条（index 1）的 docId 回写到 cache（供后续 delete 定位）。
 * 失败仅记日志，不抛，不阻塞主流程；返回 { stored, reason? } 供上层透出
 * 部分写入状态（cache/wiki 成功但向量未写时，调用方需要感知）。
 */
async function vectorWriteBack(params: {
  relation: string;
  group: string;
  moduleInfo: string;
  scope: string;
  cachePath: string;
  /** 文档内容自定义标签（额外叠加在 ki-search 之上） */
  tags?: string;
}): Promise<{ stored: boolean; reason?: string }> {
  const { relation, group, moduleInfo, scope, cachePath, tags } = params;

  try {
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      console.warn(`[sync-relation] 向量服务不可用，跳过向量写入: ${avail.reason || ''}`);
      return { stored: false, reason: avail.reason || '向量服务不可用' };
    }

    const relText = buildRelationContent(relation, group);
    const customTags = parseContentTags(tags);
    // 内容向量：ki-search（默认）+ 每个自定义 tag 各写一条（text 相同、tag 不同 → docId 不同）
    const contentEntries = [
      { text: moduleInfo, tags: 'ki-search' },
      ...customTags.map((t) => ({ text: moduleInfo, tags: t })),
    ];

    // 一次 embed 批量写：ki-relation 路径向量 + 内容向量（ki-search + 自定义 tags）
    // 顺序：先写新向量，成功后再清旧 tag 向量，避免「先删后写」在写失败时丢内容向量（M2）
    const result = await vectorBulkStore({
      scope,
      entries: [
        { text: relText, tags: 'ki-relation', group },
        ...contentEntries,
      ],
    });

    // 写失败：不删任何旧向量，保持数据守恒（仅残留旧 tag 向量，delete 时 search 兜底可清）
    const failed = result.results.filter((r) => !r.success);
    if (failed.length === result.results.length) {
      return { stored: false, reason: failed[0]?.error || '向量写入全部失败' };
    }

    // 新向量写入成功（至少部分成功）后，清理旧自定义 tag 内容：
    // 删除「旧 memoryIds 中不在本次新 tag 集合」的 docId，避免修改 tags 后旧标签内容向量残留（#M1 数据守恒）
    const newContentIds = new Set([
      generateDocId(moduleInfo, scope, 'ki-search'),
      ...customTags.map((t) => generateDocId(moduleInfo, scope, t)),
    ]);
    try {
      const priorCache = readJson<RelationsCache>(cachePath);
      const priorIds = priorCache?.groups?.[group]?.hot_relations?.find((r) => r.text === relation)?.memoryIds ?? [];
      const staleIds = priorIds.filter((id) => id && !newContentIds.has(id));
      if (staleIds.length > 0) {
        await vectorDelete({ scope, ids: staleIds });
      }
    } catch {
      // 旧 tag 清理失败不影响主流程（仅可能残留孤儿向量，delete 时 search 兜底可清）
    }

    // 内容向量（ki-search + 自定义 tags）的全部 docId 回写 cache：
    // memoryId = ki-search 主条（向后兼容）；memoryIds = 全部内容 docId（多 tag 各一，供 delete 精确清理）
    const contentItems = result.results.filter((r) => r.index >= 1 && r.success);
    const searchItem = result.results.find((r) => r.index === 1 && r.success);
    if (contentItems.length > 0 || searchItem) {
      try {
        const latestCache = readJson<RelationsCache>(cachePath);
        if (latestCache) {
          const groupData = latestCache.groups[group];
          const rel = groupData?.hot_relations.find(r => r.text === relation);
          if (rel) {
            const allIds = contentItems.map((r) => r.memoryId).filter(Boolean) as string[];
            if (allIds.length > 0) {
              rel.memoryIds = allIds;
            }
            if (searchItem?.memoryId) {
              rel.memoryId = searchItem.memoryId;
            }
            // 持久化自定义 tag 到 KB 层（relation.tags），供 rebuild-vector/restore 恢复 tag 向量
            rel.tags = customTags.length > 0 ? customTags : undefined;
            writeJson(cachePath, latestCache);
          }
        }
      } catch {
        // memoryId 回写失败不影响主流程，delete 时用 search 兜底
      }
    }

    return { stored: true };
  } catch (err) {
    console.warn(`[sync-relation] 向量写入失败: ${(err as Error).message}`);
    return { stored: false, reason: (err as Error).message };
  }
}

export async function executeSyncRelation(params: SyncRelationParams): Promise<SyncRelationResult> {
  try {
    const { moduleInfo } = params;
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    const group = String(params.group).replace(/^\/+|\/+$/g, '');
    const relation = params.relation;

    if (!group || !relation || !moduleInfo) {
      return { ok: false, error: '单条模式需要 group/relation/module-info 参数' };
    }
    if (!String(moduleInfo).trim()) {
      return { ok: false, error: '--module-info 内容不能为空' };
    }
    if (!String(group).trim() || !String(relation).trim()) {
      return { ok: false, error: '--group / --relation 不能为空' };
    }
    // relation 名会直接作为 wiki 文件名，含 "/"、"\\"、".." 会破坏路径结构。
    // 在写入任何数据（cache / 向量 / wiki）之前直接拒绝，避免产生“cache/向量已写、
    // wiki 却静默跳过”的半成品状态。
    if (isUnsafeRelationName(relation)) {
      return { ok: false, error: `--relation 含非法路径字符，不能包含 "/"、"\\" 或 ".."：${relation}` };
    }

    validateScope(scope);
    ensureScopeDir(scope);

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<RelationsCache>(cachePath);

    if (!cache) {
      return { ok: false, error: 'relations-cache.json 不存在' };
    }

    // Group 路径自动补全提示
    let pathHint: string | undefined;
    const groupIndex = readGroupIndex(scope);
    if (groupIndex) {
      const resolved = await resolveGroupPath(group, groupIndex, cache.groups || {});
      if (resolved.matched && resolved.resolvedPath !== group) {
        pathHint = `💡 Group 路径已自动补全："${group}" → "${resolved.resolvedPath}"`;
      } else if (!resolved.matched && resolved.hint) {
        pathHint = resolved.hint;
      }
    }

    const result = syncSingleRelation(cache, scope, group, relation, moduleInfo);

    // WAL 持久化
    writeJson(cachePath, cache);

    // 向量写入（await 完成后再返回）：一次批量 embed 写 ki-relation + ki-search，
    // 并回写 ki-search 的 docId 到 cache 供 delete 定位。失败仅记日志，不阻塞主流程，
    // 但把写入结果透出到返回值（vectorStored/vectorReason），避免部分写入被静默吞掉。
    // 非向量化模式（vector=false）：跳过 embed 与 memoryId 回写，仅 KB 层。
    const vec = params.vector === false
      ? { stored: false, reason: '非向量化模式（--no-vector），跳过向量写入，无 memoryId' }
      : await vectorWriteBack({ relation, group, moduleInfo, scope, cachePath, tags: params.tags });

    // Wiki 写回（容错，失败不阻塞）
    let wikiSynced: boolean | undefined;
    let wikiFile: string | undefined;
    let wikiReason: string | undefined;
    try {
      const wikiResult = writeBackToWiki(scope, group, relation, moduleInfo);
      wikiSynced = wikiResult.synced;
      if (wikiResult.synced) {
        wikiFile = wikiResult.file;
      } else {
        wikiReason = wikiResult.reason;
      }
    } catch {
      wikiSynced = false;
    }

    // 透出实际写入的内容标签：向量化时始终为「ki-search + 自定义 tags」；
    // 非向量化时透出 []（空数组语义 = 未写向量，无内容标签）。
    const customTags = parseContentTags(params.tags);
    const contentTags = params.vector === false ? [] : ['ki-search', ...customTags];

    return {
      ok: true,
      scope,
      ...result,
      ...(pathHint ? { hint: pathHint } : {}),
      vectorPending: false,
      vectorStored: vec.stored,
      contentTags,
      ...(vec.reason ? { vectorReason: vec.reason } : {}),
      ...(wikiSynced !== undefined ? { wikiSynced } : {}),
      ...(wikiFile ? { wikiFile } : {}),
      ...(wikiReason ? { wikiReason } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('sync-relation')
  .showHelpAfterError()
  .description('关系回写：写入缓存 + 本地 KB')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-g, --group <group>', 'Group 路径（单条模式）')
  .option('-r, --relation <relation>', 'Relation 描述文本（单条模式）')
  .option('--module-info <moduleInfo>', '模块信息 Markdown（单条模式）')
  .option('-i, --input <input>', 'JSON 输入文件路径（批量模式）')
  .option('--tags <tags>', '文档内容自定义标签（逗号分隔多个，叠加在默认 ki-search 之上，如 api,auth）')
  .option('--no-vector', '非向量化模式：仅写 KB 层（relations-cache + local KB + Wiki），不写向量（不产生 memoryId，无法被 ki search 召回）')
  .action(async (opts) => {
    // REQ-10：超长 module-info（>1000 字符）输出警告，不自动切分（保持单条关系语义）
    if (opts.moduleInfo && opts.moduleInfo.length > 1000) {
      console.error(
        `警告: --module-info 长度 ${opts.moduleInfo.length} 字符（>1000）。` +
        `超长内容可能导致向量质量稀释；建议拆分多条写入，或改用 "scan-kb import --source <dir>" 自动切分导入。`
      );
    }
    // 非向量化模式（--no-vector → opts.vector=false）
    const vector = opts.vector !== false;
    // 批量模式
    if (opts.input) {
      try {
        // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
        const scope = resolveScope(loadConfig(), opts.scope);
        validateScope(scope);
        ensureScopeDir(scope);
        syncBatch(scope, opts.input, vector);
      } catch (err) {
        output({ ok: false, error: (err as Error).message });
        process.exit(1);
      }
      return;
    }

    // 单条模式：调用 executeSyncRelation
    const result = await executeSyncRelation({
      scope: opts.scope,
      group: opts.group || '',
      relation: opts.relation || '',
      moduleInfo: opts.moduleInfo || '',
      vector,
      tags: opts.tags,
    });

    if (result.ok) {
      if (result.hint) console.error(result.hint);
      output(result as unknown as Record<string, unknown>);
    } else {
      output({ ok: false, error: result.error });
    }
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK）
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
