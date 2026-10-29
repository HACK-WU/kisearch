#!/usr/bin/env node
/**
 * migrate-relation-cache.ts —— ki migrate-relation-cache 命令
 *
 * 批次 2（REQ-20260930-002）：把旧布局单文件 `<scope>/relations-cache.json`
 * 显式迁移为 per-Group 分片布局（`<scope>/.relations/<groupPath>/cache.json` + manifest）。
 *
 * 背景：写路径的惰性迁移已就位（任一正式写路径首写该 scope 时自动转换）；
 * 本命令用于显式批量触发——迁移检查、批量运维、备份后统一转换、以及
 * 「只想迁移不动数据」的场景。
 *
 * 语义：
 *   - 幂等：已迁移 scope no-op（hasShardedLayout → migrated:false, alreadySharded:true）
 *   - 守恒：迁移前统计组数/relation 数并输出，供人工核对
 *   - 旧文件改名 `.bak` 保留（不自动删除；回退 = 停机后手动改回原名并删除 .relations/ 目录）
 *   - 无数据 scope（两布局均无）：noData:true，不建目录
 *   - 写锁：与 daemon 的 OperationCoordinator 共享 scope 写锁串行，迁移中不会被并发写穿插
 *   - daemon 进程内缓存（docListCache/relation-map/计数缓存）靠布局感知身份
 *     （manifest 三元组 ≠ 旧文件 mtime/size）自动失效，无需 RPC 通知
 *
 * 用法：
 *   ki migrate-relation-cache <scope>      # 迁移单个 scope
 *   ki migrate-relation-cache --all        # 迁移全部 scope（KB 层 ∪ config 注册）
 *
 * 选项：
 *   --all               迁移全部 scope
 *   -h, --help          显示帮助
 */

import fs from 'fs';
import { detectUnknownFlags, toErrorPayload } from './lib/cli-args.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { listAllScopes, validateScope, getRelationsCachePath } from './lib/scope.js';
import { hasShardedLayout, migrateLegacyRelationsCache, listGroupPaths, readGroupCache } from './lib/group-cache.js';
import { withScopeWriteLock } from './lib/scope-write-lock.js';

const MIGRATE_HELP = `ki migrate-relation-cache - 显式迁移 relations 元数据到 per-Group 分片布局

用法：
  ki migrate-relation-cache <scope>      # 迁移单个 scope
  ki migrate-relation-cache --all        # 迁移全部 scope（KB 层 ∪ config 注册）

说明：
  旧布局为单文件 <scope>/relations-cache.json；新布局为
  <scope>/.relations/<groupPath>/cache.json + scope 级 manifest.json。
  写路径本身已带惰性迁移（首次写自动转换）；本命令用于显式批量触发。

  幂等：已迁移的 scope 直接跳过（alreadySharded:true）。
  旧文件改名 relations-cache.json.bak 保留（不自动删除）。
  回退：停机后（daemon 不在写入）手动把 .bak 改回原名，再删除 <scope>/.relations/ 目录。
        注意回滚会丢弃迁移之后的全部写入，且顺序不能颠倒——先改名后删除，
        否则「旧文件缺失 + 分片被删」会被判定为从未初始化。

选项：
  --all               迁移全部 scope
  -h, --help          显示帮助`;

interface ScopeMigrateResult {
  scope: string;
  ok: boolean;
  migrated: boolean;
  alreadySharded?: boolean;
  noData?: boolean;
  groups?: number;
  relations?: number;
  legacyBackup?: string;
  error?: string;
}

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

/** 迁移前统计旧文件规模（供守恒核对）；旧文件缺失/损坏返回 null。 */
function legacyStats(scope: string): { groups: number; relations: number } | null {
  try {
    const raw = fs.readFileSync(getRelationsCachePath(scope), 'utf-8');
    const data = JSON.parse(raw) as { groups?: Record<string, { hot_relations?: unknown[] }> };
    const groups = Object.keys(data.groups ?? {}).length;
    let relations = 0;
    for (const g of Object.values(data.groups ?? {})) {
      relations += g?.hot_relations?.length ?? 0;
    }
    return { groups, relations };
  } catch {
    return null;
  }
}

