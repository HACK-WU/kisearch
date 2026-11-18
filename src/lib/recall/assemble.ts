/**
 * recall/assemble.ts —— 候选清单的「可读性装配」纯函数（S-01 §3.3 ⑩⑪）。
 *
 * 全部为纯函数（无 IO、无随机、无时间依赖），这样 S-02 的工具层只做编排，
 * 文案与排序口径可以单测钉死，不会出现「同一条候选两次跑出两种理由」。
 *
 * 三条契约：
 *   - `why` 必须能让调用方判断「凭什么推它」：命中线索 → 库内名次 → 同名提示，兜底「仅语义相近」；
 *   - `nextActions` 的参数必须**可直接执行**（视图名早已展开成物理库，这里不再兜底）；
 *   - `needMore` 是**数据不是反问**：告诉调用方缺哪个维度，由它自己决定要不要补。
 */

import {
  TOP_ACTIONS,
  WHY_MAX_CHARS,
  type NeedMoreItem,
  type NextAction,
  type RecallCandidate,
} from './types.js';

/** `ki_get_module_info` 单次读取的期望字符数（够定位，不至于把整篇归档灌进上下文） */
const ACTION_MAX_CHARS = 8000;

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 生成候选的一句话理由。
 *
 * @param args.matched 命中的线索词（按区分度排好序，取前 3 个）
 * @param args.rankInScope 1 = 该库内最高分
 * @param args.alsoIn 其他库里存在的同名文档（**必须来自已过可见性过滤的集合**）
 */
export function buildWhy(args: {
  matched: string[];
  rankInScope?: number;
  alsoIn?: string[];
  /** 该候选由哪一路检索召回：`terms` = 精确线索词（强），`blocks` = 语义块（弱） */
  via?: 'terms' | 'blocks';
  /** 该轮实际使用的线索词（仅 `via='terms'` 时用于生成「线索词：…」） */
  hitTerms?: string[];
}): string {
  const parts: string[] = [];
  const matched = args.matched.filter((m) => m.trim().length > 0);
  if (matched.length > 0) parts.push(`命中：${matched.slice(0, 3).join(' · ')}`);
  else if (args.via === 'terms' && args.hitTerms && args.hitTerms.length > 0) {
    // 文档名/路径里没出现线索词，但**是这些线索词把它检索出来的** —— 说清楚，别假称"命中正文"
    parts.push(`线索词：${args.hitTerms.slice(0, 3).join(' · ')}`);
  }
  if (args.rankInScope !== undefined && args.rankInScope > 0) {
    parts.push(args.rankInScope === 1 ? '本库第 1' : `本库第 ${args.rankInScope}`);
  }
  if (args.alsoIn && args.alsoIn.length > 0) {
    parts.push(`同名文档还出现在 ${args.alsoIn.join(' / ')}`);
  }
  return clip(parts.join(' · ') || '仅语义相近', WHY_MAX_CHARS);
}

/**
 * 建议的下一步读取动作（按候选顺序取前 N 条）。
 *
 * ⚠️ `candidate.scope` 必须已是物理库 —— 视图名在 `ki_get_module_info` 里读不到正文。
 */
export function buildNextActions(
  candidates: RecallCandidate[],
  limit: number = TOP_ACTIONS,
): NextAction[] {
  return candidates.slice(0, Math.max(0, limit)).map((c) => ({
    tool: 'ki_get_module_info' as const,
    args: { scope: c.scope, group: c.group, relation: c.name, max_chars: ACTION_MAX_CHARS },
    why: clip(c.why, WHY_MAX_CHARS),
  }));
}

/**
 * 缺失信息维度。**只报「任务画像缺什么」**，不报 scope（scope 必填且非法时走错误码）。
 *
 * @param args.candidateCount 本次产出的候选数（< 2 视为"可能描述不够具体"）
 */
export function buildNeedMore(args: {
  blocks: string[];
  tokens: string[];
  candidateCount: number;
  scopeCount: number;
}): NeedMoreItem[] {
  if (args.blocks.length === 0 && args.tokens.length === 0) {
    return [
      {
        field: 'symptom',
        hint: '任务描述里没有可检索的内容：补一句「什么现象 / 哪里报错 / 期望什么」后再调一次',
      },
    ];
  }
  if (args.candidateCount >= 2) return [];

  const items: NeedMoreItem[] = [];
  if (args.tokens.length === 0) {
    items.push({
      field: 'errorCode',
      hint: '补上错误码 / 接口名 / 文件路径（精确线索比自然语言描述有效得多）',
    });
  }
  items.push({
    field: 'module',
    hint: args.scopeCount > 1
      ? '补上涉及的模块或页面名（如「事件详情页」「导入链路」），可缩小跨库噪声'
      : '补上涉及的模块或页面名，或把范围扩到知识视图（一次查多个库）',
  });
  return items;
}
