/**
 * 数据源编辑弹窗纯函数（2026-10-30）：表单转换 / 切分校验 / 差异裁剪。
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { formFromRecord, validateChunkFields, chunkRangeNotice, buildConfigPatch, isConfigDirty } =
  await vite.ssrLoadModule('/src/lib/datasourceEdit.ts');
after(async () => vite.close());

const record = (over = {}) => ({
  version: 2,
  scope: 'demo',
  type: 'git',
  dir: '/repo/docs',
  group: null,
  conflictMode: 'incremental',
  conflictSuffix: '_{n}',
  vector: true,
  chunkSize: null,
  chunkOverlap: null,
  createdAt: 1,
  updatedAt: 2,
  revision: 3,
  lastSync: null,
  ...over,
});

describe('formFromRecord', () => {
  it('空切分参数显示为空（= 默认），布尔与策略原样带出', () => {
    assert.deepEqual(formFromRecord(record()), {
      conflictMode: 'incremental',
      conflictSuffix: '_{n}',
      vector: true,
      chunkSize: '',
      chunkOverlap: '',
    });
    const filled = formFromRecord(record({ chunkSize: 800, chunkOverlap: 80, vector: false }));
    assert.equal(filled.chunkSize, '800');
    assert.equal(filled.chunkOverlap, '80');
    assert.equal(filled.vector, false);
  });
});

describe('validateChunkFields', () => {
  it('留空 = 默认 1000 / 150，合法', () => {
    assert.equal(validateChunkFields('', '').ok, true);
    assert.equal(validateChunkFields('800', '').ok, true);
    assert.equal(validateChunkFields('', '100').ok, true);
  });

  it('正整数 / 非负整数约束', () => {
    assert.equal(validateChunkFields('0', '').ok, false);
    assert.equal(validateChunkFields('-1', '').ok, false);
    assert.equal(validateChunkFields('1.5', '').ok, false);
    assert.equal(validateChunkFields('abc', '').ok, false);
    assert.equal(validateChunkFields('', '-1').ok, false);
  });

  it('只改段长时按默认重叠校验（100 vs 150 不合法）', () => {
    const res = validateChunkFields('100', '');
    assert.equal(res.ok, false);
    assert.equal(res.field, 'chunkOverlap');
    assert.match(res.message, /必须小于段长/);
    assert.equal(validateChunkFields('100', '0').ok, true);
  });

  it('范围：段长 100–4000、重叠 0–500（端点合法）', () => {
    assert.equal(validateChunkFields('100', '0').ok, true);
    assert.equal(validateChunkFields('4000', '500').ok, true);
    assert.equal(validateChunkFields('99', '0').ok, false);
    assert.equal(validateChunkFields('4001', '0').ok, false);
    assert.equal(validateChunkFields('1000', '501').ok, false);
    const res = validateChunkFields('99999', '');
    assert.equal(res.field, 'chunkSize');
    assert.match(res.message, /100–4000/);
    assert.match(res.message, /建议 500–2000/);
  });

  it('★ 存量超界值：值未改动时跳过范围校验，改了才拦', () => {
    const base = { chunkSize: '6000', chunkOverlap: '200' };
    // 原样不动 → 放行（用户只想改同名策略 / 定时等其它字段）
    assert.equal(validateChunkFields('6000', '200', base).ok, true);
    // 一旦改动，即便仍是超界值也拦下
    assert.equal(validateChunkFields('6001', '200', base).ok, false);
    // 不传 base（新输入场景）→ 全量校验
    assert.equal(validateChunkFields('6000', '200').ok, false);
  });
});

describe('chunkRangeNotice（存量超界值可见但不阻塞）', () => {
  it('存量超界且未改动 → 给出提示', () => {
    const msg = chunkRangeNotice('6000', '200', { chunkSize: '6000', chunkOverlap: '200' });
    assert.ok(msg);
    assert.match(msg, /6000/);
    assert.match(msg, /100–4000/);
    assert.match(msg, /不影响保存其它项/);
  });

  it('存量合法 / 留空 → 无提示', () => {
    assert.equal(chunkRangeNotice('1000', '150', { chunkSize: '1000', chunkOverlap: '150' }), null);
    assert.equal(chunkRangeNotice('', '', { chunkSize: '', chunkOverlap: '' }), null);
  });

  it('值已被改动 → 交给 validateChunkFields 硬拦，这里不重复提示', () => {
    const base = { chunkSize: '6000', chunkOverlap: '200' };
    assert.equal(chunkRangeNotice('6001', '200', base), null);
  });

  it('重叠超界同样提示（关系仍合法时）', () => {
    const msg = chunkRangeNotice('1000', '900', { chunkSize: '1000', chunkOverlap: '900' });
    assert.ok(msg);
    assert.match(msg, /重叠 900/);
    assert.match(msg, /0–500/);
  });
});

describe('buildConfigPatch', () => {
  it('全等 → 空 patch（不触发请求、不 bump revision）', () => {
    const base = record();
    assert.deepEqual(buildConfigPatch(base, formFromRecord(base)), {});
    assert.equal(isConfigDirty(base, formFromRecord(base)), false);
  });

  it('只返回改动字段；清空切分 = null', () => {
    const base = record({ chunkSize: 800, chunkOverlap: 80 });
    const form = { ...formFromRecord(base), vector: false, chunkSize: '', chunkOverlap: '50' };
    assert.deepEqual(buildConfigPatch(base, form), { vector: false, chunkSize: null, chunkOverlap: 50 });
    assert.equal(isConfigDirty(base, form), true);
  });

  it('策略/后缀变化单独下发', () => {
    const base = record();
    const form = { ...formFromRecord(base), conflictMode: 'suffix', conflictSuffix: '-{n}' };
    assert.deepEqual(buildConfigPatch(base, form), { conflictMode: 'suffix', conflictSuffix: '-{n}' });
  });
});
