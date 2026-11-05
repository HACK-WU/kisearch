import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGetModuleInfo, executeGetModuleInfoBatch } from '../../get-module-info.js';
import { loadConfig } from '../config.js';
import { resolveScopeTargets, getViewMembers, isViewRequest } from '../scope-view.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerGetModuleInfoTool(server: McpServer): void {
  server.tool(
    'ki_get_module_info',
    '读取指定 Group 下某个/多个 Relation 的本地 KB Markdown 内容（批量 ≤10 条，须同 Group）',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图模式下若同一文档存在于多个成员库，需配合 member 指定来源库；省略则用 default）'),
      group: z.string().describe('Group 路径（支持向量语义兜底）'),
      relation: z.string().optional().describe('Relation 名称（精确匹配）。单条查询用；与 relations 二选一'),
      relations: z.array(z.string()).max(10).optional().describe('同 Group 下批量查询（≤10 条，超限报错），逐条返回 results（部分失败不影响其他）。与 relation 二选一'),
      member: z.string().optional().describe('视图模式下指定来源知识库（同一 group+relation 在多个库都存在时必填；批量查询在视图模式下也必须指定）'),
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
        /**
         * 视图模式：`group + relation` 在成员库之间**可能多命中**，不能静默选一个
         * （两份文档可能同名而异义，且事后无法发现选错了）。
         * 规则：显式 member 优先；否则逐库试，唯一命中才返回，多命中 fail-loud 列候选。
         */
        const targets = resolveScopeTargets(loadConfig(), args.scope);
        if (isViewRequest(targets)) {
          const viewName = targets.views[0];
          if (targets.scopes.length === 0) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  view: viewName,
                  error: `视图 ${viewName} 没有可用的成员库`,
                  skipped: targets.skipped,
                }, null, 2),
              }],
            };
          }
          let candidates = targets.scopes;
          if (args.member) {
            const members = getViewMembers(loadConfig(), viewName);
            if (!members.includes(args.member)) {
              return {
                isError: true,
                content: [{
                  type: 'text',
                  text: `--member "${args.member}" 不是视图 ${viewName} 的成员。该视图的成员：${members.join('、')}`,
                }],
              };
            }
            candidates = [args.member];
          }

          if (args.relations) {
            /**
             * 批量查询落到单一成员库。★ 单成员视图无歧义 → 自动取唯一成员，
             * 不强制 member：否则「刚建好、还没扩成员」的视图连批量读都不可用。
             */
            const member = args.member
              ?? (targets.scopes.length === 1 ? targets.scopes[0] : undefined);
            if (!member) {
              return {
                isError: true,
                content: [{
                  type: 'text',
                  text: `视图模式下批量查询必须指定 member（候选库：${candidates.join('、')}）。`
                    + '如需跨库查询，请改为逐个库调用。',
                }],
              };
            }
            const batch = await withTimeout(
              executeGetModuleInfoBatch({ scope: member, group: args.group, relations: args.relations }),
              TOOL_TIMEOUT.READ,
              'ki_get_module_info'
            );
            return { content: [{ type: 'text', text: JSON.stringify(batch, null, 2) }] };
          }

          // 逐库探测：命中结果**直接复用**，不再重读一次（曾为"探针 + 正式读"两次全量 IO）
          const hits: { scope: string; result: Record<string, unknown> }[] = [];
          /**
           * 探测失败（不是"没这篇文档"，而是引擎锁 / 维度不匹配 / 索引损坏）单独收起来。
           * 不分流的话，0 命中时只能报"均未找到"——把故障说成"文档不存在"，
           * 用户会去别的库重导，问题永远不会被发现。
           */
          const failures: { scope: string; reason: string }[] = [];
          for (const member of candidates) {
            try {
              const r = await withTimeout(
                executeGetModuleInfo({ scope: member, group: args.group, relation: args.relation as string }),
                TOOL_TIMEOUT.READ,
                'ki_get_module_info'
              );
              if (r.ok) hits.push({ scope: member, result: r as unknown as Record<string, unknown> });
              else if (args.member) {
                return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
              } else {
                failures.push({ scope: member, reason: r.hint ? `${r.error}（${r.hint}）` : r.error });
              }
            } catch (err) {
              failures.push({ scope: member, reason: (err as Error).message });
            }
          }

          if (hits.length === 1) {
            const only = hits[0];
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ ...only.result, member: only.scope }, null, 2),
              }],
            };
          }
          const payload = hits.length === 0
            ? {
              ok: false,
              view: viewName,
              error: `在视图 ${viewName} 的 ${candidates.length} 个成员库中均未找到该文档。`,
              searched: candidates,
              ...(failures.length > 0
                ? { failed: failures, hint: '部分成员库读取失败（非"文档不存在"），见 failed 明细' }
                : {}),
            }
            : {
              ok: false,
              view: viewName,
              error: `该文档在视图 ${viewName} 的多个知识库中同时存在，请用 member 指定来源库。`,
              candidates: hits,
            };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        const result = args.relations
          ? await withTimeout(
              executeGetModuleInfoBatch({ scope: args.scope, group: args.group, relations: args.relations }),
              TOOL_TIMEOUT.READ,
              'ki_get_module_info'
            )
          : await withTimeout(
              executeGetModuleInfo({ scope: args.scope, group: args.group, relation: args.relation as string }),
              TOOL_TIMEOUT.READ,
              'ki_get_module_info'
            );
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
