/**
 * delete-relation-wiki.test.ts —— 文档级硬删（D7）
 *
 * 契约（REQ-20261019-005）：
 *   - 源目录已配置且 sourcePath 匹配 → unlink 源 .md；
 *   - sourcePath 不匹配 → 拒绝（source-mismatch），文件零变化；
 *   - 无 sourcePath（历史数据）→ 按文件名删除并标 legacy-name。
 *
 * 运行：npx jiti test/delete-relation-wiki.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');
(vectorClient as any).ensureVectorAvailable = async () => ({ available: true, reason: undefined });
(vectorClient as any).vectorDelete = async () => ({ deleted: 1, failedIds: [], errors: [] });

const { executeDeleteRelation } = await import('../src/delete-relation.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir, setSource } = await import('../src/lib/scope.js');

function setup(scope: string, sourcePath?: string) {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dr-src-'));
  setSource(scope, { dir: sourceDir });

  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify({
    version: 1, scope, groups: { wiki: {} }, source: { dir: sourceDir }, updatedAt: new Date().toISOString(),
  }), 'utf-8');

  const rel: Record<string, unknown> = {
    id: 'rel_1', text: 'a', score: 1, useCount: 0, lastUsedTime: null, isImported: true, memoryIds: ['m1'],
  };
  if (sourcePath) rel.sourcePath = sourcePath;
  fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify({
    version: 1, scope, partition_config: {}, groups: { wiki: { hot_relations: [rel], keywords: [] } },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  fs.mkdirSync(path.join(kbDir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'wiki', 'index.json'), JSON.stringify({ a: '# body' }), 'utf-8');

  fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });
  const file = path.join(sourceDir, 'wiki', 'a.md');
  fs.writeFileSync(file, '# body', 'utf-8');
  return { sourceDir, file };
}

let seq = 0;
function freshScope(): string {
  const s = `dr-wiki-${Date.now()}-${seq++}`;
  registerTestScope(s);
  return s;
}

after(() => cleanupTestConfig());

describe('delete-relation · 文档级硬删', () => {
  it('sourcePath 匹配 → 删除源文件', async () => {
    const s = freshScope();
    const { file } = setup(s, 'wiki/a.md');
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, true);
    assert.equal(r.result.wikiMatch, 'sourcePath');
    assert.equal(fs.existsSync(file), false);
  });

  it('sourcePath 不匹配 → 拒绝删除，文件仍在', async () => {
    const s = freshScope();
    const { file } = setup(s, 'other/a.md');
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, false);
    assert.equal(r.result.wikiSkipReason, 'source-mismatch');
    assert.equal(fs.existsSync(file), true);
  });

  it('软链逃逸 → 拒绝删除（outside-source-dir）', async () => {
    const s = freshScope();
    const { sourceDir, file } = setup(s);
    const outside = path.join(os.tmpdir(), `ki-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, '# outside', 'utf-8');
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, false);
    assert.equal(r.result.wikiSkipReason, 'outside-source-dir');
    assert.equal(fs.existsSync(outside), true);
    fs.rmSync(outside, { force: true });
  });

  it('无 sourcePath（历史数据）→ 按文件名删除并标 legacy-name', async () => {
    const s = freshScope();
    const { file } = setup(s);
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, true);
    assert.equal(r.result.wikiMatch, 'legacy-name');
    assert.equal(fs.existsSync(file), false);
  });
});
