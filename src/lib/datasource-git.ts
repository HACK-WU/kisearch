/**
 * Git 适配层（REQ-20261021-003 S-01/S-02）。
 *
 * 本文件在 S-01 只提供**探测**与远端 URL 脱敏；S-02 再扩展
 * fetch / 自动更新 / diff / untracked 统计。
 *
 * 约束：
 *  - 一律 `execFile('git', args)`，不拼 shell；参数数组 + 超时 + 禁交互
 *  - `dir` 与 `repoRoot` 都先 realpath，再计算 relativeRoot（symlink 数据源）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;

export interface GitProbe {
  repoRoot: string;
  relativeRoot: string;
  branch: string | null;
  remoteUrl: string | null;
  headCommit: string | null;
}

export type GitProbeResult =
  | { ok: true; value: GitProbe }
  | { ok: false; code: 'GIT_UNAVAILABLE' | 'NOT_A_GIT_REPO' | 'GIT_SUBDIR_INVALID'; error: string };

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    SSH_ASKPASS: '/bin/true',
  };
}

interface GitExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

function execGit(args: string[], cwd?: string, options: GitExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      env: gitEnv(),
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: typeof stderr === 'string' ? stderr : '' }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

type GitRun =
  | { ok: true; stdout: string }
  | { ok: false; code: 'GIT_UNAVAILABLE' | 'GIT_FAILED'; error: string };

async function runGit(args: string[], cwd?: string, options: GitExecOptions = {}): Promise<GitRun> {
  try {
    const { stdout } = await execGit(args, cwd, options);
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') return { ok: false, code: 'GIT_UNAVAILABLE', error: '未找到 git 可执行文件' };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    return { ok: false, code: 'GIT_FAILED', error: stderr || e.message };
  }
}

/** 探测目录所属仓库、相对前缀、分支、远端与 HEAD；不做任何写操作。 */
export async function probeGit(dirInput: string): Promise<GitProbeResult> {
  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(path.resolve(dirInput));
  } catch {
    return { ok: false, code: 'NOT_A_GIT_REPO', error: `目录不存在或不可访问：${dirInput}` };
  }

  const top = await runGit(['-C', canonicalDir, 'rev-parse', '--show-toplevel']);
  if (!top.ok) {
    if (top.code === 'GIT_UNAVAILABLE') return { ok: false, code: 'GIT_UNAVAILABLE', error: top.error };
    return { ok: false, code: 'NOT_A_GIT_REPO', error: `不是 Git 仓库：${dirInput}（${top.error}）` };
  }

  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = fs.realpathSync(path.resolve(top.stdout.trim()));
  } catch {
    return { ok: false, code: 'NOT_A_GIT_REPO', error: `仓库根不可访问：${top.stdout.trim()}` };
  }

  const rel = path.relative(canonicalRepoRoot, canonicalDir).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'GIT_SUBDIR_INVALID', error: `数据源目录不在仓库内：${dirInput}` };
  }

  const branchRes = await runGit(['-C', canonicalRepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branchName = branchRes.ok ? branchRes.stdout.trim() : '';
  const headRes = await runGit(['-C', canonicalRepoRoot, 'rev-parse', 'HEAD']);

  return {
    ok: true,
    value: {
      repoRoot: canonicalRepoRoot,
      relativeRoot: rel === '.' ? '' : rel,
      branch: branchName && branchName !== 'HEAD' ? branchName : null,
      remoteUrl: await readRemoteUrl(canonicalRepoRoot),
      headCommit: headRes.ok ? (headRes.stdout.trim() || null) : null,
    },
  };
}

async function readRemoteUrl(repoRoot: string): Promise<string | null> {
  const origin = await runGit(['-C', repoRoot, 'remote', 'get-url', 'origin']);
  if (origin.ok) return sanitizeRemoteUrl(origin.stdout.trim());

  const names = await runGit(['-C', repoRoot, 'remote']);
  if (!names.ok) return null;
  const first = names.stdout.split('\n').map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const raw = await runGit(['-C', repoRoot, 'remote', 'get-url', first]);
  return raw.ok ? sanitizeRemoteUrl(raw.stdout.trim()) : null;
}

/**
 * 去掉远端 URL 中的凭据。返回 null 表示空。
 *  - http(s)/ssh：URL 解析后清空 username/password
 *  - scp-like `user[@host]:path`：保留 user@host，去掉 `user:pass@` 的 password
 */
export function sanitizeRemoteUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!value.includes('://')) {
    const at = value.indexOf('@');
    if (at > 0) {
      const userPart = value.slice(0, at);
      const rest = value.slice(at + 1);
      if (userPart.includes(':')) return `${userPart.split(':')[0]}@${rest}`;
    }
    return value;
  }
  try {
    const url = new URL(value);
    // ssh 的 user 是地址的一部分（通常必须是 git），只去 password；http(s) 去全部凭据
    if (url.protocol.toLowerCase() === 'ssh:' || url.protocol.toLowerCase() === 'git+ssh:') {
      url.password = '';
    } else {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1');
  }
}

