/**
 * code-tools.ts —— 对话侧源码只读工具（REQ-20261127-001 · S-01）
 *
 * ═══ 三条硬约束 ═══
 * 1. **复用沙箱，不复制实现**：读 / 搜 / 找 / 列全部调用
 *    `events/analysis-fs-tools.ts` 的 `runFs*`；越界防护与限额只有一份。
 * 2. **通道隔离**：本模块的条目只由 `tool-loop` 在 `toolFace === 'chat'` 时保留；
 *    `ki_ask` / `/mcp` 不装配。执行查表也必须用过滤后的工具面（见 tool-loop）。
 * 3. **只读 + 超时**：单次调用 10s 超时，与会话 AbortSignal 手动合并
 *    （`engines` 为 Node ≥18.0，不用 `AbortSignal.any`）。
 */

import {
  FS_READ_MAX_FILE_BYTES,
  FS_READ_MAX_LINES,
  runFsFind,
  runFsGrep,
  runFsLs,
  runFsRead,
  validateTargetRootDir,
  type FsSandboxContext,
  type FsToolResult,
} from '../events/analysis-fs-tools.js';
import { resolveAnalysisTargetDir, type AnalysisTargetConfig } from './prompt-config.js';
import { resolveScopeTargets, ViewError } from '../scope-view.js';
import type { KiConfig } from '../config.js';
import type { ChatMcpToolEntry, ChatToolArgs, ChatToolDescribe } from './mcp-tool-registry.js';
import type { ChatCodeRoot, ChatCodeRootsResult, ChatToolRunContext, CodeRootSkipReason } from './code-tools-types.js';

export const CODE_TOOL_NAMES = ['fs_read', 'fs_grep', 'fs_find', 'fs_ls'] as const;

const CODE_TOOL_NAME_SET: ReadonlySet<string> = new Set(CODE_TOOL_NAMES);

export function isCodeTool(name: string): boolean {
  return CODE_TOOL_NAME_SET.has(name);
}

/** 单次工具调用超时（页面对话没有 `budgetMs`，大仓库 grep 需要一道硬闸） */
export const FS_TOOL_TIMEOUT_MS = 10_000;

// ─── 敏感文件拒绝（对话侧独有；分析侧不传 denyPath，行为不变）──────────

const SENSITIVE_DIRS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

const SENSITIVE_BASENAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

/**
 * 对话侧敏感路径判定：凭据目录 / 私钥 / `.env` 一律不读、不搜、不列。
 * 例外：`.pub` 公钥与 `.env.example|sample|template|dist` 模板不拦（它们不是秘密）。
 */
export function isSensitiveRelPath(relPath: string): boolean {
  const segments = relPath.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => SENSITIVE_DIRS.has(s.toLowerCase()))) return true;
  const base = segments[segments.length - 1] ?? '';
  if (/\.pub$/i.test(base)) return false;
  if (/^\.env\.(example|sample|template|dist)$/i.test(base)) return false;
  return SENSITIVE_BASENAMES.some((re) => re.test(base));
}

// ─── 根解析（S-02：单库 + 视图多根）────────────────────────────────────

/**
 * 只读 `byScope` 的精确映射（**不回落 `defaultDir`**）。
 * 视图成员必须用它：回落到默认目录会把所有成员映射到同一仓库，等于读错。
 */
export function resolveByScopeOnly(
  targetDirs: AnalysisTargetConfig | undefined,
  scope: string,
): string | null {
  if (!targetDirs) return null;
  const value = Object.prototype.hasOwnProperty.call(targetDirs.byScope, scope)
    ? targetDirs.byScope[scope]?.trim()
    : '';
  return value || null;
}

/**
 * 解析当前会话可读的代码目录。
 * · 单库：`byScope[scope]` → `defaultDir`；
 * · 视图：成员库各自的 `byScope`（去重，`defaultDir` 不参与），未映射 / 不可读进 `skipped`。
 */
