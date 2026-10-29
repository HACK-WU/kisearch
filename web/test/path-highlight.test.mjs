/**
 * 路径检索的展示层单测（2026-10-20）
 *
 * 锁住五条不变量：
 *   1) 高亮区间落在**原文**下标上（含空格 / 大小写混排时也能画对），且只标首个命中；
 *   2) 归一化口径与后端一致：`\`、全角 `／`、分隔符两侧空白、重复分隔符、`./` 与前导 `/` 等价；
 *   3) 不命中 / 空检索词 → null（调用方原样渲染，不得高亮整条）；
 *   4) 命中分区：`matchedBy` 缺省（旧 daemon）一律归名称命中，不丢结果；
 *   5) 结果头分开计数，禁止把名称/路径与正文相加成一个"总数"。
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
const { findPathHighlightRange, normalizeQueryForMatch } = await vite.ssrLoadModule('/src/lib/pathHighlight.ts');
const {
  docDisplayPath,
  hasNameOrPathHit,
  hasSearchTerm,
  searchResultSummary,
  splitSearchDocs,
} = await vite.ssrLoadModule('/src/lib/browseSearchGroups.ts');
after(async () => vite.close());

const textOf = (text, range) => text.slice(range.start, range.end);

describe('normalizeQueryForMatch', () => {
  it('反斜杠 / 全角斜杠 / 分隔符空白 / 重复分隔符 / ./ 前缀 等价', () => {
    const expected = 'wiki/api接口文档/认证.md';
    for (const raw of [
      'wiki/api接口文档/认证.md',
      'wiki\\api接口文档\\认证.md',
      'wiki／api接口文档／认证.md',
      '  wiki / api接口文档 / 认证.md ',
      'wiki//api接口文档////认证.md',
      './wiki/api接口文档/认证.md',
      '/wiki/api接口文档/认证.md',
    ]) {
      assert.equal(normalizeQueryForMatch(raw), expected, `raw=${JSON.stringify(raw)}`);
    }
  });

  it('只有分隔符 / 空白 → 空串', () => {
    for (const raw of ['', '/', '//', '\\', '  ', '\u3000']) {
      assert.equal(normalizeQueryForMatch(raw), '');
    }
  });
});

describe('findPathHighlightRange', () => {
  it('原文含空格时区间仍落在原文上（页头 `group / module` 形态）', () => {
    const text = 'wiki / API接口文档 / API认证与授权.md';
    const range = findPathHighlightRange(text, 'wiki / API接口文档 / API认证与授权');
    assert.deepEqual(range, { start: 0, end: text.length - '.md'.length });
    assert.equal(textOf(text, range), 'wiki / API接口文档 / API认证与授权');
  });

  it('中间段命中：只标高亮区间，前后的路径文字保留', () => {
    const text = 'langchain/projects/智能客服助手/实现/data/kb/a.md';
    const range = findPathHighlightRange(text, '智能客服助手');
    assert.equal(textOf(text, range), '智能客服助手');
    assert.ok(range.start > 0 && range.end < text.length);
  });

  it('大小写不敏感、反斜杠检索词也能命中', () => {
    const text = 'AI Agent技能/SKILL.md';
    assert.equal(textOf(text, findPathHighlightRange(text, 'skill.md')), 'SKILL.md');
    const slash = findPathHighlightRange(text, 'AI Agent技能\\SKILL.md');
    assert.equal(textOf(text, slash), 'AI Agent技能/SKILL.md');
  });

  it('不命中 / 空检索词 → null', () => {
    assert.equal(findPathHighlightRange('wiki/a.md', 'nope'), null);
    assert.equal(findPathHighlightRange('wiki/a.md', '   '), null);
    assert.equal(findPathHighlightRange('', 'wiki'), null);
  });

  it('重复分隔符的原文归一后仍可命中', () => {
    const text = 'wiki//a.md';
    const range = findPathHighlightRange(text, 'wiki/a.md');
    assert.ok(range, '归一后应命中');
    assert.equal(textOf(text, range), 'wiki//a.md');
  });
});

describe('splitSearchDocs / 摘要', () => {
  const docs = [
    { name: 'a', group: 'g', matchedBy: 'name' },
    { name: 'b', group: 'g', matchedBy: 'path' },
    { name: 'c', group: 'g' },
  ];

  it('按 matchedBy 拆分；缺省归名称命中（旧 daemon 降级不丢结果）', () => {
    const { nameHits, pathHits } = splitSearchDocs(docs);
    assert.deepEqual(nameHits.map((d) => d.name), ['a', 'c']);
    assert.deepEqual(pathHits.map((d) => d.name), ['b']);
  });

  it('hasNameOrPathHit：两边都空才是"没有名称/路径命中"', () => {
    assert.equal(hasNameOrPathHit({ nameHits: [], pathHits: [] }), false);
    assert.equal(hasNameOrPathHit({ nameHits: [1], pathHits: [] }), true);
    assert.equal(hasNameOrPathHit({ nameHits: [], pathHits: [1] }), true);
  });

  it('摘要分开计数，不相加成总数（路径 0 命中不得被正文条数掩盖）', () => {
    assert.equal(searchResultSummary({ name: 0, path: 0, fullText: 20 }), '名称 0 · 路径 0 · 正文 20');
    assert.equal(searchResultSummary({ name: 1, path: 2, fullText: 0 }), '名称 1 · 路径 2 · 正文 0');
  });
});

describe('docDisplayPath / hasSearchTerm', () => {
  it('优先后端 logicalPath，其次 sourcePath，最后 group', () => {
    assert.equal(docDisplayPath({ group: 'g', path: 'p.md', logicalPath: 'g/p.md' }), 'g/p.md');
    assert.equal(docDisplayPath({ group: 'g', path: 'p.md' }), 'p.md');
    assert.equal(docDisplayPath({ group: 'g' }), 'g');
  });

  it('只由分隔符/空白组成 → 无有效检索词（不发请求）', () => {
    for (const raw of ['', '   ', '/', '\\', '/ /']) assert.equal(hasSearchTerm(raw), false, JSON.stringify(raw));
    for (const raw of ['a', '组/文档', '.md', '*']) assert.equal(hasSearchTerm(raw), true, JSON.stringify(raw));
  });
});
