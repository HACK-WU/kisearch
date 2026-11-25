/**
 * 分析链路「模型自选 scope」单测（2026-11-25 批 3-C · Q3/Q4/Q5）。
 *
 * 锁三件事：
 *   ① 默认范围 = 事件所在库；传了就用传的（且**真的传到执行层**）；
 *   ② 传不存在 / 无权的 scope → 可行动错误，且**不回落默认**、不发起调用；
 *   ③ 调用方没注入 `authScopes` 时保持锁定（旧调用 / 未接鉴权的入口不得白拿自由换库）。
 *
 * 运行：npx jiti test/events/analysis-scope-switch.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildKbReadToolEntries } from '../../src/lib/events/analysis-runner.js';
import type { KiConfig } from '../../src/lib/config.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-analysis-scope-'));
const cfg = { dataDir: tmpDir, chatDir: tmpDir } as KiConfig;

/** 假 KB 执行器：记录实际收到的 scope，让测试能断言「scope 真传下去了」 */
function makeDeps(calls: string[], readable: Record<string, string[]> = {}) {
  return {
    kbExecutor: {
      search: async (a: { scope: string }) => {
        calls.push(`search:${a.scope}`);
        return { results: [] };
      },
      getModuleInfo: async (a: { scope: string; group: string; relation: string }) => {
        calls.push(`read:${a.scope}`);
        const ok = (readable[a.scope] ?? []).includes(a.relation);
        return ok
          ? { ok: true, scope: a.scope, group: a.group, relation: a.relation, content: `${a.scope}/${a.relation}` }
          : { ok: false, error: `文档不存在于 ${a.scope}` };
      },
      groupList: async (a: { scope: string }) => {
        calls.push(`tree:${a.scope}`);
        return { groups: [] };
      },
      tagList: async (a: { scope: string }) => {
        calls.push(`tag:${a.scope}`);
        return [];
      },
    },
  } as never;
}

/** 测试库清单：kb-a（事件库）/ kb-b / kb-c，视图 team-view = [kb-b, kb-c] */
const SCOPE_DEPS = {
  listScopes: () => ['kb-a', 'kb-b', 'kb-c'],
  listViews: () => ({ 'team-view': { members: ['kb-b', 'kb-c'] } }),
};

function makeEntry(
  name: string,
  calls: string[],
  opts?: Parameters<typeof buildKbReadToolEntries>[3],
  readable?: Record<string, string[]>,
) {
  const entries = buildKbReadToolEntries('kb-a', cfg, makeDeps(calls, readable), opts);
  const entry = entries.find((e) => e.name === name);
  assert.ok(entry, `${name} 必须在只读工具集里`);
  return entry;
}

describe('① 默认范围 = 事件所在库', () => {
  it('不传 scope → 用事件库，且真的传到执行层', async () => {
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, { authScopes: ['kb-a', 'kb-b'], scopeDeps: SCOPE_DEPS });
    await search.run({ query: 'q' });
    assert.deepEqual(calls, ['search:kb-a']);

    calls.length = 0;
    const tag = makeEntry('ki_tag_list', calls, { authScopes: ['kb-a', 'kb-b'], scopeDeps: SCOPE_DEPS });
    await tag.run({});
    assert.deepEqual(calls, ['tag:kb-a']);
  });

  it('说明文案随运行环境注入（不传 authScopes 时明说"不允许换库"）', async () => {
    // kbScopeEnv 在 system 里生成，这里通过"锁定分支的行为"间接验证：见 ③
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, undefined);
    const r = await search.run({ query: 'q', scope: 'kb-b' });
    assert.match(String((r as { error?: string }).error ?? ''), /不允许改变检索范围/);
    assert.deepEqual(calls, [], '锁定态下不得执行');
  });
});

describe('② 模型自选：传了就按它查，视图展开为成员库', () => {
  it('传库名 → 该库；不传 → 事件库', async () => {
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, { authScopes: ['kb-a', 'kb-b'], scopeDeps: SCOPE_DEPS });
    await search.run({ query: 'q' });
    await search.run({ query: 'q', scope: 'kb-b' });
    assert.deepEqual(calls, ['search:kb-a', 'search:kb-b']);
  });

  it('传视图 → 展开成成员库后检索（多库一次查）', async () => {
    const calls: string[] = [];
    // 视图本身必须在授权名单里（生产 `authScopes` 已把 viewGrants 合并进来）+ 成员全部已授权
    const search = makeEntry('ki_search', calls, { authScopes: ['kb-a', 'kb-b', 'kb-c', 'team-view'], scopeDeps: SCOPE_DEPS });
    await search.run({ query: 'q', scope: 'team-view' });
    assert.deepEqual(calls, ['search:kb-b,kb-c']);
  });

  it('读正文：视图展开后逐个试，命中即止并回填真实库', async () => {
    const calls: string[] = [];
    const read = makeEntry(
      'ki_get_module_info',
      calls,
      { authScopes: ['kb-a', 'kb-b', 'kb-c', 'team-view'], scopeDeps: SCOPE_DEPS },
      { 'kb-c': ['r'] },
    );
    const r = await read.run({ group: 'g', relation: 'r', scope: 'team-view' });
    assert.deepEqual(calls, ['read:kb-b', 'read:kb-c'], 'kb-b 没有才试 kb-c');
    assert.equal((r as { doc?: { scope?: string } }).doc?.scope, 'kb-c');
  });
});

describe('③ 校验失败：报错、不回落、不执行', () => {
  it('传不存在的 scope → 可行动错误且不发起调用', async () => {
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, { authScopes: ['kb-a'], scopeDeps: SCOPE_DEPS });
    const r = await search.run({ query: 'q', scope: 'no-such-kb' });
    assert.match(String((r as { error?: string }).error ?? ''), /不可用/);
    assert.match(String((r as { error?: string }).error ?? ''), /kb-a/, '要回默认范围，便于自愈');
    assert.deepEqual(calls, [], '不得带着默认范围偷偷执行');
  });

  it('无权限的 scope → 拒绝（逐次鉴权，不是一次放行永久放行）', async () => {
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, { authScopes: ['kb-a'], scopeDeps: SCOPE_DEPS });
    const r = await search.run({ query: 'q', scope: 'kb-b' });
    assert.match(String((r as { error?: string }).error ?? ''), /不可用|无权限|forbidden/);
    assert.deepEqual(calls, []);
  });

  it('未注入 authScopes（旧调用 / 未接鉴权）→ 保持锁定', async () => {
    const calls: string[] = [];
    const search = makeEntry('ki_search', calls, { scopeDeps: SCOPE_DEPS });
    const r = await search.run({ query: 'q', scope: 'kb-b' });
    assert.match(String((r as { error?: string }).error ?? ''), /不允许改变检索范围/);
    assert.deepEqual(calls, []);
  });
});

describe('④ 写工具不参与（Q5：仍锁事件库）', () => {
  it('buildKbWriteToolEntries 的参数表里没有 scope', async () => {
    const { buildKbWriteToolEntries } = await import('../../src/lib/events/analysis-runner.js');
    const writes = buildKbWriteToolEntries('kb-a');
    for (const w of writes) {
      const props = (w.def.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      assert.equal('scope' in props, false, `${w.name} 不得接受 scope（写工具锁事件库）`);
    }
  });
});
