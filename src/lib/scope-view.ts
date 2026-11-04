/**
 * scope-view.ts —— 知识视图（view）的定义、校验、展开与落盘
 *
 * 视图 = 一个带名字的有序 scope 列表，**只在读路径上当 scope 用**。
 *
 * 三条铁律（设计 DESIGN.md §3）：
 *   ① 视图名与 scope 名共用同一命名空间且唯一 —— 否则 `--scope foo` 二义；
 *   ② 成员必须是真实 scope，不得是视图（含自身）—— 禁嵌套；
 *   ③ 展开只发生在 {@link resolveScopeTargets}，下游只认真实 scope。
 *      **视图名绝不允许进入 getKbDir / getScopeDataDir / getScopeCollectionPath**，
 *      否则会凭空建出 `dataDir/<视图名>/`。
 *
 * 存储：`views.json`，与 config 同目录（默认 `~/.ki/views.json`）。
 *   ⚠️ 刻意**不**写进 config.yaml：`config-schema.ts` 对未知字段是「错误」而非「告警」，
 *   写进配置后一旦回滚到不支持 views 的旧版本，`loadConfig` 会 fail-loud，
 *   整个 `ki` 的命令全部不可用（运维事故级）。独立文件对旧版本完全不可见。
 *
 * 安全不变量：{@link resolveScopeTargets} 复用 `parseScopes`，后者对**每个原始段**
 * 调用 `validateScope` —— 这是 `--scope ../etc` 被拒的唯一屏障，不得绕过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveScope, getScopeMode, type KiConfig } from './config.js';
import { parseScopes, validateScope, listAllScopes } from './scope.js';

/** 视图名合法字符：与 scope 完全一致（共用命名空间，字符集必须同源） */
export const VIEW_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 保留名：这些字面量在别处已有确定含义，用作视图名会与既有语义打架。
 *  - `all`        token 通配符（mcp-token.ts），且能通过字符集校验
 *  - `default`    缺省 scope 回退
 *  - `__global__` 调度器「独占全部 scope」标记
 *  - `__root__`   根散文件保留键
 */
export const RESERVED_VIEW_NAMES: ReadonlySet<string> = new Set([
  'all',
  'default',
  '__global__',
  '__root__',
]);

export type ViewErrorCode =
  | 'INVALID_VIEW_NAME'
  | 'RESERVED_VIEW_NAME'
  | 'VIEW_NAME_CONFLICT'
  | 'VIEW_NOT_FOUND'
  | 'VIEW_EMPTY'
  | 'VIEW_MEMBER_IS_VIEW'
  | 'VIEW_MEMBER_NOT_REGISTERED'
  | 'VIEWS_CORRUPT'
  | 'VIEWS_READ_FAILED'
  | 'VIEWS_WRITE_FAILED'
  | 'VIEWS_FILE_LOCKED';

export class ViewError extends Error {
  readonly code: ViewErrorCode;
  readonly view?: string;

  constructor(code: ViewErrorCode, message: string, view?: string) {
    super(message);
    this.name = 'ViewError';
    this.code = code;
    if (view !== undefined) this.view = view;
  }
}

/** 类型守卫：CLI / HTTP / MCP 各自按 code 映射出口 */
export function isViewError(err: unknown): err is ViewError {
  return err instanceof ViewError;
}

export interface ViewConfig {
  /** 有序成员列表（顺序只影响展示，不影响检索排序） */
  members: string[];
}

export interface ViewsFile {
  version: 1;
  views: Record<string, ViewConfig>;
  updatedAt: string;
}

/** {@link resolveScopeTargets} 的返回值 */
export interface ScopeTargets {
  /** 请求中出现过的视图名（保序去重）；空数组 = 纯 scope 请求 */
  views: string[];
  /** 展开后的真实 scope 列表（保序去重） */
  scopes: string[];
  /** 因 strict 白名单被跳过的成员/段（下游并入自己的 skipped 上报） */
  skipped: { scope: string; reason: string }[];
  /**
   * 原始请求是否是**多段**（逗号分隔 ≥2 段）。
   *
   * ★ 调用方判断"是否走多库响应结构"时必须用它，不能用 `scopes.length > 1`：
   *   strict 下 `--scope a,b` 可能只剩 1 个生效，但请求形态仍是多段，
   *   响应里依然要给 `scopes`（否则既有调用方读不到实际检索集合）。
   */
  multiRequested: boolean;
}

