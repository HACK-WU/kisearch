/**
 * group-create.ts — 创建单个 Group 节点（REQ-20261019-005 / S-02）
 *
 * 语义：
 * - 入参只有 { scope?, path }，不提供 parent/name/parents；
 * - 只建单个节点，父路径必须已存在；禁用 resolveGroupPath 语义补全；
 * - scope 不存在时自动创建并返回 createdScope（agents-md-init 依赖）。
 */

import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { getGroupIndexPath, validateScope } from './scope.js';
import { ensureScopeDir } from './store.js';
import { loadConfig, resolveScope } from './config.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { assertNoPendingVectorMigration } from './vector-client.js';
import { callDaemon, shouldUseDaemonClient } from './daemon-client.js';
import { normalizeGroupPath } from './group-delete.js';

export interface GroupCreateOptions {
  scope?: string;
  path: string;
}

export type GroupCreateResult =
  | { ok: true; scope: string; path: string; createdScope?: true }
  | { ok: false; error: string; candidates?: string[]; code?: 'SCOPE_OPERATION_BUSY' };

type TreeNode = Record<string, TreeNode>;

function findNode(groups: TreeNode, p: string): TreeNode | null {
  const segs = p.split('/').filter(Boolean);
  let cur: TreeNode | undefined = groups;
  for (const seg of segs) {
    if (!cur || typeof cur[seg] !== 'object' || cur[seg] === null) return null;
    cur = cur[seg] as TreeNode;
  }
  return cur ?? null;
}

function listChildren(groups: TreeNode, p: string): string[] {
  const node = p ? findNode(groups, p) : groups;
  return node ? Object.keys(node) : [];
}

export async function executeGroupCreate(opts: GroupCreateOptions): Promise<GroupCreateResult> {
  if (shouldUseDaemonClient()) {
    return callDaemon<GroupCreateResult>('group-create', opts);
  }
  let scope = opts.scope ?? '';
  try {
    scope = resolveScope(loadConfig(), opts.scope);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    return await withScopeWriteLock(scope, 'group-create', () => createLocal(scope, opts.path));
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      error: message,
      ...(message.includes('正在写入') ? { code: 'SCOPE_OPERATION_BUSY' as const } : {}),
    };
  }
}

function createLocal(scope: string, rawPath: string): GroupCreateResult {
  validateScope(scope);
  assertNoPendingVectorMigration(scope);

  let canonical: string;
  try {
    canonical = normalizeGroupPath(rawPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const segs = canonical.split('/');
  const name = segs[segs.length - 1];
  const parentPath = segs.slice(0, -1).join('/');

  const scopeExisted = fs.existsSync(getGroupIndexPath(scope));
  ensureScopeDir(scope);
  const createdScope = scopeExisted ? {} : { createdScope: true as const };

  const indexPath = getGroupIndexPath(scope);
  const data = readJson<{ groups: TreeNode }>(indexPath);
  if (!data) return { ok: false, error: 'group-index.json 不存在' };

  const parent = findNode(data.groups, parentPath);
  if (!parent) {
    const candidates = parentPath
      ? listChildren(data.groups, segs.slice(0, -2).join('/'))
      : Object.keys(data.groups);
    return {
      ok: false,
      error: `父路径不存在：${parentPath || '(顶层)'}；create 只建单个节点，请先创建父组`,
      candidates: candidates.slice(0, 5),
    };
  }
  if (parent[name] !== undefined) {
    return { ok: false, error: `节点 "${name}" 已存在于 "${parentPath || '(顶层)'}" 下` };
  }

  parent[name] = {};
  writeJson(indexPath, data as unknown as Record<string, unknown>);
  return { ok: true, scope, path: canonical, ...createdScope };
}
