/**
 * 检索页地址栏清理单测（lib/searchUrlCleanup.ts）
 *
 * 背景（2026-10-14 用户裁决）：语义检索页**不再用 URL 记录检索态** —— 输入框清空后地址栏不该
 * 留 `q`，刷新就是干净的当页页面。原先的「检索态 ⇄ URL」双向同步（parseSearchUrl /
 * searchUrlSearch）随之删除，本模块只剩「旧链接清理」。锁住四条不变量：
 *   1) 旧版检索参数（q/mode/tags/threshold/limit）一律清掉；
 *   2) `scope` 与当前 scope 一致（跨页深链入口）→ 保留；不一致（用户手动切过 scope）→ 清掉；
 *   3) 其它参数（如 AI 面板的 `chat=1`、全屏的 `reader=1`）原样保留；
 *   4) 无需改动时返回 null —— 调用方据此跳过写回，不产生无谓的 replace 导航。
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
const { LEGACY_SEARCH_PARAMS, cleanSearchUrl } = await vite.ssrLoadModule('/src/lib/searchUrlCleanup.ts');
after(async () => vite.close());

describe('cleanSearchUrl：旧版检索参数一律清掉', () => {
  it('单独出现的 q', () => {
    assert.equal(cleanSearchUrl('q=kubectl', 'kisearch'), '');
    assert.equal(cleanSearchUrl('q=%E5%91%8A%E8%AD%A6+%E6%94%B6%E6%95%9B', 'kisearch'), '');
  });

  it('完整旧参数集（q/mode/tags/threshold/limit）', () => {
    assert.equal(
      cleanSearchUrl('q=a&mode=fulltext&tags=x%2Cy&threshold=0.05&limit=20', 'kisearch'),
      '',
    );
  });

  it('参数名清单与页面约定一致（多一个少一个都要在这里显形）', () => {
    assert.deepEqual([...LEGACY_SEARCH_PARAMS], ['q', 'mode', 'tags', 'threshold', 'limit']);
  });

  it('不做前缀匹配：queries / tag 等同前缀参数不受影响', () => {
    assert.equal(cleanSearchUrl('queries=1&tag=x&limited=2', 'kisearch'), null);
  });
});

describe('cleanSearchUrl：scope 深链参数', () => {
  it('与当前 scope 一致 → 保留（导入页等入口的深链）', () => {
    assert.equal(cleanSearchUrl('scope=kisearch', 'kisearch'), null);
  });

  it('与当前 scope 不一致（用户手动切过 scope）→ 清掉', () => {
    assert.equal(cleanSearchUrl('scope=other', 'kisearch'), '');
    assert.equal(cleanSearchUrl('scope=other&chat=1', 'kisearch'), 'chat=1');
  });

  it('scope 与旧检索参数同时存在 → 一并清掉', () => {
    assert.equal(cleanSearchUrl('q=a&scope=other', 'kisearch'), '');
  });
});

describe('cleanSearchUrl：其它参数与「无需改动」', () => {
  it('空查询串 / 无关参数 → null（不写回地址栏）', () => {
    assert.equal(cleanSearchUrl('', 'kisearch'), null);
    assert.equal(cleanSearchUrl('chat=1', 'kisearch'), null);
    assert.equal(cleanSearchUrl('scope=kisearch&chat=1', 'kisearch'), null);
  });

  it('保留无关参数（面板 chat、全屏 reader），并只清旧检索参数', () => {
    assert.equal(cleanSearchUrl('q=a&chat=1&reader=1', 'kisearch'), 'chat=1&reader=1');
    assert.equal(cleanSearchUrl('mode=fulltext&chat=1', 'kisearch'), 'chat=1');
  });
});
