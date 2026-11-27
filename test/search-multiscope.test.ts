/**
 * search-multiscope.test.ts —— ki-search 多 scope 支持测试
 *
 * 契约：
 *   - parseScopes：逗号分隔，去空格/去重/保序；格式非法快速失败
 *   - executeSearch 多 scope：strict 未注册 → 跳过+提示（ok:true）；全部被跳过 → ok:false
 *   - executeSearch 单 scope：strict 未注册保持现状（fail-loud，向后兼容）
 *   - executeSearch 目录闸门（事件 #111）：KB 目录不存在 → 单库 fail-loud（与 ki_group_list
 *     同源文案）、多库只跳过并进 skipped；目录存在的库结果零变化
 *   - findScopeViolation（HTTP 鉴权闸门）：多 scope 逐段校验，任一段越权即拒绝
 *
 * 运行：npx jiti test/search-multiscope.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseScopes } from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';
import { findScopeViolation } from '../src/lib/mcp-http.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-multiscope-'));

/** 临时配置文件（注册 team-a/team-b 并建出 KB 目录；未注册 ghost） */
function setupConfig(scopeMode: string): void {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `cfg-${scopeMode}-${Date.now()}-`));
  const dataDir = path.join(dir, 'kb');
  // ★ 事件 #111：检索侧现在按「KB 目录是否存在」判定库可用（与 ki_group_list 同源判据），
  //   只注册、不建目录的名字会被当成「尚未导入」。测试库必须落盘，否则测的是空目录语义。
  fs.mkdirSync(path.join(dataDir, 'team-a'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'team-b'), { recursive: true });
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${dataDir}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      `scopeMode: ${scopeMode}`,
      'scopes:',
      '  team-a: {}',
      '  team-b: {}',
      '',
    ].join('\n'),
    'utf-8'
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
}

afterEach(() => {
  delete process.env.KI_CONFIG_PATH;
  resetConfigCache();
});

// ─── parseScopes ───

describe('parseScopes（逗号分隔多 scope 解析）', () => {
  it('逗号分隔：去空格、去重、保序', () => {
    assert.deepEqual(parseScopes('team-a, team-b ,team-a'), ['team-a', 'team-b']);
  });

  it('单值与空段', () => {
    assert.deepEqual(parseScopes('solo'), ['solo']);
    assert.deepEqual(parseScopes('team-a,,team-b,'), ['team-a', 'team-b']);
  });

  it('空/未传 → 空数组（由调用方走缺省回退）', () => {
    assert.deepEqual(parseScopes(undefined), []);
    assert.deepEqual(parseScopes(''), []);
    assert.deepEqual(parseScopes('   '), []);
  });

  it('纯分隔符（无有效段）→ 快速失败', () => {
    assert.throws(() => parseScopes(', ,'), /解析为空/);
  });

  it('非法字符（路径遍历）→ 快速失败', () => {
    assert.throws(() => parseScopes('team-a,../etc'), /不合法/);
    assert.throws(() => parseScopes('team-a,team b'), /不合法/);
  });
});

// ─── executeSearch 多 scope 语义 ───

describe('executeSearch 多 scope（strict 模式）', () => {
  it('部分未注册 → 跳过+提示，其余照常（ok:true + skipped）', async () => {
    setupConfig('strict');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'team-a,ghost', query: 'q' });
    // team-a 有效 → 继续走向量层；测试环境无可用向量库 → 降级/引擎层错误（不影响多 scope 语义断言）
    if (result.ok) {
      assert.deepEqual(result.scopes, ['team-a'], '仅检索已注册 scope');
      assert.deepEqual(result.skipped?.map((k) => k.scope), ['ghost'], '未注册被跳过');
      assert.match(result.skipped?.[0]?.reason ?? '', /未注册/);
      assert.strictEqual(result.scope, 'team-a');
    } else {
      // 向量层不可用/未配置：错误不应来自 scope 校验（ghost 未注册不得阻断）
      assert.ok(!/ghost/.test(result.error), `错误不应来自 scope 校验：${result.error}`);
      assert.ok(!/无可检索/.test(result.error));
    }
  });

  it('全部未注册 → ok:false 且提示原因', async () => {
    setupConfig('strict');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'ghost1,ghost2', query: 'q' });
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && /无可检索的 scope/.test(result.error), '应提示无可检索的 scope');
    assert.ok(!result.ok && /ghost1/.test(result.error));
  });

  it('格式非法 → 快速失败（安全类不容忍）', async () => {
    setupConfig('strict');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'team-a,../etc', query: 'q' });
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && /不合法/.test(result.error));
  });

  it('单 scope 未注册保持现状：fail-loud（向后兼容）', async () => {
    setupConfig('strict');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'ghost', query: 'q' });
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && /unknown scope/.test(result.error), '单 scope 仍走 resolveScope 抛错路径');
  });
});

