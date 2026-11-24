// S-06 单元测试：图集分片上传（合并 / 中断不落盘 / 缺片 / 乱序 / 暂存清理）
// 运行：npx jiti test/atlas-upload.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { registerTestScope } from './test-config.ts';
import { ensureScopeDir } from '../src/lib/store.ts';
import {
  receiveChunk,
  cleanupStaleUploads,
  readStatus,
  readEntry,
  atlasDir,
  ATLAS_CODES,
  STALE_UPLOAD_MS,
} from '../src/lib/atlas/index.ts';

const SCOPE = 'atlas-u1-' + Date.now();
registerTestScope(SCOPE);

const HTML = '<!DOCTYPE html><html><body><script>window.x={"baked": true};</script>v1</body></html>';

/** 最小 STORE zip（与 atlas-package.test.ts 同一构造，测试夹具重复无妨） */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, f.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const zipOf = (html: string) => buildZip([{ name: 'atlas.html', data: Buffer.from(html, 'utf8') }]);
const uploadDirOf = (uploadId: string) => path.join(atlasDir(SCOPE), '.upload', uploadId);
const b64 = (b: Buffer) => b.toString('base64');

/** 把 zip 切成 n 片（内容首尾相接，模拟真实分片） */
function slice(zip: Buffer, n: number): Buffer[] {
  const size = Math.ceil(zip.length / n);
  return Array.from({ length: n }, (_, i) => zip.subarray(i * size, (i + 1) * size));
}

test.before(() => ensureScopeDir(SCOPE));

test('① 两片合并成功：done + 安装 + 暂存清空', () => {
  const zip = zipOf(HTML);
  const [p0, p1] = slice(zip, 2);
  const r1 = receiveChunk({ scope: SCOPE, uploadId: 'u-ok', batchIndex: 0, batchCount: 2, files: [{ content: b64(p0) }] });
  assert.equal(r1.done, false);
  assert.equal(r1.received, 1);
  assert.equal(readStatus(SCOPE).exists, false, '未收完不得产生图集');

  const r2 = receiveChunk({ scope: SCOPE, uploadId: 'u-ok', batchIndex: 1, batchCount: 2, files: [{ content: b64(p1) }] });
  assert.equal(r2.done, true);
  assert.equal(r2.install?.meta.size, Buffer.byteLength(HTML));
  assert.equal(readEntry(SCOPE).toString('utf8'), HTML);
  assert.equal(fs.existsSync(uploadDirOf('u-ok')), false, '合并成功后暂存必须清空');
});

test('② 只发首片：不落盘、暂存保留（可续传）', () => {
  const zip = zipOf(HTML);
  const [p0] = slice(zip, 2);
  const r = receiveChunk({ scope: SCOPE, uploadId: 'u-half', batchIndex: 0, batchCount: 2, files: [{ content: b64(p0) }] });
  assert.equal(r.done, false);
  assert.equal(fs.existsSync(uploadDirOf('u-half')), true, '中断的暂存应保留以便续传');
});

test('③ 中间片丢失：即使收到最后一片也不合并', () => {
  const zip = zipOf(HTML);
  const parts = slice(zip, 3);
  receiveChunk({ scope: SCOPE, uploadId: 'u-gap', batchIndex: 0, batchCount: 3, files: [{ content: b64(parts[0]) }] });
  const r = receiveChunk({ scope: SCOPE, uploadId: 'u-gap', batchIndex: 2, batchCount: 3, files: [{ content: b64(parts[2]) }] });
  assert.equal(r.done, false, '缺第 2 片时不应合并（拼出来的包必然校验失败）');
  assert.equal(r.received, 2);
});

test('④ 乱序到达：合并顺序按 batchIndex（part-10 不会排到 part-2 前）', () => {
  const html = HTML.replace('v1', 'ordered');
  const zip = zipOf(html);
  const parts = slice(zip, 3);
  // 故意倒序发送
  receiveChunk({ scope: SCOPE, uploadId: 'u-order', batchIndex: 2, batchCount: 3, files: [{ content: b64(parts[2]) }] });
  receiveChunk({ scope: SCOPE, uploadId: 'u-order', batchIndex: 1, batchCount: 3, files: [{ content: b64(parts[1]) }] });
  const last = receiveChunk({ scope: SCOPE, uploadId: 'u-order', batchIndex: 0, batchCount: 3, files: [{ content: b64(parts[0]) }] });
  assert.equal(last.done, true);
  assert.match(readEntry(SCOPE).toString('utf8'), /ordered/);
});

test('⑤ 坏包：抛 ATLAS_* 且暂存被清空（不留下次拼脏包）', () => {
  const bad = Buffer.from('not a zip at all');
  try {
    receiveChunk({ scope: SCOPE, uploadId: 'u-bad', batchIndex: 0, batchCount: 1, files: [{ content: b64(bad) }] });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal((err as { code?: number }).code, ATLAS_CODES.PACKAGE_INVALID);
  }
  assert.equal(fs.existsSync(uploadDirOf('u-bad')), false, '校验失败必须清空暂存');
});

test('⑥ uploadId 非法（路径穿越）→ 1404', () => {
  try {
    receiveChunk({ scope: SCOPE, uploadId: '../evil', batchIndex: 0, batchCount: 1, files: [{ content: b64(Buffer.from('x')) }] });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal((err as { code?: number }).code, ATLAS_CODES.UNSAFE_ENTRY);
  }
});

test('⑦ 暂存超 24h 在下次上传时被清掉', () => {
  const zip = zipOf(HTML);
  const [p0] = slice(zip, 2);
  receiveChunk({ scope: SCOPE, uploadId: 'u-stale', batchIndex: 0, batchCount: 2, files: [{ content: b64(p0) }] });
  const stale = uploadDirOf('u-stale');
  const old = new Date(Date.now() - STALE_UPLOAD_MS - 60_000);
  fs.utimesSync(stale, old, old);

  const removed = cleanupStaleUploads(SCOPE);
  assert.ok(removed >= 1, `应清理至少 1 个过期暂存，实际 ${removed}`);
  assert.equal(fs.existsSync(stale), false);
});

test('⑧ files 多元素被拒（一片一文件，免得 concat 出含糊语义）', () => {
  const zip = zipOf(HTML);
  const [p0] = slice(zip, 2);
  try {
    receiveChunk({
      scope: SCOPE,
      uploadId: 'u-multi',
      batchIndex: 0,
      batchCount: 2,
      files: [{ content: b64(p0) }, { content: b64(p0) }],
    });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal((err as { code?: number }).code, ATLAS_CODES.PACKAGE_INVALID);
  }
  assert.equal(fs.existsSync(uploadDirOf('u-multi')), false, '参数非法时不应留下暂存');
});

test('⑨ 分片参数非法：batchIndex 越界 / 缺 files', () => {
  const zip = zipOf(HTML);
  const [p0] = slice(zip, 2);
  try {
    receiveChunk({ scope: SCOPE, uploadId: 'u-param', batchIndex: 5, batchCount: 2, files: [{ content: b64(p0) }] });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal((err as { code?: number }).code, ATLAS_CODES.PACKAGE_INVALID);
  }
  try {
    receiveChunk({ scope: SCOPE, uploadId: 'u-param', batchIndex: 0, batchCount: 1, files: [] });
    assert.fail('应抛错');
  } catch (err) {
    assert.equal((err as { code?: number }).code, ATLAS_CODES.PACKAGE_INVALID);
  }
});
