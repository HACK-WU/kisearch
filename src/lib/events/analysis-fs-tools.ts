/**
 * analysis-fs-tools.ts —— AI 分析专属只读文件沙箱工具（REQ-20261113-003 · S-02）
 *
 * ═══ 三条硬约束 ═══
 * 1. **物理隔离**：本模块的工具仅暴露给 `analysis-runner.ts`，**严禁**登记进
 *    `CHAT_MCP_TOOLS`（`chat/mcp-tool-registry.ts`）或 `/mcp`（`mcp-server-factory.ts`）。
 * 2. **全链路异步 IO**：遍历与读文件一律使用 `fs.promises` 并定期让出事件循环，
 *    绝不用 `readdirSync`/`readFileSync` 扫描大仓卡死 Node 单线程 HTTP/MCP 服务。
 * 3. **realpath 沙箱**：拒绝绝对路径、`..`、`\0` 与根外符号链接（含指向根外的悬空链接），
 *    一律返回 `OUT_OF_ROOT` 且不回传越界路径是否存在或内容。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../chat/llm-client.js';

export const FS_READ_MAX_LINES = 200;
export const FS_READ_DEFAULT_LINES = 120;
export const FS_READ_MAX_BYTES = 64 * 1024;
/**
 * `fs_read` 允许读取的单文件上限（REQ-20261127-001）。
 *
 * 旧实现直接 `readFile` 整个文件再切行：对话侧面向普通用户后，一个 GB 级日志
 * 就能把进程内存打满（超时也救不了，因为读文件是异步但整块缓冲）。
 * 8MB 足够覆盖正常源码文件；更大的文件应改用 `fs_grep` 定位后按行读取。
 */
export const FS_READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const FS_GREP_MAX_HITS = 60;
export const FS_GREP_MAX_LINE_DISPLAY = 200;
export const FS_GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const FS_GREP_MAX_RAW_LINE_BYTES = 16 * 1024;
export const FS_FIND_MAX_RESULTS = 80;
export const FS_LS_MAX_ENTRIES = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;
const YIELD_EVERY_FILES = 80;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'vendor',
  '.venv',
  '__pycache__',
  'coverage',
  '.cache',
]);

const FORBIDDEN_SYSTEM_ROOTS = new Set(['/', '/proc', '/sys', '/dev']);

export interface FsSandboxContext {
  rawRoot: string;
  realRoot: string;
  /** 已读文件集合：去重计数用（2026-11-18 起不再作为上限闸门） */
  filesRead: Set<string>;
  signal?: AbortSignal;
  /**
   * 可选：敏感路径拒绝谓词（REQ-20261127-001）。
   * 传 relPath（相对根、POSIX），返回 true = 拒绝读取 / 跳过命中 / 不列出。
   * 分析侧不传（行为不变）；对话侧传敏感文件名单。
   */
  denyPath?: (relPath: string) => boolean;
  /**
   * 可选：单文件读取上限（字节）。不传 = 不限制（分析侧保持原行为）；
   * 对话侧传 `FS_READ_MAX_FILE_BYTES`，避免普通用户让模型整读 GB 级文件。
   */
  maxFileBytes?: number;
}

export type FsToolErrorCode =
  | 'OUT_OF_ROOT'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIR'
  | 'INVALID_ARG'
  | 'FORBIDDEN_PATH'
  | 'ABORTED';

export type FsToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: FsToolErrorCode; error: string };

