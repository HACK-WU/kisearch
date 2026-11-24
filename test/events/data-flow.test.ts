/**
 * data-flow.test.ts —— 数据链路的归一（2026-11-24 · REQ-20261124-001）
 *
 * 前提同 `conclusion-chain.test.ts`：模型输出是不可信输入。差别在于本字段
 * **换行有语义**，归一绝不能像 `oneLine` 那样把多行压平。
 *
 * 重点覆盖：
 *   1. 非字符串 / 空串 / 全空行 → undefined（调用方删键，不是写 null）
 *   2. 合法内容**原样保留**，行首缩进（树形）一个空格都不能少
 *   3. CRLF 统一为 LF；行尾空白（含全角空格）清理
 *   4. 连续空行压成 1 行、首尾空行去掉
 *   5. 双上限（40 行 / 3000 字）截断 + 提示行；字符截断不切半行
 *   6. **幂等**：对归一结果再归一，结果不变（读盘每次都会跑一遍，不幂等会反复改写）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/data-flow.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_FLOW_MAX_CHARS,
  DATA_FLOW_MAX_LINES,
  DATA_FLOW_TRUNCATED_MARK,
  normalizeDataFlow,
} from '../../src/lib/events/data-flow.js';

const TREE = ['前端打开「链路状态」页 → transfer_latest_msg', '    │', '    ▼', 'table_ids = 全部表的 set（上限无约束）'].join('\n');

describe('数据链路归一 · 非法输入', () => {
  it('非字符串一律 undefined（数字 / 对象 / 数组 / null / undefined / boolean）', () => {
    for (const raw of [123, { a: 1 }, ['a'], null, undefined, true] as unknown[]) {
      assert.equal(normalizeDataFlow(raw), undefined);
    }
  });

  it('空串 / 纯空白 / 纯空行 → undefined', () => {
    for (const raw of ['', '   ', '\n\n\n', ' \n \u3000 \n ']) {
      assert.equal(normalizeDataFlow(raw), undefined, `raw=${JSON.stringify(raw)}`);
    }
  });
});

describe('数据链路归一 · 合法输入原样保留', () => {
  it('多行树结构逐字保留（含行首缩进与箭头）', () => {
    assert.equal(normalizeDataFlow(TREE), TREE);
  });

  it('单行链路也合法（不强制多行）', () => {
    assert.equal(normalizeDataFlow('用户看到「空图」'), '用户看到「空图」');
  });
});

describe('数据链路归一 · 清洗规则', () => {
  it('CRLF / CR 统一为 LF', () => {
    assert.equal(normalizeDataFlow('a\r\n    ▼\r\nb'), 'a\n    ▼\nb');
    assert.equal(normalizeDataFlow('a\rb'), 'a\nb');
  });

  it('行尾空白清零（含全角空格），行首缩进保留', () => {
    assert.equal(normalizeDataFlow('a   \n    b\u3000\u3000\n  c'), 'a\n    b\n  c');
  });

  it('连续空行压成 1 行，首尾空行去掉', () => {
    assert.equal(normalizeDataFlow('\n\na\n\n\n\nb\n\n'), 'a\n\nb');
  });

  it('行首全角空格转半角（保持缩进档位一致），行内全角空格不动', () => {
    assert.equal(normalizeDataFlow('a\n\u3000\u3000b'), 'a\n    b');
    assert.equal(normalizeDataFlow('a\u3000b'), 'a\u3000b');
  });

  it('单行超长（无换行可退）时截到预算内，不产生第二个换行', () => {
    const out = normalizeDataFlow('x'.repeat(5000))!;
    assert.ok(out.length <= DATA_FLOW_MAX_CHARS);
    assert.equal(out.split('\n').length, 2); // 内容一行 + 提示行
  });
});

describe('数据链路归一 · 上限', () => {
  it(`超过 ${DATA_FLOW_MAX_LINES} 行：截到上限并追加提示行`, () => {
    const raw = Array.from({ length: 60 }, (_, i) => `step ${i}`).join('\n');
    const out = normalizeDataFlow(raw)!;
    const lines = out.split('\n');
    assert.equal(lines.length, DATA_FLOW_MAX_LINES + 1);
    assert.equal(lines[DATA_FLOW_MAX_LINES], DATA_FLOW_TRUNCATED_MARK);
    assert.equal(lines[0], 'step 0');
    assert.equal(lines[DATA_FLOW_MAX_LINES - 1], `step ${DATA_FLOW_MAX_LINES - 1}`);
  });

  it(`超过 ${DATA_FLOW_MAX_CHARS} 字：总长不超上限（提示行长度已计入预算）`, () => {
    const line = 'x'.repeat(100);
    const raw = Array.from({ length: 45 }, () => line).join('\n'); // 45×100+44 → 超字符上限但行数也超
    const out = normalizeDataFlow(raw)!;
    assert.ok(out.length <= DATA_FLOW_MAX_CHARS, `实际 ${out.length}`);
    assert.ok(out.endsWith(DATA_FLOW_TRUNCATED_MARK));
  });

  it('字符截断只切在行边界（不产生半行）', () => {
    // 每行 200 字、共 18 行 = 3617 字；字符超限但行数未超
    const rows = Array.from({ length: 18 }, (_, i) => `${i}:`.padEnd(200, 'y'));
    const out = normalizeDataFlow(rows.join('\n'))!;
    const body = out.slice(0, out.length - DATA_FLOW_TRUNCATED_MARK.length - 1);
    for (const l of body.split('\n')) assert.equal(l.length, 200, `出现半行：${l.length}`);
  });

  it('未超限时不加提示行', () => {
    assert.ok(!normalizeDataFlow(TREE)!.includes(DATA_FLOW_TRUNCATED_MARK));
  });
});

describe('数据链路归一 · 幂等', () => {
  it('正常内容二次归一不变', () => {
    const once = normalizeDataFlow(TREE)!;
    assert.equal(normalizeDataFlow(once), once);
  });

  it('行数超限的内容二次归一不变', () => {
    const once = normalizeDataFlow(Array.from({ length: 80 }, (_, i) => `s${i}`).join('\n'))!;
    assert.equal(normalizeDataFlow(once), once);
  });

  it('字符超限的内容二次归一不变（提示行不会把总长再次顶破）', () => {
    const once = normalizeDataFlow(Array.from({ length: 18 }, (_, i) => `${i}:`.padEnd(200, 'y')).join('\n'))!;
    assert.equal(normalizeDataFlow(once), once);
  });

  it('CRLF 内容归一后再次归一是稳定的', () => {
    const once = normalizeDataFlow('a\r\nb\r\nc')!;
    assert.equal(normalizeDataFlow(once), once);
  });
});
