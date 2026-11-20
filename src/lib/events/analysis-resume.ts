/**
 * 分析断点续跑（2026-11-20 · 用户选择「真续跑」）。
 *
 * 为什么单独落一个文件：模型上下文（`messages`，含工具响应正文）与 `.analysis.json`
 * 的生命周期不同 —— 前者只在「还在跑 / 被中断」时有意义，收尾即应删除；后者是产物，
 * 要长期保留。混在一起会让读盘与列表带上几 MB 无关负载。
 *
 * 三条硬约束：
 *   1. **写盘绝不打断分析**：任何 IO 异常都吞掉（分析比续跑重要）；
 *   2. **体积有上限**：超过 `RESUME_MAX_BYTES` 就裁剪最旧的轮次（保留 system + 首条 user
 *      + 最近若干条），宁可少恢复几轮，也不让单个文件涨到几十 MB；
 *   3. **过期即失效**：超过 `RESUME_TTL_MS` 直接删除 —— 一周前的上下文对今天没价值，
 *      而且源码可能已经变了，接着跑只会给出过期结论。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ChatTurn } from '../chat/llm-client.js';
import { getEventsDir } from './store.js';
import type { AnalysisStepRecord } from './types.js';

/** 单文件上限：超过就裁旧轮次（工具响应正文是主要体积来源） */
export const RESUME_MAX_BYTES = 8 * 1024 * 1024;
/** 超过这个时长未继续 → 视为过期，读时删除 */
export const RESUME_TTL_MS = 7 * 24 * 3600 * 1000;
/** 裁剪时至少保留的最近消息条数（一轮工具交换通常 2~4 条） */
const KEEP_TAIL_MESSAGES = 24;
/** 裁剪时保留的最近 steps 条数（steps 本身已是截断版，但仍可能几千条） */
const KEEP_TAIL_STEPS = 120;

export interface ResumeState {
  version: 1;
  eventId: string;
  runId: string;
  /** 已完成的轮次（恢复后从这里继续编号） */
  round: number;
  turns: number;
  tokens: number;
  /** 跨重启累计的模型耗时（毫秒）：`stats.ms` 用它，避免把停机时间也算进去 */
  elapsedMs: number;
  /** 完整模型上下文：system + user + 历次 assistant/tool 消息 */
  messages: ChatTurn[];
  steps: AnalysisStepRecord[];
  /** 已读文件清单：恢复后统计与去重继续生效 */
  filesRead: string[];
  startedAt: number;
  updatedAt: number;
}

export function resumeFilePath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.analysis.resume.json`);
}

/** 读断点；不存在 / 过期 / 损坏 / 形状不符一律返回 null（并顺手删掉坏的） */
export function readResume(scope: string, eventId: string): ResumeState | null {
  const file = resumeFilePath(scope, eventId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ResumeState;
    const usable = parsed
      && parsed.version === 1
      && parsed.eventId === eventId
      && typeof parsed.runId === 'string'
      && Array.isArray(parsed.messages)
      && parsed.messages.length > 0
      && Array.isArray(parsed.steps);
    if (!usable) {
      clearResume(scope, eventId);
      return null;
    }
    if (Date.now() - (parsed.updatedAt || 0) > RESUME_TTL_MS) {
      clearResume(scope, eventId);
      return null;
    }
    return parsed;
  } catch {
    clearResume(scope, eventId);
    return null;
  }
}

/** 是否存在可继续的断点（只看存在性与新鲜度，不解析正文） */
export function hasResume(scope: string, eventId: string): boolean {
  try {
    const stat = fs.statSync(resumeFilePath(scope, eventId));
    return Date.now() - stat.mtimeMs <= RESUME_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * 落断点。调用方只需准备好内容，裁剪与异常吞掉都在这里做。
 * 返回是否真正写成功（测试与日志用）。
 */
export function writeResume(scope: string, eventId: string, state: ResumeState): boolean {
  const file = resumeFilePath(scope, eventId);
  let payload = state;
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > RESUME_MAX_BYTES) {
    payload = trimResume(state);
    text = JSON.stringify(payload);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再 rename：避免进程在写一半时被杀，留下半截 JSON 被当成有效断点
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 丢掉最旧的轮次：保留 system + 首条 user，其余从尾部截取 */
function trimResume(state: ResumeState): ResumeState {
  const [head, firstUser, ...rest] = state.messages;
  const keepHead = head ? [head] : [];
  const keepUser = firstUser ? [firstUser] : [];
  const tail = rest.slice(-KEEP_TAIL_MESSAGES);
  return {
    ...state,
    messages: [...keepHead, ...keepUser, ...tail],
    steps: state.steps.slice(-KEEP_TAIL_STEPS),
    // 裁剪后轮次编号不可信 —— 标成已裁剪，恢复时只用于展示「第 N 轮」的下界
    round: Math.max(1, state.round),
  };
}

export function clearResume(scope: string, eventId: string): void {
  const file = resumeFilePath(scope, eventId);
  try {
    fs.unlinkSync(file);
  } catch {
    // 删不掉不能影响主流程；改名让路一次，避免长期占位（同 scope-write-lock 的处理）
    try { fs.renameSync(file, `${file}.stale`); } catch { /* ignore */ }
  }
}
