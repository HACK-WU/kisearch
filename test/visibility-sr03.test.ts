/**
 * visibility-sr03.test.ts —— S-03 三档可见性（B4 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/visibility-sr03.test.ts
 *
 * 覆盖：
 *   ① 3×3 矩阵（planTransition）—— 尤其 hidden→full 必须补回 ki-relation；
 *   ② resolveVisibility 的四类输入（wiki / 正常事件 / 事件缺失 / 阶段悬空）；
 *   ③ applyVisibility 的 skipped 分支（无 ids / 跨组共享保护）与 pending 入队；
 *   ④ consumePending 状态机（注入 writer，不联网）：成功移除 / 失败累计 / 三次转 blocked。
 *
 * 不覆盖：`ki-path` 的组级摘除（要起向量引擎，留 B6 的集成测试）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import {
  planTransition, resolveVisibility, applyVisibility,
  pendingFilePath, type PendingFile,
} from '../src/lib/visibility-index.js';
import { consumePending, pendingCount, listPending } from '../src/lib/visibility-queue.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `vis-test-${Date.now()}`;
const GROUP_A = '错误库/Web前端界面';
const GROUP_B = '错误库/后端服务';

function seed(group: string, name: string, extra: Partial<Relation> = {}): void {
  const rel: Relation = {
    id: `rel_${group.length}_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
    ...extra,
  };
  const doc = loadGroupCache(scope, group) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, group, doc);

  const kbDir = getLocalKbDir(scope, group);
  fs.mkdirSync(kbDir, { recursive: true });
  const kbPath = path.join(kbDir, 'index.json');
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = `# ${name}`;
  writeJson(kbPath, kb);
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

describe('① 3×3 转换矩阵', () => {
  it('full → fts-only：只摘 dense', () => {
    assert.deepEqual(planTransition('full', 'fts-only'), { remove: ['dense'], write: [] });
  });

  it('full → hidden：摘 dense + FTS + ki-relation（漏一类就被兜底召回）', () => {
    assert.deepEqual(planTransition('full', 'hidden'), { remove: ['dense', 'fts', 'relation'], write: [] });
  });

  it('fts-only → hidden：摘 FTS + ki-relation（本就没有 dense）', () => {
    assert.deepEqual(planTransition('fts-only', 'hidden'), { remove: ['fts', 'relation'], write: [] });
  });

  it('hidden → full：必须**补回 ki-relation**（漏它则往返后关系向量永久缺失）', () => {
    assert.deepEqual(planTransition('hidden', 'full'), { remove: [], write: ['dense', 'fts', 'relation'] });
  });

  it('hidden → fts-only：写 FTS + ki-relation', () => {
    assert.deepEqual(planTransition('hidden', 'fts-only'), { remove: [], write: ['fts', 'relation'] });
  });

  it('fts-only → full：只补 dense', () => {
    assert.deepEqual(planTransition('fts-only', 'full'), { remove: [], write: ['dense'] });
  });

  it('同档位：无动作', () => {
    for (const v of ['full', 'fts-only', 'hidden'] as const) {
      assert.deepEqual(planTransition(v, v), { remove: [], write: [] });
    }
  });
});

describe('② resolveVisibility', () => {
  it('wiki 文档 → full（不查事件）', () => {
    const r = resolveVisibility({ relation: { lifecycle: 'wiki' } });
    assert.equal(r.mode, 'full');
    assert.equal(r.source, 'lifecycle');
  });

  it('未设置分类 → full', () => {
    assert.equal(resolveVisibility({ relation: {} }).mode, 'full');
  });

  it('事件文档 → 按当前阶段档位，缺失时降级并给 warning', () => {
    const events = new Map([['evt_1', { stageKey: 'st_2', typeId: 'et_1' }]]);
    const types = new Map([['et_1', { stages: [{ key: 'st_1', visibility: 'hidden' as const }, { key: 'st_2', visibility: 'fts-only' as const }] }]]);
    const ok = resolveVisibility({
      relation: { lifecycle: 'event', eventId: 'evt_1' },
      lookupEvent: (id) => events.get(id) ?? null,
      lookupType: (id) => types.get(id) ?? null,
    });
    assert.equal(ok.mode, 'fts-only');
    assert.equal(ok.source, 'event-stage');

    const missingEvent = resolveVisibility({
      relation: { lifecycle: 'event', eventId: 'evt_gone' },
      lookupEvent: () => null,
      lookupType: () => null,
    });
    assert.equal(missingEvent.mode, 'full');
    assert.equal(missingEvent.source, 'fallback');
    assert.match(missingEvent.warning ?? '', /不存在/);

    const orphanStage = resolveVisibility({
      relation: { lifecycle: 'event', eventId: 'evt_1' },
      lookupEvent: (id) => events.get(id) ?? null,
      lookupType: () => ({ stages: [{ key: 'st_9', visibility: 'hidden' as const }] }),
    });
    assert.equal(orphanStage.mode, 'full');
    assert.match(orphanStage.warning ?? '', /悬空/);
  });

  it('event 但无 eventId → 降级 full 并提示', () => {
    const r = resolveVisibility({ relation: { lifecycle: 'event' } });
    assert.equal(r.mode, 'full');
    assert.match(r.warning ?? '', /没有 eventId/);
  });
});

describe('③ applyVisibility', () => {
  it('摘除无索引 ID → skipped，不误报 failed', async () => {
    seed(GROUP_A, '无索引文档');
    const result = await applyVisibility({ scope, group: GROUP_A, relation: '无索引文档', to: 'hidden', from: 'full' });
    assert.equal(result.failed.length, 0);
    assert.ok(result.skipped.some((s) => s.kind === 'dense' && s.reason === 'no-dense-ids'));
    assert.ok(result.skipped.some((s) => s.kind === 'fts' && s.reason === 'no-fts-ids'));
  });

  it('同名文档仍活在别的组 → ki-relation 走跨组共享保护（skipped）', async () => {
    seed(GROUP_A, '共享同名');
    seed(GROUP_B, '共享同名');
    const result = await applyVisibility({ scope, group: GROUP_A, relation: '共享同名', to: 'hidden', from: 'fts-only' });
    assert.ok(result.skipped.some((s) => s.kind === 'relation' && s.reason === 'other-holders'));
    assert.equal(result.removed.includes('relation'), false);
  });

  it('写入方向只入队，不在本函数里 embed', async () => {
    seed(GROUP_A, '待重建文档');
    const result = await applyVisibility({ scope, group: GROUP_A, relation: '待重建文档', to: 'full', from: 'hidden' });
    assert.deepEqual(result.pending, ['dense', 'fts', 'relation']);
    assert.deepEqual(result.written, [], '写入必须异步，函数内不落索引');

    const file = readJson<PendingFile>(pendingFilePath(scope))!;
    const entry = file.items.find((i) => i.relation === '待重建文档')!;
    assert.equal(entry.target, 'full');
    assert.deepEqual(entry.kinds, ['dense', 'fts', 'relation']);
    assert.equal(entry.attempts, 0);
  });

  it('同一文档重复入队：覆盖而不是堆叠', async () => {
    seed(GROUP_A, '重复入队');
    await applyVisibility({ scope, group: GROUP_A, relation: '重复入队', to: 'full', from: 'hidden' });
    await applyVisibility({ scope, group: GROUP_A, relation: '重复入队', to: 'full', from: 'hidden' });
    const items = listPending(scope).filter((i) => i.relation === '重复入队');
    assert.equal(items.length, 1);
  });
});

describe('④ consumePending 状态机', () => {
  const okDeps = {
    readContent: () => '# 内容',
    writeDense: async () => ({ ok: true }),
    writeFts: async () => ({ ok: true, ids: ['fts_1'] }),
    // relation/path 默认会走真实向量引擎；这里注入，保证队列状态机在离线环境可验
    writeRelation: async () => ({ ok: true }),
    writePath: async () => ({ ok: true }),
  };

  it('全部成功 → 出队', async () => {
    seed(GROUP_A, '队列成功');
    await applyVisibility({ scope, group: GROUP_A, relation: '队列成功', to: 'full', from: 'hidden' });
    const before = pendingCount(scope);

    const result = await consumePending(scope, okDeps);
    assert.ok(result.consumed.some((c) => c.relation === '队列成功'));
    assert.equal(result.remaining, before - result.consumed.length);
    assert.equal(pendingCount(scope), result.remaining);
  });

  it('失败一次 → attempts+1 且保留', async () => {
    seed(GROUP_A, '队列失败一次');
    await applyVisibility({ scope, group: GROUP_A, relation: '队列失败一次', to: 'full', from: 'hidden' });

    const result = await consumePending(scope, {
      ...okDeps,
      writeDense: async () => ({ ok: false, reason: 'engine down' }),
    });
    const failed = result.failed.find((f) => f.relation === '队列失败一次')!;
    assert.equal(failed.attempts, 1);

    const kept = listPending(scope).find((i) => i.relation === '队列失败一次')!;
    assert.equal(kept.attempts, 1);
    assert.match(kept.lastError ?? '', /engine down/);
  });

  it('第三次失败 → 转 blocked 并写诊断文件，不再自动重试', async () => {
    seed(GROUP_A, '队列三次失败');
    await applyVisibility({ scope, group: GROUP_A, relation: '队列三次失败', to: 'full', from: 'hidden' });

    const failing = {
      ...okDeps,
      writeDense: async () => ({ ok: false, reason: 'always down' }),
    };
    await consumePending(scope, failing);
    await consumePending(scope, failing);
    const third = await consumePending(scope, failing);

    assert.ok(third.blocked.some((b) => b.relation === '队列三次失败'));
    assert.equal(listPending(scope).some((i) => i.relation === '队列三次失败'), false, 'blocked 不再留在 pending');

    const failures = readJson<{ items: Array<{ relation: string }> }>(path.join(getKbDir(scope), '.visibility-failures.json'))!;
    assert.ok(failures.items.some((i) => i.relation === '队列三次失败'));
  });

  it('原文已不存在 → 丢弃该条（不占队列）', async () => {
    seed(GROUP_A, '原文丢失');
    await applyVisibility({ scope, group: GROUP_A, relation: '原文丢失', to: 'full', from: 'hidden' });

    const result = await consumePending(scope, { ...okDeps, readContent: () => null });
    assert.equal(result.remaining, listPending(scope).length);
    assert.equal(listPending(scope).some((i) => i.relation === '原文丢失'), false);
  });
});
