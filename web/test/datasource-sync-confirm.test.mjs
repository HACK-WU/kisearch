/**
 * 数据源页「同步」二次确认（2026-11-09 用户要求）。
 *
 * 结论：
 *  1. 行内「同步」只**打开确认框**，不直接发请求；真正发请求的唯一入口是弹窗里的「开始同步」。
 *  2. 三条关闭路径（取消 / ✕ / Esc / 点遮罩）都**不发请求**。
 *  3. 默认焦点在「取消」——Enter 不该把同步发出去。
 *  4. 弹窗是普通模态（role=dialog + aria-modal），不是 danger 语气（同步不是破坏性操作）。
 *
 * 为什么守这些：同步按钮是行内高频入口，误点会白跑一次全目录扫描（大仓库数分钟）并挤占任务队列；
 * 一旦有人为了"少一次点击"把 onClick 改回 `triggerSync`，本条契约就悄悄失效。
 *
 * 源码守卫：页面无剥离即可测的纯逻辑，按字符串守契约。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const page = fs.readFileSync(path.join(webRoot, 'src/pages/DataSourcePage.tsx'), 'utf8');

/** 同步确认弹窗的渲染分支（到该分支的 `) : null}` 为止） */
function syncDialogBlock() {
  const start = page.indexOf('{syncTarget && syncTargetView ? (');
  assert.ok(start > 0, '未找到同步确认弹窗的渲染分支');
  const end = page.indexOf(') : null}', start);
  assert.ok(end > start, '未找到同步确认弹窗的结束位置');
  return page.slice(start, end);
}

describe('数据源「同步」二次确认', () => {
  it('行内「同步」只打开确认框，不直接发请求', () => {
    const btn = page.indexOf('data-ds-sync=');
    assert.ok(btn > 0, '行内同步按钮应带 data-ds-sync（焦点归还依赖它）');
    const onClick = page.indexOf('onClick', btn);
    assert.ok(onClick > btn, '未找到同步按钮的 onClick');
    const handler = page.slice(onClick, onClick + 320);
    assert.match(handler, /openSyncConfirm\(source, event\.currentTarget\)/, '按钮应打开确认框');
    assert.doesNotMatch(handler, /triggerSync/, '按钮不得直接触发同步');
  });

  it('唯一发请求的入口是弹窗里的「开始同步」', () => {
    const block = syncDialogBlock();
    assert.match(block, /submitSyncConfirm/, '主按钮应调 submitSyncConfirm');
    assert.doesNotMatch(block, /triggerSync\(/, '弹窗 JSX 内不得直接调 triggerSync');
    // 反过来守 submitSyncConfirm 确实调了 triggerSync（否则按钮点了不干活）
    const fnStart = page.indexOf('const submitSyncConfirm');
    assert.ok(fnStart > 0, '未找到 submitSyncConfirm 实现');
    assert.match(page.slice(fnStart, fnStart + 700), /await triggerSync\(target\.scope\)/);
  });

  it('默认焦点落在「取消」，Enter 不误发', () => {
    assert.match(syncDialogBlock(), /ref=\{syncCancelRef\}/, '取消按钮应挂 syncCancelRef');
    assert.match(page, /syncCancelRef\.current\?\.focus\(\)/, '打开时应聚焦取消按钮');
  });

  it('取消 / ✕ / 点遮罩 三条关闭路径都走 closeSyncConfirm（不发请求）', () => {
    const block = syncDialogBlock();
    assert.match(block, /if \(event\.target === event\.currentTarget\) closeSyncConfirm\(\);/, '点遮罩应关闭');
    assert.match(block, /aria-label="关闭同步确认"/, '应有 ✕ 关闭按钮');
    assert.match(block, /disabled=\{syncSubmitting\}[\s\S]{0,80}onClick=\{closeSyncConfirm\}/, '✕ / 取消应调 closeSyncConfirm');
    const fnStart = page.indexOf('const closeSyncConfirm');
    assert.ok(fnStart > 0, '未找到 closeSyncConfirm 实现');
    // 只取函数体（到该函数自己的 `  };` 为止），避免把后面 submitSyncConfirm 的注释算进来
    const body = page.slice(fnStart, page.indexOf('\n  };', fnStart) + 4);
    assert.doesNotMatch(body, /triggerSync|syncDataSource/, '关闭时不得发请求');
  });

  it('Esc 关闭（提交中不响应）', () => {
    assert.match(
      page,
      /if \(event\.key !== 'Escape' \|\| syncSubmitting\) return;[\s\S]{0,60}setSyncTarget\(null\);/,
      'Esc 应关闭确认框，提交中忽略',
    );
  });

  it('同步方式按真实模式推导（目录源不得写死「增量」）', () => {
    const block = syncDialogBlock();
    assert.doesNotMatch(
      block,
      /<dd>\s*增量（只处理有变化的文件）\s*<\/dd>/,
      '弹框不得硬编码「增量」——目录源实际走全量重扫（后端 datasourceSyncMode）',
    );
    assert.match(block, /syncTargetView\.mode/, '同步方式应取推导值');
    assert.match(
      page,
      /syncTarget\.type === 'git' && Boolean\(syncTarget\.git\?\.shortCommit\)/,
      '推导依据应与后端 datasourceSyncMode 同口径：Git 源且上次同步过才是增量',
    );
    assert.match(page, /全量（重新扫描全部文件）/, '非增量场景要明示全量');
  });

  it('弹窗是普通模态：role=dialog + aria-modal，按钮不用 danger', () => {
    const block = syncDialogBlock();
    assert.match(block, /role="dialog"/);
    assert.match(block, /aria-modal="true"/);
    assert.doesNotMatch(block, /ki-btn--danger/, '同步不是破坏性操作，主按钮不应是 danger');
    assert.match(block, /ki-btn--primary/, '主按钮应为 primary');
  });

  it('提交中双按钮都禁用（防连点重复提交）', () => {
    const block = syncDialogBlock();
    const disabled = block.match(/disabled=\{syncSubmitting\}/g) ?? [];
    assert.ok(disabled.length >= 3, '取消 / 开始同步 / ✕ 都应在提交中禁用');
  });

  it('打开弹窗时不关详情抽屉（Esc 不应关两层）', () => {
    assert.match(
      page,
      /if \(!scope \|\| addOpen \|\| docTarget \|\| removeTarget \|\| syncTarget\) return undefined;/,
      '抽屉的 Esc 关闭应把 syncTarget 一并排除',
    );
  });
});
