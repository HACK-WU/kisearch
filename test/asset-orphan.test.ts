/**
 * asset-orphan.test.ts —— 附件孤儿判定与清理（事件 #102）
 *
 * 钉住这几件事（它们各自对应一个真实误判风险）：
 *   ① 归一化口径必须与落盘一致：`./images/x.png` → `images/x.png`、URL 解码、双层 `assets/assets/x.png`
 *   ② 共享图不是孤儿：同组多篇引用同一张时必须保留
 *   ③ 正文引用了但磁盘没有（破图）只算 dangling，绝不能进删除清单
 *   ④ 越界 rel 必须被拒（删除不可逆，宁可留垃圾）
 *   ⑤ minAge 过滤给「保留期」留出口
 *
 * 按项目约定：验证产物只建在 workspace/temp，不主动清理。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fixture = path.join(process.cwd(), 'temp', `asset-orphan-${Date.now()}`);
fs.mkdirSync(fixture, { recursive: true });
const dataDir = path.join(fixture, 'kb');
const configPath = path.join(fixture, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir: path.join(fixture, 'vector'),
  scopeMode: 'default',
  scopes: {},
}));
process.env.KI_CONFIG_PATH = configPath;

const { resetConfigCache } = await import('../src/lib/config.js');
const {
  assetRelOfRef,
  collectGroupAssetRefs,
  deleteOrphans,
  findOrphansInGroup,
  listAssetFiles,
  listGroupsWithKb,
  scanScopeOrphans,
} = await import('../src/lib/asset-orphan.js');
const { getAssetsDir, getLocalKbDir } = await import('../src/lib/scope.js');

/** 造一个 group：KB 正文 + assets 文件（rel 用 posix） */
function seed(
  scope: string,
  group: string,
  docs: Record<string, string>,
  assets: Record<string, string>,
): void {
  resetConfigCache();
  const kbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  fs.writeFileSync(kbPath, JSON.stringify({ version: 1, updatedAt: 1, ...docs }), 'utf-8');
  const assetsDir = getAssetsDir(scope, group);
  for (const [rel, body] of Object.entries(assets)) {
    const abs = path.join(assetsDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

describe('assetRelOfRef：归一化口径与落盘一致', () => {
  it('剥 ./、转 posix、URL 解码', () => {
    assert.equal(assetRelOfRef('./images/x.png'), 'images/x.png');
    assert.equal(assetRelOfRef('images/%E4%B8%AD.png'), 'images/中.png');
    assert.equal(assetRelOfRef('images\\x.png'), 'images/x.png');
  });

  it('双层 assets 保持原样（./assets/x.svg → assets/x.svg）', () => {
    assert.equal(assetRelOfRef('./assets/x.svg'), 'assets/x.svg');
  });

  it('外链 / 绝对路径 / 越界 一律 null', () => {
    assert.equal(assetRelOfRef('https://e.com/a.png'), null);
    assert.equal(assetRelOfRef('//cdn/a.png'), null);
    assert.equal(assetRelOfRef('/root/a.png'), null);
    assert.equal(assetRelOfRef('C:/pics/a.png'), null);
    assert.equal(assetRelOfRef('../../etc/passwd'), null);
    assert.equal(assetRelOfRef(''), null);
  });
});

describe('孤儿判定', () => {
  it('只报没被引用的；共享图不算孤儿', () => {
    seed('s1', '组A', {
      a: '# a\n\n![](shared.png)',
      b: '# b\n\n![x](./shared.png)',
    }, {
      'shared.png': 's',
      'orphan.png': 'o',
    });
    const report = findOrphansInGroup('s1', '组A');
    assert.deepEqual(report.orphans.map((file) => file.rel), ['orphan.png']);
    assert.equal(report.orphanBytes, 1);
    assert.deepEqual(report.danglingRefs, []);
  });

  it('子目录引用按 md 绝对路径口径比对（不是 basename）', () => {
    seed('s1', '组B', {
      a: '![](images/deep/x.png)',
      b: '![](./assets/y.png)',
    }, {
      'images/deep/x.png': 'xx',
      'assets/y.png': 'yy',
      'x.png': 'wrong', // 同名但不同路径：必须仍是孤儿
    });
    const report = findOrphansInGroup('s1', '组B');
    assert.deepEqual(report.orphans.map((file) => file.rel), ['x.png']);
  });

  it('正文引用了但磁盘没有 → danglingRefs，不进删除清单', () => {
    seed('s1', '组C', { a: '![](missing.png)' }, { 'real.png': 'r' });
    const report = findOrphansInGroup('s1', '组C');
    assert.deepEqual(report.danglingRefs, ['missing.png']);
    assert.deepEqual(report.orphans.map((file) => file.rel), ['real.png']);
  });

  it('KB 里混着 version/updatedAt 元数据键不会崩', () => {
    seed('s1', '组D', { a: '![](x.png)' }, { 'x.png': 'x' });
    const report = findOrphansInGroup('s1', '组D');
    assert.equal(report.orphans.length, 0);
  });
});

describe('collectGroupAssetRefs / listAssetFiles', () => {
  it('同一张图被多篇引用时 owners 全记', () => {
    seed('s1', '组E', { a: '![](x.png)', b: '![](x.png)', c: '![](y.png)' }, { 'x.png': '', 'y.png': '' });
    const refs = collectGroupAssetRefs(
      JSON.parse(fs.readFileSync(getLocalKbDir('s1', '组E'), 'utf-8')) as Record<string, unknown>,
    );
    assert.deepEqual([...(refs.get('x.png') ?? [])].sort(), ['a', 'b']);
  });

  it('列出嵌套文件且按 rel 排序', () => {
    seed('s1', '组F', {}, { 'b.png': '', 'a/c.png': '' });
    assert.deepEqual(listAssetFiles('s1', '组F').map((file) => file.rel), ['a/c.png', 'b.png']);
  });
});

describe('清理与保留期', () => {
  it('deleteOrphans 删得掉；越界 rel 被拒且不误删', () => {
    seed('s1', '组G', {}, { 'gone.png': 'abc', 'keep.png': 'k' });
    const outcome = deleteOrphans('s1', [
      { group: '组G', rel: 'gone.png' },
      { group: '组G', rel: '../../outside.png' },
    ]);
    assert.equal(outcome.deleted, 1);
    assert.equal(outcome.bytes, 3);
    assert.equal(outcome.errors.length, 1);
    assert.deepEqual(listAssetFiles('s1', '组G').map((file) => file.rel), ['keep.png']);

    // 再删掉最后一张：assets 根必须保留（下次导入会写入；备份与排查也要看到这个组有 assets）
    const second = deleteOrphans('s1', [{ group: '组G', rel: 'keep.png' }]);
    assert.equal(second.deleted, 1);
    assert.equal(fs.existsSync(getAssetsDir('s1', '组G')), true, 'assets 根目录不能被清理掉');
  });

  it('minAgeMs 过滤：刚落的文件在保留期内不算孤儿', () => {
    seed('s1', '组H', {}, { 'fresh.png': 'f' });
    const old = Date.now() - 10 * 86_400_000;
    const assetsDir = getAssetsDir('s1', '组H');
    fs.utimesSync(path.join(assetsDir, 'fresh.png'), new Date(old), new Date(old));

    const withinKeep = scanScopeOrphans('s1', { group: '组H', minAgeMs: 30 * 86_400_000 });
    assert.equal(withinKeep.orphanCount, 0, '保留 30 天时，10 天前的文件还不该被清');

    const pastKeep = scanScopeOrphans('s1', { group: '组H', minAgeMs: 7 * 86_400_000 });
    assert.equal(pastKeep.orphanCount, 1, '保留 7 天时，10 天前的文件应被列出');
  });

  it('scanScopeOrphans 聚合多个 group，且跳过 .trash 目录', () => {
    // 独立 scope：前面的用例都写在 s1 里，混在一起会看不出聚合口径
    seed('s2', '组I', {}, { 'o1.png': '1' });
    seed('s2', '组I/子', { a: '![](in.png)' }, { 'in.png': '2' });
    // .trash 下的目录不该被当成 group 扫
    const trashDir = path.join(dataDir, 's2', '.trash', '组I');
    fs.mkdirSync(trashDir, { recursive: true });
    fs.writeFileSync(path.join(trashDir, 'index.json'), JSON.stringify({ x: '![](nope.png)' }));

    assert.deepEqual(listGroupsWithKb('s2'), ['组I', '组I/子']);
    const scan = scanScopeOrphans('s2');
    assert.equal(scan.orphanCount, 1);
    assert.deepEqual(scan.groups.map((report) => report.group), ['组I']);
  });
});
