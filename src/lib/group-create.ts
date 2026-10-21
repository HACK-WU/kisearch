/**
 * group-create.ts — 创建单个 Group 节点（REQ-20261019-005 / S-02）
 *
 * 语义：
 * - 入参只有 { scope?, path }，不提供 parent/name/parents；
 * - 只建单个节点，父路径必须已存在；禁用 resolveGroupPath 语义补全；
 * - scope 不存在时自动创建并返回 createdScope（agents-md-init 依赖）。
 */

import fs from 'node:fs';
import { writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { getGroupIndexPath, validateScope } from './scope.js';
import { loadConfig, resolveScope } from './config.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { assertNoPendingVectorMigration } from './vector-client.js';
import { callDaemon, shouldUseDaemonClient } from './daemon-client.js';
import { normalizeGroupPath } from './group-delete.js';
import { ensureWikiGroupDir } from './wiki-sync.js';

export interface GroupCreateOptions {
  scope?: string;
  path: string;
}

export type GroupCreateResult =
  | {
    ok: true;
    scope: string;
    path: string;
    createdScope?: true;
    /** wikiSync 已开启时，在 sourceDir 下同步创建的目录 */
    wikiDir?: string;
    /** wiki 目录创建失败（不阻断 group create） */
    wikiWarning?: string;
  }
  | { ok: false; error: string; candidates?: string[]; code?: 'SCOPE_OPERATION_BUSY' };

// 不能用 `Record<string, TreeNode>`：Record 是映射类型，自引用会被 TS 判为循环引用（TS2456）
type TreeNode = { [name: string]: TreeNode };

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
    return await withScopeWriteLock(scope, 'group-create', async () => createLocal(scope, opts.path));
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      error: message,
      // 按结构化 code 判定，不依赖中文文案（文案一改就会静默失效）
      ...((err as { code?: string }).code === 'SCOPE_OPERATION_BUSY'
        ? { code: 'SCOPE_OPERATION_BUSY' as const }
        : {}),
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
  // 用 readGroupIndex 而非 readJson：它会在写锁内完成 legacy `roots` → `groups` 迁移。
  // 直接用 readJson 时老 scope 上 data.groups 为 undefined，Object.keys(undefined)
  // 会抛裸 TypeError（"Cannot convert undefined or null to object"）。
  const data = readGroupIndex(scope);
  if (!data) return { ok: false, error: 'group-index.json 不存在' };
  const groups = (data.groups ?? {}) as TreeNode;

  const parent = findNode(groups, parentPath);
  if (!parent) {
    const candidates = parentPath
      ? listChildren(groups, segs.slice(0, -2).join('/'))
      : Object.keys(groups);
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
  // wiki 目录与 group 树同生命周期入口：开启 wikiSync 时建同名目录；
  // 写失败只告警，不回滚已创建的 group（目录属外部 wiki，失败可能只是权限问题）
  const wiki = ensureWikiGroupDir(scope, canonical);
  return {
    ok: true,
    scope,
    path: canonical,
    ...createdScope,
    ...(wiki?.ok ? { wikiDir: wiki.dir } : {}),
    ...(wiki && !wiki.ok ? { wikiWarning: wiki.reason } : {}),
  };
}
