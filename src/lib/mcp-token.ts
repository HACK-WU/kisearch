/**
 * mcp-token.ts —— ki mcp HTTP 模式多 Token 存储 + scope 授权（RBAC）
 *
 * 从「单 Token 全局鉴权」升级为「多 Token + 每个 Token 绑定授权 scope 集合」：
 *   - 每个 Token 记录含短 ID、Token 明文、授权 scope 集合、创建时间
 *   - scope 集合：单个 / 多个（逗号分隔）/ 'all'（全部）
 *   - 鉴权时按 Token 明文查找记录，得到授权 scope 集合，再校验请求的 scope
 *
 * 存储：~/.ki/mcp-tokens.json（JSON 数组，0600 仅属主可读写）。
 * 安全约定：Token 明文仅落盘于该文件；list 命令按需回显明文（用户明确要求的决策）。
 *
 * 与旧版（~/.ki/mcp-token 单行文本 + generate/show/reset）不兼容，直接替换。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  findUserById,
  getUsersPath,
  isUserActive,
  listUsers,
  type UserRecord,
} from './user-store.js';

/** 多 Token 存储文件路径：~/.ki/mcp-tokens.json（与 HTTP lock 同目录） */
export function getTokensPath(): string {
  return path.join(os.homedir(), '.ki', 'mcp-tokens.json');
}

/** 本机免登录管理员的虚拟 owner id（没有 users.json 记录时使用） */
export const LOCAL_ADMIN_OWNER_ID = 'local-admin';

export type TokenCreator = 'self' | 'admin' | 'cli';

/** 单条 Token 记录 */
export interface TokenRecord {
  /** 短 ID（8 位 base62，无易混淆字符），唯一标识，供 update/delete 使用 */
  id: string;
  /** Token 明文（32 字节熵，base64url） */
  token: string;
  /** 展示名称；旧记录缺省时按 `Token <id>` 兜底 */
  label?: string;
  /** 归属账号 id；旧记录缺省 = 未归属（仍有效，不计入任何人的上限） */
  ownerId?: string;
  /** 创建来源；旧记录缺省按 CLI 兜底 */
  createdBy?: TokenCreator;
  /** 授权 scope 集合：['all'] 表示全部；否则为具体 scope 列表 */
  scopes: string[];
  /** 创建时间（ISO） */
  createdAt: string;
  /**
   * 是否只读（动作维度，与 scopes 的「数据维度」正交）。
   *
   * - 缺省 / `false`：读写（全量 13 个 MCP 工具）
   * - `true`：只读（只注册并只允许 5 个读工具，见 `mcp-tools/tool-access.ts`）
   *
   * ★ 兼容与兜底：旧记录无此字段 ⇒ 视为读写（无需迁移）；
   *   字段值非法（`"true"` / `1` / `null`）⇒ **同样视为读写**，只有严格 `=== true` 才只读。
   *   理由：fail-closed（非法即只读）会把用户彻底锁死，且 Token 本身仍受 scopes 约束；
   *   代价是该限制可能静默失效，故 `ki mcp token list` 必须对非法值显式告警。
   */
  readOnly?: boolean;
}

/** 会话级访问授权：scope 集合 + 动作模式（供 MCP 会话装配工具集） */
export interface TokenAuth {
  /** Token 短 ID（供拒绝文案定位到具体 Token；进程级临时 Token 无 id） */
  id?: string;
  /** 授权 scope 集合（['all'] 或具体列表） */
  scopes: string[];
  /** 是否只读 */
  readOnly: boolean;
}

/** scope 合法字符正则（对齐 scope.ts::validateScope：字母数字连字符下划线） */
const SCOPE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 'all' 保留字：表示授权全部 scope */
export const ALL_SCOPES = 'all';

/**
 * 判断 scope 是否在授权集合内。
 * @param authScopes 授权 scope 集合；null 表示免鉴权（不限）；['all'] 表示全部
 */
export function isScopeAuthorized(authScopes: string[] | null, scope: string): boolean {
  if (authScopes === null) return true;
  return authScopes.includes(ALL_SCOPES) || authScopes.includes(scope);
}

const TOKENS_LOCK_TIMEOUT_MS = 5_000;
const TOKENS_LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Token 读-改-写文件锁（与 users.json 同思路）。
 * 原子 rename 只能防半写，不能防两个进程同时读旧文件再各自覆盖；
 * 创建/更新/删除/按 owner 清理必须串行。纯读路径不拿锁。
 */
