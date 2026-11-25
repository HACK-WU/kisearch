/**
 * 分批计划的纯函数测试（`commands/upload.ts::planBatches`）。
 *
 * 分批是「超大目录撞上传上限」的唯一出路（压缩只能缓解），所以边界要钉死：
 * 顺序不能变（服务端按 filename 落盘，顺序影响可读性）、单文件超阈值要独占一批（让服务端
 * 老实报超限，而不是客户端静默丢文件）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chooseChannel, planBatches } from '../dist/commands/upload.js';

const file = (name, bytes) => ({ rel: name, abs: `/tmp/${name}`, bytes });

describe('planBatches', () => {
  it('总量未超阈值 → 一批', () => {
    const batches = planBatches([file('a.md', 10), file('b.md', 10)], 100);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((f) => f.rel), ['a.md', 'b.md']);
  });

  it('按累计体积切批，顺序保持', () => {
    const batches = planBatches([file('a', 40), file('b', 40), file('c', 40), file('d', 40)], 100);
    assert.deepEqual(batches.map((b) => b.map((f) => f.rel)), [['a', 'b'], ['c', 'd']]);
  });

  it('单文件超阈值 → 独占一批（不丢文件、不静默截断）', () => {
    const batches = planBatches([file('small', 10), file('huge', 500), file('tail', 10)], 100);
    assert.deepEqual(batches.map((b) => b.map((f) => f.rel)), [['small'], ['huge'], ['tail']]);
  });

  it('空输入 → 空批次（调用方据此提前返回）', () => {
    assert.deepEqual(planBatches([], 100), []);
  });

  it('恰好等于阈值不切批（边界闭区间）', () => {
    const batches = planBatches([file('a', 50), file('b', 50)], 100);
    assert.equal(batches.length, 1);
  });
});

describe('chooseChannel：有附件就必须 tar.gz', () => {
  it('纯根目录 md → multipart（最快）', () => {
    assert.equal(chooseChannel([{ rel: 'a.md' }, { rel: 'b.md' }], 100, false), 'multipart');
  });

  it('出现子目录（assets/…）→ tar.gz（multipart 会丢附件，真机验证）', () => {
    assert.equal(chooseChannel([{ rel: 'a.md' }, { rel: 'assets/a.svg' }], 100, false), 'tar.gz');
  });

  it('根目录的非 md 文件 → tar.gz', () => {
    assert.equal(chooseChannel([{ rel: 'a.md' }, { rel: 'a.svg' }], 100, false), 'tar.gz');
  });

  it('--archive 强制 → tar.gz', () => {
    assert.equal(chooseChannel([{ rel: 'a.md' }], 100, true), 'tar.gz');
  });

  it('超过 32MB → tar.gz（压缩收益）', () => {
    assert.equal(chooseChannel([{ rel: 'a.md' }], 33 * 1024 * 1024, false), 'tar.gz');
  });
});
