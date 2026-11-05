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
import crypto from 'node:crypto';
import { loadConfig, resolveScope, getScopeMode, type KiConfig } from './config.js';
import { ScopeError, validateScope, listAllScopes } from './scope.js';
// 方向是 scope-view → mcp-token（mcp-token 不反向依赖本模块，无环）：
// 改名后要把 Token 里按**旧名字**记录的授权换成 ID，否则旧数据改名即断授权。
import { listTokens, updateToken } from './mcp-token.js';

/**
 * ⚠ **不再是视图名的唯一校验规则**（D5 / §1.4 起视图名支持中文）。
 *
 * 保留导出仅为兼容既有引用；真正的判定见 `viewNameCharsetError()`。
 * `scope` 名仍然只用 ASCII（`scope.ts::validateScope`），两者**故意不对称**：
 * scope 名会落磁盘目录、进 shell 参数，视图不落盘。
 */
export const VIEW_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 保留名：这些字面量在别处已有确定含义，用作视图名会与既有语义打架。
 *  - `all`        token 通配符（mcp-token.ts），且能通过字符集校验
 *  - `default`    缺省 scope 回退
 *  - `__global__` 调度器「独占全部 scope」标记
 *  - `__root__`   根散文件保留键
 *  - `__proto__` / `prototype` / `constructor`
 *                 ★ 原型污染名：视图表是普通对象，`views['__proto__'] = {...}`
 *                 走的是 setter 而不是新增属性 —— 于是「创建成功」但 `views.json`
 *                 里根本没有它（`Object.keys` 也不含），表现为视图静默消失。
 *                 读取侧 `Object.hasOwn` 判断同样会漏判。直接在命名层挡住最省事。
 */
