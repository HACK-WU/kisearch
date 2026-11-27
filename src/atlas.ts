#!/usr/bin/env node
/**
 * atlas.ts - ki atlas CLI（REQ-20261120-003 S-03）
 *
 * 图集的安装 / 查看 / 卸载。**一期唯一的写入口**（页面上传是二期）。
 *
 * 用法:
 *   ki atlas upload --scope <s> --file <pkg.zip> [--title <t>] [--json]
 *   ki atlas status --scope <s> [--json]
 *   ki atlas remove --scope <s> --yes
 *
 * 设计要点:
 *   - 直连内核（src/lib/atlas/），不经 HTTP —— 不要求 daemon 常驻，
 *     也不会把「daemon 没起」和「包不合法」两类失败混在一起。
 *   - 校验全在内核里（单一出口）；本文件只做参数、scope 校验与输出。
 *   - 每条错误都带错误码 + 下一步怎么办（agent 要能按码分支）。
 */
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveScope, isScopeReadonly } from './lib/config.js';
import { DEFAULT_MCP_HTTP_PORT } from './lib/mcp-http.js';
import { scopeDirExists, ensureScopeDir } from './lib/store.js';
import { readViews, updateView } from './lib/scope-view.js';
import {
  ALL_SCOPES,
  isScopeAuthorized,
  listTokensGrantingView,
  updateTokenScopes,
} from './lib/mcp-token.js';
import { atlasScopeFor, mainScopeFor, resolveAtlasMap, AtlasScopeMapError } from './lib/atlas/scope-map.js';
import { AUTO_LINK_MAX_MEMBERS, planAtlasLink, planTokenGrants, withAtlasScope } from './lib/atlas/link.js';
import {
  AtlasError,
  MAX_ZIP_BYTES,
  describeAtlasError,
  installPackage,
  readStatus,
  removePackage,
} from './lib/atlas/index.js';
import type { AtlasMeta } from './lib/atlas/index.js';

/** 退出码约定（写进 skill 的排障表，别随手改） */
const EXIT_OK = 0;
/** 包不合法 / 参数错 */
const EXIT_INVALID = 1;
/** 库不存在或只读 */
const EXIT_SCOPE = 2;
/** 文件不存在 */
const EXIT_NOFILE = 3;

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

/**
 * 解析「主库 ↔ 图集库」两个落点（2026-11-27）。
 *
 * - 常规：`--scope kisearch` → 图集库 `kisearch-atlas`
 * - 自指：`--scope kisearch-atlas` → 主库反查为 `kisearch`，落点仍是自身
 * - 覆盖：`--atlas-scope X`
 * - 过渡：`--legacy-scope` 时 `--scope` 就是落点库，不做推导
 */
function resolveScopePair(
  raw?: string,
  opts?: { atlasScope?: string; legacyScope?: boolean },
): { mainScope: string; atlasScope: string } {
  const config = loadConfig();
  const input = resolveScope(config, raw);
  if (opts?.legacyScope) return { mainScope: input, atlasScope: input };

  let map;
  try {
    map = resolveAtlasMap(config);
  } catch (err) {
    if (err instanceof AtlasScopeMapError) {
      fail(`${err.message}\n→ 修正配置后重试，或用 --atlas-scope 显式指定落点。`, EXIT_INVALID);
    }
    throw err;
  }
  if (opts?.atlasScope) {
    // --scope 显式给了主库就用它；只有 `--scope <图集库> --atlas-scope <同一个库>`
    // 这种自指写法才反查主库（否则会把用户显式给的主库覆盖掉）
    const mainScope = opts.atlasScope === input
      ? (mainScopeFor(input, map) ?? input)
      : input;
    return { mainScope, atlasScope: opts.atlasScope };
  }
  const derived = atlasScopeFor(input, map);
  if (derived !== input) return { mainScope: input, atlasScope: derived };
  // 自指：传进来的已是图集库，反查主库用于 meta 记录
  return { mainScope: mainScopeFor(input, map) ?? input, atlasScope: input };
}

