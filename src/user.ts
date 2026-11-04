#!/usr/bin/env node
/**
 * user.ts —— `ki user` 账号管理 CLI（REQ-20261103-001 · S-01）
 *
 * 用法：
 *   ki user create <username> --role <admin|editor|viewer> [--password-stdin]
 *   ki user list [--json]
 *   ki user reset-password <username> [--password-stdin]
 *   ki user set-role <username> --role <admin|editor|viewer>
 *   ki user disable <username>
 *   ki user enable <username>
 *   ki user delete <username> --yes
 *
 * 本机 CLI 是可信入口；创建的账号只用于 Web 登录，与 MCP Token 独立。
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import { UserStoreError, ROLES, type UserView } from './lib/user-store.js';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  setUserRole,
} from './lib/user-store.js';
import { toErrorPayload } from './lib/cli-args.js';

interface PasswordOptions {
  passwordStdin?: boolean;
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printUserTable(users: UserView[]): void {
  if (users.length === 0) {
    console.log('尚无账号。可执行：ki user create <username> --role admin');
    return;
  }
  const rows = users.map((u) => ({
    用户名: u.username,
    角色: u.role,
    状态: u.disabled ? '禁用' : '启用',
    最近登录: u.lastLoginAt ?? '—',
    创建时间: u.createdAt,
  }));
  const headers = Object.keys(rows[0]) as Array<keyof (typeof rows)[number]>;
  const widths = headers.map((h) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[h]).length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(headers.map(String)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(headers.map((h) => String(row[h]))));
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UserStoreError(
      'USER_PASSWORD_REQUIRED',
      '当前不是交互终端；请使用 --password-stdin 从标准输入读取密码',
    );
  }
  process.stdout.write(label);
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(Object.assign(new Error('已取消'), { code: 'USER_CANCELLED' }));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(opts: PasswordOptions, confirm: boolean): Promise<string> {
  if (opts.passwordStdin) {
    const raw = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!raw) throw new UserStoreError('USER_PASSWORD_REQUIRED', '标准输入没有读到密码');
    return raw;
  }
  const first = await promptHidden('密码: ');
  if (!confirm) return first;
  const second = await promptHidden('再次输入密码: ');
  if (first !== second) {
    throw Object.assign(new Error('两次输入的密码不一致'), { code: 'USER_PASSWORD_MISMATCH' });
  }
  return first;
}

function parseRole(raw: string): string {
  return raw.trim();
}

const program = new Command();
program.name('user').showHelpAfterError().description('Web 登录账号管理（与 MCP Token 独立）');

program
  .command('create')
  .description('创建 Web 登录账号')
  .argument('<username>', '用户名（字母/数字/点/连字符/下划线，1-64）')
  .requiredOption('--role <role>', `角色：${ROLES.join(' / ')}`)
  .option('--password-stdin', '从标准输入读取密码（非交互终端）')
  .action(async (username: string, opts: { role: string; passwordStdin?: boolean }) => {
    const password = await readPassword(opts, true);
    const user = createUser({ username, password, role: parseRole(opts.role) });
    output({ ok: true, user });
  });

program
  .command('list')
  .description('列出账号（不显示密码哈希）')
  .option('--json', 'JSON 输出')
  .action((opts: { json?: boolean }) => {
    const users = listUsers();
    if (opts.json) output({ ok: true, users });
    else printUserTable(users);
  });

program
  .command('reset-password')
  .description('重置指定账号的密码（无需旧密码）')
  .argument('<username>', '用户名')
  .option('--password-stdin', '从标准输入读取密码（非交互终端）')
  .action(async (username: string, opts: { passwordStdin?: boolean }) => {
    const password = await readPassword(opts, true);
    const user = resetUserPassword(username, password);
    output({ ok: true, user });
  });

program
  .command('set-role')
  .description('修改账号角色')
  .argument('<username>', '用户名')
  .requiredOption('--role <role>', `角色：${ROLES.join(' / ')}`)
  .action((username: string, opts: { role: string }) => {
    const user = setUserRole(username, parseRole(opts.role));
    output({ ok: true, user });
  });

program
  .command('disable')
  .description('禁用账号（立即拒绝登录并使现有会话失效）')
  .argument('<username>', '用户名')
  .action((username: string) => {
    output({ ok: true, user: setUserDisabled(username, true) });
  });

program
  .command('enable')
  .description('启用账号')
  .argument('<username>', '用户名')
  .action((username: string) => {
    output({ ok: true, user: setUserDisabled(username, false) });
  });

program
  .command('delete')
  .description('删除账号（需 --yes；最后一个启用中的管理员不可删除）')
  .argument('<username>', '用户名')
  .option('--yes', '确认删除')
  .action((username: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      throw new UserStoreError(
        'USER_CONFIRM_REQUIRED',
        `删除账号 ${username} 需确认：请追加 --yes`,
      );
    }
    output({ ok: true, user: deleteUser(username) });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const payload = toErrorPayload(err);
  output(payload);
  process.exitCode = 1;
});
