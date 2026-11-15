/**
 * refs-sr05-search.test.ts —— 「AI 查找」候选质量与 0 候选原因（B8-1/B8-2）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/refs-sr05-search.test.ts
 *
 * 与 `refs-sr05.test.ts` 的分工：那边守 A13 红线与引用 CRUD；这里守**候选生成**的口径：
 *   ① chunk 级命中必须先按文档聚合（否则同篇多片段会重复占位、并压高归一化分布）；
 *   ② 候选带文档**自身**可见性（不是事件阶段档位）；
 *   ③ 0 候选的四种原因要能区分（前端据此写不同空态文案）；
 *   ④ 手动搜索传 eventId 时排除已关联 / 已加入（R31 的服务端兜底）。
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
import { addRefs, searchRefCandidates, searchDocsForAdd } from '../src/lib/events/refs-service.js';
import { createSearchAdapter } from '../src/lib/events/refs-search.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `refs-search-${Date.now()}`;
const GROUP_A = '错误库/Web前端界面';
const GROUP_B = '项目架构/配置';

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

/** chunk 级 fake：同文档给多条（模拟多 chunk 命中），分数递减 */
function chunkHits(pool: Array<{ group: string; name: string; chunks: number; score: number }>) {
  return async () => pool.flatMap((d) => Array.from({ length: d.chunks }, (_, i) => ({
    group: d.group,
    name: d.name,
    // 同文档第 2 个 chunk 分更低：聚合应取最高分而不是相加
    score: d.score - i * 0.002,
  })));
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

describe('① chunk → 文档聚合', () => {
  it('同一文档 3 个 chunk → 1 条候选，chunkHits=3，分数取最高', async () => {
    seed(GROUP_A, 'cookie 作用域配置说明');
    seed(GROUP_B, '用户表设计');

    const event = await createEvent(scope, { title: '登录页 cookie 白屏', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, {
      search: chunkHits([
        { group: GROUP_A, name: 'cookie 作用域配置说明', chunks: 3, score: 0.03 },
        { group: GROUP_B, name: '用户表设计', chunks: 1, score: 0.01 },
      ]),
    });

    const cookie = result.candidates.find((c) => c.name === 'cookie 作用域配置说明');
    assert.ok(cookie, '聚合后仍应出现');
    assert.equal(cookie.chunkHits, 3);
    assert.equal(result.candidates.filter((c) => c.name === 'cookie 作用域配置说明').length, 1, '不得重复占位');

    const searchStep = result.steps.find((s) => s.name === 'search')!;
    assert.equal(searchStep.metrics.hits, 4, 'hits 是 chunk 级召回数');
    assert.equal(searchStep.metrics.docs, 2, 'docs 是聚合后的文档数');
  });

  it('缺 group / name 的命中被丢弃（辅助通道无法定位文档）', async () => {
    const event = await createEvent(scope, { title: 'cookie 定位', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, {
      search: async () => [
        { group: '', name: '', score: 0.5 },
        { group: GROUP_A, name: '', score: 0.4 },
      ],
    });
    assert.equal(result.candidates.length, 0);
  });
});

describe('② 候选契约字段', () => {
  it('带文档自身可见性与 query', async () => {
    seed(GROUP_A, 'cookie 登录态排查 SOP');
    const event = await createEvent(scope, { title: '登录页 cookie 白屏', typeId: 'et_1' });

    const result = await searchRefCandidates(scope, event.id, {
      search: async () => [{ group: GROUP_A, name: 'cookie 登录态排查 SOP', score: 0.02 }],
    });

    assert.ok(result.query.includes('cookie'), `query 应是实际检索词，实际：${result.query}`);
    const c = result.candidates[0];
    assert.equal(c.visibility, 'full', '可见性取文档自身档位');
    assert.equal(c.chunkHits, 1);
    assert.equal(result.reason, undefined, '有候选时不给 reason');
  });

  it('检索步带真实调用行与真实 mode；降级必须如实透出', async () => {
    seed(GROUP_A, 'cookie 降级验证');
    const event = await createEvent(scope, { title: '登录页 cookie 白屏', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, {
      search: async () => ({
        hits: [{ group: GROUP_A, name: 'cookie 降级验证', score: 0.02 }],
        mode: 'fulltext',
        degraded: true,
        degradedReason: '查询 embedding 超时',
      }),
    });
    const step = result.steps.find((s) => s.name === 'search')!;
    assert.equal(step.metrics.mode, 'fulltext', 'metrics.mode 必须是真实模式，不能写死 hybrid');
    assert.equal(step.calls?.length, 1);
    assert.equal(step.calls?.[0].name, 'ki_search', '调用行只标真实工具');
    assert.equal(step.calls?.[0].kind, 'tool');
    assert.equal(result.mode, 'fulltext');
    assert.equal(result.degraded, true);
  });

  it('无线索词时不产生调用行（没调就不能标）', async () => {
    const event = await createEvent(scope, { title: '的 了', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, { search: async () => [] });
    const step = result.steps.find((s) => s.name === 'search')!;
    assert.equal(step.calls, undefined);
    assert.equal(step.metrics.hits, 0);
  });
});

describe('③ 0 候选原因可区分', () => {
  it('提不出线索词 → no-keywords，且不调用检索', async () => {
    const event = await createEvent(scope, { title: '的 了', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, {
      search: async () => { throw new Error('不应被调用'); },
    });
    assert.equal(result.reason, 'no-keywords');
    assert.equal(result.candidates.length, 0);
  });

  it('库内无文档 → empty-scope', async () => {
    const other = `refs-search-empty-${Date.now()}`;
    registerTestScope(other);
    initScope(other);
    const event = await createEvent(other, { title: '登录页白屏 cookie', typeId: 'et_1' });
    const result = await searchRefCandidates(other, event.id, { search: async () => [] });
    assert.equal(result.reason, 'empty-scope');
    assert.equal(result.total, 0);
    fs.rmSync(getKbDir(other), { recursive: true, force: true });
  });

  it('检索无命中 → no-hits', async () => {
    const event = await createEvent(scope, { title: '登录页 cookie 白屏', typeId: 'et_1' });
    const result = await searchRefCandidates(scope, event.id, { search: async () => [] });
    assert.equal(result.reason, 'no-hits');
    assert.ok(result.total > 0);
  });

  it('命中的都被排除 → all-excluded', async () => {
    seed(GROUP_A, '关联文档丁');
    const event = await createEvent(scope, {
      title: '关联文档丁 cookie', typeId: 'et_1', docs: [{ group: GROUP_A, name: '关联文档丁' }],
    });
    const result = await searchRefCandidates(scope, event.id, {
      search: async () => [{ group: GROUP_A, name: '关联文档丁', score: 0.02 }],
    });
    assert.equal(result.reason, 'all-excluded');
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.excluded.associated, ['关联文档丁']);
  });
});

describe('④ 手动搜索的事件级排除（R31）', () => {
  it('传 eventId 时排除已关联与已加入', async () => {
    seed(GROUP_A, '手动搜索目标甲');
    seed(GROUP_A, '手动搜索目标乙');
    seed(GROUP_B, '手动搜索目标丙');

    const event = await createEvent(scope, {
      title: '手动搜索排除', typeId: 'et_1', docs: [{ group: GROUP_A, name: '手动搜索目标甲' }],
    });
    addRefs(scope, event.id, { docs: [{ group: GROUP_A, name: '手动搜索目标乙' }], addedBy: 'manual' });

    const names = searchDocsForAdd(scope, '手动搜索', 20, { eventId: event.id }).map((h) => h.name);
    assert.equal(names.includes('手动搜索目标甲'), false, '已关联必须排除');
    assert.equal(names.includes('手动搜索目标乙'), false, '已加入必须排除');
    assert.ok(names.includes('手动搜索目标丙'), '未占用的照常返回');
  });

  it('不传 eventId 保持旧行为（向后兼容）', () => {
    const names = searchDocsForAdd(scope, '手动搜索', 20).map((h) => h.name);
    assert.ok(names.includes('手动搜索目标甲'));
  });

  it('空查询列出可加入的前 N 篇（对齐 demo：打开弹窗即列表）', async () => {
    seed(GROUP_B, '空查询目标甲');
    const event = await createEvent(scope, { title: '空查询事件', typeId: 'et_1' });
    const all = searchDocsForAdd(scope, '   ', 50, { eventId: event.id });
    assert.ok(all.length > 0, '空查询不得返回空数组（否则弹窗一片空白）');
    assert.equal(all.some((h) => h.name === '空查询目标甲'), true, '未占用的文档应出现在列表里');

    const capped = searchDocsForAdd(scope, '', 2, { eventId: event.id });
    assert.ok(capped.length <= 2, 'limit 生效');
  });

  it('eventId 不存在 → EVENT_NOT_FOUND', () => {
    assert.throws(
      () => searchDocsForAdd(scope, '手动搜索', 20, { eventId: 'evt_not_exist' }),
      (err: { code?: string }) => err.code === 'EVENT_NOT_FOUND',
    );
  });
});

describe('⑤ 检索适配器（错误翻译与窄化）', () => {
  it('executeSearch 返回 ok:false → SEARCH_UNAVAILABLE', async () => {
    const search = createSearchAdapter(async () => ({ ok: false, error: '向量库被占用' }));
    await assert.rejects(
      () => search({ scope, query: 'q', topK: 12 }),
      (err: { code?: string; message?: string }) => (
        err.code === 'SEARCH_UNAVAILABLE' && /向量库被占用/.test(String(err.message))
      ),
    );
  });

  it('executeSearch 抛异常（daemon 通道）→ SEARCH_UNAVAILABLE，不漏成 500', async () => {
    const search = createSearchAdapter(async () => { throw new Error('connect ECONNREFUSED'); });
    await assert.rejects(
      () => search({ scope, query: 'q', topK: 12 }),
      (err: { code?: string }) => err.code === 'SEARCH_UNAVAILABLE',
    );
  });

  it('relation → name，缺定位字段的命中丢弃，limit 收到 topK', async () => {
    const seen: Array<{ limit?: number; mode?: string }> = [];
    const search = createSearchAdapter(async (args) => {
      seen.push({ limit: args.limit, mode: args.mode });
      return {
        ok: true,
        results: [
          { group: GROUP_A, relation: 'cookie 说明', score: 0.9 },
          { group: GROUP_A, score: 0.8 },                       // 缺 relation：辅助通道命中
          { relation: '孤立文档', score: 0.7 },                  // 缺 group
        ],
      };
    });

    const out = await search({ scope, query: 'cookie', topK: 7 });
    assert.deepEqual(out.hits, [{ group: GROUP_A, name: 'cookie 说明', score: 0.9 }]);
    assert.equal(out.mode, 'hybrid', '未标 fulltext 即 hybrid');
    assert.equal(seen[0].limit, 7, 'topK 必须透传为 limit');
    assert.equal(seen[0].mode, 'hybrid');
  });

  it('mode / degraded 原样透出（降级不许伪装成 hybrid）', async () => {
    const search = createSearchAdapter(async () => ({
      ok: true,
      results: [{ group: GROUP_A, relation: '全文命中', score: 0.5 }],
      mode: 'fulltext',
      degraded: true,
      degradedReason: '查询 embedding 超时',
    }));
    const out = await search({ scope, query: 'q', topK: 5 });
    assert.equal(out.mode, 'fulltext');
    assert.equal(out.degraded, true);
    assert.match(String(out.degradedReason), /embedding/);
  });
});
