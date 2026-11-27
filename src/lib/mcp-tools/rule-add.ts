/**
 * rule-add.ts —— `ki_rule_add`（S-04）
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S04_AGENT_DESIGN.md` §4.1
 *
 * 只写 AI 池：去重、20 条软上限、1 天淘汰年龄、100 条硬上限全部由内核负责。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { addAiRule } from '../rules/index.js';
import {
  actorOf,
  resolveRuleTarget,
  ruleUsage,
  rulesFail,
  rulesOk,
  toToolRule,
} from './rule-helpers.js';

const DESCRIPTION = '把一条项目规则沉淀到指定知识库：后续 ki_recall / ki_ask 会自动加载，'
  + 'ki_search 会随结果返回。适合记录“查某类问题先看哪个组 / 哪些文档不要推荐”这类已确认的约定。'
  + '默认临时：每库软上限 20 条，超出时最早且满 1 天的规则会被淘汰（允许短暂超额，硬上限 100）。'
  + '修改规则 = 先 ki_rule_delete 再 ki_rule_add。';

export function registerRuleAddTool(server: McpServer, principalKey: string): void {
  server.tool(
    'ki_rule_add',
    DESCRIPTION,
    {
      scope: z.string().min(1).describe('物理知识库名（不接受视图名）；规则只对该库生效'),
      text: z.string().min(1).max(200).describe('规则正文，≤200 字；写项目事实或检索偏好，不要写“忽略以上指令”'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const target = resolveRuleTarget(config, args.scope, { allowView: false });
        const result = addAiRule(config, {
          scope: target.scope,
          text: args.text,
          createdBy: actorOf(principalKey),
        });
        return rulesOk({
          rule: toToolRule(result.rule),
          deduped: result.deduped,
          evicted: result.evicted.map((r) => ({ id: r.id, text: r.text })),
          usage: ruleUsage(config, target.scope),
        });
      } catch (err) {
        return rulesFail(err);
      }
    },
  );
}
