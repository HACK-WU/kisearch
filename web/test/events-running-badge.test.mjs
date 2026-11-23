/**
 * 事件列表「分析中」标记（2026-11-19 用户要求）。
 *
 * 结论：
 *  1. 数据源必须是 `/governance/events/running`（后端只读进程内 activeRuns，无磁盘 I/O），
 *     不能靠"刷新整个列表" —— 那会带来滚动位置与请求竞态，而这里只要一个标记。
 *  2. 标记必须**绝对定位在标题行右侧**：真机验过两版都失败 —— 塞进 meta 会把「阶段」
 *     挤到第二行（一行只放得下编号/时间/类型/阶段），行高跟着跳。
 *  3. 轮询要 4s 且页面不可见时跳过、切回立即补一次；失败静默（下一轮重试）。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const page = fs.readFileSync(path.join(webRoot, 'src/pages/EventsPage.tsx'), 'utf8');
const api = fs.readFileSync(path.join(webRoot, 'src/api/governanceApi.ts'), 'utf8');
const css = fs.readFileSync(path.join(webRoot, 'src/styles/governance.css'), 'utf8');

describe('事件列表「分析中」标记', () => {
  it('端点路径与调用方对齐', () => {
    assert.ok(api.includes('/api/governance/events/running'), 'API 路径必须与后端路由一致');
    assert.ok(page.includes('listRunningAnalyses'), '列表页要调用该接口');
  });

  it('4s 轮询 + 页面不可见时跳过 + 失败静默', () => {
    assert.ok(page.includes('}, 4000);'), '轮询间隔应为 4s');
    assert.ok(page.includes('document.hidden'), '页面不可见时应跳过，避免后台空转');
    assert.ok(page.includes("addEventListener('visibilitychange'"), '切回前台要立即补一次');
  });

  it('标记绝对定位在标题行右侧，不挤 meta 行', () => {
    assert.ok(css.includes('.gov-ev--running { position: relative; }'), '需要给行建立定位上下文');
    // 让位宽度与实现同步（浮标文案 4 字时为 76px；改实现记得同步这里）
    assert.ok(css.includes('.gov-ev--running .gov-ev__name { padding-right: 76px; }'), '标题要让位，否则被浮标压字');
    const rule = css.slice(css.indexOf('.gov-ev__running {'), css.indexOf('.gov-ev__running {') + 260);
    assert.ok(rule.includes('position: absolute'), '浮标必须脱离文档流：进 meta 会把阶段挤到第二行');
  });

  it('只对正在跑 / 刚结束的行加类，避免其它行布局变化', () => {
    assert.ok(
      page.includes("runningIds.has(event.id) || askingIds.has(event.id) || finishedRuns[event.id] || finishedAsks[event.id] ? ' gov-ev--running' : ''"),
      '行类必须按 runningIds / askingIds / finished* 条件添加',
    );
  });
});

describe('事件列表「追问中 / 追问完成」标记（2026-11-23）', () => {
  it('与「分析中」共用一次 /events/running 轮询（asking / finishedAsks）', () => {
    assert.ok(page.includes('res.asking'), '追问中清单来自同一次轮询');
    assert.ok(page.includes('res.finishedAsks'), '追问结束态来自同一次轮询');
    assert.ok(api.includes('asking?: string[]'), '接口类型要声明 asking');
    assert.ok(api.includes('finishedAsks?: FinishedAskView[]'), '接口类型要声明 finishedAsks');
  });

  it('浮标同槽位互斥：追问中 先于 分析中 判定', () => {
    assert.ok(
      page.indexOf('askingIds.has(event.id) ? (') >= 0
        && page.indexOf('askingIds.has(event.id) ? (') < page.indexOf('runningIds.has(event.id) ? ('),
      '同一行只会有一个「进行中」浮标，追问中必须先判',
    );
  });

  it('文案：追问中 / 追问完成 / 追问失败', () => {
    assert.ok(page.includes('追问中'));
    assert.ok(page.includes('追问完成'));
    assert.ok(page.includes('追问失败'));
  });

  it('已读按 turnId 记，且与分析已读分开存（同 eventId 不互相覆盖）', () => {
    assert.ok(page.includes("const SEEN_ASK_KEY = 'ki-web:events:seen-ask';"));
    assert.ok(page.includes('activeAskSeenKey'), '点开事件即记为已读');
    assert.ok(page.includes("`failed:${activeAskDone.at}`"), '失败没有 turnId，用结束时间当已读键');
  });
});
