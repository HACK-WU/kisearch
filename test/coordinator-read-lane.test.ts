/**
 * test/coordinator-read-lane.test.ts
 *
 * REQ-20261009-003 S-01（队列分层）回归：
 *   ① 纯元数据读（kind='read'）不被同 scope 的 engine-only 长任务阻塞（现场 25s 超时的根因）；
 *   ② 普通写任务仍与同 scope 长任务串行（不回归旧语义）；
 *   ③ 「元数据提交窗口」（runMetadataCommit）内读任务等待，窗口结束立刻放行（选项 b）；
 *   ④ 其他 scope 完全不受影响；
 *   ⑤ read 仍受 maxWorkers 上限约束（不绕过并发保护）；
 *   ⑥ ★ S-04 I4（2026-10-10，Q6 拍板）：read 与"短写"**并行**（不再互斥）——前提是
 *      写侧不变量 I1 已落实（分片可见 ⇒ KB 可取；删除路径改为分片先删、KB 后删），
 *      并发读回归见 `test/read-write-concurrency.test.ts`（含旧顺序对照臂）；
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
import { OperationCoordinator, kindForOperation, kindForMcpToolNames } from '../src/lib/operation-coordinator.js';

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

test('⑥ read 与"短写"并行（S-04 I4：不再互斥；安全由写侧不变量保证）', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's6';
  const write = c.submit(req(scope, 'doc-edit-write'), () => sleep(400), [scope], 'write');
  await sleep(30);
  const t0 = Date.now();
  await c.submit(req(scope, 'doc-list-api'), () => 'r', [scope], 'read');
  const waitMs = Date.now() - t0;
  // I4（Q6 拍板）：读不再等短写 —— 现场二"一个挂住的请求把整库读挡死 >10 分钟"由此消除。
  // 并发安全由 I1/I2 保证：删除类路径已改为「分片先删 → KB 后删」、两次写紧邻入窗；
  // 并发读回归见 test/read-write-concurrency.test.ts（对照臂必须检出 DIR E）。
  assert.ok(waitMs < 120, `read 应立即执行（I4：只与提交窗口互斥），实际 ${waitMs}ms`);
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
  // ★ tag-list 必须保持 write（tags 要打开 zvec，不得与写并发）：
  //   R8 二期的 e2e「降级返回后 /api/doc/list <1s」正是靠这条互斥证明队列槽已放行；
  //   若有人给它加 'read' 特判，e2e 会静默失去证明力（read 无需等 write 槽释放）。
  assert.equal(kindForOperation('tag-list'), 'write');
});

/**
 * ⑩ 2026-10-13 现场缺陷（浏览页正文被导入阻塞）的登记回归：
 *   读类 operation / MCP 读工具必须以 `read` 入队（不传 kind 时也如此）。
 *   背景：MCP 通道此前整体缺省 `write` ⇒ `ki_get_module_info`（浏览页打开文档）
 *   在导入向量化期间被排到队尾（隔离实测 8745ms，同时刻 /api/doc/list 3ms）。
 */
test('⑩ 读类 operation 与 MCP 读工具登记为 read（防缺省落回 write）', () => {
  // CLI / daemon 读命令（daemon-rpc 按 operation 名推导，不传 kind）
  assert.equal(kindForOperation('get-module-info'), 'read');
  assert.equal(kindForOperation('get-module-info-batch'), 'read');
  assert.equal(kindForOperation('query-group'), 'read');
  // ⚠️ CLI `ki doc list`（operation='doc-list'）刻意保持 write：它是向量层管理面扫描
  //（打开引擎列举向量文档），结果在导入期间本就是中间态；浏览页用的是 doc-list-api（已 read）。
  assert.equal(kindForOperation('doc-list'), 'write');
  // HTTP 只读接口（mcp-http-api 显式传 'read'，登记作双保险）
  assert.equal(kindForOperation('doc-get-api'), 'read');
  assert.equal(kindForOperation('asset-read-api'), 'read');
  // chat 通道（operation 形如 chat-mcp-<tool>，与 MCP 通道共用白名单）
  assert.equal(kindForOperation('chat-mcp-ki_get_module_info'), 'read');
  assert.equal(kindForOperation('chat-mcp-ki_query_group'), 'read');
  // 检索：2026-10-13 用户拍板放开为 read（导入期间可搜；结果中间态由降级机制兜底）
  assert.equal(kindForOperation('chat-mcp-ki_search'), 'read');
  assert.equal(kindForOperation('search'), 'read');
  // ⚠️ 仍保持 write 的重读 / 管理面读（全库扫描，结果在导入期间不可信 + 非交互刚需）
  assert.equal(kindForOperation('chat-mcp-ki_tag_list'), 'write');
  assert.equal(kindForOperation('tag-list'), 'write');
  assert.equal(kindForOperation('chat-mcp-ki_sync_relation'), 'write');
  // 前缀相似但非白名单的 operation 不得误判
  assert.equal(kindForOperation('chat-mcp-ki_get_module_info_x'), 'write');
});

