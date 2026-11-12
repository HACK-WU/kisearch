/**
 * scope-policy.ts — scope 只读门禁（REQ-20261029-001）
 *
 * 语义：只读 scope **禁止逐条写入**（Web / MCP / CLI 单条），但批量更新
 * （`ki import`、数据源同步）与运维通道（clear/delete/restore/rebuild）不受限，
 * 读侧（检索/浏览/导出/备份）完全不受影响。
 *
 * 两段式挂点（**刻意不是单点**）：
 *   ① HTTP 入口层（本文件 `assertHttpChannelWritable`）：只挡"Web 用户通道"的接口。
 *      —— 因为 `import` op 被三条路径共用：CLI `ki import`（src/import.ts:187）、
 *         Web `/api/import/run`（lib/mcp-http-api.ts:3046）、数据源同步（lib/datasource.ts:1222），
 *         都进 `withScopeWriteLock(scope,'import')`（lib/import.ts:677）。
 *         第二段若拦 `import`，数据源同步会被一并废掉；只做第二段又挡不住 Web。
 *   ② `withScopeWriteLock` 内（本文件 `assertOperationWritable`）：默认拦 + 例外表放行，
 *      覆盖 CLI / MCP / daemon 的全部写路径；判定在**取锁之前**（fail-fast，不排队）。
 *
 * ⚠️ `scope-readonly` 这个 op 本身**不得**经过 `withScopeWriteLock`：
 *    它写的是配置文件（策略本身），若被自身门禁拦下，只读库将永远无法解除（自锁死锁）。
 */

import { loadConfig, isScopeReadonly, type KiConfig } from './config.js';
import { isViewName, getViewMembers } from './scope-view.js';

/** 统一错误码（HTTP body / MCP 文本 / CLI 输出共用） */
export const SCOPE_READONLY = 'SCOPE_READONLY' as const;

export type OperationPolicy = 'exempt' | 'block' | 'unknown';

/**
 * 只读下**仍放行**的 op：批量更新通道 + 数据源管理 + 运维。
 *
 * ⚠️ `import` 必须在列：数据源同步内部即走 `handleDirectImport`（lib/datasource.ts:1222）。
 * Web 的 `/api/import/*` 由第一段（HTTP 通道判定）单独挡。
 */
export const EXEMPT_OPS: ReadonlySet<string> = new Set([
  // 批量更新通道
  'import',
  // 数据源（同步/登记/计划）
  'datasource-sync',
  'datasource-add',
  'datasource-add-remote',
  'datasource-update',
  'datasource-remove',
  'datasource-schedule',
  'datasource-schedule-reset',
  // 运维
  'scope-delete',
  'scope-clear',
  'restore-snapshot',
  'rebuild-vector',
  'migrate-relation-cache',
]);

/**
 * 只读下**拦截**的 op：逐条写入。
 *
 * 与 {@link EXEMPT_OPS} 一起构成"写入通道登记表"：单测断言两者并集覆盖
 * `withScopeWriteLock` 的全部 op 字面量，新增写通道未登记即测试红（D14）。
 */
export const BLOCKED_OPS: ReadonlySet<string> = new Set([
  'store',
  'bulk-store',
  'sync-relation',
  'bulk-sync-relation',
  'edit-relation',
  'delete-relation',
  'batch-delete',
  'group-create',
  'group-delete',
  'doc-delete',
  'doc-edit-write',
  // 文档移动（REQ-20261112-002）：只读库同样不许搬动归属
  'doc-move-write',
]);

/** 判定某 op 的归属；`unknown` = 未登记（按拦截处理，并由单测报警） */
export function describeOperationPolicy(operation: string): OperationPolicy {
  if (EXEMPT_OPS.has(operation)) return 'exempt';
  if (BLOCKED_OPS.has(operation)) return 'block';
  return 'unknown';
}

/**
 * 只读写入被拒。
 *
 * message 需**自解释**：MCP 客户端（AI）与脚本只看到这段文本，
 * 必须能据此决定"换库 / 告知用户 / 解除只读"，而不是反复重试。
 */
export class ScopeReadonlyError extends Error {
  readonly code: typeof SCOPE_READONLY = SCOPE_READONLY;
  readonly scope: string;
  readonly action: string;

