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
import { readJson, writeJson, ensureScopeDir } from './lib/store.js';
import {
  getRelationsCachePath,
  getLocalKbDir,
  validateScope,
} from './lib/scope.js';
import { recordUse, calculateScore } from './lib/scoring.js';
import type { Relation } from './lib/scoring.js';
import type { PartitionConfig } from './lib/constants.js';
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';

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
      const { scope, group, relation } = opts;

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

      // 查找 Relation
      const groupData = cache.groups[group];
      if (!groupData) {
        output({
          ok: false,
          error: `Group "${group}" 在 relations-cache 中不存在`,
          hint: '请检查 Group 路径或先使用 sync-relation.ts 写入关系',
        });
        process.exit(1);
      }

      const rel = groupData.hot_relations.find(
        (r) => r.id === relation || r.text === relation
      );

      if (!rel) {
        output({
          ok: false,
          error: `Relation "${relation}" 不存在于 Group "${group}" 中`,
          hint: '请走检索路径或使用 sync-relation.ts 写入',
        });
        process.exit(1);
      }

      // 读取本地 KB index.json
      const localKbPath = getLocalKbDir(scope, group);
      const localKb = readJson<Record<string, string>>(localKbPath);

      if (!localKb) {
        output({
          ok: false,
          error: `本地 KB 文件不存在：${localKbPath}`,
          hint: '请从记忆系统同步或检查数据完整性',
        });
        process.exit(1);
      }

      // 查找 Markdown 内容（优先用 text 作为 key）
      const markdown = localKb[rel.text];
      if (!markdown) {
        output({
          ok: false,
          error: `本地 KB 中未找到 "${rel.text}" 的内容`,
          hint: '请使用 sync-relation.ts 重新写入模块信息',
        });
        process.exit(1);
      }

      // 更新评分（recordUse）
      const now = Date.now();
      const updatedRel = recordUse(rel, now);
      const config = cache.partition_config || DEFAULT_PARTITION_CONFIG;
      updatedRel.score = calculateScore(
        updatedRel.useCount,
        updatedRel.lastUsedTime,
        now,
        config.halfLifeHours
      );

      // 更新 cache 中的 relation
      const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel.id);
      groupData.hot_relations[relIdx] = updatedRel;
      writeJson(cachePath, cache);

      // 输出 Markdown 到 stdout
      console.log(markdown);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
