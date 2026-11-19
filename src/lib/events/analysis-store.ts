/**
 * analysis-store.ts —— 事件源码分析存储（REQ-20261113-003 · S-03）
 *
 * 落点：`{scope}/.events/{eventId}.analysis.json`
 *
 * ═══ 关键不变量 ═══
 * 1. **分文件独立存储**：不写入 `{eventId}.json`，避免后台异步分析与流转/改描述并发覆盖。
 * 2. **不占 KB scope 写锁**：锁键使用 `\0analysis:<hash>`（独立于 `<scope>` 锁），
 *    因此分析任务读写草稿绝不阻塞同 scope 知识库导入/写入（Q6 拍板）。
 * 3. **局部更新 + `runId` 守卫**：后台进度与终态写盘前必须在短锁内重读磁盘并校验
 *    `doc.draft?.runId === runId`，且只更新 `draft`，原样保留并发写入的 `confirmed[]`。
 * 4. **重启僵尸恢复**：携带当前进程 `CURRENT_BOOT_ID`，读取时若发现 `running` 任务
 *    不属当前活跃集合且跨进程或超 120s，立即归一为 `failed (INTERRUPTED)` 允许重跑。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getEventsDir } from './store.js';
import { readJson } from '../store.js';
import { walWrite } from '../wal.js';
import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import { normalizeChain } from './conclusion-chain.js';
import type {
  AnalysisDraft,
  ConfirmedCodeLocation,
  EventAnalysisDoc,
} from './types.js';

export const CURRENT_BOOT_ID = crypto.randomUUID();
const ZOMBIE_TIMEOUT_MS = 120_000;

export function getAnalysisPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.analysis.json`);
}

function analysisLockKey(scope: string, eventId: string): string {
  const hash = crypto.createHash('sha256').update(`${scope}\0${eventId}`).digest('hex').slice(0, 24);
  return `\u0000analysis:${hash}`;
}

export async function withAnalysisLock<T>(scope: string, eventId: string, operation: string, fn: () => Promise<T>): Promise<T> {
  return withScopeWriteLock(analysisLockKey(scope, eventId), operation, fn);
}

function emptyDoc(eventId: string): EventAnalysisDoc {
  return { version: 1, eventId, draft: null, confirmed: [], updatedAt: 0 };
}

export function readAnalysisDocRaw(scope: string, eventId: string): EventAnalysisDoc {
  try {
    const raw = readJson<EventAnalysisDoc>(getAnalysisPath(scope, eventId));
    if (!raw || typeof raw !== 'object') return emptyDoc(eventId);
    return {
      version: 1,
      eventId,
      draft: raw.draft && typeof raw.draft === 'object' ? raw.draft : null,
      confirmed: Array.isArray(raw.confirmed) ? raw.confirmed : [],
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch (err) {
    console.warn(`[analysis] 分析文件损坏，按空处理（${eventId}）：${(err as Error).message}`);
    return emptyDoc(eventId);
  }
}

export function normalizeAnalysisDocForRead(
  doc: EventAnalysisDoc,
  isActive: boolean,
  now = Date.now(),
): EventAnalysisDoc {
  const d = doc.draft;
  if (!d) return doc;
  /*
   * 字段归一必须在下面那句早退**之前**（历史文件 ready/partial 100% 走早退，
   * 插在僵尸分支里等于只修了 running 的文件）；但**不能 return** ——
   * 否则僵尸 running 的恢复逻辑会被跳过（曾因此让「跨进程僵尸态」测试变红）。
   */
  const rawChain = (d as { chain?: unknown }).chain;
  const chain = normalizeChain(rawChain);
  const conclusionOk = typeof (d as { conclusion?: unknown }).conclusion === 'string';
  /*
   * 历史文件兼容（2026-11-19 引入 chain）：
   * - 旧文件没有 `chain` → 归一为 `[]`，前端回退渲染 `conclusion` 纯文本；
   * - `chain` 是数组但含非法项 → 重新归一（长度变化即判定需要替换）。
   * 两者都"没有变化"时保留原对象引用，避免每次读盘都造新对象
   * （下游有 `normalized === d` 的早退判断，破坏它等于让所有读取都走慢路径）。
   */
  const chainOk = Array.isArray(rawChain) && chain.length === rawChain.length;
  const normalized = conclusionOk && chainOk
    ? d
    : {
      ...d,
      conclusion: conclusionOk ? d.conclusion : null,
      chain: chainOk ? d.chain : chain,
    };
  const withNormalized = (draft: typeof d) => (normalized === d ? doc : { ...doc, draft });

  if (normalized.status !== 'running' || isActive) return withNormalized(normalized);
  const staleProcess = normalized.bootId !== undefined && normalized.bootId !== CURRENT_BOOT_ID;
  const timedOut = now - (normalized.updatedAt || normalized.startedAt) > ZOMBIE_TIMEOUT_MS;
  if (!staleProcess && !timedOut) return withNormalized(normalized);
  return {
    ...doc,
    draft: {
      ...normalized,
      status: 'failed',
      errorCode: 'ANALYSIS_INTERRUPTED',
      errorMessage: '服务已重启或分析任务意外中断，请重新发起分析',
      /*
       * 僵尸态也是"分析已经死了"：不清实时思考的话，前端会拿一个永远转圈的
       * 「思考中」展示一段再也不会增长的文本（2026-11-18 增量落盘引入）。
       * 已完成的轮次仍在 steps 里，信息不丢。
       */
      liveThinking: undefined,
    },
  };
}

