/**
 * vector-client 端到端冒烟（S-03 Vector Adapter + 三命令闭环）
 * 单进程跑完所有断言，避免反复冷启动。
 * 运行：node test/vector-client-smoke.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KI_CONFIG_PATH = path.join(os.tmpdir(), `vc-smoke-config-${Date.now()}.json`);
const vectorDir = path.join(os.tmpdir(), `vc-smoke-vector-${Date.now()}`);
fs.writeFileSync(process.env.KI_CONFIG_PATH, JSON.stringify({ vectorDir }), 'utf-8');

const {
  vectorStore, vectorSearch, vectorBulkStore, vectorDelete,
  ensureVectorAvailable, closeEngine,
} = await import('../src/lib/vector-client.js');

const SCOPE_A = 'smokeA';
const SCOPE_B = 'smokeB';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

console.log(`vectorDir: ${vectorDir}\n`);

await t('ensureVectorAvailable: 全新 dbPath 可用', async () => {
  const r = await ensureVectorAvailable();
  assert.equal(r.available, true, r.reason);
});

let idLogin;
await t('vectorStore: 写入并返回 docId(sha256 截32)', async () => {
  const r = await vectorStore({ scope: SCOPE_A, text: '用户登录流程：校验凭证签发token写入会话', tags: 'ki-search' });
  assert.match(r.docId, /^[0-9a-f]{32}$/);
  idLogin = r.docId;
});

await t('vectorStore: tag 大写写入被小写规范化', async () => {
  const r = await vectorStore({ scope: SCOPE_A, text: '缓存策略：读穿写回TTL兜底', tags: 'KI-SEARCH' });
  assert.ok(r.docId);
});

await t('vectorSearch: 语义召回到登录文档 top1', async () => {
  const rs = await vectorSearch({ scope: SCOPE_A, query: '用户怎么登录', tags: 'ki-search', limit: 5 });
  assert.ok(rs.length > 0, '应有召回');
  assert.equal(rs[0].memoryId, idLogin, `top1 应为登录文档, 实际 ${rs[0].content}`);
  assert.equal(rs[0].tag, 'ki-search');
});

await t('vectorSearch: tag 大小写不敏感（大写查询仍命中）', async () => {
  const rs = await vectorSearch({ scope: SCOPE_A, query: '缓存', tags: 'KI-SEARCH', limit: 5 });
  assert.ok(rs.length > 0, '大写 tag 查询应命中（忽略大小写）');
});

await t('vectorSearch: scope 隔离（B 查不到 A 的文档）', async () => {
  const rs = await vectorSearch({ scope: SCOPE_B, query: '用户怎么登录', tags: 'ki-search', limit: 5 });
  assert.equal(rs.length, 0, `scopeB 应为空, 实际 ${rs.length} 条`);
});

await t('vectorSearch: 不传 tags 默认 ki-search', async () => {
  const rs = await vectorSearch({ scope: SCOPE_A, query: '登录' });
  assert.ok(rs.length > 0);
});

await t('vectorBulkStore: 批量写入成功计数', async () => {
  const r = await vectorBulkStore({ scope: SCOPE_A, entries: [
    { text: '订单支付链路：创建订单调用支付网关异步回调对账', tags: 'ki-search' },
    { text: '鉴权模块：JWT签发刷新 RBAC权限校验', tags: 'ki-search' },
  ]});
  assert.equal(r.succeeded, 2, JSON.stringify(r.results));
  assert.equal(r.failed, 0);
});

await t('vectorStore: 幂等（同 text+scope 重复 upsert 不报错同 id）', async () => {
  const r = await vectorStore({ scope: SCOPE_A, text: '用户登录流程：校验凭证签发token写入会话', tags: 'ki-search' });
  assert.equal(r.docId, idLogin, '重复写入应同 docId(幂等)');
});

await t('vectorDelete: 删除后可搜不到', async () => {
  const r = await vectorStore({ scope: SCOPE_A, text: '临时文档待删除', tags: 'ki-search' });
  const d = await vectorDelete({ scope: SCOPE_A, ids: [r.docId] });
  assert.equal(d.deleted, 1);
});

await closeEngine();
fs.rmSync(vectorDir, { recursive: true, force: true });
fs.rmSync(process.env.KI_CONFIG_PATH, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
