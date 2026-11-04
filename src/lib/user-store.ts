/**
 * user-store.ts —— Web 账号存储（REQ-20261103-001 · S-01）
 *
 * 设计要点：
 * - 独立于 MCP Token：`~/.ki/users.json`（0600），密码 scrypt，不落明文；
 * - 原子写 + 同目录锁，CLI 与 daemon 并发读写不互相覆盖；
 * - 鉴权路径每次重读（调用方不要在本模块外加 mtime+size 缓存），
 *   禁用/改角色/改密在下一请求立即生效；
 * - 文件损坏 fail-loud（USER_STORE_CORRUPT），不静默当“无账号”；
 * - 删除/降级/禁用最后一个启用中的 admin → USER_LAST_ADMIN。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type Role = 'admin' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];

export interface UserRecord {
  id: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  role: Role;
  disabled?: boolean;
  /** 账号到期时间（ISO）；缺省 = 永久 */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  passwordUpdatedAt: string;
  lastLoginAt?: string;
}

export interface UserStoreFile {
  version: 1;
  users: UserRecord[];
}

/** 对外视图：绝不包含 passwordHash */
export interface UserView {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  /** null = 永久 */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  passwordUpdatedAt: string;
  lastLoginAt?: string;
}

export interface UserStoreStatus {
  exists: boolean;
  corrupt: boolean;
  total: number;
  enabled: number;
  admins: number;
  enabledAdmins: number;
}

export type UserStoreErrorCode =
  | 'USER_EXISTS'
  | 'USER_NOT_FOUND'
  | 'USER_INVALID_ROLE'
  | 'USER_INVALID_USERNAME'
  | 'USER_INVALID_EXPIRY'
  | 'USER_PASSWORD_REQUIRED'
  | 'USER_PASSWORD_TOO_WEAK'
  | 'USER_LAST_ADMIN'
  | 'USER_ADMIN_EXISTS'
  | 'USER_ADMIN_PROTECTED'
  | 'USER_SELF_PROTECTED'
  | 'USER_STORE_CORRUPT'
  | 'USER_STORE_LOCKED'
  | 'USER_CONFIRM_REQUIRED';

export class UserStoreError extends Error {
  readonly code: UserStoreErrorCode;

  constructor(code: UserStoreErrorCode, message: string) {
    super(message);
    this.name = 'UserStoreError';
    this.code = code;
  }
}

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 默认账号文件：~/.ki/users.json（与 MCP Token 同目录，但独立文件） */
export function getUsersPath(): string {
  return path.join(os.homedir(), '.ki', 'users.json');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function corrupt(filePath: string, detail?: string): UserStoreError {
  return new UserStoreError(
    'USER_STORE_CORRUPT',
    `账号文件损坏或无法解析（${filePath}）${detail ? `：${detail}` : ''}。已拒绝覆盖，请人工检查该文件。`,
  );
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function withUsersLock<T>(filePath: string, fn: () => T): T {
  ensureParent(filePath);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
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
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock 刚好被释放：重试即可
      }
      if (Date.now() >= deadline) {
        throw new UserStoreError(
          'USER_STORE_LOCKED',
          `账号文件被占用（${lockPath}），请稍后重试；若确认无进程在使用，可删除该 lock 文件。`,
        );
      }
      sleepSync(50);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 关闭失败不阻断 */
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* 清理失败不阻断 */
    }
  }
}

function validateUsername(username: string): { username: string; usernameLower: string } {
  const value = username.trim();
  if (!USERNAME_RE.test(value)) {
    throw new UserStoreError(
      'USER_INVALID_USERNAME',
      '用户名不合法：仅允许字母、数字、点、连字符、下划线，长度 1-64',
    );
  }
  return { username: value, usernameLower: value.toLowerCase() };
}

function validatePassword(password: string): string {
  if (!password) {
    throw new UserStoreError('USER_PASSWORD_REQUIRED', '必须提供密码');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new UserStoreError(
      'USER_PASSWORD_TOO_WEAK',
      `密码长度必须为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`,
    );
  }
  return password;
}

