/**
 * governance-doc-open-ui.test.mjs —— 治理页「文档行点开正文」的静态守卫（2026-11-15）
 *
 * 背景：事件页「关联文档 / 参考文档」与分类页文档列表原先都是**纯文本行**，点了没有任何反应
 * （demo 里有抽屉、实现漏接线；用户反馈「点击以后无法查看文档内容」）。交互本身靠真机验证，
 * 这里只挡会被"顺手清理"掉的结构性约定：
 *   1. 文档名必须是 <button>（可聚焦、可回车），不许退回纯 <div>
 *   2. 点击必须落到 setDocTarget，并渲染 ModuleDrawer + getDocContent（read 通道，不排 MCP 写队列）
 *   3. ModuleDrawer 载入正文后不再重取（`if (content !== null) return`）
 *      ⇒ scope / 事件变化时必须收起抽屉，否则会静默显示上一个库的正文
 *   4. 可点击态用 ki token（hover 可发现性 + focus-visible），不新造字面色值
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const events = read('src/pages/EventsPage.tsx');
const lifecycle = read('src/pages/LifecyclePage.tsx');
const css = read('src/styles/governance.css');
/** 2026-11-17 改版：文档行抽到 DocLine，跨页断言改读组件源码 */
const docLine = read('src/components/governance/event-detail/DocLine.tsx');
/** 文档卡（meta 展示 / 点击回传 group 的落点） */
const docsCard = read('src/components/governance/event-detail/EventDocsCard.tsx');

/** 数出「<button> 上挂了某个 className」的出现次数（跨行匹配，容忍属性换行） */
function clickableCount(src, className) {
  return [...src.matchAll(/<button[\s\S]{0,200}?className="([^"]*)"/g)]
    .filter((m) => m[1].split(/\s+/).includes(className))
    .length;
}

test('事件页：关联文档与参考文档的文档名都是可点按钮，且落到 setDocTarget', () => {
  // 文档行统一走 DocLine：组件内 1 个 .gov-docline__main 按钮；事件页两张卡都用它
  const mains = docLine.match(/className="gov-docline__main"/g) ?? [];
  assert.equal(mains.length, 1, 'DocLine 内应有且仅有 1 个 .gov-docline__main');
  assert.equal((events.match(/<EventDocsCard/g) ?? []).length, 2, '关联文档 / 参考文档各渲染一次 EventDocsCard');

  for (const m of docLine.matchAll(/<button[\s\S]{0,160}?className="gov-docline__main"/g)) {
    assert.ok(m[0].startsWith('<button'), '.gov-docline__main 必须挂在 <button> 上（可聚焦 / 可回车）');
  }
  // 2026-11-20：两张卡都必须落到 setDocTarget，且显式带上「条目所属库」——
  // 只有 group+name 时，跨库引用与视图模式只能退回事件库/视图名去读。
  assert.equal(
    (events.match(/onOpen=\{\(group, name(?:, sourceScope)?\) => setDocTarget\(\{ scope: [^}]+, group, name \}\)\}/g) ?? []).length,
    2,
    '两张卡的 onOpen 都必须落到 setDocTarget，并带上 scope（传原始 group/name，不套闭包变量名）',
  );
  assert.ok(
    !docLine.includes('<div className="gov-docline__name">'),
    '文档名不许退回纯 <div>（那正是「点了没反应」的原始形态）',
  );
});

test('事件页：抽屉复用 ModuleDrawer，正文走 doc/get（read 通道）', () => {
  assert.match(events, /import \{ ModuleDrawer \} from '@\/components\/ModuleDrawer';/);
  assert.match(events, /import \{ getDocContent \} from '@\/api\/httpApi';/);
  assert.match(events, /<ModuleDrawer[\s\S]{0,320}?fetcher=\{getDocContent\}/, '抽屉必须用 getDocContent 取正文');
  assert.match(
    events,
    /key=\{`\$\{docTarget\.scope\}\/\$\{docTarget\.group\}\/\$\{docTarget\.name\}`\}/,
    'key 含 scope+group+name：换篇、以及跨库同名同组也要重挂载',
  );
  assert.match(
    events,
    /<ModuleDrawer[\s\S]{0,400}?scope=\{docTarget\.scope\}/,
    '抽屉必须按条目所属库读正文（传视图名 / 事件库都可能在跨库引用时读错）',
  );
});

/**
 * 回归（2026-11-20 真机 bug）：顶栏选视图 `kisearch-docs`，事件详情点「参考文档」→ 抽屉「加载失败」：
 * `Group "kisearch-memory · 错误库" 未匹配到有效路径`。切回单库一切正常。
 *
 * 成因：参考文档行把「来源库 · 组名 · 失效标记」这段**展示文案**赋给了 `group`，
 * 而视图的顶栏 scope 是视图名、与 `sourceScope`（真实库）必然不等 ⇒ 每次都拼串，
 * 于是展示串被当成 Group 传给 `/api/doc/get`。单库下两者相等，故不复现。
 */
