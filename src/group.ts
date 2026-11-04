#!/usr/bin/env node
/**
 * group.ts — `ki group` 命令族（REQ-20261019-005 / S-02）
 *
 *   ki group create <path> [--scope <s>]
 *   ki group delete <path> [--yes] [--scope <s>]
 *   ki group list  [<path>] [--groups a,b] [--mode ...] [--json] [--with-counts] [--scope <s>]
 */

import { Command } from 'commander';
import { closeEngine } from './lib/vector-client.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { resolveScopeTargets } from './lib/scope-view.js';
import { readJson } from './lib/store.js';
import { getGroupIndexPath } from './lib/scope.js';
import { executeGroupCreate } from './lib/group-create.js';
import { planGroupDelete, executeGroupDelete } from './lib/group-delete.js';
import { executeQueryGroup } from './query-group.js';
import {
  listGroupPaths,
  loadGroupCache,
  hasShardedLayout,
  loadCacheShape,
} from './lib/group-cache.js';

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function collectTreePaths(node: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    out.push(p);
    if (child && typeof child === 'object') collectTreePaths(child as Record<string, unknown>, p, out);
  }
}

function collectGroupPaths(scope: string): string[] {
  const paths = new Set<string>();
  const index = readJson<{ groups?: Record<string, unknown> }>(getGroupIndexPath(scope));
  const treePaths: string[] = [];
  collectTreePaths(index?.groups ?? {}, '', treePaths);
  for (const p of treePaths) paths.add(p);
  if (hasShardedLayout(scope)) {
    for (const p of listGroupPaths(scope)) paths.add(p);
  } else {
    const cache = loadCacheShape(scope) as unknown as { groups?: Record<string, unknown> };
    for (const p of Object.keys(cache?.groups ?? {})) paths.add(p);
  }
  return [...paths].sort();
}

function relationCount(scope: string, groupPath: string, sharded: boolean): number {
  if (sharded) return loadGroupCache(scope, groupPath)?.hot_relations.length ?? 0;
  const cache = loadCacheShape(scope) as unknown as {
    groups?: Record<string, { hot_relations?: unknown[] }>;
  };
  return cache?.groups?.[groupPath]?.hot_relations?.length ?? 0;
}

export function buildListJson(opts: {
  scope: string;
  path?: string;
  groups?: string;
  withCounts: boolean;
}): Record<string, unknown> {
  const scope = resolveScope(loadConfig(), opts.scope);
  const sharded = hasShardedLayout(scope);
  const all = collectGroupPaths(scope);

  const roots: string[] = [];
  if (opts.groups) {
    for (const raw of opts.groups.split(',')) {
      const g = raw.trim().replace(/^\/+|\/+$/g, '');
      if (g) roots.push(g);
    }
  } else if (opts.path) {
    roots.push(opts.path.replace(/^\/+|\/+$/g, ''));
  }

  const selected = roots.length === 0
    ? all
    : all.filter((p) => roots.some((r) => p === r || p.startsWith(`${r}/`)));

  const groups = selected.map((p) => {
    const depth = p.split('/').length;
    const children = all.filter(
      (q) => q.startsWith(`${p}/`) && q.split('/').length === depth + 1,
    );
    return {
      path: p,
      children,
      ...(opts.withCounts ? { relations: relationCount(scope, p, sharded) } : {}),
    };
  });

  return { ok: true, scope, groups, total: groups.length };
}

const program = new Command();

program
  .name('group')
  .showHelpAfterError()
  .description('Group 管理：create / delete / list（单一路径，无 --parent / --name）');

program
  .command('create')
  .description('创建单个 Group 节点（父路径必须已存在；scope 不存在则自动创建）')
  .argument('<path>', '组路径，如 "工具库/Redis"')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略）')
  .action(async (groupPath: string, opts) => {
    try {
      const result = await executeGroupCreate({ scope: opts.scope, path: groupPath });
      output(result as unknown as Record<string, unknown>);
      if (!result.ok) process.exitCode = 1;
    } finally {
      await closeEngine();
    }
  });

program
  .command('delete')
  .description('删除整个 Group（默认只预览，追加 --yes 才执行；不触碰 source.dir）')
  .argument('<path>', '组路径，如 "工具库/Redis"')
  .option('--yes', '确认执行（缺省则仅预览，零写入）', false)
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略）')
  .action(async (groupPath: string, opts) => {
    try {
      if (!opts.yes) {
        const plan = await planGroupDelete({ scope: opts.scope, path: groupPath });
        output(plan as unknown as Record<string, unknown>);
        if (!plan.ok) process.exitCode = 1;
        return;
      }
      const result = await executeGroupDelete({ scope: opts.scope, path: groupPath });
      output(result as unknown as Record<string, unknown>);
      if (!result.ok) process.exitCode = 1;
    } finally {
      await closeEngine();
    }
  });

