/**
 * executeSearch · 向量库无任何 tag 时回退全文（2026-11-02）
 *
 * 背景：`ki mcp` 改为「embedding 不可用也允许启动」后，最常见的库形态变成
 * 「文档只有全文索引」（`import --no-vector`，或密钥无效期间导入的那批）。
 *
 * 原实现：默认路径（未传 --tags）先用 `vectorListTags` 取 dense 集合的 tag，拿到空数组
 * 就 `raw = []` 直接返回 —— 既不查全文，也不打 degraded。用户看到"搜不到"却没有任何
 * 可诊断信息，CLI 默认调用下"至少能用全文检索"并不成立（只有显式 `--mode fulltext` 才行）。
 *
 * 契约（本文件锁住的）：
 *   1) tag 为空时不返回空结果，而是走全文检索路径；
 *   2) 返回 `mode: 'fulltext'`（消费方据此知道分数尺度是 BM25 而非混合 RRF）；
 *   3) 返回 `degraded: true` + `degradedReason`（禁止静默降级）。
 *
 * 运行：npx jiti test/search-empty-tag-fallback.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ZvecEngine } from '../dist/zvec-engine/index.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { ensureVectorLayout, getScopeCollectionPath } from '../src/lib/scope-collection.js';
import { closeEngine } from '../src/lib/vector-client.js';
import { executeSearch } from '../src/search.js';

const DIM = 4;
const SCOPE = 'team-a';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-empty-tag-'));
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
    // provider 构造要求 apiKey 非空；本用例不会触发任何真实请求（dense 集合为空 ⇒ 不生成查询向量）
    '  apiKey: test-key-not-used',
    `  dimension: ${DIM}`,
    '',
  ].join('\n'),
  'utf-8',
);
process.env.KI_CONFIG_PATH = configPath;
resetConfigCache();

describe('executeSearch · 向量库无 tag → 回退全文', () => {
  before(async () => {
    const config = loadConfig();
    ensureVectorLayout(config);
    // 只建空集合（**不写任何 dense 文档**）：模拟"库内文档全部是 FTS-only"的形态
    const engine = await ZvecEngine.create({
      dbPath: getScopeCollectionPath(config, SCOPE),
      collection: {
        name: 'kisearch',
        denseField: 'dense',
        dimension: DIM,
        metric: 'COSINE',
        scalarFields: [
          { name: 'tag', dataType: 'STRING', indexed: true },
          { name: 'scope', dataType: 'STRING', indexed: true },
          { name: 'group', dataType: 'STRING', indexed: true },
          { name: 'content', dataType: 'STRING' },
        ],
        fts: { field: 'content', tokenizer: 'jieba' },
      },
      embedding: { dimension: DIM, embed: async () => [[0, 0, 0, 0]] },
    });
    await engine.close();
  });

  after(async () => {
    await closeEngine();
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('默认（hybrid、未传 tags）不再返回空结果，而是标记降级并走全文', async () => {
    const res = await executeSearch({ scope: SCOPE, query: '降级验证', limit: 3 });
    assert.equal(res.ok, true);
    const r = res as {
      ok: true;
      mode?: string;
      degraded?: boolean;
      degradedReason?: string;
    };
    assert.equal(r.mode, 'fulltext', '必须按全文口径返回，消费方据此判断分数尺度');
    assert.equal(r.degraded, true, '禁止静默降级');
    assert.match(r.degradedReason ?? '', /全文检索/);
  });
});
