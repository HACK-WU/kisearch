/**
 * 共享工具执行器（2026-11-19 抽出；2026-11-25 支持模型自选 scope）。
 *
 * 为什么单独一层：模型循环是**一份**（`runGroundedRecall`），它只认「工具名 + 参数」；
 * 把「工具名 → 知识库只读调用」这段映射也收敛到一份，`find`（AI 查找）与 `recall`（AI 预取）
 * 才真正共用同一条执行链 —— 否则两边的 `ki_search` 参数/截断口径迟早不一致。
 *
 * ═══ scope 口径（2026-11-25 用户拍板 Q3/Q4）═══
 *   · 调用方传入的 scope 只是**默认值**：模型不传 scope 时用它，传了就按它查；
 *   · 模型可自选，但**每次调用**都经 `resolveScope` 校验（存在性 + 授权 + 视图展开）；
 *   · 校验失败 → 返回可行动错误（列出可用库），**不静默回落到默认**（回落会让「以为查 A、实际查 B」）；
 *   · `resolveScope` 未注入 = 不允许改范围（保持锁定），这样「AI 查找」侧行为不变，
 *     等它的鉴权链路就绪后再单独开（写工具永远不加 scope，Q5）。
 */

import { executeGetModuleInfo } from '../../get-module-info.js';
import { executeQueryGroup } from '../../query-group.js';
import { executeSearch } from '../../search.js';
import { executeTagList } from '../../tag.js';
import type { KiConfig } from '../config.js';
/*
 * 视图展开统一入口（2026-11-27 · 事件 #112）。
 * group / tag 是**聚合语义**工具，必须逐成员收集；此前复用 `tryEachPhysical`
 * 「首个 ok 即返回」，视图 / 逗号多库下只回首个成员的内容，且把 `scopeUsed`
 * 记成该库名 —— 调用方看不出漏了成员（静默丢失，比报错更难发现）。
 */
import { queryGroupByScope, VIEW_TOTAL_TIMEOUT } from '../group-list-view.js';
import { tagListByScope } from '../tag-list-view.js';
import { withTimeout, TOOL_TIMEOUT } from '../mcp-tools/util.js';
import { ALL_SCOPES } from '../mcp-token.js';
import { isScopeAccessAllowed } from '../scope-access.js';
import { readViews } from '../scope-view.js';
import { listAllScopes } from '../scope.js';
import { resolveRecallTargets } from './targets.js';
import type { GroundedToolOutcome, GroundedToolRunner } from './run-recall.js';

/** 一次调用的范围解析结果 */
export interface ScopeResolutionOk {
  /** 实际检索 / 读取的物理库（视图已展开成员） */
  physical: string[];
  /** 回显给模型与审计的名字（可能是视图名；顺序 = 模型给的顺序） */
  display: string[];
}

export interface ToolRunnerOptions {
  /** 默认检索范围（调用方传入且已展开的物理库） */
  targets: string[];
  /**
   * 默认范围的**展示名**（调用方入参原样，可能含视图名）。
   *
   * 为什么需要它：`targets` 是展开后的物理库（检索必须用它），而 `scopesUsed` 是给人和模型看的
   * 「实际用了哪些范围」。入参是视图时不传 scope 就会记成成员库名，前端拿它和 `targets` 比对
   * 会误判成"AI 擅自扩大范围"。缺省回落到 `targets`。
   */
  defaultDisplay?: string[];
  /** 单次工具结果字符上限（截断后仍会告诉模型「已截断」） */
  toolChars: number;
  /** 读正文类工具一次最多试几个物理库（视图可能展开出多个；默认 5） */
  maxReadAttempts?: number;
  /** 模型自选 scope 的解析器（不注入 = 只允许默认范围） */
  resolveScope?: (requested: string[]) => ScopeResolutionOk | { error: string };
  /** 可用库 / 视图清单（`ki_scope_list` 与错误文案用） */
  scopeCatalog?: () => { scopes: string[]; views: Record<string, string[]> };
  /** 测试注入：覆盖单个工具实现（会绕过 scope 解析，只用于不关心范围的用例） */
  overrides?: Partial<Record<string, (args: Record<string, unknown>) => Promise<string>>>;
  /**
   * 底层实现注入（默认用真实现）。测试用它验证「scope 是否正确传到执行层」，
   * 又不必碰真实知识库 —— `overrides` 在最外层短路，测不到 scope 解析这一段。
   */
  impl?: {
    search?: typeof executeSearch;
    getModuleInfo?: typeof executeGetModuleInfo;
    queryGroup?: typeof executeQueryGroup;
    tagList?: typeof executeTagList;
  };
}

