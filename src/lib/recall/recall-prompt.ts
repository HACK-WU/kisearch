/**
 * `ki_recall` 侧的**消息构造**（2026-11-18 从内核拆出）。
 *
 * 为什么单独一层：通用内核只接受「系统提示词 + 用户消息」，不认识任何业务场景。
 * 场景差异（给用户看的事件查找 / 给 agent 用的任务预取）就落在这一层：
 *   · 系统提示词 = 该域的提示词 + 该域启用的 skill 正文 + 共享的输出格式
 *   · 用户消息   = 任务画像 + 强线索 + 已读清单 + 种子候选
 *
 * 将来 `find`（AI 查找）接同一内核时，只需再写一个同形状的构造器（事件 → 画像），
 * **不再复制一遍循环与工具执行**。
 */

import { GROUNDED_OUTPUT_SPEC } from './run-recall.js';
import type { RecallHit } from './types.js';

/** 内核视角的预取配置（来自 `prompt-config.find` 域，由工具层读出后传入） */
export interface RecallRuntimeCfg {
  prompt: string;
  tools: Record<string, boolean>;
  maxRounds: number;
  toolResponseChars: number;
  /**
   * 单次预取允许的工具调用次数上限（来自 `find.maxToolCalls`，缺省 `FIND_DEFAULT_TOOL_CALLS`）。
   *
   * 2026-11-25（A 方案）：页面「AI 查找 · 工具调用上限」与 MCP 的 `ki_recall` 是同一份配置，
   * 该值必须既**传给内核**（真截断）又**写进系统提示词**（让模型提前规划）——
   * 此前只存在于页面侧，MCP 预取落进内核唯一的「不限制」档。
   */
  maxToolCalls?: number;
  /**
   * 单次硬超时（毫秒；来自「AI 查找」域的 `find.timeoutMs`，默认 60s）。
   *
   * 与部署级上限 `config.recall.hardTimeoutMs` 取 `min` 后生效（2026-11-25 用户拍板）。
   */
  timeoutMs?: number;
  /**
   * 检索范围说明（2026-11-25 Q3/Q4）：默认范围 + 可换库/视图的清单。
   *
   * 由工具层按**本次实际授权**生成后注入 —— 它必须与运行期校验同源，
   * 否则模型会按提示词里的过时清单去试，然后吃一堆错误。
   */
  scopeNote?: string;
  /**
   * 规则段（S-02）：由 `loadRulesForScopes` + `buildRulesBlock` 生成，调用方传入。
   * 位置在 skill 之后、scopeNote 之前；为空时不插入。
   */
  rulesBlock?: string;
  reasoningEffort?: string;
  skills: Array<{ id: string; name: string; content: string; enabled: boolean }>;
}

/**
 * 检索范围说明（代码追加，不进用户可编辑的提示词）。
 *
 * 为什么要说给模型：scope 现在是「默认值 + 可自选」，但它不知道有哪些库、也不知道
 * 换错会怎样。不说明的结果是两种极端 —— 要么永远只用默认范围（自选能力白给），
 * 要么瞎猜库名反复撞错误。
 */
export function buildScopeNote(args: {
  /** 调用方传入并已鉴权的默认范围 */
  defaultTargets: string[];
  /** 是否允许模型自选（分析链路未接鉴权时传 false） */
  canSwitch: boolean;
  /** 授权范围内的可用库 */
  scopes: string[];
  /** 授权可见的视图（视图名 → 成员库） */
  views: Record<string, string[]>;
}): string {
  const lines = [
    '## 检索范围',
    `默认范围：${args.defaultTargets.length > 0 ? args.defaultTargets.join('、') : '（空）'}`
      + '（调用工具时不传 `scope` 就用它）。',
  ];
  if (!args.canSwitch) {
    lines.push('本次**不能**改变检索范围：所有工具都在默认范围内工作，不要给工具传 `scope`。');
    return lines.join('\n');
  }
  lines.push('你可以按问题需要换库 / 换视图：**每次调用都可以不同**，不传 `scope` 就回到默认范围。');
  if (args.scopes.length > 0) lines.push(`可用库：${args.scopes.join('、')}`);
  const views = Object.keys(args.views);
  if (views.length > 0) {
    lines.push(`可用视图：${views.map((n) => `${n}（= ${args.views[n]!.join(' + ')}）`).join('；')}`);
  }
  lines.push('传了不存在 / 无权访问的 scope 会直接报错并列出可用项，**不会**自动改用默认范围 —— 不要靠猜。');
  return lines.join('\n');
}

