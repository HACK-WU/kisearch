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
    assert.ok(css.includes('.gov-ev--running .gov-ev__name { padding-right: 62px; }'), '标题要让位，否则被浮标压字');
    const rule = css.slice(css.indexOf('.gov-ev__running {'), css.indexOf('.gov-ev__running {') + 260);
    assert.ok(rule.includes('position: absolute'), '浮标必须脱离文档流：进 meta 会把阶段挤到第二行');
  });

  it('只对正在跑的行加类，避免其它行布局变化', () => {
    assert.ok(
      page.includes("${runningIds.has(event.id) ? ' gov-ev--running' : ''}"),
      '行类必须按 runningIds 条件添加',
    );
  });
});
