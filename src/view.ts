#!/usr/bin/env node
/**
 * view.ts —— `ki view` 视图管理（知识视图 = 多个 scope 的只读聚合）
 *
 * 用法:
 *   ki view list   [--json]
 *   ki view show   <name> [--json]
 *   ki view create <name> --members a,b   （或 --add a --add b）
 *   ki view rename <old> <new>            （ID 不变，token 授权不受影响）
 *   ki view add    <name> <scope>
 *   ki view remove <name> <scope>
 *   ki view delete <name> --yes
 *
 * 语义（详见 src/lib/scope-view.ts 顶部注释）：
 *   - 视图与 scope 共用命名空间且唯一，成员必须是真实 scope（禁嵌套）
 *   - 视图**只用于读路径**；写路径收到视图名一律 fail-loud（见 scope-policy.ts）
 *   - 定义存 `views.json`（与 config 同目录），**不写进 config.yaml**
 *   - 删除只解散定义，**不动任何知识库数据**
 */

import fs from 'node:fs';
import { Command } from 'commander';
import { loadConfig } from './lib/config.js';
import { getKbDir } from './lib/scope.js';
import {
  ViewError,
  createView,
  deleteView,
  getViewsPath,
  listViewNames,
  readViews,
  renameView,
  updateView,
  validateViewMembers,
  validateViewName,
  type ViewConfig,
} from './lib/scope-view.js';
import {
  ALL_SCOPES,
  isScopeAuthorized,
  listTokens,
  listTokensGrantingView,
  resolveDefaultCliTokenOwner,
} from './lib/mcp-token.js';
import { listUsers } from './lib/user-store.js';

/** userId → 显示名。用户文件不可读时返回空表（只影响展示，不阻断命令） */
function safeUserNames(): Map<string, string> {
  try {
    return new Map(listUsers().map((u) => [u.id, u.username]));
  } catch {
    return new Map();
  }
}