export interface ScopeResolverOptions {
  config: KiConfig;
  /** 调用方授权集；`null` = 本机不限权 */
  tokenScopes: string[] | null;
  /** 未传 scope 时使用（已展开的物理库），也用作错误文案里的"默认范围" */
  defaultTargets: string[];
  /** 测试注入：可用库 / 视图清单来源（默认真实配置，测试不碰真实库） */
  scopeDeps?: {
    listScopes?: () => string[];
    listViews?: () => Record<string, { members: string[] }>;
  };
}

export interface ScopeResolver {
  /** 校验 + 展开成员库；失败回可行动错误（不回落默认） */
  resolveScope: (requested: string[]) => ScopeResolutionOk | { error: string };
  /** 授权范围内的可用库 + 视图（`ki_scope_list` 与范围说明共用） */
  scopeCatalog: () => { scopes: string[]; views: Record<string, string[]> };
}

/**
 * 模型自选 scope 的解析器工厂（2026-11-25 批 3 抽出）。
 *
 * 为什么抽出来：`ki_recall` 与「AI 查找」是同一套执行链（同一份 runner、同一个配置域），
 * 两边各写一份「存在性 + 授权 + 视图展开」必然漂移。这里做成唯一定义，
 * 两个入口只是**是否注入**的区别（不注入 = 保持范围锁定）。
 */
export function makeScopeResolver(opts: ScopeResolverOptions): ScopeResolver {
  const tokenScopes = opts.tokenScopes ?? null;

  const scopeCatalog = (): { scopes: string[]; views: Record<string, string[]> } => {
    const views: Record<string, string[]> = {};
    try {
      const table = opts.scopeDeps?.listViews?.() ?? readViews(opts.config);
      for (const [name, v] of Object.entries(table)) {
        const members = Array.isArray(v?.members) ? [...v.members] : [];
        // 视图按「全有或全无」鉴权：只把整体有权访问的视图暴露给模型
        const grant = tokenScopes ?? [ALL_SCOPES];
        if (members.length > 0 && isScopeAccessAllowed(grant, name, { viewMembers: () => members })) {
          views[name] = members;
        }
      }
    } catch {
      /* 读不到视图不影响库清单 */
    }
    let scopes: string[];
    if (tokenScopes === null) {
      try {
        scopes = opts.scopeDeps?.listScopes?.() ?? listAllScopes();
      } catch {
        scopes = [...opts.defaultTargets];
      }
    } else {
      scopes = [...tokenScopes];
    }
    return { scopes: scopes.filter((n) => n !== ALL_SCOPES), views };
  };

  const resolveScope = (requested: string[]): ScopeResolutionOk | { error: string } => {
    const r = resolveRecallTargets({
      requested,
      tokenScopes,
      deps: {
        config: opts.config,
        listScopes: opts.scopeDeps?.listScopes ?? (() => listAllScopes()),
        listViews: opts.scopeDeps?.listViews ?? (() => readViews(opts.config)),
      },
    });
    if (r.forbiddenRequested.length > 0) {
      const bad = r.forbiddenRequested.map((b) => `${b.name}（${b.reason}）`).join('、');
      return {
        error: `这些 scope 不可用：${bad}。可先调 ki_scope_list 看有哪些可用；本次默认范围：${opts.defaultTargets.join('、')}`,
      };
    }
    if (r.physicalTargets.length === 0) {
      return {
        error: `这些 scope 都不可用。本次默认范围：${opts.defaultTargets.join('、')}；可用项可调 ki_scope_list 查看`,
      };
    }
    return { physical: r.physicalTargets, display: r.targets };
  };

  return { resolveScope, scopeCatalog };
}

function normalizeScopeArg(raw: unknown): string[] {
  const toList = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof raw === 'string') return toList(raw);
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === 'string')
      .flatMap(toList);
  }
  return [];
}

