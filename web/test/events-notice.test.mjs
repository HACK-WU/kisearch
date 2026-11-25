/**
 * events-notice.test.mjs —— 侧栏「事件」红点的判据与接线（2026-11-25 用户需求）
 *
 * 分两段：
 *   ① **真值表**：直接 import `src/lib/eventsNotice.ts`（node 22 的类型擦除）跑 `hasEventNotice`，
 *      把「什么时候该亮、什么时候不该亮」钉死。这是唯一会静默错的地方 —— 判据写反会
 *      要么红点永不灭，要么该提示时不提示。
 *   ② **接线守卫**：判据对了但没接进 AppShell / 事件页没推进水位，功能照样是死的，
 *      故对源码做静态断言（本项目 web 侧没有组件测试环境，沿用 `sidebar-nav-groups.test.mjs` 的写法）。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const {
  hasEventNotice, EVENT_NOTICE_POLL_MS, SEEN_ANALYSIS_KEY, EVENTS_SEEN_AT_KEY,
} = await import(pathToFileURL(path.join(webRoot, 'src/lib/eventsNotice.ts')).href);

const shellSrc = readFileSync(path.join(webRoot, 'src/layouts/AppShell.tsx'), 'utf8');
const eventsPageSrc = readFileSync(path.join(webRoot, 'src/pages/EventsPage.tsx'), 'utf8');
const cssSrc = readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');
const httpSrc = readFileSync(path.join(webRoot, '../src/lib/governance-http.ts'), 'utf8');

const finished = (eventId, runId, status) => ({ eventId, runId, status });

describe('hasEventNotice 真值表', () => {
  it('两个来源都没有 → 不亮', () => {
    assert.equal(hasEventNotice({ maxUpdatedAt: 100, seenAt: 100, finished: [], seenAnalysis: {} }), false);
  });

  it('没有已读水位（首次打开 / 隐私模式）+ 有历史改动 → 不亮（不误报历史）', () => {
    assert.equal(hasEventNotice({ maxUpdatedAt: 9e12, seenAt: 0, finished: [], seenAnalysis: {} }), false);
    assert.equal(hasEventNotice({ maxUpdatedAt: 9e12, finished: [], seenAnalysis: {} }), false);
  });

  it('改动晚于水位 → 亮', () => {
    assert.equal(hasEventNotice({ maxUpdatedAt: 101, seenAt: 100, finished: [], seenAnalysis: {} }), true);
  });

  it('改动等于 / 早于水位 → 不亮', () => {
    assert.equal(hasEventNotice({ maxUpdatedAt: 100, seenAt: 100, finished: [], seenAnalysis: {} }), false);
    assert.equal(hasEventNotice({ maxUpdatedAt: 99, seenAt: 100, finished: [], seenAnalysis: {} }), false);
  });

  it('旧 daemon 不返回 eventsMaxUpdatedAt → 不据此点亮，但仍看分析那一路', () => {
    assert.equal(hasEventNotice({ seenAt: 100, finished: [], seenAnalysis: {} }), false);
    assert.equal(
      hasEventNotice({ seenAt: 100, finished: [finished('evt_1', 'run_1', 'ready')], seenAnalysis: {} }),
      true,
    );
  });

  it('未看的分析结论（ready / partial / failed）→ 亮', () => {
    for (const status of ['ready', 'partial', 'failed']) {
      assert.equal(
        hasEventNotice({ finished: [finished('evt_1', 'run_1', status)], seenAnalysis: {} }),
        true,
        `${status} 未看时应提示（失败也要人处理）`,
      );
    }
  });

  it('同一个 runId 已看过 → 不亮；重新分析换了 runId → 再亮', () => {
    assert.equal(
      hasEventNotice({ finished: [finished('evt_1', 'run_1', 'ready')], seenAnalysis: { evt_1: 'run_1' } }),
      false,
    );
    assert.equal(
      hasEventNotice({ finished: [finished('evt_1', 'run_2', 'ready')], seenAnalysis: { evt_1: 'run_1' } }),
      true,
    );
  });

  it('cancelled 不算动态（用户主动取消，不该留点）', () => {
    assert.equal(
      hasEventNotice({ finished: [finished('evt_1', 'run_1', 'cancelled')], seenAnalysis: {} }),
      false,
    );
  });

  it('旧记录缺 runId：按「这条看过就算」降级，否则会永久点亮', () => {
    assert.equal(hasEventNotice({ finished: [finished('evt_1', '', 'ready')], seenAnalysis: {} }), true);
    assert.equal(
      hasEventNotice({ finished: [finished('evt_1', '', 'ready')], seenAnalysis: { evt_1: 'run_x' } }),
      false,
    );
  });

  it('水位滞后 + 分析已看完 → 仍亮（两个来源任一成立即提示）', () => {
    assert.equal(
      hasEventNotice({
        maxUpdatedAt: 200, seenAt: 100,
        finished: [finished('evt_1', 'run_1', 'ready')], seenAnalysis: { evt_1: 'run_1' },
      }),
      true,
    );
  });
});

describe('存储键与轮询常量', () => {
  it('键名与既有口径一致（分析已读沿用原键，避免列表徽标与新红点两套语义）', () => {
    assert.equal(SEEN_ANALYSIS_KEY, 'ki-web:analysis-seen');
    assert.equal(EVENTS_SEEN_AT_KEY, 'ki-web:events-seen-at');
    assert.ok(EVENT_NOTICE_POLL_MS >= 10_000, '轮询不能比 10s 更密：counts 在视图下要扫事件目录');
  });
});

describe('侧栏接线（AppShell）', () => {
  it('红点只在「事件」项上渲染，且无文字无数字', () => {
    assert.match(
      shellSrc,
      /item\.to === '\/governance\/events' && eventNotice/,
      '红点必须只挂在事件项（其它两项与「事件」含义不同）',
    );
    const block = shellSrc.slice(shellSrc.indexOf('ki-nav-item__notice'), shellSrc.indexOf('ki-nav-item__count'));
    assert.ok(block.includes('aria-label="事件有新的动态"'), '无障碍标签要说明有新动态');
    assert.ok(!/\{eventNotice\s*\?/.test(block), '红点内不得输出文字 / 计数');
  });

  it('判据与轮询来自 lib，且计数与红点共用 30s 节奏', () => {
    assert.ok(shellSrc.includes('hasEventNotice('), '必须走 lib 的纯函数判据，避免侧栏与列表各算一套');
    assert.ok(shellSrc.includes('EVENT_NOTICE_POLL_MS'), '轮询间隔必须用共享常量');
    assert.ok(shellSrc.includes("readEventsSeenAt(scope) || bootAtRef.current"), '无水位时用挂载时刻兜底（否则首次打开误亮）');
    assert.ok(shellSrc.includes('readSeenAnalysis()'), '已读必须现读存储：事件页写入后本组件收不到通知');
  });

  it('在事件页不显示红点（避免点了没反应的死角）', () => {
    assert.match(shellSrc, /const onEventsPage = location\.pathname\.startsWith\('\/governance\/events'\)/);
    assert.match(shellSrc, /if \(onEventsPage\) \{\s*setEventNotice\(false\)/, '事件页上必须直接不亮');
  });

  it('useLocation 只声明一次且在计数 effect 之前（deps 用到它）', () => {
    assert.equal(shellSrc.split('useLocation()').length - 1, 1, '重复声明会让 effect 引用到不正确的作用域');
    const locAt = shellSrc.indexOf('const location = useLocation();');
    const effectAt = shellSrc.indexOf('window.setInterval(load, EVENT_NOTICE_POLL_MS)');
    assert.ok(locAt > 0 && effectAt > 0, '计数 effect 与 location 都必须存在');
    assert.ok(locAt < effectAt, 'location 必须早于两个轮询 effect 声明');
  });
});

describe('事件页推进水位（EventsPage）', () => {
  it('loadList 成功后写入水位，且来源是 counts 的 eventsMaxUpdatedAt', () => {
    assert.match(
      eventsPageSrc,
      /writeEventsSeenAt\(scope, govCounts\.eventsMaxUpdatedAt \?\? 0\)/,
      '事件页看到的内容即视为已读；漏掉这行 → 进页面后红点永不灭',
    );
    const loadAt = eventsPageSrc.indexOf('const loadList = useCallback');
    const writeAt = eventsPageSrc.indexOf('writeEventsSeenAt(scope, govCounts.eventsMaxUpdatedAt');
    assert.ok(loadAt > 0 && writeAt > loadAt, '水位推进必须在 loadList 内（自己的写操作走后 run(fn) → loadList）');
  });

  it('已读键上移到 lib：事件页不再自建 SEEN_ANALYSIS_KEY', () => {
    assert.ok(!/const SEEN_ANALYSIS_KEY\s*=/.test(eventsPageSrc), '两处各定义一份键会分叉成两套已读');
    assert.ok(eventsPageSrc.includes('readSeenAnalysis'), '初始化要走 lib');
    assert.ok(eventsPageSrc.includes('persistSeenAnalysis'), '落盘要走 lib');
  });
});

describe('样式与后端字段', () => {
  it('红点用 danger 语义（区分「AI 对话生成中」的 primary 点）', () => {
    // 取第一条 `.ki-nav-item__notice { ... }` 规则（窄轨覆盖在媒体查询里，另有用例）
    const rule = cssSrc.match(/\.ki-nav-item__notice \{[^}]*\}/)?.[0] ?? '';
    assert.notEqual(rule, '', 'ki.css 缺少 .ki-nav-item__notice 规则');
    assert.match(rule, /var\(--ki-color-danger\)/, '红点必须用 danger：primary 点已被「生成中」占用');
    assert.match(rule, /border-radius: 50%/, '必须是圆点');
  });

  it('窄轨（≤959px）有覆盖：负 margin 在 gap:0 下会把点压到计数上', () => {
    const mediaAt = cssSrc.indexOf('@media (max-width: 959px)');
    assert.ok(mediaAt > 0);
    assert.ok(
      cssSrc.slice(mediaAt).includes('.ki-nav-item__notice { margin-left: 0; margin-right: 0; }'),
      '窄轨里必须还原间距',
    );
  });

  it('后端两个分支都下发 eventsMaxUpdatedAt（视图取 max 不是 sum）', () => {
    assert.ok(httpSrc.includes('function maxUpdatedAt('), '两个分支必须共用 helper，各写一份算法迟早算得不一样');
    assert.match(
      httpSrc,
      /eventsMaxUpdatedAt: maxUpdatedAt\(events\),/,
      '单库与视图的 row 都要带上该字段',
    );
    assert.ok(
      httpSrc.includes('sum.eventsMaxUpdatedAt = Math.max(sum.eventsMaxUpdatedAt, row.eventsMaxUpdatedAt)'),
      '视图必须取 max',
    );
    assert.ok(!httpSrc.includes('sum.eventsMaxUpdatedAt +='), '视图不得求和（求和后无法与时间点比较，红点永不灭）');
  });
});

/**
 * 红点的死穴是「亮起来之后没有路可清」：一旦出现这种状态，用户只能重启 daemon，
 * 那就不是提醒而是骚扰了。这两条守的是两条清零路。
 */
describe('红点必须可清（防常亮）', () => {
  it('删除事件时清掉进程内「已结束分析」登记（否则点不进任何地方）', () => {
    assert.match(
      httpSrc,
      /const outcome = await deleteEvent\([\s\S]{0,400}?forgetFinishedAnalysis\(scope, id\);/,
      'DELETE 事件分支必须 forgetFinishedAnalysis：事件没了，红点却还认这份「没看过的结论」',
    );
  });

  it('存储不可用时整只红点关掉（已读记不住 = 永远清不掉）', () => {
    assert.ok(
      shellSrc.includes('if (!isStorageAvailable())'),
      '隐私模式 / 禁用存储下必须在 tick 里直接熄灭，否则「未看分析」永久成立',
    );
    assert.ok(
      shellSrc.includes('isStorageAvailable, ') || shellSrc.includes('isStorageAvailable,'),
      'AppShell 必须从 lib 引入该探测',
    );
  });

  it('失败成员清单也做相等守卫，避免 30s 无谓重渲染', () => {
    assert.match(
      shellSrc,
      /prev\.length === failed\.length && prev\.every\(\(s, i\) => s === failed\[i\]\)/,
      '`map()` 每次都是新数组，不守卫就等于「值没变也 setState」',
    );
  });
});