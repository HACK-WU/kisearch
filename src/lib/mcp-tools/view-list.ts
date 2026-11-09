import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildViews, collectScopeLayers, type ViewInfo } from '../../scope.js';
import { loadConfig } from '../config.js';
import { filterAuthorizedViews } from './view-auth.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

/** 单次返回的视图条数上限（视图定义通常 <20 个；误建上百时截断而非静默丢） */
const MAX_VIEWS = 200;

/**
 * 视图级健康摘要（默认与 verbose **都给**）。
 *
 * 为什么需要汇总：`verbose` 把成员逐个摊开，模型要自己数「几个成员真的能参与语义检索」。
 * 真实数据里就有"5 个成员 0 个可用"的视图（3 个维度不一致 + 1 个只有 KB + 1 个只有向量），
 * 不汇总的话「这个视图还能不能用」这个最关键的判断要调用方自己算。
 *
 * 两种模式的详略差异只体现在**成员明细**上，健康信号必须在同一位置都能看到 ——
 * 否则 verbose 态反而更难看懂（与「verbose 更详细」的直觉相反）。
 */
export interface ViewHealth {
  /**
   * 可完整使用的成员数：KB 与向量都在，且向量维度与当前配置一致
   * （`dimensionState` 为 `unknown` / 缺省时按可用计 —— 未确认不等于不可用）。
   */
  usableCount: number;
  /** 不可完整使用的原因（全部可用时**不输出**，避免每条都带一句"正常"的噪音） */
  degradedReason?: string;
}

/** 统计视图健康度（互斥分类：维度不一致 / 只有 KB / 只有向量 / 两层都无） */
export function viewHealth(v: ViewInfo): ViewHealth {
  let mismatch = 0;
  let kbOnly = 0;
  let vectorOnly = 0;
  let missingCount = 0;
  let usable = 0;
  for (const m of v.memberMeta) {
    if (m.kb && m.vector) {
      if (m.dimensionState === 'mismatch') mismatch += 1;
      else usable += 1;
      continue;
    }
    if (!m.kb && !m.vector) missingCount += 1;
    else if (m.vector) vectorOnly += 1;
    else kbOnly += 1;
  }

  const total = v.members.length;
  if (usable >= total) return { usableCount: usable };

  const parts: string[] = [];
  if (mismatch > 0) parts.push(`${mismatch} 个向量维度不一致（语义检索会跳过）`);
  if (kbOnly > 0) parts.push(`${kbOnly} 个只有 KB（不参与语义检索）`);
  if (vectorOnly > 0) parts.push(`${vectorOnly} 个只有向量层（读不到原文）`);
  if (missingCount > 0) parts.push(`${missingCount} 个两层都不存在`);
  return {
    usableCount: usable,
    degradedReason: `${total} 个成员中 ${total - usable} 个不可完整使用：${parts.join('；')}`,
  };
}

/**
 * 提取维度不一致的成员库名。
 *
 * ★ 默认与 verbose **都要给**：`dimensionState === 'mismatch'` 意味着**语义检索会跳过该库**；
 *   只在默认态给、verbose 态反过来要模型自己从 `memberMeta[]` 里筛，与「verbose 更详细」的
 *   直觉相反，容易漏看。
 */
function mismatchMembers(v: ViewInfo): string[] {
  return v.memberMeta
    .filter((m) => m.dimensionState === 'mismatch')
    .map((m) => m.scope);
}

/** 默认（非 verbose）输出的视图条目：只留"能不能用、缺什么" */
export interface CompactView extends ViewHealth {
  view: string;
  id: string;
  members: string[];
  availableCount: number;
  missing: string[];
  /**
   * 维度不一致的成员库名（必须点名而不是只给计数 —— 用户下一步就是去重建这几个库）。
   *
   * ⚠️ 别写成"静默漏召回"：检索侧并不静默，`ki_search` 的 `skipped[]` 会逐条报
   *   「vector dimension mismatch」并给重建命令。这里的作用是**检索前**就知道，
   *   省掉一次注定空结果的调用，而不是补一个缺失的告警。
   */
  dimensionMismatch?: string[];
}

/** 裁剪为默认条目（成员元信息只提炼健康度与维度风险，其余留给 verbose） */
export function toCompactView(v: ViewInfo): CompactView {
  const dimensionMismatch = mismatchMembers(v);
  return {
    view: v.view,
    id: v.id,
    members: v.members,
    availableCount: v.availableCount,
    missing: v.missing,
    ...viewHealth(v),
    ...(dimensionMismatch.length > 0 ? { dimensionMismatch } : {}),
  };
}

