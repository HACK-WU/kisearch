/**
 * executeSearch · 向量服务不可用时降级全文（2026-11-02）
 *
 * 背景：`ki mcp` 改为「embedding 不可用也允许启动」后，降级态成了常态。原实现在
 * `ensureVectorAvailable` 失败时直接返回 `{ ok:false, error:'向量检索暂不可用…' }`：
 * 用户明明有 FTS 索引，CLI 默认搜索与 MCP 检索工具却整体报错 —— Web 端不受影响
 * （SearchPage 在 vectorAvailable=false 时改发 mode:'fulltext'），于是"降级"只在页面上成立。
 *
 * 契约（本文件锁住的）：
 *   1) 向量不可用（本用例用「未配置 apiKey」触发）不返回 ok:false；
 *   2) 返回 `mode: 'fulltext'` + `degraded: true` + `degradedReason`（禁止静默降级，且原因要能指向修复）。
 *
 * 运行：npx jiti test/search-vector-unavailable-fallback.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../src/lib/config.js';
import { closeEngine } from '../src/lib/vector-client.js';
import { executeSearch } from '../src/search.js';

const SCOPE = 'team-a';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vec-unavail-'));
const configPath = path.join(tmpRoot, 'config.yaml');
fs.writeFileSync(
  configPath,
  [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    'scopeMode: default',
    'scopes:',
    `  ${SCOPE}: {}`,
    'embedding:',
    // 引用不存在的环境变量 ⇒ embedding.apiKey 解析为空 ⇒ 「向量不可用」的典型形态
    '  apiKey: ${KI_TEST_ABSENT_EMBEDDING_KEY}',
    '  dimension: 4096',
    '',
  ].join('\n'),
  'utf-8',
);
process.env.KI_CONFIG_PATH = configPath;
resetConfigCache();

describe('executeSearch · 向量服务不可用 → 降级全文', () => {
  before(() => {
    // 不需要建任何 Collection：本用例要证的正是"没有向量能力时也能给出全文答案"
  });

  after(async () => {
    await closeEngine();
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('未配置 apiKey 时仍返回 ok:true，并标记为全文降级', async () => {
    const res = await executeSearch({ scope: SCOPE, query: '全文索引', limit: 3 });
    assert.equal(res.ok, true, '向量不可用不得让全文检索一起不可用');
    const r = res as {
      ok: true;
      mode?: string;
      degraded?: boolean;
      degradedReason?: string;
      results?: unknown[];
    };
    assert.equal(r.mode, 'fulltext');
    assert.equal(r.degraded, true, '禁止静默降级');
    assert.match(r.degradedReason ?? '', /apiKey|向量检索不可用/);
    assert.ok(Array.isArray(r.results), '必须返回 results 数组（可为空），而不是错误对象');
  });
});
