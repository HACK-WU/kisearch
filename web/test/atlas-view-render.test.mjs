/**
 * 视图下知识地图页的**组件级**验证（SSR 静态渲染，不需要 jsdom / 浏览器）
 *
 * 为什么值得单独写：本仓前端测试没有 DOM 环境，组件行为通常只能真机走查；
 * 但 `AtlasPage` 的分支全由 props/缓存决定（不依赖布局与事件），用 react-dom/server
 * 渲染一次就能锁住「视图下 1 个成员有图集 → 直出该成员，而不是假空态」这条主路径。
 * 预填 query 缓存，渲染期间不发任何请求。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/** ScopeProvider 从 localStorage 取初值；node 下没有，先垫一个（读取发生在模块外，安全） */
const scopeStore = { value: 'kisearch-docs' };
globalThis.localStorage = {
  getItem: (key) => (key === 'ki-web:scope' ? scopeStore.value : null),
  setItem: () => {},
  removeItem: () => {},
};

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { MemoryRouter } = await import('react-router-dom');
const { AtlasPage } = await vite.ssrLoadModule('/src/pages/AtlasPage.tsx');
const { ScopeProvider } = await vite.ssrLoadModule('/src/lib/scopeContext.tsx');
const { AtlasHeaderActions } = await vite.ssrLoadModule('/src/components/AtlasHeaderActions.tsx');
const { AuthProvider } = await vite.ssrLoadModule('/src/lib/authContext.tsx');
after(async () => vite.close());

const VIEW = 'kisearch-docs';
const MEMBERS = ['kisearch-memory', 'kisearch-xperts'];

/**
 * 渲染一次 AtlasPage：缓存里预置 scopeList + 各成员图集状态，渲染期零请求。
 *
 * ⚠️ 只预置**成功**数据。`isError` 态在这里造不出来：`useQueries` 对「error 且无 data」的
 * query 会给出乐观的 `isPending: true`（实测），于是「读失败」分支只能由
 * `atlas-view.test.mjs` 的纯函数用例 + 静态守卫覆盖，不能靠 SSR。
 */
function render({ view = VIEW, statuses = {}, missing = [] } = {}) {
  scopeStore.value = view;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['scopeList'], {
    scopes: MEMBERS.map((scope) => ({ scope, kb: true, vector: false, registered: true, wikiCount: 3 })),
    views: [{ view, members: MEMBERS, memberMeta: [], availableCount: MEMBERS.length, missing }],
  });
  for (const [scope, data] of Object.entries(statuses)) {
    client.setQueryData(['atlasStatus', scope], data);
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/atlas'] },
        React.createElement(ScopeProvider, null, React.createElement(AtlasPage)),
      ),
    ),
  );
}

const withAtlas = (extra = {}) => ({ ok: true, exists: true, sha256: 'sha-a', uploadedAt: '2026-11-20T00:00:00Z', ...extra });
const noAtlas = { ok: true, exists: false };

/** 单库渲染：scopeList 里没有任何视图 —— 单库取数改由 useAtlasTargets 装配后，兜住行为不变 */
function renderSingle(scope, statuses = {}) {
  scopeStore.value = scope;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['scopeList'], {
    scopes: [{ scope, kb: true, vector: false, registered: true, wikiCount: 3 }],
    views: [],
  });
  for (const [key, data] of Object.entries(statuses)) {
    client.setQueryData(['atlasStatus', key], data);
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/atlas'] },
        React.createElement(ScopeProvider, null, React.createElement(AtlasPage)),
      ),
    ),
  );
}

describe('单库路径（取数改由 useAtlasTargets 装配后行为不变）', () => {
  it('已装图集：照常出图，iframe 指向该库', () => {
    const html = renderSingle('default', { default: withAtlas() });
    assert.ok(html.includes('/api/atlas/view?scope=default'));
    assert.ok(!html.includes('这个视图'));
  });

  it('未装图集：仍是原文案「这个库还没有知识地图」+ 该库命令', () => {
    const html = renderSingle('default', { default: noAtlas });
    assert.ok(html.includes('这个库还没有知识地图'));
    assert.ok(html.includes('ki atlas upload --scope default'));
    assert.ok(!html.includes('这个视图'));
  });
});

