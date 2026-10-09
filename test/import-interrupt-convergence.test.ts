/**
 * import-interrupt-convergence.test.ts —— 导入中断重跑收敛（批次 2 工作项 6，决策 D5）
 *
 * 拆分后 import 的跨文件一致性等级与拆分前相同（WAL 单文件原子 + 幂等重导兜底）；
 * 本文件锁定「中断 → 重跑 → 收敛」语义，两条路径：
 *   - D5a（确定性）：注入等价的中断残留（丢分片 + manifest 超前）→ 重跑收敛到完整集
 *   - D5b（真实 kill -9）：子进程导入中途被杀 → 重跑收敛到完整集
 *
 * 运行：npx jiti test/import-interrupt-convergence.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { resetConfigCache } from '../src/lib/config.js';
import { readAllGroupCaches, hasShardedLayout, getRelationsRoot, getRelationsManifestPath } from '../src/lib/group-cache.js';
import { getKbDir } from '../src/lib/scope.js';
import { handleDirectImport } from '../src/lib/import.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-interrupt-'));
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/** 建项目配置（隔离 HOME 语义：dataDir/vectorDir 全在 tmp） */
function setupConfig(scope: string): void {
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
}

/** 建源目录：groups 个组 × filesPerGroup 个文件（确定性命名，便于断言） */
function makeSource(groups: number, filesPerGroup: number): string {
  const src = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
  for (let g = 0; g < groups; g++) {
    const gdir = path.join(src, `组${String(g).padStart(2, '0')}`);
    fs.mkdirSync(gdir, { recursive: true });
    for (let f = 0; f < filesPerGroup; f++) {
      fs.writeFileSync(
        path.join(gdir, `文档-${String(g).padStart(2, '0')}-${String(f).padStart(2, '0')}.md`),
        `# 文档 ${g}-${f}\n\n内容 ${g}-${f}。\n`,
        'utf-8',
      );
    }
  }
  return src;
}

/** 快照式读取：{ group → sorted texts } */
function snapshot(scope: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of readAllGroupCaches(scope)) {
    out[k] = v.hot_relations.map((r) => r.text).sort();
  }
  return out;
}

describe('导入中断重跑收敛（批次 2 工作项 6，D5）', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('D5a：确定性残留（丢分片 + manifest 超前）→ 重跑导入收敛到完整集（无重复）', async () => {
    const scope = 'd5a';
    setupConfig(scope);
    const src = makeSource(4, 5); // 4 组 × 5 文件 = 20 relations

    // 首次完整导入（--no-vector：FTS-only，不触向量层）
    const first = await handleDirectImport({ scope, sourceDir: src, vector: false });
    assert.equal(first.ok, true);
    const full = snapshot(scope);
    assert.equal(Object.keys(full).length, 4, '完整导入应覆盖 4 组');
    assert.equal(Object.values(full).flat().length, 20);

    // 注入等价中断残留：删 2 个分片文件（“写到一半被杀”）+ manifest revision 人为超前
    const allKeys = Object.keys(full);
    const removed = allKeys.slice(0, 2);
    for (const k of removed) {
      fs.rmSync(path.join(getRelationsRoot(scope), k), { recursive: true, force: true });
    }
    const manifestPath = getRelationsManifestPath(scope);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { revision: number };
    manifest.revision += 100; // 模拟“revision 已 bump 但分片未写全”
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const afterInterrupt = snapshot(scope);
    assert.equal(Object.keys(afterInterrupt).length, 2, '中断残留态：仅剩 2 组');

    // 重跑同一导入 → 必须收敛回完整集（幂等重导覆盖语义）
    const second = await handleDirectImport({ scope, sourceDir: src, vector: false });
    assert.equal(second.ok, true);
    const converged = snapshot(scope);
    assert.deepEqual(converged, full, '重跑后必须收敛到与完整导入完全一致（无重复、无缺漏）');
  });

  it('D5b：真实 kill -9 中断 → 重跑导入收敛（任意中断时机）', async () => {
    const scope = 'd5b';
    setupConfig(scope);
    const src = makeSource(8, 5); // 8 组 × 5 文件 = 40 relations（写入窗口足够被观测）

    // 子进程发起导入
    const scriptPath = path.join(tmpRoot, 'child-import.ts');
    fs.writeFileSync(scriptPath, `
const { handleDirectImport } = await import(${JSON.stringify(path.join(PROJECT_ROOT, 'src/lib/import.ts'))});
const r = await handleDirectImport({ scope: process.argv[2], sourceDir: process.argv[3], vector: false });
process.stdout.write('IMPORT_DONE ' + r.ok + '\\n');
`, 'utf-8');

    const child = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, 'node_modules/jiti/lib/jiti-cli.mjs'), scriptPath, scope, src],
      { env: { ...process.env, KI_CONFIG_PATH: process.env.KI_CONFIG_PATH }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let childOut = '';
    child.stdout.on('data', (d) => { childOut += String(d); });

    // 轮询：等待 relations/ 出现（Phase 4 开始落盘）→ 等 15ms（让部分组分片写下）→ SIGKILL
    const relRoot = getRelationsRoot(scope);
    const deadline = Date.now() + 40_000;
    let sawWrite = false;
    while (Date.now() < deadline) {
      if (fs.existsSync(relRoot) && fs.statSync(relRoot).isDirectory()) {
        const hasShard = fs.readdirSync(relRoot).some((n) => n !== 'manifest.json');
        if (hasShard) { sawWrite = true; break; }
      }
      if (childOut.includes('IMPORT_DONE')) break; // 太快完成（未命中窗口）
      await new Promise((r) => setTimeout(r, 2));
    }
    if (sawWrite) {
      await new Promise((r) => setTimeout(r, 15));
      child.kill('SIGKILL'); // kill -9 等价
    }
    // 必须等 'exit' 事件真正回收子进程（僵尸进程仍占 pid → 父进程的 stale 锁检测
    // (process.kill(pid,0) 成功) 会误判锁仍在用）。真实 CLI 场景由 shell reap，
    // 测试作为父进程必须自己 wait。
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { resolve(); }, 10_000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });

    // 无论 kill 是否命中写入窗口，重跑必须收敛（宽松但真实的断言）
    const second = await handleDirectImport({ scope, sourceDir: src, vector: false });
    assert.equal(second.ok, true);
    const converged = snapshot(scope);
    const totalRelations = Object.values(converged).flat().length;
    assert.equal(totalRelations, 40, `重跑后 relation 总数必须收敛为 40（实得 ${totalRelations}；kill 命中=${sawWrite}）`);
    for (const [, texts] of Object.entries(converged)) {
      assert.equal(new Set(texts).size, texts.length, '不得有重复 relation');
    }
    // 分片布局健康（manifest 存在 + 组数与源一致）
    assert.ok(hasShardedLayout(scope));
    assert.equal(Object.keys(converged).length, 8);
  });
});
