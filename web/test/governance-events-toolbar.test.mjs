/**
 * governance-events-toolbar.test.mjs —— 事件页工具条布局 / 列表排序 / 已收口灰底（2026-11-17）
 *
 * web 单测不渲染 React（无 jsdom），沿用仓库既有做法做**源码契约断言**：
 * 把「视图切换在页头、过滤器贴左、排序默认降序、已收口行灰底」钉住，避免后续改版悄悄回退。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
const css = read('src/styles/governance.css');

/** 页头 actions 区 / 工具条区（工具条区截到「事件类型」分支开始，避免误伤类型页的 typebar） */
const headerEnd = page.indexOf('</header>');
const headActions = page.slice(page.indexOf('gov-head__actions'), headerEnd);
const toolbarSection = page.slice(headerEnd, page.indexOf("{tab === 'types' ? ("));

describe('① 视图切换：挪进页头，位于主操作左侧', () => {
  it('「事件列表 / 事件类型」在 gov-head__actions 内', () => {
    assert.match(headActions, /事件列表/);
    assert.match(headActions, /事件类型/);
  });

  it('视图切换排在「＋ 新建事件」之前', () => {
    assert.ok(
      headActions.indexOf('事件列表') < headActions.indexOf('＋ 新建事件'),
      '视图切换应在新建事件按钮左侧',
    );
  });

  it('视图切换带分组语义（role=group + aria-label）', () => {
    assert.match(headActions, /role="group"[\s\S]{0,40}aria-label="视图"/);
  });
});

describe('② 过滤器：贴左、只在列表视图渲染', () => {
  it('工具条不再用 spacer 把过滤器顶到视口右侧', () => {
    assert.doesNotMatch(toolbarSection, /gov-toolbar__spacer/);
  });

  it('工具条只在 tab === list 时渲染（类型页没有事件可过滤）', () => {
    assert.match(toolbarSection, /tab === 'list' \? \(/);
  });

  it('三个过滤器都在工具条内：类型 / 状态 / 排序', () => {
    const ddCount = (toolbarSection.match(/<DropdownFilter/g) ?? []).length;
    assert.equal(ddCount, 3, `工具条应有 3 个下拉，实际 ${ddCount} 个`);
  });
});

describe('③ 排序：默认降序，三种口径', () => {
  it('默认排序为「最近更新」降序（升级前后默认视图不变）', () => {
    assert.match(page, /useState<SortKey>\('updated-desc'\)/);
  });

  it('三个排序选项齐全且默认项排第一', () => {
    for (const label of ['最近更新', '最新创建', '最早创建']) {
      assert.match(page, new RegExp(`label: '${label}'`));
    }
    assert.match(page, /'updated-desc': '最近更新'/);
  });

  it('排序在已取回的当前页内重排，不改请求参数', () => {
    /*
     * 原意图：排序若进入 loadList 的依赖数组，会触发重新请求（后端无 sort 参数，纯浪费）。
     * 断言方式从"硬编码整个依赖数组"改成"提取数组再看是否含 sort"——
     * 硬编码会在每次新增合法依赖（如深链的 matchDeepLink）时误报。
     */
    const m = page.match(/const loadList = useCallback\(async \(\) => \{[\s\S]*?\}, \[([^\]]*)\]\);/);
    assert.ok(m, '未能定位 loadList 的依赖数组');
    const deps = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(!deps.includes('sort'), `loadList 依赖不应包含 sort，实际=${deps.join(',')}`);
  });

  it('createdAt 缺失时回退到 updatedAt（老事件文件不整批沉底）', () => {
    assert.match(page, /e\.createdAt \?\? e\.updatedAt \?\? 0/);
  });

  it('第二行时间标签随排序键切换', () => {
    assert.match(page, /创建 \$\{relTime\(e\.createdAt \?\? e\.updatedAt\)\}/);
  });
});

