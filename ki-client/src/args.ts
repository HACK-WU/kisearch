/**
 * 极简参数解析（零依赖，不引 commander）。
 *
 * ═══ 为什么需要「哪些 flag 带值」的白名单 ═══
 * 最初按「`--x` 后面不是 `-` 就当作它的值」实现，结果 `upload-dir --wait /tmp/dir`
 * 里的 `--wait` 把目录吞了，位置参数凭空消失（报「缺目录参数」）——用户很难自己看出原因。
 * 现在改成：
 *   · **值型 flag** 才吞下一个词（白名单见 `VALUE_FLAGS`）；
 *   · **布尔 flag** 一律不吞（`BOOL_FLAGS`）；
 *   · 两者都不认识的 `--xxx` → 直接报未知参数（fail-loud）——拼错的 flag 不会静默变成布尔。
 *
 * 代价：新增 flag 必须登记。忘了登记会立刻报错而不是静默走偏，这个代价是值得的。
 */

import { ClientError } from './errors.js';

/** 需要取值的 flag（多个别名写法都登记，避免驼峰/连字符混用时踩空） */
const VALUE_FLAGS = new Set([
  'config', 'remote', 'scope', 'group', 'relation', 'refs', 'out', 'task',
  'tags', 'lifecycle', 'event', 'token',
  'ttl-days', 'ttlDays',
  'chunk-size', 'chunkSize',
  'chunk-overlap', 'chunkOverlap',
  'batch-bytes', 'batchBytes',
]);

/** 纯布尔 flag */
const BOOL_FLAGS = new Set([
  'json', 'help', 'version', 'overwrite', 'wait', 'no-assets', 'token-stdin',
  'archive', 'force', 'no-state',
]);

export interface ParsedArgs {
  positionals: string[];
  /** 取字符串值；flag 形态（`--json`）返回 undefined */
  string(name: string): string | undefined;
  /** 取布尔；`--flag` 或 `--flag=true` 为真 */
  bool(name: string): boolean;
  has(name: string): boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (!body) continue;

    const eq = body.indexOf('=');
    if (eq >= 0) {
      const name = body.slice(0, eq);
      flags.set(name, body.slice(eq + 1));
      continue;
    }

    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new ClientError(
          'USAGE',
          `参数 --${body} 缺少值`,
          `示例：--${body} <值>；把值用引号包住可避免被 shell 拆开`,
        );
      }
      flags.set(body, next);
      i += 1;
      continue;
    }

    if (BOOL_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }

    throw new ClientError(
      'USAGE',
      `未知参数 --${body}`,
      '用 ki-client --help 查看可用参数；参数名拼错不会静默忽略',
    );
  }

  return {
    positionals,
    string: (name) => {
      const value = flags.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    bool: (name) => {
      const value = flags.get(name);
      return value === true || value === 'true';
    },
    has: (name) => flags.has(name),
  };
}
