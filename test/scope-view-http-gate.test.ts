/**
 * scope-view-http-gate.test.ts —— 传输层视图成员校验（REQ-20261104-004 / R-09、D3）
 *
 * 背景：003 的设计是「授权视图 = 授权其全部成员内容」（S-04 D4：传输层零改动）。
 * 004 把语义收紧为「授权视图 ∧ 授权全部成员」，于是传输层必须展开成员逐个校验——
 * 否则 token `['team','a']`（team=[a,b]）仍能 `--scope team` 读到未授权的 b。
 *
 * 这里验的是纯函数 `findScopeViolation` 的判定（成员表用注入的 resolver，不碰磁盘）。
 *
 * 运行：npx jiti test/scope-view-http-gate.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findScopeViolation } from '../src/lib/mcp-http.js';

/** 造一个 tools/call 请求体 */
function call(scope?: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ki_search',
      arguments: scope === undefined ? {} : { scope },
    },
  };
}

/** 注入的视图成员表：只有 team = [a, b] */
const VIEWS: Record<string, string[]> = { team: ['a', 'b'] };
const viewMembers = (name: string): string[] | null => VIEWS[name] ?? null;

describe('findScopeViolation：视图成员校验（R-09）', () => {
  it('授权视图且授权全部成员 → 放行', () => {
    assert.equal(findScopeViolation(call('team'), ['team', 'a', 'b'], viewMembers), null);
  });

  it('★ 授权视图但缺一个成员 → 拒绝（003 的旧行为会放行，这正是要堵的越权）', () => {
    assert.equal(findScopeViolation(call('team'), ['team', 'a'], viewMembers), 'team');
  });

  it('只授权成员、未授权视图名 → 拒绝', () => {
    assert.equal(findScopeViolation(call('team'), ['a', 'b'], viewMembers), 'team');
  });

  it('all 通配仍全放行（含成员检查）', () => {
    assert.equal(findScopeViolation(call('team'), ['all'], viewMembers), null);
  });

  it('多段请求中视图缺成员 → 返回该视图名（整段拒绝，不做部分可见）', () => {
    assert.equal(findScopeViolation(call('a,team'), ['team', 'a'], viewMembers), 'team');
    assert.equal(findScopeViolation(call('team,a'), ['team', 'a'], viewMembers), 'team');
  });

  it('真实 scope 不受视图成员检查影响', () => {
    assert.equal(findScopeViolation(call('a'), ['a'], viewMembers), null);
    assert.equal(findScopeViolation(call('a'), ['b'], viewMembers), 'a');
  });

  it('不传 resolver 时退化为旧行为（只校验名字）', () => {
    assert.equal(findScopeViolation(call('team'), ['team', 'a'], undefined), null);
  });

  it('batch：任一项视图缺成员即拒绝', () => {
    const batch = [call('a'), call('team')];
    assert.equal(findScopeViolation(batch, ['team', 'a'], viewMembers), 'team');
  });

  it('缺省 scope=default 时不因视图表而误判', () => {
    assert.equal(findScopeViolation(call(undefined), ['default'], viewMembers), null);
    assert.equal(findScopeViolation(call(undefined), ['team', 'a'], viewMembers), 'default');
  });
});