function withTokensLock<T>(filePath: string, fn: () => T): T {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + TOKENS_LOCK_TIMEOUT_MS;
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
        if (Date.now() - stat.mtimeMs > TOKENS_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // 锁刚好被释放：重试即可
      }
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(`Token 存储被占用（${lockPath}）。请稍后重试；若确认无进程操作，可删除该锁文件。`),
          { code: 'MCP_TOKEN_LOCKED' },
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

/** 短 ID 字母表（去除易混淆字符 0/O/1/l/I） */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 生成密码学强随机 Token（32 字节熵，base64url，约 43 字符） */
export function generateTokenValue(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 生成 8 位短 ID（随机，唯一性由 createToken 循环保证） */
export function generateShortId(): string {
  const bytes = crypto.randomBytes(8);
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return id;
}

/**
 * 解析 scope 参数为 scope 集合。
 * 支持：'all' → ['all']；'a,b' → ['a','b']；'a' → ['a']。
 * 含 'all' 时归一化为 ['all']（all 已覆盖全部，冗余值忽略）。
 * @throws Error scope 为空或含非法字符时
 */
export function resolveScopesArg(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('必须指定 scope（单个 / 多个逗号分隔 / all 表示全部）');
  }
  if (parts.includes(ALL_SCOPES)) {
    return [ALL_SCOPES];
  }
  for (const p of parts) {
    if (!SCOPE_PATTERN.test(p)) {
      throw new Error(
        `scope "${p}" 不合法：仅允许字母、数字、连字符(-)、下划线(_)`,
      );
    }
  }
  return parts;
}

/** 读取结果：records + corrupt（区分「文件不存在」与「文件存在但损坏」，避免损坏文件被静默覆盖） */
function loadTokensRecords(filePath: string): { records: TokenRecord[]; corrupt: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // 文件不存在 → 合法空；其他读取错误（权限等）→ 视为损坏
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { records: [], corrupt: false }
      : { records: [], corrupt: true };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { records: [], corrupt: false };
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return { records: [], corrupt: true };
    const records = parsed.filter(
      (r): r is TokenRecord =>
        !!r && typeof r.id === 'string' && typeof r.token === 'string' &&
        Array.isArray(r.scopes) && typeof r.createdAt === 'string',
    );
    return { records, corrupt: false };
  } catch {
    return { records: [], corrupt: true };
  }
}

/**
 * 读取全部 Token 记录（宽松版）：文件不存在返回 []；损坏返回 []。
 * 供鉴权路径（findTokenScopes/tokenCount）使用：损坏时 fail-closed，所有 Token 失效但不崩溃。
 */
export function listTokens(filePath = getTokensPath()): TokenRecord[] {
  return loadTokensRecords(filePath).records;
}

/**
 * 严格读取：文件损坏时抛错（code: MCP_TOKEN_CORRUPT）。
 * 供 CLI list 命令与所有写操作（create/update/delete）使用，防止损坏文件被静默覆盖导致数据丢失。
 */
export function listTokensStrict(filePath = getTokensPath()): TokenRecord[] {
  const { records, corrupt } = loadTokensRecords(filePath);
  if (corrupt) {
    throw Object.assign(
      new Error(
        `Token 存储文件损坏或无法解析（${filePath}）。已拒绝操作以防丢失现有记录，请人工检查该文件。`,
      ),
      { code: 'MCP_TOKEN_CORRUPT' },
    );
  }
  return records;
}

/** 展示名：旧记录无 label 时按短 ID 兜底 */
export function tokenLabel(record: TokenRecord): string {
  if (typeof record.label === 'string' && record.label.trim()) return record.label.trim();
  return `Token ${record.id}`;
}

/** 创建来源：旧记录视为 CLI（历史 Token 均由 CLI 生成） */
export function tokenCreator(record: TokenRecord): TokenCreator {
  return record.createdBy === 'self' || record.createdBy === 'admin' || record.createdBy === 'cli'
    ? record.createdBy
    : 'cli';
}

/** 某个账号名下的 Token（旧记录无 ownerId，不归属任何人） */
export function listTokensByOwner(ownerId: string, filePath = getTokensPath()): TokenRecord[] {
  return listTokens(filePath).filter((record) => record.ownerId === ownerId);
}

