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

// ─── CLI ───

const program = new Command();

program
  .name('get-module-info')
  .description('模块检索：读取本地 KB + 更新评分')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--group <group>', 'Group 路径')
  .requiredOption('--relation <relation>', 'Relation ID 或名称')
  .action(async (opts) => {
    try {
      const { scope, relation } = opts;
      // 规范化 Group 路径：去除首尾斜杠
      const group = String(opts.group).replace(/^\/+|\/+$/g, '');

      validateScope(scope);
      ensureScopeDir(scope);

      // 读取 relations-cache
      const cachePath = getRelationsCachePath(scope);
      const cache = readJson<RelationsCache>(cachePath);

      if (!cache) {
        output({
          ok: false,
          error: 'relations-cache.json 不存在',
          hint: '请先使用 sync-relation.ts 写入关系',
        });
        process.exit(1);
      }

      // 读取 group-index 用于路径自动补全
      const groupIndex = readGroupIndex(scope);

      // Group 路径自动补全（传入 scope 启用向量兜底）
      const resolved = resolveGroupPath(group, groupIndex || { version: 1, scope, groups: {}, updatedAt: null }, cache.groups, scope);

      if (!resolved.matched) {
        output({
          ok: false,
          error: `Group "${group}" 未匹配到有效路径`,
          hint: resolved.hint,
        });
        process.exit(1);
      }

      // 补全成功时提示用户
      if (resolved.hint) {
        console.error(resolved.hint);
      }

      const resolvedGroup = resolved.resolvedPath;

      // 查找 Group
      const groupData = cache.groups[resolvedGroup];
      if (!groupData) {
        // resolveGroupPath matched=true 但 groupsData 中无数据（仅存在于 group-index 树中）
        output({
          ok: false,
          error: `Group "${resolvedGroup}" 在 relations-cache 中暂无 Relation 数据`,
          hint: '该 Group 路径存在但尚未写入知识条目，请先使用 sync-relation.ts 写入',
        });
        process.exit(1);
      }

      // 查找 Relation
      let rel = groupData.hot_relations.find(
        (r) => r.id === relation || r.text === relation
      );

      if (!rel) {
        // 向量语义兜底：尝试模糊匹配 relation 名称
        const fuzzyRel = searchPath(relation, 'ki-relation', scope);
        if (fuzzyRel && fuzzyRel.matched) {
          // 用提取出的 relation 名称重新查找
          const fuzzyRelText = fuzzyRel.extractedPath;
          const fuzzyMatchedRel = groupData.hot_relations.find(
            (r) => r.text === fuzzyRelText
          );
          if (fuzzyMatchedRel) {
            console.error(`💡 近似匹配：Relation "${relation}" → "${fuzzyRelText}"（score: ${fuzzyRel.score.toFixed(2)}）`);
            // 继续后续流程，用 fuzzyMatchedRel 替代 rel
            rel = fuzzyMatchedRel;
          }
        }

        if (!rel) {
          const availableRelations = groupData.hot_relations.map((r) => r.text);
          const relationHint = availableRelations.length > 0
            ? `Group "${resolvedGroup}" 中可用的 Relation：\n${availableRelations.map((r) => `  - ${r}`).join('\n')}`
            : `Group "${resolvedGroup}" 中暂无 Relation`;
          output({
            ok: false,
            error: `Relation "${relation}" 不存在于 Group "${resolvedGroup}" 中`,
            hint: relationHint,
          });
          process.exit(1);
        }
      }

      // 读取本地 KB index.json
      const localKbPath = getLocalKbDir(scope, resolvedGroup);
      const localKb = readJson<Record<string, string>>(localKbPath);

      if (!localKb) {
        output({
          ok: false,
          error: `本地 KB 文件不存在：${localKbPath}`,
          hint: [
            '本地 KB 缺失的可能原因与修复方式：',
            `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容> --keywords <词1,词2>`,
            '2. 如果是从外部 Wiki 导入的数据，检查 scan-kb import 是否完整执行',
            '3. 检查数据文件是否被误删除或备份恢复不完整',
          ].join('\n'),
        });
        process.exit(1);
      }

      // 查找 Markdown 内容（优先用 text 作为 key）
      const markdown = localKb ? localKb[rel!.text] : null;
      if (!markdown) {
        output({
          ok: false,
          error: `本地 KB 中未找到 "${rel!.text}" 的内容`,
          hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel!.text}" --module-info <内容> --keywords <词1,词2>`,
        });
        process.exit(1);
      }

      // 更新评分（recordUse）
      const now = Date.now();
      const updatedRel = recordUse(rel!, now);
      const config = cache!.partition_config || DEFAULT_PARTITION_CONFIG;
      updatedRel.score = calculateScore(
        updatedRel.useCount,
        updatedRel.lastUsedTime,
        now,
        config.halfLifeHours
      );

      // 更新 cache 中的 relation
      const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel!.id);
      groupData.hot_relations[relIdx] = updatedRel;
      writeJson(cachePath, cache! as unknown as Record<string, unknown>);

      // 输出 Markdown 到 stdout
      console.log(markdown);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
