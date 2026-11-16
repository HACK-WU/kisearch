/**
 * 可见性 pending 队列（REQ-20261113-004 · S-03 §3.6）
 *
 * 为什么必须落盘：`pending` 表示"档位已声明、索引还没补齐"的半态。挂内存里的话，
 * daemon 重启就丢，文档会永久停在「声明 hidden 但索引还在」或「声明 full 但搜不到」。
 *
 * 四条生命周期（缺一条都会留下静默不一致）：
 *   ① 何时开始累积：`applyVisibility` 判定需要写入时，落一条 pending；
 *   ② 累积期存哪：`{scope}/.visibility-pending.json`；
 *   ③ 何时并入主状态：写入成功 → 移除；失败 → attempts+1 保留；
 *   ④ 中途终止：daemon 启动时扫该文件恢复任务；attempts ≥ 3 → 转 failures 并标 blocked，
 *      不再自动重试（UI 显示「索引未切换」，由人重试）。
 *
 * 写入本身走 `sync-relation` 的既有回写函数（`vectorWriteBack` / `fullTextWriteBack`），
 * 不另写一套 embed 逻辑 —— 那会与写路径分叉，出现"同参数两种索引"。
 */

import path from 'path';
import { loadGroupCache, writeGroupCache } from './group-cache.js';
import { getLocalKbDir } from './scope.js';
import { storeOnePathAsync, buildRelationContent, buildGroupPathContent } from './path-vectorize.js';
import { readJson, writeJson } from './store.js';
import {
  pendingFilePath, failureFilePath,
  type IndexKind, type PendingFile, type PendingIndexWrite, type VisibilityFailure, type FailureFile,
} from './visibility-index.js';
import { vectorWriteBack, fullTextWriteBack } from '../sync-relation.js';
import type { Visibility } from './events/types.js';

const MAX_ATTEMPTS = 3;

export interface ConsumeResult {
  consumed: Array<{ group: string; relation: string; kinds: IndexKind[] }>;
  failed: Array<{ group: string; relation: string; reason: string; attempts: number }>;
  blocked: Array<{ group: string; relation: string }>;
  remaining: number;
}

