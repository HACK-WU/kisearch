/**
 * 文档单元分组的测试（`commands/upload.ts::groupDocs` / `extractImageRefs`）。
 *
 * 为什么必须钉：真机验证发现「按体积切批」会把附件和引用它的 md 拆到不同批次，
 * 结果纯附件批次被服务端判成 `OPEN_API_NO_VALID_FILE` 整批拒收，md 里的图变成死链。
 * 所以分组的正确性 = 附件不丢。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractImageRefs, groupDocs, normalizeRef } from '../dist/commands/upload.js';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-group-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 造一个文件并返回 PickedFile 形状 */
function put(rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { rel, abs, bytes: Buffer.byteLength(content), sha256: 'x' };
}

describe('extractImageRefs：从 markdown 抽本地附件', () => {
  it('markdown 语法与 html img 都能抽', () => {
    const md = '# t\n\n![a](assets/x.png)\n<img src="shots/y.jpg">\n';
    assert.deepEqual(extractImageRefs(md).sort(), ['assets/x.png', 'shots/y.jpg']);
  });

  it('外链、查询串、锚点都被处理掉', () => {
    const md = '![e](https://e.com/a.png) ![q](assets/b.png?v=1#x)';
    assert.deepEqual(extractImageRefs(md), ['assets/b.png']);
  });

  it('去重（同一张图引用两次）', () => {
    const md = '![a](assets/x.png)\n![b](./assets/x.png)';
    assert.deepEqual(extractImageRefs(md), ['assets/x.png']);
  });

  it('normalizeRef 剥 ./、反斜杠转正斜杠、解码', () => {
    assert.equal(normalizeRef('./assets/a.png'), 'assets/a.png');
    assert.equal(normalizeRef('assets\\a.png'), 'assets/a.png');
    assert.equal(normalizeRef('assets/%E4%B8%AD.png'), 'assets/中.png');
  });
});

describe('groupDocs：md 与它的附件必须同组', () => {
  it('附件归到引用它的 md 组，字节数含附件', () => {
    const doc = put('a.md', '# a\n\n![x](assets/a.png)\n');
    const asset = put('assets/a.png', 'png-bytes');
    const groups = groupDocs([doc, asset]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].doc.rel, 'a.md');
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['assets/a.png']);
    assert.equal(groups[0].bytes, doc.bytes + asset.bytes);
  });

  it('没有附件的 md 自成一组', () => {
    const doc = put('b.md', '# b\n\n纯文字\n');
    const groups = groupDocs([doc]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].assets, []);
  });

  it('同一附件被两篇引用时只归第一组（避免重复上传）', () => {
    const d1 = put('c1.md', '![x](assets/shared.png)');
    const d2 = put('c2.md', '![x](assets/shared.png)');
    const asset = put('assets/shared.png', 'shared');
    const groups = groupDocs([d1, d2, asset]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['assets/shared.png']);
    assert.deepEqual(groups[1].assets, []);
  });

  it('孤儿附件并入第一组（单独成批会被服务端整批拒收）', () => {
    const doc = put('d.md', '# d\n');
    const orphan = put('assets/orphan.png', 'orphan');
    const groups = groupDocs([doc, orphan]);
    assert.equal(groups.length, 1, '孤儿不该单独成组');
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['assets/orphan.png']);
  });

  it('md 引用了但本次没带的附件 → 记进 missing（服务端会静默丢图）', () => {
    const doc = put('m.md', '![x](assets/absent.png)');
    const groups = groupDocs([doc]);
    assert.deepEqual(groups[0].missing, ['assets/absent.png']);
    assert.deepEqual(groups[0].assets, []);
  });

  it('只有附件没有 md 时，仍产出一个组（让服务端去报错，而不是客户端静默丢）', () => {
    const only = put('assets/only.png', 'x');
    const groups = groupDocs([only]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].doc, undefined);
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['assets/only.png']);
  });
});