  constructor(scope: string, action: string) {
    super(`scope "${scope}" 为只读（operation=${action}）。如确需写入，先执行：ki scope readonly ${scope} --off`);
    this.name = 'ScopeReadonlyError';
    this.scope = scope;
    this.action = action;
  }
}

/** 类型守卫：HTTP 层据此映射 409，MCP 层据此透传文案 */
export function isScopeReadonlyError(err: unknown): err is ScopeReadonlyError {
  if (err instanceof ScopeReadonlyError) return true;
  return (err as { code?: string })?.code === SCOPE_READONLY;
}

/**
 * 该 scope 是否只读（展示/门禁用）。
 *
 * ⚠️ 读配置失败时返回 false 并告警：`loadConfig` 自身会沿用 last-known-good
 * （其 `scopeReadonly` 仍是上次成功解析的名单），因此常规情况下保护**不会**因
 * 配置损坏而放开；走到 catch 只可能是"进程启动即无配置"这类极端情形。
 */
export function isScopeReadonlySafe(scope: string, config?: KiConfig): boolean {
  const name = scope?.trim() || 'default'; // 与 resolveScope 口径一致
  try {
    return isScopeReadonly(config ?? loadConfig(), name);
  } catch (err) {
    process.stderr.write(`警告：只读判定读取配置失败，按可写处理：${(err as Error).message}\n`);
    return false;
  }
}

/**
 * 第二段门禁：op 级判定（在 `withScopeWriteLock` 内、**取锁之前**调用）。
 *
 * @param config 可选，传入可避免重复 `loadConfig()`（每次调用含一次 statSync）
 */
export function assertOperationWritable(scope: string, operation: string, config?: KiConfig): void {
  if (describeOperationPolicy(operation) === 'exempt') return;
  const name = scope?.trim() || 'default';
  if (!isScopeReadonlySafe(name, config)) return;
  throw new ScopeReadonlyError(name, operation);
}

/**
 * 第一段门禁：HTTP 通道级判定（**只用于 Web 用户通道的接口**）。
 *
 * 用于 `/api/import/*` 与 `POST /api/doc/edit`。数据源与运维接口不调用此函数。
 * `action` 用于文案（如 `http:/api/import/run`）。
 */
export function assertHttpChannelWritable(scope: string, action: string, config?: KiConfig): void {
  const name = scope?.trim() || 'default';
  if (!isScopeReadonlySafe(name, config)) return;
  throw new ScopeReadonlyError(name, action);
}

/** HTTP 409 响应体（三处 handler 共用，避免文案漂移） */
export function scopeReadonlyBody(err: ScopeReadonlyError): {
  ok: false;
  code: typeof SCOPE_READONLY;
  scope: string;
  error: string;
  hint: string;
} {
  return {
    ok: false,
    code: SCOPE_READONLY,
    scope: err.scope,
    error: `该知识库为只读，禁止写入与导入。如确需写入：ki scope readonly ${err.scope} --off`,
    hint: '只读库仍可通过数据源同步或 ki import 更新',
  };
}

// ─── 视图门禁（REQ-20261104-003 / S-03） ───

/**
 * 视图不是知识库：写路径一律拒绝（VIEW_NOT_WRITABLE）。
 *
 * 与只读正交——只读是「这个库不让改」，这里是「这根本不是库」。因此
 * **不参与 `EXEMPT_OPS` / `BLOCKED_OPS` 体系**：只读库的 `import` 放行，
 * 但视图的 `import` 一律拒绝。
 *
 * 为什么必须拦：视图名能通过 `SCOPE_PATTERN` 字符校验，会一路带到
 * `getScopeDataDir()` —— 不拦就会凭空建出 `dataDir/<视图名>/` 并写入。
 */
export class ScopeViewWriteError extends Error {
  readonly code = 'VIEW_NOT_WRITABLE';
  readonly view: string;
  readonly members: string[];
  readonly action: string;

  constructor(view: string, members: string[], action: string, message?: string) {
    super(message ?? ScopeViewWriteError.buildMessage(view, members, action));
    this.name = 'ScopeViewWriteError';
    this.view = view;
    this.members = members;
    this.action = action;
  }

