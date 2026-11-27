/**
 * chat-tool-view.test.ts —— 对话工具接入视图展开（事件 #110）
 *
 * 覆盖 `src/lib/chat/mcp-tool-registry.ts` 的 ki_group_list：
 *   1) 多成员视图 → view + members + buckets（成功桶与失败桶同时存在，单成员失败不拖垮整体）
 *   2) 单成员视图 → 仍然分桶（判定只认「名字命中视图」，不叠加成员数）
 *   3) 物理库名 → 保持既有形状 {ok:false,error,hint}，不进入分桶分支
 *   4) strict 模式下成员全未注册 → view-empty（不静默返回空树）
 *
 * 背景：会话 scope 由前端选定，用户可以选视图；此前该通道直接调
 * `executeQueryGroup`，把视图名当物理库名 → 报「知识库尚未导入」（#110）。
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir / views.json
 * 运行：npx jiti test/chat-tool-view.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-chat-view-'));
const configPath = path.join(tmpDir, 'config.json');
const viewsPath = path.join(tmpDir, 'views.json');
const dataDir = path.join(tmpDir, 'kb');

const writeConfig = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
    ...extra,
  }), 'utf-8');
  // loadConfig 以 mtime+size 判定是否重读；同毫秒内重写可能不触发，强制刷新 mtime
  const now = new Date();
  fs.utimesSync(configPath, now, now);
};

fs.mkdirSync(dataDir, { recursive: true });
// `kisearch` 成员库真实存在（空 Group 树）→ 覆盖「成功桶」；`kisearch-memory` 不存在 → 「失败桶」
fs.mkdirSync(path.join(dataDir, 'kisearch'), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'kisearch', 'group-index.json'),
  JSON.stringify({ groups: {}, updatedAt: new Date().toISOString() }),
  'utf-8',
);
writeConfig();
fs.writeFileSync(viewsPath, JSON.stringify({
  version: 1,
  views: {
    team: { members: ['kisearch', 'kisearch-memory'] },
    solo: { members: ['kisearch'] },
    'strict-view': { members: ['ghost-a', 'ghost-b'] },
  },
  updatedAt: new Date().toISOString(),
}, null, 2), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

interface ChatToolEntry {
  run: (scope: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
interface Bucket { scope: string; output?: string; error?: string }
let groupList: ChatToolEntry;

before(async () => {
  const { getChatTool } = await import('../src/lib/chat/mcp-tool-registry.js');
  const entry = getChatTool('ki_group_list') as unknown as ChatToolEntry | undefined;
  assert.ok(entry, '对话工具 ki_group_list 未注册');
  groupList = entry!;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('对话 ki_group_list 视图展开', () => {
  it('多成员视图 → view + members + buckets（成功桶与失败桶并存）', async () => {
    const out = await groupList.run('team', { mode: 'full' });
    assert.equal(out.ok, true);
    assert.equal(out.view, 'team');
    assert.deepEqual(out.members, ['kisearch', 'kisearch-memory']);
    // memberTotal 是「桶被截断」时的对账标量，必须与成员数一致
    assert.equal(out.memberTotal, 2);
    const buckets = out.buckets as Bucket[];
    assert.equal(buckets.length, 2);
    // 成员库存在 → 成功桶必须有树（否则「分桶」只验到失败路径）
    const hit = buckets.find((b) => b.scope === 'kisearch');
    assert.ok(hit, '缺少 kisearch 桶');
    assert.equal(hit!.error, undefined);
    assert.equal(typeof hit!.output, 'string');
    assert.ok((hit!.output ?? '').length > 0, '成功桶的 output 不能为空');
    // 成员库不存在 → 该桶带 error，但不影响整体 ok
    const miss = buckets.find((b) => b.scope === 'kisearch-memory');
    assert.ok(miss, '缺少 kisearch-memory 桶');
    assert.ok((miss!.error ?? '').includes('尚未导入'));
  });

  it('单成员视图仍然分桶（不能退回单库分支）', async () => {
    const out = await groupList.run('solo', { mode: 'full' });
    assert.equal(out.ok, true);
    assert.equal(out.view, 'solo');
    assert.deepEqual(out.members, ['kisearch']);
    const buckets = out.buckets as Bucket[];
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].error, undefined);
    assert.ok((buckets[0].output ?? '').length > 0);
    // 回归点：此前这里会是 {ok:false,error:'…尚未导入…'}
    assert.equal(out.error, undefined);
  });

  it('物理库名 → 既有形状 {ok:false,error,hint}，不进入分桶', async () => {
    const out = await groupList.run('kisearch-memory', { mode: 'full' });
    assert.equal(out.ok, false);
    assert.ok(String(out.error).includes('尚未导入'));
    // hint 必须指出「视图请用 ki view list 核对」，否则用户会被引导去建同名库
    assert.ok(String(out.hint ?? '').includes('ki view list'));
    assert.equal(out.view, undefined);
    assert.equal(out.buckets, undefined);
  });

  it('ki_get_module_info 视图下走成员库（不再报「尚未导入」）', async () => {
    const { getChatTool } = await import('../src/lib/chat/mcp-tool-registry.js');
    const tool = getChatTool('ki_get_module_info') as unknown as ChatToolEntry;
    const out = await tool.run('solo', { group: 'g', relation: 'r' });
    // 成员库是空 Group 树 → 文档不存在；关键是不再拿视图名当 scope
    assert.equal(out.ok, false);
    assert.equal(out.view, 'solo');
    assert.deepEqual(out.searched, ['kisearch']);
    assert.ok(!String(out.error).includes('尚未导入'), `不应再报尚未导入：${String(out.error)}`);
  });

  it('ki_get_module_info 视图下 member 越界 → 拒绝并给成员清单', async () => {
    const { getChatTool } = await import('../src/lib/chat/mcp-tool-registry.js');
    const tool = getChatTool('ki_get_module_info') as unknown as ChatToolEntry;
    const out = await tool.run('team', { group: 'g', relation: 'r', member: 'nope' });
    assert.equal(out.ok, false);
    assert.ok(String(out.error).includes('不是视图 team 的成员'));
    assert.deepEqual(out.members, ['kisearch', 'kisearch-memory']);
  });

  it('ki_get_module_info 批量 + start_line 仍然 fail-loud（不得静默从文首返回）', async () => {
    const { getChatTool } = await import('../src/lib/chat/mcp-tool-registry.js');
    const tool = getChatTool('ki_get_module_info') as unknown as ChatToolEntry;
    // solo 是单成员视图 → 批量免 member，直接落到成员库；起点参数必须由核心 fail-loud
    const out = await tool.run('solo', { group: 'g', relations: ['r1'], start_line: 100 });
    assert.equal(out.ok, false);
    assert.match(String(out.error), /批量查询不支持/, `应指路而非静默忽略：${JSON.stringify(out).slice(0, 160)}`);
  });

  it('ki_tag_list 视图下返回合并形状（view/members，不是空 scope 结果）', async () => {
    const { getChatTool } = await import('../src/lib/chat/mcp-tool-registry.js');
    const tool = getChatTool('ki_tag_list') as unknown as ChatToolEntry;
    const out = await tool.run('solo', {});
    assert.equal(out.view, 'solo', `应走视图合并分支，实际：${JSON.stringify(out).slice(0, 120)}`);
    assert.deepEqual(out.members, ['kisearch']);
    assert.ok(Array.isArray(out.tags));
  });

  it('视图整体超时：剩余成员进 skipped，不整体失败', async () => {
    const { queryGroupByScope } = await import('../src/lib/group-list-view.js');
    const out = await queryGroupByScope('team', {
      hotCount: 5,
      depth: 4,
      modes: ['hot'],
      // totalMs=0 ⇒ 预算立即用尽，成员全部进 skipped（不必真等 30s 单成员超时）
      timeout: { ms: 30_000, label: 'ki_group_list', totalMs: 0 },
    });
    assert.equal(out.kind, 'view');
    if (out.kind !== 'view') return;
    assert.equal(out.memberTotal, 2);
    assert.equal(out.buckets.length, 0, '超时后不应有桶');
    assert.equal(out.skipped.length, 2);
    assert.ok(out.skipped.every((s) => s.reason.includes('整体超时')));
  });

  it('strict 模式成员全未注册 → view-empty（不静默返回空树）', async () => {
    // 本用例改配置后必须放最后：strict 会让后续调用对未注册 scope 直接抛错
    writeConfig({ scopeMode: 'strict', scopes: { kisearch: {} } });
    const out = await groupList.run('strict-view', { mode: 'full' });
    assert.equal(out.ok, false);
    assert.equal(out.view, 'strict-view');
    assert.ok(String(out.error).includes('没有可用的成员库'));
    assert.equal((out.skipped as { scope: string }[]).length, 2);
  });
});
