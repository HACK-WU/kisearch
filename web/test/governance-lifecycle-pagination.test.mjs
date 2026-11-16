/**
 * governance-lifecycle-pagination.test.mjs —— 分类页文档列表分页（REQ-20261116-001）
 *
 * 锁住三件事：
 *   1) 页码折叠算法（src/lib/pager.ts）：首页 / 次页 / 末页前一页 / 末页恒在，
 *      当前页 ±1 恒在，其余折叠成 … —— 任务页与分类页共用同一份实现；
 *   2) 分类页的分页结构：只渲染当前页、`total` 必须被保存（否则截断变成静默）、
 *      筛选 / 搜索 / 排序三个入口都要回第 1 页；
 *   3) 「全选」作用域是当前页，跨页已选不得被表头一键清掉。
 *
 * 交互与观感靠真机走查，这里只挡会被「顺手清理」掉的结构性约定。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
after(async () => { await vite.close(); });

const { pageNumbers } = await vite.ssrLoadModule('/src/lib/pager.ts');

const lifecycle = read('src/pages/LifecyclePage.tsx');
const tasks = read('src/pages/TasksPage.tsx');

describe('pageNumbers：页码折叠', () => {
  it('单页 / 少量页：逐页列出，不出现省略号', () => {
    assert.deepEqual(pageNumbers(1, 1), [1]);
    assert.deepEqual(pageNumbers(2, 3), [1, 2, 3]);
    assert.deepEqual(pageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('首页：中段折叠，保留 1 / 2 / 末页前一页 / 末页', () => {
    assert.deepEqual(pageNumbers(1, 8), [1, 2, '…', 7, 8]);
  });

  it('中段：当前页 ±1 恒在，两侧各自折叠', () => {
    assert.deepEqual(pageNumbers(6, 12), [1, 2, '…', 5, 6, 7, '…', 11, 12]);
  });

  it('末页：只折叠左侧', () => {
    assert.deepEqual(pageNumbers(12, 12), [1, 2, '…', 11, 12]);
  });

  it('折叠不重复：连续的空档只出一个 …', () => {
    const items = pageNumbers(1, 20);
    assert.equal(items.filter((item) => item === '…').length, 1);
  });
});

describe('分类页：分页接线', () => {
  it('保存服务端 total（截断提示的唯一依据）', () => {
    assert.match(lifecycle, /setTotal\(list\.total\)/, 'load 必须保存 list.total');
    assert.match(lifecycle, /const truncated = total > docs\.length/, '截断判据必须比较 total 与已取回条数');
  });

  it('表格只渲染当前页，不再整表铺开', () => {
    assert.match(lifecycle, /const pageDocs = visible\.slice\(/, '需按 page/pageSize 切片');
    assert.match(lifecycle, /\{pageDocs\.map\(\(doc\) => \(/, 'tbody 必须遍历 pageDocs');
    assert.ok(
      !lifecycle.includes('{visible.map((doc) => ('),
      '不许退回整表渲染（那正是长列表卡顿与无翻页的原始形态）',
    );
  });

  it('筛选 / 搜索 / 排序三个入口都重置到第 1 页', () => {
    assert.match(
      lifecycle,
      /if \(filter !== key\) \{[\s\S]{0,120}?setSelected\(new Set\(\)\)/,
      '切分类要清空上一视角的已选（筛选是换视角，不是翻页）',
    );
    assert.match(lifecycle, /setPage\(1\);\s*\}\}\s*>/m, '切分类同时回第 1 页');
    assert.match(lifecycle, /setKeyword\(e\.target\.value\); setPage\(1\)/, '改搜索词要回第 1 页');
    assert.match(lifecycle, /setSortByRemain\(\(v\) => !v\); setPage\(1\)/, '切排序要回第 1 页');
  });

  it('页码越界收敛（数据变少后不留空白页）', () => {
    assert.match(lifecycle, /const currentPage = Math\.min\(page, pageCount\)/, '渲染前需收敛页码');
    assert.match(lifecycle, /if \(page > pageCount\) setPage\(pageCount\)/, '需把超界页码回写到 state');
  });

  it('每页条数选择器改动后回第 1 页', () => {
    assert.match(lifecycle, /setPageSize\(Number\(e\.target\.value\)\); setPage\(1\)/);
    assert.match(lifecycle, /PAGE_SIZE_OPTIONS\.map/, '需渲染每页条数选项');
  });

  it('分页栏：页数 / 篇数 / 折叠页码齐备', () => {
    assert.match(lifecycle, /className="ki-ds-pager"/, '复用站内分页样式');
    assert.match(lifecycle, /第 \{currentPage\} \/ \{pageCount\} 页 · 共 \{visible\.length\} 篇/);
    assert.match(lifecycle, /pageNumbers\(currentPage, pageCount\)/, '页码直达需用共享算法');
    assert.match(lifecycle, /const showPager = visible\.length > 0/, '0 条时整条收起');
  });

  it('截断提示独立于分页栏（0 条时仍要可见）', () => {
    // 截断提示只放分页栏的写法会在「筛出 0 条」时整条消失 —— 而那正是最需要它的场景
    assert.match(
      lifecycle,
      /列表仅加载前 <strong>\{docs\.length\}<\/strong> 篇（全部 \{total\} 篇）/,
      '截断提示需常驻在结果区上方',
    );
    assert.ok(
      !/ki-ds-pager__info[\s\S]{0,200}?truncated/.test(lifecycle),
      '分页栏不得再挂截断文案（0 条时它会随分页栏一起消失）',
    );
  });

  it('全选作用域 = 当前页，且不动其他页的已选', () => {
    assert.match(lifecycle, /ref=\{selectAllRef\}/);
    assert.match(lifecycle, /checked=\{pageAllSelected\}/);
    assert.match(lifecycle, /for \(const doc of pageDocs\)/, '全选只能增删当前页的 key');
    assert.ok(
      !lifecycle.includes('new Set(visible.map(keyOf))'),
      '不许退回「跨页全选但看不见」的旧写法',
    );
    assert.match(lifecycle, /selectAllRef\.current\.indeterminate = pageSomeSelected/, '需有半选态');
    assert.match(lifecycle, /其中当前页 \{pageSelectedCount\} 篇/, '批量条要说明有多少篇在页外');
  });

  it('列表仍取 200 条上限（本次不改后端）', () => {
    assert.match(lifecycle, /limit: 200/);
  });
});

describe('分页算法单一来源', () => {
  it('任务页改用共享 pageNumbers，不再保留本地副本', () => {
    assert.match(tasks, /import \{ pageNumbers \} from '@\/lib\/pager';/);
    assert.ok(
      !/function pageNumbers\(/.test(tasks),
      '任务页不得再自带一份 pageNumbers（两页行为必须一致）',
    );
  });
});
