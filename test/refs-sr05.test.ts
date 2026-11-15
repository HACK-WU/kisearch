/**
 * refs-sr05.test.ts —— S-05 参考文档与 AI 候选（B5 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/refs-sr05.test.ts
 *
 * 覆盖：
 *   ① **A13 红线**：加入/移除前后被引文档的分片文件字节不变；
 *   ② 候选排除（已关联 + 已加入）、归一化与 weak 标记、steps 数字与真实召回一致；
 *   ③ 悬空引用标 stale（不静默清理）；
 *   ④ 重复加入 skipped / 已关联文档拒绝 / 移除不存在报错 / 50 条上限。
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
import { loadGroupCache, writeGroupCache, getGroupCachePath } from '../src/lib/group-cache.js';
import { createEvent, transitionEvent } from '../src/lib/events/event-service.js';
import {
  addRefs, removeRef, listRefs, searchRefCandidates, extractKeywords, searchDocsForAdd,
} from '../src/lib/events/refs-service.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `refs-test-${Date.now()}`;
const GROUP_MAIN = '错误库/Web前端界面';
const GROUP_OTHER = '项目架构/配置';

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

/** fake 检索：按名字包含关系给分，量纲故意用 RRF 那样的小数（0.02 级） */
function fakeSearch(pool: Array<{ group: string; name: string }>) {
  // 池子即"召回结果"：这里不模拟关键词过滤，只保证量纲与顺序可控
  return async () => pool.map((d, i) => ({
    group: d.group,
    name: d.name,
    // 递减的小量纲分数，验证 min-max 归一化把它拉到 0~1
    score: 0.03 - i * 0.004,
  }));
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

describe('① A13：引用操作不碰被引文档', () => {
  it('加入 + 移除之后，分片文件字节不变', () => {
    seed(GROUP_OTHER, 'cookie 作用域配置说明');
    seed(GROUP_MAIN, '关联文档甲');
    const shardPath = getGroupCachePath(scope, GROUP_OTHER);

    return createEvent(scope, {
      title: '引用红线验证',
      typeId: 'et_1',
      docs: [{ group: GROUP_MAIN, name: '关联文档甲' }],
    }).then((event) => {
      // 基线必须在 createEvent 之后取：绑定关联文档本身会写目标分片
      const before = fs.readFileSync(shardPath);
      const beforeMain = fs.readFileSync(getGroupCachePath(scope, GROUP_MAIN));

      addRefs(scope, event.id, {
        docs: [{ group: GROUP_OTHER, name: 'cookie 作用域配置说明', score: 0.88 }],
        addedBy: 'manual',
      });

      assert.deepEqual(fs.readFileSync(shardPath), before, '被引文档所在分片必须字节不变');
      assert.deepEqual(fs.readFileSync(getGroupCachePath(scope, GROUP_MAIN)), beforeMain, '关联文档所在分片也不得变化');

      removeRef(scope, event.id, GROUP_OTHER, 'cookie 作用域配置说明');
      assert.deepEqual(fs.readFileSync(shardPath), before, '移除同样不得改动被引文档');
    });
  });
});

describe('② 候选检索', () => {
  it('排除已关联与已加入，分数归一化到 0~1，weak 标记正确', async () => {
    seed(GROUP_MAIN, '关联文档乙');
    seed(GROUP_OTHER, 'cookie 登录态排查 SOP');
    seed(GROUP_OTHER, 'cookie 域不匹配案例');
    seed('项目架构', '用户表设计');

    const event = await createEvent(scope, {
      title: '登录页 cookie 白屏',
      typeId: 'et_1',
      docs: [{ group: GROUP_MAIN, name: '关联文档乙' }],
    });
    addRefs(scope, event.id, { docs: [{ group: GROUP_OTHER, name: 'cookie 登录态排查 SOP' }], addedBy: 'ai' });

    const result = await searchRefCandidates(scope, event.id, {
      search: fakeSearch([
        { group: GROUP_MAIN, name: '关联文档乙' },
        { group: GROUP_OTHER, name: 'cookie 登录态排查 SOP' },
        { group: GROUP_OTHER, name: 'cookie 域不匹配案例' },
        { group: '项目架构', name: '用户表设计' },
      ]),
    });

    const names = result.candidates.map((c) => c.name);
    assert.equal(names.includes('关联文档乙'), false, '已关联必须排除');
    assert.equal(names.includes('cookie 登录态排查 SOP'), false, '已加入必须排除');
    assert.ok(names.includes('cookie 域不匹配案例'));

    for (const c of result.candidates) {
      assert.ok(c.score >= 0 && c.score <= 1, `归一化分数越界：${c.score}`);
    }
    assert.equal(result.candidates[0].score, 1, '最高分归一化为 1');
    assert.equal(result.candidates.find((c) => c.name === '用户表设计')?.weak, true, '低分应标 weak');

    const searchStep = result.steps.find((s) => s.name === 'search')!;
    assert.equal(searchStep.metrics.hits, 4, 'hits 必须是检索真实返回条数（含稍后被排除的）');
    assert.ok(result.steps.every((s) => typeof s.ms === 'number' && s.ms >= 0));
  });

  it('steps 五步齐全且顺序固定', async () => {
    const event = await createEvent(scope, { title: '链路顺序', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, { search: async () => [] });
    assert.deepEqual(result.steps.map((s) => s.name), ['understand', 'extract', 'search', 'exclude', 'rank']);
    assert.equal(result.total >= 0, true);
  });

  it('标题无线索词 → 跳过检索但流程完整', async () => {
    const event = await createEvent(scope, { title: '的 了', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, { search: async () => { throw new Error('不应被调用'); } });
    const extract = result.steps.find((s) => s.name === 'extract')!;
    assert.equal(extract.metrics.keywords, 0);
    assert.equal(result.candidates.length, 0);
  });

  it('extractKeywords 去停用词且去重', () => {
    const kws = extractKeywords('登录页白屏 问题 的 排查', ['登录页白屏', 'cookie 域']);
    assert.ok(!kws.includes('问题'));
    assert.ok(!kws.includes('的'));
    assert.equal(new Set(kws).size, kws.length);
  });
});

describe('③ 悬空引用', () => {
  it('被引文档被删除后标 stale，且不自动清理', async () => {
    seed(GROUP_OTHER, '将被删除的文档');
    const event = await createEvent(scope, { title: '悬空引用', typeId: 'et_1' });
    addRefs(scope, event.id, { docs: [{ group: GROUP_OTHER, name: '将被删除的文档' }], addedBy: 'manual' });

    // 删掉文档（只改分片，模拟删除链路）
    const doc = loadGroupCache(scope, GROUP_OTHER)!;
    doc.hot_relations = doc.hot_relations.filter((r) => r.text !== '将被删除的文档');
    writeGroupCache(scope, GROUP_OTHER, doc);

    const listed = listRefs(scope, event.id);
    assert.equal(listed.refs.length, 1, 'stale 条目必须保留在列表里');
    assert.equal(listed.refs[0].stale, true);
  });
});

describe('④ 校验与边界', () => {
  it('重复加入 → skipped（不报错）', async () => {
    seed(GROUP_OTHER, '重复引用文档');
    const event = await createEvent(scope, { title: '重复加入', typeId: 'et_1' });
    addRefs(scope, event.id, { docs: [{ group: GROUP_OTHER, name: '重复引用文档' }], addedBy: 'manual' });
    const second = addRefs(scope, event.id, { docs: [{ group: GROUP_OTHER, name: '重复引用文档' }], addedBy: 'manual' });
    assert.equal(second.added, 0);
    assert.equal(second.skipped.length, 1);
  });

  it('把已关联文档加为参考 → REF_ALREADY_ASSOCIATED', async () => {
    seed(GROUP_MAIN, '已关联文档丙');
    const event = await createEvent(scope, {
      title: '已关联', typeId: 'et_1', docs: [{ group: GROUP_MAIN, name: '已关联文档丙' }],
    });
    assert.throws(
      () => addRefs(scope, event.id, { docs: [{ group: GROUP_MAIN, name: '已关联文档丙' }], addedBy: 'ai' }),
      (err: { code?: string }) => err.code === 'REF_ALREADY_ASSOCIATED',
    );
  });

  it('移除不存在的引用 → REF_NOT_FOUND', async () => {
    const event = await createEvent(scope, { title: '移除不存在', typeId: 'et_1' });
    assert.throws(
      () => removeRef(scope, event.id, GROUP_OTHER, '不存在的文档'),
      (err: { code?: string }) => err.code === 'REF_NOT_FOUND',
    );
  });

  it('超过 50 条上限 → 拒绝', async () => {
    const event = await createEvent(scope, { title: '上限', typeId: 'et_1' });
    const docs = Array.from({ length: 51 }, (_, i) => ({ group: GROUP_OTHER, name: `批量文档${i}` }));
    assert.throws(() => addRefs(scope, event.id, { docs, addedBy: 'manual' }));
  });
});

describe('⑤ 手动添加的文档搜索', () => {
  it('按名包含匹配并给出可见性', async () => {
    seed(GROUP_OTHER, '手动搜索目标文档');
    await createEvent(scope, { title: '占位', typeId: 'et_1' });
    const hits = searchDocsForAdd(scope, '手动搜索');
    assert.ok(hits.some((h) => h.name === '手动搜索目标文档'));
    assert.equal(hits[0].visibility, 'full');
  });
});
