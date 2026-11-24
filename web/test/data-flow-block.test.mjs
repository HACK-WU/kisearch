/**
 * data-flow-block.test.mjs —— 数据链路块的结构守卫（2026-11-24 · REQ-20261124-001 · SR-04a）
 *
 * 本仓 web 侧没有 jsdom 渲染栈（见 `event-analysis-source.test.mjs` 的说明），
 * 渲染效果由真机走查兜底；这里只守**会静默坏掉的结构**：
 *   1. 组件不再用 `dangerouslySetInnerHTML`（模型输出走 HTML = 注入面）
 *   2. 三处挂载点都在（少一处就出现"卡片有、面板没有"）
 *   3. 链路段在 DOM 顺序上位于「未确认点」之前、且不在 `.gov-conclusion` 之内（已拍板 U2）
 *   4. 树的关键样式不被改成折行 / 去掉横向滚动
 *
 * 运行：cd web && node --test test/data-flow-block.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * 去掉注释后再做"禁止出现"类断言：组件头部的注释**故意**写明了
 * 「绝不 dangerouslySetInnerHTML」——按原文匹配会把这条说明本身判成违规。
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('数据链路块 · 组件守卫', () => {
  const src = read('src/components/governance/event-detail/DataFlowBlock.tsx');

  it('导出 DataFlowBlock，且 props 接受 dataFlow / source', () => {
    assert.match(src, /export function DataFlowBlock\(/);
    assert.match(src, /dataFlow\?: string \| null/);
    assert.match(src, /source\?: 'ai' \| 'external'/);
  });

  it('文本只作为 React 文本节点渲染（禁止 dangerouslySetInnerHTML）', () => {
    const code = stripComments(src);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/);
    assert.match(code, /<pre className="gov-datalink__tree">\{/);
  });

  it('三态：外部上传无链路给占位，其余无值返回 null', () => {
    assert.match(src, /if \(source !== 'external'\) return null;/);
    assert.match(src, /gov-datalink is-empty/);
    assert.match(src, /外部上传未提供链路/);
  });

  it('溢出探测：ResizeObserver + data-overflow，且无 ResizeObserver 时降级不抛', () => {
    assert.match(src, /new ResizeObserver/);
    assert.match(src, /typeof ResizeObserver === 'undefined'/);
    assert.match(src, /data-overflow=/);
  });

  it('步数不把纯箭头 / 竖轨行算进去', () => {
    assert.match(src, /RAIL_ONLY/);
    assert.match(src, /!RAIL_ONLY\.test\(line\)/);
  });

  it('不用 trim() 处理正文（会吃掉首行缩进，破坏树形）', () => {
    assert.doesNotMatch(src, /dataFlow\.trim\(\)/);
    assert.match(src, /text\.trim\(\) !== ''/);
  });
});

describe('数据链路块 · 挂载点守卫', () => {
  it('结论卡：两处挂载（编辑态只读块 + 卡片态），且卡片态在「未确认点」之前', () => {
    const card = read('src/components/governance/event-detail/EventAnalysisCard.tsx');
    assert.equal((card.match(/<DataFlowBlock /g) ?? []).length, 2, '应有编辑态 + 卡片态两处');
    const flowIdx = card.lastIndexOf('<DataFlowBlock ');
    const unconfirmedIdx = card.indexOf('className="gov-unconfirmed"');
    assert.ok(flowIdx > 0 && unconfirmedIdx > flowIdx, '链路块必须在未确认点之前');
    // 不得嵌回紫色结论壳：DataFlowBlock 不能出现在 ConclusionChain 的 props 里
    assert.doesNotMatch(card, /<ConclusionChain[\s\S]{0,400}<DataFlowBlock/);
  });

  it('分析面板：一处挂载、运行中不占位、且传 nested（过程区已有纵向滚动）', () => {
    const panel = read('src/components/governance/AiAnalyzePanel.tsx');
    assert.equal((panel.match(/<DataFlowBlock /g) ?? []).length, 1);
    assert.match(panel, /\{!isRunning \? <DataFlowBlock [^>]*nested \/>/);
  });
});

describe('数据链路块 · 样式守卫', () => {
  const css = read('src/styles/governance.css');

  it('有 .gov-datalink 全族，且与未确认点同一套语法（浅底 + 左 3px 竖条 + 纯文字标题）', () => {
    assert.match(css, /\.gov-datalink \{/);
    assert.match(css, /\.gov-datalink__head \{/);
    assert.match(css, /\.gov-datalink__title \{/);
    assert.match(css, /\.gov-datalink__copy \{/);
    assert.match(css, /border-left: 3px solid color-mix\(in srgb, var\(--ki-color-purple\)/);
  });

  it('树禁折行 + 横向滚动 + 纵向 520 上限（否则 8 步树会裁掉最后一跳）', () => {
    assert.match(css, /\.gov-datalink__scroll \{ overflow-x: auto; overflow-y: auto; max-height: 520px; \}/);
    assert.match(css, /\.gov-datalink__tree \{[\s\S]*?white-space: pre;/);
    assert.doesNotMatch(css, /\.gov-datalink__tree \{[\s\S]{0,200}word-break/);
  });

  it('溢出提示只在 data-overflow 时出现', () => {
    assert.match(css, /\.gov-datalink\[data-overflow\] \.gov-datalink__meta::after \{[\s\S]*?可横滑/);
  });
});