/**
 * 工具调用预算说明（「AI 查找」与「AI 预取」共用同一段文案）。
 *
 * 为什么非要说给模型：只硬截断的话，模型会把次数花在试探性检索上，撞墙后才被迫收口，
 * 候选质量明显下降；提前告知才能按「先定位、再读正文」的顺序分配次数。
 */
export function toolCallBudgetNote(maxToolCalls: number): string {
  return [
    '## 工具调用预算',
    `本次最多可以调用 ${maxToolCalls} 次工具（检索与读正文合计）。`,
    // 2026-11-25（Q1 拍板）：必须说明「上限 ≠ 必须用满」，否则模型会为了凑数做无意义检索
    '这是**上限，不是必须调用这么多次**：够用就尽早收口给结论，把次数留给真正读不准的文档。',
    '次数用尽后你会被要求立刻收口；先规划再动手，用最少的检索定位，不要用近似重复的检索反复试探。',
  ].join('\n');
}

/** 系统提示词：域提示词 → skill → 检索范围 → 工具预算 → 共享输出格式（顺序即优先级） */
export function buildRecallSystemPrompt(cfg: RecallRuntimeCfg): string {
  const blocks: string[] = [cfg.prompt.trim()];
  const skills = cfg.skills.filter((s) => s.enabled);
  if (skills.length > 0) {
    blocks.push([
      '## 可用 Skill（按需参考，不是必须加载）',
      ...skills.map((s) => `### ${s.name}\n${s.content.trim()}`),
    ].join('\n'));
  }
  if (cfg.rulesBlock && cfg.rulesBlock.trim()) blocks.push(cfg.rulesBlock.trim());
  if (cfg.scopeNote && cfg.scopeNote.trim()) blocks.push(cfg.scopeNote.trim());
  if (typeof cfg.maxToolCalls === 'number' && cfg.maxToolCalls > 0) {
    blocks.push(toolCallBudgetNote(cfg.maxToolCalls));
  }
  blocks.push(GROUNDED_OUTPUT_SPEC);
  return blocks.join('\n\n');
}

/** 用户消息：任务画像 / 强线索 / 已读清单 / 种子候选 */
export function buildRecallUserMessage(args: {
  task: string;
  hints?: string[];
  exclude?: string[];
  seed?: Array<Pick<RecallHit, 'scope' | 'group' | 'name'>>;
}): string {
  const lines: string[] = ['## 任务画像', args.task.trim()];
  const hints = args.hints ?? [];
  if (hints.length > 0) {
    lines.push('', '## 强线索', hints.map((h) => `- ${h}`).join('\n'));
  }
  const exclude = args.exclude ?? [];
  if (exclude.length > 0) {
    lines.push('', '## 已读清单（不要再推荐这些）', exclude.slice(0, 30).map((e) => `- ${e}`).join('\n'));
  }
  const seed = args.seed ?? [];
  if (seed.length > 0) {
    lines.push('', '## 种子候选（系统初筛，只是起点；必须读正文才知道是否真的相关）',
      seed.slice(0, 10).map((s) => `- ${s.scope} / ${s.group} / ${s.name}`).join('\n'));
  }
  lines.push('', '请开始：先读正文再判断，宁少勿滥。');
  return lines.join('\n');
}
