/**
 * `ki_event_docs` —— 事件关联文档的增 / 删
 *
 * 语义边界（与页面「＋ 添加 / ×」完全一致）：
 *   · `add` = 绑定：文档分类变 `event`，可见性跟随当前阶段；
 *   · `remove` = **解绑**：文档回 `wiki`（长期保留、可检索），**不删除文档、不进回收站**。
 *     要删数据请走回收站页，不要用本工具。
 *
 * 批量里一条失败不影响其他：`add` 走服务层的 skipped/failed 报告；`remove` 逐条 try/catch。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bindMembers, unbindMember } from '../events/members.js';
import { scheduleConsume } from '../visibility-queue.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

const DocRef = z.object({
  group: z.string().describe('Group 路径'),
  name: z.string().describe('文档名（Relation 名）'),
});

export function registerEventDocsTool(server: McpServer): void {
  server.tool(
    'ki_event_docs',
    '给事件增删关联文档：add=挂上（可见性随阶段变化）/ remove=解绑（文档回长期保留，不删除）',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId'),
      action: z.enum(['add', 'remove']).describe('add=绑定关联文档 / remove=解绑'),
      docs: z.array(DocRef).min(1).max(50).describe('文档清单（≤50）'),
    },
    async (args) => {
      try {
        if (args.action === 'add') {
          const result = await withTimeout(
            bindMembers(args.scope, args.event, { docs: args.docs, by: 'ai' }),
            TOOL_TIMEOUT.WRITE,
            'ki_event_docs',
          );
          if (result.pending.length > 0) void scheduleConsume(args.scope);
          const payload = {
            ok: true,
            scope: args.scope,
            event: { id: result.event.id, shortId: `#${result.event.shortId}` },
            action: 'add' as const,
            bound: result.bound,
            skipped: result.skipped,
            failed: result.failed,
            ...(result.visibilityFailed.length > 0 ? { visibilityFailed: result.visibilityFailed } : {}),
            visibility: result.visibility,
            ...(result.pending.length > 0 ? { indexPending: result.pending } : {}),
            hint: buildAddHint(result),
          };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        // remove：逐条解绑，一条失败不影响其他（例如它本来就不在本事件里）
        const removed: Array<{ group: string; name: string }> = [];
        const failed: Array<{ group: string; name: string; code: string; error: string }> = [];
        let pending: string[] = [];
        let lastEvent: { id: string; shortId: number } | null = null;
        for (const doc of args.docs) {
          try {
            const res = await withTimeout(
              unbindMember(args.scope, args.event, doc.group, doc.name),
              TOOL_TIMEOUT.WRITE,
              'ki_event_docs',
            );
            removed.push(res.removed);
            if (res.pending.length > 0) pending = res.pending;
            lastEvent = { id: res.event.id, shortId: res.event.shortId };
          } catch (err) {
            const code = (err as { code?: string }).code ?? 'UNBIND_FAILED';
            failed.push({ ...doc, code, error: (err as Error).message });
            const parsed = (err as { details?: { event?: { id?: string; shortId?: number } } }).details?.event;
            if (!lastEvent && parsed?.id && typeof parsed.shortId === 'number') {
              lastEvent = { id: parsed.id, shortId: parsed.shortId };
            }
          }
        }
        if (pending.length > 0) void scheduleConsume(args.scope);
        const payload = {
          ok: true,
          scope: args.scope,
          event: lastEvent ? { id: lastEvent.id, shortId: `#${lastEvent.shortId}` } : { ref: args.event },
          action: 'remove' as const,
          removed,
          failed,
          ...(pending.length > 0 ? { indexPending: pending } : {}),
          hint: `已解绑 ${removed.length} 篇（文档回长期保留，仍可被检索）`
            + (failed.length > 0 ? `；${failed.length} 篇失败：${failed[0].error}` : '')
            + (pending.length > 0 ? '；索引补齐中，数秒后生效' : ''),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

function buildAddHint(result: Awaited<ReturnType<typeof bindMembers>>): string {
  const parts: string[] = [];
  parts.push(`已挂上 ${result.bound.length} 篇`);
  if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 篇（已在本事件或重复提交）`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} 篇被拒：${result.failed[0].error}`);
  if (result.visibilityFailed.length > 0) {
    parts.push(`⚠ ${result.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到`);
  }
  if (result.visibility.mode === 'hidden') {
    parts.push('当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为（不是写入失败）');
  } else if (result.visibility.mode === 'fts-only') {
    parts.push('当前阶段仅全文可命中：语义检索不会召回，这是预期行为');
  } else {
    parts.push('当前阶段语义与全文都可检索');
  }
  return parts.join('；');
}
