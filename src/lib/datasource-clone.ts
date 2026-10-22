/**
 * 托管 clone（S-05）：URL/分支/子目录校验、clone 到受控目录、失败清理、purge。
 *
 * 安全边界：
 *  - `execFile('git', args)` + `--` 分隔；禁交互；超时
 *  - 目标路径由 scope 派生并做根目录守卫；拒绝符号链接
 *  - 临时目录 clone 成功后 rename，失败不把半成品留在最终路径
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveImportExtensions, type KiConfig } from './config.js';
import { collectMarkdownFiles } from './import.js';
import { validateScope } from './scope.js';
import { probeGit, sanitizeGitError, sanitizeRemoteUrl } from './datasource-git.js';
import type { DataSourceRecord } from './datasource-types.js';

export const DATASOURCE_CLONE_ROOT = path.join(os.homedir(), '.ki', 'datasources');
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * 实际 clone 根：默认 `~/.ki/datasources`。
 * `KI_DATASOURCE_CLONE_ROOT` 仅供隔离测试/自定义部署使用（避免测试写进真实 HOME）。
 */
function cloneRoot(): string {
  const override = process.env.KI_DATASOURCE_CLONE_ROOT?.trim();
  return override ? path.resolve(override) : DATASOURCE_CLONE_ROOT;
}

export type GitUrlCode =
  | 'INVALID_GIT_URL'
  | 'GIT_URL_CREDENTIALS'
  | 'GIT_SCHEME_UNSUPPORTED';

export type GitUrlCheck = { ok: true; url: string } | { ok: false; code: GitUrlCode; error: string };

export function managedScopeDir(scope: string): string {
  validateScope(scope);
  return path.join(cloneRoot(), scope);
}

export function managedRepoDir(scope: string): string {
  return path.join(managedScopeDir(scope), 'repo');
}

/**
 * 允许 https / ssh / git+ssh / scp-like；拒绝 http / git / file（默认）、ext:: 与
 * 任何 `xxx::` 传输、带密码的 URL、以 `-` 开头的值。
 * `allowFile` 仅用于验收/单元测试（生产 API/CLI 不开启）。
 */
export function validateGitUrl(raw: string, opts: { allowFile?: boolean } = {}): GitUrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 不能为空' };
  if (value.length > 2048) return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 过长（>2048）' };
  if (value.startsWith('-')) return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 不能以 - 开头' };
  if (/[\0\r\n]/.test(value)) return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 含非法控制字符' };
  // ext:: / fd:: 等 git 传输注入
  if (/^[a-z][a-z0-9+.-]*::/i.test(value)) {
    return { ok: false, code: 'GIT_SCHEME_UNSUPPORTED', error: '不支持该 Git 传输协议' };
  }
  if (value.startsWith('file://')) {
    return opts.allowFile
      ? { ok: true, url: value }
      : { ok: false, code: 'GIT_SCHEME_UNSUPPORTED', error: '本地目录请使用 --source 登记，不支持 file://' };
  }
  if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value) || /^git\+ssh:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 格式非法' };
    }
    if (url.password) return { ok: false, code: 'GIT_URL_CREDENTIALS', error: 'Git URL 不能包含密码，请使用 SSH agent/credential helper' };
    // 查询串里的 token 同样属于凭据：会被 git 使用并原样存进 remoteUrl
    const sensitiveParam = [...url.searchParams.keys()].find((key) => (
      /^(access[_-]?token|private[_-]?token|token|auth|authorization|password|passwd|secret|client[_-]?secret|api[_-]?key|apikey)$/i.test(key)
    ));
    if (sensitiveParam) {
      return { ok: false, code: 'GIT_URL_CREDENTIALS', error: `Git URL 不能包含查询串凭据（${sensitiveParam}），请使用 SSH agent/credential helper` };
    }
    return { ok: true, url: value };
  }
  if (/^http:\/\//i.test(value) || /^git:\/\//i.test(value)) {
    return { ok: false, code: 'GIT_SCHEME_UNSUPPORTED', error: '不支持明文 http:// / git://，请使用 https 或 ssh' };
  }
  // scp-like: user@host:path；拒绝 user:pass@host:path
  if (/^[^@\s/:]+@[^:\s/]+:.+$/.test(value)) {
    return { ok: true, url: value };
  }
  if (/^[^@\s]+:[^@\s]+@/.test(value)) {
    return { ok: false, code: 'GIT_URL_CREDENTIALS', error: 'scp-like URL 不能包含密码' };
  }
  return { ok: false, code: 'INVALID_GIT_URL', error: 'Git URL 格式非法（支持 https/ssh/scp-like）' };
}

