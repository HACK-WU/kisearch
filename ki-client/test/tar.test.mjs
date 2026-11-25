/**
 * ustar 打包 + gzip 的单元测试（`lib/tar.ts`）。
 *
 * 服务端用的是**系统 tar** 解包，所以这里除了自己解析头之外，还要用真 tar 验证一次——
 * 自己写的解析器和自己的打包器互相印证是循环论证，挡不住"两边一起错"。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTar, createTarGz, splitTarPath } from '../dist/lib/tar.js';

const field = (block, offset, length) => block.subarray(offset, offset + length).toString('utf8').replace(/\0[\s\S]*$/, '');
const octal = (block, offset, length) => parseInt(block.subarray(offset, offset + length).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8);

/** 逐条解析 ustar（只覆盖本工具会生成的普通文件） */
function parseTar(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = octal(header, 124, 12);
    const content = buf.subarray(offset + 512, offset + 512 + size);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      size,
      content,
      typeflag: field(header, 156, 1),
      magic: header.subarray(257, 263).toString('binary'),
      checksumRecorded: octal(header, 148, 8),
      checksumActual: checksum(header),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function checksum(header) {
  const copy = Buffer.from(header);
  copy.write('        ', 148, 'ascii');
  let sum = 0;
  for (const byte of copy) sum += byte;
  return sum;
}

describe('ustar：头字段正确性', () => {
  const entries = [
    { path: 'a.md', content: Buffer.from('# A\n') },
    { path: 'sub/b.md', content: Buffer.from('# B\nhello') },
    { path: 'assets/x.png', content: Buffer.alloc(700, 7) },
  ];
  const parsed = parseTar(createTar(entries));

  it('条目数、路径、内容长度都对', () => {
    assert.deepEqual(parsed.map((e) => e.path), ['a.md', 'sub/b.md', 'assets/x.png']);
    assert.deepEqual(parsed.map((e) => e.size), [4, 9, 700]);
  });

  it('内容逐字节一致（含跨 512 边界的补零）', () => {
    assert.equal(parsed[0].content.toString(), '# A\n');
    assert.equal(parsed[1].content.toString(), '# B\nhello');
    assert.equal(parsed[2].content.equals(Buffer.alloc(700, 7)), true);
  });

  it('magic 是 ustar、typeflag 是普通文件、校验和自洽', () => {
    for (const entry of parsed) {
      assert.equal(entry.magic, 'ustar\0');
      assert.equal(entry.typeflag, '0');
      assert.equal(entry.checksumRecorded, entry.checksumActual, `${entry.path} 校验和不匹配`);
    }
  });

  it('结尾有两个全零块（否则部分 tar 实现会报截断）', () => {
    const buf = createTar(entries);
    const tail = buf.subarray(buf.length - 1024);
    assert.equal(tail.every((byte) => byte === 0), true);
  });
});

describe('ustar：长路径走 prefix 字段', () => {
  it('100 字节以内不拆分', () => {
    assert.deepEqual(splitTarPath('a.md'), { name: 'a.md', prefix: '' });
  });

  it('超过 100 字节时按最深的分隔点切成 prefix + name', () => {
    const dir = '很长的目录名'.repeat(8);       // 每字 3 字节，远超 100
    const rel = `${dir}/文件.md`;
    const { name, prefix } = splitTarPath(rel);
    assert.ok(Buffer.byteLength(name, 'utf8') <= 100);
    assert.ok(Buffer.byteLength(prefix, 'utf8') <= 155);
    assert.equal(prefix ? `${prefix}/${name}` : name, rel);
  });

  it('单段超过 100 字节时明确报错（而不是生成解不开的包）', () => {
    assert.throws(() => splitTarPath(`${'x'.repeat(120)}.md`), /路径过长/);
  });
});

describe('tar.gz：能被系统 tar 解开（服务端就是用它）', () => {
  const tarAvailable = spawnSync('tar', ['--version'], { encoding: 'utf-8' }).status === 0;

  it('gzip 解压后与原 tar 一致', () => {
    const entries = [{ path: 'a.md', content: Buffer.from('hello') }];
    assert.equal(zlib.gunzipSync(createTarGz(entries)).equals(createTar(entries)), true);
  });

  it('tar -tzf 能列出条目，tar -xzf 能还原内容', { skip: !tarAvailable && '系统无 tar' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-tar-'));
    try {
      const archive = path.join(dir, 'a.tar.gz');
      const payload = '# 中文标题\n\n内容\n';
      fs.writeFileSync(archive, createTarGz([
        { path: 'a.md', content: Buffer.from(payload) },
        { path: 'sub/b.md', content: Buffer.from('# B\n') },
      ]));

      const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf-8' });
      assert.equal(list.status, 0, list.stderr);
      assert.deepEqual(list.stdout.trim().split('\n').sort(), ['a.md', 'sub/b.md']);

      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      const extract = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf-8' });
      assert.equal(extract.status, 0, extract.stderr);
      assert.equal(fs.readFileSync(path.join(out, 'a.md'), 'utf-8'), payload);
      assert.equal(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf-8'), '# B\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