export interface AnalysisToolEntry {
  readonly name: string;
  readonly def: ToolDef;
  run(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  describe(args: Record<string, unknown>): { label: string; summary: string };
}

function isInside(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosixRel(realRoot: string, realTarget: string): string {
  const rel = path.relative(realRoot, realTarget);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/** 启动分析前校验配置的目标目录 */
export function validateTargetRootDir(
  rawDir: string,
): { ok: true; realRoot: string } | { ok: false; code: 'ANALYSIS_TARGET_UNREADABLE'; error: string } {
  const trimmed = rawDir.trim();
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    return { ok: false, code: 'ANALYSIS_TARGET_UNREADABLE', error: `目标目录必须是合法绝对路径：${rawDir}` };
  }
  const resolved = path.resolve(trimmed);
  if (
    FORBIDDEN_SYSTEM_ROOTS.has(resolved)
    || resolved.startsWith('/proc/')
    || resolved.startsWith('/sys/')
    || resolved.startsWith('/dev/')
  ) {
    return { ok: false, code: 'ANALYSIS_TARGET_UNREADABLE', error: `不允许分析系统目录：${resolved}` };
  }
  try {
    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      const real = fs.realpathSync(resolved);
      if (FORBIDDEN_SYSTEM_ROOTS.has(real) || real.startsWith('/proc/') || real.startsWith('/sys/') || real.startsWith('/dev/')) {
        return { ok: false, code: 'ANALYSIS_TARGET_UNREADABLE', error: `目标目录指向系统受限路径：${real}` };
      }
    }
    const realRoot = fs.realpathSync(resolved);
    const stat = fs.statSync(realRoot);
    if (!stat.isDirectory()) {
      return { ok: false, code: 'ANALYSIS_TARGET_UNREADABLE', error: `目标路径不是目录：${rawDir}` };
    }
    fs.accessSync(realRoot, fs.constants.R_OK);
    return { ok: true, realRoot };
  } catch (err) {
    return { ok: false, code: 'ANALYSIS_TARGET_UNREADABLE', error: `目标目录不可读（${rawDir}）：${(err as Error).message}` };
  }
}

/**
 * 沙箱路径解析：
 * · 拒绝绝对路径、反斜杠、`..`、`\0`；
 * · 对路径或最近存在的祖先目录做 `realpath`，确保哪怕中间目录是根外 symlink（包括指向不存在文件）也报 `OUT_OF_ROOT`。
 */
export async function resolveSafePath(
  realRoot: string,
  relInput: string,
): Promise<
  | { ok: true; realPath: string; relPath: string }
  | { ok: false; code: 'OUT_OF_ROOT' | 'NOT_FOUND'; error: string }
> {
  if (typeof relInput !== 'string') {
    return { ok: false, code: 'OUT_OF_ROOT', error: '路径参数非法' };
  }
  const raw = relInput.trim();
  if (raw.includes('\0')) {
    return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
  }
  if (raw === '' || raw === '.') {
    return { ok: true, realPath: realRoot, relPath: '.' };
  }
  if (path.isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
  }

  const candidate = path.resolve(realRoot, ...segments);
  if (!isInside(realRoot, candidate)) {
    return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
  }

  try {
    const resolved = await fs.promises.realpath(candidate);
    if (!isInside(realRoot, resolved)) {
      return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
    }
    return { ok: true, realPath: resolved, relPath: toPosixRel(realRoot, resolved) };
  } catch (err) {
    // 若 candidate 本身不存在或为指向根外的悬空链接：检查最近存在的祖先是否越界
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // 检查是否由指向根外的 symlink 引起
      let cur = candidate;
      while (cur !== realRoot && cur.length > realRoot.length) {
        try {
          const lstat = await fs.promises.lstat(cur);
          if (lstat.isSymbolicLink()) {
            const linkTarget = await fs.promises.readlink(cur);
            const absTarget = path.resolve(path.dirname(cur), linkTarget);
            if (!isInside(realRoot, absTarget)) {
              return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
            }
          }
          const parentReal = await fs.promises.realpath(cur);
          if (!isInside(realRoot, parentReal)) {
            return { ok: false, code: 'OUT_OF_ROOT', error: '路径越出允许目录范围' };
          }
          break;
        } catch {
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
      return { ok: false, code: 'NOT_FOUND', error: `路径不存在：${raw}` };
    }
    return { ok: false, code: 'NOT_FOUND', error: `无法访问路径：${raw}` };
  }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

function globToRegex(glob: string): RegExp {
  const normalized = glob.trim().replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

function compileSearchMatcher(pattern: string): { match: (line: string) => boolean; mode: 'regex' | 'literal' } {
  const trimmed = pattern.slice(0, 200);
  // 简单 ReDoS 防护：存在嵌套量词（如 (a+)+ / (.*)* ）时降级为字面匹配
  const redosSuspect = /\([^)]*[+*][^)]*\)[+*{]/.test(trimmed);
  if (!redosSuspect) {
    try {
      const re = new RegExp(trimmed, 'i');
      return { match: (line: string) => re.test(line), mode: 'regex' };
    } catch {
      // 非法正则自动退回字面匹配
    }
  }
  const lower = trimmed.toLowerCase();
  return { match: (line: string) => line.toLowerCase().includes(lower), mode: 'literal' };
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ABORTED');
}

export async function runFsLs(ctx: FsSandboxContext, rawPath = '.'): Promise<FsToolResult> {
  if (ctx.signal?.aborted) return { ok: false, code: 'ABORTED', error: '分析已中止' };
  const resolved = await resolveSafePath(ctx.realRoot, rawPath);
  if (!resolved.ok) return resolved;

  try {
    const stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isDirectory()) return { ok: false, code: 'NOT_A_DIR', error: `不是目录：${resolved.relPath}` };
    const dirents = await fs.promises.readdir(resolved.realPath, { withFileTypes: true });
    const baseRel = resolved.relPath === '.' ? '' : `${resolved.relPath}/`;
    const filtered = dirents
      .filter((d) => !IGNORED_DIRS.has(d.name) && !ctx.denyPath?.(`${baseRel}${d.name}`))
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const truncated = filtered.length > FS_LS_MAX_ENTRIES;
    return {
      ok: true,
      data: {
        path: resolved.relPath,
        total: filtered.length,
        truncated,
        entries: filtered.slice(0, FS_LS_MAX_ENTRIES),
      },
    };
  } catch (err) {
    return { ok: false, code: 'NOT_FOUND', error: `读取目录失败：${(err as Error).message}` };
  }
}

export async function runFsFind(
  ctx: FsSandboxContext,
  namePattern: string,
  rawPath = '.',
): Promise<FsToolResult> {
  if (ctx.signal?.aborted) return { ok: false, code: 'ABORTED', error: '分析已中止' };
  const needle = typeof namePattern === 'string' ? namePattern.trim() : '';
  if (!needle) return { ok: false, code: 'INVALID_ARG', error: 'name 不能为空' };

  const resolved = await resolveSafePath(ctx.realRoot, rawPath);
  if (!resolved.ok) return resolved;

  try {
    const stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isDirectory()) return { ok: false, code: 'NOT_A_DIR', error: `不是目录：${resolved.relPath}` };
  } catch {
    return { ok: false, code: 'NOT_FOUND', error: `目录不存在：${resolved.relPath}` };
  }

  const hasGlobChars = /[*?]/.test(needle);
  const matcher = hasGlobChars
    ? globToRegex(needle.includes('/') ? needle : `**/${needle}`)
    : null;
  const lowerNeedle = needle.toLowerCase();

  const matches: string[] = [];
  let truncated = false;
  let visited = 0;
  const queue: string[] = [resolved.realPath];

  try {
    while (queue.length > 0) {
      checkAborted(ctx.signal);
      const dir = queue.shift()!;
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (d.isSymbolicLink() || IGNORED_DIRS.has(d.name)) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          queue.push(full);
        } else if (d.isFile()) {
          visited++;
          if (visited % YIELD_EVERY_FILES === 0) await yieldEventLoop();
          const rel = toPosixRel(ctx.realRoot, full);
          if (ctx.denyPath?.(rel)) continue;
          const hit = matcher ? matcher.test(rel) : rel.toLowerCase().includes(lowerNeedle);
          if (hit) {
            if (matches.length >= FS_FIND_MAX_RESULTS) {
              truncated = true;
              break;
            }
            matches.push(rel);
          }
        }
      }
      if (truncated) break;
    }
  } catch (err) {
    if ((err as Error).message === 'ABORTED') return { ok: false, code: 'ABORTED', error: '分析已中止' };
    return { ok: false, code: 'NOT_FOUND', error: `查找失败：${(err as Error).message}` };
  }

  return {
    ok: true,
    data: {
      pattern: needle,
      path: resolved.relPath,
      count: matches.length,
      truncated,
      paths: matches,
    },
  };
}

