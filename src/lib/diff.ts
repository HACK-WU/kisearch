/**
 * diff.ts —— S-05：增量 diff
 *
 * 对比 group-index.source.commit 与 HEAD，输出变更文件列表：
 *   - added / modified / deleted 三类
 *   - deleted + modified 条目尝试从 relations-cache 关联 memoryId
 *   - source 块不存在 → 返回 status='first_import' 提示，不报错
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { getSource, getRelationsCachePath } from './scope.js';

export interface DiffEntry {
  /** 相对 source.dir 的 posix 路径 */
  path: string;
  /** 绝对路径（added/modified） */
  absPath?: string;
  /** 已导入条目的 memoryId（deleted/modified，兼容单值场景） */
  memoryId?: string;
  /** 已导入条目的全部 chunk memoryId（文件级聚合，H-17/D-2 方案②） */
  memoryIds?: string[];
}

export interface DiffChangeGroup {
  added: DiffEntry[];
  modified: DiffEntry[];
  deleted: DiffEntry[];
}

export interface DiffResult extends DiffChangeGroup {
  ok: true;
  action: 'diff';
  scope: string;
  baseCommit: string;
  headCommit: string;
  sourceDir: string;
  rootName: string;
  stats: { added: number; modified: number; deleted: number; total: number };
}

export interface NoSourceResult {
  ok: true;
  action: 'diff';
  status: 'first_import';
  scope: string;
  hint: string;
}

export type DiffOutput = DiffResult | NoSourceResult;

interface GitInfo {
  repoRoot: string;
  head: string;
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function getGitInfo(sourceDir: string): GitInfo | null {
  try {
    const repoRoot = execFileSync('git', ['-C', sourceDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const head = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { repoRoot, head };
  } catch {
    return null;
  }
}

/**
 * 从 relations-cache.json 构造 文件级 path → memoryId[] 多值映射（D-2 方案②）
 *
 * relations-cache 的 hot_relation.sourcePath 为 chunk 粒度（`foo.md#1`、`foo.md#2`），
 * 按 `#` 前缀聚合到文件级 key（`foo.md`），得到该文件的全部 chunk memoryId：
 *   Map{ "docs/foo.md" → ["m1", "m2", "m3"] }
 *
 * 兼容旧数据：sourcePath 为文件级（无 `#`）时，key 即 sourcePath 本身。
 * 兼容未扩展：relations-cache 无 memoryId 时返回空 Map（调用方自行处理空值）。
 */
export function buildMemoryIdMap(scope: string): Map<string, string[]> {
  const cachePath = getRelationsCachePath(scope);
  const map = new Map<string, string[]>();
  if (!fs.existsSync(cachePath)) return map;

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
      groups?: Record<string, { hot_relations?: Array<{ text?: string; memoryId?: string; sourcePath?: string }> }>;
    };
    for (const group of Object.values(cache.groups || {})) {
      for (const rel of group.hot_relations || []) {
        const sp = rel.sourcePath;
        if (!sp || !rel.memoryId) continue;
        // 按 `#` 前缀聚合到文件级 key；无 `#`（旧数据）key 即 sp
        const hashIdx = sp.indexOf('#');
        const fileKey = hashIdx >= 0 ? sp.slice(0, hashIdx) : sp;
        const list = map.get(fileKey);
        if (list) {
          if (!list.includes(rel.memoryId)) list.push(rel.memoryId);
        } else {
          map.set(fileKey, [rel.memoryId]);
        }
      }
    }
  } catch {
    // 损坏的 cache 不抛出，返回当前累计映射
  }
  return map;
}

/**
 * 解析 `git diff -z --name-status base..head -- pathspec` 的 stdout
 * `-z` 模式下字段以 NUL(\0) 分隔，格式：status\0path[\0path2]\0
 * 状态字符：A=added, M=modified, D=deleted, R=renamed, C=copied, T=type changed
 * 重命名（R）拆解为 deleted(旧) + added(新)
 */
export function parseGitDiff(stdout: string): { status: 'A' | 'M' | 'D'; path: string }[] {
  const out: { status: 'A' | 'M' | 'D'; path: string }[] = [];
  if (!stdout) return out;

  // -z 模式：NUL 分隔，status 后跟 NUL 再跟路径
  const tokens = stdout.split('\0').map(t => t.trim()).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const statusRaw = tokens[i];
    if (!statusRaw) { i++; continue; }
    const ch = statusRaw.charAt(0);

    if (ch === 'R' || ch === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath && newPath) {
        if (ch === 'R') out.push({ status: 'D', path: oldPath });
        out.push({ status: 'A', path: newPath });
      }
      i += 3;
      continue;
    }

