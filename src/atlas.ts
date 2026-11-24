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
import { scopeDirExists } from './lib/store.js';
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

/** 解析并校验目标库：存在 + 非只读（只读判定复用 config.isScopeReadonly） */
function requireWritableScope(raw?: string): string {
  // 只读一次配置：两次 loadConfig 之间配置可能被改写（另一进程），会导致
  // 「resolveScope 用的配置」与「只读判定用的配置」不是同一份。
  const config = loadConfig();
  const scope = resolveScope(config, raw);
  if (!scopeDirExists(scope)) {
    fail(`库 ${scope} 不存在（尚未初始化）。\n→ 先建库，或用 --scope 指定已存在的库；不要用未初始化的名字硬装。`, EXIT_SCOPE);
  }
  if (isScopeReadonly(config, scope)) {
    fail(`库 ${scope} 是只读库，不能写入图集。\n→ 换一个可写库；要解除只读需由管理员改配置。`, EXIT_SCOPE);
  }
  return scope;
}

// 小于 1 KB 用字节数，避免 meta.json（137 B）显示成「0 KB」
const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);

/** 人读摘要：装完给用户看什么（设计 S03 §3.3） */
function printInstallSummary(scope: string, meta: AtlasMeta, archived: boolean): void {
  const entries = meta.entries?.map((e) => `${e.name} ${kb(e.size)}`).join(' · ') ?? '-';
  console.log(`校验通过：${meta.entries?.length ?? 0} 个条目 · ${entries}`);
  console.log(`已安装到 ${scope}/.atlas/`);
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
  .option('--scope <scope>', '目标库')
  .option('--file <file>', '图集压缩包路径（pack_atlas.py 产出的 .zip）')
  .option('--title <title>', '标题（包内 meta.json 缺失时的兜底）')
  .option('--json', '输出 JSON（与 /api/atlas/status 同构）', false)
  .action((opts: { scope?: string; file?: string; title?: string; json?: boolean }) => {
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

    const scope = requireWritableScope(opts.scope);
    try {
      const { meta, archived } = installPackage(scope, fs.readFileSync(file), {
        uploadedBy: `cli:${(() => { try { return os.userInfo().username; } catch { return 'unknown'; } })()}`,
        ...(opts.title ? { meta: { title: opts.title } } : {}),
      });
      if (opts.json) jsonMeta(scope, meta, { archived });
      else printInstallSummary(scope, meta, archived);
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
  .option('--scope <scope>', '目标库')
  .option('--yes', '跳过确认', false)
  .action((opts: { scope?: string; yes?: boolean }) => {
    const scope = requireWritableScope(opts.scope);
    const st = readStatus(scope);
    if (!st.exists) {
      console.log(`${scope}：没有可卸载的图集`);
      process.exit(EXIT_OK);
    }
    if (!opts.yes) {
      fail(`将删除 ${scope} 的当前图集（archive/ 保留）。确认请加 --yes`, EXIT_INVALID);
    }
    const removed = removePackage(scope);
    console.log(removed ? `已卸载 ${scope} 的图集（archive/ 保留，可回滚）` : `${scope}：没有可卸载的图集`);
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
