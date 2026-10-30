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

/** 多 Token 存储文件路径：~/.ki/mcp-tokens.json（与 HTTP lock 同目录） */
export function getTokensPath(): string {
  return path.join(os.homedir(), '.ki', 'mcp-tokens.json');
}

/** 单条 Token 记录 */
export interface TokenRecord {
  /** 短 ID（8 位 base62，无易混淆字符），唯一标识，供 update/delete 使用 */
  id: string;
  /** Token 明文（32 字节熵，base64url） */
  token: string;
  /** 授权 scope 集合：['all'] 表示全部；否则为具体 scope 列表 */
  scopes: string[];
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
export function createToken(
  scopes: string[],
  filePath = getTokensPath(),
  readOnly = false,
): TokenRecord {
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
  };
  records.push(record);
  writeTokens(records, filePath);
  return record;
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
  const records = listTokensStrict(filePath);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw Object.assign(new Error(`Token 不存在（id: ${id}）。请用 ki mcp token list 查看有效 id。`), {
      code: 'TOKEN_NOT_FOUND',
    });
  }
  records.splice(idx, 1);
  writeTokens(records, filePath);
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
): string[] | undefined {
  return findTokenRecord(tokenValue, filePath)?.scopes;
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
): TokenAuth | undefined {
  const record = findTokenRecord(tokenValue, filePath);
  if (!record) return undefined;
  return { id: record.id, scopes: record.scopes, readOnly: record.readOnly === true };
}

/** `readOnly` 字段是否非法（存在但不是布尔）——供 list 命令告警，undefined 属正常（缺省读写） */
export function isReadOnlyFieldInvalid(record: TokenRecord): boolean {
  const value: unknown = (record as { readOnly?: unknown }).readOnly;
  return value !== undefined && typeof value !== 'boolean';
}

/** 查询 Token 记录数量（供 --status 诊断输出，不含明文） */
export function tokenCount(filePath = getTokensPath()): number {
  return listTokens(filePath).length;
}
