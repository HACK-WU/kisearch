#!/usr/bin/env node
/**
 * get-module-info.ts - 模块检索
 *
 * 读取本地 KB index.json，返回 Relation 对应的 Markdown 文本，同时更新评分。
 *
 * 用法:
 *   npx jiti scripts/get-module-info.ts --scope <scope> --group <group> --relation <relationId>
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
  | { ok: true; content: string; hint?: string }
  | { ok: false; error: string; hint?: string };

export function executeGetModuleInfo(params: GetModuleInfoParams): GetModuleInfoResult {
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
    const resolved = resolveGroupPath(group, groupIndex || { version: 1, scope, groups: {}, updatedAt: null }, cache.groups, scope);

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

    let rel = groupData.hot_relations.find(
      (r) => r.id === relation || r.text === relation
    );

    if (!rel) {
      const fuzzyRel = searchPath(relation, 'ki-relation', scope);
      if (fuzzyRel && fuzzyRel.matched) {
        const fuzzyRelText = fuzzyRel.extractedPath;
        const fuzzyMatchedRel = groupData.hot_relations.find((r) => r.text === fuzzyRelText);
        if (fuzzyMatchedRel) {
          hints.push(`💡 近似匹配：Relation "${relation}" → "${fuzzyRelText}"（score: ${fuzzyRel.score.toFixed(2)}）`);
          rel = fuzzyMatchedRel;
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
    }

    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    const localKb = readJson<Record<string, string>>(localKbPath);

    if (!localKb) {
      return {
        ok: false,
        error: `本地 KB 文件不存在：${localKbPath}`,
        hint: [
          '本地 KB 缺失的可能原因与修复方式：',
          `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容> --keywords <词1,词2>`,
          '2. 如果是从外部 Wiki 导入的数据，检查 scan-kb import 是否完整执行',
          '3. 检查数据文件是否被误删除或备份恢复不完整',
        ].join('\n'),
      };
    }

    const markdown = localKb[rel!.text] ?? null;
    if (!markdown) {
      return {
        ok: false,
        error: `本地 KB 中未找到 "${rel!.text}" 的内容`,
        hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel!.text}" --module-info <内容> --keywords <词1,词2>`,
      };
    }

    // 更新评分（recordUse）
    const now = Date.now();
    const updatedRel = recordUse(rel!, now);
    const config = cache!.partition_config || DEFAULT_PARTITION_CONFIG;
    updatedRel.score = calculateScore(updatedRel.useCount, updatedRel.lastUsedTime, now, config.halfLifeHours);

    const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel!.id);
    groupData.hot_relations[relIdx] = updatedRel;
    writeJson(cachePath, cache! as unknown as Record<string, unknown>);

    return {
      ok: true,
      content: markdown,
      ...(hints.length > 0 ? { hint: hints.join('\n') } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('get-module-info')
  .description('模块检索：读取本地 KB + 更新评分')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--group <group>', 'Group 路径')
  .requiredOption('--relation <relation>', 'Relation ID 或名称')
  .action(async (opts) => {
    const result = executeGetModuleInfo({
      scope: opts.scope,
      group: opts.group,
      relation: opts.relation,
    });
    if (result.ok) {
      if (result.hint) console.error(result.hint);
      console.log(result.content);
    } else {
      output({ ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) });
      process.exit(1);
    }
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
