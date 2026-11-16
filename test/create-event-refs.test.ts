/**
 * create-event-refs.test.ts —— 创建事件时一次挂参考文档（REQ-20261116-004 · S-02）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/create-event-refs.test.ts
 *
 * 覆盖：refs 随创建落盘 / docs∩refs 记 skipped(already-associated) 不整批失败 /
 *       refs 超上限 → 事件未创建 / 关联文档部分失败不影响事件与参考文档 / addedBy 跟随 by
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { createEventWithBinding } from '../src/lib/events/event-service.js';
import { MEMBER_LIMIT } from '../src/lib/events/members.js';
import { readRefs } from '../src/lib/events/refs-store.js';
import { REF_LIMIT } from '../src/lib/events/refs-service.js';
import { readAllEvents } from '../src/lib/events/store.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `create-event-refs-${Date.now()}`;
const GROUP = '专题记忆/创建引用测试';

function seedDoc(name: string, extra: Partial<Relation> = {}): Relation {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
    ...extra,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);

  const kbPath = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = `# ${name}\n正文`;
  writeJson(kbPath, kb);
  return rel;
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

describe('创建时带参考文档', () => {
  it('refs 落盘并回显 added / addedList', async () => {
    const a = seedDoc('参考文档A');
    const b = seedDoc('参考文档B');
    const outcome = await createEventWithBinding(scope, {
      title: '带参考',
      typeId: 'et_1',
      refs: [{ group: GROUP, name: a.text }, { group: GROUP, name: b.text }],
    });

    assert.equal(outcome.binding.refs.added, 2);
    assert.equal(outcome.binding.refs.addedList.length, 2);
    const stored = readRefs(scope, outcome.event.id);
    assert.equal(stored.length, 2);
    assert.equal(stored[0]?.addedBy, 'manual', '页面创建走 user → manual');
  });

  it('docs∩refs 交集 → skipped(already-associated)，其余照常', async () => {
    const shared = seedDoc('同一篇文档');
    const outcome = await createEventWithBinding(scope, {
      title: '交集',
      typeId: 'et_1',
      docs: [{ group: GROUP, name: shared.text }],
      refs: [{ group: GROUP, name: shared.text }],
    });

    assert.equal(outcome.binding.docs.bound.length, 1);
    assert.equal(outcome.binding.refs.added, 0);
    assert.equal(outcome.binding.refs.skipped.length, 1);
    assert.equal(outcome.binding.refs.skipped[0]?.reason, 'already-associated');
    assert.equal(readRefs(scope, outcome.event.id).length, 0, '交集不得写进引用');
  });

  it(`refs > ${REF_LIMIT} → REF_LIMIT_EXCEEDED 且事件未创建`, async () => {
    const before = readAllEvents(scope).length;
    const refs = Array.from({ length: REF_LIMIT + 1 }, (_, i) => ({ group: GROUP, name: `不存在${i}` }));
    await assert.rejects(
      () => createEventWithBinding(scope, { title: '超限', typeId: 'et_1', refs }),
      (err: { code?: string; details?: { limit?: number } }) =>
        err.code === 'REF_LIMIT_EXCEEDED' && err.details?.limit === REF_LIMIT,
    );
    assert.equal(readAllEvents(scope).length, before, '预检失败不得留下事件');
  });

  it('关联文档部分失败不影响事件与参考文档', async () => {
    const ref = seedDoc('独立参考');
    const outcome = await createEventWithBinding(scope, {
      title: '部分失败',
      typeId: 'et_1',
      docs: [{ group: GROUP, name: '不存在的关联' }],
      refs: [{ group: GROUP, name: ref.text }],
    });

    assert.equal(outcome.binding.docs.bound.length, 0);
    assert.equal(outcome.binding.docs.failed.length, 1);
    assert.equal(outcome.binding.refs.added, 1);
    assert.ok(outcome.event.id, '事件照常创建（文档侧失败不回滚事件）');
  });

  it('by=ai 时 addedBy 记 ai', async () => {
    const ref = seedDoc('AI 参考');
    const outcome = await createEventWithBinding(scope, {
      title: 'AI 创建',
      typeId: 'et_1',
      refs: [{ group: GROUP, name: ref.text }],
      by: 'ai',
    });
    assert.equal(readRefs(scope, outcome.event.id)[0]?.addedBy, 'ai');
  });
});

describe('⑥ 关联文档超上限 → 前置拒绝（不留半成品）', () => {
  it(`docs 传 ${MEMBER_LIMIT + 1} 篇 → EVENT_MEMBER_LIMIT_EXCEEDED 且事件数不变`, async () => {
    const before = readAllEvents(scope).length;
    const docs = Array.from({ length: MEMBER_LIMIT + 1 }, (_, i) => ({ group: GROUP, name: `超额${i}` }));
    await assert.rejects(
      () => createEventWithBinding(scope, { title: '超限', typeId: 'et_1', docs }),
      (err: unknown) => {
        const e = err as { code?: string; details?: { limit?: number } };
        return e.code === 'EVENT_MEMBER_LIMIT_EXCEEDED' && e.details?.limit === MEMBER_LIMIT;
      },
    );
    assert.equal(readAllEvents(scope).length, before, '校验必须在 writeEvent 之前，事件不得落盘');
  });
});
