/**
 * 合并页（上传导入 / 手动写入）判据单测 —— REQ-20261116-002 回归锁。
 *
 * 合并后有三条判据互相耦合，任一条写错都会以"用户数据被清掉 / 侧栏不亮 / H1 空"的形式暴露：
 *   1) **tab 由路径决定**：`/import` → 导入、`/write` → 写入，其它路径为 null（不允许兜底成导入）；
 *   2) **清理只在离开合并页后回来时触发**：切 tab（同一页的两个 URL）不清 —— 否则用户在
 *      写入 tab 手写一篇再切回来，导入 tab 的文件选择与预检结果会被静默清空；
 *   3) **侧栏合并项在两条路径上都高亮**（`also`），且 `/import` 不能命中 `/imports` 这类前缀；
 *   4) **进度徽标只在导入 tab 未激活且任务在跑时出现**（激活时右轨已有进度，重复即噪音）。
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
  MERGED_WRITE_LABEL,
  WRITE_TABS,
  WRITE_TAB_LABEL,
  WRITE_TAB_PATH,
  isMergedWritePath,
  navItemActive,
  shouldCleanupOnMergedEntry,
  shouldReconfirmScopeOnImportReturn,
  tabBadgePercentText,
  tabBadgeVisible,
  writeTabFromPath,
} = await vite.ssrLoadModule('/src/lib/writeTabs.ts');
const { ALL_IMPORT_PHASES, isBusyPhase } = await vite.ssrLoadModule('/src/lib/importPhase.ts');
after(async () => vite.close());

describe('writeTabFromPath：tab 由 URL 决定', () => {
  it('两条合并路径各归其 tab', () => {
    assert.equal(writeTabFromPath(WRITE_TAB_PATH.import), 'import');
    assert.equal(writeTabFromPath(WRITE_TAB_PATH.write), 'write');
  });

  it('非合并路径返回 null（不兜底成导入，避免在其它页面渲染 tab 条）', () => {
    for (const pathname of ['/', '/browse', '/search', '/datasource', '/import/x', '/write/x']) {
      assert.equal(writeTabFromPath(pathname), null, pathname);
    }
  });

  it('isMergedWritePath 与 tab 判定同源', () => {
    assert.equal(isMergedWritePath('/import'), true);
    assert.equal(isMergedWritePath('/write'), true);
    assert.equal(isMergedWritePath('/tasks'), false);
  });

  it('tab 数量与路径/文案表一一对应', () => {
    assert.deepEqual([...WRITE_TABS], ['import', 'write']);
    for (const tab of WRITE_TABS) {
      assert.equal(typeof WRITE_TAB_PATH[tab], 'string');
      assert.equal(typeof WRITE_TAB_LABEL[tab], 'string');
    }
    // 页面名与 tab 名必须是两个词：H1 说目的（知识写入），tab 说手段（上传导入 / 手动写入）
    assert.equal(MERGED_WRITE_LABEL, '知识写入');
    assert.notEqual(WRITE_TAB_LABEL.import, MERGED_WRITE_LABEL);
    assert.notEqual(WRITE_TAB_LABEL.write, MERGED_WRITE_LABEL);
  });
});

describe('navItemActive：合并项在两条路径上都要亮', () => {
  const merged = { to: '/import', also: ['/write'] };

  it('/import 与 /write 都算激活', () => {
    assert.equal(navItemActive(merged, '/import'), true);
    assert.equal(navItemActive(merged, '/write'), true);
  });

  it('其它页面不亮', () => {
    assert.equal(navItemActive(merged, '/browse'), false);
    assert.equal(navItemActive(merged, '/'), false);
  });

  it('按分段边界匹配，不吃前缀（/imports 不该点亮 /import）', () => {
    assert.equal(navItemActive(merged, '/imports'), false);
    assert.equal(navItemActive({ to: '/import' }, '/import/history'), true);
    assert.equal(navItemActive({ to: '/import' }, '/imports'), false);
  });

  it('根路径是精确匹配，不会给所有页面点亮「总览」', () => {
    assert.equal(navItemActive({ to: '/', end: true }, '/'), true);
    assert.equal(navItemActive({ to: '/', end: true }, '/browse'), false);
  });

  it('普通项（无 also）行为不变', () => {
    const datasource = { to: '/datasource' };
    assert.equal(navItemActive(datasource, '/datasource'), true);
    assert.equal(navItemActive(datasource, '/datasource/kafka'), true);
    assert.equal(navItemActive(datasource, '/tasks'), false);
  });
});

describe('shouldCleanupOnMergedEntry：只有"从别处回来"才清', () => {
  it('从其它页面回到合并页 → 清理', () => {
    assert.equal(shouldCleanupOnMergedEntry(false, true), true);
  });

  it('合并页内部（tab 之间）跳转 → 不清', () => {
    assert.equal(shouldCleanupOnMergedEntry(true, true), false);
  });

  it('离开合并页 → 不清（清理发生在回来时，离开时就清会让"切走看一眼再回来"也丢结果）', () => {
    assert.equal(shouldCleanupOnMergedEntry(true, false), false);
    assert.equal(shouldCleanupOnMergedEntry(false, false), false);
  });
});

describe('shouldReconfirmScopeOnImportReturn：只在终态重新确认目标', () => {
  it('终态（idle / done / failed / cancelled）需要重新确认', () => {
    for (const phase of ['idle', 'done', 'failed', 'cancelled']) {
      assert.equal(shouldReconfirmScopeOnImportReturn(phase), true, phase);
    }
  });

  it('进行中与待确认态不动（否则页头说"请先确认"、右轨却在跑，自相矛盾）', () => {
    for (const phase of ['scanning', 'uploading', 'awaiting-confirm', 'importing', 'unknown']) {
      assert.equal(shouldReconfirmScopeOnImportReturn(phase), false, phase);
    }
  });

  it('覆盖全部阶段（新增阶段必须显式决定，不允许漏判）', () => {
    for (const phase of ALL_IMPORT_PHASES) {
      assert.equal(
        typeof shouldReconfirmScopeOnImportReturn(phase),
        'boolean',
        `阶段 ${phase} 未被判定`,
      );
    }
  });
});

describe('tabBadgeVisible：徽标只在导入 tab 未激活且任务在跑时出现', () => {
  it('激活导入 tab 时不显示（右轨已有完整进度）', () => {
    for (const phase of ALL_IMPORT_PHASES) {
      assert.equal(tabBadgeVisible('import', phase), false, phase);
    }
  });

  it('在写入 tab / 非合并页时可显示，且与 isBusyPhase 同口径', () => {
    for (const phase of ALL_IMPORT_PHASES) {
      assert.equal(tabBadgeVisible('write', phase), isBusyPhase(phase), phase);
      assert.equal(tabBadgeVisible(null, phase), isBusyPhase(phase), phase);
    }
  });

  it('进度未知时只给脉冲点，不给百分比', () => {
    assert.equal(tabBadgePercentText(null), null);
    assert.equal(tabBadgePercentText(0), '0%');
    assert.equal(tabBadgePercentText(62), '62%');
    assert.equal(tabBadgePercentText(100), '100%');
  });
});
