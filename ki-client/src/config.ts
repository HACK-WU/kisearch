/**
 * 配置文件读写：`~/.ki-client/config.yaml`（目录 0700 / 文件 0600）。
 *
 * ═══ 三条硬约束（改本文件前先读）═══
 * 1. **写入一律带引号**：`token: a: b` 会被 YAML 解析成嵌套 map、含 `#` 的 token 会被截断。
 *    故 stringify 统一 `defaultStringType: QUOTE_DOUBLE`。
 * 2. **源名白名单**：`[a-z0-9][a-z0-9_-]*`，且排除 `on/off/yes/no/true/false/null` ——
 *    YAML 1.1 会把它们解析成布尔/None 键，`on:` 这类名字会凭空消失。
 * 3. **未知顶层键 fail-loud**：写错的配置项必须立刻响，不能等到 401 才排查。
 *
 * 路径优先级：`--config` > `KI_CLIENT_CONFIG` > `~/.ki-client/config.yaml`。
 * **不读工作区内的配置文件**（否则 clone 别人的仓库就可能连到他的源）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ClientError } from './errors.js';

export interface RemoteConfig {
  url: string;
  /** 明文 token；0600 保护。可用 `KI_TOKEN_<REMOTE>` 环境变量覆盖 */
  token?: string;
  addedAt?: string;
}

export interface KiClientConfig {
  version: 1;
  remotes: Record<string, RemoteConfig>;
}

const CONFIG_VERSION = 1;
const CONFIG_DIR = '.ki-client';
const CONFIG_FILE = 'config.yaml';

/** YAML 布尔/空值陷阱：这些名字当 key 会被解析成非字符串 */
const RESERVED_NAMES = new Set(['on', 'off', 'yes', 'no', 'true', 'false', 'null', '~']);
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** 校验源名；不合法直接抛（调用方不必二次判断） */
export function assertValidRemoteName(name: string): void {
  if (!name) {
    throw new ClientError('USAGE', '源名不能为空', '示例：ki-client remote add prod http://127.0.0.1:7423');
  }
  if (!NAME_RE.test(name)) {
    throw new ClientError(
      'USAGE',
      `源名 "${name}" 不合法：只允许小写字母、数字、连字符、下划线，且以字母或数字开头`,
      '示例：prod / test / ki-2',
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ClientError(
      'USAGE',
      `源名 "${name}" 是 YAML 保留字（会被解析成布尔或空值）`,
      '换一个名字，如 prod / staging',
    );
  }
}

/** 解析配置路径（不读文件） */
export function resolveConfigPath(explicit?: string): string {
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  const fromEnv = process.env.KI_CLIENT_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);
}

/** 空配置（首次使用） */
export function emptyConfig(): KiClientConfig {
  return { version: CONFIG_VERSION, remotes: {} };
}

/**
 * 读配置。文件不存在 → 空配置（不报错，`remote add` 会写出来）。
 * 解析失败 / 形状不合法 → `CONFIG_INVALID`（带出路，不静默重建）。
 */
export function readConfig(configPath: string): KiClientConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw new ClientError(
      'CONFIG_INVALID',
      `读不了配置文件 ${configPath}：${(err as Error).message}`,
      '检查文件权限（应为 0600）与路径是否正确',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ClientError(
      'CONFIG_INVALID',
      `配置文件不是合法 YAML：${(err as Error).message}`,
      `修正 ${configPath}，或用 --config 指向另一份配置`,
    );
  }

  if (parsed === null || parsed === undefined) return emptyConfig();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClientError('CONFIG_INVALID', '配置文件顶层必须是映射（key: value）', `检查 ${configPath}`);
  }

  const obj = parsed as Record<string, unknown>;
  // 约束 3：未知顶层键 fail-loud
  const known = new Set(['version', 'remotes']);
  const unknown = Object.keys(obj).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ClientError(
      'CONFIG_INVALID',
      `配置文件里有不认识的配置项：${unknown.join(', ')}`,
      '本文件只支持 version 与 remotes；写错的项不会被静默忽略',
    );
  }

  const remotesRaw = obj.remotes;
  const remotes: Record<string, RemoteConfig> = {};
  if (remotesRaw !== undefined) {
    if (typeof remotesRaw !== 'object' || remotesRaw === null || Array.isArray(remotesRaw)) {
      throw new ClientError('CONFIG_INVALID', '`remotes` 必须是「源名 → { url, token }」的映射', `检查 ${configPath}`);
    }
    for (const [name, value] of Object.entries(remotesRaw as Record<string, unknown>)) {
      assertValidRemoteName(name);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ClientError(
          'CONFIG_INVALID',
          `源 "${name}" 的配置必须是映射（至少含 url）`,
          `示例：\n  ${name}:\n    url: "http://127.0.0.1:7423"\n    token: "ki_xxx"`,
        );
      }
      const item = value as Record<string, unknown>;
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!url) {
        throw new ClientError('CONFIG_INVALID', `源 "${name}" 缺少 url`, 'url 形如 http://127.0.0.1:7423');
      }
      remotes[name] = {
        url: normalizeBaseUrl(url, name),
        ...(typeof item.token === 'string' && item.token.trim() ? { token: item.token.trim() } : {}),
        ...(typeof item.addedAt === 'string' ? { addedAt: item.addedAt } : {}),
      };
    }
  }

  return { version: CONFIG_VERSION, remotes };
}

/** 校验并规范化服务地址：只接受 http/https，去尾斜杠（子路径保留） */
export function normalizeBaseUrl(raw: string, name = ''): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientError(
      'USAGE',
      `${name ? `源 "${name}" 的 ` : ''}地址不是合法 URL：${raw}`,
      '示例：http://127.0.0.1:7423 或 https://ki.example.com/ki',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ClientError('USAGE', `只支持 http/https：${raw}`, '内网部署通常是 http://<host>:<port>');
  }
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/**
 * 写配置（原子 + 0600）。目录不存在则建（0700）。
 *
 * 先写临时文件再 rename：中途失败不会留下半份配置（半份配置会让下一次启动直接报
 * CONFIG_INVALID，比"没写成功"更难排查）。
 */
export function writeConfig(configPath: string, config: KiClientConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 目录权限改不动（共享盘 / 非 POSIX 文件系统）不算致命，继续写文件
  }

  const body = stringifyYaml(
    { version: CONFIG_VERSION, remotes: config.remotes },
    // 约束 1：所有字符串**值**都带双引号（token 里的 `#` / `:` 不会被误解析）；
    // key 用 PLAIN 保持可读 —— 源名白名单已排除 YAML 保留字（on/off/yes/no/…），
    // 不会出现 `on:` 被解析成布尔键的情况。
    { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 },
  );
  const header = '# ki-client 配置（本文件含明文 token，权限必须保持 0600）\n';

  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, header + body, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 同目录权限问题，忽略
  }
  fs.renameSync(tmp, configPath);
}

/** 源名列表（排序，稳定输出） */
export function remoteNames(config: KiClientConfig): string[] {
  return Object.keys(config.remotes).sort();
}
