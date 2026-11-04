/**
 * scope-view-gate.test.ts —— 写路径门禁（REQ-20261104-003 / S-03）
 *
 * 覆盖：
 *   1) 写锁内收到视图名 → VIEW_NOT_WRITABLE，且**不建目录**（不落盘）
 *   2) 普通 scope 不受影响（门禁零开销放行）
 *   3) 产物类命令（export / backup）拒绝视图并给出逐库命令
 *   4) 错误文案带成员名与可直接执行的示例
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir
 * 运行：npx jiti test/scope-view-gate.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-gate-'));
const configPath = path.join(tmpDir, 'config.json');
const dataDir = path.join(tmpDir, 'kb');
const viewsPath = path.join(tmpDir, 'views.json');
const kiBin = path.join(process.cwd(), 'bin', 'ki.mjs');

fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(viewsPath, JSON.stringify({
  version: 1,
  views: { team: { members: ['kisearch', 'kisearch-memory'] } },
  updatedAt: new Date().toISOString(),
}, null, 2), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let lockLib: typeof import('../src/lib/scope-write-lock.js');
let policy: typeof import('../src/lib/scope-policy.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  lockLib = await import('../src/lib/scope-write-lock.js');
  policy = await import('../src/lib/scope-policy.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('写锁内门禁', () => {
  it('★ 视图名被拒且不落盘', async () => {
    configLib.resetConfigCache();
    await assert.rejects(
      () => lockLib.withScopeWriteLock('team', 'store', async () => 'should-not-run'),
      (err: unknown) => policy.isScopeViewWriteError(err) && err.code === 'VIEW_NOT_WRITABLE',
    );
    assert.equal(fs.existsSync(path.join(dataDir, 'team')), false, '视图名不得凭空建出 dataDir/<视图名>/');
  });

  it('错误文案含成员名与可执行的示例命令', async () => {
    configLib.resetConfigCache();
    try {
      await lockLib.withScopeWriteLock('team', 'store', async () => 'x');
      assert.fail('应当抛错');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /只读聚合/);
      assert.match(msg, /kisearch/);
      assert.match(msg, /ki store --scope kisearch/);
    }
  });

  it('普通 scope 正常放行（不误伤）', async () => {
    configLib.resetConfigCache();
    const got = await lockLib.withScopeWriteLock('kisearch', 'store', async () => 'ran');
    assert.equal(got, 'ran');
  });

  it('产物类 op 给出逐库命令', async () => {
    configLib.resetConfigCache();
    try {
      await lockLib.withScopeWriteLock('team', 'backup', async () => 'x');
      assert.fail('应当抛错');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /逐库执行/);
      assert.match(msg, /ki backup kisearch/);
      assert.match(msg, /ki backup kisearch-memory/);
    }
  });
});

describe('CLI 出口', () => {
  async function run(args: string[]): Promise<{ code: number; stderr: string }> {
    try {
      const r = await execFileAsync(process.execPath, [kiBin, ...args], {
        env: { ...process.env, KI_CONFIG_PATH: configPath },
        timeout: 60_000,
      });
      return { code: 0, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      return { code: e.code ?? 1, stderr: e.stderr ?? '' };
    }
  }

  it('ki export <视图> → 退出 1 + 逐库命令', async () => {
    const r = await run(['export', 'team', '--output', path.join(tmpDir, 'out')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /VIEW_NOT_WRITABLE/);
    assert.match(r.stderr, /ki export kisearch/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'out')), false, '被拒时不应产出任何目录');
  });

  it('ki backup <视图> → 退出 1 + 逐库命令', async () => {
    const r = await run(['backup', 'team']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /VIEW_NOT_WRITABLE/);
    assert.match(r.stderr, /ki backup kisearch/);
  });
});