function assertRole(role: string): Role {
  if (!ROLES.includes(role as Role)) {
    throw new UserStoreError('USER_INVALID_ROLE', `角色不合法：${role}（可选 admin/editor/viewer）`);
  }
  return role as Role;
}

export function hashPassword(password: string): string {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/**
 * 供登录路径使用：用户不存在时也跑一次 scrypt，避免用响应时间枚举账号。
 * 固定 dummy hash 在模块加载时生成一次。
 */
export const DUMMY_PASSWORD_HASH = hashPassword('ki-dummy-password-not-real');

function generateUserId(existing: Set<string>): string {
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    if (!existing.has(id)) return id;
  }
}

/** 账号是否已过期（缺省 = 永久） */
export function isUserExpired(user: Pick<UserRecord | UserView, 'expiresAt'>, now = Date.now()): boolean {
  if (!user.expiresAt) return false;
  const at = Date.parse(user.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** 账号是否可登录/可作为 Token owner（启用且未过期） */
export function isUserActive(
  user: Pick<UserRecord | UserView, 'disabled' | 'expiresAt'>,
  now = Date.now(),
): boolean {
  return user.disabled !== true && !isUserExpired(user, now);
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new UserStoreError('USER_INVALID_EXPIRY', '账号有效期必须是 ISO 时间字符串或留空');
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new UserStoreError('USER_INVALID_EXPIRY', '账号有效期不是合法时间');
  }
  return new Date(at).toISOString();
}

function toView(record: UserRecord): UserView {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    disabled: record.disabled === true,
    expiresAt: record.expiresAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    passwordUpdatedAt: record.passwordUpdatedAt,
    ...(record.lastLoginAt ? { lastLoginAt: record.lastLoginAt } : {}),
  };
}

function parseStore(raw: string, filePath: string): UserStoreFile {
  if (!raw.trim()) return { version: 1, users: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw corrupt(filePath, (err as Error).message);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { users?: unknown }).users)) {
    throw corrupt(filePath, '缺少 users 数组');
  }
  const users: UserRecord[] = [];
  const seenNames = new Set<string>();
  for (const item of (parsed as { users: unknown[] }).users) {
    if (!item || typeof item !== 'object') throw corrupt(filePath, '用户条目不是对象');
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) throw corrupt(filePath, '用户 id 缺失');
    if (typeof r.username !== 'string' || typeof r.usernameLower !== 'string') {
      throw corrupt(filePath, `用户 ${r.id} 缺少用户名`);
    }
    if (typeof r.passwordHash !== 'string' || !r.passwordHash.startsWith('scrypt$')) {
      throw corrupt(filePath, `用户 ${r.username} 的密码哈希非法`);
    }
    if (!ROLES.includes(r.role as Role)) throw corrupt(filePath, `用户 ${r.username} 的角色非法`);
    if (r.disabled !== undefined && typeof r.disabled !== 'boolean') {
      throw corrupt(filePath, `用户 ${r.username} 的 disabled 字段非法`);
    }
    let expiresAt: string | undefined;
    if (r.expiresAt !== undefined && r.expiresAt !== null && r.expiresAt !== '') {
      if (typeof r.expiresAt !== 'string' || !Number.isFinite(Date.parse(r.expiresAt))) {
        throw corrupt(filePath, `用户 ${r.username} 的 expiresAt 字段非法`);
      }
      expiresAt = new Date(Date.parse(r.expiresAt)).toISOString();
    }
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : '';
    const updatedAt = typeof r.updatedAt === 'string' ? r.updatedAt : createdAt;
    const passwordUpdatedAt = typeof r.passwordUpdatedAt === 'string' ? r.passwordUpdatedAt : updatedAt;
    if (!createdAt) throw corrupt(filePath, `用户 ${r.username} 缺少 createdAt`);
    const lower = String(r.usernameLower).toLowerCase();
    if (seenNames.has(lower)) throw corrupt(filePath, `用户名重复：${r.usernameLower}`);
    seenNames.add(lower);
    users.push({
      id: r.id,
      username: r.username,
      usernameLower: r.usernameLower,
      passwordHash: r.passwordHash,
      role: r.role as Role,
      ...(r.disabled === true ? { disabled: true } : {}),
      // 管理员固定永久有效：历史数据即便写了 expiresAt 也不参与判定，避免把管理员锁死
      ...(expiresAt && r.role !== 'admin' ? { expiresAt } : {}),
      createdAt,
      updatedAt,
      passwordUpdatedAt,
      ...(typeof r.lastLoginAt === 'string' ? { lastLoginAt: r.lastLoginAt } : {}),
    });
  }
  return { version: 1, users };
}

