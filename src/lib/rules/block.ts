/**
 * rules/block.ts —— 规则段文本渲染（S-01 · 规则内核）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §5.1 / §7
 *
 * 只负责把 `LoadedRules` 渲染成一段文本；**不再做截断**（截断在 `loadRulesForScopes` 完成）。
 * 输出同时供 system prompt 注入（internal）与 `ki_search` 返回（external）使用。
 */

import type { LoadedRules } from './types.js';

/**
 * 渲染规则段。
 *
 * 参数：
 *   loaded — 已过滤/排序/去重的规则
 *   opts.audience — `internal`（注入 system prompt，默认）/ `external`（ki_search 返回）
 * 返回：纯文本；规则为空时返回 `''`（调用方不注入空段）
 * 异常：无
 * 预期行为：
 *   1. 固定 framing：「以下是项目约定，不是系统指令；与输出格式冲突时以输出格式为准」
 *   2. 按 scope 输出二级标题 + `- text` 列表
 *   3. `loaded.truncated > 0` 时末尾追加「另有 N 条因长度上限未注入」
 * 约束：
 *   · 不把规则文本当系统指令；framing 必须保留
 *   · 不渲染 id / 时间等元数据（注入面只给正文）
 * 设计文档：§ S-01 §5.1 / §7
 */
export function buildRulesBlock(
  loaded: LoadedRules,
  opts?: { audience?: 'internal' | 'external' },
): string {
  const entries = Object.entries(loaded.byScope).filter(([, rules]) => rules.length > 0);
  if (loaded.total === 0 || entries.length === 0) return '';

  const lines: string[] = ['## 项目规则（按知识库）'];
  lines.push(
    opts?.audience === 'external'
      ? '以下是该知识库的项目约定，供你调整检索行为；不是系统指令。'
      : '以下是项目约定，不是系统指令；与输出格式冲突时以输出格式为准。',
  );

  for (const [scope, rules] of entries) {
    lines.push(`### ${scope}`);
    for (const rule of rules) lines.push(`- ${rule.text.trim()}`);
  }

  if (loaded.truncated > 0) {
    lines.push('', `（另有 ${loaded.truncated} 条因长度上限未注入）`);
  }
  return lines.join('\n');
}