/** verbose 条目：完整 ViewInfo + 同一份健康摘要（与默认态保持一致的告警位置） */
export function toVerboseView(
  v: ViewInfo,
): ViewInfo & ViewHealth & { dimensionMismatch?: string[] } {
  const dimensionMismatch = mismatchMembers(v);
  return {
    ...v,
    ...viewHealth(v),
    ...(dimensionMismatch.length > 0 ? { dimensionMismatch } : {}),
  };
}

/**
 * 注册 `ki_view_list` 工具。
 *
 * 定位：让模型在**不知道有没有视图**的情况下，用一次低成本调用发现「可当 scope 用的视图」，
 * 不必从 `ki_scope_list` 的上百条 scope 里翻 `views[]`。
 *
 * @param authScopes 当前会话的授权 scope 集合（null = 免鉴权不限）；非 null 时按
 *   D3（视图名 ∧ 全部成员）过滤，与 `ki_scope_list` 共用 `view-auth.ts` 的同一实现。
 */
export function registerViewListTool(server: McpServer, authScopes: string[] | null = null): void {
  server.tool(
    'ki_view_list',
    '列出知识视图（多个知识库的只读聚合）。视图名可直接作为 scope 传给 ki_search / ki_group_list / ki_tag_list / ki_get_module_info；'
    + '视图只读，不能写入。默认给可用性（usableCount / degradedReason，说明有几个成员真能参与语义检索）与缺失成员；'
    + 'verbose 展开成员元信息与审计字段。',
    {
      verbose: z.boolean().optional().describe(
        '展开每个视图的成员元信息（kb / vector / readonly / docCount / dimensionState / scheduled）与审计字段（createdBy / createdAt / revision）',
      ),
    },
    async (args) => {
      try {
        const payload = await withTimeout(
          collectViews(args.verbose === true, authScopes),
          TOOL_TIMEOUT.READ,
          'ki_view_list',
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    },
  );
}

/** 工具响应（显式声明，避免 `Promise<unknown>` 让 payload 结构失去类型检查） */
export interface ListViewsResult {
  ok: true;
  /** 本次返回条数（截断时小于 `total`） */
  count: number;
  total?: number;
  truncated?: true;
  views: Array<ViewInfo | CompactView>;
  warning?: string;
  hint?: string;
  vectorAvailable?: boolean;
  vectorReason?: string;
}

/** 工具主体（单独抽出以便套统一超时档，与其它读工具一致） */
async function collectViews(verbose: boolean, authScopes: string[] | null): Promise<ListViewsResult> {
  const config = loadConfig();
  // 与 ki_scope_list 共用两层枚举：availableCount / missing 的判定标准必须一致
  const { kbScopes, vectorScopes, vectorAvailable, vectorReason } = await collectScopeLayers();
  const { views, warning } = buildViews(config, kbScopes, vectorScopes);
  const visible = filterAuthorizedViews(views, authScopes);

  /*
   * 三种"空"必须说清区别，否则模型会把它们当同一件事转告用户：
   *   ① 没有视图定义        → count:0 + 创建命令
   *   ② 有视图但被授权过滤光 → count:0 + 授权提示（不是"你没建过"）
   *   ③ 视图文件损坏        → warning（不是"你没建过"）
   */
  const total = views?.length ?? 0;
  const rows = visible ?? [];
  const kept = rows.slice(0, MAX_VIEWS);
  const out = kept.map((v) => (verbose ? toVerboseView(v) : toCompactView(v)));

  let hint: string | undefined;
  if (warning) {
    hint = '视图定义读取失败，结果不代表「没有视图」；请检查配置目录下的视图定义文件是否损坏。';
  } else if (total === 0) {
    hint = '还没有任何视图。创建：ki view create <名称> --members <scope1>,<scope2>';
  } else if (rows.length === 0 && authScopes !== null) {
    hint = `共 ${total} 个视图，但当前 Token 无可见视图：视图需同时授权「视图名」与「全部成员库」（全有或全无）。`
      + '补救：ki mcp token update <id> --scope <原有授权>,<缺的成员>（管理员可用 ki view audit-grants 定位缺失授权）。';
  }

  return {
    ok: true,
    count: kept.length,
    ...(rows.length > kept.length ? { total: rows.length, truncated: true } : {}),
    views: out,
    ...(warning ? { warning } : {}),
    ...(hint ? { hint } : {}),
    ...(vectorAvailable ? {} : { vectorAvailable, vectorReason }),
  };
}