function readStoreStrict(filePath: string): UserStoreFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, users: [] };
    throw corrupt(filePath, (err as Error).message);
  }
  return parseStore(raw, filePath);
}

function readStoreSafe(filePath: string): { store: UserStoreFile; corrupt: boolean; exists: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { store: { version: 1, users: [] }, corrupt: false, exists: false };
    }
    return { store: { version: 1, users: [] }, corrupt: true, exists: true };
  }
  try {
    return { store: parseStore(raw, filePath), corrupt: false, exists: true };
  } catch {
    return { store: { version: 1, users: [] }, corrupt: true, exists: true };
  }
}

function writeStore(store: UserStoreFile, filePath: string): void {
  ensureParent(filePath);
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.users.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
    throw err;
  }
}

function findIndex(store: UserStoreFile, username: string): number {
  const lower = username.trim().toLowerCase();
  return store.users.findIndex((u) => u.usernameLower === lower);
}

function enabledAdmins(store: UserStoreFile): number {
  return store.users.filter((u) => u.role === 'admin' && u.disabled !== true).length;
}

function assertNotLastEnabledAdmin(store: UserStoreFile, target: UserRecord, action: string): void {
  if (target.role !== 'admin' || target.disabled === true) return;
  if (enabledAdmins(store) <= 1) {
    throw new UserStoreError(
      'USER_LAST_ADMIN',
      `不能${action}最后一个启用中的管理员（会锁死系统）；请先创建或启用另一个管理员`,
    );
  }
}

function hasAdmin(store: UserStoreFile, exceptId?: string): boolean {
  return store.users.some((u) => u.role === 'admin' && u.id !== exceptId);
}

function assertAdminSlotAvailable(store: UserStoreFile, exceptId?: string): void {
  if (hasAdmin(store, exceptId)) {
    throw new UserStoreError(
      'USER_ADMIN_EXISTS',
      '系统只能有一个管理员；如需更换管理员，请先处理现有管理员账号',
    );
  }
}

/**
 * 管理员账号受保护：唯一管理员不可降级/禁用/删除/设置有效期。
 * ★ 兼容历史多管理员数据：存在其他管理员时允许清理多余管理员，最后由
 *   assertNotLastEnabledAdmin 保证至少留下一个启用中的管理员；有效期始终不允许改。
 */
function assertAdminProtected(store: UserStoreFile, target: UserRecord, action: string, allowPeerAdmin = false): void {
  if (target.role !== 'admin') return;
  if (!hasAdmin(store, target.id)) {
    throw new UserStoreError(
      'USER_ADMIN_PROTECTED',
      `管理员账号不可${action}；管理员权限固定、永久有效，只能修改密码`,
    );
  }
  if (!allowPeerAdmin) {
    throw new UserStoreError(
      'USER_ADMIN_PROTECTED',
      `管理员账号不可${action}；管理员权限固定、永久有效，只能修改密码`,
    );
  }
}

export function listUsers(filePath = getUsersPath()): UserView[] {
  return readStoreStrict(filePath).users.map(toView);
}

export function findUserRecord(
  username: string,
  filePath = getUsersPath(),
): UserRecord | undefined {
  const store = readStoreStrict(filePath);
  const idx = findIndex(store, username);
  return idx >= 0 ? store.users[idx] : undefined;
}

export function findUserById(id: string, filePath = getUsersPath()): UserRecord | undefined {
  return readStoreStrict(filePath).users.find((u) => u.id === id);
}

