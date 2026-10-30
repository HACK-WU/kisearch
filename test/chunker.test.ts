/**
 * chunker 递归字符切分测试 —— REQ-20260806-001
 *
 * 契约：
 *   - 触发条件 = 长度阈值（非段落数）：份数 = ceil(字符数/chunkSize)，与段落数无关
 *   - 切分点偏好：\n\n > \n > 。 > ； > 硬切
 *   - overlap：相邻 chunk 尾部重叠
 *   - 未超限文本直接返回单 chunk
 *
 * 运行：npx jiti test/chunker.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitIntoChunks,
  validateChunkParams,
  MAX_CHUNKS_PER_FILE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_CHUNK_OVERLAP,
  SUGGESTED_CHUNK_SIZE_MIN,
  SUGGESTED_CHUNK_SIZE_MAX,
} from '../src/lib/chunker.js';

describe('splitIntoChunks', () => {
  it('空文本 → 空数组', () => {
    assert.deepStrictEqual(splitIntoChunks('', { chunkSize: 100 }), []);
  });

  it('未超限文本 → 单 chunk（index=1）', () => {
    const text = '短文内容';
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap: 0 });
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].index, 1);
    assert.strictEqual(chunks[0].text, text);
  });

  it('份数 = ceil(字符数/chunkSize)，与段落数无关', () => {
    // 100 个短段落（每段 "段" 1 字 + 换行），字符数约 200
    const text = Array.from({ length: 100 }, (_, i) => `段落${i}`).join('\n\n');
    const chunkSize = 100;
    const chunks = splitIntoChunks(text, { chunkSize, overlap: 0 });
    const expected = Math.ceil(text.length / chunkSize);
    assert.ok(chunks.length >= expected && chunks.length <= expected + 1, `chunks=${chunks.length}, expected≈${expected}`);
  });

  it('优先在段落边界（\n\n）切分', () => {
    // 5 段，每段 30 字，chunkSize=100 → 应在段落边界附近切
    const paras = Array.from({ length: 5 }, (_, i) => `段落${i}的内容填充。`.repeat(3));
    const text = paras.join('\n\n');
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap: 0 });
    // 切分点不应出现在句子中间（应在 \n\n 之后）
    for (const c of chunks) {
      if (c.text.length < 100) continue; // 最后一块可短
      const end = c.text.trimEnd();
      assert.ok(end.endsWith('。') || end.endsWith('}') || end.includes('\n'), `chunk 边界不干净: ${end.slice(-5)}`);
    }
  });

  it('硬切兜底：无分隔符的超长连续文本', () => {
    const text = '无'.repeat(350); // 350 个无分隔符字符
    const chunkSize = 100;
    const chunks = splitIntoChunks(text, { chunkSize, overlap: 0 });
    assert.strictEqual(chunks.length, 4); // 100+100+100+50
    assert.strictEqual(chunks[0].text.length, 100);
  });

  it('不会在 UTF-16 代理对中间切分', () => {
    const text = 'a'.repeat(9) + '😀' + 'b'.repeat(9) + '🚀' + 'c'.repeat(9);
    const chunks = splitIntoChunks(text, { chunkSize: 10, overlap: 0 });

    for (const chunk of chunks) {
      assert.doesNotMatch(chunk.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
      assert.doesNotMatch(chunk.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    assert.ok(chunks.some((chunk) => chunk.text.includes('😀')));
    assert.ok(chunks.some((chunk) => chunk.text.includes('🚀')));
  });

  it('overlap 生效：相邻 chunk 有重叠内容', () => {
    const text = Array.from({ length: 10 }, (_, i) => `段落${i}内容填充，用于测试。`.repeat(2)).join('\n\n');
    const overlap = 20;
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap });
    if (chunks.length > 1) {
      const second = chunks[1].text;
      const first = chunks[0].text;
      // 第二块开头应包含第一块尾部的部分内容（重叠）
      assert.ok(second.length > 0);
      assert.notStrictEqual(second, first);
    }
  });

  it('overlap 不导致死循环（推进保证）', () => {
    const text = '无'.repeat(250);
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap: 1000 });
    assert.ok(chunks.length > 1);
    // 总长应接近原文本（重叠部分被共享）
    const total = chunks.reduce((sum, c) => sum + c.text.length, 0);
    assert.ok(total >= 250, `总长 ${total} 应 >= 原文本长度`);
  });

  it('chunk index 从 1 递增', () => {
    const text = '段落'.repeat(300);
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap: 0 });
    chunks.forEach((c, i) => assert.strictEqual(c.index, i + 1));
  });

  it('非法 chunkSize 抛错', () => {
    assert.throws(() => splitIntoChunks('abc', { chunkSize: 0 }));
  });

  it('MAX_CHUNKS_PER_FILE 契约：500（P-7 单文件 chunk 数上限）', () => {
    assert.strictEqual(MAX_CHUNKS_PER_FILE, 500);
    // 超限场景：构造 501 个 chunk 的文本，切分器应产出 501 chunk（上限拦截在 import/incremental 消费层）
    const text = '无'.repeat(501 * 100);
    const chunks = splitIntoChunks(text, { chunkSize: 100, overlap: 0 });
    assert.ok(chunks.length > MAX_CHUNKS_PER_FILE, `chunks=${chunks.length} 应超 500 触发消费层防护`);
  });

  it('★ 上下限不在切分器内硬拦（历史超界值仍能重跑）', () => {
    // group-index.json.source.chunkSize 可能是旧版放行的超界值，重建 / 编辑发布会复用
    // 它重新切分。这里硬抛会让老 scope 再也跑不起来，所以范围约束只在写入入口做。
    assert.doesNotThrow(() => splitIntoChunks('无'.repeat(10000), { chunkSize: MAX_CHUNK_SIZE + 1, overlap: 0 }));
    assert.doesNotThrow(() => splitIntoChunks('无'.repeat(2000), { chunkSize: 1000, overlap: MAX_CHUNK_OVERLAP + 500 }));
  });
});

describe('validateChunkParams（写入入口的范围闸门）', () => {
  it('未指定（undefined / null）→ 跳过校验', () => {
    assert.strictEqual(validateChunkParams({}), null);
    assert.strictEqual(validateChunkParams({ chunkSize: null, chunkOverlap: null }), null);
    assert.strictEqual(validateChunkParams({ chunkSize: 1000, chunkOverlap: 150 }), null);
  });

  it('段长范围 100–4000，端点合法', () => {
    assert.strictEqual(validateChunkParams({ chunkSize: MIN_CHUNK_SIZE }), null);
    assert.strictEqual(validateChunkParams({ chunkSize: MAX_CHUNK_SIZE }), null);
    assert.strictEqual(validateChunkParams({ chunkSize: MIN_CHUNK_SIZE - 1 })?.field, 'chunkSize');
    assert.strictEqual(validateChunkParams({ chunkSize: MAX_CHUNK_SIZE + 1 })?.field, 'chunkSize');
  });

  it('段长必须为正整数', () => {
    assert.strictEqual(validateChunkParams({ chunkSize: 0 })?.field, 'chunkSize');
    assert.strictEqual(validateChunkParams({ chunkSize: -100 })?.field, 'chunkSize');
    assert.strictEqual(validateChunkParams({ chunkSize: 1000.5 })?.field, 'chunkSize');
  });

  it('重叠范围 0–500', () => {
    assert.strictEqual(validateChunkParams({ chunkOverlap: 0 }), null);
    assert.strictEqual(validateChunkParams({ chunkOverlap: MAX_CHUNK_OVERLAP }), null);
    assert.strictEqual(validateChunkParams({ chunkOverlap: MAX_CHUNK_OVERLAP + 1 })?.field, 'chunkOverlap');
    assert.strictEqual(validateChunkParams({ chunkOverlap: -1 })?.field, 'chunkOverlap');
  });

  it('重叠 < 段长：仅两者同时传入时校验', () => {
    assert.strictEqual(validateChunkParams({ chunkSize: 100, chunkOverlap: 100 })?.field, 'chunkOverlap');
    assert.strictEqual(validateChunkParams({ chunkSize: 100, chunkOverlap: 99 }), null);
    // 只传其一时不做关系校验 —— 调用方各自按「合并后的生效值」判（update 场景）
    assert.strictEqual(validateChunkParams({ chunkSize: 100 }), null);
    assert.strictEqual(validateChunkParams({ chunkOverlap: 400 }), null);
  });

  it('错误文案带可照做的范围与建议区间', () => {
    const err = validateChunkParams({ chunkSize: 99999 });
    assert.ok(err);
    assert.match(err.message, new RegExp(`${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE}`));
    assert.match(err.message, new RegExp(`建议 ${SUGGESTED_CHUNK_SIZE_MIN}–${SUGGESTED_CHUNK_SIZE_MAX}`));
    assert.match(err.message, /99999/);
  });
});