export function makeRecallToolRunner(opts: ToolRunnerOptions): GroundedToolRunner {
  const { targets, toolChars, resolveScope, scopeCatalog } = opts;
  const impl = opts.impl ?? {};
  const doSearch = impl.search ?? executeSearch;
  const doGetModuleInfo = impl.getModuleInfo ?? executeGetModuleInfo;
  const doQueryGroup = impl.queryGroup ?? executeQueryGroup;
  const doTagList = impl.tagList ?? executeTagList;
  const maxReadAttempts = Math.max(1, opts.maxReadAttempts ?? 5);
  const clip = (text: string): string => (text.length > toolChars ? `${text.slice(0, toolChars)}\n…（已截断）` : text);

  /** 解析本次调用生效的范围：未传 → 默认；传了 → 校验（失败给可行动错误，不回落） */
  const pickScopes = (raw: unknown): { ok: true; sc: ScopeResolutionOk } | { ok: false; error: string } => {
    const asked = normalizeScopeArg(raw);
    if (asked.length === 0) {
      return { ok: true, sc: { physical: targets, display: opts.defaultDisplay ?? targets } };
    }
    if (!resolveScope) {
      const avail = scopeCatalog?.().scopes ?? targets;
      return {
        ok: false,
        error: `本次不允许改变检索范围；默认范围：${targets.join('、')}`
          + (avail.length > 0 ? `。可用库：${avail.join('、')}` : ''),
      };
    }
    const res = resolveScope(asked);
    if ('error' in res) return { ok: false, error: res.error };
    return { ok: true, sc: res };
  };

  /**
   * 读正文：视图展开后逐个试，命中即止（同一篇只需从某一个库读到）。
   *
   * ⚠️ 只给 `ki_get_module_info` 用。`ki_group_list` / `ki_tag_list` 是**聚合语义**
   * （全貌），必须逐成员收集 —— 2026-11-27 事件 #112 就是它们误用了这个捷径。
   */
  const tryEachPhysical = async <T>(
    physical: string[],
    fn: (scope: string) => Promise<{ ok: boolean; value?: T; error?: string }>,
  ): Promise<{ ok: true; scope: string; value: T } | { ok: false; error: string }> => {
    let lastError = '';
    for (const scope of physical.slice(0, maxReadAttempts)) {
      const r = await fn(scope);
      if (r.ok) return { ok: true, scope, value: r.value as T };
      lastError = r.error ?? lastError;
    }
    return { ok: false, error: lastError || `未在 ${physical.join('、')} 中找到` };
  };

  return async (name, args) => {
    const override = opts.overrides?.[name];
    if (override) return { text: clip(await override(args)) };

    if (name === 'ki_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return { text: JSON.stringify({ error: 'query 不能为空' }) };
      const picked = pickScopes(args.scope);
      if (!picked.ok) return { text: JSON.stringify({ error: picked.error }) };
      const mode = args.mode === 'fulltext' ? 'fulltext' as const : 'hybrid' as const;
      const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 8;
      // 一次多库：由本次生效范围决定（模型传了就用它的，没传用默认）
      const res = await doSearch({ scope: picked.sc.physical.join(','), query, mode, limit });
      const hits = (res as { results?: Array<{ scope?: string; group?: string; relation?: string; score?: number }> }).results ?? [];
      // 实际模式（语义侧不可用时引擎会降级）：让调用方如实显示「仅全文」
      const actualMode = (res as { mode?: 'hybrid' | 'fulltext' }).mode ?? mode;
      return {
        text: clip(JSON.stringify({ results: hits, scope: picked.sc.display })),
        searchMode: actualMode,
        scopeUsed: picked.sc.display,
      };
    }

    if (name === 'ki_get_module_info') {
      const group = String(args.group ?? '').trim();
      const relation = String(args.relation ?? '').trim();
      if (!group || !relation) return { text: JSON.stringify({ error: 'group / relation 不能为空' }) };
      const picked = pickScopes(args.scope);
      if (!picked.ok) return { text: JSON.stringify({ error: picked.error }) };
      const maxChars = Math.max(2000, Math.floor(toolChars * 0.75));
      const got = await tryEachPhysical(picked.sc.physical, async (scope) => {
        const r = await doGetModuleInfo({ scope, group, relation, maxChars });
        return r.ok
          ? { ok: true as const, value: r }
          : { ok: false as const, error: (r as { error?: string }).error };
      });
      if (!got.ok) {
        return { text: clip(JSON.stringify({ error: got.error, scope: picked.sc.display })), scopeUsed: picked.sc.display };
      }
      const truncated = (got.value as { truncated?: boolean }).truncated === true;
      return {
        text: clip(JSON.stringify({ doc: got.value })),
        read: { scope: got.scope, group, name: relation, truncated },
        scopeUsed: [got.scope],
      };
    }

    if (name === 'ki_group_list') {
      const groups = typeof args.groups === 'string' ? args.groups : undefined;
      const depth = typeof args.depth === 'number' ? Math.min(6, Math.max(1, Math.floor(args.depth))) : 2;
      const picked = pickScopes(args.scope);
      if (!picked.ok) return { text: JSON.stringify({ error: picked.error }) };
      // 参数形状必须与 QueryGroupParams 一致（2026-11-19 真机踩过：传 groups 导致运行时抛错）
      const outcome = await queryGroupByScope(undefined, {
        ...(groups ? { groupsParam: groups } : {}),
        hotCount: 2,
        depth,
        modes: ['hot', 'full'],
        resolved: { physical: picked.sc.physical, display: picked.sc.display },
        // 首成员完整树、其余只给顶层 Group 名：查找输出同样受 toolChars 预算约束
        maxFullMembers: 1,
        timeout: { ms: TOOL_TIMEOUT.READ, label: 'ki_group_list', totalMs: VIEW_TOTAL_TIMEOUT.MCP },
        runOne: (target, capMs, p) =>
          withTimeout(doQueryGroup({ scope: target, ...p }), capMs ?? TOOL_TIMEOUT.READ, 'ki_group_list'),
      });
      const scopeUsed = picked.sc.display;
      if (outcome.kind === 'single') {
        return { text: clip(JSON.stringify(outcome.result)), scopeUsed };
      }
      if (outcome.kind === 'view-empty') {
        return {
          text: clip(JSON.stringify({
            ok: false,
            view: outcome.view,
            error: `视图 ${outcome.view} 没有可用的成员库`,
            skipped: outcome.skipped,
          })),
          scopeUsed,
        };
      }
      return {
        text: clip(JSON.stringify({
          ok: true,
          view: outcome.view,
          members: outcome.members,
          // 标量先于数组保留：buckets 被截断时靠它对照才发现少了成员
          memberTotal: outcome.memberTotal,
          buckets: outcome.buckets,
          ...(outcome.degraded.length > 0 ? { degraded: outcome.degraded } : {}),
          ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
        })),
        scopeUsed,
      };
    }

    if (name === 'ki_scope_list') {
      /*
       * 2026-11-25（Q2/Q4）：改为返回**授权范围内的可用库与视图** —— 模型要自选 scope 时，
       * 这是它能看到的唯一目录。此前只回本次 targets，等于「让你换库但不告诉你有哪些库」。
       */
      const catalog = scopeCatalog?.() ?? { scopes: targets, views: {} };
      return {
        text: clip(JSON.stringify({
          scopes: catalog.scopes,
          views: Object.entries(catalog.views).map(([name, members]) => ({ name, members })),
          defaultScope: targets,
        })),
        scopeUsed: targets,
      };
    }

    if (name === 'ki_tag_list') {
      const picked = pickScopes(args.scope);
      if (!picked.ok) return { text: JSON.stringify({ error: picked.error }) };
      // tag 跨库合并 + 计数累加（与 MCP / 对话 / 分析链路同口径；事件 #112）
      const outcome = await tagListByScope(undefined, {
        resolved: { physical: picked.sc.physical, display: picked.sc.display },
        timeout: { ms: TOOL_TIMEOUT.READ, label: 'ki_tag_list' },
        totalMs: VIEW_TOTAL_TIMEOUT.MCP,
        listOne: (target, capMs) =>
          withTimeout(doTagList({ scope: target }), capMs ?? TOOL_TIMEOUT.READ, 'ki_tag_list'),
      });
      const scopeUsed = picked.sc.display;
      if (outcome.kind === 'single') {
        return { text: clip(JSON.stringify(outcome.result)), scopeUsed };
      }
      if (outcome.kind === 'view-empty') {
        return {
          text: clip(JSON.stringify({
            ok: false,
            view: outcome.view,
            error: `视图 ${outcome.view} 没有可用的成员库`,
            skipped: outcome.skipped,
          })),
          scopeUsed,
        };
      }
      return {
        text: clip(JSON.stringify({
          ok: true,
          view: outcome.view,
          members: outcome.members,
          count: outcome.tags.length,
          tags: outcome.tags,
          ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
        })),
        scopeUsed,
      };
    }

    return { text: JSON.stringify({ error: `未实现的工具：${name}` }) };
  };
}

/** 供调用方复用的类型导出（避免各处重复写） */
export type { GroundedToolOutcome };
