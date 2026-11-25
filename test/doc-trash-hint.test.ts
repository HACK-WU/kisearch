/**
 * doc-trash-hint.test.ts —— `/api/doc/get` 404 的「已删除」判据（2026-11-25）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/doc-trash-hint.test.ts
 *
 * 守四件事：
 *   ① 被删的文档判得出来，且带得出「哪个条目 / 为什么删 / 什么时候到期」——
 *      没有这些就只有一句「未匹配到有效路径」，用户不知道该去回收站恢复；
 *   ② 文案必须点明「已被删除」并给出出口，且与「路径写错」区分开；
 *   ③ 整组被删时按路径前缀命中（`kind='group'`），不能因为没逐篇读快照就漏判；
 *   ④ 没进过站的文档一律 null —— 为了"更友好"把任何 404 都说成已删除是撒谎。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { moveToTrash } from '../src/lib/trash-service.js';
import { writeGroupTrashItem } from '../src/lib/trash-store.js';
import { buildDocTrashHint, findDocInTrash } from '../src/lib/doc-trash-hint.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `doc-trash-hint-${Date.now()}`;
/** 文档被单独删除的组 */
const GROUP = '错误库/单篇删除';
/** 整组被删的组（含子组前缀判定） */
const GROUP_TREE = '错误库/整组删除';
const GROUP_TREE_DEEP = '错误库/整组删除/子组';

function seedDoc(group: string, name: string, content: string): Relation {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  const kbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = content;
  writeJson(kbPath, kb);
  return rel;
}

/** 走真实链路的写快照部分（正文从 KB 读，KB 摘除由调用方按需模拟） */
function intoTrash(group: string, name: string, content: string): string {
  const rel = seedDoc(group, name, content);
  const moved = moveToTrash({ scope, group, relation: name, reason: 'manual', relationSnapshot: rel });
  assert.equal(moved.ok, true, moved.ok ? '' : moved.error);
  if (!moved.ok) throw new Error('入站失败');
  return moved.item.dirName;
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 单篇删除：判据与出处', () => {
  it('命中文档条目，带 dirName / reason / 到期时间', () => {
    const dirName = intoTrash(GROUP, '被删的文档', '# 被删的文档\n\n正文');

    const hit = findDocInTrash(scope, GROUP, '被删的文档');
    assert.ok(hit, '回收站里确实有这篇，必须判得出来');
    assert.equal(hit.kind, 'doc');
    assert.equal(hit.scope, scope);
    assert.equal(hit.group, GROUP);
    assert.equal(hit.name, '被删的文档');
    assert.equal(hit.dirName, dirName);
    assert.equal(hit.reason, 'manual');
    assert.ok(hit.expiresAt > Date.now(), '到期时间必须在未来（否则页面给的"可恢复"是假的）');
  });

  it('文案说清「在哪 + 为什么删」，并给出回收站出口', () => {
    const hit = findDocInTrash(scope, GROUP, '被删的文档');
    assert.ok(hit);
    const payload = buildDocTrashHint(hit);
    assert.equal(payload.code, 'DOC_IN_TRASH');
    assert.match(payload.error, /回收站/);
    assert.match(payload.error, /手动删除/);
    assert.match(payload.hint, /回收站/);
    // 「已被删除」由抽屉标题承担，error 不重复（重复会让整块提示读起来像回声）
    assert.doesNotMatch(payload.error, /已被删除/);
    assert.equal(payload.trash.dirName, hit.dirName);
  });
});

describe('② 整组删除：按路径前缀命中', () => {
  it('建组快照后，子组路径也判得出来（kind=group）', () => {
    const createdAt = Date.now();
    writeGroupTrashItem({
      scope,
      group: GROUP_TREE,
      reason: 'manual',
      now: createdAt,
      groups: [GROUP_TREE, GROUP_TREE_DEEP],
      docs: [
        { group: GROUP_TREE, name: '顶层篇', source: 'both', content: '# 顶层篇' },
        { group: GROUP_TREE_DEEP, name: '子组篇', source: 'both', content: '# 子组篇' },
      ],
      assets: [],
      keepDays: 7,
    });

    const deep = findDocInTrash(scope, GROUP_TREE_DEEP, '子组篇');
    assert.ok(deep, '整组被删时子组里的文档同样在站里');
    assert.equal(deep.kind, 'group');
    assert.equal(deep.group, GROUP_TREE, '命中条目应回被删组的根路径，页面据此说明是哪一组没了');

    const payload = buildDocTrashHint(deep);
    assert.match(payload.error, /分组/);
    assert.match(payload.error, /已被整体删除/);
    assert.match(payload.error, /回收站/);
  });
});

describe('③ 不误报', () => {
  it('从没进过站的文档 → null（路径写错的 404 不能被说成已删除）', () => {
    seedDoc(GROUP, '还在库里的文档', '# 正常文档');
    assert.equal(findDocInTrash(scope, GROUP, '还在库里的文档'), null);
  });

  it('组路径写错（不是被删组的前缀）→ null', () => {
    assert.equal(findDocInTrash(scope, '错误库/不存在的组', '被删的文档'), null);
  });

  it('组是前缀但多一层 '/'-分隔才算命中：`错误库/整组删除x` 不命中', () => {
    // 防止用裸 startsWith 实现时把「同名前缀的兄弟组」算进去
    assert.equal(findDocInTrash(scope, `${GROUP_TREE}x`, '任意篇'), null);
  });
});