program
  .command('list')
  .description('列出 Group 结构与 Relations（文本渲染，或 --json 结构）')
  .argument('[path]', '子树根路径（与 --groups 互斥）')
  .option('-g, --groups <groups>', '逗号分隔的 Group 路径列表（与 path 互斥）')
  // 默认 full：命令语义是 list，纯树组（无 relation）在 hot 视图里只能看到统计数字、
  // 看不到任何组名（实测 `ki group list` 对只有 create 出来的组的 scope 输出空树）。
  .option('--mode <mode>', '展示分区：full|hot|warm|cold|emerging（可逗号多值；默认 full 渲染树）', 'full')
  .option('--depth <depth>', '索引层级深度', '4')
  .option('--hot-count <count>', '热门展示个数', '5')
  .option('--no-auto-fallback', '禁用语义兜底（默认开启）')
  .option('--json', '输出结构化 JSON（默认只含路径）', false)
  .option('--with-counts', 'JSON 中附带 relations 计数（慢路径，需逐组读分片）', false)
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略）')
  .action(async (groupPath: string | undefined, opts) => {
    try {
      if (groupPath && opts.groups) {
        output({ ok: false, error: 'path 与 --groups 互斥，请只传其一' });
        process.exitCode = 1;
        return;
      }
      if (opts.withCounts && !opts.json) {
        output({ ok: false, error: '--with-counts 只能与 --json 一起使用' });
        process.exitCode = 1;
        return;
      }
      /**
       * 视图模式必须在 `--json` 分支**之前**处理：json 分支走的是
       * `buildListJson({ scope })` 单库路径，先走它会拿视图名去读
       * `dataDir/<视图名>/relations` 而直接报「scope 元数据不存在」。
       */
      const viewConfig = loadConfig();
      const viewTargets = resolveScopeTargets(viewConfig, opts.scope);
      if (viewTargets.views.length > 0 && viewTargets.scopes.length > 1) {
        const buckets: { scope: string; output?: string; groups?: unknown; error?: string }[] = [];
        for (const member of viewTargets.scopes) {
          try {
            if (opts.json) {
              buckets.push({ scope: member, groups: buildListJson({
                scope: member,
                path: groupPath,
                groups: opts.groups,
                withCounts: !!opts.withCounts,
              }) });
            } else {
              const r = await executeQueryGroup({
                scope: member,
                groupsParam: opts.groups,
                subtreeParam: groupPath,
                hotCount: Number(opts.hotCount) || 5,
                depth: Number(opts.depth) || 4,
                modes: String(opts.mode ?? 'full').split(',').map((m) => m.trim()).filter(Boolean),
                autoFallback: opts.autoFallback,
              });
              buckets.push(r.ok ? { scope: member, output: r.output } : { scope: member, error: r.error });
            }
          } catch (err) {
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        if (opts.json) {
          output({
            ok: true,
            view: viewTargets.views[0],
            members: viewTargets.scopes,
            buckets,
            ...(viewTargets.skipped.length > 0 ? { skipped: viewTargets.skipped } : {}),
          });
          return;
        }
        console.log(`视图 ${viewTargets.views.join(',')}（${viewTargets.scopes.length} 个成员）\n`);
        for (const b of buckets) {
          console.log(`── ${b.scope} ${'─'.repeat(Math.max(4, 40 - b.scope.length))}`);
          console.log(b.error ? `✗ ${b.error}` : b.output);
          console.log('');
        }
        if (viewTargets.skipped.length > 0) {
          console.error(`⚠ 已跳过：${viewTargets.skipped.map((k) => `${k.scope}（${k.reason}）`).join('；')}`);
        }
        return;
      }

      if (opts.json) {
        try {
          output(buildListJson({
            scope: opts.scope,
            path: groupPath,
            groups: opts.groups,
            withCounts: !!opts.withCounts,
          }));
        } catch (err) {
          output({ ok: false, error: (err as Error).message });
          process.exitCode = 1;
        }
        return;
      }

      const queryOpts = {
        groupsParam: opts.groups,
        subtreeParam: groupPath,
        hotCount: Number(opts.hotCount) || 5,
        depth: Number(opts.depth) || 4,
        modes: String(opts.mode ?? 'full').split(',').map((m) => m.trim()).filter(Boolean),
        autoFallback: opts.autoFallback,
      };

      /**
       * 视图模式：**按成员库分桶**，绝不合并同名组。
       * 两个库都有 `projects` 时各自一棵树——合并后看不出文档属于哪个库，
       * 且同名组必然撞（S-07 D1）。
       */
      const config = loadConfig();
      const targets = resolveScopeTargets(config, opts.scope);
      if (targets.views.length > 0 && targets.scopes.length > 1) {
        const buckets: { scope: string; output?: string; error?: string }[] = [];
        for (const member of targets.scopes) {
          try {
            const r = await executeQueryGroup({ scope: member, ...queryOpts });
            buckets.push(r.ok ? { scope: member, output: r.output } : { scope: member, error: r.error });
          } catch (err) {
            // 单个成员的索引损坏不应让整个视图不可用（告警在桶内）
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        if (opts.json) {
          output({
            ok: true,
            view: targets.views[0],
            members: targets.scopes,
            buckets,
            ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
          });
          return;
        }
        console.log(`视图 ${targets.views.join(',')}（${targets.scopes.length} 个成员）\n`);
        for (const b of buckets) {
          console.log(`── ${b.scope} ${'─'.repeat(Math.max(4, 40 - b.scope.length))}`);
          console.log(b.error ? `✗ ${b.error}` : b.output);
          console.log('');
        }
        if (targets.skipped.length > 0) {
          console.error(`⚠ 已跳过：${targets.skipped.map((k) => `${k.scope}（${k.reason}）`).join('；')}`);
        }
        return;
      }

      const result = await executeQueryGroup({ scope: opts.scope, ...queryOpts });
      if (result.ok) {
        console.log(`[scope: ${result.scope}]\n${result.output}`);
      } else {
        output({ ok: false, scope: opts.scope, error: result.error });
        process.exitCode = 1;
      }
    } finally {
      await closeEngine();
    }
  });

// 直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();
if (_isMain) program.parse();