export function resolveChatCodeRoots(
  scope: string,
  cfg: KiConfig,
  targetDirs?: AnalysisTargetConfig,
): ChatCodeRootsResult {
  let targets;
  try {
    targets = resolveScopeTargets(cfg, scope);
  } catch (err) {
    if (err instanceof ViewError && err.code === 'VIEW_EMPTY') {
      return { roots: [], skipped: [{ label: scope, reason: 'view-empty' }] };
    }
    // 不静默吞：不是"空视图"就写一行 stderr
    process.stderr.write(`[code-tools] 解析 scope「${scope}」失败：${(err as Error).message}\n`);
    // 视图文件坏了不代表单库没配置：单库仍按精确映射工作；
    // 但**绝不回落 defaultDir** —— 这个 scope 可能正是视图，回落会读错仓库。
    const dir = resolveByScopeOnly(targetDirs, scope);
    if (!dir) return { roots: [], skipped: [{ label: scope, reason: 'view-error' }] };
    const checked = validateTargetRootDir(dir);
    if (!checked.ok) return { roots: [], skipped: [{ label: scope, reason: 'unreadable' }] };
    return { roots: [{ label: scope, realRoot: checked.realRoot, aliases: [] }], skipped: [] };
  }

  if (targets.views.length > 0) {
    const byRealRoot = new Map<string, ChatCodeRoot>();
    const skipped: Array<{ label: string; reason: CodeRootSkipReason }> = [];
    for (const member of targets.skipped) {
      skipped.push({ label: member.scope, reason: 'strict-skipped' });
    }
    for (const member of targets.scopes) {
      const dir = resolveByScopeOnly(targetDirs, member);
      if (!dir) {
        skipped.push({ label: member, reason: 'unmapped' });
        continue;
      }
      const checked = validateTargetRootDir(dir);
      if (!checked.ok) {
        skipped.push({ label: member, reason: 'unreadable' });
        continue;
      }
      const existing = byRealRoot.get(checked.realRoot);
      if (existing) {
        byRealRoot.set(checked.realRoot, { ...existing, aliases: [...existing.aliases, member] });
      } else {
        byRealRoot.set(checked.realRoot, { label: member, realRoot: checked.realRoot, aliases: [] });
      }
    }
    return { roots: [...byRealRoot.values()], skipped };
  }

  const dir = resolveAnalysisTargetDir(targetDirs, scope);
  if (!dir) return { roots: [], skipped: [] };

  const checked = validateTargetRootDir(dir);
  if (!checked.ok) return { roots: [], skipped: [{ label: scope, reason: 'unreadable' }] };
  return {
    roots: [{ label: scope, realRoot: checked.realRoot, aliases: [] }],
    skipped: [],
  };
}

/** 只读展示入口（S-03 的设置接口消费）：与工具面解析同源，不再算一套 */
export function describeChatCodeRoots(
  scope: string,
  cfg: KiConfig,
  targetDirs?: AnalysisTargetConfig,
): ChatCodeRootsResult {
  return resolveChatCodeRoots(scope, cfg, targetDirs);
}

// ─── 选根 ────────────────────────────────────────────────────────────

type RootPick =
  | { ok: true; root: ChatCodeRoot }
  | { ok: false; code: 'NO_ROOT' | 'ROOT_REQUIRED' | 'UNKNOWN_ROOT'; error: string };

function pickRoot(roots: readonly ChatCodeRoot[], rawRoot: unknown): RootPick {
  if (roots.length === 0) {
    return { ok: false, code: 'NO_ROOT', error: '当前会话未配置可读代码目录，请先在「AI 分析 → 代码目录」配置' };
  }
  const wanted = typeof rawRoot === 'string' ? rawRoot.trim() : '';
  if (wanted) {
    const hit = roots.find((r) => r.label === wanted);
    if (!hit) {
      return {
        ok: false,
        code: 'UNKNOWN_ROOT',
        error: `未知的可读根「${wanted}」；可用：${roots.map((r) => r.label).join(' | ')}`,
      };
    }
    return { ok: true, root: hit };
  }
  if (roots.length === 1) return { ok: true, root: roots[0]! };
  return {
    ok: false,
    code: 'ROOT_REQUIRED',
    error: `本次有 ${roots.length} 个可读根，请指定 root：${roots.map((r) => r.label).join(' | ')}`,
  };
}

// ─── 超时 / 中止 ─────────────────────────────────────────────────────

interface CallGuard {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

function makeCallGuard(requestSignal?: AbortSignal): CallGuard {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FS_TOOL_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  if (requestSignal) {
    if (requestSignal.aborted) controller.abort();
    else requestSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onAbort);
    },
  };
}

