/**
 * `ki_tag_list` 的「视图展开」统一入口。
 *
 * 视图语义与 group/doc **不同**：tag 是跨库筛选维度，Agent 要的是「整个视图有哪些 tag、
 * 各多少篇」，所以**合并 + 计数累加**（不分桶）；分桶会让它逐库调一遍才知道全貌。
 *
 * 展开逻辑原本只写在 MCP 工具（`src/lib/mcp-tools/tag-list.ts`），对话侧直接调
 * `executeTagList(视图名)` → `vectorListTags` 返回空列表，**静默冒充「没有 tag」**
 * （比报错更糟：模型会认为该视图无标签可用）。2026-11-26 · 事件 #110 复查时发现。
 *
 * ★ 2026-11-27（事件 #112）：分析 / 查找链路仍沿用「命中即止」的单库语义，
 *   视图下只返回首个成员库的 tag。与 group-list-view 同形，这里加两个可选入参：
 *     - `resolved`：调用方已解析的成员库，跳过本层的视图解析；
 *     - `listOne`：执行器接管（调用方要套 config 快照 / 互斥时传）。
 */
import { loadConfig } from './config.js';
import { isViewRequest, resolveScopeTargets, type ScopeTargets } from './scope-view.js';
import { withTimeout } from './mcp-tools/util.js';
import { executeTagList, type TagListResult } from '../tag.js';

/** 单个 tag 条目（从成功形状里取，避免对 union 做条件类型分发导致 never） */
type TagOk = Extract<TagListResult, { ok: true }>;
export type TagItem = TagOk['tags'][number];

export interface TagListQueryOptions {
  timeout: { ms: number; label: string };
  /** 视图整体上限（可选；超时后剩余成员记入 skipped 而不是整体失败） */
  totalMs?: number;
  /**
   * 调用方已解析好的成员库（分析 / 查找链路传入）。
   * 传了就跳过 `resolveScopeTargets`：`physical` 长度 > 1 走合并分支，= 1 走单库。
   */
  resolved?: { physical: string[]; display: string[] };
  /** 执行器接管（可选）：调用方要套 config 快照 / OperationCoordinator 时传入 */
  listOne?: (target: string, capMs: number | undefined) => Promise<TagListResult>;
}

export type TagListOutcome =
  | { kind: 'single'; result: TagListResult }
  | {
    kind: 'view';
    view: string;
    members: string[];
    /** 合并后的 tag（按文档数降序，同数按字典序） */
    tags: (TagItem & { scopes: string[] })[];
    skipped: { scope: string; reason: string }[];
  }
  | { kind: 'view-empty'; view: string; skipped: { scope: string; reason: string }[] };

export async function tagListByScope(
  scope: string | undefined,
  opts: TagListQueryOptions,
): Promise<TagListOutcome> {
  const { timeout, totalMs, resolved, listOne } = opts;

  const runMember = (target: string, capMs: number | undefined): Promise<TagListResult> => {
    if (listOne) return listOne(target, capMs);
    const ms = capMs === undefined ? timeout.ms : Math.max(1, Math.min(timeout.ms, capMs));
    return withTimeout(executeTagList({ scope: target }), ms, timeout.label);
  };

  let targets: ScopeTargets;
  if (resolved) {
    targets = { scopes: resolved.physical, views: resolved.display, skipped: [], multiRequested: resolved.physical.length > 1 };
  } else {
    targets = resolveScopeTargets(loadConfig(), scope);
  }

  // 与 group-list-view 同口径：视图 + 逗号多库（multiRequested）都走多成员分支，
  // resolved 按物理库个数判断。此前只认视图名，scope:"a,b" 只返回首个库的 tag（#112 残留面）
  const multi = resolved
    ? targets.scopes.length > 1
    : (isViewRequest(targets) || targets.multiRequested);

  if (!multi) {
    const target = targets.scopes[0] ?? scope ?? 'default';
    return { kind: 'single', result: await runMember(target, undefined) };
  }

  // 回显：视图给视图名、逗号多库给原始入参、resolved 给 display
  const view = resolved ? resolved.display.join(',') : (targets.views[0] ?? scope ?? '');
  if (targets.scopes.length === 0) {
    return { kind: 'view-empty', view, skipped: targets.skipped };
  }

  const merged = new Map<string, TagItem & { scopes: string[] }>();
  const skipped: { scope: string; reason: string }[] = [...targets.skipped];
  const deadline = totalMs === undefined ? undefined : Date.now() + totalMs;

  for (const member of targets.scopes) {
    const remainMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainMs !== undefined && remainMs <= 0) {
      skipped.push({
        scope: member,
        reason: `视图整体超时（${totalMs}ms）已用尽，未读取该成员`,
      });
      continue;
    }
    try {
      const r = await runMember(member, remainMs);
      if (!r.ok) {
        skipped.push({ scope: member, reason: r.error });
        continue;
      }
      for (const t of r.tags) {
        const hit = merged.get(t.tag);
        if (hit) {
          hit.count += t.count;
          if (!hit.scopes.includes(member)) hit.scopes.push(member);
        } else {
          merged.set(t.tag, { ...t, scopes: [member] });
        }
      }
    } catch (err) {
      skipped.push({ scope: member, reason: (err as Error).message });
    }
  }

  const tags = [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { kind: 'view', view, members: targets.scopes, tags, skipped };
}
