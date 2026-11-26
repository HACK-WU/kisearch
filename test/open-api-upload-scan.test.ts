/**
 * 上传接收的三分类统计（文档 / 附件 / 真跳过）。
 *
 * 为什么必须钉：tar 分支会把整包条目都解包落地，图片只是「不是可导入单元」。
 * 修复前它被算进 `skipped` 并附原因「扩展名不支持」——调用方（尤其 AI agent）看到
 * `skipped: 12` 会以为图没传上去，实际图就在包里、随后由导入内核复制进
 * `{group}/assets/`。这一条是事件 #101 的服务端侧（客户端侧已修）。
 *
 * 顺带钉住 `assetsEnabled=false` 的回退：附件白名单为空时，图片必须退回 skipped，
 * 不能既不统计也不报（那才是真的静默丢）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanContent } from '../src/lib/open-api/upload-stream.js';

const DOC = ['.md'];
const ASSET = ['.png', '.svg'];

function withContent(files: Record<string, string>, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scan-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('扫描：文档进 saved、图片进 assets、其它才是 skipped', () => {
  withContent({
    'a.md': '# a',
    'sub/b.md': '# b',
    'images/x.png': 'png',
    'sub/deep/y.svg': '<svg/>',
    'notes.txt': 'x',
    'data.json': '{}',
  }, (root) => {
    const r = scanContent(root, DOC, ASSET);
    assert.equal(r.saved, 2, '两篇 md');
    assert.equal(r.assets, 2, '两张图，不进 skipped');
    assert.equal(r.skipped, 2, '只有 txt/json 是真跳过');
    assert.deepEqual(r.skippedSample.map((item) => item.rel).sort(), ['data.json', 'notes.txt']);
    // 原因要能看出「附件是允许的」，否则调用方仍会以为图片该进 skipped
    assert.match(r.skippedSample[0]!.reason, /附件允许/);
  });
});

test('扫描：附件白名单为空（assets:false）时图片退回 skipped 并给原因', () => {
  withContent({ 'a.md': '# a', 'x.png': 'png' }, (root) => {
    const r = scanContent(root, DOC, []);
    assert.equal(r.saved, 1);
    assert.equal(r.assets, 0);
    assert.equal(r.skipped, 1);
    assert.doesNotMatch(r.skippedSample[0]!.reason, /附件允许/);
  });
});

test('扫描：解包字节统计含附件（附件也占磁盘）', () => {
  withContent({ 'a.md': 'abc', 'x.png': '12345' }, (root) => {
    const r = scanContent(root, DOC, ASSET);
    assert.equal(r.unpackedBytes, Buffer.byteLength('abc') + Buffer.byteLength('12345'));
  });
});
