import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeEditRelation } from '../../edit-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerEditRelationTool(server: McpServer): void {
  server.tool(
    'ki_edit_relation',
    '局部修改已有的大 Relation：edit 可多轮、每轮同时修改多个不重叠行区间（行号从 1 开始且包含 end_line，以当前草稿版本为准）；view 查看草稿/发布状态；finish 提交终稿并一次性更新向量/全文索引、清理旧索引；cancel 放弃尚未开始发布的草稿。'
    + '注意：finish 是异步的——返回 queued 后必须用 view 轮询到 published/failed（超时重试请沿用同一 request_id；view 的 published=true 表示正文已生效，finish 此时只做旧索引清理）。'
    + 'finish 会用草稿正文覆盖写回该 Relation 的源文件（若该 Group 配置了 wikiSync，会重写其 frontmatter 与正文，目标目录为空时还会自动补齐历史关系）。'
    + '小 Relation 建议直接用 ki_sync_relation 提交完整正文，更简单高效。',
    {
      action: z.enum(['edit', 'view', 'finish', 'cancel']).describe('edit 修改草稿；view 查询草稿/发布状态；finish 提交最终正文；cancel 放弃尚未发布的草稿'),
      scope: z.string().optional().default('default').describe('项目隔离标识'),
      group: z.string().optional().describe('精确 Group 路径；首次 edit 必填'),
      relation: z.string().optional().describe('精确 Relation 名称；首次 edit 必填'),
      edit_id: z.string().optional().describe('草稿 ID；后续 edit/view/finish/cancel 必填'),
      expected_revision: z.string().optional().describe('首次 edit 用 ki_get_module_info.revision，后续用草稿返回的 revision；finish 也需传当前草稿 revision'),
      edits: z.array(z.object({
        start_line: z.number().int().positive().describe('起始行，1-based'),
        end_line: z.number().int().positive().describe('结束行，包含此行'),
        new_text: z.string().describe('替换行的新正文；空字符串删除该行区间'),
      })).optional().describe('同批修改的多个不重叠区域，全部按调用前草稿行号定位'),
      request_id: z.string().optional().describe('finish 必填：调用方生成的幂等请求 ID，重试时沿用'),
      start_line: z.number().int().positive().optional().describe('view 可选：查看草稿的起始行'),
      end_line: z.number().int().positive().optional().describe('view 可选：查看草稿的结束行（包含）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(executeEditRelation({
          action: args.action,
          scope: args.scope,
          group: args.group,
          relation: args.relation,
          editId: args.edit_id,
          expectedRevision: args.expected_revision,
          edits: args.edits,
          requestId: args.request_id,
          startLine: args.start_line,
          endLine: args.end_line,
        }), args.action === 'cancel' ? TOOL_TIMEOUT.BULK : TOOL_TIMEOUT.WRITE, 'ki_edit_relation');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(!result.ok ? { isError: true } : {}) };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }
    },
  );
}
