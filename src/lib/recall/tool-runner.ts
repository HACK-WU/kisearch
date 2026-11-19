/**
 * 共享工具执行器（2026-11-19 从 `ki_recall` 抽出）。
 *
 * 为什么单独一层：模型循环是**一份**（`runGroundedRecall`），它只认「工具名 + 参数」；
 * 把「工具名 → 知识库只读调用」这段映射也收敛到一份，`find`（AI 查找）与 `recall`（AI 预取）
 * 才真正共用同一条执行链 —— 否则两边的 `ki_search` 参数/截断口径迟早不一致。
 *
 * 两条入口各自注入自己的 `targets`（允许的物理库），模型传的 `scope` 一律以它为准，
 * 防止模型自己扩范围。
 */

import { executeGetModuleInfo } from '../../get-module-info.js';
import { executeQueryGroup } from '../../query-group.js';
import { executeSearch } from '../../search.js';
import { executeTagList } from '../../tag.js';
import type { GroundedToolRunner } from './run-recall.js';

export interface ToolRunnerOptions {
  /** 允许检索的物理库（模型不能越出这个集合） */
  targets: string[];
  /** 单次工具结果字符上限（截断后仍会告诉模型「已截断」） */
  toolChars: number;
  /** 测试注入：覆盖单个工具实现 */
  overrides?: Partial<Record<string, (args: Record<string, unknown>) => Promise<string>>>;
}

export function makeRecallToolRunner(opts: ToolRunnerOptions): GroundedToolRunner {
  const { targets, toolChars, overrides } = opts;
  const pickScope = (v: unknown): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && targets.includes(s) ? s : targets[0]!;
  };
  const clip = (text: string): string => (text.length > toolChars ? `${text.slice(0, toolChars)}\n…（已截断）` : text);

  return async (name, args) => {
    const override = overrides?.[name];
    if (override) return { text: clip(await override(args)) };

    if (name === 'ki_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return { text: JSON.stringify({ error: 'query 不能为空' }) };
      const mode = args.mode === 'fulltext' ? 'fulltext' as const : 'hybrid' as const;
      const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 8;
      // scope 由工具注入（一次多库），模型传的 scope 一律忽略
      const res = await executeSearch({ scope: targets.join(','), query, mode, limit });
      const hits = (res as { results?: Array<{ scope?: string; group?: string; relation?: string; score?: number }> }).results ?? [];
      // 实际模式（语义侧不可用时引擎会降级）：让调用方如实显示"仅全文"
      const actualMode = (res as { mode?: 'hybrid' | 'fulltext' }).mode ?? mode;
      return { text: clip(JSON.stringify({ results: hits })), searchMode: actualMode };
    }

    if (name === 'ki_get_module_info') {
      const group = String(args.group ?? '').trim();
      const relation = String(args.relation ?? '').trim();
      if (!group || !relation) return { text: JSON.stringify({ error: 'group / relation 不能为空' }) };
      const maxChars = Math.max(2000, Math.floor(toolChars * 0.75));
      const res = await executeGetModuleInfo({ scope: pickScope(args.scope), group, relation, maxChars });
      if (!res.ok) return { text: clip(JSON.stringify({ error: res.error })) };
      const truncated = (res as { truncated?: boolean }).truncated === true;
      return {
        text: clip(JSON.stringify({ doc: res })),
        read: { scope: res.scope, group, name: relation, truncated },
      };
    }

    if (name === 'ki_group_list') {
      const groups = typeof args.groups === 'string' ? args.groups : undefined;
      const depth = typeof args.depth === 'number' ? Math.min(6, Math.max(1, Math.floor(args.depth))) : 2;
      // 参数形状必须与 QueryGroupParams 一致（2026-11-19 真机踩过：传 groups 导致运行时抛错）
      const res = await executeQueryGroup({
        scope: pickScope(args.scope),
        ...(groups ? { groupsParam: groups } : {}),
        hotCount: 2,
        depth,
        modes: ['hot', 'full'],
      });
      return { text: clip(JSON.stringify(res)) };
    }

    if (name === 'ki_scope_list') {
      return { text: clip(JSON.stringify({ scopes: targets })) };
    }

    if (name === 'ki_tag_list') {
      const res = await executeTagList({ scope: pickScope(args.scope) });
      return { text: clip(JSON.stringify(res)) };
    }

    return { text: JSON.stringify({ error: `未实现的工具：${name}` }) };
  };
}
