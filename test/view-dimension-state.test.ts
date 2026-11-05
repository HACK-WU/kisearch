/**
 * view-dimension-state.test.ts —— 视图成员维度三态的判定口径。
 *
 * 核心 invariants（方案 A「已确认清单」）：
 *   1. 只有快照里确实有 `persisted` 且与当前配置不同，才判 `mismatch`；
 *   2. 无快照 / 损坏 / 无 persisted / scope 不匹配 / 非正整数一律 `unknown`；
 *   3. **集合维度不受 5 分钟 TTL 影响**（结构性事实），配置维度仍活读比较；
 *   4. refresh 失败不得抹掉上次确认的 persisted（否则一次锁冲突就让标记消失）；
 *   5. 任何异常都降级为 `unknown`，不把维度检查失败变成列表接口 500。
 *
 * ★ 第 3 条是首轮二次质疑实测后修的：本机 178 份快照全部过期（含真实 mismatch），
 *   若沿用 readVectorDimensionSnapshot 的 TTL 判定，视图页标记会一个都不出现。
 * ★ 第 4 条是复检发现的：refresh 的 catch 分支原本写「无 persisted」快照覆盖旧值。
 *
 * 运行：npx jiti test/view-dimension-state.test.ts
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-dim-'));
const dataDir = path.join(tmpDir, 'kb');
const configPath = path.join(tmpDir, 'config.json');
const TTL = 5 * 60 * 1000;

function writeConfig(dimension: number): void {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
    embedding: {
      provider: 'siliconflow',
      baseURL: 'https://example.invalid/v1',
      model: 'dimension-test-model',
      apiKey: 'test-key',
      dimension,
    },
  }), 'utf-8');
}
writeConfig(1024);
process.env.KI_CONFIG_PATH = configPath;

const configLib = await import('../src/lib/config.js');
const snapLib = await import('../src/lib/vector-dimension-snapshot.js');
const { readViewDimensionState } = await import('../src/lib/view-dimension-state.js');

function snapshotFile(scope: string): string {
  return path.join(dataDir, '.vector-status', `${crypto.createHash('sha256').update(scope).digest('hex')}.json`);
}

function writeSnapshot(
  scope: string,
  persisted: number | undefined,
  checkedAt = Date.now(),
  storedScope = scope,
): void {
  const file = snapshotFile(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    scope: storedScope,
    state: persisted === undefined ? 'unknown' : 'compatible',
    configured: 1024,
    model: 'dimension-test-model',
    provider: 'siliconflow',
    baseURL: 'https://example.invalid/v1',
    ...(persisted !== undefined ? { persisted } : {}),
    checkedAt,
    staleAfterMs: TTL,
  }), 'utf-8');
}

function clearSnapshots(): void {
  fs.rmSync(path.join(dataDir, '.vector-status'), { recursive: true, force: true });
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('没有快照 → unknown（不把「没查」写成「一致」）', () => {
  clearSnapshots();
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'never-checked'), 'unknown');
});

test('快照 persisted 与配置一致 → ok', () => {
  clearSnapshots();
  writeSnapshot('same-dim', 1024);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'same-dim'), 'ok');
});

test('快照 persisted 与配置不同 → mismatch', () => {
  clearSnapshots();
  writeSnapshot('old-4096', 4096);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'old-4096'), 'mismatch');
});

test('快照缺 persisted → unknown（无集合不等于一致）', () => {
  clearSnapshots();
  writeSnapshot('no-persisted', undefined);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'no-persisted'), 'unknown');
});

test('★ 过期快照的 mismatch 仍然上屏（集合维度是结构性事实，不受 TTL 影响）', () => {
  clearSnapshots();
  writeSnapshot('stale-mismatch', 4096, Date.now() - TTL * 1000);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'stale-mismatch'), 'mismatch');
});

test('★ 过期快照的 ok 仍判 ok（不能把陈旧一律降成未确认）', () => {
  clearSnapshots();
  writeSnapshot('stale-ok', 1024, Date.now() - TTL * 1000);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'stale-ok'), 'ok');
});

test('快照 scope 不匹配 → unknown（防串台）', () => {
  clearSnapshots();
  writeSnapshot('mismatch-scope', 4096, Date.now(), 'another-scope');
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'mismatch-scope'), 'unknown');
});

test('persisted 非正整数 → unknown（防损坏/伪造快照误报 mismatch）', () => {
  clearSnapshots();
  const bads: [string, unknown][] = [['negative', -1], ['fraction', 1.5], ['zero', 0], ['string', '4096']];
  for (const [name, bad] of bads) {
    const scope = `bad-${name}`;
    const file = snapshotFile(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      scope, state: 'mismatch', configured: 1024,
      persisted: bad, checkedAt: Date.now(), staleAfterMs: TTL,
    }), 'utf-8');
    assert.equal(readViewDimensionState(configLib.loadConfig(), scope), 'unknown', `${name} 不应被当成维度`);
  }
});

test('快照文件损坏 / 非 JSON → unknown，不抛错', () => {
  clearSnapshots();
  const file = snapshotFile('corrupt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json', 'utf-8');
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'corrupt'), 'unknown');
});

test('★ refresh 失败不抹掉上次确认的 persisted（一次锁冲突不该让标记消失）', async () => {
  clearSnapshots();
  /*
   * 用非法 scope 名稳定触发 refreshVectorDimensionSnapshot 的 catch 分支：
   * getVectorDimensionStatus → resolveScope 直接抛错，不打开引擎、零副作用。
   * 本机真实数据里就有这类 unknown 快照（scope「飒」「飒飒」）。
   */
  const scope = '飒';
  const file = snapshotFile(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    scope, state: 'mismatch', configured: 1024,
    model: 'dimension-test-model', provider: 'siliconflow',
    baseURL: 'https://example.invalid/v1',
    persisted: 4096, checkedAt: Date.now(), staleAfterMs: TTL,
  }), 'utf-8');

  const cfg = configLib.loadConfig();
  const snap = await snapLib.refreshVectorDimensionSnapshot(cfg, scope);
  assert.equal(snap.state, 'unknown', '失败态仍应是 unknown');
  assert.equal(snap.persisted, 4096, 'catch 分支应保留上次确认的集合维度');
  assert.equal(snapLib.readPersistedVectorDimension(cfg, scope), 4096);
  assert.equal(readViewDimensionState(cfg, scope), 'mismatch');
});

test('配置维度活读：改成 4096 后旧的 4096 集合由 mismatch 变 ok', () => {
  clearSnapshots();
  writeSnapshot('follow-config', 4096);
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'follow-config'), 'mismatch');
  writeConfig(4096);
  configLib.resetConfigCache();
  assert.equal(readViewDimensionState(configLib.loadConfig(), 'follow-config'), 'ok');
  writeConfig(1024);
  configLib.resetConfigCache();
});