// ─── S-02：同步前置与变更集 ─────────────────────────────

export type GitFetchState = 'ok' | 'failed' | 'skipped';
export type GitUpdateState = 'updated' | 'up-to-date' | 'skipped' | 'failed';
export type GitCleanState = 'ok' | 'failed' | 'skipped';

export interface GitUpdateResult {
  fetch: GitFetchState;
  fetchDetail?: string;
  update: GitUpdateState;
  updateDetail?: string;
  /** 仅托管 clone 执行 git clean -fdx；本地仓库恒为 skipped */
  clean: GitCleanState;
  cleanDetail?: string;
  branch: string | null;
  headCommit: string | null;
  headSubject: string | null;
  headAuthorTime: number | null;
}

export interface GitChangeSet {
  /** 相对数据源目录的 tracked 变更（A/M/T/C/U）；不含 D */
  changedRels: string[];
  /** 未跟踪且可导入的文件数（不进入 changedRels） */
  untrackedMarkdown: number;
  /** untracked 统计失败时的原因（成功时缺省） */
  untrackedError?: string;
  deletedCount: number;
  headCommit: string | null;
  /** lastCommit 不可解析（force push/rebase/shallow）→ 调用方走全量 */
  commitUnknown: boolean;
}

const FETCH_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 30_000;
const DIFF_TIMEOUT_MS = 60_000;
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

async function readHead(repoRoot: string): Promise<string | null> {
  const result = await runGit(['-C', repoRoot, 'rev-parse', 'HEAD']);
  return result.ok ? (result.stdout.trim() || null) : null;
}