describe('视图下知识地图页的渲染分支', () => {
  it('1 个成员有图集：直出该成员，不再显示「这个库还没有知识地图」', () => {
    const html = render({
      statuses: { 'kisearch-memory': withAtlas(), 'kisearch-xperts': noAtlas },
    });
    assert.ok(html.includes('atlas-frame'), '应渲染图集 iframe');
    assert.ok(html.includes('/api/atlas/view?scope=kisearch-memory'), 'iframe 指向有图集的成员库');
    assert.ok(!html.includes('kisearch-docs%20'), '不能把视图名塞进 atlas/view');
    assert.ok(!html.includes('这个库还没有知识地图'), '视图下不能再说「这个库」');
    assert.ok(!html.includes('这个视图还没有可显示的知识地图'), '有图集时不该走空态');
  });

  it('2 个成员都有图集：默认选最近上传的那份', () => {
    const html = render({
      statuses: {
        'kisearch-memory': withAtlas({ sha256: 'sha-old', uploadedAt: '2026-11-20T00:00:00Z' }),
        'kisearch-xperts': withAtlas({ sha256: 'sha-new', uploadedAt: '2026-11-25T00:00:00Z' }),
      },
    });
    assert.ok(html.includes('/api/atlas/view?scope=kisearch-xperts'));
  });

  it('都没装：空态列成员名，并引导「先切到成员库」而不是给视图名命令', () => {
    const html = render({ statuses: { 'kisearch-memory': noAtlas, 'kisearch-xperts': noAtlas } });
    assert.ok(html.includes('这个视图还没有可显示的知识地图'));
    assert.ok(html.includes('kisearch-memory、kisearch-xperts'));
    assert.ok(html.includes('&lt;成员库&gt;'), '命令模板应占位成成员库');
    assert.ok(!html.includes('atlas-frame'), '空态不得渲染 iframe');
  });

  it('成员库目录全缺失：报「成员库都不存在」，不误报成「没装图集」', () => {
    const html = render({
      statuses: {},
      missing: MEMBERS,
    });
    assert.ok(html.includes('这个视图的成员库都不存在'));
    assert.ok(!html.includes('都没装图集'));
  });

  });

/** 顶栏：用匿名身份（can('knowledge.write') === false）渲染，顺带验证只读账号也能切成员 */
function renderHeader({ statuses = {} } = {}) {
  scopeStore.value = VIEW;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['scopeList'], {
    scopes: MEMBERS.map((scope) => ({ scope, kb: true, vector: false, registered: true, wikiCount: 3 })),
    views: [{ view: VIEW, members: MEMBERS, memberMeta: [], availableCount: MEMBERS.length, missing: [] }],
  });
  for (const [scope, data] of Object.entries(statuses)) {
    client.setQueryData(['atlasStatus', scope], data);
  }
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/atlas'] },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(ScopeProvider, null, React.createElement(AtlasHeaderActions)),
        ),
      ),
    ),
  );
}

describe('视图下顶栏动作', () => {
  it('≥2 个成员有图集：摆成员切换器，且**不摆**上传/卸载（点了会被写锁拒成 500）', () => {
    const html = renderHeader({
      statuses: {
        'kisearch-memory': withAtlas(),
        'kisearch-xperts': withAtlas({ sha256: 'sha-b', uploadedAt: '2026-11-25T00:00:00Z' }),
      },
    });
    assert.ok(html.includes('atlas-switch__button'), '应有成员切换器');
    assert.ok(html.includes('kisearch-xperts'), '默认选中最近上传的那份');
    assert.ok(!html.includes('上传图集包'), '视图下不摆上传');
    assert.ok(!html.includes('确认卸载'), '视图下不摆卸载');
  });

  it('只有 1 个成员有图集：不摆切换器（页面直出，无需切）', () => {
    const html = renderHeader({
      statuses: { 'kisearch-memory': withAtlas(), 'kisearch-xperts': noAtlas },
    });
    assert.ok(!html.includes('atlas-switch__button'));
    assert.ok(!html.includes('上传图集包'));
  });

  });