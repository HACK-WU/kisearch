/**
 * isFullTextContent 判定测试 —— search 输出的 isFullText 字段
 *
 * 契约：content 纯化后摘要类写入方（scan-kb import / rebuild-vector）不再加
 * `[摘要]` 前缀，兜底恒为 true（用户直传原文）；仅旧数据（曾以 `[摘要]` 开头）
 * 判定为摘要。isFullText 主判定走 relations-cache 反查的 rel.isFullText 标记，
 * 本函数仅为未命中反查时的前缀推断兜底。
 *
 * 运行：npx jiti test/search-is-full-text.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFullTextContent } from '../src/search.js';

describe('isFullTextContent', () => {
  it('旧数据格式（[摘要] 前缀）→ 非全文', () => {
    const content = '[摘要] 本文件面向钉钉集成\n[关键词] 钉钉\n[路径] docs/dingtalk.md';
    assert.strictEqual(isFullTextContent(content), false);
  });

  it('纯化后无 [摘要] 前缀 → 全文（兜底恒 true）', () => {
    const content = '本技术文档围绕监控平台，介绍仪表板架构设计…';
    assert.strictEqual(isFullTextContent(content), true);
  });

  it('sync-relation 格式（moduleInfo 全文）→ 全文', () => {
    const content = '# 钉钉集成\n\n本文档介绍钉钉通知渠道的集成方式…\n\n[关键词] 钉钉集成';
    assert.strictEqual(isFullTextContent(content), true);
  });

  it('ki store 用户输入 → 全文', () => {
    const content = '告警收敛策略：在 5 分钟内相同告警仅通知一次';
    assert.strictEqual(isFullTextContent(content), true);
  });

  it('空字符串/仅摘要标记 → 非全文', () => {
    assert.strictEqual(isFullTextContent('[摘要] '), false);
    assert.strictEqual(isFullTextContent('[摘要]'), false);
  });
});
