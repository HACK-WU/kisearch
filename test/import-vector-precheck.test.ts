/**
 * import-vector-precheck.test.ts —— `ki import` 的向量前置拦截（2026-11-02）
 *
 * 背景：`ki mcp` 改为「embedding 任何失败都允许启动」后，用户很容易在"没有可用 key"
 * 的状态下直接跑 `ki import`。原实现要扫描 + 切分 + 走到向量化阶段才报「均未完成向量化」，
 * 大目录等于白等；文案又只说"请修复 embedding"，没有第二条出路。
 *
 * 契约（本文件锁住的）：
 *   1) `vector` 模式且 `embedding.apiKey` 为空 ⇒ **在扫描之前** fail-loud（exit 1）；
 *   2) 错误信息必须点名 `--no-vector`（给用户可执行出路，而不是只让他去修 key）；
 *   3) 加上 `--no-vector` 后同一命令可继续执行（FTS-only）。
 *
 * 运行：npx jiti test/import-vector-precheck.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JITI_CLI } from './test-config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-import-precheck-'));
const home = path.join(tmpRoot, 'home');
const configPath = path.join(tmpRoot, 'config.yaml');
const wikiDir = path.join(tmpRoot, 'wiki');
const kbDir = path.join(tmpRoot, 'kb');
const vectorDir = path.join(tmpRoot, 'vector');
const backupDir = path.join(tmpRoot, 'backup');

for (const dir of [home, wikiDir, kbDir, vectorDir, backupDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(wikiDir, 'a.md'), '# 前置拦截验证\n\n无 key 时应提示 --no-vector。\n', 'utf-8');
fs.writeFileSync(
  configPath,
  [
    `dataDir: ${kbDir}`,
    `vectorDir: ${vectorDir}`,
    `backupDir: ${backupDir}`,
    'scopeMode: default',
    'scopes:',
    '  default: {}',
    'embedding:',
    // 引用不存在的环境变量 ⇒ embedding.apiKey 解析为空（最常见的"没配 key"形态）
    '  apiKey: ${KI_PRECHECK_ABSENT_KEY}',
    '  dimension: 4096',
    '',
  ].join('\n'),
  'utf-8',
);

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runImport(extraArgs: string[] = []): CliResult {
  const env = {
    ...process.env,
    KI_CONFIG_PATH: configPath,
    HOME: home,
    USERPROFILE: home,
  };
  try {
    const stdout = execFileSync(
      process.execPath,
      [JITI_CLI, path.resolve('src/import.ts'),
        '--scope', 'default',
        '--source', wikiDir,
        '--group', 'demo',
        ...extraArgs],
      { encoding: 'utf-8', env, cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('ki import · 向量前置拦截', () => {
  before(() => {
    delete process.env.KI_PRECHECK_ABSENT_KEY;
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('未配置 apiKey 且未加 --no-vector → exit 1，且提示 --no-vector 出路', () => {
    const res = runImport();
    assert.notEqual(res.status, 0, '必须拦住，而不是跑到向量化阶段才失败');
    const text = `${res.stdout}${res.stderr}`;
    assert.match(text, /embedding\.apiKey 未配置/);
    assert.match(text, /--no-vector/, '必须给出可执行出路');
  });

  it('加上 --no-vector → 可继续执行（FTS-only）', () => {
    const res = runImport(['--no-vector']);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
  });
});
