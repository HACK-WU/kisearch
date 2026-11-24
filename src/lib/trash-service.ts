/**
 * 回收站 · 业务层（REQ-20261113-004 · S-04）
 *
 * 三件事：入站（moveToTrash）、恢复（restoreFromTrash）、到期清理（purgeExpired）。
 *
 * 事务边界：
 *   - `moveToTrash` 必须**在任何删除动作之前**成功；调用方（删除链路）用它当"可逆性闸门"；
 *   - `restoreFromTrash` 写 KB 与分片是同一步的两次落盘，先 KB 后分片（KB 写失败时
 *     trash 原样保留，可重试；分片写失败时 KB 已回，靠重试收敛）；
 *   - 索引重建**不在本层**：B2 只把文档恢复成"元数据 + 原文"在位，索引重建交给
 *     `visibility-index` 的 pending 队列（B4），返回 `rebuild: 'pending'` 让 UI 说清"数秒后可见"。
 *
 * 期限重算（S-04 §3.4，容易写错的一处）：
 *   原 `expiresAt` 已过（自动过期进站）→ `now + ttlDays`（**用期限长度，不是原绝对值**）；
 *   原 `expiresAt` 未过（手动删除）        → 原值不变；
 *   恢复时改 wiki                          → 清空三字段。
 *   `ttlDays` 只能取快照里的 `relationSnapshot.ttlDays` —— 用 `expiresAt - now` 反推在过期场景恒 ≤ 0。
 */

import fs from 'fs';
import path from 'path';
import {
  getAssetsDir,
  getLocalKbDir,
  getKbDir,
  getGroupIndexPath,
  ensureGroupPathInTree,
} from './scope.js';
import { readJson, writeJson, readGroupIndex } from './store.js';
import { loadGroupCache, writeGroupCache, type GroupCacheDoc } from './group-cache.js';
import { FALLBACK_TTL_DAYS, type LifecycleKind } from './lifecycle.js';
import {
  writeTrashItem,
  writeGroupTrashItem,
  readTrashItem,
  removeTrashItem,
  updateTrashItemMeta,
  findExpiredTrash,
  readTrashSettings,
  getTrashRoot,
  readGroupSnapshotDocs,
  readGroupSnapshotAssets,
  type TrashItem,
  type TrashReason,
  type TrashKind,
  type GroupSnapshotDoc,
  type GroupSnapshotDocEntry,
  type GroupTrashDocInput,
} from './trash-store.js';
import { getGovernancePath } from './governance-store.js';
import { readAllEvents } from './events/store.js';
import type { Relation } from './scoring.js';

const DAY_MS = 86_400_000;

export interface MoveToTrashArgs {
  scope: string;
  group: string;
  relation: string;
  reason: TrashReason;
  now?: number;
  /** 删除瞬间的关系快照（缺省 = 只留原文，元数据不可恢复） */
  relationSnapshot?: Relation;
}

export type MoveToTrashOutcome =
  | { ok: true; item: TrashItem }
  | { ok: false; code: 'TRASH_WRITE_FAILED' | 'TRASH_CONTENT_MISSING'; error: string };

/**
 * 把文档快照写进回收站。
 *
 * 调用方必须已持 scope 写锁。失败必须中止删除 —— 「删了但没备份」窗口比删除本身更严重。
 */
export function moveToTrash(args: MoveToTrashArgs): MoveToTrashOutcome {
  const now = args.now ?? Date.now();
  try {
    const content = readKbRelationContent(args.scope, args.group, args.relation);
    /**
     * 正文为空 → **拒绝进站**（fail-closed）。
     *
     * 空快照不是"可逆快照"：调用方据此继续删除，文档就只剩一个 0 字节条目，
     * 恢复只会写回空串（challenger C1 的存量坏条目正是这么产生的）。
     * 与本文档头「必须保证可恢复才允许删除」的事务边界一致。
     */
    if (!content.trim()) {
      return {
        ok: false,
        code: 'TRASH_CONTENT_MISSING',
        error: `读不到「${args.group}/${args.relation}」的正文，进站会得到空文档，已中止删除（未删除任何数据）`,
      };
    }
    const settings = readTrashSettings(args.scope);
    const item = writeTrashItem({
      scope: args.scope,
      group: args.group,
      relation: args.relation,
      reason: args.reason,
      now,
      content,
      assetsDir: getAssetsDir(args.scope, args.group),
      relationSnapshot: args.relationSnapshot,
      keepDays: settings.keepDays,
      restoreCount: args.relationSnapshot?.restoreCount ?? 0,
    });
    return { ok: true, item };
  } catch (err) {
    return { ok: false, code: 'TRASH_WRITE_FAILED', error: (err as Error).message };
  }
}

