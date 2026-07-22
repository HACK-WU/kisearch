#!/usr/bin/env node
/**
 * scope.ts - ki scope CLI（src 版）
 *
 * scope 生命周期管理（统一作用于 KB 目录层 + 向量语义层）。
 *
 * 用法:
 *   ki scope list
 *   ki scope delete <name> --yes          # default 不可删除
 *   ki scope clear  <name> [--tags t1,t2] --yes
 *
 * 说明:
 *   - list：列出两层（KB / 向量）并集，标注每个 scope 存在于哪层
 *   - delete：清向量文档 + 删 KB 目录 + 移除 config.scopes 条目（尽力而为）
 *   - clear：清向量文档 + 清 KB 目录内容（保留目录与配置）；带 --tags 时仅清向量层对应 tag，不动 KB
 *   - delete/clear 为破坏性操作，需向量服务可用且强制 --yes
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { listAllScopes, getKbDir, validateScope } from './lib/scope.js';
import { loadConfig, removeScopeFromConfigFile } from './lib/config.js';
import {
  vectorListScopes,
  vectorCountScope,
  vectorDeleteScope,
  ensureVectorAvailable,
  closeEngine,
} from './lib/vector-client.js';

// ─── KB 目录辅助 ───

function kbDirExists(scope: string): boolean {
  return fs.existsSync(getKbDir(scope));
}

/** 删除整个 KB 目录（scope delete 用） */
function removeKbDir(scope: string): boolean {
  const dir = getKbDir(scope);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 清空 KB 目录内容但保留目录本身（scope clear 用） */
function clearKbDir(scope: string): boolean {
  const dir = getKbDir(scope);
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return true;
}

// ─── 纯函数：scope list ───

export interface ScopeEntry {
  scope: string;
  kb: boolean;         // 存在于 KB 目录层
  vector: boolean;     // 存在于向量语义层
  registered: boolean; // 在 config.scopes 中注册
}

export type ScopeListResult = {
  ok: true;
  scopeMode: 'default' | 'strict';
  vectorAvailable: boolean;
  vectorReason?: string;
  count: number;
  scopes: ScopeEntry[];
};

export async function executeScopeList(): Promise<ScopeListResult> {
  const config = loadConfig();
  const kbScopes = new Set(listAllScopes());

  let vectorScopes = new Set<string>();
  let vectorAvailable = true;
  let vectorReason: string | undefined;

  const avail = await ensureVectorAvailable();
  if (avail.available) {
    try {
      vectorScopes = new Set(await vectorListScopes());
    } catch (err) {
      vectorAvailable = false;
      vectorReason = (err as Error).message;
    }
  } else {
    vectorAvailable = false;
    vectorReason = avail.reason;
  }

  const all = new Set<string>([...kbScopes, ...vectorScopes, ...Object.keys(config.scopes)]);
  const scopes: ScopeEntry[] = [...all].sort().map((s) => ({
    scope: s,
    kb: kbScopes.has(s),
    vector: vectorScopes.has(s),
    registered: Object.prototype.hasOwnProperty.call(config.scopes, s),
  }));

  return {
    ok: true,
    scopeMode: config.scopeMode,
    vectorAvailable,
    vectorReason,
    count: scopes.length,
    scopes,
  };
}

// ─── 纯函数：scope delete ───

export type ScopeDeleteResult =
  | { ok: true; scope: string; deletedVectors: number; kbRemoved: boolean; configRemoved: boolean }
  | {
      ok: false;
      error: string;
      requireConfirm?: boolean;
      willDelete?: { vectorCount: number; kbExists: boolean; registered: boolean };
    };

export async function executeScopeDelete(params: { scope: string; yes: boolean }): Promise<ScopeDeleteResult> {
  try {
    validateScope(params.scope);
    if (params.scope === 'default') {
      return { ok: false, error: 'default scope 不可删除' };
    }

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}），拒绝删除以免两层不一致` };
    }

    const config = loadConfig();
    const vectorCount = await vectorCountScope({ scope: params.scope });
    const kbExists = kbDirExists(params.scope);
    const registered = Object.prototype.hasOwnProperty.call(config.scopes, params.scope);

    if (!params.yes) {
      return {
        ok: false,
        error: `破坏性操作需 --yes 确认：将删除向量 ${vectorCount} 条${kbExists ? ' + KB 目录' : ''}${registered ? ' + 配置条目' : ''}`,
        requireConfirm: true,
        willDelete: { vectorCount, kbExists, registered },
      };
    }

    const deletedVectors = (await vectorDeleteScope({ scope: params.scope })).deleted;
    const kbRemoved = removeKbDir(params.scope);
    const configResult = removeScopeFromConfigFile(params.scope);

    return { ok: true, scope: params.scope, deletedVectors, kbRemoved, configRemoved: configResult.removed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── 纯函数：scope clear ───

export type ScopeClearResult =
  | { ok: true; scope: string; tags: string[] | 'all'; deletedVectors: number; kbCleared: boolean }
  | {
      ok: false;
      error: string;
      requireConfirm?: boolean;
      willDelete?: { vectorCount: number; kbWillClear: boolean };
    };

export async function executeScopeClear(params: { scope: string; tags?: string[]; yes: boolean }): Promise<ScopeClearResult> {
  try {
    validateScope(params.scope);

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}），拒绝清理以免两层不一致` };
    }

    const vectorCount = await vectorCountScope({ scope: params.scope, tags: params.tags });
    // KB 目录仅在未按 tag 过滤时清理（tag 是向量层概念，KB 层无 tag）
    const kbWillClear = !params.tags && kbDirExists(params.scope);

    if (!params.yes) {
      return {
        ok: false,
        error: `破坏性操作需 --yes 确认：将清除向量 ${vectorCount} 条${kbWillClear ? ' + KB 目录内容' : ''}`,
        requireConfirm: true,
        willDelete: { vectorCount, kbWillClear },
      };
    }

    const deletedVectors = (await vectorDeleteScope({ scope: params.scope, tags: params.tags })).deleted;
    const kbCleared = !params.tags ? clearKbDir(params.scope) : false;

    return { ok: true, scope: params.scope, tags: params.tags ?? 'all', deletedVectors, kbCleared };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── 辅助 ───

function parseTags(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const arr = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  return arr.length > 0 ? arr : undefined;
}

// ─── CLI ───

const program = new Command();
program.name('scope').description('scope 生命周期管理（KB 目录层 + 向量语义层）');

program
  .command('list')
  .description('列出所有 scope（两层并集，标注所在层）')
  .action(async () => {
    const result = await executeScopeList();
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
  });

program
  .command('delete')
  .description('彻底删除 scope（向量 + KB 目录 + 配置条目）；default 不可删除')
  .argument('<name>', 'scope 名称')
  .option('--yes', '确认执行（缺省则仅预览并拒绝）', false)
  .action(async (name: string, opts) => {
    const result = await executeScopeDelete({ scope: name, yes: !!opts.yes });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

program
  .command('clear')
  .description('清空 scope 内容（保留 scope 与配置）；带 --tags 时仅清向量层对应 tag')
  .argument('<name>', 'scope 名称')
  .option('--tags <tags>', '仅清指定标签，逗号分隔多值（省略则清全部并清 KB 目录内容）')
  .option('--yes', '确认执行（缺省则仅预览并拒绝）', false)
  .action(async (name: string, opts) => {
    const result = await executeScopeClear({ scope: name, tags: parseTags(opts.tags), yes: !!opts.yes });
    console.log(JSON.stringify(result, null, 2));
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
