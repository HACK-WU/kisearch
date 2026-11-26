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

import {
  extractImageRefs,
  groupDocs,
  isCollectibleRef,
  isWanted,
  missingRefLines,
  normalizeRef,
  refCandidates,
  uploadedRelFor,
} from '../dist/commands/upload.js';

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

/**
 * #101 回归：附件不能按目录过滤，ref 必须相对 md 目录解析。
 *
 * 真机现象：project-atlas 导出的图落在 `<分类>/images/<pid>.svg`，
 * 白名单只认 `assets/` → 一张都进不了包；即使进包，`byPath.get('./images/x.svg')`
 * 也与 `01-总览/images/x.svg` 对不上 → 全量 missing。
 */
describe('#101 图片目录不限 + ref 相对 md 解析', () => {
  it('isWanted：任意目录的白名单图片都收，非白名单后缀不收', () => {
    assert.equal(isWanted('images/x.svg'), true);
    assert.equal(isWanted('01-总览/images/x.png'), true);
    assert.equal(isWanted('a/b/c.webp'), true);
    assert.equal(isWanted('assets/x.png'), true);
    assert.equal(isWanted('notes/a.md'), true);
    assert.equal(isWanted('data/a.json'), false);
    assert.equal(isWanted('notes.md.bak'), false);
  });

  it('extractImageRefs：绝对路径 / 协议相对 / 盘符路径不算「本地可上传」', () => {
    const md = [
      '![a](/static/a.png)',
      '![b](//cdn.example.com/b.png)',
      '![c](C:/pics/c.png)',
      '![d](images/d.png)',
    ].join('\n');
    assert.deepEqual(extractImageRefs(md), ['images/d.png']);
    assert.equal(isCollectibleRef('https://e.com/a.png'), false);
    assert.equal(isCollectibleRef('data:image/png;base64,AAAA'), false);
  });

  it('refCandidates：相对 md 目录优先，ref 原样作兜底', () => {
    assert.deepEqual(refCandidates('01-总览/a.md', 'images/x.svg'), [
      '01-总览/images/x.svg',
      'images/x.svg',
    ]);
    // md 在根时两者相同，只留一个候选
    assert.deepEqual(refCandidates('a.md', 'images/x.svg'), ['images/x.svg']);
    // 引用带回溯：拼完仍是越界形态（不会误命中上传根内的文件）
    assert.equal(refCandidates('a.md', '../outside/x.png')[0], '../outside/x.png');
  });

  it('子目录 md + images/ 下的图 → 成组且不报 missing（核心回归）', () => {
    const doc = put('01-总览/a.md', '![x](./images/x.svg)');
    const asset = put('01-总览/images/x.svg', '<svg/>');
    const groups = groupDocs([doc, asset]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['01-总览/images/x.svg']);
    assert.deepEqual(groups[0].missing, []);
  });

  it('flat 引用（相对上传根）仍能命中，保持改动前行为', () => {
    const doc = put('01-总览/b.md', '![x](shared/y.png)');
    const asset = put('shared/y.png', 'png');
    const groups = groupDocs([doc, asset]);
    assert.deepEqual(groups[0].assets.map((item) => item.rel), ['shared/y.png']);
    assert.deepEqual(groups[0].missing, []);
  });

  it('真的没带图时仍记 missing（fail-loud 的数据源）', () => {
    const doc = put('01-总览/c.md', '![x](./images/absent.svg)');
    const groups = groupDocs([doc]);
    assert.deepEqual(groups[0].missing, ['images/absent.svg']);
    assert.deepEqual(groups[0].assets, []);
  });

  it('同一张图被不同目录的两篇引用时不会重复归组', () => {
    const d1 = put('g1/a.md', '![x](../shared/s.png)');
    const d2 = put('g2/b.md', '![x](../shared/s.png)');
    const asset = put('shared/s.png', 's');
    const groups = groupDocs([d1, d2, asset]);
    const claimed = groups.flatMap((group) => group.assets.map((item) => item.rel));
    assert.deepEqual(claimed, ['shared/s.png']);
  });

  it('missingRefLines：空跑也要复算缺图（增量跳过不能吞掉上次的缺图）', () => {
    const doc = put('dry/c.md', '![x](./images/none.svg)');
    const ok = put('dry/images/ok.svg', '<svg/>');
    assert.deepEqual(missingRefLines([doc, ok]), ['dry/c.md → images/none.svg']);
    assert.deepEqual(missingRefLines([put('dry2/d.md', '![y](images/fine.png)'), put('dry2/images/fine.png', 'p')]), []);
  });

  it('uploadedRelFor：cwd 内保留结构，cwd 外退 basename', () => {
    const cwd = process.cwd();
    try {
      process.chdir(root);
      assert.equal(uploadedRelFor(path.join(root, 'docs/a.md')), 'docs/a.md');
      assert.equal(uploadedRelFor(path.join(root, 'a.md')), 'a.md');
      // cwd 之外：无从推断结构，只能退 basename（否则会把 ../ 写进 tar 路径）
      assert.equal(uploadedRelFor('/tmp/elsewhere/x.png'), 'x.png');
    } finally {
      process.chdir(cwd);
    }
  });
});
