/**
 * 上下文用量（字符口径）· 纯函数与阈值规则单测（REQ-20261013-001）
 *
 * 锁住五条不变量：
 *   1) 展示口径：`已用 / 上限 · 占比`；**分母缺失时只显示绝对值**（不猜窗口）；
 *      无数据一律 `—`（**不得显示 0** —— 0 会被读成"没有用量"）
 *   2) 阈值：≥80% warn、≥90% danger、缺分子或分母 → unknown（不误报）
 *   3) 实时口径：展示值 = 基数 + 正在生成的正文字符（前端只做加法，不估算 system/工具）
 *   4) 忽略规则：同会话同档位只提示一次；档位升级（warn → danger）再次提示；
 *      会话变化（压缩/撤销）后清除 → 提示重新可用
 *   5) 压缩可用性：消息数不足时前端禁用入口（后端仍会二次判定）
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// localStorage 桩（node 默认没有；模块内部按 `typeof localStorage === 'undefined'` 降级）
class MemoryStorage {
  #map = new Map();
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null; }
  setItem(k, v) { this.#map.set(k, String(v)); }
  removeItem(k) { this.#map.delete(k); }
  clear() { this.#map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const {
  DEFAULT_CONTEXT_CHARS,
  CONTEXT_WARN_RATIO,
  CONTEXT_DANGER_RATIO,
  CONTEXT_MEASURE_NOTE,
  RING_MIN_ARC,
  ringProgress,
  formatK,
  formatKUnit,
  contextRatio,
  contextLevel,
  contextUsageLabel,
  liveContextChars,
  canCompactMessages,
  shouldShowContextWarn,
  dismissContextWarn,
  clearContextWarnDismiss,
  contextWarnText,
  sumContextParts,
} = await vite.ssrLoadModule('/src/lib/contextUsage.ts');
const { INITIAL_CHAT_STATE, chatReducer } = await vite.ssrLoadModule('/src/chat/chatStore.ts');

after(async () => {
  await vite.close();
  delete globalThis.localStorage;
});

describe('展示口径', () => {
  it('K 单位：小于 1000 显示原数，否则 1 位小数 + K', () => {
    assert.equal(formatK(0), '0');
    assert.equal(formatK(842), '842');
    assert.equal(formatK(12400), '12.4K');
    assert.equal(formatK(1000000), '1000.0K');
  });

  it('无数据（null / NaN / 负数）→ `—`，**不得显示 0**', () => {
    assert.equal(formatK(null), '—');
    assert.equal(formatK(undefined), '—');
    assert.equal(formatK(Number.NaN), '—');
    assert.equal(formatK(-1), '—');
    assert.equal(contextUsageLabel(null, 1000000), '—');
    assert.equal(contextUsageLabel(Number.NaN, 1000000), '—');
  });

  it('一律 K 单位（用户口径：不是多少字，而是多少 K）', () => {
    assert.equal(formatKUnit(0), '0');
    assert.equal(formatKUnit(482), '0.48K', '小值也带 K，不出现裸字符数');
    assert.equal(formatKUnit(1), '0.01K', '非零极小值抬到 0.01K，不得显示成 0.00K');
    assert.equal(formatKUnit(3400), '3.4K');
    assert.equal(formatKUnit(1000000), '1000.0K');
    assert.equal(formatKUnit(null), '—');
  });

  it('有分母 → `已用 / 上限 · 占比`（无「字」后缀）；分母缺失 → 只给绝对值', () => {
    assert.equal(contextUsageLabel(12400, 1000000), '12.4K / 1000.0K · 1.2%');
    assert.equal(contextUsageLabel(482, 1000000), '0.48K / 1000.0K · 0.0%');
    assert.equal(contextUsageLabel(12400, null), '12.4K');
    assert.equal(contextUsageLabel(12400, 0), '12.4K');
    assert.equal(/\s字/.test(contextUsageLabel(12400, 1000000)), false, '不得出现「字」单位词');
  });

  it('占比与 null 语义（分母非法 → null，不产出 Infinity/NaN 文案）', () => {
    assert.equal(contextRatio(500, 1000), 0.5);
    assert.equal(contextRatio(500, 0), null);
    assert.equal(contextRatio(undefined, 1000), null);
    assert.equal(DEFAULT_CONTEXT_CHARS, 1000000, '上限缺省 = 1000K 字符');
  });
});

describe('阈值档位', () => {
  it('80% 起 warn、90% 起 danger；缺分子或分母 → unknown（不误报）', () => {
    assert.equal(CONTEXT_WARN_RATIO, 0.8);
    assert.equal(CONTEXT_DANGER_RATIO, 0.9);
    assert.equal(contextLevel(799000, 1000000), 'ok');
    assert.equal(contextLevel(800000, 1000000), 'warn');
    assert.equal(contextLevel(899000, 1000000), 'warn');
    assert.equal(contextLevel(900000, 1000000), 'danger');
    assert.equal(contextLevel(null, 1000000), 'unknown');
    assert.equal(contextLevel(1000, null), 'unknown');
  });

  it('预警文案带**出路**（压缩 / 新建会话），danger 明确风险', () => {
    const warn = contextWarnText(820000, 1000000, 'warn');
    assert.match(warn, /82%/);
    assert.match(warn, /压缩上下文|新建会话/);
    const danger = contextWarnText(930000, 1000000, 'danger');
    assert.match(danger, /超出模型上限/);
  });
});

describe('实时口径（基数 + 正在生成的正文字符）', () => {
  it('流式期间逐字上涨；无基数时返回 null（不假装有数据）', () => {
    assert.equal(liveContextChars(12400, 0), 12400);
    assert.equal(liveContextChars(12400, 260), 12660);
    assert.equal(liveContextChars(null, 100), null);
    assert.equal(liveContextChars(undefined, 100), null);
    assert.equal(liveContextChars(1000, -5), 1000, '负数增量按 0 处理');
  });

  it('环形进度：越界夹取、无数据为 0（空环）、极小正值留可见弧', () => {
    assert.equal(ringProgress(null), 0, '无数据 = 空环（不得画成已满）');
    assert.equal(ringProgress(Number.NaN), 0);
    assert.equal(ringProgress(0), 0);
    assert.equal(ringProgress(0.5), 0.5);
    assert.equal(ringProgress(1), 1);
    assert.equal(ringProgress(1.4), 1, '超过上限也画满圆（不越出轨道）');
    assert.equal(ringProgress(0.001), RING_MIN_ARC, '极小值抬到可见弧');
    assert.ok(RING_MIN_ARC > 0 && RING_MIN_ARC < 0.1);
  });

  it('分量合计与 refs 子集语义', () => {
    assert.equal(sumContextParts({ system: 100, user: 50, assistant: 30, tool: 20, refs: 40 }), 200);
    assert.equal(sumContextParts(null), null);
  });
});

describe('压缩入口可用性', () => {
  it('保留 4 条 + 至少压 2 条 → 6 条起才可用', () => {
    assert.equal(canCompactMessages(0), false);
    assert.equal(canCompactMessages(5), false);
    assert.equal(canCompactMessages(6), true);
  });
});

describe('阈值提示的忽略规则', () => {
  it('同会话同档位只提示一次；档位升级再次提示', () => {
    const conv = 'c-test-1';
    assert.equal(shouldShowContextWarn(conv, 'warn'), true);
    dismissContextWarn(conv, 'warn');
    assert.equal(shouldShowContextWarn(conv, 'warn'), false, '同档位不再打扰');
    assert.equal(shouldShowContextWarn(conv, 'danger'), true, '升级到 danger 必须重新提示');
    dismissContextWarn(conv, 'danger');
    assert.equal(shouldShowContextWarn(conv, 'danger'), false);
  });

  it('会话之间互不影响；无会话 id 时不提示（也没有记账键）', () => {
    assert.equal(shouldShowContextWarn('c-test-2', 'warn'), true);
    assert.equal(shouldShowContextWarn(null, 'warn'), false);
    assert.equal(shouldShowContextWarn('c-test-2', 'ok'), false);
    assert.equal(shouldShowContextWarn('c-test-2', 'unknown'), false);
  });

  it('压缩 / 撤销后清除忽略记录 → 提示重新可用（状态已变）', () => {
    const conv = 'c-test-3';
    dismissContextWarn(conv, 'warn');
    assert.equal(shouldShowContextWarn(conv, 'warn'), false);
    clearContextWarnDismiss(conv);
    assert.equal(shouldShowContextWarn(conv, 'warn'), true);
  });

  it('localStorage 不可用时降级为"不记忆"，但绝不抛异常', () => {
    const saved = globalThis.localStorage;
    delete globalThis.localStorage;
    try {
      assert.doesNotThrow(() => dismissContextWarn('c-x', 'warn'));
      assert.equal(shouldShowContextWarn('c-x', 'warn'), true);
    } finally {
      globalThis.localStorage = saved;
    }
  });
});

describe('chatStore：context 累积态', () => {
  const parts = { system: 10, user: 5, assistant: 0, tool: 0, refs: 0 };

  it('streamContext 写入基数；后到者覆盖（工具轮次后基数变大）', () => {
    let s = { ...INITIAL_CHAT_STATE };
    s = chatReducer(s, { type: 'streamStart', messageId: 'm1', seq: 1, at: '2026-01-01T00:00:00Z' });
    s = chatReducer(s, { type: 'streamContext', chars: 100, parts });
    assert.equal(s.streaming.context.chars, 100);
    s = chatReducer(s, { type: 'streamContext', chars: 350, parts: { ...parts, tool: 240 } });
    assert.equal(s.streaming.context.chars, 350, '取最后一次（不是累加）');
    assert.equal(s.streaming.context.parts.tool, 240);
  });

  it('新一轮从零开始（streamStart 清空上一轮基数）', () => {
    let s = { ...INITIAL_CHAT_STATE };
    s = chatReducer(s, { type: 'streamStart', messageId: 'm1', seq: 1 });
    s = chatReducer(s, { type: 'streamContext', chars: 100, parts });
    s = chatReducer(s, { type: 'streamStart', messageId: 'm2', seq: 2 });
    assert.equal(s.streaming.context, null, '新流不得沿用上一轮基数');
  });
});