export function countTokensByOwner(ownerId: string, filePath = getTokensPath()): number {
  return listTokensByOwner(ownerId, filePath).length;
}

/** 删除某账号名下的全部 Token（删除账号时清理）；返回删除数量 */
export function deleteTokensByOwner(ownerId: string, filePath = getTokensPath()): number {
  return withTokensLock(filePath, () => {
    const records = listTokensStrict(filePath);
    const kept = records.filter((record) => record.ownerId !== ownerId);
    const removed = records.length - kept.length;
    if (removed > 0) writeTokens(kept, filePath);
    return removed;
  });
}

/**
 * CLI 创建 Token 的默认归属：users.json 中唯一的管理员；没有管理员记录时归本机管理员。
 * 优先选启用中的 admin；若仅有禁用/过期 admin，则仍取该记录（Token 会随 owner 失效）。
 */
export function resolveDefaultCliTokenOwner(usersPath = getUsersPath()): string {
  try {
    const admins = listUsers(usersPath).filter((user) => user.role === 'admin');
    const active = admins.find((user) => isUserActive(user));
    const chosen = active ?? admins[0];
    return chosen ? chosen.id : LOCAL_ADMIN_OWNER_ID;
  } catch {
    return LOCAL_ADMIN_OWNER_ID;
  }
}

/**
 * 把 ownerless 旧 Token 显式迁移到指定 owner。
 * - tokenId 为空：迁移全部无归属 Token；否则只迁移指定 id
 * - Token 已归属或不存在 → fail-loud
 * - 不会自动在读取/启动路径调用；只由 `ki mcp token adopt` 触发
 */
export function adoptOwnerlessTokens(
  ownerId: string,
  tokenId?: string,
  filePath = getTokensPath(),
): TokenRecord[] {
  if (!ownerId) throw new Error('adopt 需要指定 owner');
  return withTokensLock(filePath, () => {
    const records = listTokensStrict(filePath);
    let targets: TokenRecord[];
    if (tokenId) {
      const target = records.find((record) => record.id === tokenId);
      if (!target) {
        throw Object.assign(new Error(`Token 不存在（id: ${tokenId}）。`), { code: 'TOKEN_NOT_FOUND' });
      }
      if (target.ownerId) {
        throw Object.assign(new Error(`Token 已归属账号 ${target.ownerId}，无需迁移。`), {
          code: 'TOKEN_ALREADY_OWNED',
        });
      }
      targets = [target];
    } else {
      targets = records.filter((record) => !record.ownerId);
    }
    for (const target of targets) target.ownerId = ownerId;
    if (targets.length > 0) writeTokens(records, filePath);
    return targets;
  });
}

/** Token 的有效授权：owner 缺失按旧记录；owner 禁用/过期 → 失效；owner 为 viewer → 强制只读 */
function effectiveTokenAuth(
  record: TokenRecord,
  usersPath: string,
): { readOnly: boolean; owner?: UserRecord } | undefined {
  if (!record.ownerId) return { readOnly: record.readOnly === true };
  if (record.ownerId === LOCAL_ADMIN_OWNER_ID) return { readOnly: record.readOnly === true };
  let owner: UserRecord | undefined;
  try {
    owner = findUserById(record.ownerId, usersPath);
  } catch {
    return undefined;
  }
  if (!owner || !isUserActive(owner)) return undefined;
  return {
    owner,
    readOnly: record.readOnly === true || owner.role === 'viewer',
  };
}

/**
 * 原子写回全部 Token 记录（0600，目录 0700）。
 * 先写同目录临时文件（0600），再 rename 覆盖目标：rename 在同目录内原子，
 * 避免进程中途崩溃留下「半写损坏文件」（结合 listTokensStrict 的损坏保护，杜绝损坏静默扩散）。
 * 注：原子写消除半写损坏；但「读-改-写」并发丢更新（后写覆盖先写）仍需文件锁才能根治，
 *      token 管理为低频运维操作，暂不引入锁，见 AGENTS.md「已知边界」。
 */
function writeTokens(records: TokenRecord[], filePath = getTokensPath()): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.mcp-tokens.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    // 临时文件一定是新建，mode 0600 必然生效；rename 后目标继承临时文件权限
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // 清理残留临时文件，避免目录堆积
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
    throw err;
  }
}

