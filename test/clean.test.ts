/**
 * clean.ts 数据清洗测试 —— REQ-20260807-001 批次 1
 *
 * 契约：
 *   - 7 条内置规则（BOM/frontmatter/htmlComment/mermaid/codeBlock/codePath/空行折叠）
 *   - 执行顺序约束：代码块先剥离 → 路径剥离仅代码块外（短示例整体保留不被路径破坏）
 *   - 行号引用（#L490-L510 含 -L510 兜底）、空 inline code、孤儿标题清理
 *   - parseCleanRules 解析 --clean-rules
 *
 * 运行：npx jiti test/clean.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMarkdownText, parseCleanRules, CLEAN_VERSION, DEFAULT_CLEAN_RULES } from '../src/lib/clean.js';

describe('cleanMarkdownText — BOM', () => {
  it('剥离 UTF-8 BOM', () => {
    assert.strictEqual(cleanMarkdownText('\uFEFF标题内容'), '标题内容');
  });
});

describe('cleanMarkdownText — frontmatter', () => {
  it('剥离 YAML frontmatter 整块（含 title/date/tags）', () => {
    const doc = ['---', 'title: 测试', 'date: 2026-08-08', 'tags: [demo]', '---', '', '# 正文'].join('\n');
    const out = cleanMarkdownText(doc);
    assert.ok(!out.includes('title: 测试'));
    assert.ok(out.includes('# 正文'));
  });

  it('正文以 --- 开头但非 frontmatter（无键值对特征）不误剥', () => {
    const doc = ['---', '这是一段正文分隔线', '---', '', '内容'].join('\n');
    const out = cleanMarkdownText(doc);
    assert.ok(out.includes('这是一段正文分隔线'));
  });

  it('闭合 --- 后跟非换行内容（---important）不误判为闭合', () => {
    const doc = ['---', 'title: 测试', '---important', '内容'].join('\n');
    const out = cleanMarkdownText(doc);
    assert.ok(out.includes('内容'));
  });
});

describe('cleanMarkdownText — 去噪', () => {
  it('剥离 HTML 注释', () => {
    assert.strictEqual(cleanMarkdownText('正文<!-- 注释 -->结尾'), '正文结尾');
  });

  it('剥离 mermaid 块', () => {
    const doc = ['标题', '', '```mermaid', 'graph TD;', '  A-->B;', '```', '', '正文'].join('\n');
    const out = cleanMarkdownText(doc);
    assert.ok(!out.includes('mermaid'));
    assert.ok(!out.includes('graph TD'));
    assert.ok(out.includes('正文'));
  });

  it('剥离长代码块，保留短示例（keepShortSamples）', () => {
    const longLines = ['```python'].concat(Array(18).fill('# 很长')).concat(['```']);
    const doc = [
      '标题', '',
      ...longLines, '',
      '```bash', 'curl -X POST http://example.com/api', 'echo done', '```', '',
      '结尾',
    ].join('\n');
    const out = cleanMarkdownText(doc, { keepShortSamples: true });
    // 长代码块剥离（18 行 > 17 行阈值）
    assert.ok(!out.includes('# 很长'));
    // 短示例保留
    assert.ok(out.includes('curl -X POST'));
  });

  it('剥离行号引用（#L188-L605、#L490-L510 含 -L510）', () => {
    assert.strictEqual(cleanMarkdownText('参考 serializers.py#L109'), '参考 serializers.py');
    assert.strictEqual(cleanMarkdownText('见 a.py#L490-L510'), '见 a.py');
    assert.strictEqual(cleanMarkdownText('残留 -L510'), '残留');
  });

  it('剥离含目录层级的裸代码路径，保留单文件名', () => {
    assert.ok(!cleanMarkdownText('路径 bkmonitor/urls.py 引用').includes('bkmonitor/urls.py'));
    assert.ok(cleanMarkdownText('参见 README.md 的用法').includes('README.md'));
  });

  it('清理空 inline code 残留与孤儿标题（引用清单整块删除）', () => {
    const doc = ['**本文引用的文件**:', '- `bkmonitor/a.py`', '- `bkmonitor/b.py`', '', '# 正文'].join('\n');
    const out = cleanMarkdownText(doc);
    assert.ok(!out.includes('本文引用的文件'));
    assert.ok(!out.includes('`'));
    assert.ok(out.includes('# 正文'));
  });

  it('折叠 3+ 连续空行为 2 个', () => {
    assert.strictEqual(cleanMarkdownText('a\n\n\n\n\nb'), 'a\n\nb');
  });
});

describe('cleanMarkdownText — 执行顺序约束（代码块先剥 → 路径仅代码块外）', () => {
  it('短 bash 示例（含路径）不被路径剥离破坏', () => {
    const doc = [
      '标题', '',
      '正文引用 src/lib/import.ts 的路径。', '',
      '```bash', 'curl -X POST http://example.com/api/v1', 'echo /usr/bin/python3', '```', '',
      '结尾',
    ].join('\n');
    const out = cleanMarkdownText(doc, { keepShortSamples: true });
    // 短示例内容完整保留（含 URL 与路径）
    assert.ok(out.includes('curl -X POST http://example.com/api/v1'));
    assert.ok(out.includes('/usr/bin/python3'));
    // 正文路径已剥
    assert.ok(!out.includes('src/lib/import.ts'));
  });
});

describe('parseCleanRules', () => {
  it('空/未传 → undefined（用默认）', () => {
    assert.strictEqual(parseCleanRules(undefined), undefined);
    assert.strictEqual(parseCleanRules(''), undefined);
  });

  it('解析逗号分隔规则', () => {
    const rules = parseCleanRules('bom,frontmatter,mermaid');
    assert.deepStrictEqual(rules, { bom: true, frontmatter: true, mermaid: true });
  });

  it('未知规则名忽略', () => {
    const rules = parseCleanRules('bom,unknown,codePath');
    assert.deepStrictEqual(rules, { bom: true, codePath: true });
  });
});

describe('常量', () => {
  it('CLEAN_VERSION 非空', () => {
    assert.ok(CLEAN_VERSION.length > 0);
  });
  it('DEFAULT_CLEAN_RULES 全开', () => {
    assert.ok(DEFAULT_CLEAN_RULES.bom);
    assert.ok(DEFAULT_CLEAN_RULES.codePath);
    assert.ok(DEFAULT_CLEAN_RULES.codeBlock);
  });
});
