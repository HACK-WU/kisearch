/**
 * 根保留键 `__root__` 的**展示口径**（2026-11-04）。
 *
 * 背景：根散文件的 group 在库里存的是 `__root__`（后端 `ROOT_GROUP_KEY`），它只用于存储 ——
 * 用户实测在浏览页页头看到 `__root__ / xxx.md`，要求内部键不出现在任何界面上。
 *
 * ★ 口径分两类（2026-11-04 用户拍板，B 案）：
 *   1. **路径段位置**（`a / b` 拼接、面包屑、徽标、aria）→ 根**整段省略**，
 *      连分隔符一起省，退化成「文档名」—— 根不是目录，写出来等于凭空多一级；
 *   2. **独立字段**（抽屉身份行、来源/引用列表的单独一列、键值对的值）→ 也**不显示**根：
 *      要么整列不渲染（省得留空槽），要么用「根目录」这种描述代替（参数行不能空）。
 *
 * 本测试锁住：
 *   a) `groupPathSegment()`（路径段）与 `groupDisplayName()`（描述）两个映射函数的语义；
 *   b) `mergeGroupSourcePath()`：根不贡献路径段（与后端 `doc-path.logicalDocPath` 同口径）；
 *   c) 任务详情「Group」参数行的取值；
 *   d) 已知出口的源码不得再裸渲染 group、也不得再用「根」当路径段。
 *
 * 运行：cd web && npm test
 */
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
const { ROOT_GROUP_KEY, ROOT_GROUP_FIELD_LABEL, groupDisplayName, groupPathSegment } = await vite.ssrLoadModule('/src/lib/rootGroup.ts');
const { buildDataSourceDetail } = await vite.ssrLoadModule('/src/lib/dataSourceDetailModel.ts');
const { mergeGroupSourcePath } = await vite.ssrLoadModule('/src/lib/dataSourceDetailModel.ts');
const { buildTaskDetail } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');
const { docDisplayPath } = await vite.ssrLoadModule('/src/lib/browseSearchGroups.ts');
const { sourceRefTitle } = await vite.ssrLoadModule('/src/chat/format.ts');

after(async () => { await vite.close(); });

const read = (relative) => fs.readFileSync(path.join(webRoot, relative), 'utf8');

describe('groupPathSegment：根不贡献路径段', () => {
  it('根 → 空串（调用方 filter(Boolean) 后自然只剩文档名）', () => {
    assert.equal(groupPathSegment(ROOT_GROUP_KEY), '');
    assert.equal(groupPathSegment('__root__'), '');
  });

  it('普通组原样（多级路径不拆）', () => {
    assert.equal(groupPathSegment('wiki/部署运维'), 'wiki/部署运维');
    assert.equal(groupPathSegment('docs'), 'docs');
  });

  it('空值 → 空串，不渲染 undefined / null', () => {
    assert.equal(groupPathSegment(undefined), '');
    assert.equal(groupPathSegment(null), '');
    assert.equal(groupPathSegment(''), '');
  });

  it('近似但不相同的键不被误判（逐字比较，不做前缀/包含匹配）', () => {
    assert.equal(groupPathSegment('__root__x'), '__root__x');
    assert.equal(groupPathSegment('root'), 'root');
    assert.equal(groupDisplayName('__root__x'), '__root__x');
    assert.equal(groupDisplayName('root'), 'root');
  });
});

describe('groupDisplayName：仅用于"描述"位置', () => {
  it('根 → 「根」（只在不能空着的位置使用，如参数值兜底）', () => {
    assert.equal(groupDisplayName(ROOT_GROUP_KEY), '根');
  });

  it('空值 → 空串', () => {
    assert.equal(groupDisplayName(undefined), '');
    assert.equal(groupDisplayName(''), '');
  });
});

describe('mergeGroupSourcePath：根不贡献路径段', () => {
  it('根 + sourcePath → 只留 sourcePath', () => {
    assert.equal(mergeGroupSourcePath(ROOT_GROUP_KEY, 'a.md', 'a'), 'a.md');
    assert.equal(mergeGroupSourcePath(ROOT_GROUP_KEY, 'sub/a.md', 'a'), 'sub/a.md');
  });

  it('根 + 无 sourcePath → 退回文档名（不出现 __root__）', () => {
    assert.equal(mergeGroupSourcePath(ROOT_GROUP_KEY, undefined, 'a.md'), 'a.md');
  });

  it('普通组行为不变（sourcePath 已含 group 前缀 → 不重复补）', () => {
    assert.equal(mergeGroupSourcePath('aiops/rca', 'aiops/rca/x.md', 'x.md'), 'aiops/rca/x.md');
    assert.equal(mergeGroupSourcePath('wiki/API文档', 'API文档/x.md', 'x.md'), 'wiki/API文档/x.md');
    assert.equal(mergeGroupSourcePath('wiki/API文档', undefined, 'x.md'), 'wiki/API文档/x.md');
  });
});

describe('检索结果路径 / 对话来源标题：根整段省略', () => {
  it('docDisplayPath 兜底到 group 时，根 → 空串', () => {
    assert.equal(docDisplayPath({ group: ROOT_GROUP_KEY }), '');
    assert.equal(docDisplayPath({ group: ROOT_GROUP_KEY, path: 'a.md' }), 'a.md');
    assert.equal(docDisplayPath({ group: 'g' }), 'g');
  });

  it('sourceRefTitle 根 → `doc · 行号`，不留空槽也不出现 __root__', () => {
    assert.equal(sourceRefTitle({ doc: 'a.md', group: ROOT_GROUP_KEY, lineStart: 5, lineEnd: 8 }), 'a.md · L5-8');
    assert.equal(sourceRefTitle({ doc: 'a.md', group: ROOT_GROUP_KEY, lineStart: 0, lineEnd: 0 }), 'a.md');
    assert.equal(sourceRefTitle({ doc: 'a.md', group: 'wiki/x', lineStart: 5, lineEnd: 8 }), 'a.md · wiki/x · L5-8');
  });
});