/**
 * 生成并持久化一条 Token 记录。
 * @param scopes 授权 scope 集合（已归一化，含 'all' 或具体 scope 列表）
 * @param filePath 存储文件（缺省 ~/.ki/mcp-tokens.json；单测注入临时路径）
 * @param readOnly 是否只读（缺省 false = 读写）
 * @returns 完整记录（含 id + token 明文）
 */
export interface CreateTokenMeta {
  label?: string;
  ownerId?: string;
  createdBy?: TokenCreator;
}

export function createToken(
  scopes: string[],
  filePath = getTokensPath(),
  readOnly = false,
  meta: CreateTokenMeta = {},
): TokenRecord {
  return withTokensLock(filePath, () => {
    // 严格读取：文件损坏时拒绝覆盖写回（否则会永久丢失全部现有记录）
    const records = listTokensStrict(filePath);
    const existingIds = new Set(records.map((r) => r.id));
    let id = generateShortId();
    while (existingIds.has(id)) id = generateShortId();
    const record: TokenRecord = {
      id,
      token: generateTokenValue(),
      scopes,
      createdAt: new Date().toISOString(),
      // 仅只读时落字段：读写保持旧格式（旧版本读到无此字段同样按读写处理）
      ...(readOnly ? { readOnly: true } : {}),
      ...(meta.label?.trim() ? { label: meta.label.trim() } : {}),
      ...(meta.ownerId ? { ownerId: meta.ownerId } : {}),
      ...(meta.createdBy ? { createdBy: meta.createdBy } : {}),
    };
    records.push(record);
    writeTokens(records, filePath);
    return record;
  });
}

export interface CreateOwnedTokenInput {
  scopes: string[];
  label: string;
  ownerId: string;
  createdBy: TokenCreator;
  readOnly: boolean;
  /** 普通账号上限；管理员传 Infinity */
  maxTokens: number;
}

/**
 * 原子创建「归属账号」的 Token：重名/上限判断与写入必须在同一把锁内。
 * 如果先把 cap 检查放在锁外，两个并发请求可同时通过 9/10 的检查。
 */
export function createOwnedToken(
  input: CreateOwnedTokenInput,
  filePath = getTokensPath(),
): TokenRecord {
  const label = input.label.trim();
  if (!label || label.length > 64) {
    throw Object.assign(new Error('Token 名称长度需为 1-64 个字符'), { code: 'TOKEN_INVALID' });
  }
  return withTokensLock(filePath, () => {
    const records = listTokensStrict(filePath);
    const owned = records.filter((record) => record.ownerId === input.ownerId);
    if (owned.some((record) => tokenLabel(record).toLowerCase() === label.toLowerCase())) {
      throw Object.assign(new Error('该账号下已存在同名 Token'), { code: 'TOKEN_LABEL_EXISTS' });
    }
    if (owned.length >= input.maxTokens) {
      throw Object.assign(new Error(`已达 Token 上限（${input.maxTokens}）`), { code: 'TOKEN_LIMIT_REACHED' });
    }
    const existingIds = new Set(records.map((record) => record.id));
    let id = generateShortId();
    while (existingIds.has(id)) id = generateShortId();
    const record: TokenRecord = {
      id,
      token: generateTokenValue(),
      label,
      ownerId: input.ownerId,
      createdBy: input.createdBy,
      scopes: input.scopes,
      createdAt: new Date().toISOString(),
      ...(input.readOnly ? { readOnly: true } : {}),
    };
    records.push(record);
    writeTokens(records, filePath);
    return record;
  });
}

/**
 * 按短 ID 局部更新：可只改 scopes、只改 readOnly，或两者同改。
 *
 * ★ 为什么需要它：`updateTokenScopes` 强制传 scopes，用户只想把某个 Token 切成只读时
 *   必须复述一遍 scope，极易顺手改错授权范围（放宽或收窄权限）。
 * @throws Error（code: TOKEN_NOT_FOUND）id 不存在；`MCP_TOKEN_UPDATE_NOTHING_TO_DO` 两项都没给
 */
