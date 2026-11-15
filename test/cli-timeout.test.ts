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
import { stripComments, callSnippets } from './code-scan.js';

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

/**
 * ⑤ 静态门禁：测试文件内的子进程调用必须限时。
 *
 * ①②③④ 只能证明「封装本身可用」，阻止不了新代码绕过封装直接 spawnSync
 * （默认无超时，单个卡住就让整个文件永久等待）。把 REQ-20261115-002 的 A4
 * 做成可执行断言，避免口径随人漂移。
 */
describe('⑤ 门禁：测试子进程必须限时', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const TEST_DIRS = ['test', 'test/chat'];
  // 与 scripts/run-tests.mjs 同口径：只取目录下一层 *.test.ts。
  // 不能用递归扫描——`test` 递归已包含 `test/chat`，两个目录都列会重复计数、重复报错。
  const TEST_FILES = TEST_DIRS
    .map((rel) => path.join(ROOT, rel))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => path.join(dir, name)))
    .sort();
  // e2e 不归 run-tests 跑，但同样是「跑起来就可能挂住」的测试：
  // 允许直接 execFileSync（不强制封装），但必须显式限时
  const E2E_DIR = path.join(ROOT, 'test', 'e2e');
  const E2E_FILES = fs.existsSync(E2E_DIR)
    ? fs.readdirSync(E2E_DIR).filter((name) => name.endsWith('.mjs')).map((name) => path.join(E2E_DIR, name))
    : [];
  const LIMITED_FILES = [...TEST_FILES, ...E2E_FILES];

  it('扫描范围非空（规则失效时不得静默变绿）', () => {
    assert.ok(TEST_FILES.length >= 150, `应扫描到 >=150 个测试文件，实际 ${TEST_FILES.length}`);
    assert.ok(E2E_FILES.length >= 8, `应扫描到 >=8 个 e2e 文件，实际 ${E2E_FILES.length}`);
  });

  /**
   * 调用片段里是否声明了 timeout。
   *
   * 必须同时认三种写法：`timeout: 120_000`（对象字面量）、`timeout,`（shorthand，值在外部定义）、
   * `timeout }`（最后一个键）。只认 `timeout:` 会把 e2e 里常见的 shorthand 写法全判成缺失。
   */
  const hasTimeout = (text: string): boolean => /\btimeout\b\s*[,:}]/.test(text);

  it('不存在直调 execFileSync（必须走 execCli / execCommand 封装）', () => {
    const offenders: string[] = [];
    for (const file of TEST_FILES) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const hits = [...code.matchAll(/(?<![.\w$])execFileSync\s*\(/g)].length;
      if (hits > 0) offenders.push(`${path.relative(ROOT, file)}（${hits} 处）`);
    }
    assert.deepEqual(
      offenders,
      [],
      `以下文件直调 execFileSync（默认无超时，卡住即永久等待）。改用 test-config.ts 的 execCli / execCommand：\n${offenders.join('\n')}`,
    );
  });

  it('spawnSync / execFile / execFileAsync / execSync / exec 均带 timeout', () => {
    const missing: string[] = [];
    let total = 0;
    for (const file of LIMITED_FILES) {
      const raw = fs.readFileSync(file, 'utf8');
      for (const call of callSnippets(stripComments(raw))) {
        // 豁免只有两种：
        //  ① spawn —— child_process.spawn 本身没有 timeout 选项（不是偷懒：无法用统一参数限时），
        //     这类调用必须自行 kill 或等 exit 事件收尾；若卡住，由文件级 / e2e 超时兜底
        //  ② execFileSync —— 上一用例已禁止在 test/*.test.ts 里出现，e2e 里出现也必须带 timeout（不豁免）
        if (/^spawn\s*\(/.test(call.text)) continue;
        if (/^execFileSync\s*\(/.test(call.text)) {
          total += 1;
          if (!hasTimeout(call.text)) {
            const line = raw.slice(0, call.index).split('\n').length;
            missing.push(`${path.relative(ROOT, file)}:${line} → ${call.text.split('\n')[0].trim()}`);
          }
          continue;
        }
        total += 1;
        if (!hasTimeout(call.text)) {
          const line = raw.slice(0, call.index).split('\n').length;
          missing.push(`${path.relative(ROOT, file)}:${line} → ${call.text.split('\n')[0].trim()}`);
        }
      }
    }
    assert.ok(total >= 5, `应扫描到 >=5 处限时子进程调用，实际 ${total}（CALL_RE 可能已失效）`);
    assert.deepEqual(
      missing,
      [],
      `以下子进程调用缺少 timeout（用 execCli / execCommand 封装，或显式传 timeout）：\n${missing.join('\n')}`,
    );
  });
});
