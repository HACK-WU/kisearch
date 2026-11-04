#!/usr/bin/env node
/**
 * view.ts —— `ki view` 视图管理（知识视图 = 多个 scope 的只读聚合）
 *
 * 用法:
 *   ki view list   [--json]
 *   ki view show   <name> [--json]
 *   ki view create <name> --members a,b   （或 --add a --add b）
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
  updateView,
  validateViewMembers,
  validateViewName,
  type ViewConfig,
} from './lib/scope-view.js';

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
        printJson({
          ok: true,
          path: getViewsPath(config),
          count: names.length,
          views: names.map((name) => ({
            view: name,
            members: views[name].members,
            missing: views[name].members.filter((m) => !memberHasKb(m)),
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
      createView(config, name, members);

      if (opts.json) {
        printJson({ ok: true, view: name, members, path: getViewsPath(config) });
        return;
      }
      console.log(`已创建视图 ${name}（${members.length} 个库）：${members.join(' / ')}`);
      console.log(`  现在可以用：ki search "<查询词>" --scope ${name}`);
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
