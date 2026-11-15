/**
 * cli-timeout.test.ts —— 子进程封装自测（REQ-20261115-002 二期门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/cli-timeout.test.ts
 *
 * 验证 `execCli` 的四个承诺：
 *   ① 超时会中断并抛出可读错误（不是永远等）
 *   ② 错误信息含命令 / 超时值 / stdout 尾部
 *   ③ 正常退出返回 stdout，非零退出按 acceptStatus 判定
 *   ④ 超时值可被 KI_TEST_CLI_TIMEOUT 覆盖
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execCli, execCliJson, execCliRaw, cliTimeoutMs, CLI_TIMEOUT_MS } from './test-config.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-cli-timeout-'));
const HANG = path.join(TMP_DIR, 'hang.mjs');
const PRINT_THEN_HANG = path.join(TMP_DIR, 'print-hang.mjs');
const OK = path.join(TMP_DIR, 'ok.mjs');
const FAIL = path.join(TMP_DIR, 'fail.mjs');

before(() => {
  // 静默不退出：只有超时才能结束它
  fs.writeFileSync(HANG, 'setTimeout(() => {}, 200000);\n');
  // 先输出再挂住：验证错误里能拿到已产生的 stdout
  fs.writeFileSync(PRINT_THEN_HANG, [
    "process.stdout.write('line-a\\nline-b\\nline-c\\n');",
    'setTimeout(() => {}, 200000);',
    '',
  ].join('\n'));
  fs.writeFileSync(OK, "process.stdout.write(JSON.stringify({ ok: true, n: 42 }));\n");
  fs.writeFileSync(FAIL, "process.stderr.write('boom\\n'); process.exit(3);\n");
});

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('① 超时中断', () => {
  it('挂住的子进程在超时后抛错（300ms 内结束）', () => {
    const t0 = Date.now();
    assert.throws(
      () => execCli(HANG, { entry: 'node', timeout: 300 }),
      (err: Error) => {
        assert.match(err.message, /子进程超时（300ms）/);
        assert.match(err.message, /hang\.mjs/);
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `应在 5s 内返回，实际 ${elapsed}ms`);
  });

  it('超时错误带 KI_TEST_CLI_TIMEOUT 提示', () => {
    try {
      execCli(HANG, { entry: 'node', timeout: 200 });
      assert.fail('应当抛错');
    } catch (err) {
      assert.match((err as Error).message, /KI_TEST_CLI_TIMEOUT=400/);
    }
  });
});

describe('② 错误信息含输出尾部', () => {
  it('超时时能拿到已有 stdout 的尾部', () => {
    try {
      execCli(PRINT_THEN_HANG, { entry: 'node', timeout: 300 });
      assert.fail('应当抛错');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /--- stdout 尾部 ---/);
      assert.match(msg, /line-c/);
    }
  });

  it('非零退出带 stderr 尾部', () => {
    try {
      execCli(FAIL, { entry: 'node', timeout: 5000 });
      assert.fail('应当抛错');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /status=3/);
      assert.match(msg, /boom/);
    }
  });
});

describe('③ 正常路径', () => {
  it('返回 stdout 并可解析 JSON', () => {
    const parsed = execCliJson<{ ok: boolean; n: number }>(OK, { entry: 'node', timeout: 5000 });
    assert.deepEqual(parsed, { ok: true, n: 42 });
  });

  it('acceptStatus 放行非零退出', () => {
    const raw = execCliRaw(FAIL, { entry: 'node', timeout: 5000 });
    assert.equal(raw.status, 3);
    assert.match(raw.stderr, /boom/);
    // 不传 acceptStatus 时抛错；传了就不抛
    const out = execCli(FAIL, { entry: 'node', timeout: 5000, acceptStatus: [0, 3] });
    assert.equal(out, '');
  });

  it('stdout 非 JSON 时给出可读错误', () => {
    try {
      execCliJson(FAIL, { entry: 'node', timeout: 5000, acceptStatus: [0, 3] });
      assert.fail('应当抛错');
    } catch (err) {
      assert.match((err as Error).message, /不是合法 JSON/);
    }
  });
});

describe('④ 超时值来源', () => {
  it('默认取 CLI_TIMEOUT_MS', () => {
    const saved = process.env.KI_TEST_CLI_TIMEOUT;
    delete process.env.KI_TEST_CLI_TIMEOUT;
    try {
      assert.equal(cliTimeoutMs(), CLI_TIMEOUT_MS);
      assert.equal(CLI_TIMEOUT_MS, 120_000);
    } finally {
      if (saved !== undefined) process.env.KI_TEST_CLI_TIMEOUT = saved;
    }
  });

  it('KI_TEST_CLI_TIMEOUT 可覆盖', () => {
    const saved = process.env.KI_TEST_CLI_TIMEOUT;
    process.env.KI_TEST_CLI_TIMEOUT = '20000';
    try {
      assert.equal(cliTimeoutMs(), 20_000);
    } finally {
      if (saved === undefined) delete process.env.KI_TEST_CLI_TIMEOUT;
      else process.env.KI_TEST_CLI_TIMEOUT = saved;
    }
  });

  it('非法值回落默认', () => {
    const saved = process.env.KI_TEST_CLI_TIMEOUT;
    for (const bad of ['abc', '0', '-1']) {
      process.env.KI_TEST_CLI_TIMEOUT = bad;
      assert.equal(cliTimeoutMs(), CLI_TIMEOUT_MS, `非法值 ${bad} 应回落`);
    }
    if (saved === undefined) delete process.env.KI_TEST_CLI_TIMEOUT;
    else process.env.KI_TEST_CLI_TIMEOUT = saved;
  });
});
