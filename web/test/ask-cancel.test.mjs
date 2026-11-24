/**
 * ask-cancel.test.mjs —— 追问「停止」按钮的前端接入契约（2026-11-24）
 *
 * 锁住四条容易回退的约定（无 jsdom，沿用仓库既有做法做源码契约断言）：
 *   1) 运行中（本地流式 / 服务端接续）把「发送」换成「停止」，两种形态都能停；
 *   2) 停止请求走后端 `POST /analysis/ask/cancel`，沿用分析侧的幂等语义；
 *   3) **主动停止绝不能落进「回退普通 POST」分支** —— 那条兜底会重新发一次完整追问，
 *      等于把用户刚停掉的这一轮又跑一遍（用户看不到、但确实在烧钱）；
 *   4) 停止解锁要等服务端收口（`!asking && !remote`），不能一发出请求就放开输入。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const block = read('src/components/governance/event-detail/AskBlock.tsx');
const api = read('src/api/governanceApi.ts');

describe('① 停止入口', () => {
  it('运行中把「发送」换成「停止」（两种运行形态都覆盖）', () => {
    assert.match(block, /\{asking \|\| remote \? \(/, '本地流式与服务端接续都必须出现停止按钮');
    assert.match(block, /gov-btn gov-btn--sm gov-btn--danger-ghost/);
    assert.match(block, /\{stopping \? '停止中…' : '停止'\}/);
  });

  it('停止中禁用，防连点', () => {
    assert.match(block, /disabled=\{!canAsk \|\| stopping\}/);
  });

  it('权限沿用提问权限（能发起就能收回）', () => {
    // 停止按钮的 title 用 askTitle，而不是写权限
    assert.match(block, /title=\{!canAsk\s*\?\s*askTitle/);
    assert.match(block, /'停止这一轮追问（已生成的内容会保留）'/);
  });
});

describe('② 停止请求', () => {
  it('api 层打的是 /analysis/ask/cancel', () => {
    assert.match(api, /export function cancelEventAsk\(/);
    assert.match(api, /\/analysis\/ask\/cancel/);
    assert.match(api, /canceled: boolean/);
  });

  it('AskBlock 调 cancelEventAsk 并在 canceled:false 时不当失败处理', () => {
    assert.match(block, /const res = await cancelEventAsk\(scope, eventId\);/);
    assert.match(block, /if \(!res\.canceled\)/);
    /*
     * 两种含义必须分开：本地还在流式时 `canceled:false` 是竞态（服务端那一轮
     * 还没注册），此时宣称"已结束"会和随后涌出的回答自相矛盾。
     */
    assert.match(block, /asking \? '服务端暂未找到这一轮，可稍后重试停止' : '这一轮追问已经结束'/);
  });
});

describe('③ 停止的收口与不误报', () => {
  it('CANCELED 分支挡在「回退普通 POST」之前', () => {
    const canceledAt = block.indexOf("code === 'ANALYSIS_ASK_CANCELED'");
    const fallbackAt = block.indexOf('await askEventAnalysis(scope, eventId');
    assert.ok(canceledAt > 0, '必须有 ANALYSIS_ASK_CANCELED 的专门分支');
    assert.ok(fallbackAt > 0, '回退普通 POST 的分支应仍存在');
    assert.ok(
      canceledAt < fallbackAt,
      '停止分支必须在回退之前 —— 否则会重新发起一次完整追问',
    );
  });

  it('停止用中性提示（gov-hint），不落红色 error', () => {
    assert.match(block, /setNotice\('已停止本轮追问'\)/);
    assert.match(block, /\{notice \? <span className="gov-hint">\{notice\}<\/span> : null\}/);
  });

  it('停止文案不承诺「没生成内容」（落库失败也会走到这条分支）', () => {
    // 只查文案本身：注释里会引用这句"错误写法"作说明，不该被算命中
    assert.doesNotMatch(block, /setNotice\([^)]*尚未生成内容/);
  });

  it('停止后不回填输入框（那不是失败，不必让用户重发）', () => {
    const canceledBlock = block.slice(
      block.indexOf("if (stoppedRef.current || code === 'ANALYSIS_ASK_CANCELED')"),
      block.indexOf('// 一字未收到 → 回退普通 POST'),
    );
    assert.match(canceledBlock, /setQuestion\(''\)/);
  });

  it('「有半截内容」走正常 done，本地标记补一句「已停止」', () => {
    assert.match(block, /if \(stoppedRef\.current\) setNotice\('已停止本轮追问 · 已生成的部分已保留'\)/);
  });
});

describe('④ 解锁时机', () => {
  it('等本地流式结束且服务端没有在跑的轮次才解锁', () => {
    assert.match(block, /if \(!asking && !remote && stopping\) setStopping\(false\);/);
  });

  it('新一轮开跑清掉上一轮的停止标记', () => {
    assert.match(block, /stoppedRef\.current = false;/);
  });
});
