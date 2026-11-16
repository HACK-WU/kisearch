/**
 * importProgress.ts —— 导入进度快照（跨组件只读订阅）。
 *
 * 为什么需要它（REQ-20261116-002）：合并页里 tab 条渲染在**写入页**一侧，而导入进度是
 * `ImportPage` 的内部 state —— 用户在写入 tab 时导入页是 `display:none`，tab 条拿不到
 * `phase`，徽标就无从显示（而"切到写入 tab 后完全看不到导入在跑"正是合并带来的体验缺口）。
 *
 * 因此只把**最小的三个值**发布出来（阶段 / 百分比 / 目标库），不做事件总线：
 *   - 单向：只有 ImportPage 写，tab 条读；
 *   - 无历史：快照覆盖写，读到的永远是当前值；
 *   - 与 `theme.ts` / `codeLangPreference.ts` / chat store 同一套 `useSyncExternalStore` 形态。
 */

import { useSyncExternalStore } from 'react';
import type { ImportPhase } from './importPhase';

export interface ImportProgressSnapshot {
  phase: ImportPhase;
  /** 展示用百分比（来源同右轨：`activePercentOf`）；未知进度为 null */
  percent: number | null;
  scope: string;
}

const IDLE_SNAPSHOT: ImportProgressSnapshot = { phase: 'idle', percent: null, scope: '' };

let snapshot: ImportProgressSnapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 发布本次快照（值未变则不通知，避免每次渲染都触发订阅方重渲） */
export function publishImportProgress(next: Partial<ImportProgressSnapshot>): void {
  const merged: ImportProgressSnapshot = {
    phase: next.phase ?? snapshot.phase,
    percent: next.percent === undefined ? snapshot.percent : next.percent,
    scope: next.scope ?? snapshot.scope,
  };
  if (merged.phase === snapshot.phase && merged.percent === snapshot.percent && merged.scope === snapshot.scope) {
    return;
  }
  snapshot = merged;
  notify();
}

/** 当前快照（`useSyncExternalStore` 的 getSnapshot，必须是稳定引用） */
export function readImportProgress(): ImportProgressSnapshot {
  return snapshot;
}

export function subscribeImportProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件侧订阅 */
export function useImportProgress(): ImportProgressSnapshot {
  return useSyncExternalStore(subscribeImportProgress, readImportProgress, readImportProgress);
}
