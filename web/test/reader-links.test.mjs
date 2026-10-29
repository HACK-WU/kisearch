import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const { externalTarget, insertReaderLink } = await vite.ssrLoadModule('/src/lib/readerLinks.ts');
const { anchorKind, encodeKiLink, paragraphAnchor, parseKiLink } = await vite.ssrLoadModule('/src/lib/kiLinks.ts');
after(async () => vite.close());

describe('reader link insertion', () => {
  const target = { v: 1, type: 'document', scope: 'docs', group: 'guide', relation: 'deploy', anchor: paragraphAnchor('p', '目标段落') };

  it('wraps the uniquely selected reader text while preserving surrounding Markdown', () => {
    const source = '# 学习档案\n\n参阅部署指南中的目标段落。';
    const result = insertReaderLink(source, '目标段落', target);
    assert.equal(result, `# 学习档案\n\n参阅部署指南中的[目标段落](${encodeKiLink(target)})。`);
  });

  it('rejects ambiguous or non-contiguous rendered text before saving', () => {
    assert.throws(() => insertReaderLink('目标段落和目标段落', '目标段落', target), /无法唯一定位/);
    assert.throws(() => insertReaderLink('**目标**段落', '目标段落', target), /无法唯一定位/);
  });

  it('escapes Markdown label punctuation', () => {
    const source = '请阅读[目标]章节。';
    const result = insertReaderLink(source, '[目标]', target);
    assert.ok(result.includes(`[\\[目标\\]](${encodeKiLink(target)})`));
  });
});

describe('external url input', () => {
  it('accepts bare hosts and https urls', () => {
    assert.equal(externalTarget('example.com/docs').url, 'https://example.com/docs');
    assert.equal(externalTarget('http://localhost:8080/a').url, 'http://localhost:8080/a');
  });

  it('rejects text that is not a reachable http(s) host', () => {
    for (const bad of ['', 'not a url', 'notaurl', 'ftp://example.com', 'example .com']) {
      assert.throws(() => externalTarget(bad), /网址|空格/, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe('anchor format contract', () => {
  // 写入侧与阅读侧共用 paragraphAnchor；哈希位数一旦与 ANCHOR_PATTERN 脱节，
  // parseKiLink 会静默丢掉 anchor，链接退化成「只跳文档不跳段落」。
  it('round-trips every selectable block kind through encode/parse', () => {
    const tags = { P: 'p', H2: 'h', LI: 'li', TD: 'td', TH: 'th' };
    for (const [tag, kind] of Object.entries(tags)) {
      assert.equal(anchorKind({ tagName: tag }), kind, `anchorKind(${tag})`);
      const anchor = paragraphAnchor(kind, '同一段文字');
      assert.match(anchor, new RegExp(`^${kind}-[0-9a-f]{16}$`), anchor);
      const target = { v: 1, type: 'document', scope: 'kafka', group: 'g', relation: 'r', anchor };
      assert.deepEqual(parseKiLink(encodeKiLink(target)), target);
    }
  });

  it('keeps anchors stable for the same text and distinct across block kinds', () => {
    assert.equal(paragraphAnchor('p', '  部署前  确认配置 '), paragraphAnchor('p', '部署前 确认配置'));
    assert.notEqual(paragraphAnchor('p', '部署前确认配置'), paragraphAnchor('h', '部署前确认配置'));
    assert.notEqual(paragraphAnchor('p', '部署前确认配置'), paragraphAnchor('p', '部署后确认配置'));
  });

  it('drops a malformed anchor instead of jumping to the wrong block', () => {
    const truncated = `ki-link:${encodeURIComponent(JSON.stringify({ v: 1, type: 'document', scope: 'kafka', group: 'g', relation: 'r', anchor: 'p-abc' }))}`;
    assert.equal(parseKiLink(truncated), null);
  });

  it('keeps parsing links written before list and table anchors existed', () => {
    const legacy = { v: 1, type: 'document', scope: 'kafka', group: 'g', relation: 'r', anchor: paragraphAnchor('h', '历史标题') };
    assert.deepEqual(parseKiLink(encodeKiLink(legacy)), legacy);
    const docOnly = { v: 1, type: 'document', scope: 'kafka', group: 'g', relation: 'r' };
    assert.deepEqual(parseKiLink(encodeKiLink(docOnly)), docOnly);
    const external = { v: 1, type: 'external', url: 'https://example.com/a' };
    assert.deepEqual(parseKiLink(encodeKiLink(external)), external);
  });
});