describe('④ 已收口事件：灰底但不禁用', () => {
  it('列表行按 closedAt 打上 gov-ev--closed', () => {
    assert.match(page, /isClosed \? ' gov-ev--closed' : ''/);
    assert.match(page, /closedAt !== null && event\.closedAt !== undefined/);
  });

  it('灰底用中性灰专用变量（`--ki-color-bg-muted` 是暖绿灰，用户明确说"不是灰"）', () => {
    assert.match(css, /\.gov-ev--closed \{[^}]*--gov-closed-bg\b/);
    // 竖条由 `.gov-ev.gov-ev--active` 提供，closed 联合选择器再写 box-shadow 会抢值
    assert.doesNotMatch(css, /\.gov-ev--closed\.gov-ev--active \{[^}]*box-shadow/);
  });

  it('关闭态靠字重降权（650 → 400），底色只做极轻下沉（2026-11-19 用户：「咋这么突出」）', () => {
    assert.match(css, /\.gov-ev--closed \.gov-ev__name \{[^}]*font-weight: 400/);
    assert.match(css, /--gov-closed-bg: #fafafa/);
    assert.match(css, /\.gov-ev--closed:hover \{[^}]*--gov-closed-bg-hover/);
  });
});

describe('⑤ 下拉浮层：左侧按钮上的菜单向右展开', () => {
  it('.gov-dd__menu 左对齐（改用 right:0 会溢出视口左边界）', () => {
    assert.match(css, /\.gov-dd__menu \{[^}]*left: 0;/);
  });
});

describe('⑥ 默认「全部」+ 选中态写回 URL（2026-11-19）', () => {
  it('状态筛选默认「全部」：页头写着「已收口 N」却一条看不到会被当成事件丢了', () => {
    assert.match(page, /useState<Status>\('all'\)/);
  });

  it('左栏点选走统一的 selectEvent，把 id 写回 ?event=', () => {
    assert.match(page, /onClick=\{\(\) => selectEvent\(event\.id\)\}/);
    assert.match(page, /next\.set\('event', id\)/);
    // 点十次事件不该在浏览器历史里留十个台阶
    assert.match(page, /\}, \{ replace: true \}\);\s*\n\s*\}, \[setSearchParams\]\)/);
  });

  it('深链兜底只认进入页面时的参数，点选写回不再触发「可能已被删除」误报', () => {
    assert.match(page, /const entryDeepLink = useRef\(searchParams\.get\('event'\)\)\.current/);
    // 响应式读取会让「点选 → 写 URL → 兜底 effect 重跑」串成误报链
    assert.doesNotMatch(page, /deepLinkEvent/);
  });
});

describe('⑦ 列表行显示当前阶段（2026-11-19）', () => {
  it('类型徽标旁渲染阶段文字，已收口行挂 --closed 修饰', () => {
    assert.match(page, /gov-badge gov-ev__stage\$\{isClosed \? ' gov-ev__stage--closed' : ''\}/);
  });

  it('阶段名优先取接口下发的 stage，缺失时按 stageKey 从类型定义反查', () => {
    assert.match(page, /event\.stage\?\.name \?\? stageOfType\?\.name \?\? null/);
    assert.match(page, /t\?\.stages\.find\(\(s\) => s\.key === event\.stageKey\)/);
  });

  it('后端占位「(未知阶段)」不进列表（只会制造噪音）', () => {
    assert.match(page, /rawStageName !== '\(未知阶段\)'/);
  });

  it('阶段不做成带框徽标（描边 + 内边距像按钮，会被误认为可点）', () => {
    const m = css.match(/\.gov-ev__stage \{([^}]*)\}/);
    assert.ok(m, '未能定位 .gov-ev__stage 规则');
    assert.doesNotMatch(m[1], /border:\s*1px/);
    assert.match(m[1], /padding: 0/);
    assert.match(m[1], /background: none/);
  });

  it('已收口行的阶段退回弱色（灰底上不浮出一块主色）', () => {
    assert.match(css, /\.gov-ev__stage--closed \{ color: var\(--ki-color-text-subtle\); \}/);
  });
});

describe('⑧ 换库清理选中态（2026-11-19）', () => {
  it('scope 变化时清掉选中与 ?event=，并压掉深链告警', () => {
    assert.match(page, /lastScope\.current === scope/);
    assert.match(page, /deepLinkWarned\.current = true;\s*\n\s*selectEvent\(null\);/);
  });

  it('深链找不到时区分「已删除」与「不在当前库」（别让人以为数据丢了）', () => {
    assert.match(page, /它可能已被删除，或不在当前知识库「\$\{scope\}」中/);
  });
});