export async function runFsGrep(
  ctx: FsSandboxContext,
  pattern: string,
  opts?: { path?: string; glob?: string },
): Promise<FsToolResult> {
  if (ctx.signal?.aborted) return { ok: false, code: 'ABORTED', error: '分析已中止' };
  const needle = typeof pattern === 'string' ? pattern.trim() : '';
  if (!needle) return { ok: false, code: 'INVALID_ARG', error: 'pattern 不能为空' };

  const resolved = await resolveSafePath(ctx.realRoot, opts?.path ?? '.');
  if (!resolved.ok) return resolved;

  const { match, mode } = compileSearchMatcher(needle);
  const globRe = opts?.glob?.trim()
    ? globToRegex(opts.glob.includes('/') ? opts.glob.trim() : `**/${opts.glob.trim()}`)
    : null;

  const hits: Array<{ file: string; line: number; text: string }> = [];
  let truncated = false;
  let skippedBinary = 0;
  let scannedFiles = 0;

  const scanOneFile = async (realFile: string): Promise<void> => {
    const rel = toPosixRel(ctx.realRoot, realFile);
    if (ctx.denyPath?.(rel)) return;
    if (globRe && !globRe.test(rel)) return;
    const st = await fs.promises.stat(realFile);
    if (!st.isFile() || st.size > FS_GREP_MAX_FILE_BYTES) return;
    scannedFiles++;
    if (scannedFiles % YIELD_EVERY_FILES === 0) await yieldEventLoop();
    if (await isBinaryFile(realFile)) {
      skippedBinary++;
      return;
    }
    const content = await fs.promises.readFile(realFile, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      if (lineText.length > FS_GREP_MAX_RAW_LINE_BYTES) continue;
      if (match(lineText)) {
        if (hits.length >= FS_GREP_MAX_HITS) {
          truncated = true;
          return;
        }
        const trimmed = lineText.trim();
        hits.push({
          file: rel,
          line: i + 1,
          text: trimmed.length > FS_GREP_MAX_LINE_DISPLAY
            ? `${trimmed.slice(0, FS_GREP_MAX_LINE_DISPLAY)}…`
            : trimmed,
        });
      }
    }
  };

  try {
    const targetStat = await fs.promises.stat(resolved.realPath);
    if (targetStat.isFile()) {
      await scanOneFile(resolved.realPath);
    } else if (targetStat.isDirectory()) {
      const queue: string[] = [resolved.realPath];
      while (queue.length > 0 && !truncated) {
        checkAborted(ctx.signal);
        const dir = queue.shift()!;
        const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirents) {
          if (d.isSymbolicLink() || IGNORED_DIRS.has(d.name)) continue;
          const full = path.join(dir, d.name);
          if (d.isDirectory()) {
            queue.push(full);
          } else if (d.isFile()) {
            await scanOneFile(full);
            if (truncated) break;
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).message === 'ABORTED') return { ok: false, code: 'ABORTED', error: '分析已中止' };
    return { ok: false, code: 'NOT_FOUND', error: `检索失败：${(err as Error).message}` };
  }

  return {
    ok: true,
    data: {
      pattern: needle,
      matchMode: mode,
      count: hits.length,
      truncated,
      skippedBinary,
      scannedFiles,
      ...(truncated ? { hint: '命中结果过多已截断（上限 60 条），建议细化关键词或指定 path/glob' } : {}),
      hits,
    },
  };
}

export async function runFsRead(
  ctx: FsSandboxContext,
  rawPath: string,
  opts?: { offset?: number; limit?: number },
): Promise<FsToolResult> {
  if (ctx.signal?.aborted) return { ok: false, code: 'ABORTED', error: '分析已中止' };
  const relArg = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!relArg) return { ok: false, code: 'INVALID_ARG', error: 'path 不能为空' };

  const resolved = await resolveSafePath(ctx.realRoot, relArg);
  if (!resolved.ok) return resolved;
  if (ctx.denyPath?.(resolved.relPath)) {
    return { ok: false, code: 'FORBIDDEN_PATH', error: '该路径被安全策略禁止读取' };
  }

  try {
    const stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE', error: `不是文件：${resolved.relPath}` };
    if (ctx.maxFileBytes !== undefined && stat.size > ctx.maxFileBytes) {
      return {
        ok: false,
        code: 'INVALID_ARG',
        error: `文件过大（${stat.size} 字节，上限 ${ctx.maxFileBytes}）：请用 fs_grep 定位片段后按行读取`,
      };
    }
    // 2026-11-18：文件数上限取消，不再因读得多而拒绝（总超时也取消，能终止的只有用户「停止」与单轮请求超时）
    if (await isBinaryFile(resolved.realPath)) {
      return { ok: false, code: 'INVALID_ARG', error: `目标为二进制文件，跳过读取：${resolved.relPath}` };
    }

    ctx.filesRead.add(resolved.relPath);
    const text = await fs.promises.readFile(resolved.realPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const totalLines = lines.length;
    const offset = Math.max(1, Math.floor(opts?.offset ?? 1));
    const limit = Math.min(FS_READ_MAX_LINES, Math.max(1, Math.floor(opts?.limit ?? FS_READ_DEFAULT_LINES)));
    if (offset > totalLines) {
      return {
        ok: true,
        data: {
          path: resolved.relPath,
          startLine: offset,
          endLine: offset - 1,
          totalLines,
          truncated: false,
          content: '',
        },
      };
    }

    const selected: string[] = [];
    let byteCount = 0;
    let truncatedByBytes = false;
    const maxEnd = Math.min(totalLines, offset + limit - 1);
    for (let lineNo = offset; lineNo <= maxEnd; lineNo++) {
      const lineStr = `${lineNo}|${lines[lineNo - 1] ?? ''}`;
      const addBytes = Buffer.byteLength(lineStr, 'utf8') + (selected.length > 0 ? 1 : 0);
      if (byteCount + addBytes > FS_READ_MAX_BYTES) {
        if (selected.length === 0) {
          // 单行超 64KB：截断该行保底返回
          selected.push(`${lineNo}|${Buffer.from(lines[lineNo - 1] ?? '', 'utf8').subarray(0, FS_READ_MAX_BYTES - 32).toString('utf8')}…[truncated]`);
        }
        truncatedByBytes = true;
        break;
      }
      selected.push(lineStr);
      byteCount += addBytes;
    }

    const endLine = offset + selected.length - 1;
    const truncated = truncatedByBytes || endLine < totalLines;
    return {
      ok: true,
      data: {
        path: resolved.relPath,
        startLine: offset,
        endLine,
        totalLines,
        truncated,
        content: selected.join('\n'),
      },
    };
  } catch (err) {
    return { ok: false, code: 'NOT_FOUND', error: `读取文件失败：${(err as Error).message}` };
  }
}

/**
 * 汇总后二次校验候选代码位置（REQ-20261113-003 · S-04 防幻觉）：
 * 确认文件真实落在 `realRoot` 内、非二进制且 `line` 未超出总行数。
 */
export async function verifyCandidateLocation(
  realRoot: string,
  rawFile: string,
  line: number,
  endLine?: number,
): Promise<
  | { ok: true; file: string; line: number; endLine?: number; realSnippet: string }
  | { ok: false; reason: string }
> {
  const resolved = await resolveSafePath(realRoot, rawFile);
  if (!resolved.ok) return { ok: false, reason: `${rawFile}（路径越界或不存在）` };
  try {
    const stat = await fs.promises.stat(resolved.realPath);
    if (!stat.isFile()) return { ok: false, reason: `${resolved.relPath}（不是文件）` };
    if (await isBinaryFile(resolved.realPath)) return { ok: false, reason: `${resolved.relPath}（二进制文件）` };
    const text = await fs.promises.readFile(resolved.realPath, 'utf8');
    const lines = text.split(/\r?\n/);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      return { ok: false, reason: `${resolved.relPath}:${line}（行号越界，文件共 ${lines.length} 行）` };
    }
    const clampedEnd = endLine !== undefined && Number.isInteger(endLine) && endLine >= line
      ? Math.min(endLine, lines.length, line + 12)
      : undefined;
    const from = Math.max(1, line - 1);
    const to = Math.min(lines.length, clampedEnd ?? line + 2);
    const snippet = lines.slice(from - 1, to).join('\n').slice(0, 500);
    return {
      ok: true,
      file: resolved.relPath,
      line,
      ...(clampedEnd !== undefined && clampedEnd > line ? { endLine: clampedEnd } : {}),
      realSnippet: snippet,
    };
  } catch {
    return { ok: false, reason: `${rawFile}（不可读）` };
  }
}