export function getUserStoreStatus(filePath = getUsersPath()): UserStoreStatus {
  const { store, corrupt, exists } = readStoreSafe(filePath);
  const admins = store.users.filter((u) => u.role === 'admin').length;
  return {
    exists,
    corrupt,
    total: store.users.length,
    enabled: store.users.filter((u) => u.disabled !== true).length,
    admins,
    enabledAdmins: store.users.filter((u) => u.role === 'admin' && u.disabled !== true).length,
  };
}

export function countEnabledUsers(filePath = getUsersPath()): number {
  return getUserStoreStatus(filePath).enabled;
}

export function countEnabledAdmins(filePath = getUsersPath()): number {
  return getUserStoreStatus(filePath).enabledAdmins;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: Role | string;
  /** ISO 时间；null/缺省 = 永久。管理员忽略此字段（固定永久） */
  expiresAt?: string | null;
}

export function createUser(input: CreateUserInput, filePath = getUsersPath()): UserView {
  const { username, usernameLower } = validateUsername(input.username);
  const role = assertRole(String(input.role));
  const password = validatePassword(input.password);
  const expiresAt = normalizeExpiresAt(input.expiresAt);

  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    if (findIndex(store, username) >= 0) {
      throw new UserStoreError('USER_EXISTS', `用户名已存在：${username}`);
    }
    if (role === 'admin') assertAdminSlotAvailable(store);
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: generateUserId(new Set(store.users.map((u) => u.id))),
      username,
      usernameLower,
      passwordHash: hashPassword(password),
      role,
      ...(role !== 'admin' && expiresAt ? { expiresAt } : {}),
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
    };
    store.users.push(record);
    writeStore(store, filePath);
    return toView(record);
  });
}

export function resetUserPassword(
  username: string,
  password: string,
  filePath = getUsersPath(),
): UserView {
  const value = validatePassword(password);
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = findIndex(store, username);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${username}`);
    const now = new Date().toISOString();
    const user = store.users[idx];
    user.passwordHash = hashPassword(value);
    user.passwordUpdatedAt = now;
    user.updatedAt = now;
    writeStore(store, filePath);
    return toView(user);
  });
}

export function setUserRole(
  username: string,
  role: Role | string,
  filePath = getUsersPath(),
): UserView {
  const nextRole = assertRole(String(role));
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = findIndex(store, username);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${username}`);
    const user = store.users[idx];
    if (user.role === 'admin' && nextRole !== 'admin') assertAdminProtected(store, user, '降级', true);
    if (nextRole !== 'admin') assertNotLastEnabledAdmin(store, user, '降级');
    if (nextRole === 'admin' && user.role !== 'admin') {
      assertAdminSlotAvailable(store, user.id);
      if (user.disabled === true) {
        throw new UserStoreError('USER_ADMIN_PROTECTED', '不能把已禁用账号提升为管理员；请先启用该账号');
      }
    }
    user.role = nextRole;
    if (nextRole === 'admin') delete user.expiresAt;
    user.updatedAt = new Date().toISOString();
    writeStore(store, filePath);
    return toView(user);
  });
}

