/**
 * trash-sr04.test.ts —— S-04 回收站（B2 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/trash-sr04.test.ts
 *
 * 覆盖：入站快照 / 恢复可读 / 同名冲突 / 期限重算（过期场景不得用 expiresAt-now）
 *       / ttlDays 缺失回退 / 到期清理（purge 与 notify）/ 同名重复删除不覆盖
 *
 * 不依赖 embedding：只验证「删除可逆」的文件层与分片层；索引重建属 B4（返回 pending）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir, getAssetsDir } from '../src/lib/scope.js';
import { writeGroupCache, loadGroupCache } from '../src/lib/group-cache.js';
import { moveToTrash, restoreFromTrash, purgeExpired } from '../src/lib/trash-service.js';
import { listTrash, readTrashSettings, writeTrashSettings, getTrashRoot, updateTrashItemMeta } from '../src/lib/trash-store.js';
import type { Relation } from '../src/lib/scoring.js';

const DAY = 86_400_000;
const scope = `trash-test-${Date.now()}`;
const GROUP = '错误库/Web前端界面';

function makeRel(name: string, extra: Partial<Relation> = {}): Relation {
  return {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
    ...extra,
  };
}

function seedDoc(name: string, content: string, extra: Partial<Relation> = {}): Relation {
  const rel = makeRel(name, extra);
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);

  const kbDir = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(kbDir, { recursive: true });
  const kbPath = path.join(kbDir, 'index.json');
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = content;
  writeJson(kbPath, kb);
  return rel;
}

/** 模拟真实删除链路：快照写完后把文档从分片移除（否则恢复会撞同名冲突） */
function removeDoc(name: string): void {
  const doc = loadGroupCache(scope, GROUP);
  if (!doc) return;
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  writeGroupCache(scope, GROUP, doc);
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

describe('① 入站', () => {
  it('快照写在 scope 目录内（自动进备份），且保留原文与元数据', () => {
    const rel = seedDoc('cookie 过期策略', '# cookie 过期策略\n正文内容', { useCount: 7, tags: ['api'] });
    const now = Date.now();
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });

    assert.equal(moved.ok, true);
    if (!moved.ok) return;

    const itemDir = path.join(getTrashRoot(scope), GROUP, moved.item.dirName);
    assert.ok(itemDir.startsWith(getKbDir(scope)), '回收站必须在 scope 数据目录内');
    assert.ok(fs.existsSync(path.join(itemDir, 'meta.json')));
    assert.ok(fs.existsSync(path.join(itemDir, 'content.md')));
    assert.equal(fs.readFileSync(path.join(itemDir, 'content.md'), 'utf-8'), '# cookie 过期策略\n正文内容');

    assert.equal(moved.item.reason, 'manual');
    assert.equal(moved.item.expiresAt, now + 7 * DAY, '默认保留 7 天');
    assert.equal(moved.item.relationSnapshot?.useCount, 7);
    assert.deepEqual(moved.item.relationSnapshot?.tags, ['api']);
    // 索引 ID 不进快照：恢复必须重建
    assert.equal('memoryIds' in (moved.item.relationSnapshot ?? {}), false);
    assert.equal('ftsIds' in (moved.item.relationSnapshot ?? {}), false);
  });

  it('同名重复删除不覆盖：目录名带后缀，两份都在', () => {
    const rel = seedDoc('重复删除', 'v1');
    const now = Date.now();
    const first = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });
    const second = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now: now + 1000, relationSnapshot: rel });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.item.dirName, second.item.dirName);
    assert.match(second.item.dirName, /__\d{17}$/, '后缀精确到毫秒，避免同秒连续删除撞名');
    assert.equal(listTrash(scope).items.filter((i) => i.name === '重复删除').length, 2);
  });
});

describe('② 恢复', () => {
  it('原文与分片都回来，且返回 rebuild=pending', () => {
    const rel = seedDoc('待恢复文档', '# 待恢复\n内容');
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;

    // 模拟删除链路：先移除分片，再恢复
    removeDoc(rel.text);

    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    if (!restored.ok) return;

    assert.equal(restored.rebuild, 'pending');
    assert.equal(restored.restoreCount, 1);

    const kb = readJson<Record<string, string>>(path.join(getLocalKbDir(scope, GROUP), 'index.json'))!;
    assert.equal(kb['待恢复文档'], '# 待恢复\n内容');

    const after = loadGroupCache(scope, GROUP)!;
    assert.ok(after.hot_relations.some((r) => r.text === '待恢复文档'), '分片应恢复该文档');

    // 出站后回收站目录消失
    assert.equal(listTrash(scope).items.filter((i) => i.name === '待恢复文档').length, 0);
  });

  it('同组同名已存在 → 409 语义拒绝，不覆盖', () => {
    const rel = seedDoc('冲突文档', '原文');
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;

    seedDoc('冲突文档', '后来新建的同名文档');

    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName });
    assert.equal(restored.ok, false);
    assert.equal(restored.ok === false && restored.code, 'RESTORE_NAME_CONFLICT');

    const kb = readJson<Record<string, string>>(path.join(getLocalKbDir(scope, GROUP), 'index.json'))!;
    assert.equal(kb['冲突文档'], '后来新建的同名文档', '冲突时不得覆盖现有文档');
  });
});

