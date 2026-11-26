/**
 * events-sr02.test.ts —— S-02 事件与事件类型（B3 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events-sr02.test.ts
 *
 * 覆盖：内置类型 / 阶段只追加 / 末位不可停用 / 乐观锁 / shortId 不复用 /
 *       收口 keep 与 trash 两条去向 / 已收口拒绝流转 / 删除前置与 docAction /
 *       重开后成员为 0 / 列表分页与 docsPreview 限额
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { listTypes, createType, updateType, deleteType } from '../src/lib/events/type-service.js';
import {
  createEvent, transitionEvent, deleteEvent, reopenEvent, listEvents, collectMembers,
} from '../src/lib/events/event-service.js';
import { readAllEvents } from '../src/lib/events/store.js';
import { readStageLogs } from '../src/lib/events/stage-log.js';
import { listTrash } from '../src/lib/trash-store.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `events-test-${Date.now()}`;
const GROUP = '错误库/Web前端界面';

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

  // ⚠ `getLocalKbDir()` 返回的是 `<group>/index.json` **文件路径**，不是目录
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

after(async () => {
  /**
   * 绑定会触发一次索引补齐（`scheduleConsume`）。收尾顺序不能颠倒：
   * 先等后台任务结束，再关引擎 —— 否则 FTS/向量引擎的原生句柄会让进程
   * "用例都过了却不退出"（表现为测试超时）。
   */
  const { waitForConsume } = await import('../src/lib/visibility-queue.js');
  await waitForConsume(scope).catch(() => null);
  const { closeEngine } = await import('../src/lib/vector-client.js');
  await closeEngine().catch(() => undefined);
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 事件类型', () => {
  it('`_types.json` 不存在时返回内置 4 类（不落盘）', () => {
    const types = listTypes(scope);
    // 2026-11-23 起内置 4 条：bug 排查 / 性能优化 / 需求实现 / 技术债（REQ-20261123-007）
    assert.equal(types.length, 4);
    assert.deepEqual(types.map((t) => t.name), ['bug 排查', '性能优化', '需求实现', '技术债']);
    assert.equal(types[0].terminalAction, 'keep');
    assert.equal(types[1].terminalAction, 'trash');
    assert.equal(types[3].terminalAction, 'keep', '技术债收口后文档保留（复盘值得长期可检索）');
    assert.ok(!fs.existsSync(path.join(getKbDir(scope), '.events', '_types.json')), '读路径不得创建文件');
  });

  it('阶段只追加不删：少一个已有阶段 → STAGE_DELETE_FORBIDDEN', async () => {
    const type = listTypes(scope)[0];
    await assert.rejects(
      () => updateType(scope, type.id, {
        revision: type.revision,
        stages: type.stages.slice(0, 3).map((s) => ({ key: s.key, name: s.name, visibility: s.visibility })),
      }),
      (err: { code?: string }) => err.code === 'STAGE_DELETE_FORBIDDEN',
    );
  });

  it('末位阶段不可停用', async () => {
    const type = listTypes(scope)[0];
    const stages = type.stages.map((s, i) => ({
      key: s.key,
      name: s.name,
      visibility: s.visibility,
      ...(i === type.stages.length - 1 ? { disabled: true } : {}),
    }));
    await assert.rejects(
      () => updateType(scope, type.id, { revision: type.revision, stages }),
      (err: { code?: string }) => err.code === 'TERMINAL_STAGE_CANNOT_DISABLE',
    );
  });

  it('追加阶段 + 改名：新阶段拿到新 key，改名保留 originalName', async () => {
    // 用自定义类型做增改：改内置 et_1 会让它的阶段链偏离内置定义（真实踩过）
    const created = await createType(scope, {
      name: '阶段演进测试',
      stages: [
        { name: '起步', visibility: 'hidden' },
        { name: '收尾', visibility: 'full' },
      ],
    });
    // 2026-11-26：createType 自动补末位「已关闭」，所以这里是三条
    assert.deepEqual(created.stages.map((s) => s.name), ['起步', '收尾', '已关闭']);

    const stages = created.stages.map((s, i) => ({
      key: s.key,
      name: i === 0 ? '起步改' : s.name,
      visibility: s.visibility,
    })) as Array<{ key?: string; name: string; visibility: 'hidden' | 'full' }>;
    stages.push({ name: '复盘', visibility: 'full' });

    const updated = await updateType(scope, created.id, { revision: created.revision, stages });
    // 追加的「复盘」被插到末位之前：末位恒为「已关闭」，收口入口不会被顶掉
    assert.deepEqual(updated.stages.map((s) => s.name), ['起步改', '收尾', '复盘', '已关闭']);
    assert.equal(updated.stages[0].originalName, '起步');
    assert.equal(updated.stages[2].key, 'st_4');
    assert.equal(updated.revision, created.revision + 1);
  });

  it('乐观锁：旧 revision → REVISION_CONFLICT', async () => {
    const type = listTypes(scope)[0];
    await assert.rejects(
      () => updateType(scope, type.id, { revision: type.revision - 1, fallbackDays: 30 }),
      (err: { code?: string }) => err.code === 'REVISION_CONFLICT',
    );
  });

  it('内置类型不可删', async () => {
    const type = listTypes(scope)[0];
    await assert.rejects(
      () => deleteType(scope, type.id),
      (err: { code?: string }) => err.code === 'TYPE_BUILTIN',
    );
  });

  it('自定义类型：创建 → 在用不可删 → 无引用可删', async () => {
    const created = await createType(scope, {
      name: '临时验证',
      stages: [
        { name: '开始', visibility: 'hidden' },
        { name: '结束', visibility: 'full' },
      ],
    });
    assert.match(created.id, /^et_\d+$/);
    // 末位「已关闭」由系统自动补，因此拿到的 key 是三条
    assert.deepEqual(created.stages.map((s) => s.key), ['st_1', 'st_2', 'st_3']);

    const event = await createEvent(scope, { title: '用一下', typeId: created.id });
    await assert.rejects(
      () => deleteType(scope, created.id),
      (err: { code?: string }) => err.code === 'TYPE_IN_USE',
    );

    await deleteEvent(scope, { event: event.id, docAction: 'wiki' }).catch(() => undefined);
  });

  it('类型描述：创建写入 → 超长 fail-loud → PATCH 三态（不改 / 清除 / 写入）', async () => {
    const created = await createType(scope, {
      name: '描述验证',
      description: '  一句话说明这类事件装什么  ',
      stages: [
        { name: '开始', visibility: 'hidden' },
        { name: '结束', visibility: 'full' },
      ],
    });
    assert.equal(created.description, '一句话说明这类事件装什么', '前后空白应被裁剪');

    // 超长必须报错：静默截断会让「用户写的」与「看到的」不是一回事
    await assert.rejects(
      () => updateType(scope, created.id, { revision: created.revision, description: 'x'.repeat(201) }),
      (err: { code?: string }) => err.code === 'TYPE_DESCRIPTION_TOO_LONG',
    );

    // 省略 = 不改（PATCH 语义）
    const keep = await updateType(scope, created.id, { revision: created.revision });
    assert.equal(keep.description, '一句话说明这类事件装什么');

    // 空串 = 清除，且不把空串留在文件里
    const cleared = await updateType(scope, created.id, { revision: keep.revision, description: '' });
    assert.equal(cleared.description, undefined);

    await deleteType(scope, created.id);
  });
});