async function migrateOne(scope: string): Promise<ScopeMigrateResult> {
  const legacyPath = getRelationsCachePath(scope);
  const legacyExists = fs.existsSync(legacyPath);
  if (hasShardedLayout(scope)) {
    // 已迁移：no-op（注意：新布局下旧文件理论上已改名 .bak；若两侧同时存在
    // 说明上次改名失败，登记提示但绝不重复迁移覆盖分片）
    const backup = fs.existsSync(`${legacyPath}.bak`);
    const result: ScopeMigrateResult = { scope, ok: true, migrated: false, alreadySharded: true };
    if (legacyExists) result.legacyBackup = '(旧文件仍在原位，未改名；上次迁移改名失败，可手动改名)';
    else if (backup) result.legacyBackup = `${legacyPath}.bak`;
    return result;
  }
  if (!legacyExists) {
    return { scope, ok: true, migrated: false, noData: true };
  }
  const stats = legacyStats(scope);
  try {
    await withScopeWriteLock(scope, 'migrate-relation-cache', async () => {
      // 锁内复检（等锁期间可能已被惰性迁移）
      if (hasShardedLayout(scope)) return;
      migrateLegacyRelationsCache(scope);
    });
  } catch (err) {
    return { scope, ok: false, migrated: false, error: (err as Error).message };
  }
  if (hasShardedLayout(scope)) {
    // 迁移后按新布局实际分片重新统计（守恒核对以落盘结果为准；旧文件缺失时也不再
    // 用 revision 冒充组数——审查 P2）
    const groupPaths = listGroupPaths(scope);
    let actualRelations = 0;
    for (const groupPath of groupPaths) {
      actualRelations += readGroupCache(scope, groupPath)?.hot_relations.length ?? 0;
    }
    return {
      scope,
      ok: true,
      migrated: true,
      groups: groupPaths.length,
      relations: actualRelations,
      legacyBackup: fs.existsSync(`${legacyPath}.bak`) ? `${legacyPath}.bak` : undefined,
      ...(stats && (stats.groups !== groupPaths.length || stats.relations !== actualRelations)
        ? { beforeMigrate: stats } : {}),
    };
  }
  return { scope, ok: false, migrated: false, error: '迁移后仍未检测到新布局 manifest（请检查磁盘）' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    console.log(MIGRATE_HELP);
    return;
  }

  detectUnknownFlags(args.filter((a) => a.startsWith('-')), ['--all'], [], MIGRATE_HELP);

  const all = args.includes('--all');
  const scopeArg = args.find((a) => !a.startsWith('-'));
  if (all && scopeArg) {
    output({ ok: false, error: '--all 与 <scope> 互斥', code: 'ARGS_CONFLICT', help: MIGRATE_HELP });
    process.exitCode = 1;
    return;
  }
  if (!all && !scopeArg) {
    output({ ok: false, error: '缺少 <scope> 参数（或使用 --all）', code: 'MISSING_SCOPE', help: MIGRATE_HELP });
    process.exitCode = 1;
    return;
  }

  try {
    const config = loadConfig();
    if (!all) {
      const scope = resolveScope(config, scopeArg!);
      validateScope(scope);
      const result = await migrateOne(scope);
      output({ action: 'migrate-relation-cache', ...result });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    // --all：KB 层 ∪ config 注册（并集，去重排序）
    const scopes = [...new Set([...listAllScopes(), ...Object.keys(config.scopes)])].sort();
    const results: ScopeMigrateResult[] = [];
    for (const scope of scopes) {
      try {
        validateScope(scope);
        results.push(await migrateOne(scope));
      } catch (err) {
        results.push({ scope, ok: false, migrated: false, error: (err as Error).message });
      }
    }
    const summary = {
      total: results.length,
      migrated: results.filter((r) => r.migrated).length,
      alreadySharded: results.filter((r) => r.alreadySharded).length,
      noData: results.filter((r) => r.noData).length,
      failed: results.filter((r) => !r.ok).length,
    };
    output({ ok: summary.failed === 0, action: 'migrate-relation-cache', summary, scopes: results });
    if (summary.failed > 0) process.exitCode = 1;
  } catch (err) {
    output(toErrorPayload(err));
    process.exitCode = 1;
  }
}

void main();
