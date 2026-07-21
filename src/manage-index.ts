#!/usr/bin/env node
/**
 * manage-index.ts - Group 树索引管理 CLI
 * 
 * 用法:
 *   npx jiti scripts/manage-index.ts --scope <scope> --action create --name <name> [--parent <path>]
 *   npx jiti scripts/manage-index.ts --scope <scope> --action delete --name <name> [--parent <path>] [--force]
 *   npx jiti scripts/manage-index.ts --action list-scopes
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { writeJson, readJson, readGroupIndex } from './lib/store.js';
import { getGroupIndexPath, getRelationsCachePath, getLocalKbDir, validateScope, listAllScopes } from './lib/scope.js';
import type { GroupIndex } from './lib/scope.js';
import { resolveGroupPath, getDirectChildren } from './lib/group-resolve.js';
import { vectorDelete, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';

// ─── 辅助函数 ───

/**
 * 在树中按路径查找容器节点：
 * - parentPath 为空字符串时，返回 groups（顶层容器）
 * - parentPath 为 "a/b" 时，返回 b 节点对象
 *
 * @returns [父容器对象, 路径段数组] 或 null（路径不存在）
 */
function findContainer(
  groups: Record<string, Record<string, unknown>>,
  parentPath: string
): [Record<string, unknown>, string[]] | null {
  const segments = parentPath.split('/').filter(Boolean);

  // 空路径：返回 groups 作为容器（用于操作顶层节点）
  if (segments.length === 0) {
    return [groups as Record<string, unknown>, []];
  }

  // 逐级遍历
  let current: Record<string, unknown> | undefined = groups[segments[0]];
  if (current === undefined) return null;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      return null;
    }
    current = current[seg] as Record<string, unknown>;
  }

  return [current, segments];
}

/**
 * 检查节点是否为空（无子节点）
 */
function isEmptyNode(node: Record<string, unknown>): boolean {
  return Object.keys(node).length === 0;
}

/**
 * 输出 JSON 结果并退出
 */
function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── MCP / CLI 共享纯函数 ───

export interface ManageCreateParams {
  scope: string;
  name: string;
  parent?: string;
}

export type ManageCreateResult =
  | { ok: true; path: string; hint?: string }
  | { ok: false; error: string };