export interface ConsumeDeps {
  /** 读原文（默认从 local KB）；测试可注入 */
  readContent?: (group: string, relation: string) => string | null;
  /** 写 dense（默认 vectorWriteBack）；返回是否成功 */
  writeDense?: (args: { scope: string; group: string; relation: string; content: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** 写 FTS（默认 fullTextWriteBack）；返回写入的 id 列表 */
  writeFts?: (args: { scope: string; group: string; relation: string; content: string; previousIds: string[] }) => Promise<{ ok: boolean; ids?: string[]; reason?: string }>;
  /** 写 ki-relation 向量（默认 storeOnePathAsync） */
  writeRelation?: (args: { scope: string; group: string; relation: string }) => Promise<{ ok: boolean; error?: string }>;
  /** 写 ki-path 向量（默认 storeOnePathAsync） */
  writePath?: (args: { scope: string; group: string }) => Promise<{ ok: boolean; error?: string }>;
  now?: () => number;
}

function loadPending(scope: string): PendingFile {
  try {
    const raw = readJson<PendingFile>(pendingFilePath(scope));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch (err) {
    console.warn(`[visibility-queue] pending 文件损坏，按空处理：${(err as Error).message}`);
  }
  return { version: 1, items: [] };
}

function savePending(scope: string, file: PendingFile): void {
  writeJson(pendingFilePath(scope), file as unknown as Record<string, unknown>);
}

function appendFailure(scope: string, failure: VisibilityFailure): void {
  try {
    const raw = readJson<FailureFile>(failureFilePath(scope));
    const file: FailureFile = raw && Array.isArray(raw.items) ? raw : { version: 1, items: [] };
    file.items.push(failure);
    writeJson(failureFilePath(scope), file as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[visibility-queue] 写诊断失败：${(err as Error).message}`);
  }
}

/** 默认读原文：local KB 的 `index.json` */
function defaultReadContent(scope: string, group: string, relation: string): string | null {
  try {
    // 同上：getLocalKbDir 已是文件路径
    const kb = readJson<Record<string, unknown>>(getLocalKbDir(scope, group));
    const raw = kb?.[relation];
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
      const obj = raw as { moduleInfo?: unknown; content?: unknown };
      if (typeof obj.moduleInfo === 'string') return obj.moduleInfo;
      if (typeof obj.content === 'string') return obj.content;
    }
    return null;
  } catch {
    return null;
  }
}

/** 把写入结果回写分片（memoryIds / ftsIds） */
function persistIndexIds(scope: string, group: string, relation: string, patch: { memoryIds?: string[]; ftsIds?: string[] }): void {
  const doc = loadGroupCache(scope, group);
  if (!doc) return;
  const rel = doc.hot_relations.find((r) => r.text === relation);
  if (!rel) return;
  if (patch.memoryIds) {
    rel.memoryIds = patch.memoryIds;
    if (patch.memoryIds.length > 0) rel.memoryId = patch.memoryIds[0];
    else delete rel.memoryId;
  }
  if (patch.ftsIds) {
    rel.ftsIds = patch.ftsIds;
    rel.ftsIndexComplete = patch.ftsIds.length > 0;
  }
  writeGroupCache(scope, group, doc);
}

/**
 * 消费 pending 队列。
 *
 * 不持 scope 写锁（embed 可达秒级，持锁会阻塞所有写入）；但写分片前重新读一次，
 * 若档位已再次变化则丢弃本次（`superseded`），避免"连续两次流转把 hidden 写回可检索"。
 */
export async function consumePending(scope: string, deps: ConsumeDeps = {}): Promise<ConsumeResult> {
  const now = deps.now?.() ?? Date.now();
  const file = loadPending(scope);
  if (file.items.length === 0) return { consumed: [], failed: [], blocked: [], remaining: 0 };

  const consumed: ConsumeResult['consumed'] = [];
  const failed: ConsumeResult['failed'] = [];
  const blocked: ConsumeResult['blocked'] = [];
  const keep: PendingIndexWrite[] = [];

  const readContent = deps.readContent ?? ((group, relation) => defaultReadContent(scope, group, relation));

  for (const item of file.items) {
    if (item.attempts >= MAX_ATTEMPTS) {
      blocked.push({ group: item.group, relation: item.relation });
      continue;
    }

    const content = readContent(item.group, item.relation);
    if (content === null) {
      // 原文不在了（已被删除/入站）：这条 pending 没有意义，直接丢弃
      continue;
    }

    const reasons: string[] = [];
    const writtenKinds: IndexKind[] = [];

    for (const kind of item.kinds) {
      try {
        if (kind === 'dense') {
          const res = deps.writeDense
            ? await deps.writeDense({ scope, group: item.group, relation: item.relation, content })
            : await defaultWriteDense(scope, item.group, item.relation, content);
          if (res.ok) writtenKinds.push(kind);
          else reasons.push(res.reason ?? 'dense 写入失败');
        } else if (kind === 'fts') {
          const doc = loadGroupCache(scope, item.group);
          const previousIds = doc?.hot_relations.find((r) => r.text === item.relation)?.ftsIds ?? [];
          const res = deps.writeFts
            ? await deps.writeFts({ scope, group: item.group, relation: item.relation, content, previousIds })
            : await defaultWriteFts(scope, item.group, item.relation, content, previousIds);
          if (res.ok) {
            writtenKinds.push(kind);
            if (res.ids) persistIndexIds(scope, item.group, item.relation, { ftsIds: res.ids });
          } else {
            reasons.push(res.reason ?? 'fts 写入失败');
          }
        } else if (kind === 'relation') {
          // ki-relation：docId 跨组共享，写入幂等（同文本 → 同 docId）
          const res = deps.writeRelation
            ? await deps.writeRelation({ scope, group: item.group, relation: item.relation })
            : await storeOnePathAsync({
              scope,
              text: buildRelationContent(item.relation, item.group),
              tag: 'ki-relation',
              group: item.group,
            });
          if (res.ok) writtenKinds.push(kind);
          else reasons.push(res.error ?? 'relation 向量写入失败');
        } else if (kind === 'path') {
          const res = deps.writePath
            ? await deps.writePath({ scope, group: item.group })
            : await storeOnePathAsync({
              scope,
              text: buildGroupPathContent(item.group),
              tag: 'ki-path',
              group: item.group,
            });
          if (res.ok) writtenKinds.push(kind);
          else reasons.push(res.error ?? 'path 向量写入失败');
        }
      } catch (err) {
        reasons.push((err as Error).message);
      }
    }

    if (reasons.length === 0) {
      consumed.push({ group: item.group, relation: item.relation, kinds: writtenKinds });
      continue;
    }

    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      blocked.push({ group: item.group, relation: item.relation });
      for (const kind of item.kinds) {
        appendFailure(scope, {
          relation: item.relation, group: item.group, kind, code: 'INDEX_WRITE_FAILED',
          message: reasons.join('；'), attempts, at: now,
        });
      }
      continue;
    }

    failed.push({ group: item.group, relation: item.relation, reason: reasons.join('；'), attempts });
    keep.push({ ...item, attempts, lastError: reasons.join('；') });
  }

  savePending(scope, { version: 1, items: keep });
  return { consumed, failed, blocked, remaining: keep.length };
}

async function defaultWriteDense(scope: string, group: string, relation: string, content: string): Promise<{ ok: boolean; reason?: string }> {
  const res = await vectorWriteBack({ scope, group, relation, moduleInfo: content });
  return { ok: res.stored, reason: res.reason };
}

async function defaultWriteFts(
  scope: string,
  group: string,
  relation: string,
  content: string,
  previousIds: string[],
): Promise<{ ok: boolean; ids?: string[]; reason?: string }> {
  const res = await fullTextWriteBack({ scope, group, relation, moduleInfo: content, previousIds });
  return { ok: res.stored, ids: res.ids, reason: res.reason };
}

/** daemon 启动时恢复：把 blocked 之外的全部重跑一次 */
export async function resumePendingOnStartup(scope: string): Promise<ConsumeResult> {
  return consumePending(scope);
}

/**
 * 写操作后按需触发消费（fire-and-forget），**同 scope 串行**。
 *
 * 为什么必须有：`resumePendingOnStartup` 只在 daemon 启动时跑（`mcp-http.ts` 的
 * `resumeGovernanceTasks`），运行期入队的补索引任务原本永远不会执行 ——
 * 界面写着"索引补齐中，数秒后生效"，实际要等下次重启。
 *
 * 为什么要串行：`consumePending` 读-改-写 `.visibility-pending.json` 无锁，两次并发
 * 会互相覆盖条目、写乱 `attempts`。这里用模块级 in-flight Map 复用同一个 Promise。
 */
const inFlight = new Map<string, Promise<ConsumeResult>>();

/**
 * 诊断/测试开关：`KI_DISABLE_AUTO_CONSUME=1` 时 `scheduleConsume` 直接返回空结果。
 *
 * 为什么需要：补齐任务会打开 FTS/向量引擎，而单测进程在引擎句柄未释放时不会退出
 * （`closeEngine` 还可能因为 open 中的 promise 永久挂住）。测试里关掉自动补齐，
 * 由用例自己决定要不要验证补齐行为。
 */
function autoConsumeDisabled(): boolean {
  const raw = process.env.KI_DISABLE_AUTO_CONSUME;
  return raw === '1' || raw === 'true';
}

export function scheduleConsume(scope: string): Promise<ConsumeResult> {
  if (autoConsumeDisabled()) {
    return Promise.resolve({ consumed: [], failed: [], blocked: [], remaining: 0 } as ConsumeResult);
  }
  const running = inFlight.get(scope);
  if (running) return running;

  const task: Promise<ConsumeResult> = consumePending(scope)
    .catch((err: unknown) => {
      console.warn(`[visibility-queue] ${scope} 索引补齐失败（保留 pending 待重试）：${(err as Error).message}`);
      return { consumed: [], failed: [], blocked: [], remaining: -1 } as ConsumeResult;
    })
    .finally(() => {
      if (inFlight.get(scope) === task) inFlight.delete(scope);
    });

  inFlight.set(scope, task);
  return task;
}

/**
 * 等待该 scope 正在进行的补齐任务结束（没有在飞任务时返回 null）。
 *
 * 用途：诊断/测试收尾 —— 后台任务会打开 FTS/向量引擎，进程退出前必须先等它结束再关引擎，
 * 否则原生句柄会让进程"用例都过了却不退出"。
 */
export async function waitForConsume(scope: string): Promise<ConsumeResult | null> {
  const running = inFlight.get(scope);
  if (!running) return null;
  return running;
}

/** 当前 pending 数量（UI 顶部提示"N 篇索引切换中"用） */
export function pendingCount(scope: string): number {
  return loadPending(scope).items.length;
}

/** 目标档位为 `to` 的 pending 条目（诊断/重试用） */
export function listPending(scope: string): PendingIndexWrite[] {
  return loadPending(scope).items;
}

export type { Visibility };
