/**
 * 总览 scope 表：冷热 + 查询/写入（REQ-20261112-001 S-03）源码守卫。
 *
 * 守的契约（都是会被"顺手改"改坏、且改了不报错的点）：
 *  1. 两张表都带 `ki-scope-table` 类 —— 少了这个类，窄屏会套用全局 `.ki-table` 规则，
 *     把「冷热/查询」两列误隐藏。
 *  2. `ki.css` 的全局 `.ki-table` 隐藏规则必须带 `:not(.ki-scope-table)`：
 *     否则 scope 表变 6 列后，第 3/4 列（冷热/查询）会在窄屏被吞掉。
 *  3. 零调用档文案必须是「无调用」：`unused` 的真实含义是「本窗口内 0 次」，
 *     写成「未使用」会被读成「从来没被用过」，而 162 行里 100+ 行会命中该档。
 *  4. 无统计渲染 `—`，不渲染 0（0 会被读成「确实没人用」）。
 *  5. 默认排序 = 冷热降序；空值恒末尾（不随升降序翻转）。
 *  6. 切窗口不产生新请求：`ki_scope_list` 一次返回 d7/d30/d90，窗口是纯前端状态。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (...segments) => fs.readFileSync(path.join(webRoot, ...segments), 'utf8');

const page = read('src', 'pages', 'DashboardPage.tsx');
const table = read('src', 'lib', 'scopeUsageTable.ts');
const css = read('src', 'styles', 'ki.css');
const client = read('src', 'api', 'mcpClient.ts');

describe('总览 scope 表 · 冷热与调用量', () => {
  it('两张表都声明 ki-scope-table 类（窄屏规则靠它区分）', () => {
    const hits = page.match(/className="[^"]*ki-scope-table[^"]*"/g) ?? [];
    assert.equal(hits.length, 2, `主表与「显示注册 scope」表都应带该类，实际命中 ${hits.length} 处`);
  });

  it('全局 .ki-table 列隐藏规则排除了 scope 表', () => {
    // 反向断言：不存在「未排除 scope 表」的 .ki-table 列隐藏选择器
    const bad = css.match(/\.ki-table(?!:not\(\.ki-scope-table\))\s+(?:th|td):nth-child\([3-9]\)/g) ?? [];
    assert.equal(bad.length, 0, `全局列隐藏规则必须带 :not(.ki-scope-table)，命中：${bad.join(' / ')}`);
    assert.ok(
      css.includes('.ki-table:not(.ki-scope-table) th:nth-child(3)'),
      '未找到带 :not(.ki-scope-table) 的列隐藏规则',
    );
  });

  it('scope 表有自己的窄屏规则（隐藏第 4/5/6 列）', () => {
    assert.ok(
      css.includes('.ki-scope-table td:nth-child(6)'),
      '缺 scope 表专属窄屏规则：查询/写入/文档数应可隐藏',
    );
  });

  it('零调用档文案是「无调用」，渲染文案不出现「未使用」', () => {
    assert.ok(table.includes("unused: '无调用'"), 'HEAT_TEXT 的零调用档必须是「无调用」');
    // 只查渲染文案（字符串字面量），注释里解释"不要写成未使用"是允许的
    assert.ok(!/unused:\s*'[^']*未使用/.test(table), '零调用档文案不得为「未使用」');
    assert.ok(!page.includes("'未使用'"), 'DashboardPage 不得渲染「未使用」');
    assert.ok(!page.includes('>未使用<'), 'DashboardPage 不得渲染「未使用」');
  });

  it('无统计渲染 —（不渲染 0），且与「无调用」区分', () => {
    // HeatBadge / CountCell 的两条 null 分支都用了「统计不可用」作为 title
    const fallbacks = page.match(/统计不可用（尚未产生统计数据）/g) ?? [];
    assert.equal(fallbacks.length, 2, `冷热与数字的空值分支都应给出「统计不可用」说明，实际 ${fallbacks.length} 处`);
    assert.ok(page.includes('row.heat === \'unused\'') || page.includes("row.heat === 'unused'"), '应显式区分 unused 与无统计');
  });

  it('默认排序 = 冷热降序，且空值恒末尾', () => {
    assert.ok(
      table.includes("DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: 'heat', dir: 'desc' }"),
      '默认排序必须是 冷热 + 降序（需求 D6）',
    );
    assert.ok(
      table.includes('// 空值恒末尾：不随升序/降序翻转'),
      '空值排序位置必须显式声明不随方向翻转',
    );
    // 次键：文档数降序，且主键是文档数时不再重复比较
    assert.ok(table.includes("if (sortKey !== 'docs')"), '文档数作为隐式次键的判据缺失');
  });

  it('切窗口不产生请求：usage 三档一次返回，窗口是前端状态', () => {
    assert.ok(client.includes('usage?: ScopeUsageInfo | null'), 'ScopeInfo.usage 必须是可选（兼容旧 daemon）');
    assert.ok(client.includes('d7: ScopeUsageWindowInfo'), 'usage 应固定返回 d7/d30/d90 三档');
    assert.ok(client.includes('d30: ScopeUsageWindowInfo'));
    assert.ok(client.includes('d90: ScopeUsageWindowInfo'));
    // 页面里 useScopeList 必须无参（带参会让 queryKey 分裂 → 全局选择器与总览各请求一次）
    assert.ok(page.includes('useScopeList()'), '应无参调用 useScopeList（复用全局 scopeList 缓存）');
    assert.ok(
      !page.includes('useScopeList(windowDays'),
      '窗口不得作为 useScopeList 参数：那会让 queryKey 分裂、切换时多一次请求',
    );
    // windowDays 只用于取字段，不进入任何请求函数
    assert.ok(!/useQuery\(\{[^}]*windowDays/.test(page), 'windowDays 不得进入 useQuery 依赖');
  });

  it('覆盖不足是全局提示（卡头「统计自 X 起」），不逐行加角标', () => {
    assert.ok(table.includes('coveredDays'), '行模型应带 coveredDays');
    assert.ok(
      !page.includes('ki-heat-flag'),
      '数字后不得加 * 角标：统计刚上线时 172 行全带星，信息量为零、只剩噪声',
    );
    assert.ok(page.includes('coveredDays < windowDays'), 'title 里的覆盖天数提示条件缺失');
    assert.ok(page.includes('USAGE_FULL_WINDOW_DAYS'), '应按「是否已覆盖满 90 天」决定是否提示');
    assert.ok(page.includes('统计自'), '卡头应统一提示统计起始日');
  });

  it('冷热档位是热度条（三档颜色 + 长度），零调用档不画条，且不得复用既有 .ki-heat', () => {
    assert.ok(
      /\.ki-scope-heat__dot\s*\{[^}]*width:\s*24px[^}]*height:\s*6px/.test(css),
      '热度条应为 24×6 的小条（用户 2026-11-12 定稿，替换 8px 圆点）',
    );
    for (const [tone, text] of [['hot', '热=红'], ['warm', '温=黄'], ['cold', '冷=淡蓝']]) {
      assert.ok(
        new RegExp(`--ki-heat-${tone}:\\s*#[0-9a-f]{6}`, 'i').test(css),
        `冷热档位色缺少 --ki-heat-${tone}（${text}）`,
      );
    }
    // 暗色必须另给一套：深底上沿用亮色值会糊成暗块（实测 #c9422f 在 #1b201d 上几乎看不出）
    assert.ok(
      /\[data-theme="dark"\][\s\S]{0,3000}--ki-heat-hot:\s*#[0-9a-f]{6}/i.test(css),
      '暗色主题必须覆盖 --ki-heat-*（否则热度条在深底上不可辨）',
    );
    assert.ok(
      /\.ki-scope-heat--warm \.ki-scope-heat__dot\s*\{[^}]*linear-gradient/.test(css)
      && /\.ki-scope-heat--cold \.ki-scope-heat__dot\s*\{[^}]*linear-gradient/.test(css),
      '温 / 冷档必须用渐变做「填 2/3」「填 1/3」，否则三档只剩颜色差别',
    );
    assert.ok(
      /\.ki-scope-heat--unused\s+\.ki-scope-heat__dot\s*\{\s*display:\s*none/.test(css),
      '.ki-scope-heat--unused 不得画条（连空槽都不画）',
    );
    // 类名撞车回归：ki.css 里已有一个 .ki-heat（group 树的带底色徽标），
    // 复用会让本表的热度徽标拿到它的 padding:1px 7px 与淡色底，并对齐补偿失效。
    assert.ok(
      !/\.ki-scope-table[^{]*\.ki-heat\b/.test(css),
      'scope 表内的热度徽标不得使用 .ki-heat（与既有 group 树徽标同名）',
    );
    assert.ok(
      !page.includes('ki-heat ki-heat--'),
      'DashboardPage 不得使用 .ki-heat 类名',
    );
    // 不得用 padding-left 补条让出的宽度：补了以后「无调用」相对**条 / 表头**右缩一截，
    // 整列出现两条左边缘（用户 2026-11-12 二次指出，选定「贴列左边缘」）
    assert.ok(
      !/\.ki-scope-heat--unused\s*\{[^}]*padding-left/.test(css),
      '.ki-scope-heat--unused 不得用 padding-left 补偿：要与条、表头共用列左边缘',
    );
  });

  it('数字列左对齐但多缩进（32px，th 与 td 同值，SortTh 不写内联样式）', () => {
    // 内联 style 优先级高于样式表：SortTh 一旦写死 textAlign / paddingLeft，列规则就永远失效
    assert.ok(
      !page.includes('textAlign:'),
      'SortTh 不得写内联 textAlign（会盖掉 CSS 的列对齐规则）',
    );
    assert.ok(
      /\.ki-scope-table th:nth-child\(4\)[^{]*\{[^}]*padding-left:\s*32px/.test(css),
      '查询 / 写入 / 文档数（第 4/5/6 列）内缩 32px：贴 16px 边界太偏左，居中又太散',
    );
    assert.ok(
      /\.ki-scope-table td:nth-child\(4\)[^{]*\{[^}]*padding-left:\s*32px/.test(css),
      'th 与 td 必须同值内缩，否则表头与数字错位',
    );
    // 9% 列宽只剩 ~61px 内容区：`td` 是 nowrap + fixed，超宽数字会压到右侧列上
    assert.ok(
      /\.ki-scope-table \.ki-num\s*\{[^}]*text-overflow:\s*ellipsis/.test(css),
      '数字列收窄后必须自截断（超宽数字不得压到右侧列）',
    );
    // 1100px 下表宽只剩 870px ⇒ 9% 扣掉 32px 内缩仅 30px，「1,234」会被截成「1…」
    assert.ok(
      /@media \(min-width: 641px\) and \(max-width: 1100px\)[\s\S]{0,900}\.ki-scope-table--main th:nth-child\(4\) \{ width: 12%/.test(css),
      '641~1100px 必须把宽度还给数字列并降回 16px 内缩',
    );
    assert.ok(
      !/\.ki-scope-table th:nth-child\(4\) \.ki-th-sort[^{]*\{[^}]*justify-content:\s*center/.test(css),
      '计数列不得改回居中（用户 2026-11-12 试过后否掉）',
    );
  });

  it('列宽固定分配 + 最后一列留右呼吸位（用户指出列距不均 / 文档数贴边）', () => {
    assert.ok(
      /\.ki-scope-table\s*\{[^}]*table-layout:\s*fixed/.test(css),
      '必须 table-layout: fixed —— auto 会把剩余宽度按内容比例摊出去，列距忽远忽近',
    );
    const mainCols = [...new Set(
      [...css.matchAll(/\.ki-scope-table--main th:nth-child\((\d)\)\s*\{\s*width:/g)].map((m) => m[1]),
    )].sort();
    assert.deepEqual(mainCols, ['1', '2', '3', '4', '5', '6'], `主表 6 列都应有显式宽度，实际 ${mainCols}`);
    const regCols = [...new Set(
      [...css.matchAll(/\.ki-scope-table--reg th:nth-child\((\d)\)\s*\{\s*width:/g)].map((m) => m[1]),
    )].sort();
    assert.deepEqual(regCols, ['1', '2', '3', '4', '5', '6', '7'], `第二张表 7 列都应有显式宽度，实际 ${regCols}`);
    assert.ok(
      /\.ki-scope-table th:last-child[^{]*\{[^}]*padding-right:\s*24px/.test(css),
      '最后一列必须单独加大 padding-right —— td 的右 padding 是右侧空隙的唯一来源',
    );
  });

  it('可排序列表头始终显示排序图标（未激活双向、激活单向，均为小方块按钮）', () => {
    assert.ok(page.includes("'sort'"), '未激活列应显示双向箭头图标，而不是什么都不显示');
    assert.ok(page.includes("'sort-desc'") && page.includes("'sort-asc'"), '激活态应区分升/降序图标');
    // 图标本体必须存在（不是引用一个不存在的名字 —— Icon 对未知 name 返回 null，会静默变空白）
    const icons = fs.readFileSync(path.join(webRoot, 'src', 'components', 'icons.tsx'), 'utf8');
    for (const name of ['sort', 'sort-asc', 'sort-desc']) {
      assert.ok(new RegExp(`(^|\\s)'?${name}'?:`, 'm').test(icons), `icons.tsx 缺少图标 ${name}`);
    }
    assert.ok(/\.ki-th-sort__icon\s*\{[^}]*width:\s*18px/.test(css), '排序图标应为 18×18 小方块');
  });
});
