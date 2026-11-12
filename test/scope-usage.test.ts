/**
 * test/scope-usage.test.ts
 *
 * REQ-20261112-001 S-01 回归：scope 级调用量统计的存储层。
 *   ① 累加与窗口聚合：读/写分桶、多日累加、窗口外的不计入；
 *   ② 非法 scope 名丢弃（埋点取原始字面量 + 失败也计入 ⇒ 不校验就是无界写入口）；
 *   ③ 未初始化（CLI 直连 / 单测）时零副作用：不抛错、不建文件；
 *   ④ 文件损坏：读返回 null（前端显示 `—`），并改名备份；
 *   ⑤ 裁剪：90 天外的日桶删除，但 firstSeen 保留（否则老库会随天数推移"变成新库"）。
 *
 * 运行：npx jiti test/scope-usage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  flushScopeUsage,
  getUsageStorePath,
  initScopeUsage,
  readScopeUsage,
  readScopeUsageMeta,
  recordScopeUsage,
  resetScopeUsageForTest,
} from '../src/lib/scope-usage.js';
import { OperationCoordinator } from '../src/lib/operation-coordinator.js';
import { MAX_USAGE_SCOPES } from '../src/lib/constants.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scope-usage-'));
}

/** 每个用例独立目录 + 干净进程态 */
function freshStore(): string {
  resetScopeUsageForTest();
  const dataDir = tmpDataDir();
  initScopeUsage({ dataDir });
  return dataDir;
}

function dayOffset(offset: number): string {
  const d = new Date(Date.now() - offset * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test('① 累加与窗口聚合：读/写分桶，窗口外不计入', () => {
  const dataDir = freshStore();
  recordScopeUsage('ai-docs', 'read');
  recordScopeUsage('ai-docs', 'read');
  recordScopeUsage('ai-docs', 'write');

  flushScopeUsage();

  const d7 = readScopeUsage({ dataDir }, 7);
  assert.ok(d7, '统计应可读');
  const snap = d7!.get('ai-docs');
  assert.ok(snap, '应有 ai-docs');
  assert.equal(snap!.read, 2);
  assert.equal(snap!.write, 1);
  assert.equal(snap!.firstSeen, dayOffset(0));
});

test('①b 窗口边界：8 天前的记录不进 d7、进 d30', () => {
  const dataDir = freshStore();
  const eightDaysAgo = Date.now() - 8 * 86_400_000;
  recordScopeUsage('old-scope', 'read', eightDaysAgo);

  flushScopeUsage();

  assert.equal(readScopeUsage({ dataDir }, 7)!.get('old-scope')!.read, 0, '8 天前不计入 d7');
  assert.equal(readScopeUsage({ dataDir }, 30)!.get('old-scope')!.read, 1, '8 天前计入 d30');
});

test('①c lastUsedAt 保留毫秒精度（不得用日桶 key 反推成"当天 0 点"）', () => {
  const dataDir = freshStore();
  const precise = Date.now() - 5 * 3_600_000;
  recordScopeUsage('precise', 'read', precise);
  flushScopeUsage();

  const snap = readScopeUsage({ dataDir }, 7)!.get('precise')!;
  assert.equal(snap.lastUsedAt, precise, `应为精确毫秒 ${precise}，实际 ${snap.lastUsedAt}`);
});

test('② 非法 scope 名丢弃，不建 key', () => {
  const dataDir = freshStore();
  recordScopeUsage('../../etc/passwd', 'read');
  recordScopeUsage('has space', 'read');
  recordScopeUsage('', 'read');
  recordScopeUsage('x'.repeat(80), 'read');
  recordScopeUsage('ok_name-1', 'read');

  flushScopeUsage();

  const parsed = JSON.parse(fs.readFileSync(getUsageStorePath({ dataDir }), 'utf-8'));
  assert.deepEqual(Object.keys(parsed.scopes), ['ok_name-1'], '只有合法名入统计');
});

test('②b flush 侧按总 key 数上限裁剪（内存 entries 只约束单周期，挡不住跨周期累积）', () => {
  const dataDir = freshStore();
  const file = getUsageStorePath({ dataDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const today = dayOffset(0);
  const scopes: Record<string, unknown> = {};
  // 造 2005 个历史 key：每个都带今天的桶（否则会被 90 天裁剪先删掉，测不到 key 上限）
  for (let i = 0; i < MAX_USAGE_SCOPES + 5; i++) {
    scopes[`s${String(i).padStart(4, '0')}`] = {
      firstSeen: today,
      lastUsedAt: Date.now() - i * 1000, // i 越大越旧
      days: { [today]: [1, 0] },
    };
  }
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), scopes }), 'utf-8');

  resetScopeUsageForTest();
  initScopeUsage({ dataDir });
  recordScopeUsage('trigger', 'read');
  flushScopeUsage();

  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(Object.keys(parsed.scopes).length, MAX_USAGE_SCOPES, `应裁到 ${MAX_USAGE_SCOPES} 个 key`);
  assert.ok(parsed.scopes.s0000, '最近使用的应保留');
  assert.equal(parsed.scopes.s2004, undefined, '最旧的应被裁掉');
});

test('③ 未初始化时零副作用：不抛错、不建文件', () => {
  resetScopeUsageForTest();
  const dataDir = tmpDataDir();
  assert.doesNotThrow(() => recordScopeUsage('a', 'read'));
  flushScopeUsage();
  assert.equal(fs.existsSync(getUsageStorePath({ dataDir })), false, '未初始化不得创建文件');
});

