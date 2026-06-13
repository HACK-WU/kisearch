#!/usr/bin/env node
/**
 * sync-relation.ts - 关系回写
 *
 * 接收 AI 提供的 relation + 模块信息 + 关键词，校验后写入缓存 + 本地 KB。
 * 支持单条模式和批量模式。
 *
 * 用法:
 *   单条: npx jiti sync-relation.ts --scope <scope> --group <group> --relation <text>
 *         --module-info <markdown> --keywords <kw1,kw2>
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
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import {
  buildRelationContent,
  storeOnePath,
} from './lib/path-vectorize.js';

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
  keywords: string[];
  invalid_keywords: string[];
  evicted: string | null;
}

interface BatchItem {
  group: string;
  relation: string;
  module_info: string;
  keywords: string[];
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

// ─── 关键词校验 ───

/**
 * 校验关键词：
 * 1. 禁止纯代码符号/路径/文件名（推定为代码遵引不适合作为词云）
 * 2. 关键词必须在 moduleInfo 原文中出现
 *
 * 收紧为“硬拒则”，避免误伤含点合法中文词（如 "v1.0" "OAuth 2.0"）。
 */
function validateKeywords(
  keywords: string[],
  moduleInfo: string
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];

  // 硬拒则：路径分隔符 / 常见代码符号 / 模板字符 / 文件扩展名
  const HARD_REJECT_PATTERN = /[\/\\@#{}\[\]<>;`$]|^[*~`#=]+$|\.(ts|js|tsx|jsx|md|json|yml|yaml|sh|py|go|rs|java|c|cpp|h|hpp)$/i;
  // 软拒则：出现下面任一且不含中文字符，推定为代码表达式而非词语
  const CODE_HINT_PATTERN = /[()=:]/;
  const HAS_CJK = /[\u4e00-\u9fa5]/;

  for (const kw of keywords) {
    if (typeof kw !== 'string') {
      invalid.push(String(kw));
      continue;
    }
    const trimmed = kw.trim();
    if (!trimmed) continue;

    if (HARD_REJECT_PATTERN.test(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    if (CODE_HINT_PATTERN.test(trimmed) && !HAS_CJK.test(trimmed)) {
      invalid.push(trimmed);
      continue;
    }

    // 检查是否在原文中真实出现
    if (!moduleInfo.includes(trimmed)) {
      invalid.push(trimmed);
      continue;
    }

    valid.push(trimmed);
  }

  return { valid, invalid };
}

// ─── 核心同步逻辑 ───

function syncSingleRelation(
  cache: RelationsCache,
  scope: string,
  group: string,
  relationText: string,
  moduleInfo: string,
  keywords: string[]
): SyncResult {
  const config = cache.partition_config || DEFAULT_PARTITION_CONFIG;

  // 1. 校验关键词
  const { valid: validKeywords, invalid: invalidKeywords } = validateKeywords(
    keywords,
    moduleInfo
  );

  // 2. 确保 Group 路径在 group-index.json 树中完整存在（自动补建缺失节点）
  ensureGroupPath(scope, group);

  // 3. 确保 group 数据在 relations-cache 中存在
  if (!cache.groups[group]) {
    cache.groups[group] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: config.maxHotCount,
    };
  }
  const groupData = cache.groups[group];

  // 4. 查找或创建 Relation
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

    // 5. 检查是否需要淘汰
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

      // 淘汰时直接移除，不再搬运 keywords（keywords 已在 Group 级）
      groupData.hot_relations.splice(minIdx, 1);
    }

    // 6. 添加新 Relation
    groupData.hot_relations.push(newRel);

    // 按 score 降序排列
    groupData.hot_relations.sort((a, b) => b.score - a.score);
  }

  // 7. 合并 validKeywords 到 Group.keywords（去重 + FIFO 截断）
  for (const kw of validKeywords) {
    if (!groupData.keywords.includes(kw)) {
      groupData.keywords.push(kw);
    }
  }
  if (groupData.keywords.length > config.maxKeywordCount) {
    const overflow = groupData.keywords.length - config.maxKeywordCount;
    groupData.keywords.splice(0, overflow);
  }

  // 8. 写入本地 KB
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
    keywords: validKeywords,
    invalid_keywords: invalidKeywords,
    evicted,
  };
}

