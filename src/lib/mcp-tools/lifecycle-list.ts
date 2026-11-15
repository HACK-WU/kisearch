/**
 * `ki_lifecycle_list` —— 分类枚举（只读）
 *
 * 存在的理由：AI 写入时要传 `lifecycle`，但它不知道有哪几档、期限选项、该 group 的默认值。
 * 没有这个工具，AI 只能凭空猜（`ttl_days: 30`？7？90？），失败率全压在提示词里。
 *
 * 三条约束：
 *   1. **只读**，不含任何创建能力（分类只能由人在页面建，AI 不可发明新分类）；
 *   2. 传 `group` 才回显该组有效默认；**不传时不枚举全部组**（组可能上千，无界返回）；
 *   3. `presets` 只用于**向人解释**「已按你的预设标记」，不作为入参（AI 直接传 `ttl_days` 更准）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readGovernance, getGroupDefault, BUILTIN_PRESETS, DEFAULT_TRASH_SETTINGS } from '../governance-store.js';
import { readTrashSettings } from '../trash-store.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

const KIND_META = [
  { kind: 'wiki', label: '长期保留', ttlOptions: [], min: null, max: null, hint: '永不自动消失；缺省档位' },
  { kind: 'temp', label: '临时', ttlOptions: [7, 30, 90], min: 1, max: 365, hint: '到期进回收站，可恢复' },
  { kind: 'event', label: '事件', ttlOptions: [], min: null, max: null, hint: '跟随事件阶段；事件收口时按类型终态动作处理' },
] as const;

export function registerLifecycleListTool(server: McpServer): void {
  server.tool(
    'ki_lifecycle_list',
    '列出文档分类（wiki / temp / event）与期限选项、分类预设，以及指定 group 的有效默认分类；只读，不能创建分类',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      group: z
        .string()
        .optional()
        .describe('Group 路径；传了才回显该组的有效默认分类（不传时不枚举全部组，避免无界返回）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => {
            const config = readGovernance(args.scope);
            const trash = readTrashSettings(args.scope);

            /**
             * 按 id 去重（验收 M-04）：`readGovernance()` 已把内置预设合并进
             * `lifecyclePresets`，再叠一次 `BUILTIN_PRESETS` 会让每个内置项出现两遍。
             */
            const byId = new Map<string, { id: string; name: string; kind: 'wiki' | 'temp' | 'event'; ttlDays?: number }>();
            for (const preset of [...BUILTIN_PRESETS, ...config.lifecyclePresets]) byId.set(preset.id, preset);
            const presets = [...byId.values()].map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
              ...(p.ttlDays !== undefined ? { ttlDays: p.ttlDays } : {}),
            }));

            const payload: Record<string, unknown> = {
              ok: true,
              scope: args.scope,
              kinds: KIND_META.map((k) => ({ ...k })),
              presets,
              trash: { keepDays: trash.keepDays, expireAction: trash.expireAction, default: DEFAULT_TRASH_SETTINGS },
              note: 'presets 仅供向你解释「已按用户预设标记」，入参请直接传 lifecycle + ttl_days',
            };

            if (args.group) {
              const groupDefault = getGroupDefault(config, args.group);
              payload.group = args.group;
              payload.effectiveDefault = groupDefault
                ? {
                  kind: groupDefault.kind,
                  ...(groupDefault.ttlDays !== undefined ? { ttlDays: groupDefault.ttlDays } : {}),
                  source: 'group-default',
                }
                : { kind: 'wiki', source: 'fallback-wiki' };
            } else {
              payload.effectiveDefault = { kind: 'wiki', source: 'fallback-wiki' };
              payload.note2 = '未传 group：effectiveDefault 只表示全局兜底，不代表任何具体组';
            }

            return payload;
          }),
          TOOL_TIMEOUT.READ,
          'ki_lifecycle_list',
        );

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (err as Error).message }, null, 2) }],
        };
      }
    },
  );
}
