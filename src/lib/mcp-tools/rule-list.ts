/**
 * rule-list.ts —— `ki_rule_list`（S-04）
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S04_AGENT_DESIGN.md` §4.3
 *
 * 只读工具：允许视图并集；默认不含已过期人工规则。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { readRules, type RuleRecord } from '../rules/index.js';
import {
  isRuleExpired,
  resolveRuleTarget,
  ruleUsage,
  rulesFail,
  rulesOk,
  toToolRule,
} from './rule-helpers.js';

const DESCRIPTION = '列出指定知识库当前的规则（人工 + AI），用于删除前确认规则 id 与正文；'
  + '视图返回成员并集。只读，不消耗模型，只读 Token 也可调用。';

function orderRules(a: RuleRecord, b: RuleRecord): number {
  if (a.source !== b.source) return a.source === 'human' ? -1 : 1;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function registerRuleListTool(server: McpServer): void {
  server.tool(
    'ki_rule_list',
    DESCRIPTION,
    {
      scope: z.string().min(1).describe('知识库名或视图名；视图返回成员并集'),
      include_expired: z.boolean().optional().default(false).describe('是否包含已过期的人工规则，默认 false'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const target = resolveRuleTarget(config, args.scope, { allowView: true });
        const file = readRules(config);

        const rules = file.rules
          .filter((rule) => target.members.includes(rule.scope))
          .filter((rule) => args.include_expired || !isRuleExpired(rule))
          .sort(orderRules)
          .map(toToolRule);

        return rulesOk({
          scope: target.scope,
          isView: target.isView,
          members: target.isView ? target.members : [],
          usage: target.isView ? null : ruleUsage(config, target.scope),
          rules,
        });
      } catch (err) {
        return rulesFail(err);
      }
    },
  );
}
