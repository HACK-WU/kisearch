/**
 * cross-process-invalidation.test.ts —— 跨进程缓存失效（批次 2 工作项 6，D3 兜底机制）
 *
 * 场景：daemon 进程内缓存（docListCache / relation-map / scopeDocCountCache）在
 * CLI 子进程写入分片后必须失效——daemon 无法收到 CLI 的进程内失效广播，
 * 唯一兜底 = 布局感知身份三元组（manifest revision 由子进程 bump → 父进程下次读
 * 身份不匹配 → 重算）。
 *
 * 本测试用真实子进程（spawnSync + jiti）写入，父进程读缓存必须看到新数据。
 *
 * 运行：npx jiti test/cross-process-invalidation.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetConfigCache } from '../src/lib/config.js';
import { writeGroupCacheBatch, readAllGroupCaches } from '../src/lib/group-cache.js';
import { getRelationMap, clearRelationMapCache } from '../src/lib/relation-map.js';
import { getKbDir } from '../src/lib/scope.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xproc-'));
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function setupConfig(scope: string): { configPath: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-'));
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${path.join(dir, 'kb')}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      'scopeMode: default',
      'scopes:',
      `  ${scope}: {}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
  return { configPath };
}

const rel = (text: string, extra: Record<string, unknown> = {}) => ({
  id: `r-${text}`, text, score: 1, useCount: 0, lastUsedTime: null, ...extra,
}) as never;

/** 子进程脚本：用同一 KI_CONFIG_PATH 写入一条 relation（模拟 CLI 写路径）。 */
const CHILD_SCRIPT = `
const gc = await import(${JSON.stringify(path.join(PROJECT_ROOT, 'src/lib/group-cache.ts'))});
const scope = process.argv[2];
const group = process.argv[3];
gc.writeGroupCache(scope, group, {
  version: 1, scope,
  hot_relations: [{ id: 'r-子进程新条', text: '子进程新条', score: 1, useCount: 0, lastUsedTime: null, memoryId: 'm-child' }],
  keywords: [], updatedAt: null,
});
process.stdout.write('CHILD_OK\\n');
`;

describe('跨进程缓存失效（批次 2 工作项 6：CLI 写 → daemon 读不 stale）', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    clearRelationMapCache();
  });

  it('子进程 bump revision → 父进程 relation-map 与全量读立即看到新数据', () => {
    const scope = 'xproc';
    setupConfig(scope);
    fs.mkdirSync(getKbDir(scope), { recursive: true });

    // 父进程初始数据 + 建立缓存
    writeGroupCacheBatch(scope, new Map([
      ['g1', { version: 1, scope, hot_relations: [rel('父进程原有', { memoryId: 'm-parent' })], keywords: [] }],
    ]));
    const map1 = getRelationMap(scope);
    assert.ok(map1.has('m-parent'), '父进程缓存建立');
    assert.ok(!map1.has('m-child'));

    // 子进程（独立进程）写入 —— 父进程收不到任何进程内失效广播
    // 用临时脚本文件（jiti -e 下 process.argv 语义不同，脚本文件方式稳定）
    const childScriptPath = path.join(tmpRoot, 'child-writer.ts');
    fs.writeFileSync(childScriptPath, CHILD_SCRIPT, 'utf-8');
    const out = execFileSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'node_modules/jiti/lib/jiti-cli.mjs'), childScriptPath, scope, 'g1x'],
      {
        env: { ...process.env, KI_CONFIG_PATH: process.env.KI_CONFIG_PATH },
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    assert.match(out, /CHILD_OK/, '子进程写入完成');

    // 父进程读：身份三元组（revision 已由子进程 bump）必须触发重算
    const map2 = getRelationMap(scope);
    assert.ok(map2.has('m-child'), '跨进程写后父进程缓存必须失效（revision 兜底）');
    assert.ok(map2.has('m-parent'), '旧数据仍在（新组写入不丢旧组）');

    const all = readAllGroupCaches(scope);
    assert.deepEqual([...all.keys()].sort(), ['g1', 'g1x'].sort());
  });
});