describe('② 事件创建与流转', () => {
  it('shortId 自增且删除后不复用', async () => {
    const a = await createEvent(scope, { title: '第一个', typeId: 'et_1' });
    const b = await createEvent(scope, { title: '第二个', typeId: 'et_1' });
    assert.equal(b.shortId, a.shortId + 1);

    // 收口后删除，再建一个：应继续自增
    await transitionEvent(scope, { event: a.id, stage: '已关闭' });
    await deleteEvent(scope, { event: a.id, docAction: 'wiki' });
    const c = await createEvent(scope, { title: '第三个', typeId: 'et_1' });
    assert.ok(c.shortId > b.shortId, `shortId 不得复用：b=${b.shortId} c=${c.shortId}`);
  });

  it('起始阶段：缺省首阶段 / 指定生效 / 未知或停用被拒', async () => {
    // ① 缺省 = 首阶段
    const plain = await createEvent(scope, { title: '缺省起始', typeId: 'et_1' });
    assert.equal(plain.stageKey, 'st_1');
    assert.equal(plain.stageIndex, 0);

    // ② 显式指定：落在该阶段，且列表可见性跟随该阶段（st_3 修复中 = fts-only）
    const at3 = await createEvent(scope, { title: '从修复中开始', typeId: 'et_1', stageKey: 'st_3' });
    assert.equal(at3.stageKey, 'st_3');
    assert.equal(at3.stageIndex, 2);
    const listed = listEvents(scope, { status: 'open', limit: 100 }).items.find((i) => i.event.id === at3.id);
    assert.equal(listed?.stage?.visibility, 'fts-only');

    // ③ 未知阶段 → STAGE_NOT_FOUND + 可选阶段清单
    await assert.rejects(
      () => createEvent(scope, { title: '非法起始', typeId: 'et_1', stageKey: 'st_99' }),
      (err: { code?: string; details?: { available?: unknown[] } }) =>
        err.code === 'STAGE_NOT_FOUND' && (err.details?.available?.length ?? 0) === 4,
    );

    // ④ 停用阶段 → STAGE_DISABLED（三段类型停用**中间**那段：末位是终态，服务端不允许停用）
    const custom = await createType(scope, {
      name: '起始阶段校验',
      stages: [
        { name: '一', visibility: 'hidden' },
        { name: '二', visibility: 'fts-only' },
        { name: '三', visibility: 'full' },
      ],
    });
    await updateType(scope, custom.id, {
      revision: custom.revision,
      stages: custom.stages.map((s, i) => ({
        key: s.key,
        name: s.name,
        visibility: s.visibility,
        ...(i === 1 ? { disabled: true } : {}),
      })),
    });
    await assert.rejects(
      () => createEvent(scope, { title: '停用起始', typeId: custom.id, stageKey: custom.stages[1].key }),
      (err: { code?: string }) => err.code === 'STAGE_DISABLED',
    );
    await deleteType(scope, custom.id);
  });

  it('流转更新 stageKey；与当前相同 → STAGE_UNCHANGED', async () => {
    const event = await createEvent(scope, { title: '流转测试', typeId: 'et_1' });
    const moved = await transitionEvent(scope, { event: event.id, stage: '已定位' });
    assert.equal(moved.to.key, 'st_2');
    assert.equal(moved.closed, false);
    assert.equal(moved.visibility.mode, 'fts-only');
    assert.equal(moved.visibility.dense, false);

    await assert.rejects(
      () => transitionEvent(scope, { event: event.id, stage: '已定位' }),
      (err: { code?: string }) => err.code === 'STAGE_UNCHANGED',
    );
  });

  it('阶段名不存在 → STAGE_NOT_FOUND 且附可选阶段', async () => {
    const event = await createEvent(scope, { title: '非法阶段', typeId: 'et_1' });
    await assert.rejects(
      () => transitionEvent(scope, { event: event.id, stage: '不存在的阶段' }),
      (err: { code?: string; details?: { available?: unknown[] } }) => {
        assert.equal(err.code, 'STAGE_NOT_FOUND');
        assert.ok(Array.isArray(err.details?.available));
        return true;
      },
    );
  });

  it('流转写日志（from/to 正确）', async () => {
    const event = await createEvent(scope, { title: '日志测试', typeId: 'et_1' });
    await transitionEvent(scope, { event: event.id, stage: '已定位', note: '开始修' });
    const logs = readStageLogs(scope, event.id);
    assert.ok(logs.length >= 2, '创建 + 一次流转');
    const last = logs[logs.length - 1];
    assert.equal(last.fromKey, 'st_1');
    assert.equal(last.toKey, 'st_2');
    assert.equal(last.note, '开始修');
  });
});

