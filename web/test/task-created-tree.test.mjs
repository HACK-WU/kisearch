/**
 * 任务/数据源详情「新增的文档」目录树 —— 根散文档不得丢（2026-11-09 现场）
 *
 * 现场：`archive.md` 落在知识库根（group=`__root__`），任务详情卡片「新增的文档 1 篇」
 * 下方渲染空白 —— `mergeGroupSourcePath` 会把 `__root__` 摘成空串（这是对的，否则树上
 * 会多一个叫「__root__」的目录），但建树时 `segments.slice(0,-1)` 为空数组，
 * `ensureDir([])` 返回 null，代码随即 `continue` 把这条**文件**丢了。
 *
 * 锁住的不变量：
 *   1) 根散文档（group 为保留键）必须作为顶层文件节点出现，不能被丢弃；
 *   2) 根散 + 子目录混排时，两类都在，且目录的 total 只数自己的子文件；
 *   3) 顶层文件节点保留原 group（点击可开正文，不能改写成 `__root__` 之外的假分组）。
 *
 * 运行：cd web && npm test
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
const { buildDataSourcePendingTree } = await vite.ssrLoadModule('/src/lib/dataSourceDetailModel.ts');

after(async () => { await vite.close(); });

describe('新增的文档目录树：根散文档', () => {
  it('单篇根散文档（__root__/archive）必须出现在树里', () => {
    const nodes = buildDataSourcePendingTree([{ group: '__root__', relation: 'archive' }]);
    assert.equal(nodes.length, 1, '根散文档不能被丢弃（否则卡片渲染空白）');
    assert.equal(nodes[0].kind, 'file');
    assert.equal(nodes[0].name, 'archive');
    assert.deepEqual(nodes[0].item, { group: '__root__', relation: 'archive' });
  });

  it('根散 + 子目录混排：两类都在，目录 total 只数自己的文件', () => {
    const nodes = buildDataSourcePendingTree([
      { group: '__root__', relation: 'PROJECT' },
      { group: '__root__', relation: 'INDEX' },
      { group: 'sub', relation: 'child' },
      { group: 'sub/deep', relation: 'leaf' },
    ]);
    const rootFiles = nodes.filter((node) => node.kind === 'file');
    const dirs = nodes.filter((node) => node.kind === 'dir');
    assert.equal(rootFiles.length, 2, '两篇根散文档都要在顶层');
    assert.equal(dirs.length, 1, '子目录仍应合并成一个节点');
    assert.equal(dirs[0].name, 'sub');
    assert.equal(dirs[0].total, 2, 'sub 下共 2 篇（child + deep/leaf）');
    assert.equal(dirs[0].direct, 1, 'sub 直属 1 篇（child）');
  });

  it('根散文档的 group 保持原值（点击打开正文时后端要认这个键）', () => {
    const nodes = buildDataSourcePendingTree([{ group: '__root__', relation: 'archive' }]);
    assert.equal(nodes[0].item?.group, '__root__');
  });
});