    if (ch === 'U') { i += 2; continue; } // unmerged 忽略

    const filePath = tokens[i + 1];
    if (filePath) {
      const status: 'A' | 'M' | 'D' =
        ch === 'A' ? 'A' : ch === 'D' ? 'D' : 'M'; // T/MM 等归 M
      out.push({ status, path: filePath });
    }
    i += 2;
  }
  return out;
}

interface HandleDiffArgs {
  scope: string;
  outputFile?: string;
}

/**
 * diff 子命令入口
 * @returns DiffOutput（首次导入返回 NoSourceResult）
 */
export function handleDiff(args: HandleDiffArgs): DiffOutput {
  const { scope } = args;

  const source = getSource(scope);
  if (!source) {
    return {
      ok: true,
      action: 'diff',
      status: 'first_import',
      scope,
      hint: `scope "${scope}" 尚未首次导入。请先执行 scan-kb import 完成全量导入后再 diff。`,
    };
  }

  if (!fs.existsSync(source.dir) || !fs.statSync(source.dir).isDirectory()) {
    throw new Error(`source.dir 不存在或不是目录：${source.dir}`);
  }

  // realpath 规范化：macOS os.tmpdir() 的 /var 软链到 /private/var，git rev-parse
  // 返回 realpath；source.dir 若未规范化，path.relative 会计算出越界 pathspec（../../…）
  let sourceDirReal: string;
  try {
    sourceDirReal = fs.realpathSync(source.dir);
  } catch {
    sourceDirReal = source.dir;
  }

  const gitInfo = getGitInfo(sourceDirReal);
  if (!gitInfo) {
    throw new Error(
      `source 目录不在 git 仓库中（${source.dir}）。增量更新依赖 git，请先 git init 或改用 --mode full 全量导入`
    );
  }

  const relativeSource = toPosix(path.relative(gitInfo.repoRoot, sourceDirReal)) || '.';
  let rawDiff: string;
  try {
    rawDiff = execFileSync(
      'git',
      [
        '-C',
        gitInfo.repoRoot,
        'diff',
        '-z',                    // NUL 分隔，避免非 ASCII 文件名被 C 风格转义
        '--name-status',
        `${source.commit}..${gitInfo.head}`,
        '--',
        relativeSource,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch (err) {
    throw new Error(
      `git diff 失败：base=${source.commit} head=${gitInfo.head} pathspec=${relativeSource}\n${(err as Error).message}`
    );
  }

  const memMap = buildMemoryIdMap(scope);
  const parsed = parseGitDiff(rawDiff);

  // 把 repo 内路径转为相对 source.dir 的 posix；越界则跳过
  const toSourceRel = (repoRelPath: string): string | null => {
    const abs = path.resolve(gitInfo.repoRoot, repoRelPath);
    const rel = toPosix(path.relative(sourceDirReal, abs));
    if (rel.startsWith('..')) return null;
    return rel;
  };

  const added: DiffEntry[] = [];
  const modified: DiffEntry[] = [];
  const deleted: DiffEntry[] = [];

  for (const item of parsed) {
    const rel = toSourceRel(item.path);
    if (!rel) continue;
    if (!/\.md$/i.test(rel)) continue;

    if (item.status === 'A') {
      added.push({ path: rel, absPath: path.resolve(sourceDirReal, rel) });
    } else if (item.status === 'M') {
      const entry: DiffEntry = { path: rel, absPath: path.resolve(sourceDirReal, rel) };
      const ids = memMap.get(rel);
      if (ids && ids.length > 0) {
        entry.memoryIds = ids;
        entry.memoryId = ids[0]; // 兼容单值消费方（取第一个）
      }
      modified.push(entry);
    } else {
      const entry: DiffEntry = { path: rel };
      const ids = memMap.get(rel);
      if (ids && ids.length > 0) {
        entry.memoryIds = ids;
        entry.memoryId = ids[0];
      }
      deleted.push(entry);
    }
  }

  return {
    ok: true,
    action: 'diff',
    scope,
    baseCommit: source.commit,
    headCommit: gitInfo.head,
    sourceDir: source.dir,
    rootName: source.rootName,
    added,
    modified,
    deleted,
    stats: {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      total: added.length + modified.length + deleted.length,
    },
  };
}
