/**
 * 上下文上限输入换算与写接口（REQ-20261014-001）· 纯函数与请求形状单测
 *
 * 锁住四条不变量：
 *   1) **K 是给用户看的单位，字符是给后端传的单位** —— 换算只能有一处，且必须四舍五入到整数
 *      （后端只收正整数；浮点误差导致的 499.999… 会被拒）
 *   2) **不可提交的输入一律返回 null**（不是 0、不是 NaN）：调用方据此禁用按钮。空/怪异写法
 *      （`1e3` / `0x10` / `1000K`）/ 非正 / 超上界 / 换算后不足 1 字符都必须被挡住
 *   3) **恢复默认写的是 1000K**（= 1,000,000 字符），与后端 `CHAT_BUDGET.defaultContextChars` 同源
 *   4) 写接口只发 `{ contextChars }` 一个字段到 `PUT /api/chat/config`（服务端白名单，多发即 400）
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

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
  CONTEXT_CHARS_MAX,
  CONTEXT_LIMIT_K_MAX,
  CONTEXT_LIMIT_SMALL_CHARS,
  CONTEXT_LIMIT_LARGE_CHARS,
  parseContextLimitK,
  contextLimitToKText,
  contextLimitHint,
} = await vite.ssrLoadModule('/src/lib/contextUsage.ts');

after(async () => { await vite.close(); });

// ─────────────────────────────────────────────────────────────

describe('同源常量：与后端对齐的默认值与上界', () => {
  it('① 默认上限 = 1000K = 1,000,000 字符（后端 CHAT_BUDGET.defaultContextChars）', () => {
    assert.equal(DEFAULT_CONTEXT_CHARS, 1_000_000);
  });

  it('② 硬上界 = 1 亿字符，K 上界是其 1/1000', () => {
    assert.equal(CONTEXT_CHARS_MAX, 100_000_000);
    assert.equal(CONTEXT_LIMIT_K_MAX, 100_000);
    assert.equal(parseContextLimitK(String(CONTEXT_LIMIT_K_MAX)), CONTEXT_CHARS_MAX,
      'K 上界换算回来必须恰好等于字符上界（否则会出现"界面允许、后端拒绝"的死角）');
  });
});

describe('parseContextLimitK —— 不可提交的输入一律 null（调用方据此禁用按钮）', () => {
  const rejected = [
    ['空串', ''],
    ['纯空白', '   '],
    ['非数字', 'abc'],
    ['科学计数法', '1e3'],
    ['十六进制', '0x10'],
    ['带单位（单位是独立标签，不该写进输入框）', '1000K'],
    ['负数', '-5'],
    ['正号前缀', '+5'],
    ['零', '0'],
    ['小数点为 0', '.5'],
    ['小数点结尾', '5.'],
    ['换算后不足 1 字符（0.1 → round 0）', '0.0001'],
    ['超硬上界', '100000.001'],
  ];
  for (const [name, input] of rejected) {
    it(`拒绝 ${name}：${JSON.stringify(input)} → null`, () => {
      assert.equal(parseContextLimitK(input), null);
    });
  }
});

describe('parseContextLimitK —— 合法输入换算为整数（后端只收正整数）', () => {
  it('整数 K', () => {
    assert.equal(parseContextLimitK('1000'), 1_000_000);
    assert.equal(parseContextLimitK('500'), 500_000);
    assert.equal(parseContextLimitK('250'), 250_000);
  });

  it('小数 K → 四舍五入到 1 字符', () => {
    assert.equal(parseContextLimitK('0.5'), 500);
    assert.equal(parseContextLimitK('1.5'), 1500);
    assert.equal(parseContextLimitK('0.001'), 1);
  });

  it('前后空白被 trim（用户复制粘贴常带空格）', () => {
    assert.equal(parseContextLimitK(' 250 '), 250_000);
  });

  it('★ 结果恒为整数（后端 schema 是 positiveInt，浮点尾巴会被拒）', () => {
    for (const k of ['0.3', '1.7', '99.99', '1000.0004']) {
      const chars = parseContextLimitK(k);
      assert.ok(Number.isInteger(chars), `${k} 换算结果应为整数，实际 ${chars}`);
      assert.ok(chars > 0);
    }
  });

  it('恰好等于上界仍然合法（边界包含）', () => {
    assert.equal(parseContextLimitK('100000'), CONTEXT_CHARS_MAX);
  });
});

describe('contextLimitToKText —— 字符 → 输入框文本（去尾随零）', () => {
  it('整千值不带小数点', () => {
    assert.equal(contextLimitToKText(1_000_000), '1000');
    assert.equal(contextLimitToKText(250_000), '250');
  });

  it('不足 1K 时保留小数（面板同口径）', () => {
    assert.equal(contextLimitToKText(500), '0.5');
    assert.equal(contextLimitToKText(1), '0.001');
  });

  it('非法值 → 空串（不是 "0"，0 会被读成"上限是 0"）', () => {
    for (const v of [0, -1, null, undefined, NaN, Infinity]) {
      assert.equal(contextLimitToKText(v), '');
    }
  });

  it('★ 往返一致：文本 → 字符 → 文本（用户不动输入框时不该看到数字跳变）', () => {
    for (const chars of [1_000_000, 250_000, 500_000, 1_500, 500, 1]) {
      const text = contextLimitToKText(chars);
      assert.equal(parseContextLimitK(text), chars, `往返失败：${chars} → "${text}"`);
    }
  });
});

// 注：原先这里测 `saveChatContextChars`（专用写接口 `PUT /api/chat/config`）。
// 用户裁决（2026-10-14）后，界面覆盖值改存进**对话配置**（`PUT /api/chat/prompt-config`），
// 该专用接口已删除。它最核心的契约 ——「改界面不写 config.yaml」—— 由后端
// `test/chat/context-limit-config.test.ts` 逐字节断言锁定（②c / ③c / ⑤ / ⑥a / ⑧）。

describe('contextLimitHint —— 极小 / 极大但合法的值必须给出说明（R6）', () => {
  it('① 过小 → small（系统提示本身约 3~4K 字符）', () => {
    assert.equal(contextLimitHint(1), 'small', '1 字符虽合法，但必须提示会发生什么');
    assert.equal(contextLimitHint(5_000), 'small');
    assert.equal(contextLimitHint(CONTEXT_LIMIT_SMALL_CHARS - 1), 'small');
  });

  it('② 阈值本身不提示（边界包含）', () => {
    assert.equal(contextLimitHint(CONTEXT_LIMIT_SMALL_CHARS), null);
    assert.equal(contextLimitHint(CONTEXT_LIMIT_LARGE_CHARS), null);
  });

  it('③ 常用区间（100K~2000K）不提示', () => {
    for (const chars of [100_000, 250_000, 500_000, 1_000_000, 2_000_000]) {
      assert.equal(contextLimitHint(chars), null, `${chars} 不应触发提示`);
    }
  });

  it('④ 过大 → large（占比恒近 0 ⇒ 预警静默失效）', () => {
    assert.equal(contextLimitHint(CONTEXT_LIMIT_LARGE_CHARS + 1), 'large');
    assert.equal(contextLimitHint(CONTEXT_CHARS_MAX), 'large');
  });

  it('⑤ 无效值不提示（非法输入由另一条提示负责，不重复说）', () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity]) {
      assert.equal(contextLimitHint(v), null);
    }
  });

  it('★ ⑥ 提示只说明、不拦截：过小/过大的值仍能通过 parseContextLimitK 提交', () => {
    // 用户可能有非常规用法（刻意压小观察预警）——拦截会挡掉正当诉求
    assert.equal(parseContextLimitK('1'), 1_000);
    assert.equal(parseContextLimitK('50000'), 50_000_000);
  });
});