/** 构造仅供 `analysis-runner` 使用的 4 个专属只读文件工具 */
export function createFsToolEntries(ctx: FsSandboxContext): readonly AnalysisToolEntry[] {
  return [
    {
      name: 'fs_read',
      def: {
        type: 'function',
        function: {
          name: 'fs_read',
          description: `读取目标代码目录中指定文件的带行号文本片段（只读；单次最多 ${FS_READ_MAX_LINES} 行 / 64 KB）。用于精读上下文确认因果与真实行号。`,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对目标根目录的文件路径，如 "src/auth/guard.ts"' },
              offset: { type: 'integer', minimum: 1, description: '起始行号（1-based），默认 1' },
              limit: { type: 'integer', minimum: 1, maximum: FS_READ_MAX_LINES, description: `读取行数，默认 ${FS_READ_DEFAULT_LINES}，上限 ${FS_READ_MAX_LINES}` },
            },
            required: ['path'],
          },
        },
      },
      describe: (args) => ({
        label: '读取文件',
        summary: `${String(args.path ?? '')}${args.offset ? `:${args.offset}` : ''}`,
      }),
      run: async (args) => {
        const r = await runFsRead(ctx, String(args.path ?? ''), {
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        return r.ok ? r.data : { error: r.error, code: r.code };
      },
    },
    {
      name: 'fs_grep',
      def: {
        type: 'function',
        function: {
          name: 'fs_grep',
          description: `在目标代码目录中按正则或字面关键词检索源码行（只读；跳过二进制与依赖目录；最多返回 ${FS_GREP_MAX_HITS} 条 file:line）。`,
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '检索正则或关键词（如报错文本、函数名、错误码）' },
              path: { type: 'string', description: '限定子目录或单文件（相对路径），默认整个目标目录' },
              glob: { type: 'string', description: '文件名 glob 过滤（如 "*.ts"、"src/**/*.tsx"）' },
            },
            required: ['pattern'],
          },
        },
      },
      describe: (args) => ({
        label: '检索源码',
        summary: String(args.pattern ?? '').slice(0, 60),
      }),
      run: async (args) => {
        const r = await runFsGrep(ctx, String(args.pattern ?? ''), {
          ...(typeof args.path === 'string' ? { path: args.path } : {}),
          ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
        });
        return r.ok ? r.data : { error: r.error, code: r.code };
      },
    },
    {
      name: 'fs_find',
      def: {
        type: 'function',
        function: {
          name: 'fs_find',
          description: `按文件名或路径模式在目标代码目录查找文件（只读；跳过 .git/node_modules；最多返回 ${FS_FIND_MAX_RESULTS} 条路径）。`,
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '文件名子串或 glob（如 "guard.ts"、"*.tsx"）' },
              path: { type: 'string', description: '限定起始子目录（相对路径），默认 "."' },
            },
            required: ['name'],
          },
        },
      },
      describe: (args) => ({
        label: '查找文件',
        summary: String(args.name ?? '').slice(0, 60),
      }),
      run: async (args) => {
        const r = await runFsFind(ctx, String(args.name ?? ''), typeof args.path === 'string' ? args.path : '.');
        return r.ok ? r.data : { error: r.error, code: r.code };
      },
    },
    {
      name: 'fs_ls',
      def: {
        type: 'function',
        function: {
          name: 'fs_ls',
          description: `列出目标代码目录下一层子目录与文件（只读；最多返回 ${FS_LS_MAX_ENTRIES} 项）。`,
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对子目录路径，默认 "."' },
            },
          },
        },
      },
      describe: (args) => ({
        label: '浏览目录',
        summary: String(args.path ?? '.'),
      }),
      run: async (args) => {
        const r = await runFsLs(ctx, typeof args.path === 'string' ? args.path : '.');
        return r.ok ? r.data : { error: r.error, code: r.code };
      },
    },
  ];
}