  /** 产物是 per-scope 目录的操作：列出逐库命令，而不是「换一个成员」 */
  private static readonly PRODUCT_CMD: Record<string, string> = {
    'export': 'ki export',
    'backup': 'ki backup',
    'restore': 'ki restore',
    'restore-snapshot': 'ki restore',
    'wiki-backfill': 'ki wiki-backfill',
    'index-optimize': 'ki index-optimize',
    'migrate-relation-cache': 'ki migrate-relation-cache',
  };

  /** 落点是单个知识库的操作：给一个可以直接复制执行的示例 */
  private static readonly WRITE_CMD: Record<string, string> = {
    'store': 'ki store',
    'bulk-store': 'ki bulk-store',
    'sync-relation': 'ki sync-relation',
    'bulk-sync-relation': 'ki sync-relation',
    'edit-relation': 'ki sync-relation',
    'delete-relation': 'ki delete-relation',
    'group-create': 'ki group create "<Group 路径>"',
    'group-delete': 'ki group delete "<Group 路径>"',
    'doc-delete': 'ki doc delete',
    'import': 'ki import',
    'scope-delete': 'ki scope delete',
    'scope-clear': 'ki scope clear',
    'rebuild-vector': 'ki restore <scope> --rebuild-vector',
    'datasource-add': 'ki datasource add',
    'datasource-add-remote': 'ki datasource add',
    'datasource-sync': 'ki datasource sync',
    'datasource-remove': 'ki datasource remove',
    'datasource-schedule': 'ki datasource schedule',
    'datasource-update': 'ki datasource',
  };

  private static buildMessage(view: string, members: string[], action: string): string {
    const product = ScopeViewWriteError.PRODUCT_CMD[action];
    if (product) {
      const lines = members.map((m) => `    ${product} ${m}`).join('\n');
      return `视图 ${view} 暂不支持 ${action}（产物是每个知识库一套目录）。\n`
        + '  请逐库执行：\n' + lines;
    }

    const cmd = ScopeViewWriteError.WRITE_CMD[action];
    const example = cmd ? `\n  请改用其中一个成员，例如：\n    ${cmd} --scope ${members[0]}` : '';
    return `视图 ${view} 是只读聚合，不是知识库，不能作为写入目标（operation=${action}）。\n`
      + (members.length > 0 ? `  它的成员：${members.join('、')}${example}` : '  该视图没有成员。');
  }
}

export function isScopeViewWriteError(err: unknown): err is ScopeViewWriteError {
  return err instanceof ScopeViewWriteError
    || (err as { code?: string })?.code === 'VIEW_NOT_WRITABLE';
}

/**
 * 写路径门禁：`scope` 是视图名则抛 {@link ScopeViewWriteError}。
 *
 * 挂点只有两处，不逐个命令改：
 *   ① `scope-write-lock.ts`（覆盖 CLI / MCP / daemon 的全部写 op）
 *   ② 不经写锁的 CLI 读导出类命令（export / backup / restore / wiki-backfill 等）
 *
 * @param config 可选，传入可复用 `loadConfig()`
 */
export function assertNotScopeView(scope: string, operation: string, config?: KiConfig): void {
  if (!scope) return;
  const cfg = config ?? loadConfig();
  if (!isViewName(cfg, scope)) return;
  // 成员读取失败（如 views.json 损坏）时退化为空列表，不阻断门禁本身
  let members: string[] = [];
  try {
    members = getViewMembers(cfg, scope);
  } catch {
    members = [];
  }
  throw new ScopeViewWriteError(scope, members, operation);
}

/**
 * CLI 入口专用：命中视图名时打印并退出（1），避免每个命令各写一段 try/catch。
 * ⚠️ 含 `process.exit`，**仅供 CLI 命令文件调用**；MCP / HTTP / daemon 用
 * {@link assertNotScopeView}（需要把错误码透传给调用方）。
 */
export function assertNotScopeViewCli(scope: string, operation: string, config?: KiConfig): void {
  try {
    assertNotScopeView(scope, operation, config);
  } catch (err) {
    if (isScopeViewWriteError(err)) {
      process.stderr.write(`错误：${err.message}\n  错误码：${err.code}\n`);
      process.exit(1);
    }
    throw err;
  }
}