describe('数据源「落点 Group」：不泄漏内部键', () => {
  it('根 → 「根目录」（列/参数不能空着），普通组原样，未设置 → 自动派生说明', () => {
    assert.equal(ROOT_GROUP_FIELD_LABEL, '根目录');
    const pick = (record) => buildDataSourceDetail(record).params.find((row) => row.label === '落点 Group')?.value;
    assert.equal(pick({ scope: 'kafka', type: 'git', dir: '/tmp/x', group: ROOT_GROUP_KEY }), '根目录');
    assert.equal(pick({ scope: 'kafka', type: 'git', dir: '/tmp/x', group: 'wiki/x' }), 'wiki/x');
    assert.equal(pick({ scope: 'kafka', type: 'git', dir: '/tmp/x' }), '自动：按顶层子目录');
  });
});

describe('任务详情「Group」参数行：不泄漏内部键', () => {
  const base = {
    id: 't1',
    operation: 'datasource-sync',
    scope: 'kafka',
    source: 'web',
    state: 'failed',
    createdAt: 1_792_558_513_966,
  };

  it('根 → 「根目录」（参数行不能空着，也不能回显 __root__）', () => {
    const view = buildTaskDetail({
      ...base,
      params: { group: ROOT_GROUP_KEY, conflictMode: 'incremental', vector: true, sourceKind: 'git' },
    });
    const row = view.params.find((item) => item.label === 'Group');
    assert.ok(row, '应存在 Group 参数行');
    assert.equal(row.value, '根目录');
    assert.ok(!JSON.stringify(view).includes('__root__'), '整份详情都不应出现 __root__');
  });

  it('普通组原样显示', () => {
    const view = buildTaskDetail({
      ...base,
      params: { group: 'wiki/部署运维', conflictMode: 'incremental', vector: true, sourceKind: 'git' },
    });
    assert.equal(view.params.find((item) => item.label === 'Group').value, 'wiki/部署运维');
  });
});

describe('已知出口的源码守卫', () => {
  const FILES = [
    'src/pages/BrowsePage.tsx',
    'src/pages/SearchPage.tsx',
    'src/components/ModuleDrawer.tsx',
    'src/components/GroupTreePanel.tsx',
    'src/components/ReaderLinkComposer.tsx',
    'src/chat/ChatPanel.tsx',
    'src/chat/SourcesList.tsx',
    'src/lib/taskDetailModel.ts',
    'src/lib/dataSourceDetailModel.ts',
    'src/lib/browseSearchGroups.ts',
    'src/chat/format.ts',
    'src/components/DocumentEditor.tsx',
    'src/pages/ImportPage.tsx',
    'src/pages/DataSourcePage.tsx',
  ];

  for (const file of FILES) {
    it(`${file} 引入了 rootGroup 映射`, () => {
      assert.match(read(file), /from '[^']*(?:rootGroup|groupTree)'/,
        '应 import groupPathSegment / groupDisplayName / isRootGroup，别自己拼一份');
    });
  }

  it('页头路径：根组整段省略（含分隔符），不是显示「根」', () => {
    const src = read('src/pages/BrowsePage.tsx');
    assert.match(src, /const headGroup = groupPathSegment\(currentViewing\?\.group\)/,
      '页头 Group 段必须走 groupPathSegment（根 → 空）');
    assert.match(src, /\{headGroup \? \(/, 'group span 与「/」必须随 headGroup 条件渲染');
    assert.doesNotMatch(src, /\{currentViewing\.group\}<\/span>/, '不得裸渲染内部键');
  });

  it('抽屉 / 来源 / 引用 / 选择器 / 编辑器 / 检索命中 不得裸渲染 group', () => {
    assert.doesNotMatch(read('src/components/ModuleDrawer.tsx'), /<span className="ki-drawer__path">\{group\}/);
    assert.doesNotMatch(read('src/chat/SourcesList.tsx'), /\{s\.group\}<\/span>/);
    assert.doesNotMatch(read('src/chat/ChatPanel.tsx'), /\{r\.group\}<\/span>/);
    assert.doesNotMatch(read('src/components/ReaderLinkComposer.tsx'), /\{d\.group\}<\/span>|\{selectedDoc\.group\}<\/small>/);
    assert.doesNotMatch(read('src/components/DocumentEditor.tsx'), /<small>\{group\}<\/small>/);
    assert.doesNotMatch(read('src/pages/BrowsePage.tsx'), /ki-browse-fulltext__path">\{group\}/);
    assert.doesNotMatch(read('src/pages/DataSourcePage.tsx'), /\{source\.group \?\? '\(自动\)'\}/);
  });

  it('路径段位置不得再用 groupDisplayName（那是「根」描述用的）', () => {
    for (const file of [
      'src/pages/BrowsePage.tsx',
      'src/pages/SearchPage.tsx',
      'src/components/ModuleDrawer.tsx',
      'src/components/GroupTreePanel.tsx',
      'src/components/ReaderLinkComposer.tsx',
      'src/chat/SourcesList.tsx',
      'src/chat/ChatPanel.tsx',
    ]) {
      assert.doesNotMatch(read(file), /groupDisplayName\(/, `${file} 的路径/字段展示应改用 groupPathSegment`);
    }
  });
});
