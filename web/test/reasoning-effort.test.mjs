/**
 * 思考级别纯逻辑单测（REQ-20261016-001 · 设计 §13）
 *
 * 覆盖 `web/src/lib/reasoningEffort.ts`：选项构建（含"脱离清单仍可显示"）、三态派生（未配置 / 空清单 / 脱离清单 / 正常）。
 * 加载方式与 `tool-budget.test.mjs` 一致：vite `ssrLoadModule` 直载 TS 源码。
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

const { EFFORT_FOLLOW_DEFAULT, buildEffortOptions, resolveEffortView } = await vite.ssrLoadModule(
  '/src/lib/reasoningEffort.ts',
);

after(() => vite.close());

describe('思考级别 · 选项构建', () => {
  it('清单前恒定附加「跟随配置默认」，顺序与清单一致', () => {
    const opts = buildEffortOptions(['low', 'high', 'max']);
    assert.equal(opts.length, 4);
    assert.equal(opts[0].value, EFFORT_FOLLOW_DEFAULT);
    assert.deepEqual(opts.slice(1).map((o) => o.value), ['low', 'high', 'max']);
  });

  it('清单未配置 → 只有「跟随配置默认」一项（不伪造档位）', () => {
    assert.deepEqual(buildEffortOptions(undefined).map((o) => o.value), [EFFORT_FOLLOW_DEFAULT]);
  });

  it('当前值脱离清单 → 额外插入该项，避免下拉撒谎成"跟随默认"', () => {
    const opts = buildEffortOptions(['low'], 'max');
    assert.deepEqual(opts.map((o) => o.value), [EFFORT_FOLLOW_DEFAULT, 'low', 'max']);
    assert.match(opts[2].label, /不在清单内/);
  });

  it('当前值在清单内 → 不重复插入', () => {
    const opts = buildEffortOptions(['low', 'high'], 'high');
    assert.deepEqual(opts.map((o) => o.value), [EFFORT_FOLLOW_DEFAULT, 'low', 'high']);
  });

  it('清单若混入保留字（服务端本会拦订阅）→ 前端不重复渲染', () => {
    const opts = buildEffortOptions([EFFORT_FOLLOW_DEFAULT, 'low']);
    assert.deepEqual(opts.map((o) => o.value), [EFFORT_FOLLOW_DEFAULT, 'low']);
  });
});

describe('思考级别 · 三态派生', () => {
  it('清单未配置 → 不可调 + 指向 config.yaml 的指引', () => {
    const v = resolveEffortView({ options: undefined, overridden: false });
    assert.equal(v.editable, false);
    assert.equal(v.badge, '未配置');
    assert.match(v.warn, /llm\.reasoningEfforts/);
  });

  it('显式空清单 → 不可调，且文案与"未配置"不同', () => {
    const unset = resolveEffortView({ options: undefined, overridden: false });
    const empty = resolveEffortView({ options: [], overridden: false });
    assert.equal(empty.editable, false);
    assert.notEqual(empty.warn, unset.warn);
    assert.match(empty.warn, /清单为空/);
  });

  it('脱离清单 → 仍可调 + 明示"仍会按此值发送"', () => {
    const v = resolveEffortView({ options: ['low'], current: 'max', overridden: true });
    assert.equal(v.editable, true);
    assert.equal(v.selectValue, 'max');
    assert.match(v.warn, /仍会按此值发送/);
  });

  it('正常：覆盖值 → 自定义；无覆盖 + 有部署默认档 → "默认 x"；都没有 → 跟随默认', () => {
    const overridden = resolveEffortView({ options: ['low', 'high'], current: 'high', overridden: true });
    assert.equal(overridden.badge, '自定义');
    assert.equal(overridden.warn, null);

    const byDefault = resolveEffortView({ options: ['low', 'high'], def: 'high', current: 'high', overridden: false });
    assert.equal(byDefault.badge, '默认 high');

    const none = resolveEffortView({ options: ['low', 'high'], overridden: false });
    assert.equal(none.badge, '跟随默认');
    assert.equal(none.selectValue, EFFORT_FOLLOW_DEFAULT);
  });
});
