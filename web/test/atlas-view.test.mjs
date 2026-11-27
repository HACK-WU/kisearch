import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const { resolveAtlasView, atlasMemberNote, toAtlasProbes } = await vite.ssrLoadModule(
  '/src/lib/atlasTargets.ts',
);
after(async () => vite.close());

/** 探针构造器：failed 默认 false，避免每个用例都写一长串 */
const probe = (scope, exists, uploadedAt, failed = false) => ({ scope, exists, uploadedAt, failed });

describe('视图下知识地图的取数判定', () => {
  it('0 个装：members 为空，页面走空态而不是白屏', () => {
    const shape = resolveAtlasView([probe('a', false), probe('b', false)], null);
    assert.deepEqual(shape.members, []);
    assert.deepEqual(shape.absent, ['a', 'b']);
    assert.equal(shape.selected, null);
  });

  it('1 个装：直出该成员（顶栏据此不摆切换器）', () => {
    const shape = resolveAtlasView(
      [probe('a', false), probe('b', true, '2026-11-20T00:00:00Z')],
      null,
    );
    assert.deepEqual(shape.members, ['b']);
    assert.equal(shape.selected, 'b');
  });

  it('2 个装且没有记忆：默认最近上传的那份，但列表保持成员顺序', () => {
    const shape = resolveAtlasView(
      [
        probe('a', true, '2026-11-20T00:00:00Z'),
        probe('b', true, '2026-11-25T00:00:00Z'),
      ],
      null,
    );
    assert.deepEqual(shape.members, ['a', 'b']);
    assert.equal(shape.selected, 'b');
  });

  it('记忆的成员仍可用时优先它 —— 不被「最近上传」抢走', () => {
    const shape = resolveAtlasView(
      [
        probe('a', true, '2026-11-20T00:00:00Z'),
        probe('b', true, '2026-11-25T00:00:00Z'),
      ],
      'a',
    );
    assert.equal(shape.selected, 'a');
  });

  it('记忆的成员已被移出视图时静默回落（视图成员会被改）', () => {
    const shape = resolveAtlasView([probe('a', true, '2026-11-20T00:00:00Z')], 'gone');
    assert.equal(shape.selected, 'a');
  });

  it('读取失败单独成桶，不与「未配置」混在一起', () => {
    const shape = resolveAtlasView(
      [probe('a', false), probe('b', false, undefined, true)],
      null,
    );
    assert.deepEqual(shape.absent, ['a']);
    assert.deepEqual(shape.failed, ['b']);
    assert.equal(atlasMemberNote(shape), '另有 1 个成员库未配置图集 · 1 个成员库读取失败');
  });

  it('1 个有图集 + 1 个读取失败：失败桶照旧产出（页面直出，但提示不能丢）', () => {
    const shape = resolveAtlasView(
      [probe('a', true, '2026-11-25T00:00:00Z'), probe('b', false, undefined, true)],
      null,
    );
    assert.deepEqual(shape.members, ['a']);
    assert.deepEqual(shape.failed, ['b']);
    assert.equal(shape.selected, 'a');
    // 顶栏靠这条 note 才能让「读失败」在只有 1 份图集时仍然可见
    assert.equal(atlasMemberNote(shape), '1 个成员库读取失败');
  });

  it('缺 uploadedAt 时按成员顺序首个，不因 NaN 乱选', () => {
    const mixed = resolveAtlasView(
      [probe('a', true), probe('b', true, '2026-11-25T00:00:00Z')],
      null,
    );
    assert.equal(mixed.selected, 'b');
    const bothMissing = resolveAtlasView([probe('a', true), probe('b', true)], null);
    assert.equal(bothMissing.selected, 'a');
  });

  it('note 没有可说的内容时为 null（切换器不渲染空行）', () => {
    const shape = resolveAtlasView([probe('a', true), probe('b', true)], null);
    assert.equal(atlasMemberNote(shape), null);
  });

  it('toAtlasProbes 把 isError 映射成 failed（页面与顶栏共用同一输入）', () => {
    const probes = toAtlasProbes([
      { scope: 'a', isError: true, exists: false, isPending: false, error: null },
      { scope: 'b', isError: false, exists: true, uploadedAt: '2026-11-25T00:00:00Z', isPending: false, error: null },
    ]);
    assert.deepEqual(probes, [
      { scope: 'a', kind: 'main', mainScope: 'a', failed: true, exists: false, uploadedAt: undefined },
      { scope: 'b', kind: 'main', mainScope: 'b', failed: false, exists: true, uploadedAt: '2026-11-25T00:00:00Z' },
    ]);
  });
});

describe('视图分支的静态守卫（防回归）', () => {
  const pageSrc = fs.readFileSync(path.join(webRoot, 'src/pages/AtlasPage.tsx'), 'utf8');
  const headerSrc = fs.readFileSync(path.join(webRoot, 'src/components/AtlasHeaderActions.tsx'), 'utf8');

  it('视图出图用成员库名，不能把视图名塞进 /api/atlas/view', () => {
    assert.ok(
      pageSrc.includes('/api/atlas/view?scope=${encodeURIComponent(member)}'),
      '视图分支的 iframe src 必须用 member（视图名在 atlas/view 上恒 404）',
    );
  });

  it('视图空态给「先切到成员库」的引导，而不是 --scope <视图名>', () => {
    assert.ok(
      pageSrc.includes('ki atlas upload --scope &lt;成员库&gt; --file dist/atlas.zip'),
      '视图空态的命令模板必须占位成成员库（视图名在 /open/v1 上必被 400 拒）',
    );
  });

  it('顶栏摆出条件：0 个不摆，1 个且无失败才不摆（1 个 + 有失败必须摆）', () => {
    assert.ok(
      headerSrc.includes('if (shape.members.length === 0) return <></>'),
      '0 份时必须不摆（页面已是整幅错误卡）',
    );
    assert.ok(
      headerSrc.includes('if (shape.members.length === 1 && shape.failed.length === 0) return <></>'),
      '只有「1 份且无失败」才静默；有失败时摆出来，否则失败信息无处可见',
    );
  });

  it('顶栏切换器在只读早退之前判定（只读账号也要能切成员）', () => {
    const viewAt = headerSrc.indexOf('if (targets.isView)');
    const canWriteAt = headerSrc.indexOf('if (!canWrite || statusUnavailable)');
    assert.ok(viewAt > 0, '缺少视图分支');
    assert.ok(canWriteAt > viewAt, `视图分支必须在 canWrite 早退之前（${viewAt} / ${canWriteAt}）`);
  });

  it('单库路径不再保留独立的 useAtlasStatus 调用（改由 useAtlasTargets 统一装配）', () => {
    assert.ok(!headerSrc.includes('useAtlasStatus('), '顶栏不应再单独查视图名，否则视图下会多发一次无效请求');
  });
});