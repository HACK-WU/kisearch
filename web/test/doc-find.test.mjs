/**
 * 文档内查找纯逻辑单测（lib/docFind.ts）
 *
 * 锁住四条不变量（REQ-20261014-002 R4 / R8）：
 *   1) 查询词归一化：trim + 200 字符截断（截断必须可被调用方感知，否则「无提示地少搜」）；
 *   2) 环形导航：`上一个` 在首位要回绕到末位（不能返回负数下标）；0 命中一律 0；
 *   3) 计数文案：命中被上限截断时补 `+`；0 命中时不产出 `0/0`（状态由「未找到 x」表达）；
 *   4) 上限常量与需求数字一致（200 / 2000），防止后续被静默调小/调大。
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
  DOC_FIND_QUERY_MAX,
  DOC_FIND_MARK_LIMIT,
  DOC_FIND_SLIDE_TERM_LIMIT,
  DOC_FIND_SEED_MAX,
  buildFindTerms,
  clampFindQuery,
  pickFindSeed,
  stepFindIndex,
  formatFindCount,
  describeFindMiss,
  describeFindLimit,
} = await vite.ssrLoadModule('/src/lib/docFind.ts');
after(async () => vite.close());

describe('clampFindQuery', () => {
  it('trim 首尾空白后原样返回，不标记截断', () => {
    assert.deepEqual(clampFindQuery('  kubectl  '), { value: 'kubectl', truncated: false });
  });

  it('纯空白 → 空值且不标记截断', () => {
    assert.deepEqual(clampFindQuery('   \n\t '), { value: '', truncated: false });
  });

  it('恰好上限长度不截断', () => {
    const exact = 'a'.repeat(DOC_FIND_QUERY_MAX);
    assert.deepEqual(clampFindQuery(exact), { value: exact, truncated: false });
  });

  it('超长截断到上限并标记 truncated', () => {
    const long = 'a'.repeat(DOC_FIND_QUERY_MAX + 1);
    const result = clampFindQuery(long);
    assert.equal(result.value.length, DOC_FIND_QUERY_MAX);
    assert.equal(result.truncated, true);
  });

  it('截断只按长度算，不动内部字符（中文安全）', () => {
    const long = '中'.repeat(DOC_FIND_QUERY_MAX + 5);
    const result = clampFindQuery(long);
    assert.equal(result.value, '中'.repeat(DOC_FIND_QUERY_MAX));
    assert.equal(result.truncated, true);
  });
});

describe('stepFindIndex', () => {
  it('下一个：末位回绕到 0', () => {
    assert.equal(stepFindIndex(4, 5, 1), 0);
  });

  it('上一个：首位回绕到末位（不得出现负下标）', () => {
    assert.equal(stepFindIndex(0, 5, -1), 4);
  });

  it('常规步进', () => {
    assert.equal(stepFindIndex(1, 5, 1), 2);
    assert.equal(stepFindIndex(3, 5, -1), 2);
  });

  it('count=0 → 0（无论方向与当前值）', () => {
    assert.equal(stepFindIndex(3, 0, 1), 0);
    assert.equal(stepFindIndex(3, 0, -1), 0);
  });

  it('非法 current（NaN / 负数 / 越界）先夹取到区间内再步进', () => {
    assert.equal(stepFindIndex(Number.NaN, 3, 1), 1);
    assert.equal(stepFindIndex(-5, 3, 1), 1); // 夹到 0 再 +1
    assert.equal(stepFindIndex(99, 3, 1), 0); // 夹到末位后回绕
  });
});

describe('formatFindCount', () => {
  it('正常计数为「序号/总数」', () => {
    assert.equal(formatFindCount(0, 5, false), '1/5');
    assert.equal(formatFindCount(4, 5, false), '5/5');
  });

  it('命中被上限截断时补 +', () => {
    assert.equal(formatFindCount(0, 2000, true), '1/2000+');
  });

  it('越界序号夹取到区间内', () => {
    assert.equal(formatFindCount(9, 5, false), '5/5');
    assert.equal(formatFindCount(-3, 5, false), '1/5');
  });

  it('0 命中返回空串（不显示 0/0）', () => {
    assert.equal(formatFindCount(0, 0, false), '');
  });
});

describe('文案', () => {
  it('未命中文案回显查询词', () => {
    assert.equal(describeFindMiss('kubectl'), '未找到「kubectl」');
  });

  it('未命中文案对超长查询做省略，避免撑破查找栏', () => {
    const long = 'x'.repeat(60);
    const label = describeFindMiss(long);
    assert.equal(label, `未找到「${'x'.repeat(40)}…」`);
  });

  it('命中上限提示带总数', () => {
    assert.equal(describeFindLimit(2000), '命中过多，仅显示前 2000 处');
  });
});

describe('buildFindTerms（文档内查找专用词表）', () => {
  it('短词原样保留，不做泛词剔除（回归 2026-10-14：ku 搜不到、kub 能搜到）', () => {
    assert.deepEqual(buildFindTerms('ku'), ['ku']);
  });

  it('按空白 / 标点切块，多词并存', () => {
    assert.deepEqual(buildFindTerms('kubectl pod'), ['kubectl', 'pod']);
    assert.deepEqual(buildFindTerms('kubectl, pod'), ['kubectl', 'pod']);
  });

  it('即使与长词混输，短词也不被过滤', () => {
    assert.deepEqual(buildFindTerms('kubectl ku'), ['kubectl', 'ku']);
  });

  it('4 字以内中文块整体保留（不滑窗）', () => {
    assert.deepEqual(buildFindTerms('命名空间'), ['命名空间']);
  });

  it('超过 4 字的中文块：整体 + 2~4 字滑窗兜底', () => {
    const terms = buildFindTerms('什么需要注册中心');
    assert.ok(terms.includes('什么需要注册中心'), `terms=${JSON.stringify(terms)}`);
    assert.ok(terms.includes('注册中'));
    assert.ok(terms.includes('需要注'));
  });

  it('滑窗词数封顶，避免超长中文查询构造出庞大正则', () => {
    const terms = buildFindTerms('中'.repeat(80));
    assert.ok(terms.length <= 1 + DOC_FIND_SLIDE_TERM_LIMIT, `terms=${terms.length}`);
  });

  it('空查询 → 空词表', () => {
    assert.deepEqual(buildFindTerms('   '), []);
  });
});

describe('上限常量（与需求 R8 一致）', () => {
  it('查询 200 字符 / 命中 2000 处', () => {
    assert.equal(DOC_FIND_QUERY_MAX, 200);
    assert.equal(DOC_FIND_MARK_LIMIT, 2000);
  });
});

/**
 * 2026-10-15 新增：Ctrl+F 带入选区（「选中文档内容 → 查找栏带入所选」）。
 * 口径为「只取首个词」—— 整段/多行选区塞进字面查找会命中一大片，失去定位意义。
 */
