/**
 * `ki_event_refs` —— 事件参考文档的增 / 删
 *
 * 参考文档与关联文档是两种东西：它**只建立引用**，不修改被引文档的分类、期限与可见性。
 *
 * `add` 逐条调用 `addRefs`（单元素批次）而不是整批：`addRefs` 对「与关联文档冲突」
 * 是抛 `REF_ALREADY_ASSOCIATED` 的整批语义，整批调用会让一条冲突带走整批，
 * AI 也无从知道是哪条失败。逐条后每条的结果都能落到 `failed[]`，批上限仍是 50。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addRefs, removeRef } from '../events/refs-service.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

const DocRef = z.object({
  group: z.string().describe('Group 路径'),
  name: z.string().describe('文档名（Relation 名）'),
});

export function registerEventRefsTool(server: McpServer): void {
  server.tool(
    'ki_event_refs',
    '给事件增删参考文档：只建立引用，不改被引文档的分类与可见性；add 与关联文档冲突的项会被拒并说明',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId'),
      action: z.enum(['add', 'remove']).describe('add=建立引用 / remove=移除引用'),
      docs: z.array(DocRef).min(1).max(50).describe('文档清单（≤50）'),
    },
    async (args) => {
      try {
        if (args.action === 'add') {
          const added: Array<{ group: string; name: string }> = [];
          const skipped: Array<{ group: string; name: string; reason: 'duplicate' | 'already-associated' }> = [];
          const failed: Array<{ group: string; name: string; code: string; error: string }> = [];

          for (const doc of args.docs) {
            try {
              const res = await withTimeout(
                Promise.resolve().then(() => addRefs(args.scope, args.event, { docs: [doc], addedBy: 'ai' })),
                TOOL_TIMEOUT.WRITE,
                'ki_event_refs',
              );
              if (res.added > 0) added.push(doc);
              for (const dup of res.skipped) skipped.push({ group: doc.group, name: doc.name, reason: 'duplicate' });
            } catch (err) {
              const code = (err as { code?: string }).code ?? 'REF_ADD_FAILED';
              if (code === 'REF_ALREADY_ADDED') {
                skipped.push({ group: doc.group, name: doc.name, reason: 'duplicate' });
              } else if (code === 'REF_ALREADY_ASSOCIATED') {
                skipped.push({ group: doc.group, name: doc.name, reason: 'already-associated' });
              } else {
                failed.push({ ...doc, code, error: (err as Error).message });
              }
            }
          }

          const payload = {
            ok: true,
            scope: args.scope,
            event: { ref: args.event },
            action: 'add' as const,
            added: added.length,
            addedList: added,
            skipped,
            failed,
            hint: `已加入 ${added.length} 条参考文档`
              + (skipped.length > 0 ? `；跳过 ${skipped.length} 条（重复或已作为关联文档）` : '')
              + (failed.length > 0 ? `；${failed.length} 条失败：${failed[0].error}` : '')
              + '；被引文档的分类与可见性未做任何改动',
          };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        const removed: Array<{ group: string; name: string }> = [];
        const failed: Array<{ group: string; name: string; code: string; error: string }> = [];
        for (const doc of args.docs) {
          try {
            await withTimeout(
              Promise.resolve().then(() => removeRef(args.scope, args.event, { group: doc.group, name: doc.name })),
              TOOL_TIMEOUT.WRITE,
              'ki_event_refs',
            );
            removed.push(doc);
          } catch (err) {
            const code = (err as { code?: string }).code ?? 'REF_REMOVE_FAILED';
            failed.push({ ...doc, code, error: (err as Error).message });
          }
        }

        const payload = {
          ok: true,
          scope: args.scope,
          event: { ref: args.event },
          action: 'remove' as const,
          removed,
          failed,
          hint: `已移除 ${removed.length} 条参考文档`
            + (failed.length > 0 ? `；${failed.length} 条失败：${failed[0].error}` : '')
            + '；被引文档本身未做任何改动',
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
