/**
 * datasource-sync-preserve.test.ts —— 数据源同步不得改变既有文档的分类与事件绑定
 *
 * 需求：REQ-20261116-006 v3（`CodeWikiHub/kisearch/requirements/2026-11-16-数据源同步不得改变既有文档的分类与事件绑`）
 *
 * 覆盖需求文档 §9 的验收场景（标号与文档一致）：
 *   S1  temp 保留（lifecycle / expiresAt / ttlDays 不变）
 *   S2  event 保留（eventId 不丢）
 *   S4  新增文档默认 wiki
 *   S5  正文与索引照旧更新
 *   S6  isImported 照旧刷 true，且重复同步不会回退（N1）
 *   S8  findExpiredTemp 豁免 isImported（R7）
 *   S9  事件终态 trash 对数据源成员改 wiki，不进回收站（R8）
 *   S10 裸同步不清 tag，显式传（含空串）才覆盖（R9）
 *   S11 分类字段不自洽 → 降级 wiki（N4）
 *
 * 运行：npx jiti test/datasource-sync-preserve.test.ts
 *
 * ★ 全部 `vector: false`（FTS-only），免 embedding、离线可跑。
 *   也因此不会触发 `isContentUnchanged` 短路 —— 每次同步都真的走一次覆盖写，
 *   正是本需求要盯的那条路径。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { handleDirectImport } from '../src/lib/import.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { getKbDir } from '../src/lib/scope.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { resetConfigCache } from '../src/lib/config.js';
import { findExpiredTemp } from '../src/lib/lifecycle.js';
import { readKbRelationContent } from '../src/lib/trash-service.js';
import { closeFtsEngine, ftsSearch } from '../src/lib/fts-client.js';
import { allocateShortId, newEventId, writeEvent, writeTypesDoc } from '../src/lib/events/store.js';
import { deleteEvent, transitionEvent } from '../src/lib/events/event-service.js';
import type { EventRecord } from '../src/lib/events/types.js';
import type { Relation } from '../src/lib/scoring.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-preserve-'));
// 数据目录与上传暂存都跟着 HOME 走，避免污染真实 ~/.ki
process.env.HOME = tmpRoot;

const scope = `ds-preserve-${Date.now()}`;
registerTestScope(scope);
resetConfigCache();
ensureScopeDir(scope);

const GROUP = 'wiki';
const DAY = 86_400_000;
const sourceDir = fs.mkdtempSync(path.join(tmpRoot, 'src-'));

function writeSource(name: string, body: string): void {
  fs.writeFileSync(path.join(sourceDir, name), body, 'utf8');
}

/** 走真实导入入口（数据源同步与 `ki import --source` 共用的同一内核） */
async function sync(opts: { tags?: string } = {}): Promise<void> {
  const res = await handleDirectImport({
    scope,
    sourceDir,
    group: GROUP,
    vector: false,
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
  });
  assert.equal(res.ok, true, `导入应成功：${JSON.stringify(res)}`);
}

function relOf(name: string): Relation | undefined {
  const doc = loadGroupCache(scope, GROUP);
  return doc?.hot_relations.find((rel) => rel.text === name);
}

/**
 * 模拟「用户此前给这篇文档设过分类 / 标签」：直接改分片再落盘。
 * 身份先置 `isImported: false` —— 这正是真实场景：文档先作为普通文档存在并被人设了分类，
 * 之后源侧出现同名文件被同步接管（数据源文档本身绑不进事件，见需求 §2.8）。
 */
function patchRelation(name: string, mutate: (rel: Relation) => void): void {
  const doc = loadGroupCache(scope, GROUP);
  assert.ok(doc, 'group 分片应已存在');
  const rel = doc.hot_relations.find((item) => item.text === name);
  assert.ok(rel, `分片里应存在文档 ${name}`);
  rel.isImported = false;
  mutate(rel);
  writeGroupCache(scope, GROUP, doc);
}

