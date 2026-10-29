/**
 * rebuild-vector-stop-summary.test.ts —— P0 输出治理：重建链路的同类契约
 *
 * 与 batch-vectorize-stop.test.ts 同源问题、不同链路：`ki restore <scope> --rebuild-vector`
 * 在系统性故障后也会把「剩余 entry」逐条展开（原实现按 chunk 数产出上万条同因错误）。
 * 本套件固化：
 *   1. 剩余条目只出 **1 条汇总**（数量由 stats.notProcessed 承载）；
 *   2. 停止批次的失败明细只出 **1 条汇总**（带样例），不再逐条；
 *   3. 停止后不再调用 bulkStore（只调用 1 次）。
 *
 * 运行：npx jiti test/rebuild-vector-stop-summary.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { rebuildScopeVectors } from '../src/lib/rebuild-vector.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), 'temp', 'rebuild-stop-summary-'));

// 断言失败也要收拾干净：环境变量与临时目录都不留给后续套件（否则会污染 temp/ 与后续用例的 config 解析）。
after(() => {
  delete process.env.KI_CONFIG_PATH;
  resetConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
const DOC_COUNT = 350;

const STOP_REASON = {
  kind: 'provider-unavailable',
  code: 'TIMEOUT',
  phase: 'embedding',
  reason: 'dashscope /embeddings timeout after 60000ms',
} as const;

function setupScope(scope: string): { configPath: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `cfg-${scope}-`));
  const dataDir = path.join(dir, 'kb');
  const scopeDir = path.join(dataDir, scope);
  const configPath = path.join(dir, 'config.yaml');
  fs.mkdirSync(path.join(scopeDir, 'Wiki'), { recursive: true });
  const index: Record<string, string> = {};
  for (let i = 0; i < DOC_COUNT; i++) index[`doc-${String(i).padStart(3, '0')}`] = `文档 ${i} 摘要正文`;
  fs.writeFileSync(path.join(scopeDir, 'Wiki', 'index.json'), JSON.stringify(index), 'utf-8');
  fs.writeFileSync(
    path.join(scopeDir, 'relations-cache.json'),
    JSON.stringify({ groups: { Wiki: { hot_relations: Object.keys(index).map((k) => ({ text: k, sourcePath: `Wiki/${k}.md` })) } } }),
    'utf-8',
  );
  fs.writeFileSync(
    configPath,
    `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\n`
    + `embedding:\n  provider: dashscope\n  baseURL: https://example.invalid/v1\n  model: fake\n  dimension: 1024\n  apiKey: fake\n`
    + `scopes:\n  ${scope}: {}\n`,
    'utf-8',
  );
  return { configPath };
}

describe('P0：重建链路系统性停止后的 errors 汇总', () => {
  it('首批停止 → errors 只含汇总条目（不再逐条），stats.notProcessed 承载总数', async () => {
    const scope = 'stop-summary';
    const { configPath } = setupScope(scope);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    let calls = 0;
    const result = await rebuildScopeVectors(scope, {
      bulkStore: (async (params: { entries: unknown[] }) => {
        calls++;
        return {
          total: params.entries.length,
          succeeded: 0,
          failed: params.entries.length,
          notProcessed: params.entries.length,
          stopReason: STOP_REASON,
          results: params.entries.map((_, i) => ({ index: i, success: false, error: STOP_REASON.reason })),
        } as never;
      }) as never,
      deleteScope: (async () => ({ deleted: 0 })) as never,
      collectionDimension: (async () => undefined) as never,
    });

    // 总条目 = content 350 + relation 350 + path 1
    const total = result.stats.content + result.stats.relation + result.stats.path;
    assert.equal(total, 701);
    assert.equal(calls, 1, '系统性停止后不得再提交后续批次');
    assert.equal(result.stats.notProcessed, total, '数量由 stats.notProcessed 承载');

    const notProcessed = result.errors.filter((e) => e.error.includes('系统性向量故障后未处理'));
    assert.equal(notProcessed.length, 1, '剩余条目只允许 1 条汇总');
    assert.match(notProcessed[0].error, new RegExp(`未处理 ${total - 200} 条`));

    const batchSummary = result.errors.filter((e) => e.error.includes('系统性故障批次中有'));
    assert.equal(batchSummary.length, 1, '停止批的失败明细同样只留 1 条汇总');
    assert.match(batchSummary[0].error, /样例：/);

    assert.ok(result.errors.length <= 5, `errors 应与批数同量级而非与条目数同量级，实际 ${result.errors.length}`);

    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('普通失败（无 stopReason）同样设逐条上限：701 条失败 → 50 条明细 + 1 条汇总', async () => {
    const scope = 'plain-fail-cap';
    const { configPath } = setupScope(scope);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    const result = await rebuildScopeVectors(scope, {
      bulkStore: (async (params: { entries: unknown[] }) => ({
        total: params.entries.length,
        succeeded: 0,
        failed: params.entries.length,
        results: params.entries.map((_, i) => ({ index: i, success: false, error: '批量 400：坏文本' })),
      })) as never,
      deleteScope: (async () => ({ deleted: 0 })) as never,
      collectionDimension: (async () => undefined) as never,
    });

    const truncated = result.errors.filter((e) => e.path === '<truncated>');
    assert.equal(truncated.length, 1);
    assert.equal(result.errors.filter((e) => e.type === 'vectorize').length, 51, '50 条明细 + 1 条汇总');
    assert.match(truncated[0].error, /另有 651 条失败明细未逐条列出/);
  });
});
