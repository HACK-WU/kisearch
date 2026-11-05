/**
 * scope-access.ts —— 「这个名字能不能访问」的**唯一判定**（含视图成员展开）
 *
 * 为什么必须收敛成一处：同一个 Token 会走两条通道
 *   ① MCP `tools/call`（Web 检索页也走这条，见 `web/src/api/mcpClient.ts`）
 *   ② Web REST（`/api/doc/list`、`/api/doc/get`、`/api/tags`…）
 * 两条通道各自实现判定时，一旦语义不同就会出现「同一份授权，一条通道放行、
 * 另一条拒绝」——曾经的实况是：MCP 侧做了「视图名 ∧ 全部成员」的全有或全无，
 * REST 侧只比对名字，于是 `ki mcp token generate --view team` 产生的 Token
 * 在 MCP 里全 403、在 REST 里却能读到 team 全部成员的正文。
 *
 * 判定规则（两条都满足才放行）：
 *   ① 名字本身在授权集合内（视图名与 scope 名共用命名空间，故一次比对即可）
 *   ② 若该名字是视图，则其**全部成员**也必须在授权集合内
 *      （全有或全无 —— 部分可见会让"给一个视图授权"变成"给它的成员授权"，
 *        视图就成了绕过成员授权的通道）
 *
 * 失败方向：`views.json` 读不出来时**按拒绝处理**（fail-closed）并告警到 stderr。
 * 不能降级成「当它不是视图」——那正好会让越权的成员展开静默通过。
 */

import fs from 'node:fs';
import { loadConfig, type KiConfig } from './config.js';
import { getViewsPath, readViews, type ViewConfig } from './scope-view.js';
import { ALL_SCOPES } from './mcp-token.js';
import { listAllScopes } from './scope.js';

/** 视图名 → 成员；`null` 表示「这个名字不是视图」（含 views.json 不可读的 fail-closed 情形） */
export type ViewMembersLookup = (name: string) => string[] | null;

export interface ScopeAccessOptions {
  /** 测试注入：绕开真实 views.json */
  viewMembers?: ViewMembersLookup;
  /** 复用调用方已加载的 config（避免每次 loadConfig 的 statSync） */
  config?: KiConfig;
}

/**
 * 视图表快照缓存：按 `(路径, mtimeMs, size)` 失效。
 *
 * 为什么这么设计（而不是"每次 readFileSync"或"固定 TTL"）：
 *   - 不做缓存：`scopeAllowed` 在列表端点里按行调用（任务列表最多 500 行），
 *     每行一次 `readFileSync + JSON.parse` 会把纯内存过滤变成磁盘热路径；
 *   - 固定 TTL（如 200ms）：在"管理员刚 `ki view add`、缓存还没过期"的窗口里，
 *     **授权判定用旧成员集、实际展开用新成员集**（少判一个成员）→ 构成越权窗口；
 *   - mtime+size 失效：每次只付一次 `statSync`，且只要文件真的变了就立刻重读，
 *     不引入人为时间窗口。文件损坏时**不写缓存**，修好后自动恢复。
 */
let viewsSnapshot: { path: string; mtimeMs: number; size: number; views: Record<string, ViewConfig> } | null = null;

function loadViewsCached(config: KiConfig): Record<string, ViewConfig> | null {
  const filePath = getViewsPath(config);
  let mtimeMs: number;
  let size: number;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    return null; // 文件不存在 = 没有任何视图，这是正常状态而非错误
  }
  if (viewsSnapshot && viewsSnapshot.path === filePath
    && viewsSnapshot.mtimeMs === mtimeMs && viewsSnapshot.size === size) {
    return viewsSnapshot.views;
  }
  const views = readViews(config); // 损坏时抛 ViewError，由调用方 fail-closed
  viewsSnapshot = { path: filePath, mtimeMs, size, views };
  return views;
}

/** 测试用：丢弃快照（隔离不同临时 config 目录） */
export function resetScopeAccessCache(): void {
  viewsSnapshot = null;
}

function readViewMembersFromDisk(config: KiConfig, name: string): string[] | null {
  let views: Record<string, ViewConfig> | null;
  try {
    views = loadViewsCached(config);
  } catch (err) {
    /*
     * views.json 读不出来：**无法证明它不是视图**。
     *
     * 但"全拒"会把整个应用锁死 —— 真实 scope 也会被当成"成员未知的视图"拒绝，
     * 而 403 文案统一为"无权访问该 scope"，运维根本看不出根因是 views.json 坏了。
     *
     * 关键事实：视图名与 scope 名**共用命名空间且唯一**（`validateViewName` 撞名即拒），
     * 且视图**不落盘**（没有 `dataDir/<视图名>/`）。所以"磁盘上/配置里存在的真实 scope"
     * 必然不是视图 —— 对它返回 null 是**事实判定**，不是降级放行。
     * 反过来，既不是已知 scope、又读不出视图表的名字，才按拒绝处理。
     */
    process.stderr.write(
      `[kisearch] 视图定义不可读，授权判定按拒绝处理：${(err as Error).message}\n`,
    );
    return isKnownScopeName(config, name) ? null : [];
  }
  if (!views) return null; // 没有任何视图定义
  return views[name]?.members ?? null;
}

/**
 * 该名字是否是**真实知识库**（配置里注册过，或磁盘上有 KB 目录）。
 *
 * 只在 views.json 损坏的异常路径上调用（一次 readdir），正常路径零成本。
 */
function isKnownScopeName(config: KiConfig, name: string): boolean {
  if (!name) return false;
  if (Object.prototype.hasOwnProperty.call(config.scopes, name)) return true;
  try {
    return listAllScopes().includes(name);
  } catch {
    return false;
  }
}

function resolveLookup(opts?: ScopeAccessOptions): ViewMembersLookup {
  if (opts?.viewMembers) return opts.viewMembers;
  const config = opts?.config;
  return (name) => readViewMembersFromDisk(config ?? loadConfig(), name);
}

/**
 * 名字通过授权、但作为视图还有哪些成员未授权。
 *
 * @returns `null` = 可以访问（不是视图，或成员全都被授权）；
 *          空数组 = 视图定义不可读 → 调用方应**拒绝**（fail-closed）；
 *          非空 = 缺失的成员清单（供日志与提示文案）。
 */
export function missingViewMembers(
  scopes: string[],
  scope: string,
  opts?: ScopeAccessOptions,
): string[] | null {
  if (scopes.includes(ALL_SCOPES)) return null;
  const members = resolveLookup(opts)(scope);
  if (!members) return null; // 不是视图
  if (members.length === 0) return []; // fail-closed 标记
  const missing = members.filter((m) => !scopes.includes(m));
  return missing.length > 0 ? missing : null;
}

/**
 * 单点 scope 访问判定（两条通道共用）。
 *
 * @param scopes 授权名字全集（`findTokenAuth` 已把 `viewGrants` 合并进来）
 */
export function isScopeAccessAllowed(
  scopes: string[],
  scope: string,
  opts?: ScopeAccessOptions,
): boolean {
  if (scopes.includes(ALL_SCOPES)) return true;
  if (!scopes.includes(scope)) return false;
  return missingViewMembers(scopes, scope, opts) === null;
}
