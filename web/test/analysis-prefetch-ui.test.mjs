/**
 * 分析过程区：预取步骤的可读性（2026-11-19 真机反馈）。
 *
 * 三条回归点：
 *  1. **轮次文案只数 round-\*** —— 用 `steps.length + 1` 会把 context / recall 也算成轮次，
 *     预取阶段只有一条 context 时界面显示「第 2 轮探索」，用户以为跳轮了。
 *  2. **「建议先读」清单要渲染出来** —— docs/summary 存在 `step.detail` 里，
 *     只渲染 metrics 的话用户只看得到「建议先读 1」这个数字，不知道建议的是哪篇。
 *  3. **指标 key 要中文化** —— 否则展开明细里是 `docs 1 uncertain 3` 这种英文。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const panel = fs.readFileSync(path.join(webRoot, 'src/components/governance/AiAnalyzePanel.tsx'), 'utf8');
const metrics = fs.readFileSync(path.join(webRoot, 'src/components/governance/StepMetrics.tsx'), 'utf8');
const css = fs.readFileSync(path.join(webRoot, 'src/styles/governance.css'), 'utf8');

describe('分析过程区的预取步骤', () => {
  it('轮次文案只数 round-*，不把 context / recall 算成轮次', () => {
    assert.ok(panel.includes("const roundCount = steps.filter((st) => st.name.startsWith('round-')).length"), '缺少 roundCount 派生');
    assert.ok(panel.includes('第 ${roundCount + 1} 轮探索'), '文案必须用 roundCount');
    assert.equal(panel.includes('第 ${steps.length + 1} 轮探索'), false, '不能再用 steps.length（会显示"第 2 轮"）');
  });

  it('预取的「建议先读」清单与 summary 会渲染（不是只显示数字）', () => {
    assert.ok(panel.includes('step.detail?.docs'), '必须读 detail.docs');
    assert.ok(panel.includes('gov-step-docs__list'), '清单要有列表结构');
    assert.ok(panel.includes('step.detail?.summary'), 'summary 也要展示（0 篇时它是唯一的信息）');
    assert.ok(css.includes('.gov-step-docs__list'), 'CSS 未定义清单样式');
  });

  it('指标 key 中文化：docs / uncertain', () => {
    assert.ok(metrics.includes("docs: '建议先读'"), 'docs 应显示为「建议先读」');
    assert.ok(metrics.includes("uncertain: '待确认'"), 'uncertain 应显示为「待确认」');
  });
});
