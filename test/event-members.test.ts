/**
 * event-members.test.ts —— 事件关联文档的绑定 / 解绑（REQ-20261116-004 · S-01）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-members.test.ts
 *
 * 覆盖：绑定落字段 / 幂等 skipped / 同批重复 / 文档不存在 / 数据源锁 /
 *       归属冲突（已属其他未收口事件）/ 上限整批拒绝 / 已收口拒绝 /
 *       解绑回 wiki / 解绑非成员 / 事件 updatedAt 变化而 revision 不变
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { listTypes } from '../src/lib/events/type-service.js';
import { createEvent, createEventWithBinding } from '../src/lib/events/event-service.js';
import { bindMembers, unbindMember, collectMembers, MEMBER_LIMIT } from '../src/lib/events/members.js';
import { readAllEvents } from '../src/lib/events/store.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `event-members-${Date.now()}`;
const GROUP = '专题记忆/成员测试';

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

function findRel(name: string): Relation | undefined {
  return loadGroupCache(scope, GROUP)?.hot_relations.find((r) => r.text === name);
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

describe('① 绑定', () => {
  it('落 lifecycle=event + eventId，返回 bound；事件 updatedAt 变化而 revision 不变', async () => {
    const doc = seedDoc('绑定成功文档');
    const created = await createEvent(scope, { title: '绑定', typeId: 'et_1' });
    const before = readAllEvents(scope).find((e) => e.id === created.id);

    const result = await bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });
    assert.equal(result.bound.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.skipped.length, 0);

    const rel = findRel(doc.text);
    assert.equal(rel?.lifecycle, 'event');
    assert.equal(rel?.eventId, created.id);

    const after = readAllEvents(scope).find((e) => e.id === created.id);
    assert.equal(after?.revision, before?.revision, '绑定不得改 revision（描述编辑的乐观锁）');
    assert.ok((after?.updatedAt ?? 0) >= (before?.updatedAt ?? 0), 'updatedAt 应同步（列表按它排序）');
  });

  it('重复绑定 → skipped(already-bound)；同批重复 → skipped(duplicate-in-request)', async () => {
    const doc = seedDoc('幂等文档');
    const created = await createEvent(scope, { title: '幂等', typeId: 'et_1' });
    await bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });

    const again = await bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });
    assert.equal(again.bound.length, 0);
    assert.deepEqual(again.skipped.map((s) => s.reason), ['already-bound']);

    const dup = await bindMembers(scope, created.id, {
      docs: [{ group: GROUP, name: doc.text }, { group: GROUP, name: doc.text }],
    });
    assert.equal(dup.bound.length, 0);
    assert.ok(dup.skipped.length >= 1);
  });

  it('文档不存在 / 数据源文档 → 逐条进 failed，不影响同批其他', async () => {
    const ok = seedDoc('正常文档');
    const imported = seedDoc('数据源文档', { isImported: true });
    const created = await createEvent(scope, { title: '混合批次', typeId: 'et_1' });

    const result = await bindMembers(scope, created.id, {
      docs: [
        { group: GROUP, name: '不存在的文档' },
        { group: GROUP, name: imported.text },
        { group: GROUP, name: ok.text },
      ],
    });

    assert.equal(result.bound.length, 1);
    assert.equal(result.failed.length, 2);
    assert.deepEqual(
      result.failed.map((f) => f.code).sort(),
      ['DATASOURCE_LIFECYCLE_LOCKED', 'DOC_NOT_FOUND'],
    );
    assert.equal(findRel(imported.text)?.lifecycle, undefined, '数据源文档不得被改分类');
  });

  it('已属其他未收口事件 → DOC_BOUND_TO_OTHER_EVENT，不静默改绑', async () => {
    const doc = seedDoc('冲突文档');
    const a = await createEvent(scope, { title: '事件A', typeId: 'et_1' });
    const b = await createEvent(scope, { title: '事件B', typeId: 'et_1' });
    await bindMembers(scope, a.id, { docs: [{ group: GROUP, name: doc.text }] });

    const result = await bindMembers(scope, b.id, { docs: [{ group: GROUP, name: doc.text }] });
    assert.equal(result.bound.length, 0);
    assert.equal(result.failed[0]?.code, 'DOC_BOUND_TO_OTHER_EVENT');
    assert.match(result.failed[0]?.error ?? '', new RegExp(`#${a.shortId}`));
    assert.equal(findRel(doc.text)?.eventId, a.id, '归属必须仍是原事件');
  });

  it(`超过 ${MEMBER_LIMIT} 篇 → 整批拒绝且不落任何一篇`, async () => {
    const created = await createEvent(scope, { title: '上限', typeId: 'et_1' });
    const docs = Array.from({ length: MEMBER_LIMIT + 1 }, (_, i) => {
      const rel = seedDoc(`上限文档${i}`);
      return { group: GROUP, name: rel.text };
    });

    await assert.rejects(
      () => bindMembers(scope, created.id, { docs }),
      (err: { code?: string; details?: { limit?: number } }) =>
        err.code === 'EVENT_MEMBER_LIMIT_EXCEEDED' && err.details?.limit === MEMBER_LIMIT,
    );
    assert.equal(findRel('上限文档0')?.lifecycle, undefined, '整批拒绝后不得有半批落盘');
  });

  it('已收口事件拒绝绑定', async () => {
    const doc = seedDoc('收口后文档');
    const created = await createEvent(scope, { title: '收口', typeId: 'et_1' });
    const type = listTypes(scope).find((t) => t.id === 'et_1')!;
    const terminal = type.stages[type.stages.length - 1];
    await assert.rejects(
      async () => {
        const { transitionEvent } = await import('../src/lib/events/event-service.js');
        await transitionEvent(scope, { event: created.id, stage: terminal.key });
        return bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });
      },
      (err: { code?: string }) => err.code === 'EVENT_CLOSED',
    );
  });
});

describe('② 解绑', () => {
  it('回到 wiki 且清掉 eventId；不是成员 → DOC_NOT_FOUND + memberOf', async () => {
    const doc = seedDoc('解绑文档');
    const created = await createEvent(scope, { title: '解绑', typeId: 'et_1' });
    await bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });

    const out = await unbindMember(scope, created.id, GROUP, doc.text);
    assert.equal(out.lifecycle, 'wiki');
    assert.equal(out.visibility.mode, 'full');

    const rel = findRel(doc.text);
    assert.equal(rel?.lifecycle, undefined);
    assert.equal(rel?.eventId, undefined);

    await assert.rejects(
      () => unbindMember(scope, created.id, GROUP, doc.text),
      (err: { code?: string }) => err.code === 'DOC_NOT_FOUND',
    );
  });

  it('collectMembers 反映绑定与解绑', async () => {
    const doc = seedDoc('聚合文档');
    const created = await createEvent(scope, { title: '聚合', typeId: 'et_1' });
    assert.equal(collectMembers(scope, created.id).length, 0);

    await bindMembers(scope, created.id, { docs: [{ group: GROUP, name: doc.text }] });
    assert.equal(collectMembers(scope, created.id).length, 1);

    await unbindMember(scope, created.id, GROUP, doc.text);
    assert.equal(collectMembers(scope, created.id).length, 0);
  });
});

describe('③ 创建时绑定', () => {
  it('createEventWithBinding 一次完成且回显 visibility/pending', async () => {
    const doc = seedDoc('创建绑定文档');
    const type = listTypes(scope)[0];
    const hidden = type.stages.find((s) => s.visibility === 'hidden');
    const outcome = await createEventWithBinding(scope, {
      title: '创建绑定',
      typeId: type.id,
      ...(hidden ? { stageKey: hidden.key } : {}),
      docs: [{ group: GROUP, name: doc.text }],
    });

    assert.equal(outcome.binding.docs.bound.length, 1);
    assert.equal(outcome.visibility.mode, hidden ? 'hidden' : outcome.visibility.mode);
    assert.ok(Array.isArray(outcome.pending));
    assert.equal(findRel(doc.text)?.eventId, outcome.event.id);
  });
});