/**
 * 写入前的落点校验：**主库必须已存在**，图集库允许不存在（部署产物，自动初始化）。
 *
 * 主库存在性是 2026-11-27 评审抓到的洞：不校验时 `--scope kisearc`（typo）
 * 会静默建出 `kisearc-atlas` 并装包，留下孤儿库且映射全错。
 */
function requireInstallTargets(mainScope: string, atlasScope: string): void {
  if (!scopeDirExists(mainScope)) {
    fail(
      `主库 ${mainScope} 不存在（尚未初始化）。\n→ 用 ki scope list 核对库名；本命令不会为写错的名字建库。`,
      EXIT_SCOPE,
    );
  }
  const config = loadConfig();
  if (scopeDirExists(atlasScope)) {
    if (isScopeReadonly(config, atlasScope)) {
      fail(`图集库 ${atlasScope} 是只读库，不能写入图集。\n→ 换一个可写库，或由管理员解除只读。`, EXIT_SCOPE);
    }
    return;
  }
  try {
    ensureScopeDir(atlasScope);
  } catch (err) {
    fail(
      `无法创建图集库 ${atlasScope}：${(err as Error).message}\n→ strict 模式下需先在配置中注册该 scope。`,
      EXIT_SCOPE,
    );
  }
}

// 小于 1 KB 用字节数，避免 meta.json（137 B）显示成「0 KB」
const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);

/** 人读摘要：装完给用户看什么（设计 S03 §3.3） */
function printInstallSummary(scope: string, meta: AtlasMeta, archived: boolean, mainScope?: string): void {
  const entries = meta.entries?.map((e) => `${e.name} ${kb(e.size)}`).join(' · ') ?? '-';
  console.log(`校验通过：${meta.entries?.length ?? 0} 个条目 · ${entries}`);
  console.log(`已安装到 ${scope}/.atlas/`);
  if (mainScope && mainScope !== scope) {
    console.log(`  归属主库 ${mainScope}（图集库独立存放，主库页会自动回落）`);
    console.log(`  下一步   ki import --scope ${scope} --source dist/atlas-md --group 知识地图 --prune`);
    console.log(`  再关联   ki atlas link --scope ${mainScope}`);
  }
  console.log(`  标题   ${meta.title}`);
  console.log(`  基线   ${meta.branch}@${meta.baseline}（生成 ${meta.generatedAt.slice(0, 10)}）`);
  console.log(`  体积   ${kb(meta.size)}（zip ${kb(meta.packageSize)}）`);
  console.log(`  sha    ${meta.sha256.slice(0, 8)}`);
  if (archived) console.log('上一版已归档到 archive/（可用同一条命令回滚）');
  const cfg = loadConfig() as unknown as { mcp?: { http?: { port?: number } } };
  const port = cfg.mcp?.http?.port ?? DEFAULT_MCP_HTTP_PORT;
  console.log(`\n打开 http://127.0.0.1:${port}/atlas 查看（未启动 daemon 时先 ki mcp --http）`);
}

function jsonMeta(scope: string, meta: AtlasMeta, extra: Record<string, unknown> = {}): void {
  // 与 GET /api/atlas/status 同构：页面状态栏与 CLI 共用一套字段名
  console.log(JSON.stringify({ ok: true, scope, exists: true, ...meta, ...extra }, null, 2));
}

const program = new Command();
program.name('atlas').showHelpAfterError().description('知识地图图集：上传 / 查看 / 卸载（一期唯一写入口）');

