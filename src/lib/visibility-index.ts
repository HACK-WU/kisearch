/**
 * 索引可见性 · 唯一出口（B0 骨架，B2/B4 填实现）
 *
 * 为什么必须只有这一个出口：
 *   四类索引（dense / FTS / ki-relation / ki-path）× 三档可见性 × 调用方（删除链路、
 *   事件流转、rebuild-vector、编辑发布、覆盖写）＝ 组合爆炸。历史上已两次出现
 *   「摘了向量没摘 FTS」/「摘了 path 没摘 relation」的残留，都是因为各处自己拼调用。
 *
 * 两条硬约束（S-03）：
 *   1. **摘除同步、写入异步**：用户点完流转要立刻搜不到（语义正确优先于响应速度）；
 *      embed 秒级/篇，只入 pending 队列，返回值带 `pending` 让 UI 显示"索引重建中"。
 *   2. **`ki-path` 是组级**：docId 只由 group 路径决定，一组一条。按文档摘会误伤
 *      同组其他可见文档 ⇒ 只有「组内全部文档都 hidden」时才摘。
 *
 * 另外 `ki-relation` 的 docId 只由 `relation 名 + scope + tag` 决定（跨组共享），
 * 摘前必须复用 `delete-relation.ts` 的 otherHolders 保护。
 */

import type { Visibility } from './events/types.js';

export type IndexKind = 'dense' | 'fts' | 'relation' | 'path';

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`NOT_IMPLEMENTED: ${feature}（B0 骨架，见 design/IMPL_PLAN.md 批次 B2/B4）`);
    this.name = 'NotImplementedError';
  }
}

/** `resolveVisibility` 的最小输入（避免依赖 `Relation` 在 B1 才新增的字段） */
export interface VisibilitySubject {
  lifecycle?: string;
  expiresAt?: number;
  eventId?: string;
}

export interface ResolveVisibilityInput {
  relation: VisibilitySubject;
  /** 仅 event 文档需要：按 eventId 查事件与类型 */
  lookupEvent?: (eventId: string) => { stageKey: string; typeId: string } | null;
  lookupType?: (typeId: string) => { stages: Array<{ key: string; visibility: Visibility }> } | null;
}

export interface ResolvedVisibility {
  mode: Visibility;
  source: 'lifecycle' | 'event-stage' | 'fallback';
  /** 事件/类型缺失时的可读原因（N13：按 wiki 处理但要报诊断） */
  warning?: string;
}

export interface ApplyArgs {
  scope: string;
  group: string;
  relation: string;
  to: Visibility;
}

export interface ApplySkipped {
  kind: IndexKind;
  reason: string;
}

export interface ApplyResult {
  relation: string;
  from: Visibility;
  to: Visibility;
  /** 本次同步摘除成功的类别 */
  removed: IndexKind[];
  /** 本次已写入的类别 */
  written: IndexKind[];
  /** 已入 pending 队列、待异步补齐的类别 */
  pending: IndexKind[];
  skipped: ApplySkipped[];
  /** 摘除失败的类别（已写诊断，档位仍标记为 `to`） */
  failed: IndexKind[];
}

export interface RebuildArgs {
  scope: string;
  filter?: { group?: string; relations?: string[] };
}

export interface RebuildResult {
  applied: number;
  skipped: number;
}

/** 待补索引条目（落 `{scope}/.visibility-pending.json`，daemon 重启不丢） */
export interface PendingIndexWrite {
  relation: string;
  group: string;
  target: Visibility;
  kinds: IndexKind[];
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface PendingFile {
  version: 1;
  items: PendingIndexWrite[];
}

/** 失败诊断条目（落 `{scope}/.visibility-failures.json`） */
export interface VisibilityFailure {
  relation: string;
  group: string;
  kind: IndexKind;
  code: string;
  message: string;
  attempts: number;
  at: number;
}

export interface FailureFile {
  version: 1;
  items: VisibilityFailure[];
}

/**
 * 判定文档应处的档位（纯查询，不碰索引）。
 *
 * B4 实现：`lifecycle !== 'event'` → full；`event` → 按事件当前阶段查类型可见性；
 * 事件/类型缺失 → full + warning（N13：悬空引用按 wiki 处理，不静默丢弃）。
 */
export function resolveVisibility(_input: ResolveVisibilityInput): ResolvedVisibility {
  throw new NotImplementedError('resolveVisibility');
}

/** 单文档档位切换；调用方必须已持 scope 写锁（本函数不自己加锁） */
export async function applyVisibility(_args: ApplyArgs): Promise<ApplyResult> {
  throw new NotImplementedError('applyVisibility');
}

/** 按当前档位重建（rebuild-vector / restore 用） */
export async function rebuildVisibility(_args: RebuildArgs): Promise<RebuildResult> {
  throw new NotImplementedError('rebuildVisibility');
}