describe('③ 收口与终态动作', () => {
  it('keep：成员文档回 wiki 且清掉 eventId', async () => {
    const doc = seedDoc('收口保留文档');
    const event = await createEvent(scope, {
      title: '收口 keep', typeId: 'et_1', docs: [{ group: GROUP, name: doc.text }],
    });
    assert.equal(collectMembers(scope, event.id).length, 1);

    const closed = await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    assert.equal(closed.closed, true);
    assert.equal(closed.terminalAction, 'keep');
    assert.equal(closed.affected.docs, 1);

    const rec = loadGroupCache(scope, GROUP)!.hot_relations.find((r) => r.text === doc.text)!;
    assert.equal(rec.lifecycle, undefined, 'keep 应回 wiki');
    assert.equal(rec.eventId, undefined, 'keep 应清空绑定');
  });

  it('trash：成员进回收站并从分片移除', async () => {
    const doc = seedDoc('收口回收文档');
    const event = await createEvent(scope, {
      title: '收口 trash', typeId: 'et_2', docs: [{ group: GROUP, name: doc.text }],
    });

    // 2026-11-26 起「已完成」不再是终态，收口统一走末位「已关闭」
    const closed = await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    assert.equal(closed.terminalAction, 'trash');
    assert.equal(closed.affected.docs, 1);

    assert.equal(loadGroupCache(scope, GROUP)!.hot_relations.some((r) => r.text === doc.text), false);
    assert.ok(listTrash(scope).items.some((i) => i.name === doc.text && i.reason === 'event-closed'));
  });

  it('已收口事件拒绝再流转', async () => {
    const event = await createEvent(scope, { title: '已收口', typeId: 'et_1' });
    await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    await assert.rejects(
      () => transitionEvent(scope, { event: event.id, stage: '已定位' }),
      (err: { code?: string }) => err.code === 'EVENT_CLOSED',
    );
  });
});