program
  .command('upload')
  .description('安装一个图集压缩包（同库重复上传即覆盖，旧版进 archive/）')
  .option('--scope <scope>', '主库（图集库按映射推导，缺省 <主库>-atlas）')
  .option('--file <file>', '图集压缩包路径（pack_atlas.py 产出的 .zip）')
  .option('--title <title>', '标题（包内 meta.json 缺失时的兜底）')
  .option('--atlas-scope <scope>', '显式指定图集库（跳过映射推导）')
  .option('--legacy-scope', '旧行为：--scope 即图集落点库（过渡期保留）', false)
  .option('--json', '输出 JSON（与 /api/atlas/status 同构）', false)
  .action((opts: {
    scope?: string; file?: string; title?: string;
    atlasScope?: string; legacyScope?: boolean; json?: boolean;
  }) => {
    if (!opts.file) {
      fail('缺少 --file <pkg.zip>。\n→ 例：ki atlas upload --scope kisearch --file dist/atlas.zip', EXIT_INVALID);
    }
    const file = path.resolve(opts.file);
    if (!fs.existsSync(file)) {
      fail(`文件不存在：${file}\n→ 先跑 pack_atlas.py <图集目录> dist/ --zip`, EXIT_NOFILE);
    }
    // 传目录是最常见的误用：readFileSync 会抛 EISDIR 并把栈甩给用户，先说人话
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      fail(`--file 需要指向压缩包文件，收到的是目录：${file}\n→ 例：--file dist/atlas.zip`, EXIT_INVALID);
    }
    const size = stat.size;
    if (size > MAX_ZIP_BYTES) {
      fail(`包体积 ${(size / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB（ATLAS_TOO_LARGE · 1403）\n→ 减少视图数量后重打包。`, EXIT_INVALID);
    }

    const { mainScope, atlasScope } = resolveScopePair(opts.scope, opts);
    requireInstallTargets(mainScope, atlasScope);
    /*
     * 旧部署检测（2026-11-27）：主库自身已装过图集、图集库还没有 →
     * 用户很可能在按旧语义重传；静默写到新库会让他以为"更新了"，实际多出一份。
     */
    if (!opts.legacyScope && mainScope !== atlasScope
      && readStatus(mainScope).exists && !readStatus(atlasScope).exists) {
      fail(
        `主库 ${mainScope} 自身已有图集，但图集库 ${atlasScope} 还没有。\n`
        + `→ 要搬到图集库：先删除旧图集再重跑（ki atlas remove --scope ${mainScope} --yes）\n`
        + `→ 要按旧方式继续更新旧图集：加 --legacy-scope`,
        EXIT_INVALID,
      );
    }
    const metaFallback: { title?: string; mainScope?: string } = {};
    if (opts.title) metaFallback.title = opts.title;
    if (mainScope !== atlasScope) metaFallback.mainScope = mainScope;
    try {
      const { meta, archived } = installPackage(atlasScope, fs.readFileSync(file), {
        uploadedBy: `cli:${(() => { try { return os.userInfo().username; } catch { return 'unknown'; } })()}`,
        ...(Object.keys(metaFallback).length > 0 ? { meta: metaFallback } : {}),
      });
      if (opts.json) jsonMeta(atlasScope, meta, { archived, mainScope });
      else printInstallSummary(atlasScope, meta, archived, mainScope);
      process.exit(EXIT_OK);
    } catch (err) {
      if (err instanceof AtlasError) fail(describeAtlasError(err), EXIT_INVALID);
      throw err;
    }
  });

program
  .command('status')
  .description('查看某库是否已安装图集')
  .option('--scope <scope>', '目标库')
  .option('--json', '输出 JSON', false)
  .action((opts: { scope?: string; json?: boolean }) => {
    const scope = resolveScope(loadConfig(), opts.scope);
    const st = readStatus(scope);
    if (opts.json) {
      console.log(JSON.stringify(st.exists && st.meta ? { ok: true, scope, exists: true, ...st.meta } : { ok: true, scope, exists: false }, null, 2));
      process.exit(EXIT_OK);
    }
    if (!st.exists || !st.meta) {
      console.log(`${scope}：还没有图集\n→ 部署：ki atlas upload --scope ${scope} --file dist/atlas.zip`);
      process.exit(EXIT_OK);
    }
    const m = st.meta;
    console.log(`${scope}：已安装`);
    console.log(`  标题   ${m.title}`);
    console.log(`  基线   ${m.branch}@${m.baseline}（生成 ${m.generatedAt.slice(0, 10)}）`);
    console.log(`  体积   ${kb(m.size)}（zip ${kb(m.packageSize)}）`);
    console.log(`  sha    ${m.sha256.slice(0, 8)}`);
    console.log(`  上传   ${m.uploadedAt.replace('T', ' ').slice(0, 19)}${m.uploadedBy ? ` · ${m.uploadedBy}` : ''}`);
    process.exit(EXIT_OK);
  });

