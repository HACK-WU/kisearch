/**
 * vector-count-scan-limit.test.ts —— S0-1（REQ-20260930-002）向量计数/标签扫描 10k 上限回归
 *
 * 修复前行为：vectorCountScope 固定 listIds(10,000) 长度 → 10,500 条时低报 10,000
 * （scope 删除/clear 预告与 rebuild 进度基准随之失真）；vectorListTags 同理
 * scanned=10,000、truncated:true，标签计数不完整。
 * 修复后：无 tags 计数走 info().docCount（O(1) 精确，Collection 按 scope 独立）；
 * 带 tags 倍增取全；vectorListTags 默认倍增取全，显式 scanLimit 仍为硬上限。
 *
 * 真实 zvec 引擎 + 临时 KI_CONFIG_PATH（独立 vectorDir，不触 7423 daemon 锁）；
 * 种子数据用预计算向量 upsert（不走 embedding，离线可跑）。
 *
 * 运行：npx jiti test/vector-count-scan-limit.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIM = 64;
const TOTAL = 10_500;            // > LIST_ALL_LIMIT(10,000)，触发旧缺陷
const BULK_TAG_COUNT = 10_400;   // > 10,000，触发带 tags 计数的倍增路径
const DEFAULT_TAG_COUNT = TOTAL - BULK_TAG_COUNT; // 100

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-s01-count-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  vectorDir: path.join(tmpDir, 'vector'),
  dataDir: path.join(tmpDir, 'kb'),
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-Embedding-8B',
    dimension: DIM,
    // 不触网：种子走预计算向量，计数/标签/删除路径均无 embedding 调用
    apiKey: 'sk-s01-offline-dummy',
  },
  scopes: { default: {} },
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

const SCOPE = 's01test';

let vc: typeof import('../src/lib/vector-client.js');

function tinyVector(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i % DIM] = 1;
  v[(i * 7 + 3) % DIM] = 0.5;
  return v;
}

before(async () => {
  vc = await import('../src/lib/vector-client.js');
  // getEngine 首次调用创建 Collection（schema 来自 buildCreateConfig，dimension=DIM）
  const engine = await vc.getEngine(SCOPE);
  const BATCH = 500;
  for (let i = 0; i < TOTAL; i += BATCH) {
    const docs = Array.from({ length: Math.min(BATCH, TOTAL - i) }, (_, j) => {
      const idx = i + j;
      const tag = idx < BULK_TAG_COUNT ? 'bulk-tag' : 'ki-search';
      return {
        id: `s01-${idx}`,
        vector: tinyVector(idx),
        fields: {
          tag,
          scope: SCOPE,
          group: 'g',
          content: `s01 seed ${idx}`,
        },
      };
    });
    const res = await engine.upsert(docs);
    assert.equal(res.failed, 0, `种子 upsert 批 ${i} 不应有失败`);
  }
});

after(async () => {
  await vc.closeEngine();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('S0-1：向量计数与标签扫描不受 10,000 上限低报', () => {
  it('vectorCountScope 无 tags：10,500 条 → 精确 10,500（旧代码低报 10,000）', async () => {
    const count = await vc.vectorCountScope({ scope: SCOPE });
    assert.equal(count, TOTAL);
  });

  it('vectorCountScope 带 tags：匹配 10,400 条 → 倍增取全精确 10,400', async () => {
    const count = await vc.vectorCountScope({ scope: SCOPE, tags: ['bulk-tag'] });
    assert.equal(count, BULK_TAG_COUNT);
  });

  it('vectorListTags 默认：scanned=10,500、truncated=false、两标签计数完整', async () => {
    const { tags, scanned, truncated } = await vc.vectorListTags({ scope: SCOPE });
    assert.equal(scanned, TOTAL);
    assert.equal(truncated, false);
    const byName = new Map(tags.map((t) => [t.tag, t.count]));
    assert.equal(byName.get('bulk-tag'), BULK_TAG_COUNT);
    assert.equal(byName.get('ki-search'), DEFAULT_TAG_COUNT);
  });

  it('vectorListTags 显式 scanLimit=5000：仍是硬上限（scanned=5000, truncated:true）', async () => {
    const { scanned, truncated } = await vc.vectorListTags({ scope: SCOPE, scanLimit: 5000 });
    assert.equal(scanned, 5000);
    assert.equal(truncated, true);
  });

  it('删除预告口径：vectorCountScope 与 vectorDeleteScope 实际删除条数一致', async () => {
    const preview = await vc.vectorCountScope({ scope: SCOPE });
    const del = await vc.vectorDeleteScope({ scope: SCOPE });
    assert.equal(del.deleted, preview, '预告条数应与实际删除一致');
    assert.equal(del.remaining, 0);
    assert.equal(await vc.vectorCountScope({ scope: SCOPE }), 0, '删除后计数归零');
  });
});