export const RESERVED_VIEW_NAMES: ReadonlySet<string> = new Set([
  'all',
  'default',
  '__global__',
  '__root__',
  '__proto__',
  'prototype',
  'constructor',
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

/**
 * 单个视图定义。
 *
 * ★ 落盘形状：`views` 仍是 `Record<视图名, ViewConfig>`（**按名做键**），
 *   `id` 存在值里。这与早期方案（按 ID 做键）不同，理由：
 *   - 按名做键时 `readViews()` 的签名与全部 8 处读路径（`scope.ts`、`view.ts`、
 *     `scope-policy.ts`、4 个 MCP 工具、`group.ts`…）零改动，回归面小一个数量级；
 *   - 按 ID 做键要额外维护「名字 → ID」索引，且 `--scope <名字>` 的解析要先查索引；
 *   - 改名只是一次原子写（删旧键 + 插新键，值里的 `id` 不动），不需要事务。
 *   D7 的诉求（**改名不影响 token 授权 / localStorage / 深链**）由 `id` 不变满足，
 *   与"键是什么"无关。
 */
export interface ViewConfig {
  /** 不可变标识（D7）。改名不动它；token 授权以它为锚 */
  id: string;
  /** 有序成员列表（顺序只影响展示，不影响检索排序） */
  members: string[];
  /** 创建者 userId（D6 / R-07）。旧视图缺失 = 无主，仅管理员可改 */
  createdBy?: string;
  /** ISO 8601 UTC。旧视图缺失 → **不伪造**，列表显示 `—`（§1.5 迁移第 4 条） */
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  /** 乐观锁计数（N7）：成员或名称每次变更 +1；旧视图缺失按 0 处理 */
  revision: number;
}

export interface ViewsFile {
  /** 1 = 003 时代（只有 members）；2 = 本需求（含 id / 审计字段 / revision） */
  version: 1 | 2;
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
 * 由名字派生稳定 ID —— **仅用于迁移 v1 旧视图**。
 *
 * ★ 派生后必须固化写回（`withViewsFile` 的 `needsMigration` 会强制写）：
 *   若每次读取都重新按名字算，用户改名后 hash 就变了，ID 等于没稳定。
 */
function deriveViewId(name: string): string {
  return `v_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

/** 新视图 ID：随机 8 位 hex，避让已有 ID */
function generateViewId(taken: Set<string>): string {
  for (let i = 0; i < 100; i += 1) {
    const id = `v_${crypto.randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
  // 兜底：4 字节撞 100 次的概率可忽略，但仍给一个更长且必然不同的
  return `v_${crypto.randomBytes(8).toString('hex')}`;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 读取全部视图定义，并**顺带给出「是否需要迁移写回」**。
 *
 * - 文件不存在 → 返回空表（不是错误：视图是可选能力）
 * - JSON 损坏 / 结构非法 → `VIEWS_CORRUPT` fail-loud，**不允许静默当成空表**
 *   （否则下一次写入会把用户定义整体覆盖掉）
 * - v1 条目缺 `id` / `revision` → 就地补齐（id 由名字派生）并把 `needsMigration` 置位，
 *   由 `withViewsFile` 强制写回，完成**一次性固化**（幂等：固化后再读不会重复派生）
 */
function readViewsDetailed(config: KiConfig): { views: Record<string, ViewConfig>; needsMigration: boolean } {
  const filePath = getViewsPath(config);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { views: {}, needsMigration: false };
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

  let needsMigration = (parsed as Partial<ViewsFile> | null)?.version !== 2;

  const out: Record<string, ViewConfig> = {};
  const usedIds = new Set<string>();

  for (const [name, cfg] of Object.entries(views as Record<string, unknown>)) {
    const raw = (cfg ?? {}) as Record<string, unknown>;
    const members = raw.members;
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string')) {
      throw new ViewError(
        'VIEWS_CORRUPT',
        `视图「${name}」的 members 必须是字符串数组：${filePath}`,
        name,
      );
    }

    let id = asOptionalString(raw.id);
    if (!id) {
      needsMigration = true;
      id = deriveViewId(name);
      // 派生 ID 撞车概率极低，但同一份文件里必须唯一
      let suffix = 1;
      while (usedIds.has(id)) id = `${deriveViewId(name)}_${suffix++}`;
    }
    usedIds.add(id);

    const rawRevision = raw.revision;
    const revision = typeof rawRevision === 'number' && Number.isFinite(rawRevision) && rawRevision >= 0
      ? Math.floor(rawRevision)
      : 0;
    if (rawRevision !== revision) needsMigration = true;

    const createdBy = asOptionalString(raw.createdBy);
    const createdAt = asOptionalString(raw.createdAt);
    const updatedBy = asOptionalString(raw.updatedBy);
    const updatedAt = asOptionalString(raw.updatedAt);

    out[name] = {
      id,
      members: [...(members as string[])],
      revision,
      ...(createdBy ? { createdBy } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedBy ? { updatedBy } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  return { views: out, needsMigration };
}

/**
 * 读取全部视图定义（对外 API，签名与 003 时代一致）。
 *
 * 迁移细节见 {@link readViewsDetailed}：调用本函数**不会**触发写回，
 * 固化只发生在 `withViewsFile` 内的读-改-写路径上。
 */
export function readViews(config: KiConfig): Record<string, ViewConfig> {
  return readViewsDetailed(config).views;
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
    version: 2,
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
    const { views, needsMigration } = readViewsDetailed(config);
    const before = JSON.stringify(views);
    const result = fn(views);
    // ★ needsMigration 时即使 fn 没改任何东西也要写回：v1 → v2 的 ID 固化靠这一次写
    if (needsMigration || JSON.stringify(views) !== before) atomicWriteViews(filePath, views);
    return result;
  });
}

/**
 * 创建视图。已存在则在**锁内**抛 `VIEW_NAME_CONFLICT`（防并发重复创建）。
 */
export function createView(
  config: KiConfig,
  name: string,
  members: string[],
  meta?: { createdBy?: string },
): void {
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
    const taken = new Set(Object.values(views).map((v) => v.id));
    const createdBy = asOptionalString(meta?.createdBy);
    views[name] = {
      id: generateViewId(taken),
      members: [...members],
      createdAt: new Date().toISOString(),
      revision: 0,
      ...(createdBy ? { createdBy } : {}),
    };
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
  meta?: { updatedBy?: string },
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
    const updatedBy = asOptionalString(meta?.updatedBy);
    // ★ 必须 `...entry` 展开：只写 members 会把 id / createdBy / createdAt 丢掉，
    //   下一次读时 id 被重新派生 → 改名与 token 授权锚点全部失效。
    views[name] = {
      ...entry,
      members: [...next],
      revision: entry.revision + 1,
      updatedAt: new Date().toISOString(),
      ...(updatedBy ? { updatedBy } : {}),
    };
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

/**
 * 改名（D7）：只换**键与展示名**，`id` 不变。
 *
 * 因此 token 的 `viewGrants`（存 ID）、前端 localStorage 选中态都不受影响；
 * 唯一代价是**旧名字的深链会失效**（要提示「视图可能已改名」，不能静默 404）。
 *
 * @throws VIEW_NOT_FOUND 旧名不存在 / VIEW_NAME_CONFLICT 新名撞其他视图或 scope
 */
export function renameView(
  config: KiConfig,
  oldName: string,
  newName: string,
  meta?: {
    updatedBy?: string;
    /**
     * Token 存储路径。**仅供测试隔离**：生产留空即用 `~/.ki/mcp-tokens.json`。
     * 不留这个口子的话，单测会去改写开发者真实目录下的 token 文件。
     */
    tokensPath?: string;
  },
): void {
  if (oldName === newName) return;
  validateViewName(config, newName);
  withViewsFile(config, (views) => {
    const entry = views[oldName];
    if (!entry) throw new ViewError('VIEW_NOT_FOUND', `视图「${oldName}」不存在`, oldName);
    if (Object.prototype.hasOwnProperty.call(views, newName)) {
      throw new ViewError(
        'VIEW_NAME_CONFLICT',
        `视图「${newName}」已存在，不能改成同名（视图名共用命名空间且唯一）`,
        newName,
      );
    }
    const updatedBy = asOptionalString(meta?.updatedBy);
    delete views[oldName];
    views[newName] = {
      ...entry,
      revision: entry.revision + 1,
      updatedAt: new Date().toISOString(),
      ...(updatedBy ? { updatedBy } : {}),
    };
  });

  // ★ views 锁已释放，再做 token 同步：避免在 views 临界区里嵌套 tokens 锁
  syncTokenGrantsOnRename(config, oldName, newName, meta?.tokensPath);
}

/**
 * 改名后把 Token 里**按旧名字**记录的授权迁到新名字 / 稳定 ID。
 *
 * 为什么需要：`viewGrants` 存 ID 是 D7 的目标，但**存量 token 里存的是名字**
 * （003 阶段写入）。不做这一步，旧数据一改名就静默失去视图。
 *
 * 迁移策略（渐进、不做一次性全量改写）：
 *   - `viewGrants` 命中旧名 → 换成该视图的 `id`（此后永久免疫改名）
 *   - `scopes` 命中旧名（历史兼容写法）→ 换成新名字
 *
 * 单条 Token 失败只告警不中断：改名本身已成功，不能因为一个坏记录回滚。
 */
function syncTokenGrantsOnRename(
  config: KiConfig,
  oldName: string,
  newName: string,
  tokensPath?: string,
): void {
  let tokens: ReturnType<typeof listTokens>;
  try {
    tokens = listTokens(tokensPath);
  } catch {
    return; // 没有 token 文件 / 不可读 → 无授权可同步
  }
  const id = getViewId(config, newName);
  for (const token of tokens) {
    const grants = Array.isArray(token.viewGrants) ? token.viewGrants : [];
    const scopes = Array.isArray(token.scopes) ? token.scopes : [];
    const grantsHit = grants.includes(oldName);
    const scopesHit = scopes.includes(oldName);
    if (!grantsHit && !scopesHit) continue;

    const patch: { viewGrants?: string[]; scopes?: string[] } = {};
    if (grantsHit) patch.viewGrants = grants.map((g) => (g === oldName ? id ?? newName : g));
    if (scopesHit) patch.scopes = scopes.map((s) => (s === oldName ? newName : s));

    try {
      updateToken(token.id, patch, tokensPath);
    } catch (err) {
      process.stderr.write(
        `[kisearch] 改名后同步 Token ${token.id} 的视图授权失败（需手动处理）：${(err as Error).message}\n`,
      );
    }
  }
}

/**
 * 按稳定 ID 反查视图名。
 *
 * token 的 `viewGrants` 存的是 **ID**（D7），判定可见性 / 分类展示时要换回名字。
 * 视图量级是「几十」以内，线性扫足够；不建索引以免索引与文件不同步。
 */
export function findViewNameById(config: KiConfig, id: string): string | null {
  if (!id) return null;
  for (const [name, cfg] of Object.entries(readViews(config))) {
    if (cfg.id === id) return name;
  }
  return null;
}

/** 取某视图的稳定 ID（不存在 → null） */
export function getViewId(config: KiConfig, name: string): string | null {
  return readViews(config)[name]?.id ?? null;
}

/**
 * 造一个「视图 ID → 当前名字」的解析器，供 `findTokenAuth(..., resolveViewName)` 注入。
 *
 * 语义：
 *   - 传入的是**已存在的视图 ID** → 返回它当前的名字（改名后自动跟随，D7 的核心）
 *   - 传入的是**名字**且该视图存在 → 原样返回（兼容 003 阶段按名字写入的存量授权）
 *   - 都匹配不上（指向已删视图 / 垃圾值）→ `null`，调用方会退回原值
 *
 * 快照语义：内部一次性读取 views，一次请求内不会因为文件变化而中途改变结果。
 */
export function makeViewNameResolver(config: KiConfig): (idOrName: string) => string | null {
  const views = readViews(config);
  const nameById = new Map(Object.entries(views).map(([name, def]) => [def.id, name]));
  return (idOrName) => {
    const byId = nameById.get(idOrName);
    if (byId) return byId;
    return Object.prototype.hasOwnProperty.call(views, idOrName) ? idOrName : null;
  };
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

/** 视图名长度上限（按 Unicode 码点计，一个汉字算 1） */
const VIEW_NAME_MAX_LENGTH = 40;

/**
 * 视图名里**必须拒绝**的 shell 元字符。
 *
 * 判据与"为什么禁逗号/空格"完全同源：这个名字会作为 `--scope` 的值被用户复制到
 * shell 里执行，也会被无引号插进提示文案（如 `ki view add <名字> <scope>`）。
 * 早先只禁了空白 / 逗号 / 斜杠，于是 `ki view create '$(id)'` 能成功创建，
 * 后续提示文案 `ki view add $(id) x` 被复制即触发命令替换。
 *
 * 名单取舍：`-` `.` `_` 与中文/字母数字保留（正常命名需要）；`$()` `` ` `` `;|&<>`
 * `'"` `*?!#~{}[]()^` 一律拒绝（视图名没有任何使用它们的理由）。
 */
// eslint-disable-next-line no-useless-escape
const SHELL_METACHARS = /[;|&$<>`'"(){}[\]*?!#~^]/;

/** 名字里所有非法字符的去重清单（供错误文案逐字指出） */
function illegalCharsOf(name: string): string[] {
  return Array.from(new Set(Array.from(name).filter(
    (c) => SHELL_METACHARS.test(c) || /[\s,，/\\]/.test(c),
  )));
}

/**
 * 视图名字符集校验（D5 / §1.4）：**支持中文**。
 *
 * 关键约束不在"能不能存"，而在这个名字会被当成 `--scope` 的值传出去：
 *   - 半角逗号是 `--scope a,b` 的分隔符 → 必禁；全角逗号一并禁（避免"看起来像分隔符"）
 *   - 空白 / `/` / `\` / `..` 是 shell 与路径语义 → 必禁
 *   - `$()` `` ` `` `;|&<>` 等 shell 元字符 → 必禁（会被复制执行的提示文案里出现）
 * scope 名本身的规则**没变**（仍 `^[a-zA-Z0-9_-]+$`，见 `scope.ts::validateScope`），
 * 所以"含非 ASCII 的名字一定是视图名"，不需要额外标记位。
 */
export function viewNameCharsetError(name: string): string | null {
  const length = [...name].length;
  if (length > VIEW_NAME_MAX_LENGTH) {
    return `视图名最多 ${VIEW_NAME_MAX_LENGTH} 个字符（当前 ${length} 个）`;
  }
  if (/[\s,，/\\]/.test(name)) {
    // 保留「指出具体非法字符」的能力：只说"不合法"用户还得自己找
    return '视图名不能包含空格、半角/全角逗号、斜杠（半角逗号是 --scope 的分隔符）'
      + `\n  非法字符：${illegalCharsOf(name).map((c) => JSON.stringify(c)).join(', ')}`;
  }
  if (name.includes('..')) return '视图名不能包含「..」';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '视图名不能包含控制字符';
  if (SHELL_METACHARS.test(name)) {
    /*
     * 只禁"会进 shell"这一小撮，别扩大到全 ASCII 标点：视图名在报错文案里会被
     * 直接抄进命令提示（`ki view add <name> <scope>`），含命令替换/管道/重定向
     * 字符就能在用户复制粘贴时执行本机命令。
     */
    return '视图名不能包含 shell 元字符（它会被复制到命令里执行）'
      + `\n  非法字符：${illegalCharsOf(name).map((c) => JSON.stringify(c)).join(', ')}`;
  }
  return null;
}

/**
 * 视图名合法性：字符集 → 保留名 → 与已有 scope 撞名。
 * @throws ViewError
 */
export function validateViewName(config: KiConfig, name: string): void {
  if (!name || typeof name !== 'string') {
    throw new ViewError('INVALID_VIEW_NAME', '视图名不能为空');
  }
  const charsetError = viewNameCharsetError(name);
  if (charsetError) {
    throw new ViewError('INVALID_VIEW_NAME', charsetError, name);
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
 * 把 `--scope` 原始值拆成段，并**只对不是视图名的段**做 scope 校验。
 *
 * ★ 为什么不直接复用 `parseScopes`：它对**每一段**都调 `validateScope`（ASCII-only），
 *   而视图名允许中文（D5 / §1.4）—— 直接复用会让 `--scope 团队研发` 在"是否视图"
 *   判断之前就被判成非法 scope，中文视图永远不可用。
 * ★ 安全不变量必须保住：**非视图段**照样逐个 `validateScope`，
 *   `--scope ../etc`、`--scope a/b` 依旧在解析层被拒。
 */
function splitTargetSegments(config: KiConfig, raw?: string): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.trim().length > 0 && parts.length === 0) {
    throw new ScopeError('EMPTY_SCOPE', `scope "${raw}" 解析为空：逗号分隔列表无有效段`);
  }
  const viewsMap = readViews(config);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!Object.prototype.hasOwnProperty.call(viewsMap, part)) validateScope(part);
    if (!seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  return out;
}

/**
 * 把 `--scope` 的原始值展开为真实 scope 列表。
 *
 * ★ 安全：**非视图段**逐个走 `validateScope`（见 {@link splitTargetSegments}）——
 *   `--scope ../etc` 在这里被拒。视图名豁免字符集校验（D5 允许中文），
 *   但豁免的前提是它确实是已注册视图。
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

  const parsed = splitTargetSegments(config, raw);
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

/**
 * 本次请求是否应按「视图」处理（分桶 / 合并 / 逐成员探测）。
 *
 * ★ 判据只能是「名字命中视图」，**不能**叠加 `scopes.length > 1`。
 *   单成员视图（`members: ['a']`，`ki view create solo --members a` 或 `view remove`
 *   后只剩一个）同样是视图请求；叠加成员数判断会把它落到「单库分支」，
 *   而单库分支用的是**原始 `--scope` 值（视图名）**去当 scope 名：
 *   `resolveScope(config,'solo')` 在 default 模式原样返回 'solo' →
 *   `getKbDir('solo')` / `relations-cache('solo')` 都不存在 →
 *   用户看到「scope 元数据不存在」「知识库尚未导入」甚至「tag 列表为空」，
 *   中文视图名还会先撞 `validateScope` 的 ASCII 校验（`INVALID_SCOPE`）。
 *
 * 单成员视图的分桶结果就是 1 个桶 —— 结构一致比省一层分支更重要：
 * 前端与 AI 调用方靠 `view` / `buckets` 字段判断"这是视图"，不该再猜成员数。
 */
export function isViewRequest(targets: ScopeTargets): boolean {
  return targets.views.length > 0;
}
