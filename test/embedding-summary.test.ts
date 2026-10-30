/**
 * embedding-summary.test.ts —— 「资源 / 向量模型」只读摘要（REQ-20261030-001）
 *
 * 契约：
 *   1) `source` 判定看**原始配置文件里该字段是否存在**，不看值是否等于默认值
 *      —— 用户显式写 `dimension: 1024` 仍是 `configured`（这正是不复用 `loadConfig()`
 *      结果的原因：合并后「显式写默认值」与「没写兜底」已经分不清了）；
 *   2) apiKey **只出布尔**：返回值任何位置都不得出现密钥明文；
 *   3) 配置文件存在但读不出来 → 降级为 builtin-default + `warning`，**不抛错**
 *      （一个展示接口不该因此整页失败）；
 *   4) 无配置文件（全内置默认）→ `configPath: null`、全 builtin-default，且**不**报 warning。
 *
 * 运行：npx jiti test/embedding-summary.test.ts
 */
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEmbeddingSummary } from '../src/lib/embedding-summary.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import type { KiConfig } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-emb-summary-'));

/** 写一份最小可加载的 config，`embeddingLines` 为 null 表示整段缺省 */
function writeConfig(name: string, embeddingLines: string[] | null): string {
  const file = path.join(tmpRoot, name);
  const lines = [
    `dataDir: ${path.join(tmpRoot, 'data')}`,
    `backupDir: ${path.join(tmpRoot, 'backup')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    'scopeMode: default',
  ];
  if (embeddingLines) lines.push('embedding:', ...embeddingLines);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
}

/** 构造一个「配置对象」用于测 edge（不经过真实文件） */
function fakeConfig(configPath: string | undefined): KiConfig {
  return {
    dataDir: tmpRoot,
    backupDir: tmpRoot,
    vectorDir: tmpRoot,
    embedding: { provider: 'dashscope', baseURL: 'https://x/v1', model: 'm', dimension: 1024, queryTimeoutMs: 3000 },
    scopeMode: 'default',
    scopes: {},
    scopeReadonly: [],
    ...(configPath !== undefined ? { _configPath: configPath } : {}),
  } as KiConfig;
}

before(() => {
  for (const dir of ['data', 'backup', 'vector']) {
    fs.mkdirSync(path.join(tmpRoot, dir), { recursive: true });
  }
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('全部字段显式配置', () => {
  it('五个字段都是 configured，且不泄漏密钥', () => {
    resetConfigCache();
    const file = writeConfig('full.yaml', [
      '  provider: dashscope',
      '  baseURL: https://example.com/v1',
      '  model: my-model',
      '  dimension: 768',
      '  apiKey: sk-secret-should-not-leak',
      '  queryTimeoutMs: 5000',
    ]);
    const summary = buildEmbeddingSummary(loadConfig(file));

    assert.equal(summary.configPath, file);
    for (const field of ['provider', 'baseURL', 'model', 'dimension', 'queryTimeoutMs'] as const) {
      assert.equal(summary[field].source, 'configured', `${field} 应为 configured`);
    }
    assert.equal(summary.model.value, 'my-model');
    assert.equal(summary.dimension.value, 768);
    assert.equal(summary.queryTimeoutMs.value, 5000);
    assert.equal(summary.apiKeyConfigured, true);
    assert.equal(summary.warning, undefined);

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('sk-secret-should-not-leak'), false, '返回值不得含密钥明文');
  });
});

describe('部分字段缺省', () => {
  it('只写 model：其余回落内置默认并标 builtin-default', () => {
    resetConfigCache();
    const file = writeConfig('partial.yaml', ['  model: only-model']);
    const summary = buildEmbeddingSummary(loadConfig(file));

    assert.equal(summary.model.source, 'configured');
    assert.equal(summary.model.value, 'only-model');
    for (const field of ['provider', 'baseURL', 'dimension', 'queryTimeoutMs'] as const) {
      assert.equal(summary[field].source, 'builtin-default', `${field} 应为 builtin-default`);
    }
    // 值本身来自 DEFAULT_EMBEDDING，不等于「用户配过」
    assert.equal(summary.dimension.value, 1024);
  });

  it('★ 显式写默认值仍算 configured（不能靠比较值来猜来源）', () => {
    resetConfigCache();
    const file = writeConfig('explicit-default.yaml', ['  dimension: 1024', '  provider: dashscope']);
    const summary = buildEmbeddingSummary(loadConfig(file));

    assert.equal(summary.dimension.source, 'configured');
    assert.equal(summary.provider.source, 'configured');
    assert.equal(summary.dimension.value, 1024);
  });

  it('★ 空字符串 provider/model 不算 configured（与 config.ts 的 truthy 合并同口径）', () => {
    resetConfigCache();
    const file = writeConfig('empty-strings.yaml', ['  provider: ""', '  model: ""']);
    const summary = buildEmbeddingSummary(loadConfig(file));

    // schema 对 provider/model 没有 validate，空串能过校验；config.ts 用 truthy 判断 → 回落默认值。
    // 若这里按「字段存在」判 configured，就会出现「值来自内置默认、却标成你的配置」（D-1 反向）。
    assert.equal(summary.provider.source, 'builtin-default');
    assert.equal(summary.model.source, 'builtin-default');
    assert.equal(summary.provider.value, 'dashscope');
    assert.equal(summary.model.value, 'qwen3.7-text-embedding-flash');
  });

  it('整段 embedding 缺省：全 builtin-default 且 apiKey 未配置', () => {
    resetConfigCache();
    const file = writeConfig('no-embedding.yaml', null);
    const summary = buildEmbeddingSummary(loadConfig(file));

    for (const field of ['provider', 'baseURL', 'model', 'dimension', 'queryTimeoutMs'] as const) {
      assert.equal(summary[field].source, 'builtin-default', `${field} 应为 builtin-default`);
    }
    assert.equal(summary.apiKeyConfigured, false);
    assert.equal(summary.configPath, file);
  });
});

describe('apiKey 只出布尔', () => {
  it('${ENV_VAR} 引用的变量不存在时等同未配置', () => {
    resetConfigCache();
    const envName = 'KI_TEST_UNDEFINED_API_KEY_XYZ';
    delete process.env[envName];
    const file = writeConfig('env-missing.yaml', ['  apiKey: ${' + envName + '}']);
    const summary = buildEmbeddingSummary(loadConfig(file));
    assert.equal(summary.apiKeyConfigured, false);
  });

  it('${ENV_VAR} 引用的变量存在时为 true', () => {
    resetConfigCache();
    const envName = 'KI_TEST_PRESENT_API_KEY_XYZ';
    process.env[envName] = 'sk-from-env';
    try {
      const file = writeConfig('env-present.yaml', ['  apiKey: ${' + envName + '}']);
      const summary = buildEmbeddingSummary(loadConfig(file));
      assert.equal(summary.apiKeyConfigured, true);
      assert.equal(JSON.stringify(summary).includes('sk-from-env'), false);
    } finally {
      delete process.env[envName];
    }
  });
});

describe('降级', () => {
  it('无配置文件：configPath 为 null、全 builtin-default、不报 warning', () => {
    const summary = buildEmbeddingSummary(fakeConfig(undefined));
    assert.equal(summary.configPath, null);
    for (const field of ['provider', 'baseURL', 'model', 'dimension', 'queryTimeoutMs'] as const) {
      assert.equal(summary[field].source, 'builtin-default');
    }
    assert.equal(summary.warning, undefined, '没有配置文件属正常态，不该报 warning');
  });

  it('★ 配置文件读不出来：降级 + warning，不抛错', () => {
    const summary = buildEmbeddingSummary(fakeConfig(path.join(tmpRoot, 'not-exist.yaml')));
    assert.equal(summary.configPath, path.join(tmpRoot, 'not-exist.yaml'));
    for (const field of ['provider', 'baseURL', 'model', 'dimension', 'queryTimeoutMs'] as const) {
      assert.equal(summary[field].source, 'builtin-default', '读不到文件时不能谎称 configured');
    }
    assert.ok(typeof summary.warning === 'string' && summary.warning.length > 0);
  });
});
