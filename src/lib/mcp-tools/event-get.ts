/**
 * `ki_event_get` —— 单事件详情（只读）
 *
 * 与 `ki_event_list` 的分工：**list 用来找，get 用来读**。list 只给 `conclusionPreview`
 * （截 120 字）与位置预览，拿不到未确认点、参考文档、阶段日志；要判断"这条事件现在缺什么"
 * 必须走 get。
 *
 * 体积纪律（详见 `events/event-detail.ts` 文件头）：过程与候选正文不返回；每块带 `total`，
 * 截断时给 `note`；五个 limit 参数里任何一个传 0 就是不返回该块。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEventDetail } from '../events/event-detail.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

export function registerEventGetTool(server: McpServer): void {
  server.tool(
    'ki_event_get',
    '读取单条事件的完整详情（只读）：描述全文 / 类型与阶段链 / 当前阶段可见性 / 关联文档 / 参考文档 / '
      + 'AI 分析结论与未确认点 / 已确认代码位置 / 阶段日志。找事件用 ki_event_list，读事件用本工具',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）、#shortId（如 #3）或纯数字（3）'),
      members_limit: z
        .number().int().min(0).max(50).optional().default(20)
        .describe('关联文档返回条数，默认 20，上限 50；0 = 不返回该块（仍给 total）'),
      refs_limit: z
        .number().int().min(0).max(50).optional().default(20)
        .describe('参考文档返回条数，默认 20，上限 50；0 = 不返回该块（仍给 total）'),
      logs_limit: z
        .number().int().min(0).max(100).optional().default(20)
        .describe('阶段日志返回最近 N 条，默认 20，上限 100；0 = 不返回该块'),
      locations_limit: z
        .number().int().min(0).max(50).optional().default(20)
        .describe('已确认代码位置返回条数，默认 20，上限 50；0 = 不返回该块'),
      location_snippet_limit: z
        .number().int().min(0).max(2000).optional().default(200)
        .describe('每个代码位置的快照字符数，默认 200；0 = 只给位置不给代码'),
    },
    async (args) => {
      try {
        const detail = await withTimeout(
          Promise.resolve().then(() => getEventDetail(args.scope, {
            ref: args.event,
            membersLimit: args.members_limit,
            refsLimit: args.refs_limit,
            logsLimit: args.logs_limit,
            locationsLimit: args.locations_limit,
            snippetLimit: args.location_snippet_limit,
          })),
          TOOL_TIMEOUT.READ,
          'ki_event_get',
        );

        const payload = {
          ok: true,
          scope: args.scope,
          ...detail,
          hint: [
            '成员与引用每条都带 (scope, group, name) 三元组，取正文直接调 ki_get_module_info，不要只按名字猜 group',
            // 事件本身不含文档正文（只有成员/引用的三元组），图片清单挂在正文读取工具上；
            // 在事件侧再算一遍会缺 group 锚点，属误导，故这里只做引导
            '成员/参考文档里的图片不在本工具返回：先用 ki_get_module_info 读出该文档，其返回体的 images 给出清单与 ref',
            'refs 的 visibility 指「被引文档自身」的档位（它可能绑在另一个未收口事件上而收窄），不是引用关系本身的可见性',
            '已确认位置与候选的 file 是相对 analysis.targetDir 的路径，两者一起才定位得到代码',
            detail.event.closed
              ? '事件已收口：不再接受流转（需在页面重新打开）；要追加文档请另建事件'
              : '推进阶段用 ki_event_edit stage；挂证据用 ki_event_edit references（不改文档可见性），不要用 ki_event_edit members 挂分析材料',
          ].join('；'),
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
