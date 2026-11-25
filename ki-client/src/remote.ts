/**
 * 源（remote）解析：决定「这次操作打哪台 ki」以及「用哪个 token」。
 *
 * ═══ 优先级（刻意不设默认源）═══
 * 1. `--remote <name>`
 * 2. `KI_REMOTE` 环境变量
 * 3. 配置里**只有一个**源 → 自动选中
 * 4. 多个源且都没指定 → `NO_REMOTE_SPECIFIED`（列出可用源）
 * 5. 没有任何源但有 `KI_URL` → 视为隐式源（兼容 CI 一次性调用与旧脚本习惯）
 *
 * 为什么不像 git 那样留一个 `default`：本工具最常见的误操作是「把测试库的包传到生产」。
 * 多源必须显式，等于每次写操作都过一次脑子；单源自动只是省掉无意义的重复。
 *
 * token 优先级：`KI_TOKEN_<REMOTE>` > 该源的 `token` 字段 > （单源/隐式源时）`KI_TOKEN`。
 */

import { ClientError } from './errors.js';
import type { KiClientConfig } from './config.js';
import { remoteNames } from './config.js';

export interface ResolvedRemote {
  /** 源名；隐式源（KI_URL）为 `(env)` */
  name: string;
  /** 规范化后的基地址（无尾斜杠，可能含子路径） */
  url: string;
  token: string;
  /** 值从哪来，供 `ping` 回显与排错 */
  source: 'config' | 'env';
}

/** `KI_TOKEN_<REMOTE>` 的变量名：非字母数字转下划线、转大写 */
export function tokenEnvName(remoteName: string): string {
  const suffix = remoteName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `KI_TOKEN_${suffix}`;
}

function pickToken(remoteName: string, configToken: string | undefined, allowGlobalFallback: boolean): string | undefined {
  const perRemote = process.env[tokenEnvName(remoteName)]?.trim();
  if (perRemote) return perRemote;
  if (configToken) return configToken;
  if (allowGlobalFallback) {
    const global = process.env.KI_TOKEN?.trim();
    if (global) return global;
  }
  return undefined;
}

/**
 * 解析本次要用的源。找不到 / 不唯一 / 缺 token 一律抛 `ClientError`（带出路）。
 */
export function resolveRemote(config: KiClientConfig, requested?: string): ResolvedRemote {
  const explicit = (requested ?? process.env.KI_REMOTE ?? '').trim();
  const names = remoteNames(config);

  // ① 显式指定
  if (explicit) {
    const item = config.remotes[explicit];
    if (!item) {
      throw new ClientError(
        'UNKNOWN_REMOTE',
        `没有名为 "${explicit}" 的源`,
        names.length > 0
          ? `可用源：${names.join(', ')}（用 ki-client remote add 新增）`
          : '当前还没有任何源，先跑 ki-client remote add <名字> <地址>',
      );
    }
    const token = pickToken(explicit, item.token, names.length === 1);
    if (!token) {
      throw new ClientError(
        'TOKEN_MISSING',
        `源 "${explicit}" 没有可用 token`,
        `设置环境变量 ${tokenEnvName(explicit)}，或重新执行 remote add 时用 --token-stdin 提供`,
      );
    }
    return { name: explicit, url: item.url, token, source: 'config' };
  }

  // ② 隐式源（没有任何配置源，但有 KI_URL）
  if (names.length === 0) {
    const envUrl = process.env.KI_URL?.trim();
    const envToken = process.env.KI_TOKEN?.trim();
    if (envUrl) {
      if (!envToken) {
        throw new ClientError(
          'TOKEN_MISSING',
          '检测到 KI_URL，但没有 KI_TOKEN',
          '设置 KI_TOKEN，或改用 ki-client remote add 把源与 token 写进配置',
        );
      }
      return {
        name: '(env)',
        url: envUrl.replace(/\/+$/, ''),
        token: envToken,
        source: 'env',
      };
    }
    throw new ClientError(
      'NO_REMOTE_SPECIFIED',
      '还没有配置任何源',
      '先执行：ki-client remote add prod http://127.0.0.1:7423（token 用 --token-stdin 或环境变量 KI_TOKEN_PROD）',
    );
  }

  // ③ 单源自动
  if (names.length === 1) {
    const name = names[0]!;
    return resolveRemote(config, name);
  }

  // ④ 多源必须显式
  throw new ClientError(
    'NO_REMOTE_SPECIFIED',
    `配置了 ${names.length} 个源，必须指定用哪个`,
    `加 --remote <名字>，或设置 KI_REMOTE；可用源：${names.join(', ')}`,
  );
}
