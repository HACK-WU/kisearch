/**
 * vector-dimension-snapshot 单元测试（REQ-20261016-002 回归锁）
 *
 * 锁三条不变量：
 *   1) 配置标识（model / provider / baseURL）由**读路径从 config 活读** —— 快照文件里的同名值
 *      不参与判定（改配置后不会展示陈旧模型名）；
 *   2) 快照缺失 / 过期 / 维度不符各分支都必须带标识，且**不得编造 persisted**；
 *   3) 兜底写入的快照文件**不含 apiKey**（配置含密钥，快照目录不得成为泄漏面）。
 *
 * 跑法：cd /root/knowledge-indexer && npx jiti test/vector-dimension-snapshot.test.ts
 *
 * ★ 环境隔离（自查发现）：`refreshVectorDimensionSnapshot` 内部的 `getVectorDimensionStatus` 会
 *   `loadConfig()` 读**真实配置**（`~/.ki/config.yaml`）—— 若用户恰好存在同名 scope 的集合，
 *   `scopeCollectionExists` 为真就会 `withEngine` 打开**真实向量库**（可能撞 daemon 锁）。
 *   故本测试在 before 里把 `KI_CONFIG_PATH` 指向临时配置（dataDir/vectorDir 均在临时目录），
 *   保证不读用户配置、不触碰真实向量库；after 恢复原环境变量。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVectorDimensionSnapshot, refreshVectorDimensionSnapshot } from '../src/lib/vector-dimension-snapshot.js';
import type { KiConfig } from '../src/lib/config.js';

const SCOPE = 'snapshot-test';
const MODEL = 'qwen3.7-text-embedding-flash';
const PROVIDER = 'dashscope';
const BASE_URL = 'http://127.0.0.1:9/v1';
const DIMENSION = 1024;
const API_KEY = 'sk-unit-test-should-not-leak';
const TTL_MS = 5 * 60 * 1000;

let dataDir = '';

/** 最小可用 config：read/refresh 只用 dataDir + embedding（其余字段由断言路径覆盖不到） */
function testConfig(): KiConfig {
  return {
    dataDir,
    embedding: {
      provider: PROVIDER,
      baseURL: BASE_URL,
      model: MODEL,
      dimension: DIMENSION,
      apiKey: API_KEY,
      queryTimeoutMs: 1000,
    },
  } as unknown as KiConfig;
}

function snapshotFile(): string {
  const key = crypto.createHash('sha256').update(SCOPE).digest('hex');
  return path.join(dataDir, '.vector-status', `${key}.json`);
}

/** 直接落一份"上次刷新产物"；staleModel 等标识用于验证读路径是否覆盖它们 */
function writeSnapshot(options: { persisted?: number; checkedAt?: number; staleIdentifiers?: boolean } = {}): void {
  const { persisted, checkedAt = Date.now(), staleIdentifiers = false } = options;
  const file = snapshotFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    scope: SCOPE,
    state: 'compatible',
    configured: DIMENSION,
    ...(staleIdentifiers
      ? { model: 'STALE-MODEL', provider: 'STALE-PROVIDER', baseURL: 'https://stale.example.com/v1' }
      : {}),
    ...(persisted !== undefined ? { persisted } : {}),
    checkedAt,
    staleAfterMs: TTL_MS,
  }), 'utf-8');
}