const VIEWS_LOCK_TIMEOUT_MS = 5_000;
const VIEWS_LOCK_STALE_MS = 30_000;

// ─── 路径 ────────────────────────────────────────────────

/**
 * views.json 位置：跟随 config 所在目录。
 *
 * 为什么跟着 config 而不是硬编码 `~/.ki`：
 *  - 默认 config 就在 `~/.ki/config.yaml`，两者结果相同；
 *  - `--config /tmp/x/config.yaml` 这类隔离（测试 / 多环境）时，
 *    硬编码会让读写落到真实 home，污染用户数据。
 */
export function getViewsPath(config: KiConfig): string {
  const configPath = config._configPath;
  if (configPath) return path.join(path.dirname(configPath), 'views.json');
  return path.join(os.homedir(), '.ki', 'views.json');
}

// ─── 读 ──────────────────────────────────────────────────

/**
 * 读取全部视图定义。
 *
 * - 文件不存在 → 返回 `{}`（不是错误：视图是可选能力）
 * - JSON 损坏 / 结构非法 → `VIEWS_CORRUPT` fail-loud，**不允许静默当成空表**
 *   （否则下一次写入会把用户定义整体覆盖掉）
 */
export function readViews(config: KiConfig): Record<string, ViewConfig> {
  const filePath = getViewsPath(config);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ViewError(
      'VIEWS_READ_FAILED',
      `读取视图文件失败：${filePath}\n  ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ViewError(
      'VIEWS_CORRUPT',
      `视图文件不是合法 JSON：${filePath}\n`
      + '  请修复该文件；或删除它后重建视图（不影响任何知识库及其文档）。',
    );
  }

  const views = (parsed as Partial<ViewsFile> | null)?.views;
  if (!views || typeof views !== 'object' || Array.isArray(views)) {
    throw new ViewError(
      'VIEWS_CORRUPT',
      `视图文件结构非法（缺少 views 对象）：${filePath}\n`
      + '  请修复该文件；或删除它后重建视图（不影响任何知识库及其文档）。',
    );
  }

  const out: Record<string, ViewConfig> = {};
  for (const [name, cfg] of Object.entries(views as Record<string, unknown>)) {
    const members = (cfg as { members?: unknown } | null)?.members;
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string')) {
      throw new ViewError(
        'VIEWS_CORRUPT',
        `视图「${name}」的 members 必须是字符串数组：${filePath}`,
        name,
      );
    }
    out[name] = { members: [...(members as string[])] };
  }
  return out;
}

// ─── 写 ──────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 视图读-改-写文件锁（与 mcp-token.ts::withTokensLock 同范式）。
 *
 * 为什么需要：`atomicWrite`（tmp + rename）只防「半写」，不防
 * 「两个进程各自读旧文件再各自覆盖」——并发 `ki view add` 会静默丢成员。
 */
function withViewsLock<T>(filePath: string, fn: () => T): T {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + VIEWS_LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, String(process.pid));
      } catch (writeError) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        fd = undefined;
        try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        throw writeError;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > VIEWS_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // 锁刚好被释放：重试即可
      }
      if (Date.now() >= deadline) {
        throw new ViewError(
          'VIEWS_FILE_LOCKED',
          `视图存储被占用（${lockPath}）。请稍后重试；若确认无进程操作，可删除该锁文件。`,
        );
      }
      sleepSync(10);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  }
}

/** 原子写：临时文件 + rename，沿用原文件权限（可能是 0600） */
function atomicWriteViews(filePath: string, views: Record<string, ViewConfig>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    // 新文件：用默认 0600
  }

  // 键排序：保证 diff 稳定，也让 `ki view list` 顺序可预期
  const sorted: Record<string, ViewConfig> = {};
  for (const key of Object.keys(views).sort()) sorted[key] = views[key];

  const payload: ViewsFile = {
    version: 1,
    views: sorted,
    updatedAt: new Date().toISOString(),
  };

  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode });
    try { fs.chmodSync(tmp, mode); } catch { /* 权限沿用失败不致命 */ }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new ViewError(
      'VIEWS_WRITE_FAILED',
      `写入视图文件失败：${filePath}\n  ${(err as Error).message}`,
    );
  }
}

/**
 * 视图文件的事务包装：**读-改-写全程持锁**。
 *
 * ★ 这是本模块唯一正确的改写入方式。任何「在锁外读到成员 → 算好新数组 →
 *   交给一个只做覆盖写的函数」的写法都会丢更新：并发 `ki view add` 时
 *   两个进程都基于同一份旧快照计算，后写的覆盖先写的。
 *   （本模块最初就是这样，被 test/scope-view.test.ts 的并发用例抓出来。）
 */
function withViewsFile<T>(config: KiConfig, fn: (views: Record<string, ViewConfig>) => T): T {
  const filePath = getViewsPath(config);
  return withViewsLock(filePath, () => {
    const views = readViews(config);
    const before = JSON.stringify(views);
    const result = fn(views);
    if (JSON.stringify(views) !== before) atomicWriteViews(filePath, views);
    return result;
  });
}

/**
 * 创建视图。已存在则在**锁内**抛 `VIEW_NAME_CONFLICT`（防并发重复创建）。
 */
export function createView(config: KiConfig, name: string, members: string[]): void {
  // 名字校验放在**函数内部**而不是只靠调用方：createView 是公开 API，
  // 将来新增入口（HTTP / MCP 工具）若忘了先调 validateViewName，
  // 非法名/保留名/与 scope 撞名就会直接落盘。这里做一次自校验，成本是一次正则。
  validateViewName(config, name);
  withViewsFile(config, (views) => {
    if (Object.prototype.hasOwnProperty.call(views, name)) {
      throw new ViewError(
        'VIEW_NAME_CONFLICT',
        `视图「${name}」已存在。改成员请用 ki view add/remove；如需重建请先 ki view delete ${name}`,
        name,
      );
    }
    validateViewMembers(config, members, name);
    views[name] = { members: [...members] };
  });
}

/**
 * 原子地改一个已存在视图的成员。
 *
 * @param updater 收到**锁内最新**成员，返回新数组；返回 `null` 表示删除该视图
 * @returns 改后的成员（删除时为 null）
 */
export function updateView(
  config: KiConfig,
  name: string,
  updater: (current: string[]) => string[] | null,
): string[] | null {
  return withViewsFile(config, (views) => {
    const entry = views[name];
    if (!entry) throw new ViewError('VIEW_NOT_FOUND', `视图「${name}」不存在`, name);
    const next = updater([...entry.members]);
    if (next === null) {
      delete views[name];
      return null;
    }
    validateViewMembers(config, next, name);
    views[name] = { members: [...next] };
    return [...next];
  });
}

/** 删除视图定义（不动任何知识库数据） */
export function deleteView(config: KiConfig, name: string): void {
  withViewsFile(config, (views) => {
    if (!Object.prototype.hasOwnProperty.call(views, name)) {
      throw new ViewError('VIEW_NOT_FOUND', `视图「${name}」不存在`, name);
    }
    delete views[name];
  });
}

// ─── 校验 ────────────────────────────────────────────────

/** 命名空间中已被占用的名字（磁盘上的 scope ∪ 配置里注册的 scope） */
function takenScopeNames(config: KiConfig): Set<string> {
  const names = new Set<string>(Object.keys(config.scopes));
  try {
    for (const s of listAllScopes()) names.add(s);
  } catch {
    // 枚举失败不影响字符集/保留名校验，只是少一层撞名保护
  }
  return names;
}

/**
 * 视图名合法性：字符集 → 保留名 → 与已有 scope 撞名。
 * @throws ViewError
 */
export function validateViewName(config: KiConfig, name: string): void {
  if (!name || typeof name !== 'string') {
    throw new ViewError('INVALID_VIEW_NAME', '视图名不能为空');
  }
  if (!VIEW_NAME_PATTERN.test(name)) {
    const illegal = Array.from(new Set(name.split('').filter((c) => !/[a-zA-Z0-9_-]/.test(c))));
    throw new ViewError(
      'INVALID_VIEW_NAME',
      `视图名 "${name}" 不合法：仅允许字母、数字、连字符(-)、下划线(_)`
        + (illegal.length > 0 ? `\n  非法字符：${illegal.map((c) => JSON.stringify(c)).join(', ')}` : ''),
      name,
    );
  }
  if (RESERVED_VIEW_NAMES.has(name)) {
    throw new ViewError(
      'RESERVED_VIEW_NAME',
      `视图名 "${name}" 是保留名（${[...RESERVED_VIEW_NAMES].join(' / ')}），不能使用`,
      name,
    );
  }
  if (takenScopeNames(config).has(name)) {
    throw new ViewError(
      'VIEW_NAME_CONFLICT',
      `视图名 "${name}" 与已存在的知识库（scope）重名。\n`
      + '  视图与知识库共用一个命名空间（否则 `--scope` 会有二义），请换一个名字。',
      name,
    );
  }
}

/**
 * 成员合法性：非空 → 逐项字符集 → 禁嵌套（含自身）→ strict 下必须已注册。
 *
 * @param selfName 创建/改名场景传目标视图名。
 *   ★ 必须显式排除自身：`ki view create team --members team` 时 `team` 尚未落盘，
 *     只判「是否是已存在视图」会放行，随后展开成 team→[team] 无限循环。
 * @throws ViewError
 */
export function validateViewMembers(
  config: KiConfig,
  members: string[],
  selfName?: string,
): void {
  if (!Array.isArray(members) || members.length === 0) {
    throw new ViewError('VIEW_EMPTY', '视图至少要有一个成员（知识库）', selfName);
  }

  const knownViews = new Set(Object.keys(readViews(config)));
  if (selfName) knownViews.add(selfName);

  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const raw of members) {
    const m = String(raw).trim();
    validateScope(m);
    if (knownViews.has(m)) {
      throw new ViewError(
        'VIEW_MEMBER_IS_VIEW',
        `「${m}」是一个视图，不能作为成员（不支持视图嵌套，也不支持引用自身）。\n`
        + '  成员必须是真实的知识库（scope）。',
        selfName,
      );
    }
    if (!seen.has(m)) {
      seen.add(m);
      dedup.push(m);
    }
  }

  if (getScopeMode(config) === 'strict') {
    const missing = dedup.filter((m) => !Object.prototype.hasOwnProperty.call(config.scopes, m));
    if (missing.length > 0) {
      const known = Object.keys(config.scopes);
      throw new ViewError(
        'VIEW_MEMBER_NOT_REGISTERED',
        `scopeMode=strict 下视图成员必须已在配置 scopes 中注册；未注册：${missing.join(', ')}\n`
        + `  已注册：${known.length ? known.join(', ') : '（无）'}`,
        selfName,
      );
    }
  }
}

// ─── 查询 ────────────────────────────────────────────────

export function listViewNames(config: KiConfig): string[] {
  return Object.keys(readViews(config)).sort();
}

export function isViewName(config: KiConfig, name: string): boolean {
  if (!name) return false;
  try {
    return Object.prototype.hasOwnProperty.call(readViews(config), name);
  } catch {
    // 视图文件损坏时按「不是视图」处理：否则任何配置抖动都会让所有写操作失败。
    // 残余风险可接受——视图名与 scope 名共用命名空间后，漏判会在下一跳
    // （ensureScopeDir 缺 group-index.json）fail-loud，不会静默产出可用数据。
    return false;
  }
}

/** 取成员；不存在抛 VIEW_NOT_FOUND，为空抛 VIEW_EMPTY */
export function getViewMembers(config: KiConfig, name: string): string[] {
  const views = readViews(config);
  const entry = views[name];
  if (!entry) throw new ViewError('VIEW_NOT_FOUND', `视图「${name}」不存在`, name);
  if (entry.members.length === 0) {
    throw new ViewError('VIEW_EMPTY', `视图「${name}」没有成员；请执行 ki view add ${name} <scope>`, name);
  }
  return [...entry.members];
}

// ─── 展开（唯一入口） ────────────────────────────────────

/**
 * 把 `--scope` 的原始值展开为真实 scope 列表。
 *
 * ★ 安全：全程复用 `parseScopes`（`src/lib/scope.ts`），它对**每个原始段**调
 *   `validateScope` —— `--scope ../etc` 在这里被拒。不要为省一次调用而内联拆分。
 *
 * 行为（设计 S-01 §3.3，与 S-02 D5 协调后：成员缺失不在本层判断）：
 *   - 空 / 未传      → `[resolveScope(config, undefined)]`（default 模式为 `default`）
 *   - 单段且非视图    → 完全沿用现状（strict 下未注册由 resolveScope 抛错）
 *   - 单段且是视图    → 展开成员；strict 下未注册成员进 skipped
 *   - 多段           → 逐段展开并合并去重；strict 下的未注册项进 skipped
 */
export function resolveScopeTargets(config: KiConfig, raw?: string): ScopeTargets {
  const views: string[] = [];
  const scopes: string[] = [];
  const skipped: { scope: string; reason: string }[] = [];

  const parsed = parseScopes(raw);
  const multi = parsed.length > 1;

  if (!multi) {
    // 单段（或空）：纯 scope 走既有路径，保证零回归
    const singleRaw = parsed.length === 1 ? parsed[0] : raw;
    const viewsMap = readViews(config);
    if (parsed.length === 1 && Object.prototype.hasOwnProperty.call(viewsMap, parsed[0])) {
      const name = parsed[0];
      const members = viewsMap[name].members;
      if (members.length === 0) {
        throw new ViewError('VIEW_EMPTY', `视图「${name}」没有成员；请执行 ki view add ${name} <scope>`, name);
      }
      views.push(name);
      const strict = getScopeMode(config) === 'strict';
      for (const m of members) {
        if (strict && !Object.prototype.hasOwnProperty.call(config.scopes, m)) {
          skipped.push({ scope: m, reason: `未注册（scopeMode=strict，视图 ${name} 的成员）` });
          continue;
        }
        scopes.push(m);
      }
      return { views, scopes, skipped, multiRequested: false };
    }

    const scope = resolveScope(config, singleRaw);
    validateScope(scope);
    return { views, scopes: [scope], skipped, multiRequested: false };
  }

  // 多段：合并展开
  const strict = getScopeMode(config) === 'strict';
  const viewsMap = readViews(config);
  const seenScope = new Set<string>();
  const pushScope = (s: string): void => {
    if (seenScope.has(s)) return;
    seenScope.add(s);
    scopes.push(s);
  };

  for (const seg of parsed) {
    if (Object.prototype.hasOwnProperty.call(viewsMap, seg)) {
      if (!views.includes(seg)) views.push(seg);
      const members = viewsMap[seg].members;
      if (members.length === 0) {
        throw new ViewError('VIEW_EMPTY', `视图「${seg}」没有成员；请执行 ki view add ${seg} <scope>`, seg);
      }
      for (const m of members) {
        if (strict && !Object.prototype.hasOwnProperty.call(config.scopes, m)) {
          skipped.push({ scope: m, reason: `未注册（scopeMode=strict，视图 ${seg} 的成员）` });
          continue;
        }
        pushScope(m);
      }
      continue;
    }
    if (strict && !Object.prototype.hasOwnProperty.call(config.scopes, seg)) {
      skipped.push({ scope: seg, reason: '未注册（scopeMode=strict，不在配置 scopes 白名单）' });
      continue;
    }
    pushScope(seg);
  }

  return { views, scopes, skipped, multiRequested: true };
}

// ─── 便捷入口（CLI 用） ──────────────────────────────────

/** 用当前配置执行展开；CLI 里省掉一次显式 loadConfig */
export function resolveTargets(raw?: string): ScopeTargets {
  return resolveScopeTargets(loadConfig(), raw);
}