program
  .command('remove')
  .description('卸载当前图集（archive/ 里的备份不受影响）')
  .option('--scope <scope>', '主库（图集库按映射推导）')
  .option('--atlas-scope <scope>', '显式指定图集库')
  .option('--legacy-scope', '旧行为：--scope 即落点库', false)
  .option('--yes', '跳过确认', false)
  .action((opts: { scope?: string; atlasScope?: string; legacyScope?: boolean; yes?: boolean }) => {
    const { atlasScope } = resolveScopePair(opts.scope, opts);
    // 卸载不要求主库存在（可能只是清理图集库），只做只读保护
    if (scopeDirExists(atlasScope) && isScopeReadonly(loadConfig(), atlasScope)) {
      fail(`图集库 ${atlasScope} 是只读库，不能卸载图集。`, EXIT_SCOPE);
    }
    const st = readStatus(atlasScope);
    if (!st.exists) {
      console.log(`${atlasScope}：没有可卸载的图集`);
      process.exit(EXIT_OK);
    }
    if (!opts.yes) {
      fail(`将删除 ${atlasScope} 的当前图集（archive/ 保留）。确认请加 --yes`, EXIT_INVALID);
    }
    const removed = removePackage(atlasScope);
    console.log(removed ? `已卸载 ${atlasScope} 的图集（archive/ 保留，可回滚）` : `${atlasScope}：没有可卸载的图集`);
    process.exit(EXIT_OK);
  });

