/**
 * conclusion-chain.test.ts —— 结论因果链的归一 / 裁剪（2026-11-19）
 *
 * 重点覆盖"模型输出是不可信输入"这条前提：
 *   1. 结构不是数组、项不是对象、kind 非法 → 丢弃而不是抛错；
 *   2. 节点文本压成一行并截断（换行会把前端轨道撑坏）；
 *   3. ref 只接受 `file:line` 形状（`src/a.ts: 128` 这种带说明的串必须丢）；
 *   4. branches 只允许挂 root，最多 3 条；
 *   5. 节点上限 5（结论总量有限，超出必然水化）；
 *   6. pruneChainRefs 只剪引用、保留节点（那句话通常仍然成立）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/conclusion-chain.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN_MAX_NODES,
  chainToLines,
  normalizeChain,
  pruneChainRefs,
} from '../../src/lib/events/conclusion-chain.js';

describe('结论因果链归一', () => {
  it('非数组输入一律归一为空数组（不抛错）', () => {
    for (const raw of [undefined, null, 'symptom', 42, { kind: 'root', text: 'x' }]) {
      assert.deepEqual(normalizeChain(raw), []);
    }
  });

  it('丢弃非法 kind / 空文本，kind 大小写与空白归一', () => {
    const chain = normalizeChain([
      { kind: ' ROOT ', text: '  根本原因  ' },
      { kind: 'unknown', text: '应被丢弃' },
      { kind: 'impact', text: '   ' },
      null,
      'not-an-object',
      { text: '缺 kind' },
      { kind: 'fix', text: '补兜底' },
    ]);
    assert.deepEqual(chain.map((n) => n.kind), ['root', 'fix']);
    assert.equal(chain[0]!.text, '根本原因');
  });

  it('文本压成一行并截断到 200 字（换行会撑坏前端轨道）', () => {
    const chain = normalizeChain([
      { kind: 'cause', text: '第一行\n第二行\t带制表符' },
      { kind: 'impact', text: '甲'.repeat(500) },
    ]);
    assert.equal(chain[0]!.text, '第一行 第二行 带制表符');
    assert.equal(chain[1]!.text.length, 200);
  });

  it('ref 只接受 file:line；带说明、非正整数、空串一律丢弃', () => {
    const chain = normalizeChain([
      { kind: 'cause', text: 'a', ref: ' src/pages/EventsPage.tsx:431 ' },
      { kind: 'cause', text: 'b', ref: 'src/a.ts: 128' },
      { kind: 'cause', text: 'c', ref: 'src/a.ts:0' },
      { kind: 'cause', text: 'd', ref: 'src/a.ts' },
      { kind: 'cause', text: 'e', ref: '' },
    ]);
    assert.equal(chain[0]!.ref, 'src/pages/EventsPage.tsx:431', '前后空白必须被裁掉');
    assert.equal(chain[1]!.ref, undefined, '带说明的串会让前端渲染出一个点开找不到的胶囊');
    assert.equal(chain[2]!.ref, undefined, '行号必须是正整数');
    assert.equal(chain[3]!.ref, undefined);
    assert.equal(chain[4]!.ref, undefined);
  });

  it('branches 只允许 root，最多 3 条，每条截断 120 字', () => {
    const chain = normalizeChain([
      { kind: 'cause', text: '原因', branches: ['不该保留'] },
      {
        kind: 'root',
        text: '根因',
        // 空串先被过滤，再按上限截断，所以"触发四"进不来
        branches: ['触发一', '', '触发二', '触发三', '触发四'],
      },
    ]);
    assert.equal(chain[0]!.branches, undefined, '非 root 的分支必须丢弃');
    assert.deepEqual(chain[1]!.branches, ['触发一', '触发二', '触发三']);
  });

  it('节点上限 5', () => {
    const raw = ['symptom', 'cause', 'root', 'impact', 'fix', 'fix'].map((kind, i) => ({ kind, text: `节点${i}` }));
    const chain = normalizeChain(raw);
    assert.equal(chain.length, CHAIN_MAX_NODES);
  });

  it('pruneChainRefs 只剪引用、保留节点文本', () => {
    const chain = normalizeChain([
      { kind: 'cause', text: '指向真实位置', ref: 'src/login.ts:3' },
      { kind: 'root', text: '指向幻觉位置', ref: 'src/ghost.ts:10' },
      { kind: 'impact', text: '本来就没有引用' },
    ]);
    const pruned = pruneChainRefs(chain, [{ file: 'src/login.ts', line: 3 }]);
    assert.equal(pruned.length, 3, '引用失效不等于节点失效');
    assert.equal(pruned[0]!.ref, 'src/login.ts:3');
    assert.equal(pruned[1]!.ref, undefined);
    assert.equal(pruned[1]!.text, '指向幻觉位置');
    assert.equal(pruned[2]!.ref, undefined);
  });

  it('chainToLines 供追问上下文复用同一套中文标签', () => {
    const chain = normalizeChain([
      { kind: 'root', text: '未兜底', ref: 'src/a.ts:9', branches: ['冷启动'] },
      { kind: 'fix', text: '解构前判空' },
    ]);
    assert.deepEqual(chainToLines(chain), [
      '- 根本原因：未兜底（src/a.ts:9）；分支：冷启动',
      '- 建议：解构前判空',
    ]);
  });
});
