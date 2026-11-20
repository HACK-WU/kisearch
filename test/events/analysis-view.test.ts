/**
 * analysis-view.test.ts —— 分析视角与「按视角生成输出规范」（REQ-20261120-002 · 2026-11-20）
 *
 * 覆盖四件容易写错的：
 *   1. 视角推断：内置按 **id** 映射、自建落 generic、**缺 typeId 回退 fault**（不改变历史行为）；
 *   2. 视角表自身合法：skeleton 只含合法 kind、强调点必须在骨架内、词表缺项能兜底；
 *   3. 输出规范按视角换词，但**三条证据门槛逐字不动**（放宽它们＝结论退化成猜测）；
 *   4. 追问上下文（chainToLines）的措辞与卡面同源，不残留「根本原因」。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-view.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYSIS_VIEWS,
  BASE_KIND_LABELS,
  inferAnalysisView,
  resolveKindLabel,
  viewProfile,
  type AnalysisView,
} from '../../src/lib/events/analysis-view.js';
import { buildOutputTail } from '../../src/lib/events/analysis-runner.js';
import { CONCLUSION_KINDS, chainToLines } from '../../src/lib/events/conclusion-chain.js';

describe('视角推断', () => {
  it('内置类型按 id 映射到三个视角', () => {
    assert.equal(inferAnalysisView('et_1'), 'fault');
    assert.equal(inferAnalysisView('et_2'), 'perf');
    assert.equal(inferAnalysisView('et_3'), 'change');
  });

  it('自建 / 已删类型落 generic（不假装知道它的语义）', () => {
    assert.equal(inferAnalysisView('et_9'), 'generic');
    assert.equal(inferAnalysisView('et_1_deleted'), 'generic');
  });

  it('缺 typeId 回退 fault —— 历史调用点与旧数据行为不变', () => {
    assert.equal(inferAnalysisView(undefined), 'fault');
    assert.equal(inferAnalysisView(null), 'fault');
    assert.equal(inferAnalysisView(''), 'fault');
  });
});

describe('视角表完整性', () => {
  it('四个视角都在表内', () => {
    assert.deepEqual([...ANALYSIS_VIEWS].sort(), ['change', 'fault', 'generic', 'perf']);
  });

  it('skeleton 非空且只含合法 kind', () => {
    for (const view of ANALYSIS_VIEWS) {
      const p = viewProfile(view);
      assert.ok(p.skeleton.length >= 2, `${view} skeleton 太短`);
      for (const kind of p.skeleton) {
        assert.ok(
          (CONCLUSION_KINDS as readonly string[]).includes(kind),
          `${view} 的 skeleton 含非法 kind: ${kind}`,
        );
      }
    }
  });

  it('强调点要么为 null，要么必须在自己的骨架里', () => {
    for (const view of ANALYSIS_VIEWS) {
      const p = viewProfile(view);
      if (p.emphasize === null) {
        assert.equal(p.flag, '', `${view} 不强调却给了清标文案`);
        continue;
      }
      assert.ok(p.skeleton.includes(p.emphasize), `${view} 强调了骨架外的节点 ${p.emphasize}`);
      assert.ok(p.flag.length > 0, `${view} 强调点缺清标文案`);
    }
  });

  it('词表缺项回退中性词（模型给出骨架外的 kind 仍可读）', () => {
    assert.equal(resolveKindLabel('change', 'root'), BASE_KIND_LABELS.root);
    assert.equal(resolveKindLabel('generic', 'root'), BASE_KIND_LABELS.root);
    assert.equal(resolveKindLabel('perf', 'cause'), '瓶颈点');
    assert.equal(resolveKindLabel('change', 'symptom'), '现状与目标差距');
  });

  it('非因果视角不设轨道，因果视角都有轨道', () => {
    assert.equal(viewProfile('fault').rail, true);
    assert.equal(viewProfile('perf').rail, true);
    assert.equal(viewProfile('change').rail, false);
    assert.equal(viewProfile('generic').rail, false);
  });
});

describe('输出规范按视角生成', () => {
  const views: AnalysisView[] = [...ANALYSIS_VIEWS];

  it('每个视角都写进自己的词表关键词', () => {
    assert.match(buildOutputTail('fault'), /根本原因/);
    assert.match(buildOutputTail('perf'), /瓶颈点/);
    assert.match(buildOutputTail('change'), /差距与成因/);
    assert.match(buildOutputTail('generic'), /关键发现/);
  });

  it('三条证据门槛逐字保留（空 candidates / confidence 口径 / 反引号路径）', () => {
    for (const view of views) {
      const tail = buildOutputTail(view);
      assert.ok(tail.includes('**candidates 允许为空数组**'), `${view} 丢了空 candidates 口径`);
      assert.ok(tail.includes('0.5 以下一律不要写进 candidates'), `${view} 丢了 confidence 口径`);
      assert.ok(tail.includes('一律用反引号包住**相对路径**'), `${view} 丢了反引号路径口径`);
    }
  });

  it('声明本节为格式唯一权威（压住旧配置里残留的固定顺序句）', () => {
    for (const view of views) {
      assert.match(buildOutputTail(view), /本节是输出格式的唯一权威/);
    }
  });

  it('非因果视角显式禁止编造现象 / 根因；因果视角不加这句', () => {
    assert.match(buildOutputTail('change'), /不要为了凑骨架编造/);
    assert.match(buildOutputTail('generic'), /不要为了凑骨架编造/);
    assert.ok(!buildOutputTail('fault').includes('不要为了凑骨架编造'));
    assert.ok(!buildOutputTail('perf').includes('不要为了凑骨架编造'));
  });

  it('骨架顺序与视角一致：change/generic 的固定顺序里没有 root', () => {
    for (const view of ['change', 'generic'] as AnalysisView[]) {
      const orderLine = buildOutputTail(view).split('\n').find((l) => l.includes('顺序固定为')) ?? '';
      assert.ok(orderLine.includes('symptom'), `${view} 缺少 symptom`);
      assert.ok(!orderLine.includes('root（'), `${view} 的顺序里不该出现 root`);
    }
    const faultOrder = buildOutputTail('fault').split('\n').find((l) => l.includes('顺序固定为')) ?? '';
    assert.ok(faultOrder.includes('root（根本原因）'));
  });

  it('节点数上限随骨架：change 是 2~4，fault 是 2~5', () => {
    assert.match(buildOutputTail('change'), /2~4 个节点/);
    assert.match(buildOutputTail('fault'), /2~5 个节点/);
  });
});

describe('追问上下文措辞与卡面同源', () => {
  const chain = [
    { kind: 'symptom' as const, text: '列表只能按时间排' },
    { kind: 'cause' as const, text: '排序逻辑分散在两端' },
    { kind: 'root' as const, text: '没有排序契约' },
    { kind: 'fix' as const, text: '字段入库 + 排序下沉' },
  ];

  it('缺省仍是原模板（fault），不改变既有调用', () => {
    assert.deepEqual(chainToLines(chain)[2], '- 根本原因：没有排序契约');
  });

  it('change 视角换成需求语义', () => {
    const lines = chainToLines(chain, 'change');
    assert.equal(lines[0], '- 现状与目标差距：列表只能按时间排');
    assert.equal(lines[1], '- 差距与成因：排序逻辑分散在两端');
    assert.equal(lines[3], '- 实施建议：字段入库 + 排序下沉');
  });

  it('骨架外的 kind（change 视角的 root）回退中性词，不丢节点', () => {
    assert.equal(chainToLines(chain, 'change')[2], '- 根本原因：没有排序契约');
  });

  it('ref 与 branches 的格式不受视角影响', () => {
    const withRef = [{ kind: 'cause' as const, text: 'x', ref: 'src/a.ts:12', branches: ['条件 A'] }];
    assert.equal(chainToLines(withRef, 'perf')[0], '- 瓶颈点：x（src/a.ts:12）；分支：条件 A');
  });
});
