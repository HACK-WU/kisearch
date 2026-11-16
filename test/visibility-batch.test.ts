/**
 * visibility-batch.test.ts —— 档位矩阵与批量切换（REQ-20261116-004 · S-01）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/visibility-batch.test.ts
 *
 * 重点覆盖 `ki-path` 重建：`hidden → full` 必须把 path 放进 pending，
 * 否则解绑 / 流转 / 恢复之后组路径向量永久缺失（页面无感、检索静默失效）。
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
import { createEvent } from '../src/lib/events/event-service.js';
import {
  planTransition, applyVisibilityBatch, resolveVisibilityBatch, pendingFilePath,
  type PendingFile,
} from '../src/lib/visibility-index.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `visibility-batch-${Date.now()}`;
const GROUP = '专题记忆/档位测试';

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

describe('① planTransition 矩阵', () => {
  it('hidden → full 必须补 path（既有缺陷：只写 dense/fts/relation）', () => {
    const plan = planTransition('hidden', 'full');
    assert.ok(plan.write.includes('path'), '缺 path 会导致组路径向量永久缺失');
    assert.ok(plan.write.includes('dense'));
    assert.equal(plan.remove.length, 0);
  });

  it('fts-only → full 不需要 path（path 只在 hidden 时被摘）', () => {
    const plan = planTransition('fts-only', 'full');
    assert.deepEqual(plan.write, ['dense']);
  });

  it('full → hidden 摘 dense/fts/relation，不写', () => {
    const plan = planTransition('full', 'hidden');
    assert.deepEqual(plan.remove.sort(), ['dense', 'fts', 'relation']);
    assert.equal(plan.write.length, 0);
  });

  it('档位相同 → 无动作', () => {
    assert.deepEqual(planTransition('hidden', 'hidden'), { remove: [], write: [] });
  });
});

describe('② 批量解析与切换', () => {
  it('resolveVisibilityBatch 一次算出各文档档位', async () => {
    const type = listTypes(scope)[0];
    const hidden = type.stages.find((s) => s.visibility === 'hidden')!;
    const event = await createEvent(scope, { title: '批量档位', typeId: type.id, stageKey: hidden.key });

    const a = seedDoc('档位文档A', { lifecycle: 'event', eventId: event.id });
    const b = seedDoc('档位文档B');

    const map = resolveVisibilityBatch(scope, [
      { group: GROUP, relation: a.text },
      { group: GROUP, relation: b.text },
    ]);
    assert.equal(map.get(`${GROUP}\u0000${a.text}`), 'hidden');
    assert.equal(map.get(`${GROUP}\u0000${b.text}`), 'full');
  });

  it('applyVisibilityBatch(hidden → full) 把 path 写入 pending', async () => {
    const type = listTypes(scope)[0];
    const hidden = type.stages.find((s) => s.visibility === 'hidden')!;
    const event = await createEvent(scope, { title: 'path 重建', typeId: type.id, stageKey: hidden.key });
    const doc = seedDoc('path重建文档', { lifecycle: 'event', eventId: event.id });

    // 先清掉可能残留的 pending，保证断言只反映本次操作
    const pendingFile = pendingFilePath(scope);
    if (fs.existsSync(pendingFile)) fs.rmSync(pendingFile);

    const result = await applyVisibilityBatch(
      scope,
      [{ group: GROUP, relation: doc.text, from: 'hidden' }],
      'full',
    );

    assert.equal(result.applied, 1);
    assert.ok(result.pending.includes('path'), `pending 缺 path：${JSON.stringify(result.pending)}`);

    const file = readJson<PendingFile>(pendingFile);
    const entry = file?.items.find((i) => i.relation === doc.text && i.group === GROUP);
    assert.ok(entry, 'pending 文件里应有该文档');
    assert.ok(entry?.kinds.includes('path'), 'pending 条目应含 path');
    assert.equal(entry?.target, 'full');
  });

  it('空数组是幂等空操作', async () => {
    const result = await applyVisibilityBatch(scope, [], 'full');
    assert.deepEqual(result, { applied: 0, pending: [], failed: [] });
  });
});
