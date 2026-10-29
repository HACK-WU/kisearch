/**
 * doc-path.ts 单测 —— 路径检索的口径（REQ-20261020-001）
 *
 * 锁住六条不变量（均为实测出来的真实形态，不得随意放宽）：
 *   1) 检索词归一：`\`、全角 `／`、分隔符两侧空白、重复分隔符、`./` 与前导/尾随 `/` 一律等价；
 *   2) 归一处后为空（纯空格 / 纯 `/`）→ 视为**无检索词**，不是"搜不到"；
 *   3) 逻辑路径按最长重叠段合并：既不能丢 group 前缀（monitot 形态），也不能拼出重复段；
 *   4) 无 sourcePath 的文档（MCP / CLI 写入）退回 `group/name`，路径维度照样可检索；
 *   5) 命中来源：名称命中优先归 name，其余归 path；
 *   6) 匹配是纯字面比较 —— `..`、`*`、正则元字符都只是普通字符，不触达文件系统。
 *
 * 运行：npx jiti test/doc-path.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { logicalDocPath, matchDocQuery, normalizeSearchQuery } from '../src/lib/doc-path.js';

describe('normalizeSearchQuery：检索词归一', () => {
  it('反斜杠 / 全角斜杠 / 分隔符两侧空白 / 重复分隔符 等价', () => {
    const expected = 'wiki/api接口文档/认证.md';
    assert.equal(normalizeSearchQuery('wiki/api接口文档/认证.md'), expected);
    assert.equal(normalizeSearchQuery('wiki\\api接口文档\\认证.md'), expected);
    assert.equal(normalizeSearchQuery('wiki／api接口文档／认证.md'), expected);
    assert.equal(normalizeSearchQuery('  wiki / api接口文档 / 认证.md '), expected);
    assert.equal(normalizeSearchQuery('wiki//api接口文档////认证.md'), expected);
  });

  it('去 ./ 与前导 / 尾随 /', () => {
    assert.equal(normalizeSearchQuery('./wiki/a.md'), 'wiki/a.md');
    assert.equal(normalizeSearchQuery('/wiki/a.md'), 'wiki/a.md');
    assert.equal(normalizeSearchQuery('wiki/a/'), 'wiki/a');
  });

  it('只有空白 / 只有分隔符 → 空串（= 无检索词）', () => {
    for (const raw of ['', '   ', '/', '//', '\\', ' / \\ ', '\u3000']) {
      assert.equal(normalizeSearchQuery(raw), '', `raw=${JSON.stringify(raw)} 应归一为空`);
    }
  });

  it('纯 * 不归一为空（按字面搜索，N2）', () => {
    assert.equal(normalizeSearchQuery('*'), '*');
  });
});

describe('logicalDocPath：group 与 sourcePath 合并', () => {
  it('sourcePath 缺 group 前缀 → 补上（monitot 真实形态）', () => {
    assert.equal(
      logicalDocPath({ group: 'wiki/API接口文档', path: 'API接口文档/API认证与授权.md', name: 'API认证与授权' }),
      'wiki/API接口文档/API认证与授权.md',
    );
  });

  it('sourcePath 已含 group 前缀 → 原样，**不得**拼出重复段', () => {
    const merged = logicalDocPath({
      group: 'aiops/algorithms/rca',
      path: 'aiops/algorithms/rca/告警聚合.md',
      name: '告警聚合',
    });
    assert.equal(merged, 'aiops/algorithms/rca/告警聚合.md');
    assert.ok(!merged.includes('rca/rca'), `路径重复拼接：${merged}`);
  });

  it('无 sourcePath（MCP / CLI 写入）→ 退回 group/name', () => {
    assert.equal(
      logicalDocPath({ group: '专题记忆/Agent 执行链专家', name: '执行链概览' }),
      '专题记忆/Agent 执行链专家/执行链概览',
    );
  });

  it('group 与 sourcePath 无重叠（单层 group + 裸文件名）', () => {
    assert.equal(logicalDocPath({ group: 'k8s', path: '00-学习档案.md', name: '00-学习档案' }), 'k8s/00-学习档案.md');
  });
});

describe('matchDocQuery：命中来源', () => {
  const monitot = { group: 'wiki/API接口文档', path: 'API接口文档/API认证与授权.md', name: 'API认证与授权' };
  const memory = { group: '专题记忆/Agent 执行链专家', name: '执行链概览' };

  it('空检索词 → null（不过滤）', () => {
    assert.equal(matchDocQuery(monitot, ''), null);
  });

  it('页头形态的完整路径命中 → path', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('wiki/API接口文档/API认证与授权')), 'path');
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('wiki / API接口文档 / API认证与授权')), 'path');
  });

  it('只输组名也命中 → path（组在逻辑路径里）', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('wiki')), 'path');
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('API接口文档')), 'path');
  });

  it('无 sourcePath 的文档按 group/name 命中 → path', () => {
    assert.equal(matchDocQuery(memory, normalizeSearchQuery('专题记忆/Agent 执行链专家/执行链概览')), 'path');
    assert.equal(matchDocQuery(memory, normalizeSearchQuery('专题记忆/Agent 执行链专家/')), 'path');
  });

  it('名称命中优先归 name（哪怕路径也含该词）', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('API认证')), 'name');
  });

  it('带扩展名只能从路径命中 → path；不带扩展名的名称命中 → name', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('API认证与授权.md')), 'path');
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('API认证与授权')), 'name');
  });

  it('不命中 → null', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('完全无关的路径')), null);
  });

  it('字面匹配：通配符与 .. 不特殊解释', () => {
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('wiki/*.md')), null);
    assert.equal(matchDocQuery(monitot, normalizeSearchQuery('../etc/passwd')), null);
    // `..` 只是普通字符：一旦真出现在文档名里就能按字面命中
    assert.equal(matchDocQuery({ group: 'g', name: '..配置' }, '..'), 'name');
  });
});