after(async () => {
  // `ftsSearch` 会把引擎打开并留在进程里 —— 不关掉，node:test 跑完后进程不退（会挂到超时）
  try { await closeFtsEngine(scope); } catch { /* best effort */ }
  try { fs.rmSync(getKbDir(scope), { recursive: true, force: true }); } catch { /* best effort */ }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('A. 数据源同步覆盖：分类 / 事件 / 标签全部保留', () => {
  before(async () => {
    writeSource('a.md', '# A\n第一版\n');
    await sync();
  });

  it('S4/R3：新增文档默认 wiki（不写 lifecycle 字段）', () => {
    const rel = relOf('a');
    assert.ok(rel, '首次同步应建出文档 a');
    assert.equal(rel.lifecycle, undefined, '新增文档不得带 lifecycle');
    assert.equal(rel.expiresAt, undefined);
    assert.equal(rel.eventId, undefined);
  });

  it('S6/R5：数据源同步后 isImported=true（身份维度照旧）', () => {
    assert.equal(relOf('a')?.isImported, true);
  });

  it('S1/R1：temp 三字段在覆盖后原样保留，正文照旧更新', async () => {
    const expiresAt = Date.now() + 30 * DAY;
    patchRelation('a', (rel) => {
      rel.lifecycle = 'temp';
      rel.expiresAt = expiresAt;
      rel.ttlDays = 30;
    });

    writeSource('a.md', '# A\n第二版（源文件改过一个字）\n');
    await sync();

    const rel = relOf('a');
    assert.equal(rel?.lifecycle, 'temp', '覆盖不得抹掉 temp');
    assert.equal(rel?.expiresAt, expiresAt, 'expiresAt 必须原样保留（不是重算）');
    assert.equal(rel?.ttlDays, 30);
    assert.equal(rel?.isImported, true, '保留分类不等于放弃数据源身份');
    assert.match(readKbRelationContent(scope, GROUP, 'a'), /第二版/, 'S5：正文必须照旧更新');
  });

  it('N1：再同步一次仍保留（不会来回跳）', async () => {
    await sync();
    assert.equal(relOf('a')?.lifecycle, 'temp');
    assert.equal(relOf('a')?.isImported, true);
  });

  it('S2/R2：eventId 在覆盖后保留', async () => {
    patchRelation('a', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = 'evt_preserve_test';
      delete rel.expiresAt;
      delete rel.ttlDays;
    });

    await sync();

    const rel = relOf('a');
    assert.equal(rel?.lifecycle, 'event', '覆盖不得把事件成员退回 wiki');
    assert.equal(rel?.eventId, 'evt_preserve_test', '事件归属必须保留');
  });

  it('S11/N4：temp 缺 expiresAt → 降级 wiki（不保留坏分类）', async () => {
    patchRelation('a', (rel) => {
      rel.lifecycle = 'temp';
      delete rel.expiresAt;
      delete rel.eventId;
      rel.ttlDays = 30;
    });

    await sync();

    const rel = relOf('a');
    assert.equal(rel?.lifecycle, undefined, '不自洽的 temp 必须降级 wiki');
    assert.equal(rel?.ttlDays, undefined, '降级时配套字段一并清掉');
  });

  it('S11/N4：event 缺 eventId → 降级 wiki', async () => {
    patchRelation('a', (rel) => {
      rel.lifecycle = 'event';
      delete rel.eventId;
    });

    await sync();

    assert.equal(relOf('a')?.lifecycle, undefined, '缺 eventId 的 event 必须降级 wiki');
  });

  it('S10/R9：裸同步不清 tag，显式传（含空串）才覆盖', async () => {
    patchRelation('a', (rel) => {
      rel.tags = ['ops', 'k8s'];
    });

    await sync();
    assert.deepEqual(relOf('a')?.tags, ['ops', 'k8s'], '未指定 --tags 时不得清空用户 tag');

    await sync({ tags: '' });
    assert.equal(relOf('a')?.tags, undefined, '显式传空串 = 清空 tag');

    await sync({ tags: 'ops' });
    assert.deepEqual(relOf('a')?.tags, ['ops'], '显式传 tag = 覆盖');
  });

  it('R3：同批新增的另一个文件仍是 wiki', async () => {
    writeSource('b.md', '# B\n新文件\n');
    await sync();

    const rel = relOf('b');
    assert.ok(rel, '新文件应被导入');
    assert.equal(rel?.lifecycle, undefined);
    assert.equal(rel?.isImported, true);
  });
});

describe('B. S8/R7：findExpiredTemp 豁免数据源文档', () => {
  const now = 1_700_000_000_000;

  it('普通文档过期 temp 仍被挑出；数据源文档被豁免', () => {
    const rows = [
      { text: 'imported-expired', lifecycle: 'temp', expiresAt: now - 1, isImported: true },
      { text: 'normal-expired', lifecycle: 'temp', expiresAt: now - 1, isImported: false },
      // 旧数据可能没有 isImported 字段：与 false 同义，必须照旧挑出
      { text: 'legacy-expired', lifecycle: 'temp', expiresAt: now - 1 },
      { text: 'future', lifecycle: 'temp', expiresAt: now + 1, isImported: false },
      { text: 'wiki', lifecycle: 'wiki', expiresAt: now - 1, isImported: false },
    ];
    assert.deepEqual(
      findExpiredTemp(rows, now).map((row) => row.text),
      ['normal-expired', 'legacy-expired'],
    );
  });
});

describe('C. S9/R8：事件终态 trash 不搬数据源文档', () => {
  const typeId = 'et_preserve_trash';
  let eventId = '';

  before(() => {
    writeTypesDoc(scope, {
      version: 1,
      revision: 1,
      types: [{
        id: typeId,
        name: '终态进回收站的类型',
        builtin: false,
        stages: [
          { key: 'st_1', name: '实施中', visibility: 'full' },
          { key: 'st_2', name: '已收口', visibility: 'full' },
        ],
        terminalAction: 'trash',
        fallbackDays: 90,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    } as never);

    const event: EventRecord = {
      scope,
      typeId,
      stageKey: 'st_2',
      stageIndex: 1,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      id: newEventId(),
      shortId: allocateShortId(scope),
      title: '终态动作测试事件',
      // deleteEvent 的唯一收口判据（isEventClosed 只看 closedAt）
      closedAt: Date.now(),
    };
    writeEvent(scope, event);
    eventId = event.id;

    patchRelation('a', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = event.id;
      rel.isImported = true; // 数据源成员
    });
    patchRelation('b', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = event.id;
    });
  });

  it('数据源成员改回 wiki 且留在原 group；普通成员进回收站', async () => {
    const outcome = await deleteEvent(scope, { event: eventId, docAction: 'trash' });
    assert.equal(outcome.affected.failed, 0, `不应有失败：${JSON.stringify(outcome.affected)}`);

    const imported = relOf('a');
    assert.ok(imported, '数据源成员不得因事件终态被从库里摘掉');
    assert.equal(imported?.lifecycle, undefined, '分类应清空 = 回到 wiki');
    assert.equal(imported?.eventId, undefined, '事件绑定应解除');
    assert.equal(imported?.isImported, true, '身份不变');

    assert.equal(relOf('b'), undefined, '普通成员按 docAction=trash 进回收站');
  });

  it('阶段流转到终态（applyTerminalAction）同样不搬数据源成员', async () => {
    // 上一个用例把 b 搬走了，这里另建一篇普通成员
    writeSource('c.md', '# C\n终态流转用\n');
    await sync();

    const openEvent: EventRecord = {
      scope,
      typeId,
      stageKey: 'st_1',
      stageIndex: 0,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      id: newEventId(),
      shortId: allocateShortId(scope),
      title: '未收口事件（流转到终态）',
      closedAt: null,
    };
    writeEvent(scope, openEvent);

    patchRelation('a', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = openEvent.id;
      rel.isImported = true;
    });
    patchRelation('c', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = openEvent.id;
    });

    const outcome = await transitionEvent(scope, { event: openEvent.id, stage: 'st_2' });
    assert.equal(outcome.closed, true, '末位阶段应触发收口');
    assert.equal(outcome.terminalAction, 'trash');

    const imported = relOf('a');
    assert.ok(imported, '数据源成员不得被终态动作搬走');
    assert.equal(imported?.lifecycle, undefined);
    assert.equal(imported?.eventId, undefined);
    assert.equal(imported?.isImported, true);

    assert.equal(relOf('c'), undefined, '普通成员按类型终态动作进回收站');
  });
});

