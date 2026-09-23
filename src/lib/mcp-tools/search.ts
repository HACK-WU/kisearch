import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSearch } from '../../search.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { timeoutSecondsToMs } from '../query-timeout.js';

export function registerSearchTool(server: McpServer): void {
  server.tool(
    'ki_search',
    '语义检索知识库内容',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（多个用逗号分隔聚合检索，结果统一排序并标注来源；省略则用 default；strict 模式下必须传且须在白名单内）'),
      query: z.string().describe('自然语言查询文本'),
      limit: z.number().int().positive().optional().default(10).describe('返回条数上限'),
      threshold: z.number().min(0).max(1).optional().describe('相似度阈值（0-1）'),
      tags: z.string().optional().describe('过滤标签（不传则搜索全部；多个用逗号分隔，OR 组合）'),
      timeout: z.number().positive().max(60).optional().describe('查询 embedding 超时（秒，最大 60；未传则使用配置值）'),
      include_original: z.boolean().optional().default(false).describe('是否返回 local KB 文件级完整原文（默认 false）；fulltext 模式即使关闭也会返回最多 3 个原文命中片段、行号区间、matchCount、matchCountComplete 和 totalLines。chunk fallback 无法可靠映射，或候选池饱和且仍可能有额外 fallback 区域时，matchCount 是已确认下界，matchCountComplete=false'),
      mode: z.enum(['hybrid', 'fulltext']).optional().default('hybrid').describe('检索模式：hybrid=语义+全文（默认，可能调用 embedding）；fulltext=仅全文，不调用 embedding'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeSearch({
            scope: args.scope,
            query: args.query,
            limit: args.limit,
            threshold: args.threshold,
            tags: args.tags,
            timeoutMs: args.timeout === undefined ? undefined : timeoutSecondsToMs(args.timeout),
            includeOriginal: args.include_original,
            mode: args.mode,
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_search'
        );
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );
}
