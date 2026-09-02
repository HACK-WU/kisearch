#!/usr/bin/env node
/**
 * get-module-info.ts - 模块检索
 *
 * 读取本地 KB index.json，返回 Relation 对应的 Markdown 文本，同时更新评分。
 *
 * 用法:
 *   npx jiti src/get-module-info.ts --scope <scope> --group <group> --relation <relationId>
 */

import { Command } from 'commander';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './lib/store.js';
import {
  getRelationsCachePath,
  getLocalKbDir,
  validateScope,
} from './lib/scope.js';
import { recordUse, calculateScore } from './lib/scoring.js';
import type { Relation } from './lib/scoring.js';
import type { PartitionConfig } from './lib/constants.js';
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import { searchPath } from './lib/path-search.js';
import { closeEngine } from './lib/vector-client.js';
import { loadConfig, resolveScope } from './lib/config.js';

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

// ─── 输出 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── MCP / CLI 共享纯函数 ───

export interface GetModuleInfoParams {
  scope: string;
  group: string;
  relation: string;
}

export type GetModuleInfoResult =
  | { ok: true; scope: string; content: string; hint?: string }
  | { ok: false; error: string; hint?: string };

/**
 * 在 Group 内查找 Relation：先精确匹配（id 或名称），未命中再走向量模糊兜底。
 * 供单条/批量两条链路复用；searchPath 自带降级（向量不可用返回 null，静默跳过模糊匹配）。
 */
async function findRelationWithFuzzy(
  groupData: GroupData,
  relation: string,
  scope: string
): Promise<{ rel: Relation; fuzzyHint?: string } | null> {
  const exact = groupData.hot_relations.find(
    (r) => r.id === relation || r.text === relation
  );
  if (exact) return { rel: exact };

  const fuzzyRel = await searchPath(relation, 'ki-relation', scope);
  if (fuzzyRel && fuzzyRel.matched) {
    const fuzzyRelText = fuzzyRel.extractedPath;
    const fuzzyMatchedRel = groupData.hot_relations.find((r) => r.text === fuzzyRelText);
    if (fuzzyMatchedRel) {
      return {
        rel: fuzzyMatchedRel,
        fuzzyHint: `💡 近似匹配：Relation "${relation}" → "${fuzzyRelText}"（score: ${fuzzyRel.score.toFixed(2)}）`,
      };
    }
  }
  return null;
}

