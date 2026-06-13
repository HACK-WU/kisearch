#!/usr/bin/env node
/**
 * migrate-keywords.ts - keywords Group 级别重构数据迁移
 *
 * 将旧版 relations-cache.json 中的 keywords 从 Relation 级提升到 Group 级：
 * - 合并 Group.word_cloud_keywords + 所有 hot_relations[].keywords → 去重 → Group.keywords
 * - 删除 Group.word_cloud_keywords 字段
 * - 删除每个 Relation 的 keywords 字段
 * - FIFO 截断到 maxKeywordCount
 *
 * 幂等：已迁移的 Group（无 word_cloud_keywords / 无 Relation.keywords）执行结果不变。
 *
 * 用法:
 *   单 scope: npx jiti scripts/migrate-keywords.ts --scope <scope>
 *   全部:     npx jiti scripts/migrate-keywords.ts --all
 *   预演:     额外加 --dry-run，仅打印将变更的内容，不写盘
 */

import { Command } from 'commander';
import fs from 'fs';
import { readJson, writeJson } from './lib/store.js';
import { getRelationsCachePath, validateScope, listAllScopes } from './lib/scope.js';
import { DEFAULT_PARTITION_CONFIG, type PartitionConfig } from './lib/constants.js';

// ─── 类型定义（兼容新旧格式） ───

interface LegacyRelation {
  id: string;
  text: string;
  score: number;
  useCount: number;
  lastUsedTime: number | null;
  keywords?: string[];
  isImported: boolean;
}

interface LegacyGroupData {
  hot_relations: LegacyRelation[];
  word_cloud_keywords?: string[];
  keywords?: string[];
  max_hot_count: number;
}

interface LegacyRelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, LegacyGroupData>;
  updatedAt: string | null;
}

interface MigrateStat {
  scope: string;
  groups_total: number;
  groups_migrated: number;
  relations_cleaned: number;
  keywords_total: number;
  keywords_truncated: number;
}

// ─── 输出 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── 单 scope 迁移 ───

function migrateScope(scope: string, dryRun: boolean): MigrateStat {
  validateScope(scope);
  const cachePath = getRelationsCachePath(scope);

  const stat: MigrateStat = {
    scope,
    groups_total: 0,
    groups_migrated: 0,
    relations_cleaned: 0,
    keywords_total: 0,
    keywords_truncated: 0,
  };

  if (!fs.existsSync(cachePath)) {
    console.warn(`警告：scope "${scope}" 无 relations-cache.json，跳过`);
    return stat;
  }

  const cache = readJson<LegacyRelationsCache>(cachePath);
  if (!cache) {
    console.warn(`警告：scope "${scope}" 读取 relations-cache.json 失败，跳过`);
    return stat;
  }

  const maxKw = (cache.partition_config || DEFAULT_PARTITION_CONFIG).maxKeywordCount;

  for (const [groupPath, group] of Object.entries(cache.groups)) {
    stat.groups_total++;

    const hadLegacyField = group.word_cloud_keywords !== undefined;
    const hadRelationKeywords = group.hot_relations.some(
      (r) => Array.isArray((r as LegacyRelation).keywords)
    );
    const needsMigrate = hadLegacyField || hadRelationKeywords || group.keywords === undefined;

    // 合并 keywords（去重）
    const merged: string[] = [];
    const seen = new Set<string>();

    const pushUnique = (kws: string[] | undefined): void => {
      if (!kws) return;
      for (const kw of kws) {
        if (typeof kw !== 'string') continue;
        const trimmed = kw.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        merged.push(trimmed);
      }
    };

    // 已有的 Group.keywords（幂等：第二次运行时此字段已存在）
    pushUnique(group.keywords);
    // 旧字段 word_cloud_keywords
    pushUnique(group.word_cloud_keywords);
    // 各 Relation 上的 keywords
    for (const rel of group.hot_relations) {
      pushUnique((rel as LegacyRelation).keywords);
    }

    // FIFO 截断
    let truncated = 0;
    if (merged.length > maxKw) {
      truncated = merged.length - maxKw;
      merged.splice(0, truncated);
    }

    // 写回 Group.keywords，删除旧字段
    group.keywords = merged;
    if ('word_cloud_keywords' in group) {
      delete group.word_cloud_keywords;
    }

    // 清理每个 Relation 上的 keywords 字段
    for (const rel of group.hot_relations) {
      if ('keywords' in rel) {
        delete (rel as LegacyRelation).keywords;
        stat.relations_cleaned++;
      }
    }

    if (needsMigrate) stat.groups_migrated++;
    stat.keywords_total += merged.length;
    stat.keywords_truncated += truncated;

    if (dryRun) {
      console.warn(
        `[dry-run] ${scope} :: ${groupPath} → keywords(${merged.length})${truncated ? ` 截断${truncated}` : ''}`
      );
    }
  }

  if (!dryRun) {
    writeJson(cachePath, cache as unknown as Record<string, unknown>);
  }

  return stat;
}

// ─── CLI ───

const program = new Command();

program
  .name('migrate-keywords')
  .description('keywords Group 级别重构数据迁移（幂等）')
  .option('--scope <scope>', '迁移指定 scope')
  .option('--all', '迁移 kb/ 下的全部 scope')
  .option('--dry-run', '仅打印将变更内容，不写盘', false)
  .action(async (opts) => {
    try {
      const dryRun = !!opts.dryRun;

      let scopes: string[];
      if (opts.all) {
        scopes = listAllScopes();
      } else if (opts.scope) {
        scopes = [String(opts.scope)];
      } else {
        output({ ok: false, error: '需指定 --scope <scope> 或 --all' });
        process.exit(1);
      }

      const stats: MigrateStat[] = [];
      for (const scope of scopes) {
        stats.push(migrateScope(scope, dryRun));
      }

      output({
        ok: true,
        dry_run: dryRun,
        scopes_processed: stats.length,
        stats,
      });
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