async function readBranch(repoRoot: string): Promise<string | null> {
  const result = await runGit(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const value = result.ok ? result.stdout.trim() : '';
  return value && value !== 'HEAD' ? value : null;
}

async function readHeadMeta(repoRoot: string): Promise<{
  headCommit: string | null;
  headSubject: string | null;
  headAuthorTime: number | null;
  branch: string | null;
}> {
  const headCommit = await readHead(repoRoot);
  if (!headCommit) return { headCommit: null, headSubject: null, headAuthorTime: null, branch: await readBranch(repoRoot) };
  const subject = await runGit(['-C', repoRoot, 'log', '-1', '--format=%s']);
  const authorTime = await runGit(['-C', repoRoot, 'log', '-1', '--format=%ct']);
  const seconds = authorTime.ok ? Number.parseInt(authorTime.stdout.trim(), 10) : NaN;
  return {
    headCommit,
    headSubject: subject.ok ? (subject.stdout.trim() || null) : null,
    headAuthorTime: Number.isFinite(seconds) ? seconds * 1000 : null,
    branch: await readBranch(repoRoot),
  };
}

async function resolveUpstream(repoRoot: string, branch: string | null): Promise<string | null> {
  const upstream = await runGit(['-C', repoRoot, 'rev-parse', '--abbrev-ref', '@{u}']);
  if (upstream.ok) {
    const value = upstream.stdout.trim();
    if (value && value !== '@{u}') return value;
  }
  if (!branch) return null;
  const candidate = `origin/${branch}`;
  const verify = await runGit(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
  return verify.ok ? candidate : null;
}

/**
 * 同步前置：fetch + 自动更新。
 *  - managed=true：reset --hard + clean -fdx（工具副本）
 *  - managed=false：merge --ff-only（绝不 reset / clean）
 * fetch / update 失败只记录并继续；clean 失败由调用方视为致命。
 */
export async function prepareGitSync(input: {
  repoRoot: string;
  managed: boolean;
  branch: string | null;
  timeoutMs?: number;
  onPhase?: (phase: 'git-fetch' | 'git-update') => void;
}): Promise<GitUpdateResult> {
  const before = await readHeadMeta(input.repoRoot);
  const remotes = await runGit(['-C', input.repoRoot, 'remote']);
  if (!remotes.ok || remotes.stdout.trim().length === 0) {
    return {
      fetch: 'skipped',
      update: 'skipped',
      clean: 'skipped',
      branch: before.branch,
      headCommit: before.headCommit,
      headSubject: before.headSubject,
      headAuthorTime: before.headAuthorTime,
    };
  }

  input.onPhase?.('git-fetch');
  const fetch = await runGit(['-C', input.repoRoot, 'fetch'], undefined, {
    timeoutMs: input.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const fetchState: GitFetchState = fetch.ok ? 'ok' : 'failed';
  const fetchDetail = fetch.ok ? undefined : sanitizeGitError(fetch.error);

  input.onPhase?.('git-update');
  const upstream = await resolveUpstream(input.repoRoot, input.branch);
  let update: GitUpdateState = 'skipped';
  let updateDetail: string | undefined;
  let clean: GitCleanState = 'skipped';
  let cleanDetail: string | undefined;

  if (input.managed) {
    if (!upstream) {
      update = 'failed';
      updateDetail = '托管 clone 无法解析远端分支（origin/<branch>）';
    } else {
      const reset = await runGit(['-C', input.repoRoot, 'reset', '--hard', upstream], undefined, {
        timeoutMs: UPDATE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!reset.ok) {
        update = 'failed';
        updateDetail = sanitizeGitError(reset.error);
      } else {
        const cleaned = await runGit(['-C', input.repoRoot, 'clean', '-fdx'], undefined, {
          timeoutMs: UPDATE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        clean = cleaned.ok ? 'ok' : 'failed';
        if (!cleaned.ok) cleanDetail = sanitizeGitError(cleaned.error);
        const afterHead = await readHead(input.repoRoot);
        update = afterHead && afterHead !== before.headCommit ? 'updated' : 'up-to-date';
      }
    }
  } else if (!upstream) {
    update = 'skipped';
  } else {
    const merge = await runGit(['-C', input.repoRoot, 'merge', '--ff-only', upstream], undefined, {
      timeoutMs: UPDATE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!merge.ok) {
      update = 'failed';
      updateDetail = sanitizeGitError(merge.error);
    } else {
      const afterHead = await readHead(input.repoRoot);
      update = afterHead && afterHead !== before.headCommit ? 'updated' : 'up-to-date';
    }
  }

  const after = await readHeadMeta(input.repoRoot);
  return {
    fetch: fetchState,
    ...(fetchDetail ? { fetchDetail } : {}),
    update,
    ...(updateDetail ? { updateDetail } : {}),
    clean,
    ...(cleanDetail ? { cleanDetail } : {}),
    branch: after.branch,
    headCommit: after.headCommit,
    headSubject: after.headSubject,
    headAuthorTime: after.headAuthorTime,
  };
}

function toRelative(repoPath: string, relativeRoot: string): string | null {
  const value = repoPath.replaceAll('\\', '/');
  if (!relativeRoot) return value;
  const prefix = `${relativeRoot}/`;
  if (value === relativeRoot) return '';
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function isScannableRelPath(rel: string, extensions: string[]): boolean {
  if (!rel) return false;
  const segments = rel.split('/');
  // 与 collectMarkdownFiles 同口径：跳过隐藏目录与 node_modules（文件名本身可隐藏）
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].startsWith('.') || segments[i] === 'node_modules') return false;
  }
  const lower = rel.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

function isUnknownCommitError(text: string): boolean {
  return /bad object|unknown revision|not a valid object|bad revision|invalid object name|fatal: bad/i.test(text);
}

/** 脱敏 git stderr：去 URL 凭据、只留尾部、截断到 500 字。 */
export function sanitizeGitError(raw: string): string {
  const redacted = raw
    .replace(/https?:\/\/[^@\s/]+(?::[^@\s/]*)?@/gi, (match) => `${match.slice(0, match.indexOf('://') + 3)}`)
    .replace(/ssh:\/\/[^@\s/]+(?::[^@\s/]*)?@/gi, 'ssh://')
    .replace(/\b([A-Za-z0-9._-]+):[^@\s]+@/g, '$1@');
  const lines = redacted.split('\n').map((line) => line.trim()).filter(Boolean).slice(-20);
  return lines.join('\n').slice(0, 500);
}

/**
 * 计算 tracked 变更集 + untracked 计数。
 * lastCommit 为空时只做 untracked 统计（调用方走全量）；diff 不可解析时 commitUnknown=true。
 */
export async function collectGitChanges(input: {
  repoRoot: string;
  relativeRoot: string;
  lastCommit: string | null;
  extensions: string[];
  timeoutMs?: number;
}): Promise<GitChangeSet> {
  const headCommit = await readHead(input.repoRoot);
  const pathspec = input.relativeRoot || '.';
  const untracked = await runGit(
    ['-C', input.repoRoot, 'ls-files', '-z', '--others', '--exclude-standard', '--', pathspec],
    undefined,
    { timeoutMs: input.timeoutMs ?? DIFF_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
  );
  let untrackedMarkdown = 0;
  let untrackedError: string | undefined;
  if (untracked.ok) {
    for (const path of untracked.stdout.split('\0')) {
      if (!path) continue;
      const rel = toRelative(path, input.relativeRoot);
      if (rel !== null && isScannableRelPath(rel, input.extensions)) untrackedMarkdown += 1;
    }
  } else {
    untrackedError = sanitizeGitError(untracked.error);
  }

  if (!input.lastCommit) {
    return { changedRels: [], untrackedMarkdown, ...(untrackedError ? { untrackedError } : {}), deletedCount: 0, headCommit, commitUnknown: false };
  }
  if (!/^[0-9a-f]{7,64}$/i.test(input.lastCommit)) {
    return { changedRels: [], untrackedMarkdown, ...(untrackedError ? { untrackedError } : {}), deletedCount: 0, headCommit, commitUnknown: true };
  }

  const diff = await runGit(
    ['-C', input.repoRoot, 'diff', '--name-status', '-z', '--no-renames', input.lastCommit, '--', pathspec],
    undefined,
    { timeoutMs: input.timeoutMs ?? DIFF_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
  );
  if (!diff.ok) {
    if (isUnknownCommitError(diff.error)) {
      return { changedRels: [], untrackedMarkdown, ...(untrackedError ? { untrackedError } : {}), deletedCount: 0, headCommit, commitUnknown: true };
    }
    throw Object.assign(new Error(`git diff 失败：${sanitizeGitError(diff.error)}`), { code: 'GIT_DIFF_FAILED' });
  }

  const changed = new Set<string>();
  let deletedCount = 0;
  const parts = diff.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const repoPath = parts[i + 1];
    if (!status || !repoPath) continue;
    const rel = toRelative(repoPath, input.relativeRoot);
    if (rel === null || !isScannableRelPath(rel, input.extensions)) continue;
    if (status.startsWith('D')) {
      deletedCount += 1;
      continue;
    }
    if (/^[AMTCU]/.test(status)) changed.add(rel);
  }
  return {
    changedRels: [...changed].sort(),
    untrackedMarkdown,
    ...(untrackedError ? { untrackedError } : {}),
    deletedCount,
    headCommit,
    commitUnknown: false,
  };
}