export function updateToken(
  id: string,
  patch: { scopes?: string[]; readOnly?: boolean },
  filePath = getTokensPath(),
): TokenRecord {
  if (patch.scopes === undefined && patch.readOnly === undefined) {
    throw Object.assign(
      new Error('update 至少需要一项变更：--scope <...> 或 --read-only/--read-write。'),
      { code: 'MCP_TOKEN_UPDATE_NOTHING_TO_DO' },
    );
  }
  return withTokensLock(filePath, () => {
    const records = listTokensStrict(filePath);
    const target = records.find((r) => r.id === id);
    if (!target) {
      throw Object.assign(new Error(`Token 不存在（id: ${id}）。请用 ki mcp token list 查看有效 id。`), {
        code: 'TOKEN_NOT_FOUND',
      });
    }
    if (patch.scopes !== undefined) target.scopes = patch.scopes;
    if (patch.readOnly !== undefined) {
      // 切回读写时删除字段（不写 false），保持文件格式与旧版一致
      if (patch.readOnly) target.readOnly = true;
      else delete target.readOnly;
    }
    writeTokens(records, filePath);
    return target;
  });
}

/**
 * 按短 ID 更新授权 scope 集合（仅 scope，保留只读标记）。
 * @throws Error（code: TOKEN_NOT_FOUND）id 不存在时
 */
export function updateTokenScopes(
  id: string,
  scopes: string[],
  filePath = getTokensPath(),
): TokenRecord {
  return updateToken(id, { scopes }, filePath);
}

/**
 * 按短 ID 删除 Token。
 * @throws Error（code: TOKEN_NOT_FOUND）id 不存在时
 */
export function deleteToken(id: string, filePath = getTokensPath()): void {
  withTokensLock(filePath, () => {
    const records = listTokensStrict(filePath);
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw Object.assign(new Error(`Token 不存在（id: ${id}）。请用 ki mcp token list 查看有效 id。`), {
        code: 'TOKEN_NOT_FOUND',
      });
    }
    records.splice(idx, 1);
    writeTokens(records, filePath);
  });
}

/**
 * 按 Token 明文查找记录。
 * 遍历所有记录做常量时间比较（timingSafeEqual），避免时序侧信道泄露匹配位置。
 */
function findTokenRecord(tokenValue: string, filePath: string): TokenRecord | undefined {
  const records = listTokens(filePath);
  const provided = Buffer.from(tokenValue);
  for (const r of records) {
    const expected = Buffer.from(r.token);
    if (provided.length !== expected.length) continue;
    if (crypto.timingSafeEqual(provided, expected)) {
      return r;
    }
  }
  return undefined;
}

/**
 * 鉴权查询：按 Token 明文查找授权 scope 集合。
 * @returns 命中记录的 scopes；未命中返回 undefined
 */
export function findTokenScopes(
  tokenValue: string,
  filePath = getTokensPath(),
  usersPath = getUsersPath(),
): string[] | undefined {
  return findTokenAuth(tokenValue, filePath, usersPath)?.scopes;
}

/**
 * 鉴权查询（完整授权）：scope 集合 + 动作模式，供 MCP 会话装配工具集与 tools/call 拦截。
 *
 * 只读判定为**严格** `readOnly === true`：字段缺失或类型非法（`"true"` / `1` / `null`）一律按读写，
 * 避免手改/迁移中断把用户彻底锁死；非法值由 `ki mcp token list` 显式告警。
 * @returns 命中返回 { scopes, readOnly }；未命中返回 undefined
 */
export function findTokenAuth(
  tokenValue: string,
  filePath = getTokensPath(),
  usersPath = getUsersPath(),
): TokenAuth | undefined {
  const record = findTokenRecord(tokenValue, filePath);
  if (!record) return undefined;
  const effective = effectiveTokenAuth(record, usersPath);
  if (!effective) return undefined;
  return { id: record.id, scopes: record.scopes, readOnly: effective.readOnly };
}

/** `readOnly` 字段是否非法（存在但不是布尔）——供 list 命令告警，undefined 属正常（缺省读写） */
export function isReadOnlyFieldInvalid(record: TokenRecord): boolean {
  const value: unknown = (record as { readOnly?: unknown }).readOnly;
  return value !== undefined && typeof value !== 'boolean';
}

/** 查询 Token 记录数量（供 `ki mcp status` 诊断输出，不含明文） */
export function tokenCount(filePath = getTokensPath()): number {
  return listTokens(filePath).length;
}
