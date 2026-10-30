/**
 * 总览「当前知识库」六宫格判定单测（2026-10-30）
 *
 * 锁住四条不变量（每条都对应一次真实的误读风险）：
 *   ① `readonly === undefined` 必须是「—」，不得渲染成「可写」（旧 daemon 不返回该字段）；
 *   ② 向量服务不可用时 RAG 列必须是 `?` 而不是 `✗` —— 后端此时 `vectorScopes` 为空集，
 *      所有 scope 的 `vector` 都返回 false（src/scope.ts:210-218 → :275），渲染 ✗ 是谎报；
 *   ③ Wiki 回写卡的 `tone` 必须与 describeWikiSync 全等（两套判定会出现"总览说未开启、
 *      资源页说已开启"的同屏矛盾）；
 *   ④ 卡内 label 不含路径（用户 2026-10-30 明确要求），路径只在 title 里。
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
const { readModeCard, layerColumns, wikiWritebackCard, readonlyWikiNote } =
  await vite.ssrLoadModule('/src/lib/dashboardScopeCards.ts');
const { describeWikiSync } = await vite.ssrLoadModule('/src/lib/resourcesPage.ts');
after(async () => vite.close());

describe('readModeCard（读写权限三态）', () => {
  it('readonly=true → 只读 + 警示色，title 带解除命令', () => {
    const card = readModeCard('demo', true);
    assert.equal(card.label, '只读');
    assert.equal(card.tone, 'warn');
    assert.match(card.title, /只读知识库/);
    assert.match(card.title, /ki scope readonly demo --off/);
  });

  it('readonly=false → 可写', () => {
    const card = readModeCard('demo', false);
    assert.equal(card.label, '可写');
    assert.equal(card.tone, 'ok');
  });

  it('readonly=undefined（旧 daemon）→ —，不得显示"可写"', () => {
    const card = readModeCard('demo', undefined);
    assert.equal(card.label, '—');
    assert.equal(card.tone, 'muted');
    assert.match(card.title, /未提供只读状态/);
    assert.doesNotMatch(card.label, /可写/);
  });
});

describe('layerColumns（KB / RAG 两列状态点）', () => {
  const view = (cols) => ({
    kb: `${cols.kb.label}/${cols.kb.tone}`,
    rag: `${cols.rag.label}/${cols.rag.tone}`,
  });

  it('两层都可用 → 可用/可用', () => {
    assert.deepEqual(view(layerColumns({ kb: true, vector: true }, false)), {
      kb: '可用/ok',
      rag: '可用/ok',
    });
  });

  it('KB 可用、RAG 不可用 → 逐列可读（不得压成一个总状态）', () => {
    const cols = layerColumns({ kb: true, vector: false }, false);
    assert.equal(cols.kb.label, '可用');
    assert.equal(cols.rag.label, '不可用');
    assert.equal(cols.rag.tone, 'off');
    assert.match(cols.rag.title, /未建向量集合/);
  });

  it('KB 不可用、RAG 可用', () => {
    assert.deepEqual(view(layerColumns({ kb: false, vector: true }, false)), {
      kb: '不可用/off',
      rag: '可用/ok',
    });
  });

  it('两层都不可用 → 不可用/不可用', () => {
    assert.deepEqual(view(layerColumns({ kb: false, vector: false }, false)), {
      kb: '不可用/off',
      rag: '不可用/off',
    });
  });

  it('向量服务不可用 → RAG 是「未知/unknown」而不是「不可用」（不谎报"没建向量"）', () => {
    const cols = layerColumns({ kb: true, vector: false }, true);
    assert.equal(cols.kb.label, '可用');
    assert.equal(cols.rag.label, '未知');
    assert.equal(cols.rag.tone, 'unknown');
    assert.match(cols.rag.title, /未枚举/);
    assert.doesNotMatch(cols.rag.title, /未建/);
  });

  it('scope 不在列表 → 两列都是 — / unknown', () => {
    const cols = layerColumns(undefined, false);
    assert.deepEqual(view(cols), { kb: '—/unknown', rag: '—/unknown' });
  });

  it('两列不得共用同一个对象引用（防一处就地改字段污染另一列）', () => {
    const cols = layerColumns(undefined, false);
    assert.notEqual(cols.kb, cols.rag);
  });
});

describe('wikiWritebackCard（Wiki 回写四态）', () => {
  const DIR = '/data/wiki';

  it('旧 daemon 无数据 → —', () => {
    const card = wikiWritebackCard('demo', false, undefined);
    assert.equal(card.label, '—');
    assert.equal(card.tone, 'muted');
  });

  it('显式配了 wikiSync → 已开启，路径只进 title', () => {
    const ws = { enabled: true, writableDir: DIR, writableFrom: 'wiki-sync' };
    const card = wikiWritebackCard('demo', false, ws);
    assert.equal(card.label, '已开启');
    assert.equal(card.tone, 'ok');
    assert.match(card.title, new RegExp(DIR));
    assert.doesNotMatch(card.label, /\//, 'label 不得含路径');
  });

  it('落点来自导入源 → 已开启 · 导入源（与真正配过 sourceDir 区分开）', () => {
    const ws = { enabled: true, writableDir: '/tmp/upload-123', writableFrom: 'source' };
    const card = wikiWritebackCard('demo', false, ws);
    assert.equal(card.label, '已开启 · 导入源');
    assert.doesNotMatch(card.label, /\//, 'label 不得含路径');
    assert.match(card.title, /导入源目录/);
    assert.match(card.title, /\/tmp\/upload-123/);
  });

  it('开关开着但无可用目录 → ⚠ 无可用目录 + 警示色', () => {
    const ws = { enabled: true, writableDir: null, writableFrom: null, rejectReason: 'source 块不可用' };
    const card = wikiWritebackCard('demo', false, ws);
    assert.equal(card.label, '⚠ 无可用目录');
    assert.equal(card.tone, 'warn');
  });

  it('未配且无导入源 → 未开启', () => {
    const ws = { enabled: false, writableDir: null, writableFrom: null };
    const card = wikiWritebackCard('demo', false, ws);
    assert.equal(card.label, '未开启');
    assert.equal(card.tone, 'muted');
  });

  it('tone 与 describeWikiSync 全等（防两套判定｜资源页同源）', () => {
    const cases = [
      undefined,
      { enabled: true, writableDir: DIR, writableFrom: 'wiki-sync' },
      { enabled: true, writableDir: '/tmp/u', writableFrom: 'source' },
      { enabled: true, writableDir: null, writableFrom: null, rejectReason: 'x' },
      { enabled: false, writableDir: null, writableFrom: null },
      { enabled: false, writableDir: '/tmp/u', writableFrom: 'source' },
    ];
    for (const ws of cases) {
      assert.equal(wikiWritebackCard('demo', false, ws).tone, describeWikiSync(ws).tone);
    }
  });

  it('只读库追加注脚（只读 ⇒ 不回写，唯一例外是 CLI 导入带 --wiki-writeback）', () => {
    const ws = { enabled: true, writableDir: DIR, writableFrom: 'wiki-sync' };
    const ro = wikiWritebackCard('demo', true, ws);
    assert.match(ro.title, /只读库下逐条写入会被拒绝/);
    assert.match(ro.title, /--wiki-writeback/);
    // 可写 / 未知不追加，避免噪声
    assert.doesNotMatch(wikiWritebackCard('demo', false, ws).title, /只读库下/);
    assert.doesNotMatch(wikiWritebackCard('demo', undefined, ws).title, /只读库下/);
  });

  it('旧 daemon（无 wikiSync）也带只读注脚 —— 不知道配没配，不改变只读事实', () => {
    const ro = wikiWritebackCard('demo', true, undefined);
    assert.equal(ro.label, '—');
    assert.match(ro.title, /只读库下逐条写入会被拒绝/);
    // 非只读时不追加
    assert.doesNotMatch(wikiWritebackCard('demo', undefined, undefined).title, /只读库下/);
  });
});

describe('readonlyWikiNote', () => {
  it('含原因、唯一例外与解除命令', () => {
    const note = readonlyWikiNote('demo');
    assert.match(note, /逐条写入会被拒绝/);
    assert.match(note, /--wiki-writeback/);
    assert.match(note, /ki scope readonly demo --off/);
  });

  it('不得声称数据源同步会回写 wiki（资源页已核定它只写 KB 与向量）', () => {
    const note = readonlyWikiNote('demo');
    assert.match(note, /数据源同步只写 KB 与向量，不回写 wiki/);
    assert.doesNotMatch(note, /数据源同步仍可更新并回写/);
  });
});