test('④ 文件损坏：读返回 null（前端显示 —），并改名备份', () => {
  const dataDir = freshStore();
  recordScopeUsage('a', 'read');
  flushScopeUsage();

  const file = getUsageStorePath({ dataDir });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8');
  resetScopeUsageForTest();
  initScopeUsage({ dataDir });

  assert.equal(readScopeUsage({ dataDir }, 7), null, '损坏应降级为 null 而不是全 0');
  const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
  assert.equal(backups.length, 1, '应留一份 .corrupt-*.bak');
});

test('⑤ 裁剪：删 90 天外的日桶，但 firstSeen 保留', () => {
  const dataDir = freshStore();
  const file = getUsageStorePath({ dataDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 造一份「老库」：firstSeen 120 天前，有一个 100 天前的桶 + 昨天的桶
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString(),
    scopes: {
      legacy: {
        firstSeen: dayOffset(120),
        lastUsedAt: Date.now() - 86_400_000,
        days: { [dayOffset(100)]: [5, 0], [dayOffset(1)]: [2, 1] },
      },
    },
  }), 'utf-8');

  resetScopeUsageForTest();
  initScopeUsage({ dataDir });
  // 任意一次记录触发 flush（裁剪在 flush 内执行）
  recordScopeUsage('trigger', 'read');
  flushScopeUsage();

  const parsed = JSON.parse(fs.readFileSync(getUsageStorePath({ dataDir }), 'utf-8'));
  assert.deepEqual(Object.keys(parsed.scopes.legacy.days), [dayOffset(1)], '90 天外的桶应被删');
  assert.equal(parsed.scopes.legacy.firstSeen, dayOffset(120), 'firstSeen 不得随裁剪回退');

  const snap = readScopeUsage({ dataDir }, 90)!.get('legacy');
  assert.equal(snap!.firstSeen, dayOffset(120));
  assert.equal(snap!.read, 2);
});

test('⑦ coordinator 埋点：检索类计查询、管理类读不计、写工具计写入', async () => {
  const dataDir = freshStore();
  const c = new OperationCoordinator(2, 1_000);
  // search：kind 缺省推导为 read，且属检索类 → 计查询
  await c.submit({ operation: 'search', params: { scope: 'ai-docs' } }, () => 'r', ['ai-docs']);
  // doc-list-api：read 但不是检索类（浏览页管理面）→ 不计
  await c.submit({ operation: 'doc-list-api', params: { scope: 'ai-docs' } }, () => 'r', ['ai-docs'], 'read');
  // sync-relation：write → 计写入
  await c.submit({ operation: 'sync-relation', params: { scope: 'ai-docs' } }, () => 'w', ['ai-docs']);

  flushScopeUsage();
  const snap = readScopeUsage({ dataDir }, 7)!.get('ai-docs')!;
  assert.equal(snap.read, 1, '只有 search 计入查询；管理类读（doc-list-api）不计');
  assert.equal(snap.write, 1);
});

test('⑦b engine-only：只有真正产生数据的操作计写入（运维类不计）', async () => {
  const dataDir = freshStore();
  const c = new OperationCoordinator(2, 1_000);
  await c.submit({ operation: 'vector-optimize', params: { scope: 'ops' } }, () => 'v', ['ops'], 'engine-only');
  await c.submit({ operation: 'import', params: { scope: 'ops' } }, () => 'i', ['ops'], 'engine-only');

  flushScopeUsage();
  const snap = readScopeUsage({ dataDir }, 7)!.get('ops')!;
  assert.equal(snap.write, 1, 'vector-optimize 是运维动作，不该计入写入');
  assert.equal(snap.read, 0);
});

test('⑦c 失败调用也计入（需求 D7），且不因统计异常影响结果', async () => {
  const dataDir = freshStore();
  const c = new OperationCoordinator(2, 1_000);
  await assert.rejects(
    c.submit({ operation: 'sync-relation', params: { scope: 'boom' } }, () => { throw new Error('boom'); }, ['boom']),
    /boom/,
  );

  flushScopeUsage();
  const snap = readScopeUsage({ dataDir }, 7)!.get('boom')!;
  assert.equal(snap.write, 1, 'handler 抛错也要记一次写入');
});

test('⑦d MCP 通道显式 usageTargets 覆盖整批 kind（batch 混算场景）', async () => {
  const dataDir = freshStore();
  const c = new OperationCoordinator(2, 1_000);
  // 模拟一个「读 + 写」混合 batch：整批 kind=write，但 usage 精确到每条
  await c.submit(
    { operation: 'mcp-request', params: { batch: true } },
    () => 'ok',
    ['a', 'b'],
    'write',
    [{ scope: 'a', kind: 'read' }, { scope: 'b', kind: 'write' }],
  );

  flushScopeUsage();
  const map = readScopeUsage({ dataDir }, 7)!;
  assert.equal(map.get('a')!.read, 1, 'a 的检索不该被整批 write 污染');
  assert.equal(map.get('a')!.write, 0);
  assert.equal(map.get('b')!.write, 1);
});

test('⑥ meta：since 取最早 firstSeen', () => {
  const dataDir = freshStore();
  recordScopeUsage('a', 'read');
  flushScopeUsage();
  const meta = readScopeUsageMeta({ dataDir });
  assert.ok(meta);
  assert.equal(meta!.since, dayOffset(0));
  assert.ok(meta!.updatedAt.length > 0);
});
