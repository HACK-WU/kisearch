/**
 * atlas/link —— `ki atlas link` 的纯规划逻辑（2026-11-27）
 *
 * 只测判断，不碰 views.json / tokens.json：
 * 目标视图怎么选、阈值怎么跳过、哪些 Token 需要补授权。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_LINK_MAX_MEMBERS,
  planAtlasLink,
  planTokenGrants,
  withAtlasScope,
} from '../src/lib/atlas/link.js';

const views = (defs: Record<string, string[]>) => Object.fromEntries(
  Object.entries(defs).map(([name, members]) => [name, { members }]),
);

test('自动发现：只取 members 含主库的视图', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({
      'kisearch-docs': ['kisearch-memory', 'kisearch-xperts'],
      'with-main': ['kisearch', 'kisearch-memory'],
      'no-main': ['monitor', 'monitor-memory'],
      'main-later': ['alpha', 'kisearch'],
    }),
  });
  assert.deepEqual(plan.targets, ['with-main', 'main-later']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.missingViews, []);
  assert.deepEqual(plan.notContaining, []);
});

test('自动发现：成员数超阈值（5）的视图被跳过', () => {
  const six = ['kisearch', 'a', 'b', 'c', 'd', 'e'];
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ small: ['kisearch', 'a'], big: six }),
  });
  assert.deepEqual(plan.targets, ['small']);
  assert.deepEqual(plan.skipped, ['big']);
  assert.equal(AUTO_LINK_MAX_MEMBERS, 5);
});

test('自动发现：恰好等于阈值仍纳入（只跳 > 5）', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ five: ['kisearch', 'a', 'b', 'c', 'd'] }),
  });
  assert.deepEqual(plan.targets, ['five']);
  assert.deepEqual(plan.skipped, []);
});

test('显式限定：正常视图原样作为 targets', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ 'with-main': ['kisearch'], 'big': ['kisearch', 'a', 'b', 'c', 'd', 'e'] }),
    viewFilter: ['big'],
  });
  assert.deepEqual(plan.targets, ['big'], '显式指定时不受阈值限制');
  assert.deepEqual(plan.skipped, []);
});

test('显式限定：不存在的视图记入 missingViews 且不产出 targets', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ 'with-main': ['kisearch'] }),
    viewFilter: ['ghost'],
  });
  assert.deepEqual(plan.missingViews, ['ghost']);
  assert.deepEqual(plan.targets, []);
});

test('显式限定：不含主库的视图记入 notContaining 且不产出 targets', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ other: ['monitor'] }),
    viewFilter: ['other'],
  });
  assert.deepEqual(plan.notContaining, ['other']);
  assert.deepEqual(plan.targets, []);
});

test('没有任何含主库的视图时 targets 为空（调用方据此报错）', () => {
  const plan = planAtlasLink({
    mainScope: 'kisearch',
    views: views({ other: ['monitor'] }),
  });
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.skipped, []);
});

test('空视图集合不抛错', () => {
  const plan = planAtlasLink({ mainScope: 'kisearch', views: {} });
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.skipped, []);
});

test('补授权规划：全量授权跳过、已授权忽略、其余待补', () => {
  const plan = planTokenGrants({
    tokens: [
      { id: 'tok_all', scopes: ['all'] },
      { id: 'tok_has', scopes: ['kisearch-docs', 'kisearch-atlas'] },
      { id: 'tok_need', scopes: ['kisearch-docs', 'kisearch'] },
    ],
    atlasScope: 'kisearch-atlas',
    allScopes: 'all',
    isAuthorized: (scopes, scope) => scopes.includes('all') || scopes.includes(scope),
  });
  assert.deepEqual(plan.updated, ['tok_need']);
  assert.deepEqual(plan.skipped, ['tok_all']);
});

test('补授权规划：没有 Token 时两项都为空（不报错）', () => {
  const plan = planTokenGrants({
    tokens: [],
    atlasScope: 'kisearch-atlas',
    allScopes: 'all',
    isAuthorized: () => false,
  });
  assert.deepEqual(plan.updated, []);
  assert.deepEqual(plan.skipped, []);
});

test('withAtlasScope 幂等：已包含时不重复追加', () => {
  assert.deepEqual(withAtlasScope(['a', 'b'], 'b'), ['a', 'b']);
  assert.deepEqual(withAtlasScope(['a'], 'b'), ['a', 'b']);
});