describe('⑨ 深链兜底只判一次（2026-11-19 误报修复）', () => {
  /*
   * 真机 Bug：带 `?event=<已收口事件>` 进页面后切「未收口」，先把用户筛选弹回「全部」，
   * 再在「筛选刚切、列表还是旧的一份」的中间态上重判 → 误报「事件可能已被删除」。
   * 修法：判定做完就置 `deepLinkWarned`（找到也置），且不再自动放宽筛选。
   * 复现与证据见 `.debug/events-filter-deeplink-20261119/`。
   */
  /*
   * 取「判定入口 → 依赖数组」这整段，而不是固定长度切片：切片越界会把后面 effect 的
   * `setStatus(` 一起算进来，让「不改筛选」这条断言假红。
   */
  const effectStart = page.indexOf('if (!entryDeepLink || deepLinkWarned.current || events.length === 0) return;');
  const effectMatch = effectStart < 0
    ? null
    : page.slice(effectStart).match(/^[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/);
  const effectBlock = effectMatch?.[0] ?? '';
  const effectDeps = (effectMatch?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  it('能定位深链兜底 effect', () => {
    assert.ok(effectStart >= 0, '未能定位深链兜底 effect 的判定入口');
    assert.ok(effectMatch, '未能从判定入口切到依赖数组结尾');
  });

  it('找到即终结：置位在「命中」判断之前，不只在报警时置位', () => {
    assert.match(
      effectBlock,
      /deepLinkWarned\.current = true;\s*\n\s*if \(matchDeepLink\(events\)\) return;/,
    );
  });

  it('兜底不再改动筛选（旧实现在这里 setStatus 放宽到「全部」，会弹回用户刚选的那一档）', () => {
    assert.doesNotMatch(effectBlock, /setStatus\(/);
  });

  it('不随状态筛选重判（依赖数组不含 status）', () => {
    assert.ok(effectDeps.length > 0, '未能解析深链兜底 effect 的依赖数组');
    assert.ok(!effectDeps.includes('status'), `深链兜底依赖不应包含 status，实际=${effectDeps.join(',')}`);
  });
});

describe('⑩ 列表行改版：缩略 / 编号 chip / 刷新 / 撑满视口（2026-11-19）', () => {
  it('标题缩略 1 行，完整标题走 title 属性（否则折 4-5 行，行高在 60~120px 间跳）', () => {
    assert.match(css, /\.gov-ev__name \{[^}]*-webkit-line-clamp: 1;/);
    assert.match(page, /className="gov-ev__name" title=\{event\.title\}/);
  });

  it('编号移入 meta 行、正文只显示裸数字（`#` 只留在 title / aria-label）', () => {
    const metaStart = page.indexOf('className="gov-ev__meta"');
    assert.ok(metaStart > 0, '未能定位 gov-ev__meta');
    const metaBlock = page.slice(metaStart, page.indexOf('</div>', metaStart));
    assert.match(metaBlock, /className="gov-ev__id"/);
    assert.match(page, /title=\{`事件 #\$\{event\.shortId\}`\}/);
    assert.doesNotMatch(page, />\s*#\{event\.shortId\}/, '正文节点不能拼 `#`');
  });

  it('分隔点用真实节点，不用 ::before（徽标是 inline-flex，伪元素会跑进它自己的背景）', () => {
    assert.match(page, /className="gov-ev__sep"/);
    assert.match(css, /\.gov-ev__sep \{ margin: 0 5px;/);
    assert.doesNotMatch(css, /\.gov-ev__meta > \* \+ \*::before/);
  });

  it('图钉与编号 chip 之间有间距（否则图标贴着 chip 边框）', () => {
    assert.match(css, /\.gov-ev__pin \{[^}]*margin-right: 5px/);
  });

  it('刷新按钮同时刷列表与详情、在途禁用；请求序号丢弃过期响应（搜索与刷新并发不互相覆盖）', () => {
    assert.match(page, /gov-pane__refresh/);
    assert.match(page, /onClick=\{\(\) => \{[\s\S]{0,80}void loadList\(\);/);
    // 只刷列表会让人以为「刷了还是旧的」：列表标题变了、右栏还停在旧阶段
    assert.match(page, /if \(activeId\) void loadDetail\(activeId\);/);
    assert.match(page, /disabled=\{listLoading\}/);
    assert.match(page, /const seq = \+\+listSeq\.current;/);
    assert.match(page, /if \(seq !== listSeq\.current\) return;/);
    assert.match(page, /if \(seq === listSeq\.current\) setListLoading\(false\)/);
  });

  it('列表撑满视口靠 noscroll + flex 高度链，不再拿固定值估页头高度', () => {
    assert.match(page, /ki-content--noscroll/);
    assert.match(page, /gov-page--fill/);
    assert.match(css, /\.ki-content--noscroll \.gov-page--fill \{[^}]*flex: 1 1 auto/);
    assert.match(css, /\.ki-content--noscroll \.gov-page--fill \.gov-pane--list \{ height: 100%; \}/);
    // 三代固定预留（560 / min(760,100vh-220) / 100vh-200）都不得回到生效规则里
    assert.doesNotMatch(css, /max-height: min\(760px, calc\(100vh - 220px\)\)/);
    assert.doesNotMatch(css, /max-height: calc\(100vh - 200px\)/);
    assert.doesNotMatch(css, /\.gov-pane--list \{ position: sticky/);
  });

  it('「事件类型」视图与单列断点必须摘掉 noscroll（否则页面滚不动、下半页看不到）', () => {
    assert.match(page, /tab !== 'list' \|\| narrowLayout/);
    assert.match(page, /matchMedia\('\(max-width: 1080px\)'\)/);
  });

  it('右栏自己接管滚动，切事件后回顶（否则停在上一条位置像「点了没反应」）', () => {
    assert.match(css, /\.ki-content--noscroll \.gov-page--fill \.gov-pane--flat \{[^}]*overflow-y: auto/);
    assert.match(page, /el\.scrollTop = 0;/);
  });

  it('分区标题与首行无缝：吸顶不露内容、首行顶部直角', () => {
    assert.match(css, /\.gov-evgroup \+ \.gov-ev \{ border-radius: 0 0/);
    assert.match(css, /\.gov-pane__list \{[^}]*padding: 0 var\(--ki-space-2\) 10px/);
    assert.match(page, /gov-evgroup__count/);
  });
});
