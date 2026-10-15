/**
 * 工具预算纯逻辑单测（REQ-20261015-001）
 *
 * 覆盖 `web/src/lib/toolBudget.ts`：K 字符解析、严格整数解析、越界判定、组合提示。
 * 加载方式与 `context-limit-config.test.mjs` 一致：vite `ssrLoadModule` 直载 TS 源码。
 *
 * 运行：cd web && npm test
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
  budgetComboWarn,
  isHitsInputInvalid,
  isResponseCharsInputInvalid,
  parseKChars,
  parseStrictInt,
} = await vite.ssrLoadModule('/src/lib/toolBudget.ts');

after(async () => { await vite.close(); });

// ─────────────────────────────────────────────────────────────

describe('parseKChars：K 字符 → 字符数', () => {
  it('整数与小数正常换算', () => {
    assert.equal(parseKChars('10'), 10000);
    assert.equal(parseKChars('1'), 1000);
    assert.equal(parseKChars('10.5'), 10500);
    assert.equal(parseKChars('100'), 100000);
  });

  it('空串（含纯空白）→ null（调用方按"未覆盖"处理）', () => {
    assert.equal(parseKChars(''), null);
    assert.equal(parseKChars('   '), null);
  });

  it('非法写法一律 null（不静默取整）', () => {
    for (const bad of ['abc', '1e3', '0x10', '10K', '-5', '+5', '1,000', '.5', '5.', '1 0', 'NaN']) {
      assert.equal(parseKChars(bad), null, `应拒绝：${JSON.stringify(bad)}`);
    }
  });

  it('换算后非整数（如 0.0001 → 0.1 字符）→ null', () => {
    assert.equal(parseKChars('0.0001'), null);
  });
});

describe('parseStrictInt：条数解析', () => {
  it('正整数正常', () => {
    assert.equal(parseStrictInt('5'), 5);
    assert.equal(parseStrictInt('50'), 50);
  });

  it('空串 → null；小数/符号/单位 → null', () => {
    for (const bad of ['', '  ', '5.5', '-1', '1e1', '5 条']) {
      assert.equal(parseStrictInt(bad), null, `应拒绝：${JSON.stringify(bad)}`);
    }
  });
});

describe('isResponseCharsInputInvalid：返回上限越界判定', () => {
  it('空串不算非法（= 未覆盖）', () => {
    assert.equal(isResponseCharsInputInvalid('', 1000, 100000), false);
  });

  it('范围内合法（含边界）', () => {
    assert.equal(isResponseCharsInputInvalid('1', 1000, 100000), false); // 1000 = min
    assert.equal(isResponseCharsInputInvalid('100', 1000, 100000), false); // 100000 = max
  });

  it('越界或非法 → true', () => {
    assert.equal(isResponseCharsInputInvalid('0.5', 1000, 100000), true); // 500 < min
    assert.equal(isResponseCharsInputInvalid('101', 1000, 100000), true); // 101000 > max
    assert.equal(isResponseCharsInputInvalid('abc', 1000, 100000), true);
  });

  it('旧 daemon 未返回 limits（范围缺省）→ 只做格式校验，不拦保存', () => {
    assert.equal(isResponseCharsInputInvalid('10'), false);
    assert.equal(isResponseCharsInputInvalid('99999'), false);
    assert.equal(isResponseCharsInputInvalid('abc'), true);
  });
});

describe('isHitsInputInvalid：条数越界判定', () => {
  it('边界合法（1 / 50），空串不算非法', () => {
    assert.equal(isHitsInputInvalid('', 1, 50), false);
    assert.equal(isHitsInputInvalid('1', 1, 50), false);
    assert.equal(isHitsInputInvalid('50', 1, 50), false);
  });

  it('越界或非法 → true', () => {
    assert.equal(isHitsInputInvalid('0', 1, 50), true);
    assert.equal(isHitsInputInvalid('51', 1, 50), true);
    assert.equal(isHitsInputInvalid('5.5', 1, 50), true);
  });
});

describe('budgetComboWarn：两个旋钮的组合提示', () => {
  it('条数 × 单条约 1.2K > 上限 → 提示（默认上限 10K 时 9 条即触发）', () => {
    assert.equal(budgetComboWarn(9, 10000), true); // 10800 > 10000
    assert.equal(budgetComboWarn(8, 10000), false); // 9600 < 10000
  });

  it('上限调大后不再提示（组合被修正）', () => {
    assert.equal(budgetComboWarn(20, 100000), false);
    assert.equal(budgetComboWarn(30, 10000), true);
  });

  it('任一侧为空/非法（null）→ 不提示', () => {
    assert.equal(budgetComboWarn(null, 10000), false);
    assert.equal(budgetComboWarn(8, null), false);
    assert.equal(budgetComboWarn(null, null), false);
  });

  it('perHit 可覆盖（便于按实际语料校准）', () => {
    assert.equal(budgetComboWarn(5, 10000, 3000), true); // 15000 > 10000
    assert.equal(budgetComboWarn(5, 10000, 1000), false);
  });
});
