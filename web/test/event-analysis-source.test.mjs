/**
 * event-analysis-source.test.mjs —— 分析卡「来源」相关源码守卫（REQ-20261123-009 · S-03）
 *
 * 为什么用源码守卫而不是渲染测试：本仓 web 侧没有 jsdom 渲染栈（既有 .mjs 测试都是
 * 静态断言或纯函数单测），而这几处改动全是「分支存在性 + 兜底是否到位」，
 * 静态守卫足以防回退（渲染效果由真机走查兜底）。
 *
 * 运行：cd web && node --test test/event-analysis-source.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const card = () => read('src/components/governance/event-detail/EventAnalysisCard.tsx');
const panel = () => read('src/components/governance/AiAnalyzePanel.tsx');
const css = () => read('src/styles/governance.css');

test('卡头来源行：外部显示上传时间与来源，AI 显示更新 / 修订时间', () => {
  const src = card();
  assert.ok(src.includes('gov-dcard__source'), '缺少来源行容器');
  assert.ok(src.includes("draft.sourceClient && draft.sourceClient !== 'mcp'"), '外部来源要回显客户端名（缺省 MCP）');
  assert.ok(src.includes('fmtStamp(draft.importedAt)'), '外部要显示上传时间');
  // 第二轮优化：AI 侧区分「完成于」与「修订于」，不再用 editedAt ?? updatedAt 混说
  assert.ok(src.includes('来源 AI 在线分析 · 修订于 ${fmtStamp(draft.editedAt)}'), 'AI 修订后只说修订时间');
  assert.ok(src.includes('来源 AI 在线分析 · 完成于 ${fmtStamp(draft.updatedAt)}'), 'AI 未修订时显示完成时间');
});

test('chip：外部来源前置，但不掩盖 failed，并回显本版确认数', () => {
  const src = card();
  assert.ok(
    src.includes("draft?.source === 'external' && draft.status !== 'failed'"),
    '外部 chip 必须排在其它状态之前，且让位给 failed',
  );
  assert.ok(src.includes('外部上传'), '外部 chip 文案存在');
  // 走查 #4：确认后要有反馈，且只数本版（confirmedAt >= startedAt）的位置
  assert.ok(src.includes('c.confirmedAt >= draft.startedAt'), '只数本版已确认位置');
  assert.ok(src.includes('已确认 ${fresh} 处'), '确认数要回显到 chip');
});

test('兜底：candidates / unconfirmed / stats 缺失不崩', () => {
  const src = card();
  assert.ok(src.includes('const cands = draft?.candidates ?? []'), 'candidates 必须兜底');
  assert.ok(src.includes('const unconfirmed = draft?.unconfirmed ?? []'), 'unconfirmed 必须兜底');
  assert.equal(src.includes('draft.unconfirmed.length'), false, '不得再直接读 draft.unconfirmed.length');

  const p = panel();
  assert.ok(p.includes('draft?.stats?.ms'), 'stats.ms 必须双层可选链');
  assert.ok(p.includes('draft.stats?.turns ?? 0'), '底栏轮次必须兜底');
  assert.ok(p.includes('draft?.unconfirmed?.length'), '未确认点计数必须兜底');
});

test('过程区：外部来源改文案并隐藏轮次统计', () => {
  const p = panel();
  assert.ok(p.includes("const isExternal = draft?.source === 'external'"));
  assert.ok(p.includes("'外部上传 · 无分析过程'"), '外部 procTitle 必须是「无分析过程」');
  assert.ok(p.includes("'无分析过程'"), '过程区右上角不能再显示 N 步 / 调用次数');
  // 第二轮优化：底栏不再重复「无分析过程」（过程区标题已说），改报确认数
  assert.ok(p.includes('`外部上传${confirmed.length'), '底栏换外部口径：有确认报确认，无确认才说无过程');
});

test('重跑弹窗：外部来源单独文案与按钮', () => {
  const p = panel();
  assert.ok(p.includes('当前结论由外部上传（MCP）：重新分析会整份覆盖且不可恢复'));
  assert.ok(p.includes("'覆盖外部结论并重新分析'"));
});

test('已确认位置：跨版本提示按 confirmedAt < startedAt 判定', () => {
  const src = card();
  assert.ok(src.includes('c.confirmedAt < draft.startedAt'), '跨版本判据必须是 confirmedAt < startedAt');
  assert.ok(src.includes('处来自上一版结论'));
});

test('样式：外部 chip / 来源行 / 跨版本说明都有定义', () => {
  const c = css();
  assert.ok(c.includes('.gov-dchip--ext'), '缺少外部 chip 样式');
  assert.ok(c.includes('.gov-dcard__source'), '缺少来源行样式');
  assert.ok(c.includes('.gov-confirmed__note'), '缺少跨版本说明样式');
});

test('走查 #1：详情按「版本 + 确认数」签名变化自动刷新', () => {
  const page = read('src/pages/EventsPage.tsx');
  assert.ok(page.includes('detailSigRef'), '缺少详情新鲜度基线');
  assert.ok(page.includes('getEventAnalysis(scope, activeId)'), '轮询要拉分析产物，不能只拉 running 标记');
  assert.ok(page.includes('nextSig !== detailSigRef.current'), '只在签名变化时整条刷新');
  // 第二轮优化：人工确认不换 runId，签名必须含已确认数
  assert.ok(page.includes('sigOf'), '签名要含 runId 与已确认位置数');
});

test('走查 #2：外部结论补列表标记，前端按 ext_ 前缀区分文案', () => {
  const runner = read('../src/lib/events/analysis-runner.ts');
  assert.ok(runner.includes('export function markExternalConclusionReady'), '后端要能补 finished 标记');
  const tool = read('../src/lib/mcp-tools/event-edit.ts');
  assert.ok(tool.includes('markExternalConclusionReady('), '上传成功后要写这条标记');
  const page = read('src/pages/EventsPage.tsx');
  assert.ok(page.includes("done.runId.startsWith('ext_')"), '列表文案要按来源分档');
  assert.ok(page.includes('外部分结论') === false && page.includes('外部结论'), '外部来源的行内文案');
});

test('走查 #6：analysis 必须用解析后的事件 id（否则写成 `#5.analysis.json`）', () => {
  const tool = read('../src/lib/mcp-tools/event-edit.ts');
  assert.ok(
    tool.includes('saveExternalAnalysis(args.scope, detail.event.id,'),
    '必须传 detail.event.id：存储层把 eventId 当文件名，传 `#5` 会写出前端读不到的文件',
  );
  assert.equal(
    tool.includes('saveExternalAnalysis(args.scope, args.event,'),
    false,
    '不能把引用串当 eventId 传下去',
  );
});

test('走查 #3/#5：外部来源显示修订时间，「已修订」并入 chip', () => {
  const src = card();
  assert.ok(src.includes('修订于 ${fmtStamp(draft.editedAt)}'), '外部来源要追加修订时间');
  // 第二轮优化：外部修订并入 chip，不再并排两个标签
  assert.ok(src.includes("text: '外部上传 · 已修订'"), '外部修订并入 chip');
  assert.ok(src.includes('edited && !isExternal'), '只有 AI 来源才渲染独立「已人工修订」徽标');
});