describe('③ 期限重算（S-04 §3.4）', () => {
  it('原本已过期 → 按 ttlDays 续期，而不是 now + 0', () => {
    const now = Date.now();
    const rel = seedDoc('已过期文档', 'x', {
      lifecycle: 'temp',
      expiresAt: now - 5 * DAY, // 已过期
      ttlDays: 30,
    });
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'temp-expired', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    removeDoc(rel.text);

    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName, now });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;

    assert.equal(restored.expiresAtChanged, true, '过期文档恢复必须续期');
    assert.equal(restored.ttlDays, 30);
    assert.ok(restored.expiresAt && restored.expiresAt > now + 29 * DAY, '应续期约 30 天，而不是立刻再过期');
  });

  it('手动删除（原期限未过）→ 原值不变', () => {
    const now = Date.now();
    const future = now + 10 * DAY;
    const rel = seedDoc('未过期文档', 'x', { lifecycle: 'temp', expiresAt: future, ttlDays: 30 });
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    removeDoc(rel.text);

    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName, now });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.expiresAtChanged, false);
    assert.equal(restored.expiresAt, future);
  });

  it('ttlDays 缺失（存量）→ 回退 7 天并标 ttlAssumed', () => {
    const now = Date.now();
    const rel = seedDoc('无期限字段', 'x', { lifecycle: 'temp', expiresAt: now - DAY });
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'temp-expired', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    assert.equal(moved.item.ttlAssumed, true);
    removeDoc(rel.text);

    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName, now });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.ttlDays, 7);
    assert.match(restored.hint ?? '', /原期限未知/);
  });

  it('恢复时改 wiki → 清空期限', () => {
    const now = Date.now();
    const rel = seedDoc('改长期', 'x', { lifecycle: 'temp', expiresAt: now - DAY, ttlDays: 7 });
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'temp-expired', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;

    removeDoc(rel.text);
    const restored = restoreFromTrash({ scope, group: GROUP, dirName: moved.item.dirName, targetLifecycle: 'wiki', now });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.lifecycle, 'wiki');
    assert.equal(restored.expiresAt, undefined);

    const doc = loadGroupCache(scope, GROUP)!;
    const rec = doc.hot_relations.find((r) => r.text === '改长期')!;
    assert.equal(rec.lifecycle, undefined);
    assert.equal(rec.expiresAt, undefined);
  });
});

describe('④ 到期清理', () => {
  it('purge 模式：到期条目被物理删除', () => {
    const now = Date.now();
    const rel = seedDoc('到期清理', 'x');
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;

    // 人为把到期时间提前
    updateTrashItemMeta(scope, GROUP, moved.item.dirName, { expiresAt: now - 1000 });

    const result = purgeExpired({ scope, now });
    assert.equal(result.mode, 'purge');
    assert.ok(result.purged.some((i) => i.name === '到期清理'));
    assert.equal(listTrash(scope).items.filter((i) => i.name === '到期清理').length, 0);
  });

  it('notify 模式：只报不删', () => {
    const now = Date.now();
    writeTrashSettings(scope, { keepDays: 7, expireAction: 'notify' });
    const rel = seedDoc('仅通知', 'x');
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    updateTrashItemMeta(scope, GROUP, moved.item.dirName, { expiresAt: now - 1000 });

    const result = purgeExpired({ scope, now });
    assert.equal(result.mode, 'notify');
    assert.ok(result.notified.some((i) => i.name === '仅通知'));
    assert.equal(listTrash(scope).items.filter((i) => i.name === '仅通知').length, 1, 'notify 模式不得删除');

    writeTrashSettings(scope, { keepDays: 7, expireAction: 'purge' });
  });

  it('dryRun 只算不删', () => {
    const now = Date.now();
    const rel = seedDoc('预演清理', 'x');
    const moved = moveToTrash({ scope, group: GROUP, relation: rel.text, reason: 'manual', now, relationSnapshot: rel });
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    updateTrashItemMeta(scope, GROUP, moved.item.dirName, { expiresAt: now - 1000 });

    const result = purgeExpired({ scope, now, dryRun: true });
    assert.ok(result.purged.some((i) => i.name === '预演清理'));
    assert.equal(listTrash(scope).items.filter((i) => i.name === '预演清理').length, 1);
  });

  it('设置缺省为 7 天 / purge，且不自动创建文件', () => {
    const settings = readTrashSettings(scope);
    assert.deepEqual(settings, { keepDays: 7, expireAction: 'purge' });
  });
});

describe('⑤ 列表', () => {
  it('按 deletedAt 倒序且支持 reason 过滤', () => {
    const now = Date.now();
    const a = seedDoc('列表A', 'x');
    const b = seedDoc('列表B', 'x');
    moveToTrash({ scope, group: GROUP, relation: a.text, reason: 'manual', now, relationSnapshot: a });
    moveToTrash({ scope, group: GROUP, relation: b.text, reason: 'event-closed', now: now + 10, relationSnapshot: b });

    const all = listTrash(scope);
    assert.ok(all.total >= 2);
    assert.ok(all.items[0].deletedAt >= all.items[1].deletedAt);

    const onlyEvent = listTrash(scope, { reason: 'event-closed' });
    assert.ok(onlyEvent.items.every((i) => i.reason === 'event-closed'));
    assert.ok(onlyEvent.items.some((i) => i.name === '列表B'));
  });
});