program
  .command('link')
  .description('把图集库加入主库所在的视图，并（默认）补齐 Token 授权')
  .option('--scope <scope>', '主库（图集库按映射推导）')
  .option('--atlas-scope <scope>', '显式指定图集库')
  .option('--views <list>', '限定视图（逗号分隔；缺省自动发现）')
  .option('--no-grant', '只加视图成员，不补 Token 授权')
  .option('--json', '输出 JSON', false)
  .action((opts: {
    scope?: string; atlasScope?: string; views?: string; grant?: boolean; json?: boolean;
  }) => {
    const config = loadConfig();
    const { mainScope, atlasScope } = resolveScopePair(opts.scope, { atlasScope: opts.atlasScope });
    if (!scopeDirExists(mainScope)) {
      fail(`主库 ${mainScope} 不存在。\n→ 用 ki scope list 核对库名。`, EXIT_SCOPE);
    }
    if (!scopeDirExists(atlasScope)) {
      fail(
        `图集库 ${atlasScope} 还不存在。\n→ 先执行：ki atlas upload --scope ${mainScope} --file <zip>`,
        EXIT_SCOPE,
      );
    }

    const views = readViews(config);
    const names = Object.keys(views);
    if (names.length === 0) {
      fail('没有任何视图定义。\n→ 先建视图：ki view create <名> --members <主库>', EXIT_INVALID);
    }

    const linkPlan = planAtlasLink({
      mainScope,
      views,
      ...(opts.views
        ? { viewFilter: opts.views.split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
    });
    if (linkPlan.missingViews.length > 0) {
      fail(`视图不存在：${linkPlan.missingViews.join('、')}`, EXIT_INVALID);
    }
    // 指定了但不含主库 = 用户以为关联上了，实际没有 → 显式拒绝，不静默忽略
    if (linkPlan.notContaining.length > 0) {
      fail(`以下视图不含主库 ${mainScope}，已拒绝：${linkPlan.notContaining.join('、')}`, EXIT_INVALID);
    }
    if (linkPlan.skipped.length > 0) {
      console.log(
        `跳过 ${linkPlan.skipped.join('、')}（成员超过 ${AUTO_LINK_MAX_MEMBERS} 个，自动关联会扩大授权范围；需要时用 --views 显式指定）`,
      );
    }
    if (linkPlan.targets.length === 0) {
      fail(
        `未发现可关联的视图（主库 ${mainScope} 不在任何 ≤${AUTO_LINK_MAX_MEMBERS} 成员的视图里）。\n`
        + `→ 用 --views 显式指定，或先 ki view create。`,
        EXIT_INVALID,
      );
    }
    const targets = linkPlan.targets;

    /*
     * 阶段 A（只读）：先取受影响 Token 并验证 token 存储可读。
     * 任何一步失败都整体中止，**不写任何成员** —— 先改 views 再补授权、失败不回滚，
     * 会让视图因缺成员授权直接从列表消失（2026-11-27 评审阻断项）。
     */
    const plan: { view: string; tokens: ReturnType<typeof listTokensGrantingView> }[] = [];
    for (const view of targets) {
      let tokens: ReturnType<typeof listTokensGrantingView> = [];
      try {
        tokens = listTokensGrantingView(view);
      } catch (err) {
        fail(
          `读取 Token 失败（视图 ${view}）：${(err as Error).message}\n→ 本次未写入任何成员；检查 ki mcp token list 是否可用。`,
          EXIT_INVALID,
        );
      }
      plan.push({ view, tokens });
    }

    // 阶段 B（写）：加成员 → 补授权；补授权失败回滚该视图的成员
    const results: {
      view: string; members: number; added: boolean;
      updated: string[]; skipped: string[];
    }[] = [];
    for (const { view, tokens } of plan) {
      const before = views[view].members.slice();
      const next = updateView(config, view, (cur) => (
        cur.includes(atlasScope) ? cur : [...cur, atlasScope]
      )) ?? before;
      const updated: string[] = [];
      const skippedTokens: string[] = [];
      const grantPlan = opts.grant === false
        ? { updated: [] as string[], skipped: [] as string[] }
        : planTokenGrants({
            tokens,
            atlasScope,
            allScopes: ALL_SCOPES,
            isAuthorized: isScopeAuthorized,
          });
      skippedTokens.push(...grantPlan.skipped.map((id) => `${id}（全量授权）`));
      for (const id of grantPlan.updated) {
        const token = tokens.find((t) => t.id === id);
        if (!token) continue;
        try {
          updateTokenScopes(id, withAtlasScope(token.scopes, atlasScope));
          updated.push(id);
        } catch (err) {
          updateView(config, view, () => before); // 回滚成员，避免「视图消失」
          fail(
            `补授权失败（Token ${id}）：${(err as Error).message}\n→ 已回滚视图 ${view} 的成员变更。`,
            EXIT_INVALID,
          );
        }
      }
      results.push({
        view,
        members: next.length,
        added: !before.includes(atlasScope),
        updated,
        skipped: skippedTokens,
      });
    }

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, scope: mainScope, atlasScope, views: results }, null, 2));
      process.exit(EXIT_OK);
    }
    console.log(`图集库 ${atlasScope} 已关联到主库 ${mainScope} 的视图：`);
    for (const row of results) {
      const grant = opts.grant === false
        ? '未补授权（--no-grant）'
        : `补授权 ${row.updated.length} 个${row.skipped.length > 0 ? `，跳过 ${row.skipped.length} 个` : ''}`;
      console.log(`  ${row.added ? '+' : '='} ${row.view}（${row.members} 个成员）· ${grant}`);
    }
    if (opts.grant === false) {
      console.log('\n⚠ 未补授权时，已授权这些视图但缺图集库授权的 Token 将看不到视图。');
      console.log('  核对：ki view audit-grants');
    }
    process.exit(EXIT_OK);
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