/**
 * 读 local KB 里某文档的原文（结构：`{ [relation]: string | { moduleInfo | content } }`）。
 *
 * 导出消费方：`delete-relation`（删前重算内容向量 docId）与 `visibility-index`
 * （摘除补救）。两处都必须在「KB 已被删除」之前调用 —— 正文是 docId 的唯一可重算来源。
 * 缺省返回空串表示「KB 中没有该条」，调用方据此决定是否放弃重算。
 */
export function readKbRelationContent(scope: string, group: string, relation: string): string {
  // getLocalKbDir 返回的就是 index.json 文件路径，不能再 join 一次（否则变成 index.json/index.json）
  const kbPath = getLocalKbDir(scope, group);
  const kb = readJson<Record<string, unknown>>(kbPath);
  if (!kb) return '';
  return extractKbBodyValue(kb[relation]);
}

/**
 * KB `index.json` 顶层的元字段（`writeJson` 自动注入 `version` / `updatedAt`），不是文档。
 *
 * 判定**同时看键名与值形状**，不能只按键名：用户完全可能有一篇叫 `version` 或
 * `updatedAt` 的文档，只按名排除会把它从组快照里漏掉 —— 而组删除会 `rmSync` 掉它，
 * 那就是静默丢数据。
 */
function isKbMetaKey(key: string, value: unknown): boolean {
  if (key === 'version') return typeof value === 'number';
  if (key === 'updatedAt') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value);
  return false;
}

/** 从 KB index.json 的一项里取正文（结构：`string | { moduleInfo | content }`） */
function extractKbBodyValue(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as { moduleInfo?: unknown; content?: unknown };
    if (typeof obj.moduleInfo === 'string') return obj.moduleInfo;
    if (typeof obj.content === 'string') return obj.content;
  }
  return '';
}

// ─── 组入站（REQ-20261123-005 · S02 / S03）────────────────────────────────

export interface MoveGroupToTrashArgs {
  scope: string;
  /** 被删组规范路径 */
  group: string;
  /** 自身 + 全部子组（含空组） */
  groups: string[];
  reason?: TrashReason;
  now?: number;
  /** relations 分片里读到的元数据 —— 可能缺篇，那正是要取并集的原因 */
  relations: Array<{ group: string; name: string; snapshot?: Relation }>;
}

export type MoveGroupToTrashOutcome =
  | { ok: true; item: TrashItem; docs: number }
  | { ok: false; code: 'TRASH_WRITE_FAILED'; error: string };

/**
 * 把整组写进回收站。调用方必须已持 scope 写锁，且**必须在删除任何数据之前**调用。
 *
 * 篇目集合取 **relations 分片键 ∪ KB `index.json` 键** 的并集，不是只看分片：
 * 真正删数据的是 `fs.rmSync(kbGroupDir, { recursive: true })`，它删的是磁盘上**所有**文件。
 * 只按分片取会把「KB 有正文、分片里没有对应 relation」的文档漏在快照之外 —— 那篇正文
 * 会随组删除永久消失，而且回收站里连条目都没有，用户根本不知道自己丢了东西。
 *
 * 三档来源（写进 `doc.json` 的 `source`）：
 *   `both`       分片 + KB 都有
 *   `shard-only` 只有元数据（残壳；单篇删除会被 fail-closed 卡死的正是这类）
 *   `kb-only`    只有正文（元数据不一致；恢复时重建最小元数据）
 *
 * 正文缺失**不中止**删除：残壳文档连单篇删除都过不去（`moveToTrash` 同样 fail-closed），
 * 这里再硬拒会让用户永远清理不掉脏数据。
 */
export function moveGroupToTrash(args: MoveGroupToTrashArgs): MoveGroupToTrashOutcome {
  const now = args.now ?? Date.now();
  try {
    // 每个 group 只读一次 KB（同组篇目共享同一个 index.json）
    const kbByGroup = new Map<string, Record<string, unknown>>();
    for (const group of args.groups) {
      let kb: Record<string, unknown> = {};
      try {
        kb = readJson<Record<string, unknown>>(getLocalKbDir(args.scope, group)) ?? {};
      } catch {
        kb = {};
      }
      kbByGroup.set(group, kb ?? {});
    }

    const fromShard = new Map(args.relations.map((r) => [`${r.group}\u0000${r.name}`, r] as const));
    const keys = new Set<string>(fromShard.keys());
    for (const [group, kb] of kbByGroup) {
      for (const [name, value] of Object.entries(kb)) {
        // KB index.json 顶层混着 writeJson 注入的 version / updatedAt —— 它们不是文档
        if (isKbMetaKey(name, value)) continue;
        keys.add(`${group}\u0000${name}`);
      }
    }

    const docs: GroupTrashDocInput[] = [];
    for (const key of keys) {
      const [group, name] = key.split('\u0000');
      const shard = fromShard.get(key);
      const content = extractKbBodyValue(kbByGroup.get(group)?.[name]);
      /** 分片有元数据但读不到正文 = 残壳；两边都没有不可能（key 来源保证至少一边有） */
      const source: GroupSnapshotDoc['source'] = shard && content ? 'both' : shard ? 'shard-only' : 'kb-only';
      docs.push({
        group,
        name,
        source,
        ...(content ? { content } : {}),
        ...(shard?.snapshot ? { relationSnapshot: shard.snapshot } : {}),
      });
    }

    // 附件是 group 级共享目录：每个 group 复制一份，绝不按文档复制
    const assets = args.groups
      .map((group) => ({ group, assetsDir: getAssetsDir(args.scope, group) }))
      .filter((entry) => fs.existsSync(entry.assetsDir));

    const settings = readTrashSettings(args.scope);
    const item = writeGroupTrashItem({
      scope: args.scope,
      group: args.group,
      reason: args.reason ?? 'manual',
      now,
      groups: args.groups,
      docs,
      assets,
      keepDays: settings.keepDays,
    });
    return { ok: true, item, docs: docs.length };
  } catch (err) {
    return { ok: false, code: 'TRASH_WRITE_FAILED', error: (err as Error).message };
  }
}