describe('D. S3/R2b：hidden 阶段成员在同步后仍不可检索', () => {
  const hiddenTypeId = 'et_preserve_hidden';
  const MARK = 'ZQXHIDDENMARK';

  it('保留 eventId 后，同步不会把 hidden 成员的索引重新写回来', async () => {
    writeTypesDoc(scope, {
      version: 1,
      revision: 2,
      types: [{
        id: hiddenTypeId,
        name: '含隐藏阶段的类型',
        builtin: false,
        stages: [
          { key: 'st_h', name: '排查中（隐藏）', visibility: 'hidden' },
          { key: 'st_f', name: '已公开', visibility: 'full' },
        ],
        terminalAction: 'keep',
        fallbackDays: 90,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    } as never);

    writeSource('d.md', `# D\n${MARK} 用于检索断言\n`);
    await sync();
    // 基线：还没绑事件时它是可检索的（否则下面的 0 命中说明不了问题）
    assert.ok((await ftsSearch({ scope, query: MARK, limit: 10 })).length > 0, '基线应可检索');

    const event: EventRecord = {
      scope,
      typeId: hiddenTypeId,
      stageKey: 'st_h',
      stageIndex: 0,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      id: newEventId(),
      shortId: allocateShortId(scope),
      title: '隐藏阶段事件',
      closedAt: null,
    };
    writeEvent(scope, event);
    patchRelation('d', (rel) => {
      rel.lifecycle = 'event';
      rel.eventId = event.id;
    });

    // 这一轮导入会先写 dense/FTS，再由「阶段可见性」把它们摘掉
    await sync();

    assert.equal(relOf('d')?.eventId, event.id, '事件绑定应保留');
    assert.equal(
      (await ftsSearch({ scope, query: MARK, limit: 10 })).length,
      0,
      'hidden 阶段成员同步后必须仍然搜不到（import.ts 阶段可见性判据）',
    );
  });
});
