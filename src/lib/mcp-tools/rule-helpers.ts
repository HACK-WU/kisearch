/**
 * rule-helpers.ts —— Agent 规则工具的公共小工具（S-04）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S04_AGENT_DESIGN.md` §4 / §5 / §7
 *
 * 只做：scope 形态校验、规则视图化、错误外壳、AI 用量统计。
 * 不做：权限判定（mcp-http 负责）、写锁（内核负责）。
 */

import type { KiConfig } from '../config.js';
import { readViews } from '../scope-view.js';
import { listAllScopes } from '../scope.js';
import {
  AI_SOFT_CAP,
  MAX_INJECT_CHARS,
  RulesError,
  readRules,
  type RuleRecord,
} from '../rules/index.js';

export interface RuleTarget {
  scope: string;
  isView: boolean;
  members: string[];
}

export interface ToolRule {
  id: string;
  scope: string;
  text: string;
  source: 'human' | 'ai';
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  expired: boolean;
}

export function actorOf(principalKey: string): string {
  return principalKey === 'local' ? 'local' : `token:${principalKey}`;
}

export function isRuleExpired(rule: RuleRecord): boolean {
  if (rule.source !== 'human' || rule.expiresAt === null) return false;
  const at = Date.parse(rule.expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

export function toToolRule(rule: RuleRecord): ToolRule {
  return { ...rule, expired: isRuleExpired(rule) };
}

function safeViews(config: KiConfig): ReturnType<typeof readViews> {
  try {
    return readViews(config);
  } catch {
    return {};
  }
}

/**
 * 解析规则工具的目标 scope。
 *
 * - 写工具：视图直接拒绝（`RULE_SCOPE_VIEW`），未知库 `RULE_SCOPE_UNKNOWN`
 * - 读工具：视图展开为成员列表
 */
export function resolveRuleTarget(
  config: KiConfig,
  rawScope: string,
  opts: { allowView: boolean },
): RuleTarget {
  const scope = rawScope.trim();
  if (!scope) throw new RulesError('RULE_SCOPE_UNKNOWN', 'scope 不能为空');

  const views = safeViews(config);
  if (Object.prototype.hasOwnProperty.call(views, scope)) {
    if (!opts.allowView) {
      throw new RulesError('RULE_SCOPE_VIEW', '视图不能直接写规则，请改传成员库名');
    }
    return { scope, isView: true, members: views[scope]!.members.slice() };
  }

  let known: string[] = [];
  try {
    known = listAllScopes();
  } catch {
    known = [];
  }
  if (!known.includes(scope)) {
    throw new RulesError('RULE_SCOPE_UNKNOWN', `知识库「${scope}」不存在`);
  }
  return { scope, isView: false, members: [scope] };
}

export interface RuleUsage {
  aiCount: number;
  aiLimit: number;
  humanChars: number;
  humanLimit: number;
}

export function ruleUsage(config: KiConfig, scope: string): RuleUsage {
  const file = readRules(config);
  let aiCount = 0;
  let humanChars = 0;
  for (const rule of file.rules) {
    if (rule.scope !== scope) continue;
    if (rule.source === 'ai') aiCount += 1;
    else humanChars += rule.text.length;
  }
  return { aiCount, aiLimit: AI_SOFT_CAP, humanChars, humanLimit: MAX_INJECT_CHARS };
}

export function rulesOk(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}

export function rulesFail(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  const code = err instanceof RulesError ? err.code : 'RULES_WRITE_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  const retryable = code === 'RULES_BUSY';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message, retryable }) }],
  };
}