describe('pickFindSeed（Ctrl+F 带入的选区种子）', () => {
  it('单个词原样返回', () => {
    assert.equal(pickFindSeed('kubectl'), 'kubectl');
  });

  it('多词只取首个空白块', () => {
    assert.equal(pickFindSeed('kubectl get pods'), 'kubectl');
    assert.equal(pickFindSeed('  告警  收敛  '), '告警');
  });

  it('多行选区只取首行（trim 后）', () => {
    assert.equal(pickFindSeed('first line\nsecond line'), 'first');
    assert.equal(pickFindSeed('\n  \n kubectl pods \n'), 'kubectl');
  });

  it('去掉首尾标点，但保留词内部的点号 / 连字符 / 下划线', () => {
    assert.equal(pickFindSeed('kubectl,'), 'kubectl');
    assert.equal(pickFindSeed('「config.yaml」'), 'config.yaml');
    assert.equal(pickFindSeed('ki-search。'), 'ki-search');
    assert.equal(pickFindSeed('a_b'), 'a_b');
  });

  it('中文整句保留（无空白可切，属预期：由 buildFindTerms 滑窗兜底）', () => {
    assert.equal(pickFindSeed('告警收敛策略是什么？'), '告警收敛策略是什么');
  });

  it('超长按码点截断到 DOC_FIND_SEED_MAX', () => {
    const long = 'a'.repeat(DOC_FIND_SEED_MAX + 20);
    assert.equal(pickFindSeed(long), 'a'.repeat(DOC_FIND_SEED_MAX));
    assert.equal(DOC_FIND_SEED_MAX, 40);
  });

  it('码点截断安全：代理对（emoji）不会被切成半个', () => {
    // 首尾用字母，避免触发「首尾标点剥离」这条正交规则
    const raw = `${'a'.repeat(30)}${'🎉'.repeat(20)}b`;
    const seed = pickFindSeed(raw);
    assert.equal([...seed].length, DOC_FIND_SEED_MAX);
    assert.equal(seed, [...raw].slice(0, DOC_FIND_SEED_MAX).join(''));
  });

  it('空 / 纯空白 / 只剩标点 → 空串（调用方走「无选区」分支）', () => {
    assert.equal(pickFindSeed(''), '');
    assert.equal(pickFindSeed('   \n\t '), '');
    assert.equal(pickFindSeed('（）'), '');
  });
});