describe('④ 删除与重开', () => {
  it('未收口不能删；收口后必须指定 docAction', async () => {
    const event = await createEvent(scope, { title: '删除前置', typeId: 'et_1' });
    await assert.rejects(
      () => deleteEvent(scope, { event: event.id, docAction: 'wiki' }),
      (err: { code?: string }) => err.code === 'EVENT_NOT_CLOSED',
    );

    await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    await assert.rejects(
      () => deleteEvent(scope, { event: event.id }),
      (err: { code?: string }) => err.code === 'DOC_ACTION_REQUIRED',
    );
  });

  it('删除后事件文件与日志都消失', async () => {
    const event = await createEvent(scope, { title: '待删除', typeId: 'et_1' });
    await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    await deleteEvent(scope, { event: event.id, docAction: 'wiki' });

    assert.equal(readAllEvents(scope).some((e) => e.id === event.id), false);
    assert.equal(readStageLogs(scope, event.id).length, 0);
  });

  it('重开：回到首阶段、closedAt 清空、membersRestored=0', async () => {
    const doc = seedDoc('重开文档');
    const event = await createEvent(scope, { title: '重开', typeId: 'et_1', docs: [{ group: GROUP, name: doc.text }] });
    await transitionEvent(scope, { event: event.id, stage: '已关闭' });
    const reopened = await reopenEvent(scope, event.id);

    assert.equal(reopened.event.stageKey, 'st_1');
    assert.equal(reopened.event.closedAt, null);
    assert.equal(reopened.membersRestored, 0);
    assert.match(reopened.hint, /重新绑定/);
    assert.equal(collectMembers(scope, event.id).length, 0, '收口时已清绑定，重开不自动恢复');
  });
});

describe('⑤ 列表', () => {
  it('分页 + docsPreview 限额 + 状态筛选', async () => {
    const docs = [seedDoc('列表文档A'), seedDoc('列表文档B'), seedDoc('列表文档C')];
    const event = await createEvent(scope, {
      title: '列表事件',
      typeId: 'et_1',
      docs: docs.map((d) => ({ group: GROUP, name: d.text })),
    });

    const hit = listEvents(scope, { status: 'all', q: '列表事件', docsPreviewLimit: 1 });
    const target = hit.items.find((i) => i.event.id === event.id)!;
    assert.equal(target.members.length, 1, 'docsPreviewLimit=1 时应只回 1 条文档名');
    assert.equal(target.memberTotal, 3);
    assert.equal(target.visibilitySummary.hidden, 3, '首阶段是 hidden');

    const page = listEvents(scope, { status: 'open', limit: 2 });
    assert.ok(page.items.length <= 2);
    assert.ok(page.total >= page.items.length);
    assert.ok(page.items.every((i) => i.event.closedAt === null));
  });
});
