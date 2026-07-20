/**
 * zvec-engine-fixtures.mjs —— ZvecEngine 测试共享夹具
 *
 * 不以 .test.mjs 结尾，不会被 node --test 自动运行。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DIM = 4096;

/** 简单 hash 向量：相同文本 → 相同向量（L2 归一化，COSINE 自检索 top1≈1） */
export function hashVector(text, dim = DIM) {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[(text.charCodeAt(i) * 31 + i) % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** 固定 mock EmbeddingProvider（不触网） */
export const mockEmbedding = {
  dimension: DIM,
  embed: async (texts) => texts.map((t) => hashVector(t)),
};

/** 标准建库配置（含 jieba FTS + tag/content/score/flag 标量字段） */
export function makeConfig(dbPath, overrides = {}) {
  const config = {
    dbPath,
    collection: {
      name: 'test_col',
      denseField: 'dense',
      dimension: DIM,
      metric: 'COSINE',
      scalarFields: [
        { name: 'tag', dataType: 'STRING', indexed: true },
        { name: 'content', dataType: 'STRING' },
        { name: 'score', dataType: 'FLOAT' },
        { name: 'flag', dataType: 'BOOL' },
      ],
      fts: { field: 'content', tokenizer: 'jieba' },
    },
    embedding: mockEmbedding,
  };
  if (overrides.collection) {
    config.collection = { ...config.collection, ...overrides.collection };
  }
  delete overrides.collection;
  return { ...config, ...overrides };
}

/** 无 FTS 的建库配置 */
export function makeConfigNoFts(dbPath) {
  return makeConfig(dbPath, {
    collection: { fts: undefined, scalarFields: [{ name: 'tag', dataType: 'STRING', indexed: true }] },
  });
}

/** 生成独立临时 dbPath */
export function makeDbPath(prefix = 'zvec-test-') {
  return mkdtempSync(join(tmpdir(), prefix)) + '/db';
}
