/**
 * test/coordinator-read-lane.test.ts
 *
 * REQ-20261009-003 S-01（队列分层）回归：
 *   ① 纯元数据读（kind='read'）不被同 scope 的 engine-only 长任务阻塞（现场 25s 超时的根因）；
 *   ② 普通写任务仍与同 scope 长任务串行（不回归旧语义）；
 *   ③ 「元数据提交窗口」（runMetadataCommit）内读任务等待，窗口结束立刻放行（选项 b）；
 *   ④ 其他 scope 完全不受影响；
 *   ⑤ read 仍受 maxWorkers 上限约束（不绕过并发保护）；
 *   ⑥ read 与"短写"任务互斥（P0 修复：不得与 doc/edit 这类元数据写并发）；
 *   ⑦ engine-only 长任务不阻塞 read（导入场景）。
 *   ⑧ 提交窗口可重入：内层（同步）窗口退出不提前放开读。
 *   ⑨ ★ P0 回归：**未显式传 kind** 的 import 自动判为 engine-only —— 真实入口
 *      （daemon-rpc / mcp-http-api.runImportJob）都不传该参数，此前 HTTP 入口
 *      漏标导致 Web 端导入期间 `/doc/list` 仍被串行（现场 25s 超时）。
 *
 * 运行：npx jiti test/coordinator-read-lane.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationCoordinator, kindForOperation } from '../src/lib/operation-coordinator.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const req = (scope: string, operation = 'op') => ({ operation, params: { scope } });

test('① read 不被同 scope 的 engine-only 长任务阻塞（现场 25s 超时的根因）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's1';
  let longDone = false;
  const long = c.submit(req(scope, 'import'), async () => {
    await sleep(600);
    longDone = true;
    return 'long';
  }, [scope], 'engine-only');
  await sleep(30);

  const t0 = Date.now();
  const read = await c.submit(req(scope, 'doc-list-api'), () => 'read', [scope], 'read');
  const waitMs = Date.now() - t0;

  assert.equal(read.result, 'read');
  assert.equal(longDone, false, '读任务应在长任务结束前返回');
  assert.ok(waitMs < 120, `读等待应 <120ms，实际 ${waitMs}ms`);
  await long;
});

test('② write 仍与同 scope 长任务串行（不回归）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's2';
  const long = c.submit(req(scope, 'import'), () => sleep(400), [scope], 'engine-only');
  await sleep(30);

  const t0 = Date.now();
  await c.submit(req(scope, 'tag-list'), () => 'w', [scope], 'write');
  assert.ok(Date.now() - t0 >= 300, '写任务必须等长任务结束');
  await long;
});

test('③ 元数据提交窗口内读等待、窗口结束立即放行（选项 b）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's3';
  const commit = c.runMetadataCommit(scope, () => sleep(400));
  await sleep(30);

  const t0 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r', [scope], 'read');
  const duringMs = Date.now() - t0;
  assert.ok(duringMs >= 200, `窗口内读应等待，实际 ${duringMs}ms`);
  await commit;

  const t1 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r2', [scope], 'read');
  assert.ok(Date.now() - t1 < 120, '窗口结束后读应立即可跑');
});

test('④ 其他 scope 不受影响', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const long = c.submit(req('busy'), () => sleep(400), ['busy'], 'write');
  await sleep(30);
  const t0 = Date.now();
  await c.submit(req('other', 'doc-list-api'), () => 'ok', ['other'], 'read');
  assert.ok(Date.now() - t0 < 120, '无关 scope 的读不应被拖慢');
  await long;
});

test('⑤ read 任务仍受 maxWorkers 上限约束（不绕过并发保护）', async () => {
  const c = new OperationCoordinator(1, 5_000);
  const long = c.submit(req('s5', 'import'), () => sleep(300), ['s5'], 'engine-only');
  await sleep(30);
  const t0 = Date.now();
  await c.submit(req('s5', 'doc-list-api'), () => 'r', ['s5'], 'read');
  assert.ok(Date.now() - t0 >= 200, 'maxWorkers=1 时读也需等空位（可旁路 engine-only，但仍排队）');
  await long;
});

test('⑥ read 与"短写"任务互斥（P0 修复：不得与 doc/edit 并发）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's6';
  const write = c.submit(req(scope, 'doc-edit-write'), () => sleep(400), [scope], 'write');
  await sleep(30);
  const t0 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r', [scope], 'read');
  assert.ok(Date.now() - t0 >= 300, '读必须等短写结束（否则可能读到"列表里在、点开 404"）');
  await write;
});

test('⑦ engine-only 与 write 仍互斥；read 可旁路 engine-only（并行不重复排队）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's7';
  const engineLong = c.submit(req(scope, 'import'), () => sleep(300), [scope], 'engine-only');
  await sleep(20);

  // write 与 engine-only 互斥（旧语义不变）：必须排在 engine-only 之后
  const tWrite = Date.now();
  const write = c.submit(req(scope, 'doc-edit-write'), () => 'w', [scope], 'write');

  // read 可旁路 engine-only：立即可跑（此刻 running=1 但全是 engine-only）
  const tRead = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r', [scope], 'read');
  const readWaitMs = Date.now() - tRead;
  assert.ok(readWaitMs < 120, `read 应立即执行，实际 ${readWaitMs}ms`);

  await engineLong;
  await write;
  assert.ok(Date.now() - tWrite >= 250, 'write 必须等 engine-only 结束（旧语义不回归）');
});

test('⑧ 提交窗口可重入：内层（同步）窗口退出不提前放开读', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's8';
  let innerExited = false;
  const outer = c.runMetadataCommit(scope, async () => {
    await sleep(150);
    c.withMetadataCommitSync(scope, () => { /* 模拟回滚路径的同步窗口 */ });
    innerExited = true;
    await sleep(250); // 内层已退出，但外层窗口仍在
  });
  await sleep(30);

  const t0 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r', [scope], 'read');
  const waitMs = Date.now() - t0;
  await outer;

  assert.equal(innerExited, true);
  assert.ok(waitMs >= 300, `内层退出后窗口应仍有效，实际 ${waitMs}ms`);

  const t1 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r2', [scope], 'read');
  assert.ok(Date.now() - t1 < 120, '窗口彻底结束后读应立即可跑');
});

test('⑨ ★ 未显式传 kind 的 import 自动判为 engine-only（真实入口形状，防再次漏改）', async () => {
  // 真实入口（daemon-rpc / mcp-http-api.runImportJob）都**不传**第 4 个参数，kind 由
  // kindForOperation(request.operation) 推导。上一次事故正是 HTTP 入口漏标：若缺省
  // 退回 'write'，Web 端导入期间 /doc/list 会再次被串行（现场 25s 超时的形态）。
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's9';
  const long = c.submit(req(scope, 'import'), () => sleep(400), [scope]);
  await sleep(30);

  const t0 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'read', [scope], 'read');
  const waitMs = Date.now() - t0;
  assert.ok(waitMs < 120, `未传 kind 的 import 不得阻塞读（实际 ${waitMs}ms）`);
  await long;

  // 推导表：import 之外一律保守为 write（rebuild-vector 等需先把元数据写纳入提交窗口）
  assert.equal(kindForOperation('import'), 'engine-only');
  assert.equal(kindForOperation('rebuild-vector'), 'write');
  assert.equal(kindForOperation('restore-snapshot'), 'write');
  assert.equal(kindForOperation('sync-relation'), 'write');
  assert.equal(kindForOperation(undefined), 'write');
});
