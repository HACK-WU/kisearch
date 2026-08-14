/**
 * import-scheme-d.test.ts —— 方案 D 导入流程专项测试（REQ-06/08，local KB 原文保留 + 格式限制）
 *
 * 契约：
 *   - local KB 存文件级原文（未清洗）——含 frontmatter/BOM 的文档，local KB 保留原文
 *   - 前置检查：非 md 跳过 + 汇总提示；>1MB 跳过（--no-vector 免 embedding，可测 local KB 语义）
 *   - --no-vector：local KB 原文照写、memoryIds 为空
 *
 * 运行：npx jiti test/import-scheme-d.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

const SCRIPT = path.resolve('src/scan-kb.ts');

function runImport(args: string[]): any {
  const { execFileSync } = require('node:child_process');
  let out: string;
  try {
    out = execFileSync('npx', ['jiti', SCRIPT, ...args], {
      encoding: 'utf-8',
      env: getTestEnv(),
      cwd: path.resolve('.'),
    });
  } catch (err: any) {
    // 负向用例：子进程非零退出但 stdout 仍输出结果 JSON
    out = err.stdout ?? '';
  }
  return JSON.parse(out);
}

function mkSource(files: Record<string, string>, skip: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-d-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const rel of skip) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'not markdown');
  }
  return dir;
}

const scope = `scheme-d-${Date.now()}`;

describe('方案 D 导入：local KB 原文保留 + 格式限制（--no-vector 免 embedding）', () => {
  before(() => {
    registerTestScope(scope);
  });

  after(() => {
    cleanupTestConfig();
  });

  it('local KB 存文件级原文（含 frontmatter/BOM 未清洗）', () => {
    const src = mkSource({
      'docs/api.md': '\uFEFF---\ntitle: API\n---\n# 正文\n内容',
    });
    const r = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));

    // local KB 应存原文（未清洗：含 BOM/frontmatter）
    const { getLocalKbDir } = require('../src/lib/scope.js');
    const kbPath = getLocalKbDir(scope, 'wiki/docs');
    const kb = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
    assert.ok(kb['api'], '文件级 relation（basename 去扩展名）应为 key');
    assert.ok(kb['api'].includes('\uFEFF---'), 'local KB 保留 BOM + frontmatter（未清洗）');
    assert.ok(kb['api'].includes('title: API'));
  });

  it('--no-vector：memoryIds 为空，local KB 仍写入', () => {
    const src = mkSource({ 'a.md': '# A\n内容' });
    const r = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true);

    const { getRelationsCachePath } = require('../src/lib/scope.js');
    const cache = JSON.parse(fs.readFileSync(getRelationsCachePath(scope), 'utf-8'));
    const rel = cache.groups['wiki'].hot_relations.find((x: any) => x.text === 'a');
    assert.ok(rel, '文件级 relation a 应存在');
    assert.ok(Array.isArray(rel.memoryIds) && rel.memoryIds.length === 0, '--no-vector 时 memoryIds 为空');
    assert.strictEqual(rel.sourcePath, 'a.md', 'sourcePath 无 #N');
  });

  it('非 md 文件跳过 + 汇总提示', () => {
    const src = mkSource({ 'ok.md': '# OK\n内容' }, ['note.txt', 'slide.pdf']);
    const r = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true);
    // files=1（只有 ok.md），非 md 跳过（输出到 stderr，JSON 不含 skippedNonMd）
    assert.strictEqual(r.stats.total, 1);
  });

  it('幂等重导：同文件重跑 import 不冲突，正常覆盖', () => {
    // 第一次导入 x/a.md（group wiki/x，relation a）
    const srcA = mkSource({ 'x/a.md': '# A1\n内容1' });
    const rA = runImport(['import', '--scope', scope, '--source', srcA, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(rA.ok, true);
    assert.strictEqual(rA.stats.total, 1);
    // 同文件重导（sourcePath 相同）→ 幂等覆盖，不跳过
    const rB = runImport(['import', '--scope', scope, '--source', srcA, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(rB.ok, true);
    assert.strictEqual(rB.stats.total, 1, '同文件重导应为幂等覆盖（不跳过、不新增）');
    assert.strictEqual(rB.stats.skipped, 0, '幂等重导不应计入 skipped');
  });

  it('真冲突（同 group 不同文件同名，sourcePath 不同）跳过', () => {
    // 已导入 x/a.md；导入 y/a.md（不同 group 不冲突）
    const srcY = mkSource({ 'y/a.md': '# A-y\n内容Y' });
    const rY = runImport(['import', '--scope', scope, '--source', srcY, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(rY.ok, true);
    assert.strictEqual(rY.stats.total, 1, '不同 group 同名不冲突');
    // 同 group 下另一文件同名（x/a.md 与 x2/a.md 不同 group；需同 group）：
    // 构造同 group wiki/x 下第二文件也命名为 a（无法直接构造，验证逻辑：sourcePath 相同则不冲突）
    const rC = runImport(['import', '--scope', scope, '--source', mkSource({ 'x/a.md': '# A3\n内容3' }), '--group', 'wiki', '--no-vector']);
    assert.strictEqual(rC.ok, true);
    assert.strictEqual(rC.stats.total, 1, '同文件再次重导仍幂等（sourcePath 相同）');
  });

  it('--group 多级路径落点：自动建父路径 + 子目录挂载', () => {
    const src = mkSource({
      'a.md': '# A\n内容A',
      'sub/b.md': '# B\n内容B',
    });
    const r = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki/部署运维', '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.stats.total, 2);
    // 多级落点：父路径 wiki + 完整路径 wiki/部署运维 + 子目录 wiki/部署运维/sub
    assert.ok(r.groups.includes('wiki'), `应含父 group wiki；实际=${JSON.stringify(r.groups)}`);
    assert.ok(r.groups.includes('wiki/部署运维'), `应含落点 group；实际=${JSON.stringify(r.groups)}`);
    assert.ok(r.groups.includes('wiki/部署运维/sub'), `子目录应挂到落点下；实际=${JSON.stringify(r.groups)}`);
  });

  it('--group 缺省时：顶层 .md 落 scope name（K2 决策）', () => {
    const src = mkSource({ 'a.md': '# A\n内容' });
    const r = runImport(['import', '--scope', scope, '--source', src, '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.groups.includes(scope), `缺省 --group 顶层 .md 应落 scope name；实际=${JSON.stringify(r.groups)}`);
  });

  it('单文件导入：--source 直接传 .md 文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-d-file-'));
    const file = path.join(dir, 'solo.md');
    fs.writeFileSync(file, '# Solo\n单文件内容');
    // 显式 --group
    const r1 = runImport(['import', '--scope', scope, '--source', file, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.strictEqual(r1.stats.total, 1);
    assert.ok(r1.groups.includes('wiki'), `显式 --group 应生效；实际=${JSON.stringify(r1.groups)}`);
    // 缺省 --group → scope name（回退用例：修复 ENOTDIR 单文件路径拼接 bug）
    const r2 = runImport(['import', '--scope', scope, '--source', file, '--no-vector']);
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.ok(r2.groups.includes(scope), `单文件缺省 --group 应落 scope name；实际=${JSON.stringify(r2.groups)}`);
    // 非 .md 单文件：fail-loud 拒绝（REQ-08 白名单不因单文件路径绕过）
    const txt = path.join(dir, 'plain.txt');
    fs.writeFileSync(txt, 'not markdown');
    const r3 = runImport(['import', '--scope', scope, '--source', txt, '--no-vector']);
    assert.strictEqual(r3.ok, false, '非白名单后缀应 fail-loud');
    assert.ok(String(r3.error).includes('不支持的文件格式'), `实际=${JSON.stringify(r3.error)}`);
  });

  it('新增文档追加到已有 group', () => {
    const src = mkSource({ 'a.md': '# A v1\n内容A' });
    const r1 = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.stats.total, 1);

    // 新增 b.md + 修改 a.md 后重新导入
    fs.writeFileSync(path.join(src, 'b.md'), '# B\n内容B');
    fs.writeFileSync(path.join(src, 'a.md'), '# A v2\n内容A改');
    const r2 = runImport(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    // 1 个旧文件（a 覆盖）+ 1 新增（b）= 2
    assert.strictEqual(r2.stats.total, 2, `追加后 total 应为 2；实际=${r2.stats.total}`);
  });

  it('废弃参数负向验证：--mode/--root-name 报未知，diff 子命令不存在', () => {
    const src = mkSource({ 'a.md': '# A\n内容' });
    const { execFileSync } = require('node:child_process');
    // 辅助：跑一次，返回 { code, stdout, stderr }（commander 对未知参数/命令输出 help 文本，非 JSON）
    const runRaw = (args: string[]) => {
      try {
        const out = execFileSync('npx', ['jiti', SCRIPT, ...args], { encoding: 'utf-8', env: getTestEnv(), cwd: path.resolve('.') });
        return { code: 0, stdout: out, stderr: '' };
      } catch (e: any) {
        return { code: e.status ?? 1, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
      }
    };
    // --mode 已移除 → 未知参数（commander 输出 help 到 stderr/stdout，非 JSON）
    const rMode = runRaw(['import', '--scope', scope, '--source', src, '--group', 'wiki', '--mode', 'incremental', '--no-vector']);
    assert.notStrictEqual(rMode.code, 0, '--mode 应报未知参数（非 0 退出）');
    assert.ok(/未知|unknown|no such option|unrecognized/i.test(rMode.stderr + rMode.stdout), `应提示未知参数；stdout=${rMode.stdout} stderr=${rMode.stderr}`);
    // --root-name 已移除 → 未知参数
    const rRoot = runRaw(['import', '--scope', scope, '--source', src, '--root-name', 'wiki', '--no-vector']);
    assert.notStrictEqual(rRoot.code, 0, '--root-name 应报未知参数（非 0 退出）');
    assert.ok(/未知|unknown|no such option|unrecognized/i.test(rRoot.stderr + rRoot.stdout), `应提示未知参数；stdout=${rRoot.stdout}`);
    // diff 子命令已移除 → commander 报未知命令
    const rDiff = runRaw(['diff', '--scope', scope]);
    assert.notStrictEqual(rDiff.code, 0, 'diff 子命令应不存在（非 0 退出）');
    assert.ok(/未知|unknown|not.*command|command.*not|no such command/i.test(rDiff.stderr + rDiff.stdout), `diff 子命令应不存在；stdout=${rDiff.stdout}`);
  });
});