/** 统一错误出口：ViewError 打印 code + 文案，其他错误原样透出 */
function fail(err: unknown): void {
  if (err instanceof ViewError) {
    console.error(`错误：${err.message}`);
    console.error(`  错误码：${err.code}`);
  } else {
    console.error(`错误：${(err as Error).message}`);
  }
  process.exitCode = 1;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/** 成员是否存在本地 KB 目录（配置级判定：不查向量层，那一层归 ki scope list） */
function memberHasKb(scope: string): boolean {
  try {
    return fs.existsSync(getKbDir(scope));
  } catch {
    return false;
  }
}

/** 把 `--members a,b` 与反复出现的 `--add x` 合并为成员列表 */
function collectMembers(opts: { members?: string; add?: string[] }): string[] {
  const out: string[] = [];
  if (typeof opts.members === 'string') {
    for (const part of opts.members.split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  for (const item of opts.add ?? []) {
    const s = String(item).trim();
    if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

const program = new Command();

program
  .name('view')
  .showHelpAfterError()
  .description('知识视图管理（多个 scope 的只读聚合；视图可当 scope 用于所有读命令）');

// ─── list ────────────────────────────────────────────────

program
  .command('list')
  .description('列出全部视图')
  .option('--json', '输出结构化 JSON', false)
  .action((opts) => {
    try {
      const config = loadConfig();
      const views = readViews(config);
      const names = listViewNames(config);

      if (opts.json) {
        const userNames = safeUserNames();
        printJson({
          ok: true,
          path: getViewsPath(config),
          count: names.length,
          views: names.map((name) => ({
            view: name,
            // R-07 / R-12：id 是 token 授权的锚点，审计字段供页面展示
            id: views[name].id,
            members: views[name].members,
            missing: views[name].members.filter((m) => !memberHasKb(m)),
            createdBy: views[name].createdBy ?? null,
            /*
             * 同时给显示名：`createdBy` 是 userId，用户看到一串 ID 等于没信息
             * （页面侧已由 `/api/views` 翻译，CLI 侧不能落后）。
             */
            ...(views[name].createdBy && userNames.has(views[name].createdBy)
              ? { createdByName: userNames.get(views[name].createdBy) }
              : {}),
            createdAt: views[name].createdAt ?? null,
            updatedBy: views[name].updatedBy ?? null,
            updatedAt: views[name].updatedAt ?? null,
            revision: views[name].revision,
          })),
        });
        return;
      }

      if (names.length === 0) {
        console.log('还没有任何视图。');
        console.log('  创建：ki view create <名称> --members <scope1>,<scope2>');
        return;
      }

      console.log(`视图（${names.length} 个）· ${getViewsPath(config)}\n`);
      const width = Math.max(...names.map((n) => n.length), 4);
      for (const name of names) {
        const members = views[name].members;
        const missing = members.filter((m) => !memberHasKb(m));
        const tail = missing.length > 0 ? `   ⚠ 缺失：${missing.join(', ')}` : '';
        console.log(`  ${name.padEnd(width)}  ${String(members.length).padStart(2)} 个库   ${members.join(' / ')}${tail}`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ─── audit-grants ────────────────────────────────────────

program
  .command('audit-grants')
  .description('检查「授权了视图但缺少成员授权」的 Token —— D3 收紧后这些 Token 将看不到该视图')
  .option('--json', '输出结构化 JSON', false)
  .action((opts) => {
    try {
      const config = loadConfig();
      const views = readViews(config);
      const byId = new Map(Object.entries(views).map(([name, def]) => [def.id, name]));

      let tokens: ReturnType<typeof listTokens>;
      try {
        tokens = listTokens();
      } catch (err) {
        console.log(`没有可读的 Token 文件，无需检查。(${(err as Error).message})`);
        return;
      }

      const affected: { id: string; label: string | null; view: string; missing: string[] }[] = [];
      for (const token of tokens) {
        const scopes = Array.isArray(token.scopes) ? token.scopes : [];
        // ALL_SCOPES 是全量授权，不受成员收紧影响
        if (scopes.includes(ALL_SCOPES)) continue;

        const grants = Array.isArray(token.viewGrants) ? token.viewGrants : [];
        const grantedViews = new Set<string>();
        for (const g of grants) {
          const name = byId.get(g);
          if (name) grantedViews.add(name);
          else if (Object.prototype.hasOwnProperty.call(views, g)) grantedViews.add(g); // 存量按名字记录
        }
        // 历史写法：视图名混在 scopes 里
        for (const s of scopes) {
          if (Object.prototype.hasOwnProperty.call(views, s)) grantedViews.add(s);
        }

        for (const viewName of grantedViews) {
          const missing = views[viewName].members.filter((m) => !isScopeAuthorized(scopes, m));
          if (missing.length > 0) {
            affected.push({ id: token.id, label: token.label ?? null, view: viewName, missing });
          }
        }
      }

      if (opts.json) {
        printJson({ ok: true, affected: affected.length, tokens: affected });
        return;
      }

      if (affected.length === 0) {
        console.log('✅ 没有 Token 受影响：已授权的视图，其成员也都已授权。');
        return;
      }

      console.log(`⚠ ${affected.length} 处授权会在升级后失效（D3：授权视图 ∧ 授权全部成员，缺一即不可见）：\n`);
      for (const row of affected) {
        console.log(`  - ${row.label ?? '(未命名)'}  ${row.id}`);
        console.log(`      ${row.view} → 缺 ${row.missing.join(', ')}`);
        const all = [...new Set([...views[row.view].members])];
        console.log(`    修复：ki mcp token update ${row.id} --scope ${all.join(',')}`);
      }
      console.log('\n说明：视图名本身仍然有效，但成员未授权时该视图不会出现在 ki_scope_list，也读不到内容。');
    } catch (err) {
      fail(err);
    }
  });

// ─── show ────────────────────────────────────────────────

program
  .command('show')
  .description('查看单个视图的成员（配置级：KB 目录是否存在，不查向量层与只读）')
  .argument('<name>', '视图名')
  .option('--json', '输出结构化 JSON', false)
  .action((name: string, opts) => {
    try {
      const config = loadConfig();
      const views = readViews(config);
      const entry: ViewConfig | undefined = views[name];
      if (!entry) {
        throw new ViewError('VIEW_NOT_FOUND', `视图「${name}」不存在；用 ki view list 查看全部视图`, name);
      }

      const rows = entry.members.map((m) => ({ scope: m, kb: memberHasKb(m) }));

      if (opts.json) {
        printJson({ ok: true, view: name, path: getViewsPath(config), members: entry.members, memberMeta: rows });
        return;
      }

      // 逐行「状态 + 成员名」而非列表头对齐：成员名是 ASCII、表头是中文，
      // padEnd 按字符数补空格会让中日韩字符与等宽字母错位（成员名越长错得越多）。
      console.log(`视图 ${name}（${entry.members.length} 个成员）· ${getViewsPath(config)}\n`);
      for (const row of rows) {
        const mark = row.kb ? '✓' : '✗';
        const note = row.kb ? '' : '   尚未导入（导入后自动生效）';
        console.log(`  ${mark}  ${row.scope}${note}`);
      }
      const missing = rows.filter((r) => !r.kb).length;
      if (missing > 0) {
        console.log(`\n  其中 ${missing} 个成员尚无本地 KB 目录；检索时会被跳过并上报。`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ─── create ──────────────────────────────────────────────

program
  .command('create')
  .description('创建视图（成员可暂不存在，导入后自动生效）')
  .argument('<name>', '视图名（字母 / 数字 / 连字符 / 下划线）')
  .option('-m, --members <list>', '逗号分隔的成员 scope 列表')
  .option('-a, --add <scope>', '追加一个成员（可重复）', (v: string, acc: string[]) => {
    acc.push(v);
    return acc;
  }, [] as string[])
  .option('--json', '输出结构化 JSON', false)
  .action((name: string, opts) => {
    try {
      const config = loadConfig();
      const members = collectMembers(opts);
      if (members.length === 0) {
        throw new ViewError('VIEW_EMPTY', '请用 --members a,b 或 --add a 指定至少一个成员');
      }

      validateViewName(config, name);
      // 存在性判定与写入都在锁内完成（并发重复创建只会有一次成功）
      // D8：CLI 无登录态，创建的视图记到**默认管理员**名下；否则会变成"无主"视图
      createView(config, name, members, { createdBy: resolveDefaultCliTokenOwner() });

      if (opts.json) {
        const created = readViews(config)[name];
        printJson({ ok: true, view: name, id: created?.id, members, path: getViewsPath(config) });
        return;
      }
      console.log(`已创建视图 ${name}（${members.length} 个库）：${members.join(' / ')}`);
      console.log(`  现在可以用：ki search "<查询词>" --scope ${name}`);
    } catch (err) {
      fail(err);
    }
  });

// ─── rename ──────────────────────────────────────────────

program
  .command('rename')
  .description('给视图改名（ID 不变 → token 授权与页面选中态不受影响；旧名字的深链会失效）')
  .argument('<old>', '现视图名')
  .argument('<new>', '新视图名')
  .option('--json', '输出结构化 JSON', false)
  .action((oldName: string, newName: string, opts) => {
    try {
      const config = loadConfig();
      if (!readViews(config)[oldName]) {
        throw new ViewError('VIEW_NOT_FOUND', `视图「${oldName}」不存在；用 ki view list 查看全部视图`, oldName);
      }
      // N3 / R-05：改名的影响面必须在改**之前**说清楚（当前 token 侧仍按**名字**记录授权）
      const affected = listTokensGrantingView(oldName);

      renameView(config, oldName, newName, { updatedBy: resolveDefaultCliTokenOwner() });
      const after = readViews(config)[newName];

      if (opts.json) {
        printJson({
          ok: true,
          from: oldName,
          to: newName,
          id: after?.id,
          path: getViewsPath(config),
          affectedTokens: affected.map((r) => ({ id: r.id, label: r.label ?? null })),
        });
        return;
      }
      console.log(`已改名：${oldName} → ${newName}（ID ${after?.id ?? '?'} 不变）`);
      console.log(`  ⚠ 旧名字会失效：脚本 / 深链里的 --scope ${oldName} 需改成 --scope ${newName}`);
      if (affected.length > 0) {
        /*
         * 诚实暴露当前实现边界：`viewGrants` 里存的还是**名字**（存 ID 的方案随 B2 的
         * 页面授权一起落地），所以改名会让这些 Token 失去该视图。不静默，必须报出来。
         */
        console.log(`  ⚠ 该视图当前被 ${affected.length} 个 Token 按旧名字授权，改名后它们将看不到此视图：`);
        for (const token of affected) {
          console.log(`      - ${token.label ?? '(未命名)'}  ${token.id}`);
        }
        console.log(`    补救：ki mcp token update ${affected[0].id} --view ${newName}（逐个处理）`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ─── add ─────────────────────────────────────────────────

program
  .command('add')
  .description('给视图追加一个成员（已存在则提示无变更）')
  .argument('<name>', '视图名')
  .argument('<scope>', '要追加的知识库（scope）')
  .option('--json', '输出结构化 JSON', false)
  .action((name: string, scope: string, opts) => {
    try {
      const config = loadConfig();
      let changed = false;
      const next = updateView(config, name, (current) => {
        if (current.includes(scope)) return current; // 无变更：内容相同 → 不落盘
        changed = true;
        return [...current, scope];
      });

      if (opts.json) {
        printJson({ ok: true, view: name, members: next, changed });
        return;
      }
      if (!changed) {
        console.log(`视图 ${name} 已包含 ${scope}，无变更。`);
        return;
      }
      console.log(`已在视图 ${name} 中加入 ${scope}（现 ${(next ?? []).length} 个库）。`);
      console.log('  ⚠ 若该视图已被 Token 授权，缺少新成员授权的 Token 将看不到此视图。');
      console.log(`     核对：ki mcp token list --granting-view ${name}`);
    } catch (err) {
      fail(err);
    }
  });

// ─── remove ──────────────────────────────────────────────

program
  .command('remove')
  .description('从视图移除一个成员（移空会被拒绝）')
  .argument('<name>', '视图名')
  .argument('<scope>', '要移除的知识库（scope）')
  .option('--json', '输出结构化 JSON', false)
  .action((name: string, scope: string, opts) => {
    try {
      const config = loadConfig();
      let changed = false;
      const next = updateView(config, name, (current) => {
        if (!current.includes(scope)) return current;
        const filtered = current.filter((m) => m !== scope);
        if (filtered.length === 0) {
          throw new ViewError(
            'VIEW_EMPTY',
            `视图至少要保留一个成员；如需解散整个视图请执行：ki view delete ${name} --yes`,
            name,
          );
        }
        changed = true;
        return filtered;
      });

      if (opts.json) {
        printJson({ ok: true, view: name, members: next, changed });
        return;
      }
      if (!changed) {
        console.log(`视图 ${name} 不包含 ${scope}，无变更。`);
        return;
      }
      console.log(`已从视图 ${name} 移除 ${scope}（现 ${(next ?? []).length} 个库）。`);
    } catch (err) {
      fail(err);
    }
  });

// ─── delete ──────────────────────────────────────────────

program
  .command('delete')
  .description('删除视图定义（只解散组合，不删除任何知识库数据）')
  .argument('<name>', '视图名')
  .option('--yes', '确认执行（缺省则仅预览并拒绝）', false)
  .option('--json', '输出结构化 JSON', false)
  .action((name: string, opts) => {
    try {
      const config = loadConfig();
      const entry = readViews(config)[name];
      if (!entry) throw new ViewError('VIEW_NOT_FOUND', `视图「${name}」不存在`, name);

      if (!opts.yes) {
        console.log(`将要删除视图 ${name}（${entry.members.length} 个成员）：${entry.members.join(' / ')}`);
        console.log('  只删除这层组合关系，不会删除任何知识库及其文档。');
        console.log('  ⚠ 该视图可能已被 Token 授权；删除前可执行');
        console.log(`      ki mcp token list --granting-view ${name}`);
        console.log('    核对（删除后这些 Token 将失去该视图的访问）。');
        console.log(`  确认执行请加 --yes：ki view delete ${name} --yes`);
        process.exitCode = 1;
        return;
      }

      deleteView(config, name);

      if (opts.json) {
        printJson({ ok: true, view: name, deleted: true });
        return;
      }
      console.log(`已删除视图 ${name}（成员库数据未受影响）。`);
    } catch (err) {
      fail(err);
    }
  });

program.parse(process.argv);