export async function executeManageCreate(params: ManageCreateParams): Promise<ManageCreateResult> {
  try {
    const { scope, name, parent } = params;

    if (!scope) return { ok: false, error: '此操作需要 scope 参数' };
    validateScope(scope);

    const data = readGroupIndex(scope);
    if (!data) return { ok: false, error: 'group-index.json 不存在' };

    const indexPath = getGroupIndexPath(scope);
    const cachePath = getRelationsCachePath(scope);
    const groupsData = readJson<Record<string, unknown>>(cachePath)?.groups as Record<string, unknown> || {};

    if (!name) return { ok: false, error: 'create 需要 name 参数' };
    if (name.includes('/')) return { ok: false, error: `节点名 "${name}" 不能包含 "/"` };

    const parentPath = (parent || '').replace(/^\/+|\/+$/g, '');
    const result = findContainer(data.groups, parentPath);

    if (!result) {
      const resolved = await resolveGroupPath(parentPath, data, groupsData);
      if (resolved.matched) {
        const resolvedParent = resolved.resolvedPath;
        const resolvedResult = findContainer(data.groups, resolvedParent);
        if (resolvedResult) {
          const [parentNode] = resolvedResult;
          if (parentNode[name] !== undefined) {
            return { ok: false, error: `节点 "${name}" 已存在于 "${resolvedParent}" 下` };
          }
          parentNode[name] = {};
          writeJson(indexPath, data as unknown as Record<string, unknown>);
          return { ok: true, path: `${resolvedParent}/${name}`, ...(resolved.hint ? { hint: resolved.hint } : {}) };
        }
      }
      const hintParts: string[] = [`父节点路径不存在：${parentPath || '(顶层)'}`];
      if (resolved.hint) hintParts.push(resolved.hint);
      const topChildren = Object.keys(data.groups);
      if (topChildren.length > 0 && !parentPath) {
        hintParts.push(`可用的顶层节点：${topChildren.join(', ')}`);
      }
      return { ok: false, error: hintParts.join('\n') };
    }

    const [parentNode] = result;
    if (parentNode[name] !== undefined) {
      return { ok: false, error: `节点 "${name}" 已存在于 "${parentPath || '(顶层)'}" 下` };
    }

    parentNode[name] = {};
    writeJson(indexPath, data as unknown as Record<string, unknown>);
    return { ok: true, path: parentPath ? `${parentPath}/${name}` : name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type ListScopesResult = {
  ok: true;
  scopes: Array<{ scope: string; topGroups: string[] }>;
  total: number;
};

export function executeListScopes(): ListScopesResult {
  const scopes = listAllScopes();
  const scopeDetails = scopes.map((s) => {
    let topGroups: string[] = [];
    try {
      const data = readGroupIndex(s);
      if (data?.groups) topGroups = Object.keys(data.groups);
    } catch { /* 读取失败则返回空列表 */ }
    return { scope: s, topGroups };
  });
  return { ok: true, scopes: scopeDetails, total: scopes.length };
}

// ─── 级联清理：删除 Group 时同步清理 relations-cache + local-kb + 向量 ───

interface CascadeDeleteResult {
  cacheGroupsRemoved: string[];
  localKbFilesRemoved: string[];
  memDeleted: number;
  memSkipped: number;
  errors: string[];
}

/**
 * 级联删除指定 Group 路径下的所有关联数据（不含 wiki 文件）。
 *
 * 清理范围：
 *   1. relations-cache.json 中所有以 groupPath 为前缀的 key（含子 Group）
 *   2. local-kb 的 index.json 文件
 *   3. 向量记忆（收集所有 memoryId 一次批量 vectorDelete，无 memoryId 的条目计入 memSkipped）
 *
 * 不清理 wiki 文件（用户明确要求保留）。
 */
async function cascadeDeleteGroupData(scope: string, groupPath: string): Promise<CascadeDeleteResult> {
  const result: CascadeDeleteResult = {
    cacheGroupsRemoved: [],
    localKbFilesRemoved: [],
    memDeleted: 0,
    memSkipped: 0,
    errors: [],
  };

  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<{
    version: number;
    scope: string;
    groups: Record<string, {
      hot_relations: Array<{ text: string; memoryId?: string }>;
      keywords: string[];
      max_hot_count: number;
    }>;
  }>(cachePath);

  if (!cache || !cache.groups) {
    return result;
  }

  // 前缀匹配：groupPath 本身 + 所有子 Group（如 "工具库" 匹配 "工具库/Redis"、"工具库/加密与哈希" 等）
  const prefix = groupPath + '/';
  const keysToDelete: string[] = [];
  for (const key of Object.keys(cache.groups)) {
    if (key === groupPath || key.startsWith(prefix)) {
      keysToDelete.push(key);
    }
  }

  // 收集所有 memoryId，一次批量 vectorDelete；无 memoryId 的条目计入 memSkipped
  const idsToDelete: string[] = [];
  for (const key of keysToDelete) {
    const groupData = cache.groups[key];
    if (!groupData?.hot_relations) continue;
    for (const rel of groupData.hot_relations) {
      if (rel.memoryId) {
        idsToDelete.push(rel.memoryId);
      } else {
        result.memSkipped++;
      }
    }
  }

  if (idsToDelete.length > 0) {
    const avail = await ensureVectorAvailable();
    if (avail.available) {
      try {
        const delResult = await vectorDelete({ scope, ids: idsToDelete });
        result.memDeleted = delResult.deleted;
        for (const e of delResult.errors) {
          result.errors.push(`vectorDelete ${e.id} 失败: ${e.reason}`);
        }
      } catch (err) {
        result.errors.push(`vectorDelete 批量失败: ${(err as Error).message}`);
        result.memSkipped += idsToDelete.length;
      }
    } else {
      result.errors.push(`向量服务不可用，跳过向量删除: ${avail.reason || ''}`);
      result.memSkipped += idsToDelete.length;
    }
  }

  // 删除 local-kb 的 index.json 文件
  for (const key of keysToDelete) {
    const localKbPath = getLocalKbDir(scope, key);
    try {
      if (fs.existsSync(localKbPath)) {
        fs.unlinkSync(localKbPath);
        result.localKbFilesRemoved.push(key);
      }
    } catch (err) {
      result.errors.push(`local-kb 删除失败 ${key}: ${(err as Error).message}`);
    }
  }

  // 从 relations-cache 中删除所有匹配的 group key
  for (const key of keysToDelete) {
    delete cache.groups[key];
    result.cacheGroupsRemoved.push(key);
  }

  // 持久化 cache
  if (keysToDelete.length > 0) {
    writeJson(cachePath, cache as unknown as Record<string, unknown>);
  }

  return result;
}

// ─── CLI 定义 ───

const program = new Command();

program
  .name('manage-index')
  .description('Group 树索引管理（支持 scope 列表查询）')
  .option('--scope <scope>', '项目隔离标识（list-scopes 时可省略）')
  .option('--action <action>', '操作：create | delete | list-scopes', 'create')
  .option('--parent <parent>', '父节点路径（为空时在顶层操作）')
  .option('--name <name>', '节点名称')
  .option('--force', '强制删除非空节点', false)
  .action(async (opts) => {
    try {
      const { scope, action, parent, name, force } = opts;

      // ─── list-scopes：不需要 scope ───
      if (action === 'list-scopes') {
        const scopes = listAllScopes();
        const scopeDetails = scopes.map((s) => {
          let topGroups: string[] = [];
          try {
            const data = readGroupIndex(s);
            if (data?.groups) {
              topGroups = Object.keys(data.groups);
            }
          } catch (err) {
            console.warn(`警告：scope "${s}" 的 group-index.json 读取失败: ${(err as Error).message}`);
          }
          return { scope: s, topGroups };
        });
        output({ ok: true, scopes: scopeDetails, total: scopes.length });
        return;
      }

      // 其他 action 需要 scope
      if (!scope) {
        output({ ok: false, error: '此操作需要 --scope 参数' });
        process.exit(1);
      }

      // 校验 scope
      validateScope(scope);

      const data = readGroupIndex(scope);

      if (!data) {
        output({ ok: false, error: `group-index.json 不存在` });
        process.exit(1);
      }

      const indexPath = getGroupIndexPath(scope);

      // 读取 relations-cache 用于 resolveGroupPath
      const cachePath = getRelationsCachePath(scope);
      const groupsData = readJson<Record<string, unknown>>(cachePath)?.groups as Record<string, unknown> || {};

      switch (action) {
        // ─── 创建节点 ───
        case 'create': {
          if (!name) {
            output({ ok: false, error: 'create 需要 --name 参数' });
            process.exit(1);
          }
          if (typeof name === 'string' && name.includes('/')) {
            output({ ok: false, error: `节点名 "${name}" 不能包含 "/"` });
            process.exit(1);
          }

          // parent 为空或未传 → 在顶层创建
          const parentPath = (parent || '').replace(/^\/+|\/+$/g, '');
          const result = findContainer(data.groups, parentPath);
          if (!result) {
            // 尝试 Group 路径自动补全
            const resolved = await resolveGroupPath(parentPath, data, groupsData);
            if (resolved.matched) {
              const resolvedParent = resolved.resolvedPath;
              const resolvedResult = findContainer(data.groups, resolvedParent);
              if (resolvedResult) {
                if (resolved.hint) console.error(resolved.hint);
                const [parentNode] = resolvedResult;
                if (parentNode[name] !== undefined) {
                  output({ ok: false, error: `节点 "${name}" 已存在于 "${resolvedParent}" 下` });
                  process.exit(1);
                }
                parentNode[name] = {};
                writeJson(indexPath, data as unknown as Record<string, unknown>);
                output({ ok: true, path: `${resolvedParent}/${name}`, hint: resolved.hint || undefined });
                break;
              }
            }
            // 补全也失败 → 给出可用子节点提示
            const hintParts: string[] = [`父节点路径不存在：${parentPath || '(顶层)'}`];
            if (resolved.hint) hintParts.push(resolved.hint);
            const topChildren = Object.keys(data.groups);
            if (topChildren.length > 0 && !parentPath) {
              hintParts.push(`可用的顶层节点：${topChildren.join(', ')}`);
            }
            output({ ok: false, error: hintParts.join('\n') });
            process.exit(1);
          }

          const [parentNode] = result;
          if (parentNode[name] !== undefined) {
            output({ ok: false, error: `节点 "${name}" 已存在于 "${parentPath || '(顶层)'}" 下` });
            process.exit(1);
          }

          parentNode[name] = {};
          writeJson(indexPath, data as unknown as Record<string, unknown>);
          output({ ok: true, path: parentPath ? `${parentPath}/${name}` : name });
          break;
        }

        // ─── 删除节点 ───
        case 'delete': {
          if (!name) {
            output({ ok: false, error: 'delete 需要 --name 参数' });
            process.exit(1);
          }

          // parent 为空或未传 → 从顶层删除
          const parentPath = (parent || '').replace(/^\/+|\/+$/g, '');
          const result = findContainer(data.groups, parentPath);
          if (!result) {
            // 尝试 Group 路径自动补全
            const resolved = await resolveGroupPath(parentPath, data, groupsData);
            if (resolved.matched) {
              const resolvedParent = resolved.resolvedPath;
              const resolvedResult = findContainer(data.groups, resolvedParent);
              if (resolvedResult) {
                if (resolved.hint) console.error(resolved.hint);
                const [parentNode] = resolvedResult;
                if (parentNode[name] === undefined) {
                  const siblings = Object.keys(parentNode);
                  const siblingHint = siblings.length > 0
                    ? `"${resolvedParent}" 下的子节点：${siblings.join(', ')}`
                    : `"${resolvedParent}" 下无子节点`;
                  output({ ok: false, error: `节点 "${name}" 不存在于 "${resolvedParent}" 下`, hint: siblingHint });
                  process.exit(1);
                }
                const targetNode = parentNode[name] as Record<string, unknown>;
                if (!isEmptyNode(targetNode) && !force) {
                  output({
                    ok: false,
                    error: `节点 "${name}" 非空，包含子节点。使用 --force 强制删除`,
                    children: Object.keys(targetNode),
                  });
                  process.exit(1);
                }
                delete parentNode[name];
                writeJson(indexPath, data as unknown as Record<string, unknown>);
                const deletedPath = `${resolvedParent}/${name}`;
                const cascade = await cascadeDeleteGroupData(scope, deletedPath);
                output({
                  ok: true,
                  path: deletedPath,
                  hint: resolved.hint || undefined,
                  cascade: {
                    cacheGroupsRemoved: cascade.cacheGroupsRemoved.length,
                    localKbFilesRemoved: cascade.localKbFilesRemoved.length,
                    memDeleted: cascade.memDeleted,
                    memSkipped: cascade.memSkipped,
                    errors: cascade.errors.length > 0 ? cascade.errors : undefined,
                  },
                });
                break;
              }
            }
            // 补全也失败 → 给出可用子节点提示
            const hintParts: string[] = [`父节点路径不存在：${parentPath || '(顶层)'}`];
            if (resolved.hint) hintParts.push(resolved.hint);
            const topChildren = Object.keys(data.groups);
            if (topChildren.length > 0 && !parentPath) {
              hintParts.push(`可用的顶层节点：${topChildren.join(', ')}`);
            }
            output({ ok: false, error: hintParts.join('\n') });
            process.exit(1);
          }

          const [parentNode] = result;
          if (parentNode[name] === undefined) {
            const siblings = Object.keys(parentNode);
            const siblingHint = siblings.length > 0
              ? `"${parentPath || '(顶层)'}" 下的子节点：${siblings.join(', ')}`
              : `"${parentPath || '(顶层)'}" 下无子节点`;
            output({ ok: false, error: `节点 "${name}" 不存在于 "${parentPath || '(顶层)'}" 下`, hint: siblingHint });
            process.exit(1);
          }

          const targetNode = parentNode[name] as Record<string, unknown>;

          // 非空节点需要 --force
          if (!isEmptyNode(targetNode) && !force) {
            output({
              ok: false,
              error: `节点 "${name}" 非空，包含子节点。使用 --force 强制删除`,
              children: Object.keys(targetNode),
            });
            process.exit(1);
          }

          delete parentNode[name];
          writeJson(indexPath, data as unknown as Record<string, unknown>);
          const deletedPath = parentPath ? `${parentPath}/${name}` : name;
          const cascade = await cascadeDeleteGroupData(scope, deletedPath);
          output({
            ok: true,
            path: deletedPath,
            cascade: {
              cacheGroupsRemoved: cascade.cacheGroupsRemoved.length,
              localKbFilesRemoved: cascade.localKbFilesRemoved.length,
              memDeleted: cascade.memDeleted,
              memSkipped: cascade.memSkipped,
              errors: cascade.errors.length > 0 ? cascade.errors : undefined,
            },
          });
          break;
        }

        default: {
          const validActions = ['create', 'delete', 'list-scopes'];
          output({
            ok: false,
            error: `未知操作：${action}`,
            hint: `可用操作：${validActions.join(' | ')}`,
          });
          process.exit(1);
        }
      }
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      await closeEngine();
      process.exit(1);
    } finally {
      await closeEngine();
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
