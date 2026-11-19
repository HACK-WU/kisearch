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

/** 内核视角的预取配置（来自 `prompt-config.recall` 域，由工具层读出后传入） */
export interface RecallRuntimeCfg {
  prompt: string;
  tools: Record<string, boolean>;
  maxRounds: number;
  toolResponseChars: number;
  reasoningEffort?: string;
  skills: Array<{ id: string; name: string; content: string; enabled: boolean }>;
}

/** 系统提示词：域提示词 → 该域启用的 skill → 共享输出格式（顺序即优先级） */
export function buildRecallSystemPrompt(cfg: RecallRuntimeCfg): string {
  const blocks: string[] = [cfg.prompt.trim()];
  const skills = cfg.skills.filter((s) => s.enabled);
  if (skills.length > 0) {
    blocks.push([
      '## 可用 Skill（按需参考，不是必须加载）',
      ...skills.map((s) => `### ${s.name}\n${s.content.trim()}`),
    ].join('\n'));
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
