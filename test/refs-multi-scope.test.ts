/**
 * refs-multi-scope.test.ts —— 跨库检索范围与跨库引用（REQ-20261116-005 · S-02）
 *
 * 运行：npx jiti test/refs-multi-scope.test.ts
 *
 * 守四条口径：
 *   ① 多库检索：每个 target 都真的查了，候选能回指**源库**并带 `rankInScope`；
 *   ② 同名不同库：两篇都要保留（去重键必须含库，否则第二篇被静默跳过）；
 *   ③ 局部失败：某个库失败只进 `targetErrors`，其余结果仍有效；全部失败才 503；
 *   ④ 范围解析：无权限 / 不存在 / 视图无成员 → 进 `skipped`，不失败。
 *
 * 检索实现注入 fake，不联网。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { createEvent } from '../src/lib/events/event-service.js';
import { addRefs, listRefs, searchRefCandidates } from '../src/lib/events/refs-service.js';
import { resolveFindTargets } from '../src/lib/events/find-targets.js';
import type { Relation } from '../src/lib/scoring.js';

const stamp = Date.now();
const scopeA = `refs-multi-a-${stamp}`;
const scopeB = `refs-multi-b-${stamp}`;
const GROUP = '部署运维';

function seed(
  target: string,
  group: string,
  name: string,
  times: { createdAt?: number; updatedAt?: number } = {},
): Relation {
  const rel: Relation = {
    id: `rel_${group.length}_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
    ...(times.createdAt !== undefined ? { createdAt: times.createdAt } : {}),
    ...(times.updatedAt !== undefined ? { updatedAt: times.updatedAt } : {}),
  };
  const doc = loadGroupCache(target, group) ?? { version: 1, scope: target, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(target, group, doc);

  const kbDir = getLocalKbDir(target, group);
  fs.mkdirSync(kbDir, { recursive: true });
  const kbPath = path.join(kbDir, 'index.json');
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = `# ${name}`;
  writeJson(kbPath, kb);
}

before(() => {
  registerTestScope(scopeA);
  registerTestScope(scopeB);
  initScope(scopeA);
  initScope(scopeB);
});

after(() => {
  for (const s of [scopeA, scopeB]) {
    const dir = getKbDir(s);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('① 跨库候选', () => {
  it('两个库都查、候选带源库与库内排名，targets 如实回显', async () => {
    seed(scopeA, GROUP, 'A 库回滚手册');
    seed(scopeB, GROUP, 'B 库发布检查清单');
    const event = await createEvent(scopeA, { title: '发布回滚失败', typeId: 'et_1' });

    const asked: string[] = [];
    const result = await searchRefCandidates(
      scopeA,
      event.id,
      {
        search: async ({ scope }) => {
          asked.push(scope);
          const name = scope === scopeA ? 'A 库回滚手册' : 'B 库发布检查清单';
          return [{ group: GROUP, name, score: scope === scopeA ? 0.03 : 0.02 }];
        },
      },
      { targets: [scopeA, scopeB] },
    );

    assert.deepEqual(asked.sort(), [scopeA, scopeB].sort(), '每个 target 都要真的查一遍');
    assert.deepEqual(result.targets, [scopeA, scopeB]);
    assert.equal(result.candidates.length, 2, '两库各一篇都要出');
    const byScope = new Map(result.candidates.map((c) => [c.scope, c]));
    assert.ok(byScope.has(scopeA) && byScope.has(scopeB), '候选必须能回指源库');
    assert.equal(byScope.get(scopeB)!.rankInScope, 1, '库内排名按源库算');
    assert.equal(byScope.get(scopeA)!.origin, 'fast');
  });

  it('同名同 group 但不同库：两条都保留（去重键含库）', async () => {
    seed(scopeA, GROUP, '同名手册');
    seed(scopeB, GROUP, '同名手册');
    const event = await createEvent(scopeA, { title: '同名文档回滚', typeId: 'et_1' });

    const result = await searchRefCandidates(
      scopeA,
      event.id,
      {
        search: async ({ scope }) => [{ group: GROUP, name: '同名手册', score: scope === scopeA ? 0.03 : 0.02 }],
      },
      { targets: [scopeA, scopeB] },
    );
    assert.equal(result.candidates.length, 2, '不同库的同名文档不是重复');
  });

  it('某个库失败只记 targetErrors，其余照常返回', async () => {
    seed(scopeA, GROUP, 'A 库唯一手册');
    const event = await createEvent(scopeA, { title: '局部失败验证', typeId: 'et_1' });

    const result = await searchRefCandidates(
      scopeA,
      event.id,
      {
        search: async ({ scope }) => {
          if (scope === scopeB) throw new Error('embedding 超时');
          return [{ group: GROUP, name: 'A 库唯一手册', score: 0.03 }];
        },
      },
      { targets: [scopeA, scopeB] },
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(result.targetErrors?.length, 1);
    assert.equal(result.targetErrors?.[0]?.name, scopeB);
    assert.equal(result.reason, undefined, '有命中时不判 reason');
  });

  it('视图当检索范围：文档数按成员库求和，命中回指成员库', async () => {
    seed(scopeB, GROUP, '视图内 B 文档');
    const event = await createEvent(scopeA, { title: '视图范围回滚', typeId: 'et_1' });

    const result = await searchRefCandidates(
      scopeA,
      event.id,
      {
        // 生产链路里 executeSearch 自己展开视图；fake 只需模拟"视图返回成员库的命中"
        search: async ({ scope }) => (scope === '运维视图'
          ? [{ group: GROUP, name: '视图内 B 文档', score: 0.02, scope: scopeB }]
          : []),
        // 视图不是物理库：readAllGroupCaches(视图名) 恒为空，必须展开成成员库
        viewMembers: (name) => (name === '运维视图' ? [scopeA, scopeB] : null),
      },
      { targets: [scopeA, '运维视图'] },
    );

    const view = result.totalByScope?.find((x) => x.scope === '运维视图');
    assert.ok(view !== undefined, 'totalByScope 要覆盖视图 target');
    assert.ok(view.docs >= 2, `视图文档数应为成员库之和，实际 ${JSON.stringify(result.totalByScope)}`);
    assert.equal(result.candidates[0]?.scope, scopeB, '视图命中要回指成员库，不能写视图名');
    assert.notEqual(result.reason, 'empty-scope', '视图有内容时不得判成"事件与文档不在同一库"');
  });

  it('全部库失败才 503', async () => {
    const event = await createEvent(scopeA, { title: '全失败验证 query', typeId: 'et_1' });
    await assert.rejects(
      () => searchRefCandidates(
        scopeA,
        event.id,
        { search: async () => { throw new Error('down'); } },
        { targets: [scopeA, scopeB] },
      ),
      /向量检索不可用/,
    );
  });
});

describe('② 跨库引用', () => {
  it('同 group 同名的两库文档可同时加入，且 stale 可区分', async () => {
    seed(scopeA, GROUP, '双库手册');
    seed(scopeB, GROUP, '双库手册');
    const event = await createEvent(scopeA, { title: '跨库引用验证', typeId: 'et_1' });

    const r1 = addRefs(scopeA, event.id, {
      docs: [{ group: GROUP, name: '双库手册' }],
      addedBy: 'manual',
      tokenScopes: [scopeA, scopeB],
    });
    assert.equal(r1.added, 1);

    const r2 = addRefs(scopeA, event.id, {
      docs: [{ sourceScope: scopeB, group: GROUP, name: '双库手册' }],
      addedBy: 'manual',
      tokenScopes: [scopeA, scopeB],
    });
    assert.equal(r2.added, 1, '另一库的同名文档不是重复');
    assert.equal(r2.skipped.length, 0);

    const listed = listRefs(scopeA, event.id).refs;
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((r) => r.stale).length, 0, '两篇都存在，都不应 stale');
    assert.equal(listed.find((r) => r.sourceScope === scopeB)?.name, '双库手册');
  });

  it('无权访问的源库 → FIND_TARGET_NOT_AUTHORIZED', async () => {
    seed(scopeA, GROUP, '鉴权手册');
    const event = await createEvent(scopeA, { title: '越权引用验证', typeId: 'et_1' });
    assert.throws(
      () => addRefs(scopeA, event.id, {
        docs: [{ sourceScope: scopeB, group: GROUP, name: '鉴权手册' }],
        addedBy: 'manual',
        tokenScopes: [scopeA],   // 只授权了事件库
      }),
      /无权引用库/,
    );
  });

  it('源库不存在的文档 → REF_DOC_NOT_FOUND（不写脏引用）', async () => {
    const event = await createEvent(scopeA, { title: '不存在文档验证', typeId: 'et_1' });
    assert.throws(
      () => addRefs(scopeA, event.id, {
        docs: [{ group: GROUP, name: '从未存在过的手册' }],
        addedBy: 'manual',
        tokenScopes: [scopeA, scopeB],
      }),
      /不存在/,
    );
    assert.equal(listRefs(scopeA, event.id).refs.length, 0, '校验失败不得落盘');
  });

  it('列出引用时透出**文档自身**的时间；跨库取源库、失效后不带时间', async () => {
    const t0 = Date.UTC(2026, 10, 20, 8, 0);
    seed(scopeA, GROUP, '时间手册A', { createdAt: t0, updatedAt: t0 + 86_400_000 });
    seed(scopeB, GROUP, '时间手册B', { createdAt: t0 + 3_600_000, updatedAt: t0 + 7_200_000 });

    const event = await createEvent(scopeA, { title: '时间透出验证', typeId: 'et_1' });
    addRefs(scopeA, event.id, {
      docs: [
        { group: GROUP, name: '时间手册A' },
        { sourceScope: scopeB, group: GROUP, name: '时间手册B' },
      ],
      addedBy: 'manual',
      tokenScopes: [scopeA, scopeB],
    });

    const listed = listRefs(scopeA, event.id).refs;
    const a = listed.find((r) => r.name === '时间手册A')!;
    assert.equal(a.updatedAt, t0 + 86_400_000, '更新时间必须取自正文 relation');
    assert.equal(a.createdAt, t0);
    assert.notEqual(a.updatedAt, a.addedAt, '不得拿「加入事件的时间」冒充更新时间');

    const b = listed.find((r) => r.name === '时间手册B')!;
    assert.equal(b.updatedAt, t0 + 7_200_000, '跨库引用必须取**源库**文档的时间');

    // 文档被删 → stale 且没有 relation 可读 ⇒ 不透出时间键（留着过期时间会误导成「最近更新」）
    const cache = loadGroupCache(scopeB, GROUP)!;
    cache.hot_relations = cache.hot_relations.filter((r) => r.text !== '时间手册B');
    writeGroupCache(scopeB, GROUP, cache);

    const after = listRefs(scopeA, event.id).refs.find((r) => r.name === '时间手册B')!;
    assert.equal(after.stale, true);
    assert.equal('updatedAt' in after, false, '失效引用不得留下时间字段');
    assert.equal('createdAt' in after, false);
  });
});

describe('③ 范围解析', () => {
  it('无权限 / 不存在 / 视图无成员 都进 skipped，不失败', () => {
    const r = resolveFindTargets(scopeA, { ranges: { extraScopes: [scopeB, 'not-exist-scope', 'empty-view'] } }, {
      tokenScopes: [scopeA],   // 只授权事件库
      listScopes: () => [scopeA, scopeB],
      listViews: () => ({ 'empty-view': { members: [] } }),
    });
    assert.deepEqual(r.targets, [scopeA], '全部被剔除，只剩事件库');
    assert.equal(r.skipped.find((s) => s.name === scopeB)?.reason, 'forbidden');
    assert.equal(r.skipped.find((s) => s.name === 'not-exist-scope')?.reason, 'missing');
    assert.equal(r.skipped.find((s) => s.name === 'empty-view')?.reason, 'view-members-changed');
  });

  it('授权内的额外库会被纳入，且事件库恒在首位', () => {
    const r = resolveFindTargets(scopeA, { ranges: { extraScopes: [scopeB, scopeA] } }, {
      tokenScopes: [scopeA, scopeB],
      listScopes: () => [scopeA, scopeB],
      listViews: () => ({}),
    });
    assert.deepEqual(r.targets, [scopeA, scopeB], '去重且事件库在前');
    assert.equal(r.skipped.length, 0);
  });

  it('未配置 range 时只查事件库（与历史行为一致）', () => {
    const r = resolveFindTargets(scopeA, undefined, { tokenScopes: [scopeA, scopeB] });
    assert.deepEqual(r.targets, [scopeA]);
    assert.equal(r.skipped.length, 0);
  });
});
