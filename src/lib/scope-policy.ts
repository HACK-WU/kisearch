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