describe('向量维度快照的配置标识（REQ-20261016-002）', () => {
  let root = '';
  let previousConfigPath: string | undefined;
  let previousDaemonClient: string | undefined;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vec-snapshot-'));
    dataDir = path.join(root, 'kb');
    fs.mkdirSync(dataDir, { recursive: true });
    // ★ 环境隔离：让 lib 内部的 loadConfig() 也只用临时配置（否则 refresh 链路可能打开真实向量库）
    const cfgPath = path.join(root, 'config.yaml');
    fs.writeFileSync(cfgPath, [
      `dataDir: ${dataDir}`,
      `backupDir: ${path.join(root, 'backup')}`,
      `vectorDir: ${path.join(root, 'vector')}`,
      'scopeMode: default',
      'embedding:',
      `  provider: ${PROVIDER}`,
      `  baseURL: ${BASE_URL}`,
      `  model: ${MODEL}`,
      `  dimension: ${DIMENSION}`,
      '  apiKey: sk-temp-env-only',
      'scopes:',
      '  default: {}',
      '',
    ].join('\n'), 'utf-8');
    previousConfigPath = process.env.KI_CONFIG_PATH;
    previousDaemonClient = process.env.KI_DAEMON_CLIENT;
    process.env.KI_CONFIG_PATH = cfgPath;
    delete process.env.KI_DAEMON_CLIENT;
  });

  after(() => {
    if (previousConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfigPath;
    if (previousDaemonClient !== undefined) process.env.KI_DAEMON_CLIENT = previousDaemonClient;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('⓪ 环境隔离生效：库内部 loadConfig() 读到的是临时配置（未读用户 ~/.ki/config.yaml）', async () => {
    const { loadConfig } = await import('../src/lib/config.js');
    const loaded = loadConfig();
    assert.equal(loaded.dataDir, dataDir, 'dataDir 必须是临时目录');
    assert.equal(loaded.embedding.model, MODEL);
  });

  it('① 无快照：unknown + 标识来自 config，且不编造 persisted', () => {
    fs.rmSync(snapshotFile(), { force: true });
    const snap = readVectorDimensionSnapshot(testConfig(), SCOPE);
    assert.equal(snap.state, 'unknown');
    assert.equal(snap.configured, DIMENSION);
    assert.equal(snap.model, MODEL);
    assert.equal(snap.provider, PROVIDER);
    assert.equal(snap.baseURL, BASE_URL);
    assert.ok(!('persisted' in snap), `不得编造 persisted：${JSON.stringify(snap)}`);
  });

  it('② ★ 快照文件里的 STALE 标识不参与判定（读路径恒覆盖）', () => {
    writeSnapshot({ persisted: DIMENSION, staleIdentifiers: true });
    const snap = readVectorDimensionSnapshot(testConfig(), SCOPE);
    assert.equal(snap.state, 'compatible', 'persisted === configured ⇒ compatible');
    assert.equal(snap.persisted, DIMENSION);
    assert.equal(snap.model, MODEL, '模型名必须以当前配置为准');
    assert.equal(snap.provider, PROVIDER, 'provider 必须以当前配置为准');
    assert.equal(snap.baseURL, BASE_URL, 'baseURL 必须以当前配置为准');
  });

  it('③ persisted ≠ configured：mismatch + 标识仍为 config 值', () => {
    writeSnapshot({ persisted: 4096, staleIdentifiers: true });
    const snap = readVectorDimensionSnapshot(testConfig(), SCOPE);
    assert.equal(snap.state, 'mismatch');
    assert.equal(snap.persisted, 4096);
    assert.equal(snap.configured, DIMENSION);
    assert.equal(snap.model, MODEL);
  });

  it('④ 快照过期：unknown 且仍带标识（不冒充确认）', () => {
    writeSnapshot({ persisted: DIMENSION, checkedAt: Date.now() - TTL_MS - 1000 });
    const snap = readVectorDimensionSnapshot(testConfig(), SCOPE);
    assert.equal(snap.state, 'unknown');
    assert.equal(snap.model, MODEL);
    assert.equal(snap.provider, PROVIDER);
    assert.equal(snap.baseURL, BASE_URL);
  });

  it('⑤ 刷新失败兜底：unknown + 标识 + error（以非法 scope 名驱动，不触碰向量库）', async () => {
    const snap = await refreshVectorDimensionSnapshot(testConfig(), 'bad scope!');
    assert.equal(snap.state, 'unknown');
    assert.equal(snap.configured, DIMENSION);
    assert.equal(snap.model, MODEL);
    assert.equal(snap.provider, PROVIDER);
    assert.equal(snap.baseURL, BASE_URL);
    assert.equal(typeof snap.error, 'string');
  });

  it('⑥ 兜底写入的快照文件不含 apiKey（密钥不落快照目录）', async () => {
    await refreshVectorDimensionSnapshot(testConfig(), SCOPE);
    const raw = fs.readFileSync(snapshotFile(), 'utf-8');
    assert.ok(!raw.includes(API_KEY), '快照文件不得出现 apiKey');
    assert.ok(!/apiKey/i.test(raw), `快照文件不得出现 apiKey 字段名：${raw}`);
  });
});