type SandboxOutcome =
  | { ok: false; code: string; error: string }
  | { ok: true; root: ChatCodeRoot; data: Record<string, unknown> };

async function runSandbox(
  ctx: ChatToolRunContext | undefined,
  rawRoot: unknown,
  fn: (sandbox: FsSandboxContext) => Promise<FsToolResult>,
): Promise<SandboxOutcome> {
  const pick = pickRoot(ctx?.codeRoots ?? [], rawRoot);
  if (!pick.ok) return pick;

  const guard = makeCallGuard(ctx?.signal);
  const sandbox: FsSandboxContext = {
    rawRoot: pick.root.realRoot,
    realRoot: pick.root.realRoot,
    filesRead: new Set<string>(),
    signal: guard.signal,
    denyPath: isSensitiveRelPath,
    maxFileBytes: FS_READ_MAX_FILE_BYTES,
  };
  try {
    const result = await fn(sandbox);
    if (!result.ok) {
      if (result.code === 'ABORTED' && guard.timedOut()) {
        return {
          ok: false,
          code: 'TIMEOUT',
          error: `读取超时（${FS_TOOL_TIMEOUT_MS / 1000}s）：请缩小 path/glob 或换关键词`,
        };
      }
      return result;
    }
    return { ok: true, root: pick.root, data: result.data };
  } finally {
    guard.cleanup();
  }
}

/** 结果统一加根标签：`{label}:{relPath}`；grep 命中与 find 路径同样加前缀，避免多根串台 */
function withRootPath(outcome: SandboxOutcome): Record<string, unknown> {
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  const label = outcome.root.label;
  const prefix = (p: string): string => (p === '.' ? `${label}:.` : `${label}:${p}`);
  const data = outcome.data;
  const out: Record<string, unknown> = {
    ...data,
    ok: true,
    root: label,
    path: prefix(typeof data.path === 'string' ? data.path : '.'),
  };
  if (Array.isArray(data.hits)) {
    out.hits = data.hits.map((hit) => (
      hit !== null && typeof hit === 'object' && typeof (hit as { file?: unknown }).file === 'string'
        ? { ...(hit as Record<string, unknown>), file: prefix((hit as { file: string }).file) }
        : hit
    ));
  }
  if (Array.isArray(data.paths)) {
    out.paths = data.paths.map((p) => (typeof p === 'string' ? prefix(p) : p));
  }
  return out;
}

// ─── 入参解析（仅本模块的 4 个工具；白名单 + 钳制）─────────────────────

interface ArgSpec {
  key: string;
  type: 'string' | 'int';
  required?: boolean;
  min?: number;
  max?: number;
}

