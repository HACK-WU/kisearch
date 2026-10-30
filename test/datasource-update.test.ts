/**
 * 数据源同步参数编辑（2026-10-30）：字段校验 / 乐观锁 / 水位保留 / 只读放行。
 * 运行：npx jiti test/datasource-update.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache, setScopeReadonlyInConfigFile } from '../src/lib/config.js';
import {
  addDataSource,
  normalizeStoredChunkParams,
  readDataSource,
  updateDataSourceConfig,
  writeDataSource,
} from '../src/lib/datasource.js';

let root: string;
let savedConfigPath: string | undefined;
const scope = `ds-update-${process.pid}`;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-update-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(root, 'kb'),
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [scope]: {} },
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'a.md'), '# a\n');
  const added = await addDataSource({ scope, dir: source, config: loadConfig() });
  assert.equal(added.ok, true);
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = () => {
  const res = readDataSource(scope);
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error(res.error);
  return res.record;
};

const update = (patch: Record<string, unknown>, baseRevision?: number) =>
  updateDataSourceConfig({
    scope,
    patch,
    ...(baseRevision !== undefined ? { baseRevision } : {}),
    config: loadConfig(),
  });

describe('updateDataSourceConfig', () => {
  it('只改传入字段：四项都改、revision +1、定时 revision 不动', async () => {
    const before = read();
    const res = await update({
      conflictMode: 'suffix',
      conflictSuffix: '_v{n}',
      vector: false,
      chunkSize: 500,
      chunkOverlap: 50,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.changed.sort(), ['chunkOverlap', 'chunkSize', 'conflictMode', 'conflictSuffix', 'vector'].sort());
    assert.equal(res.record.revision, before.revision + 1);
    assert.equal(res.record.schedule.revision, before.schedule.revision);
    const disk = read();
    assert.equal(disk.vector, false);
    assert.equal(disk.chunkSize, 500);
    assert.equal(disk.chunkOverlap, 50);
    assert.equal(disk.conflictMode, 'suffix');
  });

  it('保留同步水位与落点 / 身份字段', async () => {
    const current = read();
    const at = Date.now() - 60_000;
    writeDataSource(scope, {
      ...current,
      lastSync: { at, durationMs: 1, state: 'ok' } as typeof current.lastSync,
    });
    const res = await update({ chunkSize: 800, chunkOverlap: 80 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.record.lastSync?.at, at);
    assert.equal(res.record.group, current.group);
    assert.equal(res.record.dir, current.dir);
    assert.equal(res.record.createdAt, current.createdAt);
  });

  it('全等不 bump revision', async () => {
    const before = read();
    const res = await update({
      conflictMode: before.conflictMode,
      conflictSuffix: before.conflictSuffix,
      vector: before.vector,
      chunkSize: before.chunkSize,
      chunkOverlap: before.chunkOverlap,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.changed, []);
    assert.equal(res.record.revision, before.revision);
  });

  it('乐观锁：baseRevision 不符 → DATASOURCE_STALE', async () => {
    const res = await update({ vector: true }, 9999);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, 'DATASOURCE_STALE');
  });

  it('校验：段长 100–4000 / 重叠 0–500（含端点合法）', async () => {
    const tooBig = await update({ chunkSize: 5000 });
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) {
      assert.equal(tooBig.code, 'INVALID_CHUNK');
      assert.equal(tooBig.field, 'chunkSize');
      assert.match(tooBig.error, /100–4000/);
    }
    const tooSmall = await update({ chunkSize: 50 });
    assert.equal(tooSmall.ok, false);
    if (!tooSmall.ok) assert.equal(tooSmall.field, 'chunkSize');
    const overlapTooBig = await update({ chunkOverlap: 600 });
    assert.equal(overlapTooBig.ok, false);
    if (!overlapTooBig.ok) assert.equal(overlapTooBig.field, 'chunkOverlap');
    // 端点合法
    assert.equal((await update({ chunkSize: 4000, chunkOverlap: 500 })).ok, true);
    assert.equal((await update({ chunkSize: 800, chunkOverlap: 80 })).ok, true);
  });

  it('★ 存量超界值不阻塞「只改其它字段」（范围只校验本次 patch）', async () => {
    // 旧版只校验 ">0"、没有上界，库里可能存着 6000 这类值。若按合并后的生效值判范围，
    // 用户只想改「同名策略」也会被历史值拦住 —— 整条配置再也改不动。
    const seeded = read();
    writeDataSource(scope, { ...seeded, chunkSize: 6000, chunkOverlap: 200 });
    const res = await update({ conflictMode: 'overwrite' });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.record.chunkSize, 6000, '历史值原样保留，不被顺手改写');
    assert.equal(res.record.conflictMode, 'overwrite');
    // 恢复合法值，避免影响后续用例
    assert.equal((await update({ chunkSize: 800, chunkOverlap: 80 })).ok, true);
  });

  it('校验：重叠 >= 段长 / 非法策略 / 负数', async () => {
    // 当前 chunkSize=800 / overlap=80；只改段长到 100 仍合法（80 < 100）
    const shrink = await update({ chunkSize: 100 });
    assert.equal(shrink.ok, true);
    const bad = await update({ chunkSize: 100, chunkOverlap: 100 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, 'INVALID_CHUNK');
    const mode = await update({ conflictMode: 'bogus' });
    assert.equal(mode.ok, false);
    if (!mode.ok) assert.equal(mode.code, 'INVALID_CONFLICT');
    const neg = await update({ chunkOverlap: -1 });
    assert.equal(neg.ok, false);
    if (!neg.ok) assert.equal(neg.code, 'INVALID_CHUNK');
  });

  it('未登记 → NOT_FOUND', async () => {
    const res = await updateDataSourceConfig({
      scope: `nope-${process.pid}`,
      patch: { vector: false },
      config: loadConfig(),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'NOT_FOUND');
  });

  it('只读 scope 仍允许编辑数据源参数（EXEMPT_OPS）', async () => {
    assert.equal(setScopeReadonlyInConfigFile(scope, true).ok, true);
    resetConfigCache();
    const res = await update({ vector: true });
    assert.equal(res.ok, true);
    assert.equal(setScopeReadonlyInConfigFile(scope, false).ok, true);
    resetConfigCache();
  });

  it('旧记录缺 revision 时按 0 处理', async () => {
    const current = read();
    const { revision: _drop, ...legacy } = current;
    writeDataSource(scope, legacy as typeof current);
    const disk = read();
    assert.equal(disk.revision, 0);
  });
});

describe('normalizeStoredChunkParams（存量超界值不阻塞同步）', () => {
  it('超界段长钳到最近边界并留 warning', () => {
    const r = normalizeStoredChunkParams(6000, 200);
    assert.equal(r.chunkSize, 4000);
    assert.equal(r.chunkOverlap, 200, '范围内的重叠不改动');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].message, /6000/);
    assert.match(r.warnings[0].message, /100–4000/);
  });

  it('段长钳小后重叠不再小于段长时，重叠一并下压（否则同步第二次失败）', () => {
    const r = normalizeStoredChunkParams(50, 900);
    assert.equal(r.chunkSize, 100, '50 → 下限 100');
    assert.equal(r.chunkOverlap, 99, '900 超上限 → 500，仍 >= 100 → 压到 99');
    assert.ok(r.warnings.length >= 2);
  });

  it('合法值 / 未设置原样返回、零 warning', () => {
    const ok = normalizeStoredChunkParams(1000, 150);
    assert.deepEqual({ ...ok, warnings: [] }, { chunkSize: 1000, chunkOverlap: 150, warnings: [] });
    assert.equal(ok.warnings.length, 0);
    const unset = normalizeStoredChunkParams(null, null);
    assert.equal(unset.chunkSize, null);
    assert.equal(unset.chunkOverlap, null);
    assert.equal(unset.warnings.length, 0);
  });
});
