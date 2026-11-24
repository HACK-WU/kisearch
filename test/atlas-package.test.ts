// S-01 单元测试：图集包校验与落盘内核（坏包矩阵 / 覆盖归档 / 原子替换 / 卸载）
// 运行：node --test test/atlas-package.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { registerTestScope } from './test-config.ts';
import { ensureScopeDir, scopeDirExists } from '../src/lib/store.ts';
import {
  installPackage,
  readStatus,
  readEntry,
  removePackage,
  ATLAS_CODES,
  archiveDir,
  entryPath,
  atlasDir,
  metaPath,
} from '../src/lib/atlas/index.ts';

const SCOPE = 'atlas-t1-' + Date.now();
registerTestScope(SCOPE);

const HTML_OK = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>t</title></head><body><script>window.__cfg={"baked": true};</script>ok</body></html>';

/** 构造一个最小 zip（STORE 或 DEFLATE），字段偏移按 PK 规范手写 */
function buildZip(files, method = 0) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = zlib.crc32(data);
    const stored = method === 0 ? data : zlib.deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
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

const okZip = (html = HTML_OK, extra = []) => buildZip([{ name: 'atlas.html', data: html }, ...extra]);

/** 断言抛出的 AtlasError 码 */
function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}：${err.message}`);
    return err;
  }
  assert.fail(`期望抛出错误码 ${code}，但没有抛错`);
}

test.before(() => {
  ensureScopeDir(SCOPE);
  assert.ok(scopeDirExists(SCOPE), '测试库应已建立');
});

test.after(() => {
  const dir = atlasDir(SCOPE);
  if (fs.existsSync(path.dirname(dir))) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('① 正常包安装成功：size / sha / entries 与包一致', () => {
  const zip = okZip(HTML_OK, [{ name: 'meta.json', data: '{"title":"测试图集","branch":"main","baseline":"abc1234"}' }]);
  const { meta, archived } = installPackage(SCOPE, zip);
  assert.equal(archived, false, '首次安装不应产生归档');
  assert.equal(meta.size, Buffer.byteLength(HTML_OK));
  assert.equal(meta.packageSize, zip.length);
  assert.equal(meta.sha256.length, 64);
  assert.equal(meta.title, '测试图集', '应优先取包内 meta.json 的标题');
  assert.equal(meta.baseline, 'abc1234');
  assert.deepEqual(meta.entries.map((e) => e.name).sort(), ['atlas.html', 'meta.json']);

  const st = readStatus(SCOPE);
  assert.equal(st.exists, true);
  assert.equal(st.meta.sha256, meta.sha256);
  assert.equal(readEntry(SCOPE).toString('utf8'), HTML_OK);
});

test('② 非 zip 输入 → 1401', () => {
  expectCode(() => installPackage(SCOPE, Buffer.from('this is not a zip')), ATLAS_CODES.PACKAGE_INVALID);
});

test('③ 截断的 zip → 1401', () => {
  const zip = okZip();
  expectCode(() => installPackage(SCOPE, zip.subarray(0, 30)), ATLAS_CODES.PACKAGE_INVALID);
});

test('④ 包内根目录没有 html → 1402（且提示重新打包）', () => {
  const zip = buildZip([{ name: 'README.md', data: '# hi' }]);
  const err = expectCode(() => installPackage(SCOPE, zip), ATLAS_CODES.ENTRY_NOT_FOUND);
  assert.match(err.hint ?? '', /pack_atlas\.py/);
});

test('⑤ 包内根目录多个 html → 1402', () => {
  const zip = buildZip([
    { name: 'a.html', data: HTML_OK },
    { name: 'b.html', data: HTML_OK },
  ]);
  expectCode(() => installPackage(SCOPE, zip), ATLAS_CODES.ENTRY_NOT_FOUND);
});

test('⑥ 缺 baked:true → 1401（指出应重新打包）', () => {
  const zip = okZip(HTML_OK.replace('"baked": true', '"baked": false'));
  const err = expectCode(() => installPackage(SCOPE, zip), ATLAS_CODES.PACKAGE_INVALID);
  assert.match(err.message, /baked/);
});

test('⑦ 含外链资源 → 1401，并指出具体 URL', () => {
  const bad = HTML_OK.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>');
  const err = expectCode(() => installPackage(SCOPE, okZip(bad)), ATLAS_CODES.PACKAGE_INVALID);
  assert.match(err.message, /cdn\.example\.com/);
});

test('⑧ 条目路径穿越 → 1404（在选 entry 之前就被拦下）', () => {
  const zip = buildZip([
    { name: 'atlas.html', data: HTML_OK },
    { name: '../escape.txt', data: 'x' },
  ]);
  expectCode(() => installPackage(SCOPE, zip), ATLAS_CODES.UNSAFE_ENTRY);
});

test('⑨ 条目数超上限（51）→ 1407', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  expectCode(() => installPackage(SCOPE, buildZip(many)), ATLAS_CODES.UNSUPPORTED_ZIP);
});

test('⑩ DEFLATE 压缩包可正常解出（与 Python zipfile 同款压缩方式）', () => {
  const zip = buildZip([{ name: 'atlas.html', data: HTML_OK }], 8);
  const { meta } = installPackage(SCOPE, zip);
  assert.equal(meta.size, Buffer.byteLength(HTML_OK));
  assert.ok(meta.packageSize < Buffer.byteLength(HTML_OK) + 300, '压缩包应小于原文 + 头开销');
});

test('⑪ 重传覆盖：旧包进 archive（只留 1 版），meta 更新', () => {
  const v1 = okZip(HTML_OK, [{ name: 'meta.json', data: '{"title":"v1"}' }]);
  installPackage(SCOPE, v1);

  const html2 = HTML_OK.replace('>ok<', '>ok2<');
  const v2 = okZip(html2, [{ name: 'meta.json', data: '{"title":"v2"}' }]);
  const { archived, meta } = installPackage(SCOPE, v2);

  assert.equal(archived, true, '第二次安装应产生归档');
  assert.equal(meta.title, 'v2');
  const archives = fs.readdirSync(archiveDir(SCOPE));
  assert.equal(archives.length, 1, `archive 只应保留 1 版，实际 ${archives.join(',')}`);
  assert.equal(readEntry(SCOPE).toString('utf8'), html2);
});

test('⑫ 卸载后 status.exists=false，entry 被删而 archive 保留', () => {
  const ok = removePackage(SCOPE);
  assert.equal(ok, true);
  assert.equal(readStatus(SCOPE).exists, false);
  assert.equal(fs.existsSync(entryPath(SCOPE)), false);
  assert.equal(fs.readdirSync(archiveDir(SCOPE)).length, 1, 'archive 不应被卸载清掉');

  expectCode(() => readEntry(SCOPE), ATLAS_CODES.NOT_FOUND);
});

test('⑬ 原子性：损坏包不会破坏已安装的版本', () => {
  installPackage(SCOPE, okZip(HTML_OK.replace('>ok<', '>good<')));
  const good = readEntry(SCOPE).toString('utf8');

  expectCode(() => installPackage(SCOPE, Buffer.from('garbage')), ATLAS_CODES.PACKAGE_INVALID);
  assert.equal(readEntry(SCOPE).toString('utf8'), good, '失败安装不应影响已有 entry');
  assert.equal(readStatus(SCOPE).meta.title.length > 0, true, 'meta 应仍然可用');
});

test('⑭ meta.json 损坏 → status.exists=false（不把异常抛给页面）', () => {
  installPackage(SCOPE, okZip());
  fs.writeFileSync(metaPath(SCOPE), '{ not json');
  const st = readStatus(SCOPE);
  assert.equal(st.exists, false, '损坏的 meta 视为未安装，页面走空态而不是报错');
});

test('⑮ 单条目解压后超预算 → 1403，且在解压前就拒（防 bomb）', () => {
  // 51 MB 的 'a' 压成几十 KB：zip 体积检查放行，靠「解压前按声明大小预判」拦下
  const big = Buffer.alloc(51 * 1024 * 1024, 0x61);
  const zip = buildZip([{ name: 'atlas.html', data: big }], 8);
  assert.ok(zip.length < 20 * 1024 * 1024, `压缩后应远小于 zip 上限，实际 ${zip.length}`);
  expectCode(() => installPackage(SCOPE, zip), ATLAS_CODES.TOO_LARGE);
});