export async function executeGetModuleInfo(params: GetModuleInfoParams): Promise<GetModuleInfoResult> {
  try {
    const { scope, relation } = params;
    const group = String(params.group).replace(/^\/+|\/+$/g, '');

    validateScope(scope);
    ensureScopeDir(scope);

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<RelationsCache>(cachePath);

    if (!cache) {
      return { ok: false, error: 'relations-cache.json 不存在', hint: '请先使用 sync-relation.ts 写入关系' };
    }

    const groupIndex = readGroupIndex(scope);
    const resolved = await resolveGroupPath(group, groupIndex || { version: 1, scope, groups: {}, updatedAt: null }, cache.groups, scope);

    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到有效路径`, hint: resolved.hint };
    }

    const resolvedGroup = resolved.resolvedPath;
    const hints: string[] = [];
    if (resolved.hint) hints.push(resolved.hint);

    const groupData = cache.groups[resolvedGroup];
    if (!groupData) {
      return {
        ok: false,
        error: `Group "${resolvedGroup}" 在 relations-cache 中暂无 Relation 数据`,
        hint: '该 Group 路径存在但尚未写入知识条目，请先使用 sync-relation.ts 写入',
      };
    }

    let rel: Relation | null = null;
    {
      const found = await findRelationWithFuzzy(groupData, relation, scope);
      if (found) {
        rel = found.rel;
        if (found.fuzzyHint) hints.push(found.fuzzyHint);
      }
    }

    if (!rel) {
      const availableRelations = groupData.hot_relations.map((r) => r.text);
      const relationHint = availableRelations.length > 0
        ? `Group "${resolvedGroup}" 中可用的 Relation：\n${availableRelations.map((r) => `  - ${r}`).join('\n')}`
        : `Group "${resolvedGroup}" 中暂无 Relation`;
      return {
        ok: false,
        error: `Relation "${relation}" 不存在于 Group "${resolvedGroup}" 中`,
        hint: relationHint,
      };
    }

    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    const localKb = readJson<Record<string, string>>(localKbPath);

    if (!localKb) {
      return {
        ok: false,
        error: `本地 KB 文件不存在：${localKbPath}`,
        hint: [
          '本地 KB 缺失的可能原因与修复方式：',
          `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
          '2. 如果是从外部 Wiki 导入的数据，检查 scan-kb import 是否完整执行',
          '3. 检查数据文件是否被误删除或备份恢复不完整',
        ].join('\n'),
      };
    }

    const markdown = localKb[rel.text] ?? null;
    if (!markdown) {
      return {
        ok: false,
        error: `本地 KB 中未找到 "${rel.text}" 的内容`,
        hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
      };
    }

    // 更新评分（recordUse）
    const now = Date.now();
    const updatedRel = recordUse(rel, now);
    const config = cache!.partition_config || DEFAULT_PARTITION_CONFIG;
    updatedRel.score = calculateScore(updatedRel.useCount, updatedRel.lastUsedTime, now, config.halfLifeHours);

    const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel.id);
    groupData.hot_relations[relIdx] = updatedRel;
    writeJson(cachePath, cache! as unknown as Record<string, unknown>);

    return {
      ok: true,
      scope,
      content: markdown,
      ...(hints.length > 0 ? { hint: hints.join('\n') } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── 批量查询（同 Group 下多个 Relation，CLI/MCP 共享纯函数） ───

/** 单次批量查询上限：超限 fail-loud（防 AI 单次拖爆上下文），提示拆批 */
export const MAX_BATCH_RELATIONS = 10;

export interface BatchRelationResult {
  /** 调用方传入的 Relation 名称/ID */
  relation: string;
  /** 近似匹配命中时的实际 Relation 名（精确匹配时不出现） */
  matchedRelation?: string;
  ok: boolean;
  content?: string;
  error?: string;
  hint?: string;
}

export type GetModuleInfoBatchResult =
  | {
      ok: true;
      scope: string;
      /** 路径解析后的实际 Group */
      group: string;
      results: BatchRelationResult[];
      succeeded: number;
      failed: number;
      /** Group 路径解析提示（自动补全/近似匹配） */
      hint?: string;
    }
  | { ok: false; error: string; hint?: string };

export interface BatchGetModuleInfoParams {
  scope: string;
  group: string;
  relations: string[];
}

/**
 * 批量读取同 Group 下多个 Relation 的本地 KB Markdown 内容（≤ MAX_BATCH_RELATIONS 条）。
 *
 * 与逐条调用 executeGetModuleInfo 相比的收益：
 *   1. Group 路径解析（resolveGroupPath 向量语义兜底）只做一次——省 N-1 次 embedding 调用；
 *   2. localKb index.json 一次读取（同 Group 共享同一文件）；
 *   3. N 条评分更新合并一次 writeJson 落盘。
 *
 * 语义：
 *   - 逐条独立 ok：某条不存在/KB 缺内容仅该条失败，不阻塞其他条目；
 *   - relations 去重（保留首次出现顺序），重复条目只查询一次（recordUse 5min 防刷也会拦截重复计分）；
 *   - 超上限 fail-loud 报错（不静默截断）；
 *   - 整体性失败（cache/group/KB 缺失）返回 ok:false，与单条链路同语义。
 */
export async function executeGetModuleInfoBatch(params: BatchGetModuleInfoParams): Promise<GetModuleInfoBatchResult> {
  try {
    const { scope } = params;
    const group = String(params.group).replace(/^\/+|\/+$/g, '');

    // 入参护栏：去重（保留首次出现顺序）、空判、上限 fail-loud
    const rawList = Array.isArray(params.relations) ? params.relations : [];
    const relations = [...new Set(rawList.map((r) => String(r ?? '').trim()).filter(Boolean))];
    if (relations.length === 0) {
      return { ok: false, error: 'relations 不能为空' };
    }
    if (relations.length > MAX_BATCH_RELATIONS) {
      return {
        ok: false,
        error: `批量查询上限为 ${MAX_BATCH_RELATIONS} 条（去重后 ${relations.length} 条），请拆分调用`,
        hint: `建议分 ${Math.ceil(relations.length / MAX_BATCH_RELATIONS)} 批查询`,
      };
    }

    validateScope(scope);
    ensureScopeDir(scope);

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<RelationsCache>(cachePath);
    if (!cache) {
      return { ok: false, error: 'relations-cache.json 不存在', hint: '请先使用 sync-relation.ts 写入关系' };
    }

    // Group 路径解析：批量只做一次（省 N-1 次向量语义兜底调用）
    const groupIndex = readGroupIndex(scope);
    const resolved = await resolveGroupPath(group, groupIndex || { version: 1, scope, groups: {}, updatedAt: null }, cache.groups, scope);
    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到有效路径`, hint: resolved.hint };
    }
    const resolvedGroup = resolved.resolvedPath;

    const groupData = cache.groups[resolvedGroup];
    if (!groupData) {
      return {
        ok: false,
        error: `Group "${resolvedGroup}" 在 relations-cache 中暂无 Relation 数据`,
        hint: '该 Group 路径存在但尚未写入知识条目，请先使用 sync-relation.ts 写入',
      };
    }

    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    const localKb = readJson<Record<string, string>>(localKbPath);
    if (!localKb) {
      return {
        ok: false,
        error: `本地 KB 文件不存在：${localKbPath}`,
        hint: [
          '本地 KB 缺失的可能原因与修复方式：',
          `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation <名称> --module-info <内容>`,
          '2. 如果是从外部 Wiki 导入的数据，检查 scan-kb import 是否完整执行',
          '3. 检查数据文件是否被误删除或备份恢复不完整',
        ].join('\n'),
      };
    }

    const now = Date.now();
    const config = cache.partition_config || DEFAULT_PARTITION_CONFIG;
    const results: BatchRelationResult[] = [];
    let scoreUpdated = false;

    for (const relation of relations) {
      const found = await findRelationWithFuzzy(groupData, relation, scope);
      if (!found) {
        const availableRelations = groupData.hot_relations.map((r) => r.text);
        const relationHint = availableRelations.length > 0
          ? `Group "${resolvedGroup}" 中可用的 Relation：\n${availableRelations.map((r) => `  - ${r}`).join('\n')}`
          : `Group "${resolvedGroup}" 中暂无 Relation`;
        results.push({
          relation,
          ok: false,
          error: `Relation "${relation}" 不存在于 Group "${resolvedGroup}" 中`,
          hint: relationHint,
        });
        continue;
      }

      const { rel, fuzzyHint } = found;
      const markdown = localKb[rel.text] ?? null;
      if (!markdown) {
        results.push({
          relation,
          ...(fuzzyHint ? { matchedRelation: rel.text } : {}),
          ok: false,
          error: `本地 KB 中未找到 "${rel.text}" 的内容`,
          hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
        });
        continue;
      }

      // 更新评分（recordUse，5min 防刷对每条独立生效）；批量合并一次落盘
      const updatedRel = recordUse(rel, now);
      updatedRel.score = calculateScore(updatedRel.useCount, updatedRel.lastUsedTime, now, config.halfLifeHours);
      const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel.id);
      groupData.hot_relations[relIdx] = updatedRel;
      scoreUpdated = true;

      results.push({
        relation,
        ...(fuzzyHint ? { matchedRelation: rel.text, hint: fuzzyHint } : {}),
        ok: true,
        content: markdown,
      });
    }

    if (scoreUpdated) {
      writeJson(cachePath, cache as unknown as Record<string, unknown>);
    }

    const failed = results.filter((r) => !r.ok).length;
    return {
      ok: true,
      scope,
      group: resolvedGroup,
      results,
      succeeded: results.length - failed,
      failed,
      ...(resolved.hint ? { hint: resolved.hint } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('get-module-info')
  .showHelpAfterError()
  .description('模块检索：读取本地 KB + 更新评分')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('-g, --group <group>', 'Group 路径')
  .requiredOption('-r, --relation <relation>', 'Relation ID 或名称（多个用逗号分隔，≤10 条批量查询，须同 Group）')
  .action(async (opts) => {
    const scope = resolveScope(loadConfig(), opts.scope);
    const relationArgs = String(opts.relation || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    // 批量模式（对齐 ki_search 多 scope 逗号分隔先例）：多条逗号分隔 → 一次查同一 Group
    if (relationArgs.length > 1) {
      const batch = await executeGetModuleInfoBatch({ scope, group: opts.group, relations: relationArgs });
      output(batch as unknown as Record<string, unknown>);
      await closeEngine();
      if (!batch.ok) process.exit(1);
      return;
    }

    const result = await executeGetModuleInfo({
      scope,
      group: opts.group,
      relation: opts.relation,
    });
    if (result.ok) {
      if (result.hint) console.error(result.hint);
      // 文本展示输出：开头标注 scope，保证输出内容自解释
      console.log(`[scope: ${result.scope}]\n${result.content}`);
    } else {
      output({ ok: false, scope: opts.scope, error: result.error, ...(result.hint ? { hint: result.hint } : {}) });
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
