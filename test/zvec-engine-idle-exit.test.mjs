/**
 * zvec-engine-idle-exit.test.mjs —— 事件 #109 回归：引擎空闲时不得把进程吊住。
 *
 * 背景：worker 原先是 ref 的，调试脚本 / 短命令忘记 `closeEngine()` 时进程会永久挂住，
 * 并持续持有该 collection 的 LOCK（实测只读脚本 87s 不退、另一个挂 3 天）。
 * 修复后：有在途请求 ref、pending 清空且 open 时 unref → 空闲进程可自然退出。
 *
 * 用子进程验证真实退出行为（在本进程里测不出"事件循环是否被 worker 保活"）。
 * 依赖 dist（npm run build），与其它 zvec-engine 测试一致。
 *
 * 运行：node --test test/zvec-engine-idle-exit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDbPath } from './zvec-engine-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_URL = pathToFileURL(path.join(HERE, '../dist/zvec-engine/index.js')).href;
const FIXTURES_URL = pathToFileURL(path.join(HERE, 'zvec-engine-fixtures.mjs')).href;
/** 子进程从启动到建库完成的上限；超时视为"被 worker 吊住" */
const EXIT_TIMEOUT_MS = 20_000;

test('#109 忘记 close 时（空闲引擎）进程仍能自然退出', async (t) => {
  const dbPath = makeDbPath('zvec-idle-exit-');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  // 故意不调用 engine.close()：完整复现"脚本调完引擎就结束、没有收尾"。
  // 必须落到临时 .mjs 文件再执行：`node --input-type=module -e` 会把该参数带进
  // process.execArgv，worker 线程继承后直接 ERR_INPUT_TYPE_NOT_ALLOWED。
  const scriptPath = path.join(os.tmpdir(), `ki-idle-exit-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(scriptPath, `
    const { ZvecEngine } = await import(process.env.KI_TEST_DIST_URL);
    const { makeConfigNoFts } = await import(process.env.KI_TEST_FIXTURES_URL);
    const engine = await ZvecEngine.create(makeConfigNoFts(process.env.KI_TEST_DB_PATH));
    await engine.upsert([{ id: 'x', text: 'hello world', fields: { tag: 'A' } }]);
    const docs = await engine.fetch(['x']);
    console.log('READY docs=' + docs.length);
  `, 'utf8');
  t.after(() => fs.rmSync(scriptPath, { force: true }));

  const child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      KI_TEST_DIST_URL: DIST_URL,
      KI_TEST_FIXTURES_URL: FIXTURES_URL,
      KI_TEST_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  // 用 close 而非 exit：exit 可能早于 stdio 读完，导致断言拿到空 stdout
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
  });
  const exit = await Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
    timeout,
  ]);
  clearTimeout(timeoutId);

  if (exit === null) {
    child.kill('SIGKILL');
    assert.fail(
      `进程在 ${EXIT_TIMEOUT_MS}ms 内未退出：worker 仍在保活事件循环（#109 回归）。\n`
      + `stdout=${stdout}\nstderr=${stderr}`,
    );
  }

  // 在途写/读必须真的跑完，不能被 unref 截断
  assert.match(stdout, /READY docs=1/, `读写结果不得丢失，stdout=${stdout}`);
  assert.equal(exit.signal, null, `不应被信号杀死，signal=${exit.signal}`);
  assert.equal(exit.code, 0, `应正常退出，code=${exit.code}\nstderr=${stderr}`);
});
