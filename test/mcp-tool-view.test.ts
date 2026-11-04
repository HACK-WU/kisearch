/**
 * mcp-tool-view.test.ts —— MCP 读工具接入视图（REQ-20261104-003 / S-07）
 *
 * 覆盖三个 Agent 主路径工具在视图模式下的分支：
 *   1) ki_group_list  → 按成员库分桶（单成员失败不拖垮视图）
 *   2) ki_tag_list    → 合并 + 计数累加
 *   3) ki_get_module_info → 视图下批量查询必须给 member；member 越界即报错
 *
 * 手法：桩一个只记录 handler 的 McpServer，直接调用注册进来的回调——
 * 不需要起 MCP 传输层，也不依赖向量引擎。
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir
 * 运行：npx jiti test/mcp-tool-view.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-view-'));
const configPath = path.join(tmpDir, 'config.json');
const viewsPath = path.join(tmpDir, 'views.json');
const dataDir = path.join(tmpDir, 'kb');

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
fs.writeFileSync(viewsPath, JSON.stringify({
  version: 1,
  views: { team: { members: ['kisearch', 'kisearch-memory'] } },
  updatedAt: new Date().toISOString(),
}, null, 2), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const handlers = new Map<string, Handler>();

/** 最小 McpServer 桩：只截获 tool() 注册的 name → handler */
const fakeServer = {
  tool(name: string, _desc: string, _schema: unknown, handler: Handler): void {
    handlers.set(name, handler);
  },
} as unknown as Parameters<typeof import('../src/lib/mcp-tools/group-list.js').registerGroupListTool>[0];

before(async () => {
  const { registerGroupListTool } = await import('../src/lib/mcp-tools/group-list.js');
  const { registerTagListTool } = await import('../src/lib/mcp-tools/tag-list.js');
  const { registerGetModuleInfoTool } = await import('../src/lib/mcp-tools/get-module-info.js');
  registerGroupListTool(fakeServer);
  registerTagListTool(fakeServer);
  registerGetModuleInfoTool(fakeServer);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parse(res: { content: { text: string }[] }): any {
  return JSON.parse(res.content[0].text);
}

describe('ki_group_list 视图分桶', () => {
  it('返回 buckets，单成员失败不拖垮整体', async () => {
    const h = handlers.get('ki_group_list');
    assert.ok(h, '工具未注册');
    const res = await h!({ scope: 'team', mode: 'full' });
    const data = parse(res);
    assert.equal(data.ok, true);
    assert.equal(data.view, 'team');
    assert.deepEqual(data.members, ['kisearch', 'kisearch-memory']);
    assert.equal(data.buckets.length, 2);
    // 两个成员都没有索引：各自带 error，但视图整体仍可用
    for (const b of data.buckets) {
      assert.ok(typeof b.scope === 'string');
      assert.ok(b.error !== undefined || b.output !== undefined);
    }
  });

  it('单库请求不进入分桶分支', async () => {
    const h = handlers.get('ki_group_list')!;
    const res = await h({ scope: 'kisearch', mode: 'full' });
    // 单库走原路径：要么成功输出文本，要么 isError —— 但绝不能是 buckets 结构
    const text = res.content[0].text;
    assert.ok(!text.includes('"buckets"'), '单库不应返回 buckets');
  });
});

describe('ki_tag_list 视图合并', () => {
  it('返回合并形状（tags + skipped）', async () => {
    const h = handlers.get('ki_tag_list');
    assert.ok(h);
    const res = await h!({ scope: 'team' });
    const data = parse(res);
    assert.equal(data.ok, true);
    assert.equal(data.view, 'team');
    assert.ok(Array.isArray(data.tags));
    assert.ok(Array.isArray(data.skipped), '成员不可用时应进 skipped 而不是抛错');
  });
});

describe('ki_get_module_info 视图成员约束', () => {
  it('member 越界 → isError + 成员清单', async () => {
    const h = handlers.get('ki_get_module_info');
    assert.ok(h);
    const res = await h!({ scope: 'team', group: 'g', relation: 'r', member: 'nope' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /不是视图 team 的成员/);
    assert.match(res.content[0].text, /kisearch/);
  });

  it('视图下批量查询未给 member → isError 并给候选库', async () => {
    const h = handlers.get('ki_get_module_info')!;
    const res = await h({ scope: 'team', group: 'g', relations: ['r1', 'r2'] });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /必须指定 member/);
    assert.match(res.content[0].text, /kisearch/);
  });
});