test('⑪ MCP 工具批的 kind：全读才 read，混入写工具整批回退 write', () => {
  assert.equal(kindForMcpToolNames(['ki_get_module_info']), 'read');
  assert.equal(kindForMcpToolNames(['ki_get_module_info', 'ki_query_group']), 'read');
  // 只读通道工具（不占 scope）与读工具混合仍是 read
  assert.equal(kindForMcpToolNames(['ki_scope_list']), 'read');
  assert.equal(kindForMcpToolNames(['ki_scope_list', 'ki_get_module_info']), 'read');
  // ★ 混入写工具必须整批回退：否则写会绕过与长任务/短写的互斥
  assert.equal(kindForMcpToolNames(['ki_get_module_info', 'ki_sync_relation']), 'write');
  assert.equal(kindForMcpToolNames(['ki_search', 'ki_sync_relation']), 'write');
  // 检索自身是读（放开后可与导入并行）
  assert.equal(kindForMcpToolNames(['ki_search']), 'read');
  assert.equal(kindForMcpToolNames(['ki_search', 'ki_get_module_info']), 'read');
  // tags 扫描仍是 write
  assert.equal(kindForMcpToolNames(['ki_tag_list']), 'write');
  // 非 tools/call（undefined 占位）或空批：保守回退 write
  assert.equal(kindForMcpToolNames([]), 'write');
  assert.equal(kindForMcpToolNames([undefined]), 'write');
  assert.equal(kindForMcpToolNames([undefined, 'ki_get_module_info']), 'read');
});

test('⑫ 行为：以 read 登记的 daemon 读命令（不传 kind）不被导入长任务阻塞', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's12';
  const long = c.submit(req(scope, 'import'), () => sleep(400), [scope]);
  await sleep(30);

  // 模拟 daemon-rpc：只传 operation 名、不传 kind
  const t0 = Date.now();
  await c.submit(req(scope, 'get-module-info'), () => 'read', [scope]);
  const waitMs = Date.now() - t0;
  assert.ok(waitMs < 120, `get-module-info 应立即执行，实际 ${waitMs}ms`);

  // ⚠️ 安全性：读与长任务并行时，读**不得**绕过「元数据提交窗口」
  const commit = c.runMetadataCommit(scope, () => sleep(200));
  await sleep(20);
  const t1 = Date.now();
  await c.submit(req(scope, 'query-group'), () => 'read', [scope]);
  assert.ok(Date.now() - t1 >= 100, '窗口内读仍须等待（写侧不变量 I2 不回归）');
  await commit;
  await long;
});

test('⑬ 行为：检索（read）在导入期间立即可执行；tag-list（write）仍排队', async () => {
  const c = new OperationCoordinator(4, 5_000);
  const scope = 's13';
  const long = c.submit(req(scope, 'import'), () => sleep(400), [scope]);
  await sleep(30);

  // 不传 kind ⇒ 走 kindForOperation('search') = read（2026-10-13 放开，导入期间可搜）
  const t0 = Date.now();
  await c.submit(req(scope, 'search'), () => 'r', [scope]);
  const searchWait = Date.now() - t0;
  assert.ok(searchWait < 120, `search 应立即执行，实际 ${searchWait}ms`);

  // ⚠️ tag-list 刻意保持 write：必须等导入长任务结束（保守语义不回归）
  const t1 = Date.now();
  const tagP = c.submit(req(scope, 'tag-list'), () => 'w', [scope]);
  await long;
  await tagP;
  assert.ok(Date.now() - t1 >= 300, 'tag-list 必须等导入结束');
});
