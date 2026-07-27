/**
 * mcp-token.ts —— ki mcp HTTP 模式托管 Token（生成 / 读取 / 重置）
 *
 * 把 Bearer Token 从「用户手工管理的输入」升级为「ki 托管的凭据」：
 *   - createManagedToken：强随机生成并持久化，已存在则拒绝覆盖（防止已配置客户端断连）
 *   - resetManagedToken：显式轮换，生成新 Token 覆盖旧值
 *   - readManagedToken：`ki mcp --http` 启动时自动读取（优先级最低：--token > KI_MCP_TOKEN > 托管文件）
 *
 * 存储：~/.ki/mcp-token（单行纯文本，0600 仅属主可读写）。
 * 安全约定：Token 绝不写入 YAML 配置文件；明文只在 generate/reset 成功输出时出现一次。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** 托管 Token 文件路径：~/.ki/mcp-token（与 mcp-http.lock 同目录） */
export function getManagedTokenPath(): string {
  return path.join(os.homedir(), '.ki', 'mcp-token');
}

/** 生成密码学强随机 Token（32 字节熵，base64url，约 43 字符） */
export function generateTokenValue(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 托管 Token 元信息（不含明文），供 --status 等诊断输出使用 */
export interface ManagedTokenInfo {
  exists: boolean;
  path: string;
  createdAt?: string;
}

/** 查询托管 Token 存在性与创建时间（文件 mtime），绝不返回明文 */
export function managedTokenInfo(filePath = getManagedTokenPath()): ManagedTokenInfo {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, path: filePath, createdAt: st.mtime.toISOString() };
  } catch {
    return { exists: false, path: filePath };
  }
}

/** 读取托管 Token；文件不存在或内容为空时返回 undefined */
export function readManagedToken(filePath = getManagedTokenPath()): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 生成并持久化托管 Token。
 * 已存在时抛错（code: MCP_TOKEN_EXISTS），绝不静默覆盖——覆盖会使所有已配置客户端断连。
 * 使用 'wx' 独占创建标志保证存在性检查与写入的原子性（无 TOCTOU 竞态）。
 */
export function createManagedToken(filePath = getManagedTokenPath()): { token: string; path: string } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = generateTokenValue();
  try {
    fs.writeFileSync(filePath, token + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const info = managedTokenInfo(filePath);
      throw Object.assign(
        new Error(
          `托管 Token 已存在（创建于 ${info.createdAt ?? '未知时间'}，路径 ${filePath}）。` +
            `为避免已配置的客户端断连，不会覆盖；如需更换请执行 ki mcp token reset --yes。`,
        ),
        { code: 'MCP_TOKEN_EXISTS' },
      );
    }
    throw err;
  }
  return { token, path: filePath };
}

/**
 * 重置托管 Token（轮换）：无条件生成新值覆盖旧值，并确保 0600 权限。
 * 调用方必须先完成显式确认（--yes），本函数不做交互。
 */
export function resetManagedToken(filePath = getManagedTokenPath()): { token: string; path: string } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = generateTokenValue();
  fs.writeFileSync(filePath, token + '\n', { mode: 0o600 });
  // writeFileSync 的 mode 仅在新建时生效；文件已存在时显式收紧权限
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* Windows/挂载盘等权限语义受限的场景忽略 */
  }
  return { token, path: filePath };
}
