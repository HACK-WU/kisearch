/**
 * 「文档内高亮」决策单测（lib/searchHighlight.ts，REQ-20261014-003 R1–R6）
 *
 * 锁住三条口径（这是本需求最容易做错的地方）：
 *   1) **降级不影响开关**（Q2 裁决）：`resultMode === 'hybrid'` 时开关照常生效，
 *      不因 `degraded` 而恒开；降级只改变**列表**高亮（= 全文待遇，Q1）；
 *   2) **开关只在混合结果下可用**：全文与未检索（`null`）一律禁用；
 *   3) **自动滚动只在全文**（Q8）：混合与降级打开文档都不跳转。
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
const { decideDocHighlight } = await vite.ssrLoadModule('/src/lib/searchHighlight.ts');
after(async () => vite.close());

/** 便捷构造：默认开关开、查询词固定 */
const decide = (over = {}) =>
  decideDocHighlight({ resultMode: 'hybrid', degraded: false, switchOn: true, query: 'kubectl', ...over });

describe('decideDocHighlight / 混合（未降级）', () => {
  it('开关开：列表不高亮、文档高亮、不滚动、开关可用', () => {
    assert.deepEqual(decide(), {
      listHighlight: false,
      docHighlightQuery: 'kubectl',
      switchDisabled: false,
      autoScroll: false,
    });
  });

  it('开关关：列表仍不高亮、文档**不**高亮、不滚动、开关可用', () => {
    assert.deepEqual(decide({ switchOn: false }), {
      listHighlight: false,
      docHighlightQuery: undefined,
      switchDisabled: false,
      autoScroll: false,
    });
  });
});

describe('decideDocHighlight / 降级（混合 + 向量失败）', () => {
  it('开关开：列表高亮（全文待遇）、文档高亮、不滚动', () => {
    assert.deepEqual(decide({ degraded: true }), {
      listHighlight: true,
      docHighlightQuery: 'kubectl',
      switchDisabled: false,
      autoScroll: false,
    });
  });

  it('开关关：列表仍高亮、文档**不**高亮（降级不改变开关语义）', () => {
    assert.deepEqual(decide({ degraded: true, switchOn: false }), {
      listHighlight: true,
      docHighlightQuery: undefined,
      switchDisabled: false,
      autoScroll: false,
    });
  });
});

describe('decideDocHighlight / 全文', () => {
  it('开关关也恒高亮与滚动（开关对全文无效）', () => {
    assert.deepEqual(decide({ resultMode: 'fulltext', switchOn: false }), {
      listHighlight: true,
      docHighlightQuery: 'kubectl',
      switchDisabled: true,
      autoScroll: true,
    });
  });

  it('降级标记残留时仍按全文处理（判据以 resultMode 为准）', () => {
    assert.deepEqual(decide({ resultMode: 'fulltext', degraded: true }), {
      listHighlight: true,
      docHighlightQuery: 'kubectl',
      switchDisabled: true,
      autoScroll: true,
    });
  });
});

describe('decideDocHighlight / 未检索与边界', () => {
  it('未检索（resultMode=null）：不高亮、不滚动，但**开关仍可用**（偏好应随时可设）', () => {
    assert.deepEqual(decide({ resultMode: null, query: '' }), {
      listHighlight: false,
      docHighlightQuery: undefined,
      switchDisabled: false,
      autoScroll: false,
    });
  });

  it('开关禁用只发生在「当前结果是全文」——其余组合都可用', () => {
    // 2026-10-14 用户实测反馈：刚进页面（未检索）开关是灰的 ⇒ 关不了。此用例锁死回归。
    const disabledCases = [
      { resultMode: 'fulltext', degraded: false, switchOn: true },
      { resultMode: 'fulltext', degraded: true, switchOn: false },
    ];
    for (const c of disabledCases) {
      assert.equal(decide(c).switchDisabled, true, `应禁用：${JSON.stringify(c)}`);
    }
    const enabledCases = [
      { resultMode: 'hybrid', degraded: false, switchOn: true },
      { resultMode: 'hybrid', degraded: true, switchOn: true },
      { resultMode: null, degraded: false, switchOn: true },
      { resultMode: null, degraded: true, switchOn: false },
    ];
    for (const c of enabledCases) {
      assert.equal(decide(c).switchDisabled, false, `不应禁用：${JSON.stringify(c)}`);
    }
  });

  it('空查询词：即使想高亮也不传空串（避免查看器把空词当命中词）', () => {
    assert.equal(decide({ query: '' }).docHighlightQuery, undefined);
    assert.equal(decide({ resultMode: 'fulltext', query: '' }).docHighlightQuery, undefined);
  });
});