// ─── 批量模式 ───

function syncBatch(
  scope: string,
  inputFile: string
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
          keywords: [],
          invalid_keywords: [],
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
        item.module_info,
        item.keywords || []
      );

      // 空关键词产生警告
      if (result.keywords.length === 0) {
        console.warn(`警告：Relation "${item.relation}" 的关键词全部无效或为空`);
      }

      results.push(result);
    } catch (err) {
      results.push({
        relation: item.relation,
        keywords: [],
        invalid_keywords: [],
        evicted: null,
      });
      failed++;
    }
  }

  // 统一 WAL 持久化
  writeJson(cachePath, cache);

  output({
    ok: true,
    results,
    total: items.length,
    failed,
  });
}

// ─── CLI ───

const program = new Command();

program
  .name('sync-relation')
  .description('关系回写：校验关键词 + 写入缓存 + 本地 KB')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .option('--group <group>', 'Group 路径（单条模式）')
  .option('--relation <relation>', 'Relation 描述文本（单条模式）')
  .option('--module-info <moduleInfo>', '模块信息 Markdown（单条模式）')
  .option('--keywords <keywords>', '逗号分隔的关键词列表（单条模式）')
  .option('--input <input>', 'JSON 输入文件路径（批量模式）')
  .action(async (opts) => {
    try {
      const { scope, input } = opts;

      validateScope(scope);
      ensureScopeDir(scope);

      // 批量模式
      if (input) {
        syncBatch(scope, input);
        return;
      }

      // 单条模式
      // 规范化 Group 路径：去除首尾斜杠
      const group = opts.group ? String(opts.group).replace(/^\/+|\/+$/g, '') : '';
      const { relation, moduleInfo, keywords } = opts;

      if (!group || !relation || !moduleInfo || !keywords) {
        output({
          ok: false,
          error: '单条模式需要 --group --relation --module-info --keywords 参数',
        });
        process.exit(1);
      }

      // 空内容防护（仅空格/制表符也不能接受）
      if (!String(moduleInfo).trim()) {
        output({ ok: false, error: '--module-info 内容不能为空' });
        process.exit(1);
      }
      if (!String(group).trim() || !String(relation).trim()) {
        output({ ok: false, error: '--group / --relation 不能为空' });
        process.exit(1);
      }

      const keywordList = keywords.split(',').map((k: string) => k.trim());

      // Group 路径自动补全提示
      const groupIndex = readGroupIndex(scope);
      const cacheForResolve = readJson<RelationsCache>(getRelationsCachePath(scope));
      if (groupIndex) {
        const resolved = resolveGroupPath(group, groupIndex, cacheForResolve?.groups || {});
        if (resolved.matched && resolved.resolvedPath !== group) {
          console.error(`💡 Group 路径已自动补全："${group}" → "${resolved.resolvedPath}"`);
        } else if (!resolved.matched && resolved.hint) {
          console.error(resolved.hint);
        }
      }

      const cachePath = getRelationsCachePath(scope);
      const cache = readJson<RelationsCache>(cachePath);

      if (!cache) {
        output({ ok: false, error: 'relations-cache.json 不存在' });
        process.exit(1);
      }

      const result = syncSingleRelation(
        cache,
        scope,
        group,
        relation,
        moduleInfo,
        keywordList
      );

      // WAL 持久化
      writeJson(cachePath, cache);

      // 写入 ki-relation 向量索引（失败不阻塞）
      try {
        const relText = buildRelationContent(relation, group, keywordList);
        storeOnePath({ text: relText, tag: 'ki-relation', scope });
      } catch { /* 向量写入失败不影响主流程 */ }

      output({
        ok: true,
        ...result,
      });
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
