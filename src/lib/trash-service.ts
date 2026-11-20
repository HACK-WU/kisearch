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
import { getAssetsDir, getLocalKbDir } from './scope.js';
import { readJson, writeJson } from './store.js';
import { getKbDir } from './scope.js';
import { loadGroupCache, writeGroupCache, type GroupCacheDoc } from './group-cache.js';
import { FALLBACK_TTL_DAYS, type LifecycleKind } from './lifecycle.js';
import {
  writeTrashItem,
  readTrashItem,
  removeTrashItem,
  updateTrashItemMeta,
  findExpiredTrash,
  readTrashSettings,
  getTrashRoot,
  type TrashItem,
  type TrashReason,
} from './trash-store.js';
import { getGovernancePath } from './governance-store.js';
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
  const raw = kb[relation];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as { moduleInfo?: unknown; content?: unknown };
    if (typeof obj.moduleInfo === 'string') return obj.moduleInfo;
    if (typeof obj.content === 'string') return obj.content;
  }
  return '';
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
  | { ok: false; code: 'TRASH_NOT_FOUND' | 'RESTORE_NAME_CONFLICT'; error: string };

export function restoreFromTrash(args: RestoreArgs): RestoreOutcome {
  const now = args.now ?? Date.now();
  const found = readTrashItem(args.scope, args.group, args.dirName);
  if (!found) {
    return { ok: false, code: 'TRASH_NOT_FOUND', error: `回收站条目不存在：${args.group}/${args.dirName}` };
  }
  const { item, content, assetsDir } = found;

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

export interface PurgeOutcome {
  purged: Array<{ group: string; name: string; dirName: string }>;
  notified: Array<{ group: string; name: string; dirName: string }>;
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
    const brief = { group: item.group, name: item.name, dirName: item.dirName };
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