function parseCodeArgs(raw: string, specs: readonly ArgSpec[]): ChatToolArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().length > 0 ? raw : '{}');
  } catch {
    throw new Error('入参不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('入参应为对象');
  }
  const src = parsed as Record<string, unknown>;
  const out: ChatToolArgs = {};
  for (const spec of specs) {
    const value = src[spec.key];
    if (value === undefined || value === null || value === '') {
      if (spec.required) throw new Error(`缺少必填参数 ${spec.key}`);
      continue;
    }
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${spec.key} 应为字符串`);
      out[spec.key] = value;
      continue;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new Error(`${spec.key} 应为整数`);
    let i = Math.floor(n);
    if (spec.min !== undefined) i = Math.max(i, spec.min);
    if (spec.max !== undefined) i = Math.min(i, spec.max);
    out[spec.key] = i;
  }
  return out;
}

function describeArgs(args: ChatToolArgs): ChatToolDescribe {
  const out: Record<string, string | number | boolean> = {};
  for (const key of ['root', 'path', 'name', 'pattern', 'glob', 'offset', 'limit']) {
    const value = args[key];
    if (value === undefined || value === '') continue;
    out[key] = typeof value === 'number' ? value : String(value).slice(0, 60);
  }
  return Object.keys(out).length > 0 ? { args: out } : {};
}

// ─── 工具定义 ────────────────────────────────────────────────────────

const ROOT_PROP = {
  type: 'string',
  description: '可读根标签（多根必填、单根可省略）；见【可读代码目录】',
};

const PATH_PROP = {
  type: 'string',
  description: '相对所选根的文件路径，如 "src/auth/guard.ts"',
};

function readArg(args: ChatToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: ChatToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * 归一化路径入参：模型可能把工具返回的 `{label}:{rel}` 原样传回。
 * 命中某个根的标签前缀 → 剥掉前缀并推断 `root`；显式给了 root 时只剥该根的前缀。
 */
interface NormalizedPath {
  rawRoot: unknown;
  path: string;
}

function normalizePathArg(args: ChatToolArgs, roots: readonly ChatCodeRoot[]): NormalizedPath {
  const raw = readArg(args, 'path') ?? '.';
  const wanted = typeof args.root === 'string' ? args.root.trim() : '';
  const candidates = wanted ? roots.filter((r) => r.label === wanted) : roots;
  for (const root of candidates) {
    const prefix = `${root.label}:`;
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    return {
      rawRoot: typeof args.root === 'string' ? args.root : root.label,
      path: rest.length > 0 ? rest : '.',
    };
  }
  return { rawRoot: args.root, path: raw };
}

/** 构造 4 条对话侧源码只读工具（静态定义；根在运行时由 ctx 注入） */
export function createChatCodeToolEntries(): readonly ChatMcpToolEntry[] {
  const entries: ChatMcpToolEntry[] = [
    {
      name: 'fs_read',
      readOnly: true,
      def: {
        type: 'function',
        function: {
          name: 'fs_read',
          description: `读取代码文件片段（只读；单次 ≤${FS_READ_MAX_LINES} 行 / 64 KB；返回带行号）。用于精读上下文、确认调用链与真实行号。`,
          parameters: {
            type: 'object',
            properties: {
              root: ROOT_PROP,
              path: PATH_PROP,
              offset: { type: 'integer', minimum: 1, description: '起始行号（1-based），默认 1' },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: FS_READ_MAX_LINES,
                description: `读取行数，默认由系统按响应窗口推导（上限 ${FS_READ_MAX_LINES}）`,
              },
            },
            required: ['path'],
          },
        },
      },
      parse: (raw) => parseCodeArgs(raw, [
        { key: 'root', type: 'string' },
        { key: 'path', type: 'string', required: true },
        { key: 'offset', type: 'int', min: 1 },
        { key: 'limit', type: 'int', min: 1, max: FS_READ_MAX_LINES },
      ]),
      describe: describeArgs,
      run: async (_scope, args, ctx) => {
        const p = normalizePathArg(args, ctx?.codeRoots ?? []);
        return withRootPath(await runSandbox(ctx, p.rawRoot, (sandbox) => runFsRead(
          sandbox,
          p.path,
          {
            ...(intArg(args, 'offset') !== undefined ? { offset: intArg(args, 'offset') } : {}),
            ...(intArg(args, 'limit') !== undefined ? { limit: intArg(args, 'limit') } : {}),
          },
        )));
      },
    },
    {
      name: 'fs_grep',
      readOnly: true,
      def: {
        type: 'function',
        function: {
          name: 'fs_grep',
          description: '按正则或字面关键词检索源码行（只读；跳过二进制与依赖目录；最多返回 60 条 file:line）。',
          parameters: {
            type: 'object',
            properties: {
              root: ROOT_PROP,
              pattern: { type: 'string', description: '检索正则或关键词（如报错文本、函数名、错误码）' },
              path: { type: 'string', description: '限定子目录或单文件（相对路径），默认整个根' },
              glob: { type: 'string', description: '文件名 glob 过滤（如 "*.ts"、"src/**/*.tsx"）' },
            },
            required: ['pattern'],
          },
        },
      },
      parse: (raw) => parseCodeArgs(raw, [
        { key: 'root', type: 'string' },
        { key: 'pattern', type: 'string', required: true },
        { key: 'path', type: 'string' },
        { key: 'glob', type: 'string' },
      ]),
      describe: describeArgs,
      run: async (_scope, args, ctx) => {
        const p = normalizePathArg(args, ctx?.codeRoots ?? []);
        return withRootPath(await runSandbox(ctx, p.rawRoot, (sandbox) => runFsGrep(
          sandbox,
          readArg(args, 'pattern') ?? '',
          {
            path: p.path,
            ...(readArg(args, 'glob') !== undefined ? { glob: readArg(args, 'glob') } : {}),
          },
        )));
      },
    },
    {
      name: 'fs_find',
      readOnly: true,
      def: {
        type: 'function',
        function: {
          name: 'fs_find',
          description: '按文件名或路径模式查找文件（只读；跳过 .git/node_modules；最多返回 80 条路径）。',
          parameters: {
            type: 'object',
            properties: {
              root: ROOT_PROP,
              name: { type: 'string', description: '文件名子串或 glob（如 "guard.ts"、"*.tsx"）' },
              path: { type: 'string', description: '限定起始子目录（相对路径），默认 "."' },
            },
            required: ['name'],
          },
        },
      },
      parse: (raw) => parseCodeArgs(raw, [
        { key: 'root', type: 'string' },
        { key: 'name', type: 'string', required: true },
        { key: 'path', type: 'string' },
      ]),
      describe: describeArgs,
      run: async (_scope, args, ctx) => {
        const p = normalizePathArg(args, ctx?.codeRoots ?? []);
        return withRootPath(await runSandbox(ctx, p.rawRoot, (sandbox) => runFsFind(
          sandbox,
          readArg(args, 'name') ?? '',
          p.path,
        )));
      },
    },
    {
      name: 'fs_ls',
      readOnly: true,
      def: {
        type: 'function',
        function: {
          name: 'fs_ls',
          description: '列出目录下一层子目录与文件（只读；最多 200 项）。',
          parameters: {
            type: 'object',
            properties: {
              root: ROOT_PROP,
              path: { type: 'string', description: '相对子目录路径，默认 "."' },
            },
          },
        },
      },
    parse: (raw) => parseCodeArgs(raw, [
        { key: 'root', type: 'string' },
        { key: 'path', type: 'string' },
      ]),
      describe: describeArgs,
      run: async (_scope, args, ctx) => {
        const p = normalizePathArg(args, ctx?.codeRoots ?? []);
        return withRootPath(await runSandbox(ctx, p.rawRoot, (sandbox) => runFsLs(sandbox, p.path)));
      },
    },
  ];
  return entries;
}

// ─── 预算与提示块 ────────────────────────────────────────────────────

/**
 * `fs_read` 未显式给 `limit` 时按本轮响应窗口推导。
 * 下界取 1：小窗口下宁可少读，也不要抬到 40 行造成二次截断。
 */
export function applyFsReadWindow(
  name: string,
  args: ChatToolArgs,
  responseChars: number,
): ChatToolArgs {
  if (name !== 'fs_read' || args.limit !== undefined) return args;
  const lines = Math.floor((responseChars * 0.7) / 72);
  const limit = Math.max(1, Math.min(FS_READ_MAX_LINES, lines));
  return { ...args, limit };
}

export const CODE_READ_BLOCK_HEADER = '【源码只读（本次可用）】';

/** 有 `fs_*` 时按轮注入的条件提示；根清单让模型直接选根，不必先试探 */
export function renderCodeReadBlock(roots: readonly ChatCodeRoot[]): string {
  // 只列 label：aliases 仅给 UI 展示，列进模型提示词会让它用别名调 root（而 pickRoot 不接受）
  const lines = roots.map((r) => `- ${r.label} → ${r.realRoot}`);
  return [
    CODE_READ_BLOCK_HEADER,
    '· 先答知识库：本问题涉及的事实、结论、参数，先用 ki_* 检索 / 读文档；知识库能回答就直接回答，不要为了"更确定"去读代码。',
    '· 仅在以下情况读代码：知识库无相关文档；文档只有结论、没有实现细节；需要核对调用链、默认值、分支条件或行号。',
    '· 读法：先 fs_grep / fs_find 定位，再 fs_read 精读上下文；不要扫全仓。',
    '· 来源标注：知识库来源写文档名；代码来源写 {label}:{path}:{line}。不得把代码结论说成"知识库记载"。',
    '· 冲突：知识库与代码不一致时以代码为准，并明确指出冲突点。',
    '· 读不到 / 目录未配置：如实说明，退回知识库口径，不猜。',
    '· 本节是硬性规则第 1 条的补充：知识库无命中时，若源码工具可用，应继续下探而不是直接收口。',
    '【可读代码目录】',
    ...lines,
  ].join('\n');
}
