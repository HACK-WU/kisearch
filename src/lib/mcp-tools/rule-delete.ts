/**
 * rule-delete.ts —— `ki_rule_delete`（S-04）
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S04_AGENT_DESIGN.md` §4.2
 *
 * 只删 AI 池：命中人工规则 → `RULE_NOT_AI`；定位用 id 或精确 text（二选一）。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { RulesError, deleteAiRule } from '../rules/index.js';
import { actorOf, resolveRuleTarget, rulesFail, rulesOk } from './rule-helpers.js';

const DESCRIPTION = '删除一条由 Agent 写入的 AI 规则（人工规则不能通过 MCP 删除）。'
  + '优先用 id；也可以传精确 text。修改规则 = 先删除再 ki_rule_add。';

export function registerRuleDeleteTool(server: McpServer, principalKey: string): void {
  server.tool(
    'ki_rule_delete',
    DESCRIPTION,
    {
      scope: z.string().min(1).describe('物理知识库名（不接受视图名）'),
      id: z.string().optional().describe('规则 id（优先）；与 text 二选一'),
      text: z.string().min(1).max(200).optional().describe('规则正文精确匹配；与 id 二选一'),
    },
    async (args) => {
      try {
        const hasId = typeof args.id === 'string' && args.id.trim().length > 0;
        const hasText = typeof args.text === 'string' && args.text.trim().length > 0;
        if (hasId === hasText) {
          throw new RulesError('RULE_TARGET_INVALID', '删除规则必须且只能提供 id 或 text 之一');
        }

        const config = loadConfig();
        const target = resolveRuleTarget(config, args.scope, { allowView: false });
        const deleted = deleteAiRule(
          config,
          {
            scope: target.scope,
            ...(hasId ? { id: args.id!.trim() } : {}),
            ...(hasText ? { text: args.text!.trim() } : {}),
          },
          actorOf(principalKey),
        );
        return rulesOk({ deleted: { id: deleted.id, scope: deleted.scope, text: deleted.text } });
      } catch (err) {
        return rulesFail(err);
      }
    },
  );
}