/** 子目录：相对路径、无 .. / 反斜杠 / 空段 / .git 段；空字符串 = 仓库根 */
export function isSafeRelativeSubdir(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) return false;
  return true;
}

function gitExec(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
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

export async function validateBranchName(branch: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const value = branch.trim();
  if (!value) return { ok: false, error: '分支名不能为空' };
  if (value.startsWith('-') || value.length > 255) return { ok: false, error: '分支名非法' };
  try {
    await gitExec(['check-ref-format', '--branch', value]);
    return { ok: true };
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr ?? (err as Error).message;
    return { ok: false, error: `分支名非法：${detail.trim() || value}` };
  }
}

export type CloneErrorCode =
  | 'INVALID_SCOPE'
  | 'INVALID_GIT_URL'
  | 'GIT_URL_CREDENTIALS'
  | 'GIT_SCHEME_UNSUPPORTED'
  | 'INVALID_SUBDIR'
  | 'INVALID_BRANCH'
  | 'CLONE_DIR_INSIDE_DATA_DIR'
  | 'CLONE_TARGET_EXISTS'
  | 'GIT_AUTH_FAILED'
  | 'GIT_REPO_NOT_FOUND'
  | 'GIT_NETWORK_FAILED'
  | 'GIT_BRANCH_NOT_FOUND'
  | 'GIT_CLONE_TIMEOUT'
  | 'CLONE_CANCELLED'
  | 'SOURCE_EMPTY'
  | 'CLONE_FAILED';

export interface CloneResult {
  scope: string;
  repoRoot: string;
  dir: string;
  branch: string | null;
  headCommit: string | null;
  remoteUrl: string | null;
}

export type CloneOutcome = { ok: true; value: CloneResult } | { ok: false; code: CloneErrorCode; error: string; hint?: string };

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function mapCloneFailure(stderr: string): { code: CloneErrorCode; error: string } {
  const text = sanitizeGitError(stderr);
  if (/authentication failed|permission denied \(publickey\)|could not read username|terminal prompts disabled|access denied/i.test(text)) {
    return { code: 'GIT_AUTH_FAILED', error: `认证失败：请在运行 daemon 的环境中配置 SSH agent 或 credential helper（${text}）` };
  }
  // 分支判断必须先于「not found」通用判断：`remote branch ... not found` 会同时命中后者
  if (/remote branch .* not found|fatal: remote branch/i.test(text)) {
    return { code: 'GIT_BRANCH_NOT_FOUND', error: `远端分支不存在（${text}）` };
  }
  if (/repository .*not found|does not appear to be a git repository|not found/i.test(text)) {
    return { code: 'GIT_REPO_NOT_FOUND', error: `仓库不存在或当前凭据无权访问（${text}）` };
  }
  if (/could not resolve host|connection timed out|network is unreachable|failed to connect|couldn't connect/i.test(text)) {
    return { code: 'GIT_NETWORK_FAILED', error: `无法连接远端（${text}）` };
  }
  return { code: 'CLONE_FAILED', error: `clone 失败：${text || '未知错误'}` };
}

function cleanupTemp(tmp: string): void {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

function cleanupStaleTemps(scopeDir: string): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(scopeDir, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-repo-')) continue;
    const target = path.join(scopeDir, entry.name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      if (now - stat.mtimeMs > STALE_TMP_MS) cleanupTemp(target);
    } catch { /* ignore */ }
  }
}

export type ManagedSubdirCheck =
  | { ok: true; dir: string }
  | { ok: false; code: 'INVALID_SUBDIR' | 'SOURCE_EMPTY'; error: string; hint?: string };

function topLevelDirsHint(repoRoot: string): string | undefined {
  try {
    const dirs = fs.readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (dirs.length === 0) return undefined;
    return `仓库顶层目录：${dirs.slice(0, 12).join('、')}${dirs.length > 12 ? ` 等 ${dirs.length} 个` : ''}`;
  } catch {
    return undefined;
  }
}

/** 校验某个仓库根下的导入子目录（复用已有 clone 时也用它做前置校验）。 */
export function checkManagedSubdir(
  repoRoot: string,
  subdirInput: string,
  config: KiConfig,
  scope: string,
): ManagedSubdirCheck {
  const subdir = subdirInput.trim().replace(/^\/+|\/+$/g, '');
  const fail = (code: 'INVALID_SUBDIR' | 'SOURCE_EMPTY', error: string, withHint = true): ManagedSubdirCheck => {
    const hint = withHint ? topLevelDirsHint(repoRoot) : undefined;
    return { ok: false, code, error, ...(hint ? { hint } : {}) };
  };
  if (!isSafeRelativeSubdir(subdir)) {
    return fail('INVALID_SUBDIR', `非法子目录：${subdirInput}`);
  }
  const dir = subdir ? path.join(repoRoot, ...subdir.split('/')) : repoRoot;
  try {
    const lstat = fs.lstatSync(dir);
    // lstat 不跟随链接：必须先判 symlink，否则 isDirectory() 为 false 会掩盖真实原因
    if (lstat.isSymbolicLink()) {
      return fail('INVALID_SUBDIR', `子目录不能是符号链接：${subdir}`, false);
    }
    if (!lstat.isDirectory()) {
      return fail('INVALID_SUBDIR', `子目录不存在或不是目录：${subdir}`);
    }
    // 仓库内容可含任意 symlink：realpath 必须仍落在 clone 内，否则会把宿主机任意目录当导入源
    const realDir = fs.realpathSync(dir);
    const realRepo = fs.realpathSync(repoRoot);
    if (!isInside(realRepo, realDir)) {
      return fail('INVALID_SUBDIR', `子目录解析后越出仓库（符号链接）：${subdir}`, false);
    }
  } catch {
    return fail('INVALID_SUBDIR', `子目录不存在：${subdir}`);
  }
  const files = collectMarkdownFiles(dir, resolveImportExtensions(config, scope)).files;
  if (files.length === 0) {
    const exts = resolveImportExtensions(config, scope).join(', ');
    return fail('SOURCE_EMPTY', `仓库（或子目录）中没有可导入文件（${exts}）：${subdir || '.'}`);
  }
  return { ok: true, dir };
}

export interface CloneManagedInput {
  scope: string;
  url: string;
  branch?: string | null;
  subdir?: string | null;
  config: KiConfig;
  /** 仅测试：允许 file://；生产 API/CLI 不开启 */
  allowFileUrl?: boolean;
  onProgress?: (progress: { phase: 'clone'; done: number; total: number }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export async function cloneManagedRepo(input: CloneManagedInput): Promise<CloneOutcome> {
  const scope = input.scope;
  try { validateScope(scope); } catch (err) { return { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message }; }
  const urlCheck = validateGitUrl(input.url, { allowFile: input.allowFileUrl === true });
  if (!urlCheck.ok) return { ok: false, code: urlCheck.code as CloneErrorCode, error: urlCheck.error };
  const subdir = (input.subdir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!isSafeRelativeSubdir(subdir)) return { ok: false, code: 'INVALID_SUBDIR', error: `非法子目录：${input.subdir}` };
  if (input.branch) {
    const branchCheck = await validateBranchName(input.branch);
    if (!branchCheck.ok) return { ok: false, code: 'INVALID_BRANCH', error: branchCheck.error };
  }

  const scopeDir = managedScopeDir(scope);
  const repoDir = managedRepoDir(scope);
  if (isInside(input.config.dataDir, scopeDir)) {
    return { ok: false, code: 'CLONE_DIR_INSIDE_DATA_DIR', error: `托管 clone 目录不能位于 dataDir 内：${scopeDir}` };
  }
  if (fs.existsSync(repoDir)) {
    return { ok: false, code: 'CLONE_TARGET_EXISTS', error: `托管目录已存在：${repoDir}` };
  }
  const root = cloneRoot();
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    return { ok: false, code: 'CLONE_FAILED', error: `clone 根目录是符号链接，拒绝写入：${root}` };
  }
  try {
    if (fs.existsSync(scopeDir) && fs.lstatSync(scopeDir).isSymbolicLink()) {
      return { ok: false, code: 'CLONE_FAILED', error: `托管目录是符号链接，拒绝写入：${scopeDir}` };
    }
    fs.mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(scopeDir, 0o700);
  } catch (err) {
    return { ok: false, code: 'CLONE_FAILED', error: `创建托管目录失败：${(err as Error).message}` };
  }
  cleanupStaleTemps(scopeDir);

  const tmp = path.join(scopeDir, `.tmp-repo-${crypto.randomUUID()}`);
  const args = ['clone', '--progress'];
  if (input.branch) args.push('--branch', input.branch);
  args.push('--', urlCheck.url, tmp);

  try {
    await new Promise<void>((resolve, reject) => {
      let lastPercent = -1;
      let lastAt = 0;
      const child = execFile('git', args, {
        timeout: input.timeoutMs ?? CLONE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          LC_ALL: 'C',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/true',
          SSH_ASKPASS: '/bin/true',
        },
        encoding: 'utf8',
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      }, (error, _stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
          if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
            reject(Object.assign(new Error('clone 已取消'), { code: 'CLONE_CANCELLED' }));
            return;
          }
          if (e.killed) {
            reject(Object.assign(new Error('clone 超时'), { code: 'GIT_CLONE_TIMEOUT', stderr: typeof stderr === 'string' ? stderr : '' }));
            return;
          }
          reject(Object.assign(error, { stderr: typeof stderr === 'string' ? stderr : '' }));
          return;
        }
        resolve();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        const matches = [...text.matchAll(/(\d+)%/g)];
        if (matches.length === 0) return;
        const percent = Number.parseInt(matches[matches.length - 1][1], 10);
        const now = Date.now();
        if (percent === lastPercent || now - lastAt < 200) return;
        lastPercent = percent;
        lastAt = now;
        input.onProgress?.({ phase: 'clone', done: percent, total: 100 });
      });
    });
  } catch (err) {
    cleanupTemp(tmp);
    const e = err as NodeJS.ErrnoException & { code?: string; stderr?: string };
    if (e.code === 'CLONE_CANCELLED') return { ok: false, code: 'CLONE_CANCELLED', error: 'clone 已取消' };
    if (e.code === 'GIT_CLONE_TIMEOUT') return { ok: false, code: 'GIT_CLONE_TIMEOUT', error: 'clone 超时（10 分钟）' };
    return { ok: false, ...mapCloneFailure(typeof e.stderr === 'string' ? e.stderr : e.message) };
  }

  try {
    const probe = await probeGit(tmp);
    if (!probe.ok) {
      cleanupTemp(tmp);
      return { ok: false, code: 'CLONE_FAILED', error: probe.error };
    }
    // 只支持远端分支：tag / commit 会得到 detached HEAD，后续 reset --hard origin/<ref> 不可用
    if (input.branch && probe.value.branch !== input.branch) {
      cleanupTemp(tmp);
      return {
        ok: false,
        code: 'INVALID_BRANCH',
        error: `--branch 只支持远端分支（${input.branch} 克隆后为 detached HEAD，可能是 tag/commit）`,
      };
    }
    const subdirCheck = checkManagedSubdir(tmp, subdir, input.config, scope);
    if (!subdirCheck.ok) {
      cleanupTemp(tmp);
      return {
        ok: false,
        code: subdirCheck.code,
        error: subdirCheck.error,
        ...(subdirCheck.hint ? { hint: subdirCheck.hint } : {}),
      };
    }
    if (fs.existsSync(repoDir)) {
      cleanupTemp(tmp);
      return {
        ok: false,
        code: 'CLONE_TARGET_EXISTS',
        error: `托管目录已存在：${repoDir}。如确认是遗留副本，可执行 ki datasource remove --scope ${scope} --purge --yes 清理后重试`,
      };
    }
    fs.renameSync(tmp, repoDir);
    return {
      ok: true,
      value: {
        scope,
        repoRoot: repoDir,
        dir: subdir ? path.join(repoDir, ...subdir.split('/')) : repoDir,
        branch: probe.value.branch,
        headCommit: probe.value.headCommit,
        remoteUrl: sanitizeRemoteUrl(probe.value.remoteUrl ?? ''),
      },
    };
  } catch (err) {
    cleanupTemp(tmp);
    return { ok: false, code: 'CLONE_FAILED', error: `clone 后校验失败：${(err as Error).message}` };
  }
}

