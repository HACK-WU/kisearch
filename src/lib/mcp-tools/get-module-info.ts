import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getModuleInfoByScope } from '../get-module-info-view.js';
import { TOOL_TIMEOUT } from './util.js';

export function registerGetModuleInfoTool(server: McpServer): void {
  server.tool(
    'ki_get_module_info',
    '读取指定 Group 下某个/多个 Relation 的本地 KB Markdown 内容（批量 ≤10 条，须同 Group）。默认返回全文；超长文档可传 max_chars 分页，按返回的 nextStart 续读',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图模式下若同一文档存在于多个成员库，需配合 member 指定来源库；省略则用 default）'),
      group: z.string().describe('Group 路径（支持向量语义兜底）'),
      relation: z.string().optional().describe('Relation 名称（精确匹配）。单条查询用；与 relations 二选一'),
      relations: z.array(z.string()).max(10).optional().describe('同 Group 下批量查询（≤10 条，超限报错），逐条返回 results（部分失败不影响其他）。与 relation 二选一'),
      member: z.string().optional().describe('视图模式下指定来源知识库（同一 group+relation 在多个库都存在时必填；批量查询在视图模式下也必须指定）'),
      start_line: z.number().int().optional().describe('分段读取：起始行（1-based，默认 1）。需配合 max_chars；与 relations 互斥'),
      start_char: z.number().int().optional().describe('分段读取：起始行内字符偏移（默认 0）。仅当上次返回的 nextStart.char > 0 时需要'),
      max_chars: z.number().int().optional().describe('分段读取：本次正文的字符上限（不传 = 返回全文）。长文档读不全时用它分页，按返回的 nextStart 续读；批量时该上限按条数均分'),
    },
    async (args) => {
      try {
        if (args.relation && args.relations) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'relation 与 relations 只能二选一：单条用 relation，批量（≤10 条）用 relations' }],
          };
        }
        if (!args.relation && !args.relations) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'relation 与 relations 必须二选一传入' }],
          };
        }
        if (args.relations && (args.start_line !== undefined || args.start_char !== undefined)) {
          return {
            isError: true,
            content: [{ type: 'text', text: '批量查询不支持 start_line / start_char：批量只能整体从文首返回。需要分段读取请改用单条 relation' }],
          };
        }
        /**
         * 分段参数：**不传 `max_chars` 就完全不上报**，返回体与引入分页前逐字节一致
         * （外部 MCP 通道没有 token 预算，不该被静默降级成只能拿片段）。
         */
        const page = {
          ...(args.start_line !== undefined ? { startLine: args.start_line } : {}),
          ...(args.start_char !== undefined ? { startChar: args.start_char } : {}),
          ...(args.max_chars !== undefined ? { maxChars: args.max_chars } : {}),
        };

        /**
         * 视图展开统一交给 `getModuleInfoByScope`（CLI / 对话侧共用）：
         * 显式 member 优先 → 逐库探测 → 唯一命中才返回 → 多命中 fail-loud 列候选。
         */
        const outcome = await getModuleInfoByScope({
          scope: args.scope,
          group: args.group,
          relation: args.relation,
          relations: args.relations,
          member: args.member,
          page,
          timeout: { ms: TOOL_TIMEOUT.READ, label: 'ki_get_module_info' },
        });

        switch (outcome.kind) {
          case 'single': {
            // 视图唯一命中时把来源库一并告诉调用方（同一份文档在别的库可能另有版本）
            const payload = outcome.member
              ? { ...(outcome.result as Record<string, unknown>), member: outcome.member }
              : outcome.result;
            return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
          }
          case 'view-empty':
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  view: outcome.view,
                  error: `视图 ${outcome.view} 没有可用的成员库`,
                  skipped: outcome.skipped,
                }, null, 2),
              }],
            };
          case 'bad-member':
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `--member "${outcome.member}" 不是视图 ${outcome.view} 的成员。该视图的成员：${outcome.members.join('、')}`,
              }],
            };
          case 'batch-needs-member':
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `视图模式下批量查询必须指定 member（候选库：${outcome.candidates.join('、')}）。`
                  + '如需跨库查询，请改为逐个库调用。',
              }],
            };
          case 'ambiguous':
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  view: outcome.view,
                  error: `该文档在视图 ${outcome.view} 的多个知识库中同时存在，请用 member 指定来源库。`,
                  candidates: outcome.candidates,
                }, null, 2),
              }],
            };
          case 'not-found': {
            const payload = {
              ok: false,
              view: outcome.view,
              error: `在视图 ${outcome.view} 的 ${outcome.searched.length} 个成员库中均未找到该文档。`,
              searched: outcome.searched,
              ...(outcome.failures.length > 0
                ? { failed: outcome.failures, hint: '部分成员库读取失败（非"文档不存在"），见 failed 明细' }
                : {}),
            };
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
          }
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );
}