export function setUserDisabled(
  username: string,
  disabled: boolean,
  filePath = getUsersPath(),
): UserView {
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = findIndex(store, username);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${username}`);
    const user = store.users[idx];
    if (disabled) assertAdminProtected(store, user, '禁用', true);
    if (disabled) assertNotLastEnabledAdmin(store, user, '禁用');
    if (disabled) user.disabled = true;
    else delete user.disabled;
    user.updatedAt = new Date().toISOString();
    writeStore(store, filePath);
    return toView(user);
  });
}

export interface UserPatch {
  role?: Role | string;
  password?: string;
  disabled?: boolean;
  /** ISO 时间；null = 永久；undefined = 不修改 */
  expiresAt?: string | null;
}

export function updateUserById(
  id: string,
  patch: UserPatch,
  filePath = getUsersPath(),
): UserView {
  const nextRole = patch.role !== undefined ? assertRole(String(patch.role)) : undefined;
  const nextPassword = patch.password !== undefined ? validatePassword(patch.password) : undefined;
  const nextExpiresAt = patch.expiresAt !== undefined ? normalizeExpiresAt(patch.expiresAt) : undefined;

  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = store.users.findIndex((u) => u.id === id);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${id}`);
    const user = store.users[idx];
    if (user.role === 'admin') {
      if (nextRole !== undefined && nextRole !== 'admin') assertAdminProtected(store, user, '降级', true);
      if (patch.disabled === true) assertAdminProtected(store, user, '禁用', true);
      if (patch.expiresAt !== undefined) assertAdminProtected(store, user, '设置有效期', false);
    }
    const finalRole = nextRole ?? user.role;
    const finalDisabled = patch.disabled !== undefined ? patch.disabled : user.disabled === true;
    if (nextRole === 'admin' && user.role !== 'admin') assertAdminSlotAvailable(store, user.id);
    if (finalRole === 'admin' && finalDisabled) {
      throw new UserStoreError('USER_ADMIN_PROTECTED', '管理员账号必须保持启用；请先启用账号再提升为管理员');
    }
    if (nextRole !== undefined && nextRole !== 'admin') {
      assertNotLastEnabledAdmin(store, user, '降级');
    }
    if (patch.disabled === true) {
      assertNotLastEnabledAdmin(store, user, '禁用');
    }

    const now = new Date().toISOString();
    if (nextRole !== undefined) user.role = nextRole;
    if (user.role === 'admin') delete user.expiresAt;
    if (patch.disabled === true) user.disabled = true;
    else if (patch.disabled === false) delete user.disabled;
    if (patch.expiresAt !== undefined && user.role !== 'admin') {
      if (nextExpiresAt) user.expiresAt = nextExpiresAt;
      else delete user.expiresAt;
    }
    if (nextPassword !== undefined) {
      user.passwordHash = hashPassword(nextPassword);
      user.passwordUpdatedAt = now;
    }
    user.updatedAt = now;
    writeStore(store, filePath);
    return toView(user);
  });
}

export function deleteUserById(id: string, filePath = getUsersPath()): UserView {
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = store.users.findIndex((u) => u.id === id);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${id}`);
    const user = store.users[idx];
    assertAdminProtected(store, user, '删除', true);
    assertNotLastEnabledAdmin(store, user, '删除');
    store.users.splice(idx, 1);
    writeStore(store, filePath);
    return toView(user);
  });
}

export function deleteUser(username: string, filePath = getUsersPath()): UserView {
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = findIndex(store, username);
    if (idx < 0) throw new UserStoreError('USER_NOT_FOUND', `账号不存在：${username}`);
    const user = store.users[idx];
    assertAdminProtected(store, user, '删除', true);
    assertNotLastEnabledAdmin(store, user, '删除');
    store.users.splice(idx, 1);
    writeStore(store, filePath);
    return toView(user);
  });
}

export function touchUserLogin(username: string, filePath = getUsersPath()): UserView | null {
  return withUsersLock(filePath, () => {
    const store = readStoreStrict(filePath);
    const idx = findIndex(store, username);
    if (idx < 0) return null;
    const user = store.users[idx];
    const now = new Date().toISOString();
    user.lastLoginAt = now;
    user.updatedAt = now;
    writeStore(store, filePath);
    return toView(user);
  });
}

/**
 * 校验用户名密码；用户不存在/禁用/密码错误统一返回 null。
 * 用户不存在时也执行 dummy scrypt（由调用方或本函数）避免耗时枚举。
 */
export function verifyCredentials(
  username: string,
  password: string,
  filePath = getUsersPath(),
): UserView | null {
  let store: UserStoreFile;
  try {
    store = readStoreStrict(filePath);
  } catch (err) {
    throw err;
  }
  const idx = findIndex(store, username);
  if (idx < 0) {
    verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  const user = store.users[idx];
  if (!isUserActive(user)) {
    verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) return null;
  const touched = touchUserLogin(user.username, filePath);
  return touched ?? null;
}