/** 从 repoRoot 推导托管根目录（`<cloneRoot>/<owner>/repo` → `<cloneRoot>/<owner>`）。 */
export function managedCloneDirForRepo(repoRoot: string): string | null {
  const root = path.resolve(cloneRoot());
  const repo = path.resolve(repoRoot);
  const rel = path.relative(root, repo);
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || parts[1] !== 'repo') return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(parts[0])) return null;
  return path.join(root, parts[0]);
}

/**
 * 从记录推导托管根目录。允许多个 scope 共享同一 clone（repoRoot 可能属于
 * 另一个 scope）；是否可删除由引用计数决定，不在这里判断。
 */
export function managedCloneDirOf(record: DataSourceRecord): string | null {
  if (!record.git?.managed) return null;
  return managedCloneDirForRepo(record.git.repoRoot);
}

/** 删除托管 clone 根目录（`<root>/<scope>`），带根目录守卫与符号链接拒绝。 */
export async function purgeManagedCloneDir(dir: string): Promise<{ removed: boolean } | { removed: false; error: string }> {
  const target = path.resolve(dir);
  const root = path.resolve(cloneRoot());
  // 只允许精确的 <root>/<scope>（深度 1）：更深层/根本身一律拒绝
  if (path.dirname(target) !== root || target === root) {
    return { removed: false, error: `拒绝删除非托管目录：${dir}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
    return { removed: false, error: (err as Error).message };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { removed: false, error: `托管目录不是安全目录：${target}` };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    return { removed: false, error: `删除托管目录失败：${(err as Error).message}` };
  }
}