function writeAnalysisDoc(scope: string, doc: EventAnalysisDoc): void {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  walWrite(getAnalysisPath(scope, doc.eventId), doc as unknown as Record<string, unknown>);
}

/** 启动分析前在短锁内写入 `running` 草稿（保留已有 `confirmed[]`） */
export async function writeDraftStart(
  scope: string,
  eventId: string,
  draft: AnalysisDraft,
): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-start', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: { ...draft, bootId: CURRENT_BOOT_ID },
      confirmed: cur.confirmed,
      updatedAt: draft.startedAt,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/** 后台更新草稿进度或终态：仅当磁盘 `draft.runId` 匹配时更新 `draft`，绝不覆盖并发 `confirmed[]` */
export async function updateDraftIfMatch(
  scope: string,
  eventId: string,
  runId: string,
  updater: (current: AnalysisDraft) => AnalysisDraft,
): Promise<EventAnalysisDoc | null> {
  return withAnalysisLock(scope, eventId, 'analysis-update', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    if (!cur.draft || cur.draft.runId !== runId) return null;
    const updatedDraft = updater(cur.draft);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: updatedDraft,
      confirmed: cur.confirmed,
      updatedAt: updatedDraft.updatedAt,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/** 勾选确认候选写入 `confirmed`（带 `expectedRunId` 防双标签重跑错绑，按 `file+line` 去重） */
export async function confirmDraftLocations(
  scope: string,
  eventId: string,
  args: { candidateIds: string[]; expectedRunId?: string; discardDraft?: boolean },
  now = Date.now(),
): Promise<{ added: number; doc: EventAnalysisDoc }> {
  return withAnalysisLock(scope, eventId, 'analysis-confirm', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    if (!cur.draft) {
      throw new GovernanceError('ANALYSIS_DRAFT_NOT_FOUND', '当前没有可确认的分析草稿');
    }
    if (args.expectedRunId && cur.draft.runId !== args.expectedRunId) {
      throw new GovernanceError('REVISION_CONFLICT', '分析草稿已被新一轮分析更新，请刷新后重新确认');
    }
    const wanted = new Set(args.candidateIds);
    const existingKeys = new Set(cur.confirmed.map((c) => `${c.file}\0${c.line}`));
    const additions: ConfirmedCodeLocation[] = [];

    for (const cand of cur.draft.candidates) {
      if (!wanted.has(cand.id)) continue;
      const key = `${cand.file}\0${cand.line}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push({
        id: `loc_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        file: cand.file,
        line: cand.line,
        ...(cand.endLine !== undefined ? { endLine: cand.endLine } : {}),
        snippet: cand.snippet,
        why: cand.why,
        confidence: cand.confidence,
        targetDir: cur.draft.targetDir,
        commit: cur.draft.commit,
        confirmedAt: now,
      });
    }

    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: args.discardDraft ? null : cur.draft,
      confirmed: [...cur.confirmed, ...additions],
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return { added: additions.length, doc: next };
  });
}

export async function discardAnalysisDraft(scope: string, eventId: string, now = Date.now()): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-discard', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: null,
      confirmed: cur.confirmed,
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

export async function removeConfirmedLocation(
  scope: string,
  eventId: string,
  locId: string,
  now = Date.now(),
): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-remove-loc', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const filtered = cur.confirmed.filter((c) => c.id !== locId);
    if (filtered.length === cur.confirmed.length) {
      throw new GovernanceError('ANALYSIS_LOCATION_NOT_FOUND', `代码位置「${locId}」不存在`);
    }
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: cur.draft,
      confirmed: filtered,
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

export function removeAnalysisFile(scope: string, eventId: string): void {
  try {
    fs.rmSync(getAnalysisPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[analysis] 删除分析文件失败 ${eventId}: ${(err as Error).message}`);
  }
}
