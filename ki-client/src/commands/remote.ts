/**
 * `ki-client remote ...` —— 多源管理（类比 `git remote`）。
 *
 * 一条安全约定：**同名源改地址时清空旧 token**。否则「A 环境的 token 发给 B 环境」
 * 这种事故只会在某次 401 之后才被发现，而且很难归因。
 */

import { ClientError } from '../errors.js';
import {
  assertValidRemoteName,
  normalizeBaseUrl,
  readConfig,
  remoteNames,
  writeConfig,
  type KiClientConfig,
} from '../config.js';
import { tokenEnvName } from '../remote.js';
import type { ParsedArgs } from '../args.js';

function maskToken(token: string | undefined): string {
  if (!token) return '(未配置)';
  return token.length <= 8 ? `${token}…` : `${token.slice(0, 8)}…`;
}

/** 从 stdin 读一行（`--token-stdin`：避免 token 进 shell history） */
async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const token = Buffer.concat(chunks).toString('utf-8').trim();
  if (!token) {
    throw new ClientError('USAGE', '--token-stdin 没有读到内容', 'echo "$MY_TOKEN" | ki-client remote add prod <url> --token-stdin');
  }
  return token;
}

function printConfigHint(configPath: string): void {
  console.log(`配置已写入：${configPath}（权限 0600，含明文 token，勿提交到仓库）`);
}

export async function runRemote(args: ParsedArgs, configPath: string): Promise<number> {
  const [sub, ...rest] = args.positionals;
  const config = readConfig(configPath);

  switch (sub) {
    case 'add': return addRemote(args, config, configPath, rest);
    case 'list': return listRemotes(config);
    case 'show': return showRemote(config, rest);
    case 'remove':
    case 'rm': return removeRemote(config, configPath, rest);
    case undefined:
      throw new ClientError('USAGE', '缺子命令', '用法：ki-client remote <add|list|show|remove> ...');
    default:
      throw new ClientError('USAGE', `不认识的子命令 remote ${sub}`, '可用：add / list / show / remove');
  }
}

async function addRemote(
  args: ParsedArgs,
  config: KiClientConfig,
  configPath: string,
  rest: string[],
): Promise<number> {
  const [name, rawUrl] = rest;
  if (!name || !rawUrl) {
    throw new ClientError('USAGE', '缺参数', '用法：ki-client remote add <名字> <地址> [--token <t> | --token-stdin]');
  }
  assertValidRemoteName(name);
  const url = normalizeBaseUrl(rawUrl, name);

  const inlineToken = args.string('token');
  const useStdin = args.bool('token-stdin');
  if (inlineToken && useStdin) {
    throw new ClientError('USAGE', '--token 与 --token-stdin 只能二选一', '推荐 --token-stdin（不进 shell history）');
  }
  const providedToken = useStdin ? await readTokenFromStdin() : inlineToken;

  const existing = config.remotes[name];
  if (existing && existing.url !== url) {
    // 换地址 ⇒ 清掉旧 token（防把 A 环境的凭证发到 B 环境）
    config.remotes[name] = { url, addedAt: new Date().toISOString(), ...(providedToken ? { token: providedToken } : {}) };
    writeConfig(configPath, config);
    console.log(`已更新源 ${name}：地址变了（${existing.url} → ${url}），旧 token 已清除`);
    if (!providedToken) {
      console.log(`请补 token：设置环境变量 ${tokenEnvName(name)}，或重新执行 --token-stdin`);
    }
    printConfigHint(configPath);
    return 0;
  }

  config.remotes[name] = {
    url,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    // 没提供新 token 时保留旧值（同址更新不应丢凭证）
    ...(providedToken ? { token: providedToken } : existing?.token ? { token: existing.token } : {}),
  };
  writeConfig(configPath, config);

  console.log(`${existing ? '已更新' : '已添加'}源 ${name} → ${url}`);
  const hasToken = Boolean(config.remotes[name]!.token);
  if (!hasToken) {
    console.log(`该源还没有 token：设置环境变量 ${tokenEnvName(name)}，或用 --token-stdin 写入`);
  }
  if (inlineToken) {
    console.log('提示：--token 会留在 shell history 里，下次可用 --token-stdin');
  }
  printConfigHint(configPath);
  if (remoteNames(config).length > 1) {
    console.log(`当前共 ${remoteNames(config).length} 个源，之后每次操作都要加 --remote <名字>`);
  }
  return 0;
}

function listRemotes(config: KiClientConfig): number {
  const names = remoteNames(config);
  if (names.length === 0) {
    const envUrl = process.env.KI_URL?.trim();
    console.log('还没有配置任何源。');
    if (envUrl) {
      console.log(`检测到环境变量 KI_URL=${envUrl}（隐式源，仅本次进程有效）`);
    } else {
      console.log('先执行：ki-client remote add prod http://127.0.0.1:7423');
    }
    return 0;
  }
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    const item = config.remotes[name]!;
    const fromEnv = process.env[tokenEnvName(name)]?.trim() ? '（环境变量覆盖）' : '';
    console.log(`${name.padEnd(width)}  ${item.url}  token=${maskToken(item.token)}${fromEnv}`);
  }
  if (names.length > 1) {
    console.log(`\n共 ${names.length} 个源：操作时必须用 --remote <名字> 指定`);
  }
  return 0;
}

function showRemote(config: KiClientConfig, rest: string[]): number {
  const name = rest[0];
  if (!name) throw new ClientError('USAGE', '缺源名', '用法：ki-client remote show <名字>');
  const item = config.remotes[name];
  if (!item) {
    throw new ClientError('UNKNOWN_REMOTE', `没有名为 "${name}" 的源`, `可用源：${remoteNames(config).join(', ') || '(无)'}`);
  }
  const envHasToken = Boolean(process.env[tokenEnvName(name)]?.trim());
  console.log(`name:   ${name}`);
  console.log(`url:    ${item.url}`);
  console.log(`token:  ${maskToken(item.token)}${envHasToken ? '（环境变量覆盖）' : ''}`);
  if (item.addedAt) console.log(`added:  ${item.addedAt}`);
  if (!item.token && !envHasToken) {
    console.log(`\n该源没有可用 token：设置 ${tokenEnvName(name)} 或 --token-stdin`);
  }
  return 0;
}

function removeRemote(config: KiClientConfig, configPath: string, rest: string[]): number {
  const name = rest[0];
  if (!name) throw new ClientError('USAGE', '缺源名', '用法：ki-client remote remove <名字>');
  if (!config.remotes[name]) {
    throw new ClientError('UNKNOWN_REMOTE', `没有名为 "${name}" 的源`, `可用源：${remoteNames(config).join(', ') || '(无)'}`);
  }
  delete config.remotes[name];
  writeConfig(configPath, config);
  console.log(`已删除源 ${name}`);
  const left = remoteNames(config);
  if (left.length === 1) console.log(`剩下 1 个源（${left[0]}），之后可以省略 --remote`);
  return 0;
}