describe('executeSearch 多 scope（default 模式）', () => {
  it('未注册但目录存在也放行（KB 目录即判据），返回多 scope 结构', async () => {
    setupConfig('default');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'team-a,team-b', query: 'q' });
    if (result.ok) {
      assert.deepEqual(result.scopes, ['team-a', 'team-b']);
      assert.strictEqual(result.skipped, undefined, '无跳过时不返回 skipped');
    } else {
      // default 模式不应因未注册而失败；错误只可能来自向量层（与单 scope 现状一致）
      assert.ok(!/未注册|无可检索/.test(result.error), `错误不应来自 scope 校验：${result.error}`);
    }
  });

  it('单库目录不存在 → fail-loud，文案与 ki_group_list 同源并给视野图出路（事件 #111）', async () => {
    setupConfig('default');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'ghost', query: 'q', mode: 'fulltext' });
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && /尚未导入（KB 目录不存在）/.test(result.error), '应给出与 group_list 同源的文案');
    assert.ok(!result.ok && /ki view list/.test(result.error), '应提示「若以为是视图」的出路');
  });

  it('多库部分目录不存在 → 只跳过不整体失败（ok:true + skipped，事件 #111）', async () => {
    setupConfig('default');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'team-a,ghost', query: 'q', mode: 'fulltext' });
    assert.strictEqual(result.ok, true, `不应整体失败：${result.ok ? '' : result.error}`);
    if (result.ok) {
      assert.deepEqual(result.scopes, ['team-a'], '不存在的库不参与检索');
      assert.deepEqual(result.skipped?.map((k) => k.scope), ['ghost']);
      assert.match(result.skipped?.[0]?.reason ?? '', /尚未导入/);
      // 跳过原因不得撞「无向量 Collection」前缀：撞了会在 hybrid 降级路径被整批清理（修复失效）
      assert.ok(!(result.skipped?.[0]?.reason ?? '').startsWith('无向量 Collection'));
    }
  });

  it('多库全部目录不存在 → ok:false 且逐项列出原因（事件 #111）', async () => {
    setupConfig('default');
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope: 'ghost,ghost2', query: 'q', mode: 'fulltext' });
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && /无可检索的 scope/.test(result.error));
    assert.ok(!result.ok && /ghost/.test(result.error) && /ghost2/.test(result.error));
  });
});

// ─── HTTP 鉴权闸门：多 scope 逐段校验 ───

describe('findScopeViolation（多 scope 越权闸门）', () => {
  function call(scope?: unknown) {
    return { method: 'tools/call', params: { name: 'ki_search', arguments: { scope, query: 'q' } } };
  }

  it('全部授权（逗号分隔）→ 放行', () => {
    assert.strictEqual(findScopeViolation(call('team-a,team-b'), ['team-a', 'team-b']), null);
  });

  it('任一段越权 → 拒绝并返回违规段', () => {
    assert.strictEqual(findScopeViolation(call('team-a,secret'), ['team-a']), 'secret');
    assert.strictEqual(findScopeViolation(call('secret,team-a'), ['team-a']), 'secret');
  });

  it('all 通配 → 放行', () => {
    assert.strictEqual(findScopeViolation(call('team-a,secret'), ['all']), null);
  });

  it('缺省/空串等价 default（保持现状）', () => {
    assert.strictEqual(findScopeViolation(call(undefined), ['team-a']), 'default');
    assert.strictEqual(findScopeViolation(call(''), ['default']), null);
    assert.strictEqual(findScopeViolation(call('  '), ['default']), null);
  });

  it('纯分隔符（无有效段）等价 default', () => {
    assert.strictEqual(findScopeViolation(call(',, ,'), ['default']), null);
    assert.strictEqual(findScopeViolation(call(',, '), ['team-a']), 'default');
  });

  it('batch 中任一 tools/call 越权即拒绝', () => {
    const batch = [call('team-a'), call('team-a,secret')];
    assert.strictEqual(findScopeViolation(batch, ['team-a']), 'secret');
  });

  it('段内空格规范化后再校验', () => {
    assert.strictEqual(findScopeViolation(call(' team-a , team-b '), ['team-a', 'team-b']), null);
    assert.strictEqual(findScopeViolation(call(' team-a , secret '), ['team-a']), 'secret');
  });
});
