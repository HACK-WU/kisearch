import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSearch } from '../../search.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { timeoutSecondsToMs } from '../query-timeout.js';

export function registerSearchTool(server: McpServer): void {
  server.tool(
    'ki_search',
    '语义检索知识库内容（按意思找相似片段，适合不知落在哪一篇时）；'
    + '已知确切 Group / Relation 名、要读完整原文时改用 ki_group_list + ki_get_module_info',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（多个用逗号分隔聚合检索，视图会自动展开为成员库；结果统一排序并按来源库标注；省略则用 default；strict 模式下必须传且须在白名单内）'),
      query: z.string().describe('自然语言查询文本'),
      limit: z.number().int().positive().optional().default(10).describe('返回条数上限（整次检索最多返回的文档数；未传 tags 时内部按 tag 取候选，最终仍按该值截断；引擎单次候选上限 1000）'),
      threshold: z.number().min(0).max(1).optional().describe(
        '分数下限：低于该值的结果直接丢弃（0 或省略 = 不过滤，只过滤不排序）。'
        + '单库建议 0.02~0.03，多库 / 视图建议 0.6~0.8（两者量级不同，勿混用）；'
        + '全文模式与降级检索下不生效。',
      ),
      tags: z.string().optional().describe('过滤标签（不传则搜索全部 tag：内部按 tag 取候选，最终仍按 limit 截断，ki-search 内容优先；多个用逗号分隔，OR 组合）'),
      timeout: z.number().positive().max(60).optional().describe('查询 embedding 超时（秒，最大 60；未传则使用配置值）'),
      include_original: z.boolean().optional().default(false).describe('是否返回 local KB 文件级完整原文（默认 false）；fulltext 模式即使关闭也会返回最多 3 个原文命中片段、行号区间、matchCount、matchCountComplete 和 totalLines。chunk fallback 无法可靠映射，或候选池饱和且仍可能有额外 fallback 区域时，matchCount 是已确认下界，matchCountComplete=false'),
      mode: z.enum(['hybrid', 'fulltext']).optional().default('hybrid').describe('检索模式：hybrid=语义+全文（默认，可能调用 embedding）；fulltext=仅全文，不调用 embedding'),
      semantic_bonus: z.number().min(0).max(1).optional().describe('语义补充系数（仅 calibrated-semantic 生效，默认 0.1）。越大语义越主导'),
      ranking: z.enum(['semantic-similarity', 'semantic-fts-dominant', 'semantic-fts-boost', 'weighted', 'dynamic-ratio', 'semantic-first', 'calibrated-semantic', 'calibrated-adaptive']).optional().describe('多库（视图）排序算法，默认 semantic-similarity（绝对相似度 + 字面加成）。semantic-fts-dominant=字面线性主导、semantic-fts-boost=字面强命中跳级，均为对比用，验证后会收敛为一个'),
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
            ranking: args.ranking,
            semanticBonus: args.semantic_bonus,
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