test('参考文档行：group 必须是真实组名，展示文案只走 meta', () => {
  const start = events.indexOf('mode="ref"');
  assert.ok(start > 0, '应存在参考文档卡（mode="ref"）');
  const refBlock = events.slice(start, events.indexOf('actions={(', start));
  assert.ok(refBlock.length > 0, '应能截出参考文档卡的 docs 映射与 onOpen');

  assert.match(refBlock, /group: ref\.group,/, '参考文档行的 group 必须是 ref.group（点开定位用原值）');
  assert.match(refBlock, /meta: \[[\s\S]{0,320}?\]\.join\(""\)/, '「来源库 · 组名 · 失效」只能作为展示文案进 meta');
  assert.doesNotMatch(refBlock, /group: \[/, 'group 不得再被赋成数组拼出来的展示串（本 bug 的原始形态）');
  assert.match(refBlock, /sourceScope/, '跨库引用要带上 sourceScope，抽屉才能读对库');

  assert.match(docsCard, /meta=\{row\.meta \?\? row\.group\}/, '卡片展示取 meta，缺省才回退 group');
  assert.match(docsCard, /onOpen\(row\.group, row\.name, row\.sourceScope\)/, '点击回传真实的 group / sourceScope');
});

test('分类页：文档名是可点按钮，且同样复用 ModuleDrawer', () => {
  assert.match(
    lifecycle,
    /<button[\s\S]{0,160}?className="gov-cell-name gov-cell-name--link"/,
    '分类页文档名必须是按钮（表格里可聚焦）',
  );
  // 分类页文档条目自带所属库（视图聚合二期）：抽屉按它取正文，不能传顶栏 scope
  assert.match(lifecycle, /setDocTarget\(\{ scope: doc\.scope, group: doc\.group, name: doc\.name \}\)/);
  assert.ok(
    !lifecycle.includes('<div className="gov-cell-name">'),
    '文档名不许退回纯 <div>',
  );
  assert.match(lifecycle, /import \{ ModuleDrawer \} from '@\/components\/ModuleDrawer';/);
  assert.match(lifecycle, /<ModuleDrawer[\s\S]{0,320}?fetcher=\{getDocContent\}/);
});

test('切 scope（事件页还要换事件）时收起抽屉，避免串库', () => {
  // 2026-11-17 改版：同一 effect 还要收回 AI 查找面板/二次确认等跨事件临时态，
  // 契约不变：依赖必须是 [scope, activeId]，且第一句就是 setDocTarget(null)。
  assert.match(
    events,
    /useEffect\(\(\) => \{\s*setDocTarget\(null\);[\s\S]{0,200}?\}, \[scope, activeId\]\);/,
    '事件页：scope 或选中事件变化即收起抽屉',
  );
  // 2026-11-16 起该 effect 顺带把页码归 1（REQ-20261116-001），故允许 setDocTarget 后跟其他动作；
  // 契约不变：必须是「依赖 [scope]、且以 setDocTarget(null) 开头」的那个 effect。
  assert.match(
    lifecycle,
    /useEffect\(\(\) => \{ setDocTarget\(null\);[\s\S]{0,80}?\}, \[scope\]\);/,
    '分类页：scope 变化即收起抽屉',
  );
});

test('可点击态用 ki token，且带 focus-visible（键盘可达）', () => {
  assert.match(css, /\.gov-docline__main:hover \{ background: var\(--ki-color-hover\); \}/);
  assert.match(css, /\.gov-docline__main:hover \.gov-docline__name \{ color: var\(--ki-color-primary\); \}/);
  assert.match(css, /\.gov-docline__main:focus-visible \{ outline: 2px solid var\(--ki-color-primary\)/);
  assert.match(css, /\.gov-cell-name--link:hover \{ color: var\(--ki-color-primary\); text-decoration: underline; \}/);
  assert.match(css, /\.gov-cell-name--link:focus-visible \{ outline: 2px solid var\(--ki-color-primary\)/);
});

/**
 * 计数辅助的兜底断言：上面的 clickableCount 目前未被用到（保留给后续扩展多入口时使用），
 * 这里显式断言它至少能数出 2 个，避免函数被误改成永远返回 0 还一路绿。
 */
test('辅助计数函数可用（防被改坏后静默失效）', () => {
  assert.equal(clickableCount(docLine, 'gov-docline__main'), 1);
});

test('治理页抽屉保持只读：不得开启 editable，也不得挂删除 / 移动回调', () => {
  for (const [page, src] of [['EventsPage', events], ['LifecyclePage', lifecycle]]) {
    const start = src.indexOf('<ModuleDrawer');
    assert.ok(start > 0, `${page} 应渲染 ModuleDrawer`);
    const block = src.slice(start, src.indexOf('/>', start));
    assert.ok(!/\beditable\b/.test(block), `${page}：治理页是读入口，抽屉不得开启 editable（会带出编辑写入口）`);
    assert.ok(!/\bonDeleted\b|\bonMoved\b/.test(block), `${page}：抽屉不得挂删除 / 移动回调（无后续导航承接）`);
  }
});