export interface RestoreArgs {
  scope: string;
  group: string;
  dirName: string;
  /** 恢复时改分类；缺省 = 按原分类（且原期限已过则续期） */
  targetLifecycle?: 'wiki' | 'temp';
  now?: number;
}

export type RestoreOutcome =
  | {
      ok: true;
      restored: { group: string; name: string };
      lifecycle: LifecycleKind;
      expiresAt?: number;
      ttlDays?: number;
      expiresAtChanged: boolean;
      rebuild: 'pending' | 'failed';
      restoreCount: number;
      hint?: string;
    }
  | { ok: false; code: 'TRASH_NOT_FOUND' | 'RESTORE_NAME_CONFLICT' | 'TRASH_CORRUPTED'; error: string };

export function restoreFromTrash(args: RestoreArgs): RestoreOutcome {
  const now = args.now ?? Date.now();
  const found = readTrashItem(args.scope, args.group, args.dirName);
  if (!found) {
    return { ok: false, code: 'TRASH_NOT_FOUND', error: `回收站条目不存在：${args.group}/${args.dirName}` };
  }
  const { item, content, assetsDir } = found;

  /**
   * 组条目不能走文档分支：它的 `docs/` 在子目录里、主体没有 `content.md`、
   * `item.name` 是组名 —— 硬走会往 KB 里写一篇叫组名的空文档。
   * 正常调用走 `restoreAnyFromTrash`（按 kind 分派），这条只是纵深防御。
   */
  if (item.kind === 'group') {
    return {
      ok: false,
      code: 'TRASH_CORRUPTED',
      error: '这是一个组删除快照，请走整组恢复入口（restoreAnyFromTrash）',
    };
  }

  /**
   * 正文缺失 → **拒绝恢复**（fail-closed，事件 #81）。
   *
   * 与入站 `!content.trim()` 的 TRASH_CONTENT_MISSING 对称，也与本文件组恢复
   * （`restoreGroupFromTrash` 的 `if (!entry.content)`）同一口径：写一篇空文档
   * 比不恢复更糟 —— 用户会以为数据救回来了，而「这篇本来是坏的」信息随条目删除不可逆丢失。
   *
   * 为什么不在 HTTP 层挡：`restoreFromTrash` 才是唯一落盘口，MCP/CLI 与组恢复都汇到这里；
   * 页面禁用按钮只是体验层，不能当校验。
   */
  if (!content.trim()) {
    return {
      ok: false,
      code: 'TRASH_CORRUPTED',
      error: `「${item.group}/${item.name}」的快照里没有正文，恢复只会得到空文档；请彻底删除该条目`,
    };
  }

  // ① 同名冲突：同组已存在同名文档时拒绝（R25 / N6），不静默覆盖
  const doc = loadGroupCache(args.scope, item.group);
  const existing = doc?.hot_relations.find((r) => r.text === item.name);
  if (existing) {
    return {
      ok: false,
      code: 'RESTORE_NAME_CONFLICT',
      error: `Group「${item.group}」已存在同名文档「${item.name}」，请先改名或删除现有文档后再恢复`,
    };
  }

  // ② 还原原文 + 附件
  /**
   * ⚠ `getLocalKbDir` 名字像目录，**实际返回的是 `<group>/index.json` 文件路径**
   * （src/lib/scope.ts:115-118）。此前把它的返回值当目录用，导致：
   *   ① `mkdirSync(文件路径)` → EEXIST，恢复直接失败；
   *   ② 即使建目录成功，`path.join(它, 'index.json')` 也会变成 `index.json/index.json`。
   * 正确写法：拿文件路径 → 只建它的父目录。
   */
  const kbPath = getLocalKbDir(args.scope, item.group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, unknown>>(kbPath) ?? {};
  kb[item.name] = content;
  writeJson(kbPath, kb);

  if (item.hasAssets && fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, getAssetsDir(args.scope, item.group), { recursive: true });
  }

  // ③ 还原元数据（保持原 id；冲突时换一个，避免两条关系共享 id）
  const snapshot = item.relationSnapshot;
  const usedIds = new Set((doc?.hot_relations ?? []).map((r) => r.id));
  const restoreCount = (item.restoreCount ?? 0) + 1;
  const relation: Relation = {
    id: snapshot && !usedIds.has(snapshot.id) ? snapshot.id : `rel_restored_${now.toString(36)}`,
    text: item.name,
    score: snapshot?.score ?? 0,
    useCount: snapshot?.useCount ?? 0,
    lastUsedTime: snapshot?.lastUsedTime ?? null,
    isImported: snapshot?.isImported ?? false,
    ...(snapshot?.tags?.length ? { tags: snapshot.tags } : {}),
    ...(snapshot?.sourcePath ? { sourcePath: snapshot.sourcePath } : {}),
    ...(snapshot?.groupSource ? { groupSource: snapshot.groupSource } : {}),
    // 恢复不是内容变更（REQ-20261120-001）：原样带回时间字段，缺省则继续缺省（未知）
    ...(snapshot?.createdAt !== undefined ? { createdAt: snapshot.createdAt } : {}),
    ...(snapshot?.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
    restoreCount,
  };

  // ④ 期限重算（三分支显式分开：wiki 不落字段 / event 只留绑定 / temp 落期限）
  const { lifecycle, expiresAt, ttlDays, changed, ttlAssumed } = recomputeLifecycle(item, snapshot, args.targetLifecycle, now);
  if (lifecycle === 'event') {
    // 事件文档恢复：保留绑定；事件是否仍存在由读侧校验，悬空引用由 diagnostics 暴露
    relation.lifecycle = 'event';
    relation.eventId = snapshot?.eventId;
  } else if (lifecycle === 'temp') {
    relation.lifecycle = 'temp';
    relation.expiresAt = expiresAt;
    relation.ttlDays = ttlDays;
  }
  // wiki 分支：一个字段都不落（缺省即 wiki，与 S-01 口径一致）

  const nextDoc: GroupCacheDoc = doc ?? {
    version: 1,
    scope: args.scope,
    hot_relations: [],
    keywords: [],
    updatedAt: null,
  };
  nextDoc.hot_relations.push(relation);
  writeGroupCache(args.scope, item.group, nextDoc);

  // ⑤ 出站：先记恢复次数，再删目录
  updateTrashItemMeta(args.scope, item.group, item.dirName, { restoreCount });
  removeTrashItem(args.scope, item.group, item.dirName);

  // ⑥ 索引重建入 pending 队列（B4 消费）；此处只登记，不阻塞恢复
  const rebuild = enqueueRebuild(args.scope, item.group, item.name, now);

  const hints: string[] = [];
  if (changed) hints.push(`已按原期限续期 ${ttlDays} 天`);
  if (ttlAssumed) hints.push(`原期限未知，已按 ${FALLBACK_TTL_DAYS} 天处理`);
  if (restoreCount >= 3) hints.push('这份文档反复过期，建议改为长期保留或调长有效期');
  if (rebuild === 'pending') hints.push('索引重建中（数秒），期间检索暂时看不到');

  return {
    ok: true,
    restored: { group: item.group, name: item.name },
    lifecycle,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(ttlDays !== undefined ? { ttlDays } : {}),
    expiresAtChanged: changed,
    rebuild,
    restoreCount,
    ...(hints.length > 0 ? { hint: hints.join('；') } : {}),
  };
}

// ─── 组条目恢复（REQ-20261123-005 · S04）─────────────────────────────────

export interface RestoreGroupArgs {
  scope: string;
  /** 被删组路径（组条目的 group） */
  group: string;
  dirName: string;
  now?: number;
}

export interface RestoreGroupFailureItem {
  group: string;
  name: string;
  code: 'RESTORE_NAME_CONFLICT' | 'TRASH_CORRUPTED';
  error: string;
}

export type RestoreGroupOutcome =
  | {
    ok: true;
    scope: string;
    kind: 'group';
    restored: { group: string; groups: string[]; docs: number };
    failed: RestoreGroupFailureItem[];
    rebuild: 'pending' | 'done' | 'failed';
    restoreCount: number;
    hint?: string;
  }
  | {
    ok: false;
    code: 'TRASH_NOT_FOUND' | 'RESTORE_NAME_CONFLICT' | 'TRASH_CORRUPTED';
    error: string;
  };

/** 目标组已存在且非空 → 返回拒绝理由；不存在或只空节点 → null（允许合并） */
function describeGroupConflict(scope: string, groupPath: string): string | null {
  const index = readGroupIndex(scope);
  const segs = groupPath.split('/').filter(Boolean);
  if (!index || segs.length === 0) return null;
  let node: unknown = index.groups;
  for (const seg of segs) {
    if (!node || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    if (!(seg in obj)) return null; // 路径本身不存在 → 无冲突
    node = obj[seg];
  }
  const children = node && typeof node === 'object' ? Object.keys(node as Record<string, unknown>).length : 0;
  const relations = (() => {
    try {
      return loadGroupCache(scope, groupPath)?.hot_relations.length ?? 0;
    } catch {
      return 0;
    }
  })();
  if (children > 0 || relations > 0) {
    return `目标 Group「${groupPath}」已存在且非空（子组 ${children} / relation ${relations}），`
      + '请先改名或清理后再恢复整组';
  }
  return null; // 空节点：允许把快照内容写回该组（用户重建了空组很常见）
}

/** 先建树节点：逆序（先写文档后建树）会产生「KB 里有文档、树里没这个组」 */
function rebuildGroupTree(scope: string, groups: string[]): void {
  const index = readGroupIndex(scope);
  if (!index) throw new Error('group-index.json 不存在或不可读');
  for (const groupPath of groups) ensureGroupPathInTree(index, groupPath);
  writeJson(getGroupIndexPath(scope), index as unknown as Record<string, unknown>);
}

/** 批量登记索引重建：逐篇调用会让 `.visibility-pending.json` 被读改写 N 次（O(N²)） */
function enqueueRebuildMany(
  scope: string,
  entries: Array<{ group: string; name: string }>,
  now: number,
): 'pending' | 'failed' {
  const filePath = path.join(getKbDir(scope), '.visibility-pending.json');
  try {
    const current = readJson<{ version: 1; items: Array<Record<string, unknown>> }>(filePath);
    const items = Array.isArray(current?.items) ? current!.items : [];
    const wanted = new Set(entries.map((e) => `${e.group}\u0000${e.name}`));
    const next = items.filter((i) => !wanted.has(`${String(i.group)}\u0000${String(i.relation)}`));
    for (const entry of entries) {
      next.push({
        relation: entry.name,
        group: entry.group,
        target: 'full',
        kinds: ['dense', 'fts', 'relation', 'path'],
        createdAt: now,
        attempts: 0,
      });
    }
    writeJson(filePath, { version: 1, items: next });
    return 'pending';
  } catch (err) {
    console.warn(`[trash] 登记索引重建失败（组恢复）：${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * 整组恢复（REQ-20261123-005 · S04）。调用方必须已持 scope 写锁。
 *
 * 顺序不可调换：
 *   ① 冲突判定（目标组已存在且非空 → 整组拒绝，不动任何数据）
 *   ② **建树节点** —— 必须先于文档，否则中途失败会留下「KB 有文档、树里没组」
 *   ③ 逐篇写回（按 group 分组：每组读一次 KB / 分片，写一次）
 *   ④ 附件按 `assets.json` 逐 group 一次性复制（附件是 group 级共享目录）
 *   ⑤ 收缩：成功的篇从 `docs/` 移除；`docCount` 归 0 才删整个条目
 *   ⑥ 索引重建整组一次登记
 *
 * 部分失败**不整组回滚**：已恢复的篇留在 KB 里，失败项留在回收站可改名后重试。
 */
export function restoreGroupFromTrash(args: RestoreGroupArgs): RestoreGroupOutcome {
  const now = args.now ?? Date.now();
  const found = readTrashItem(args.scope, args.group, args.dirName);
  if (!found) {
    return { ok: false, code: 'TRASH_NOT_FOUND', error: `回收站条目不存在：${args.group}/${args.dirName}` };
  }
  const { item } = found;
  const snapshot = item.groupSnapshot;
  if (item.kind !== 'group' || !snapshot) {
    return {
      ok: false,
      code: 'TRASH_CORRUPTED',
      error: `条目 ${args.group}/${args.dirName} 不是组快照，无法按整组恢复`,
    };
  }

  const conflict = describeGroupConflict(args.scope, snapshot.path);
  if (conflict) {
    return { ok: false, code: 'RESTORE_NAME_CONFLICT', error: conflict };
  }

  try {
    rebuildGroupTree(args.scope, snapshot.groups);
  } catch (err) {
    return { ok: false, code: 'TRASH_CORRUPTED', error: `重建 Group 树失败：${(err as Error).message}` };
  }

  const failed: RestoreGroupFailureItem[] = [];
  const entries = readGroupSnapshotDocs(args.scope, args.group, args.dirName);

  // 事件存量：用于把「原事件已删除」的文档降级为 wiki，避免一次恢复制造 N 条悬空引用
  const liveEventIds = (() => {
    try {
      return new Set(readAllEvents(args.scope).map((event) => event.id));
    } catch {
      return null; // 读不到事件库时不降级（宁可按原样恢复，也不误改用户分类）
    }
  })();

  const byGroup = new Map<string, GroupSnapshotDocEntry[]>();
  for (const entry of entries) {
    if (!entry.doc) {
      failed.push({
        group: args.group,
        name: entry.dirName,
        code: 'TRASH_CORRUPTED',
        error: '快照条目损坏（doc.json 缺失或不可读）',
      });
      continue;
    }
    const list = byGroup.get(entry.doc.group) ?? [];
    list.push(entry);
    byGroup.set(entry.doc.group, list);
  }

  const rebuildEntries: Array<{ group: string; name: string }> = [];
  /** 已写进内存、但**尚未落盘**的篇目：落盘成功后才能删它们的快照 */
  const restoredEntries: GroupSnapshotDocEntry[] = [];
  let restoredDocs = 0;
  let minimalRecords = 0;
  let eventDowngraded = 0;

  for (const [groupPath, list] of byGroup) {
    const kbPath = getLocalKbDir(args.scope, groupPath);
    let kb: Record<string, unknown> = {};
    try {
      kb = readJson<Record<string, unknown>>(kbPath) ?? {};
    } catch {
      kb = {};
    }
    let cacheDoc: GroupCacheDoc;
    try {
      cacheDoc = loadGroupCache(args.scope, groupPath) ?? {
        version: 1,
        scope: args.scope,
        hot_relations: [],
        keywords: [],
        updatedAt: null,
      } as GroupCacheDoc;
    } catch {
      cacheDoc = {
        version: 1,
        scope: args.scope,
        hot_relations: [],
        keywords: [],
        updatedAt: null,
      } as GroupCacheDoc;
    }

    const usedNames = new Set(cacheDoc.hot_relations.map((rel) => rel.text));
    const usedIds = new Set(cacheDoc.hot_relations.map((rel) => rel.id));
    let kbDirty = false;
    let cacheDirty = false;

    for (const entry of list) {
      const doc = entry.doc!;
      if (usedNames.has(doc.name)) {
        failed.push({
          group: groupPath,
          name: doc.name,
          code: 'RESTORE_NAME_CONFLICT',
          error: '该 Group 已存在同名文档，改名后可重试',
        });
        continue;
      }
      // 原文缺失（shard-only 残壳）：**不写空串** —— 恢复成空文档比不恢复更糟
      if (!entry.content) {
        failed.push({
          group: groupPath,
          name: doc.name,
          code: 'TRASH_CORRUPTED',
          error: '快照里没有正文，恢复只会得到空文档',
        });
        continue;
      }

      kb[doc.name] = entry.content;
      kbDirty = true;

      const snap = doc.relationSnapshot;
      if (!snap) minimalRecords++;
      const relation: Relation = {
        id: snap && !usedIds.has(snap.id) ? snap.id : `rel_restored_${now.toString(36)}_${restoredDocs}`,
        text: doc.name,
        score: snap?.score ?? 0,
        useCount: snap?.useCount ?? 0,
        lastUsedTime: snap?.lastUsedTime ?? null,
        isImported: snap?.isImported ?? false,
        ...(snap?.tags?.length ? { tags: snap.tags } : {}),
        ...(snap?.sourcePath ? { sourcePath: snap.sourcePath } : {}),
        ...(snap?.groupSource ? { groupSource: snap.groupSource } : {}),
        ...(snap?.createdAt !== undefined ? { createdAt: snap.createdAt } : {}),
        ...(snap?.updatedAt !== undefined ? { updatedAt: snap.updatedAt } : {}),
        restoreCount: (item.restoreCount ?? 0) + 1,
      };

      const recomputed = recomputeLifecycle(item, snap, undefined, now);
      if (recomputed.lifecycle === 'event') {
        const eventId = snap?.eventId;
        if (eventId && liveEventIds && !liveEventIds.has(eventId)) {
          // 事件已不在：降级为 wiki（保持"不制造悬空引用"），并在 hint 里说明
          eventDowngraded++;
        } else {
          relation.lifecycle = 'event';
          relation.eventId = eventId;
        }
      } else if (recomputed.lifecycle === 'temp') {
        relation.lifecycle = 'temp';
        relation.expiresAt = recomputed.expiresAt;
        relation.ttlDays = recomputed.ttlDays;
      }

      usedNames.add(doc.name);
      usedIds.add(relation.id);
      cacheDoc.hot_relations.push(relation);
      cacheDirty = true;
      restoredDocs++;
      rebuildEntries.push({ group: groupPath, name: doc.name });
      restoredEntries.push(entry);
    }

    /*
     * 顺序不可调换：**先落盘、再删快照**。
     * 反过来（边恢复边删快照）时，只要 `writeJson` 失败一次（磁盘满 / 权限），
     * 正文就随快照一起没了 —— 那是不可逆的数据丢失。
     */
    if (kbDirty) writeJson(kbPath, kb);
    if (cacheDirty) writeGroupCache(args.scope, groupPath, cacheDoc);
    for (const entry of restoredEntries) {
      try {
        fs.rmSync(entry.dir, { recursive: true, force: true });
      } catch { /* 删不掉只是让条目多留一会儿：下次恢复会因同名冲突拒绝，不影响数据 */ }
    }
    restoredEntries.length = 0;
  }

  /*
   * 附件：逐 group 一次性复制（整组一份，绝不按篇 —— 按篇既膨胀又会互相覆盖）。
   * **复制成功才删快照里的那份**；失败则留在回收站，否则条目一删附件就再也拿不回来。
   */
  const remainingAssets: Array<{ group: string; dir: string }> = [];
  for (const asset of readGroupSnapshotAssets(args.scope, args.group, args.dirName)) {
    try {
      fs.cpSync(asset.absDir, getAssetsDir(args.scope, asset.group), { recursive: true });
      try {
        fs.rmSync(asset.absDir, { recursive: true, force: true });
      } catch { /* 删不掉只是多占点空间，不影响正确性 */ }
    } catch (err) {
      remainingAssets.push({ group: asset.group, dir: asset.dir });
      failed.push({
        group: asset.group,
        name: `(附件 ${asset.dir})`,
        code: 'TRASH_CORRUPTED',
        error: `附件复制失败：${(err as Error).message}`,
      });
    }
  }
  const assetsManifestPath = path.join(found.dir, 'assets.json');
  try {
    if (remainingAssets.length > 0) {
      fs.writeFileSync(assetsManifestPath, JSON.stringify(remainingAssets, null, 2), 'utf-8');
    } else if (fs.existsSync(assetsManifestPath)) {
      fs.rmSync(assetsManifestPath, { force: true });
    }
  } catch { /* 清单写不回去只影响下次恢复的附件范围，条目不丢 */ }

  const rebuild = rebuildEntries.length > 0 ? enqueueRebuildMany(args.scope, rebuildEntries, now) : 'done';
  const restoreCount = (item.restoreCount ?? 0) + 1;

  /*
   * 出站判定按**磁盘实况**（不按计数推断）：
   * 正文与附件**都**清空才能删条目；只恢复了一半的条目必须留着，否则失败项再也没机会重试。
   */
  const leftDocs = readGroupSnapshotDocs(args.scope, args.group, args.dirName);
  const leftAssets = readGroupSnapshotAssets(args.scope, args.group, args.dirName);
  if (leftDocs.length === 0 && leftAssets.length === 0) {
    removeTrashItem(args.scope, args.group, args.dirName);
  } else {
    updateTrashItemMeta(args.scope, args.group, args.dirName, {
      restoreCount,
      groupSnapshot: {
        ...snapshot,
        docCount: leftDocs.length,
        assets: leftAssets.map(({ group, dir }) => ({ group, dir })),
      },
    });
  }

  const hints: string[] = [];
  if (failed.length > 0) hints.push(`${failed.length} 篇/项未恢复，已保留在回收站`);
  if (minimalRecords > 0) hints.push(`${minimalRecords} 篇缺元数据，已按最小记录恢复`);
  if (eventDowngraded > 0) hints.push(`${eventDowngraded} 篇的原事件已删除，已按长期保留恢复`);
  if (rebuild === 'pending') hints.push('索引重建中（数秒），期间检索暂时看不到');

  return {
    ok: true,
    scope: args.scope,
    kind: 'group',
    restored: { group: snapshot.path, groups: snapshot.groups, docs: restoredDocs },
    failed,
    rebuild,
    restoreCount,
    ...(hints.length > 0 ? { hint: hints.join('；') } : {}),
  };
}

export type RestoreAnyOutcome = RestoreOutcome | RestoreGroupOutcome;

/**
 * 统一恢复入口：按条目 `kind` 分派。
 *
 * doc → `restoreFromTrash`（返回形状不变）；group → `restoreGroupFromTrash`（建树 + 逐篇回写）。
 * HTTP 层只暴露这一个入口，前端不必按 kind 选端点 —— 坐标 `(group, dirName)` 本来就够用。
 */
export function restoreAnyFromTrash(args: RestoreArgs): RestoreAnyOutcome {
  const found = readTrashItem(args.scope, args.group, args.dirName);
  if (!found) {
    return { ok: false, code: 'TRASH_NOT_FOUND', error: `回收站条目不存在：${args.group}/${args.dirName}` };
  }
  if (found.item.kind === 'group') {
    return restoreGroupFromTrash({
      scope: args.scope,
      group: args.group,
      dirName: args.dirName,
      ...(args.now !== undefined ? { now: args.now } : {}),
    });
  }
  return restoreFromTrash(args);
}

function recomputeLifecycle(
  item: TrashItem,
  snapshot: Relation | undefined,
  target: 'wiki' | 'temp' | undefined,
  now: number,
): { lifecycle: LifecycleKind; expiresAt?: number; ttlDays?: number; changed: boolean; ttlAssumed: boolean } {
  if (target === 'wiki') return { lifecycle: 'wiki', changed: true, ttlAssumed: false };

  const originalTtl = snapshot?.ttlDays;
  const hasOriginalTtl = typeof originalTtl === 'number' && originalTtl > 0;
  const ttlDays = hasOriginalTtl ? originalTtl : item.ttlDays > 0 ? item.ttlDays : FALLBACK_TTL_DAYS;
  /**
   * 「用了回退值」必须读**入站时落盘的** `ttlAssumed`：
   * 入站时已把缺省 ttlDays 规范成 7（`writeTrashItem`），恢复侧再靠 `item.ttlDays > 0` 判断
   * 永远为真 → 「原期限未知」的提示会丢。旧条目没有该字段时才回退到按 ttlDays 推断。
   */
  const ttlAssumed = hasOriginalTtl
    ? false
    : item.ttlAssumed !== undefined ? item.ttlAssumed : !(item.ttlDays > 0);

  // 事件文档：保留阶段可见性（B4 由事件决定档位），此处只保留 eventId
  if (snapshot?.eventId && target !== 'temp') {
    return { lifecycle: 'event', changed: false, ttlAssumed };
  }

  const originalExpiresAt = snapshot?.expiresAt;
  // 手动删除（原期限未过）→ 保持原值；自动过期进站 → 按期限长度续期
  if (typeof originalExpiresAt === 'number' && originalExpiresAt > now) {
    return { lifecycle: 'temp', expiresAt: originalExpiresAt, ttlDays, changed: false, ttlAssumed };
  }
  return { lifecycle: 'temp', expiresAt: now + ttlDays * DAY_MS, ttlDays, changed: true, ttlAssumed };
}

/**
 * 把该文档登记进索引重建队列。
 *
 * 为什么不是直接重建：B2 阶段 `visibility-index` 只有摘除原语，重建要等 B4 的
 * `applyVisibility`（含 embed 与 pending 消费）。先登记，B4 上线后同一份文件即可被消费，
 * 不需要改恢复链路。
 */
function enqueueRebuild(scope: string, group: string, relation: string, now: number): 'pending' | 'failed' {
  const filePath = path.join(getKbDir(scope), '.visibility-pending.json');
  try {
    const current = readJson<{ version: 1; items: Array<Record<string, unknown>> }>(filePath);
    const items = Array.isArray(current?.items) ? current!.items : [];
    const next = items.filter((i) => !(i.relation === relation && i.group === group));
    next.push({
      relation,
      group,
      target: 'full',
      kinds: ['dense', 'fts', 'relation', 'path'],
      createdAt: now,
      attempts: 0,
    });
    writeJson(filePath, { version: 1, items: next });
    return 'pending';
  } catch (err) {
    console.warn(`[trash] 登记索引重建失败（${group}/${relation}）：${(err as Error).message}`);
    return 'failed';
  }
}

export interface PurgeArgs {
  scope: string;
  now?: number;
  /** 只算不删（设置弹窗预览"将清理 N 篇"） */
  dryRun?: boolean;
}

/**
 * 到期清理的条目摘要（REQ-20261123-005 · S02 §6）。
 *
 * `kind` / `docCount` 不是锦上添花：组条目到期会**一次清掉 N 篇正文 + 附件**，
 * 只报一个组名会让用户以为清掉的是个空分组。
 */
export interface PurgeBrief {
  group: string;
  name: string;
  dirName: string;
  kind: TrashKind;
  /** 仅组条目：本次一并清掉的篇数 */
  docCount?: number;
}

export interface PurgeOutcome {
  purged: PurgeBrief[];
  notified: PurgeBrief[];
  mode: 'purge' | 'notify';
}

/**
 * 到期清理。
 *
 * 触发点（三处共用，S-04 §3.5）：daemon 启动、每次写入收尾、每次删除收尾。
 * `expireAction='notify'` 时只返回名单不删（页面标红）。
 */
export function purgeExpired(args: PurgeArgs): PurgeOutcome {
  const now = args.now ?? Date.now();
  const settings = readTrashSettings(args.scope);
  const expired = findExpiredTrash(args.scope, now);
  const purge: PurgeOutcome['purged'] = [];
  const notify: PurgeOutcome['notified'] = [];

  for (const item of expired) {
    const isGroup = item.kind === 'group';
    const brief: PurgeBrief = {
      group: item.group,
      name: item.name,
      dirName: item.dirName,
      // findExpiredTrash 直接读 meta.json，不走 listTrash 的补全 —— 这里自己兜底
      kind: isGroup ? 'group' : 'doc',
      ...(isGroup ? { docCount: item.groupSnapshot?.docCount ?? 0 } : {}),
    };
    if (settings.expireAction === 'notify') {
      notify.push(brief);
      continue;
    }
    if (args.dryRun) {
      purge.push(brief);
      continue;
    }
    try {
      removeTrashItem(args.scope, item.group, item.dirName);
      purge.push(brief);
    } catch (err) {
      console.warn(`[trash] 清理失败 ${item.group}/${item.dirName}：${(err as Error).message}`);
    }
  }

  return { purged: purge, notified: notify, mode: settings.expireAction };
}

/** 治理配置路径（供 diagnostics 校验 scope 是否已初始化） */
export function governancePathOf(scope: string): string {
  return getGovernancePath(scope);
}
