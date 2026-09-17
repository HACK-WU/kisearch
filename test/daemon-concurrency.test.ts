import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperationCoordinator, GLOBAL_SCOPE, scopesOf } from '../src/lib/operation-coordinator.js';
import { dispatchOperation, supportedOperations } from '../src/lib/daemon-dispatch.js';
import { validateScope } from '../src/lib/scope.js';
import { configFingerprint, daemonIdentityFingerprint, getScopeCollectionPath, VECTOR_LAYOUT_VERSION } from '../src/lib/scope-collection.js';

test('stage1：默认跨 scope 并发上限为 min(4, CPU 数量)', () => {
  const coordinator = new OperationCoordinator();
  assert.equal(coordinator.maxWorkers, Math.max(1, Math.min(4, os.cpus().length)));
});

test('stage1：同 scope 串行、不同 scope 有界并行', async () => {
  const coordinator = new OperationCoordinator(2);
  const active = new Map<string, number>();
  const events: string[] = [];
  const run = (scope: string, delay: number) => coordinator.submit(
    { operation: 'test', params: { scope } },
    async () => {
      active.set(scope, (active.get(scope) ?? 0) + 1);
      assert.equal(active.get(scope), 1, `scope ${scope} 不得同时执行两个操作`);
      events.push(`start:${scope}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end:${scope}`);
      active.set(scope, active.get(scope)! - 1);
      return scope;
    },
    scope,
  );
  await Promise.all([run('a', 30), run('a', 1), run('b', 10)]);
  assert.ok(events.indexOf('end:a') < events.lastIndexOf('start:a'));
  assert.ok(events.includes('start:b'));
});

test('stage1：scope Collection 路径隔离', () => {
  const config = { vectorDir: '/tmp/ki-stage1-vector', embedding: { provider: 'x', baseURL: 'x', model: 'x', dimension: 1 }, scopeMode: 'default', scopes: {} } as any;
  assert.equal(VECTOR_LAYOUT_VERSION, 2);
  assert.equal(getScopeCollectionPath(config, 'team-a'), '/tmp/ki-stage1-vector/collections/team-a');
  assert.throws(() => getScopeCollectionPath(config, '../escape'));
});

test('stage2：配置指纹区分 KB 根目录且在首次创建符号链接路径后保持稳定', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-fingerprint-'));
  const realRoot = path.join(root, 'real');
  const linkRoot = path.join(root, 'link');
  fs.mkdirSync(realRoot, { recursive: true });
  fs.symlinkSync(realRoot, linkRoot, 'dir');
  const base = {
    vectorDir: path.join(linkRoot, 'vectors'),
    dataDir: path.join(root, 'kb-a'),
    embedding: { provider: 'x', baseURL: 'x', model: 'x', dimension: 1 },
    scopeMode: 'default',
    scopes: {},
  } as any;
  const before = configFingerprint(base);
  fs.mkdirSync(base.vectorDir, { recursive: true });
  const after = configFingerprint(base);
  assert.equal(after, before);
  assert.notEqual(after, configFingerprint({ ...base, dataDir: path.join(root, 'kb-b') }));
  assert.equal(
    daemonIdentityFingerprint(base),
    daemonIdentityFingerprint({ ...base, scopeMode: 'strict', scopes: { added: {} } }),
    'Socket owner identity 不应因 scope 注册或授权模式变化而分裂；握手指纹负责拒绝配置不匹配',
  );
});

test('stage1：多 scope 操作只与其涉及的分片互斥，不冻结无关 scope', async () => {
  const coordinator = new OperationCoordinator(4);
  // 用事件**顺序**而非毫秒时间戳做断言：一个任务完成的瞬间后继任务就会被
  // pump 启动，两者时间戳很可能相同，用 < 比较会假阳性失败。
  const events: string[] = [];
  const task = (label: string, scopes: string | string[], delay: number) => coordinator.submit(
    { operation: 'test', params: { label } },
    async () => {
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end:${label}`);
    },
    scopes,
  );
  const order = (name: string): number => {
    const index = events.indexOf(name);
    assert.ok(index >= 0, `缺少事件 ${name}`);
    return index;
  };

  // scope a 上有一个 60ms 写任务；multi 涉及 a,b；c 与两者都无关。
  const a = task('a', 'a', 60);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const multi = task('multi', ['a', 'b'], 20);
  const cStartedAt = Date.now();
  const c = task('c', 'c', 10);
  await c;
  const cElapsed = Date.now() - cStartedAt;
  await Promise.all([a, multi]);

  // 不变量 1（回归锁）：无关 scope 的任务不得被「待执行的多 scope 任务」阻塞。
  // 旧实现用 `if (activeWorkers > 0) return` 冻结整个 pump，实测把自身仅需 30ms 的
  // 无关 scope 短写拖到 4482ms（149 倍），违反 REQ-02「不同 scope 在资源允许时可重叠执行」。
  // 若将来又把全局屏障改回冻结式调度，本断言立即变红。
  assert.ok(cElapsed < 300, `无关 scope c 不应被待执行的 multi 阻塞，实测 ${cElapsed}ms`);
  // 不变量 2：multi 涉及 scope a，必须等 a 的任务完成后才能开始（同 scope 串行）。
  assert.ok(order('end:a') < order('start:multi'), 'multi 涉及 scope a，不得与 a 的任务重叠');
  // 不变量 3：multi 与无关的 c 允许重叠（c 在 a 仍在跑时就已完成）。
  assert.ok(order('end:c') < order('end:a'), 'c 与 a/multi 无关，应能并行完成');
});

test('stage1：scope 枚举走只读通道，不被长写任务阻塞', async () => {
  const coordinator = new OperationCoordinator(4);
  // scopesOf 对 scope-list 返回空集合 = 只读通道（不占用任何 scope）。
  assert.deepEqual(scopesOf({}, 'scope-list'), []);
  const longWrite = coordinator.submit(
    { operation: 'import', params: { scope: 'a' } },
    async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return 'done'; },
    scopesOf({ scope: 'a' }, 'import'),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const startedAt = Date.now();
  await coordinator.submit(
    { operation: 'scope-list', params: {} },
    async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return 'listed'; },
    scopesOf({}, 'scope-list'),
  );
  const elapsed = Date.now() - startedAt;
  await longWrite;
  // ki scope list 是高频只读命令（前端 scope 下拉），自带 fastFail 撞锁降级；
  // 它绝不应该排在一次 import 后面等几分钟。
  assert.ok(elapsed < 300, `只读的 scope 枚举不应被写任务阻塞，实测 ${elapsed}ms`);
});

test('stage1：旧向量迁移不再暴露为 daemon operation', async () => {
  assert.ok(!supportedOperations().includes('migrate-vector'));
  await assert.rejects(
    dispatchOperation({ operation: 'migrate-vector', params: { yes: true } }),
    (error: any) => error?.code === 'DAEMON_OPERATION_UNSUPPORTED',
  );
});

test('stage1：全局独占任务执行期间与所有分片互斥', async () => {
  const coordinator = new OperationCoordinator(4);
  const events: string[] = [];
  const task = (label: string, scopes: string | string[], delay: number) => coordinator.submit(
    { operation: 'test', params: { label } },
    async () => {
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end:${label}`);
    },
    scopes,
  );
  const write = task('write-a', 'a', 30);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const global = task('migrate', [GLOBAL_SCOPE], 20);
  const other = task('write-b', 'b', 10);
  await Promise.all([write, global, other]);
  // migrate 开始前，已在跑的 write-a 必须已完成（全局独占要求 activeWorkers === 0）。
  assert.ok(events.indexOf('end:write-a') < events.indexOf('start:migrate'));
  // write-b 在 migrate **排队期间**启动是允许的（宽限期内不冻结普通 scope，这正是
  // C-1 的修复语义）；但 migrate 一旦开始就不得有任何其他任务在跑。
  assert.ok(events.indexOf('end:write-b') < events.indexOf('start:migrate'), 'migrate 开始时不得有其他任务在跑');
  const between = events.slice(events.indexOf('start:migrate') + 1, events.indexOf('end:migrate'));
  assert.deepEqual(between, [], 'migrate 执行期间必须独占，不得夹入任何其他事件');
});

test('stage1：全局独占任务不会因持续写流量而饥饿', async () => {
  // 宽限期调小到 30ms 以便在测试时长内验证冻结行为。
  const coordinator = new OperationCoordinator(4, 30);
  const events: string[] = [];
  const task = (label: string, scopes: string | string[], delay: number) => coordinator.submit(
    { operation: 'test', params: { label } },
    async () => {
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end:${label}`);
    },
    scopes,
  );

  // 持续 240ms 的写流量（4 个 scope 轮转、每 4ms 一个 8ms 任务），保证
  // activeWorkers 几乎从不归零 —— 若无防饥饿机制，migrate 将一直等到写流量结束。
  const writes: Promise<unknown>[] = [];
  let migrate: Promise<unknown> | null = null;
  let migrateSubmittedAt = 0;
  let migrateDoneAt = 0;
  const until = Date.now() + 240;
  for (let i = 0; Date.now() < until; i++) {
    writes.push(task(`w${i}`, `s${i % 4}`, 8));
    if (i === 3) {
      migrateSubmittedAt = Date.now();
      migrate = task('migrate', [GLOBAL_SCOPE], 10).then((r) => { migrateDoneAt = Date.now(); return r; });
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  assert.ok(migrate !== null, '测试应已提交全局任务');
  await migrate;
  const waited = migrateDoneAt - migrateSubmittedAt;
  // 宽限期 30ms + 在跑任务收敛（≤ 8ms）+ 自身 10ms：应在写流量结束（240ms）之前完成。
  assert.ok(waited < 200, `全局任务应在宽限期后不久完成而不被写流量饥饿，实测等待 ${waited}ms`);
  // 独占不变量：migrate 执行期间不得夹入任何其他任务的 start。
  const start = events.indexOf('start:migrate');
  const end = events.indexOf('end:migrate');
  assert.ok(start >= 0 && end > start, 'migrate 必须已执行');
  assert.deepEqual(
    events.slice(start + 1, end).filter((e) => e.startsWith('start:')),
    [],
    'migrate 执行期间不得启动任何其他任务',
  );
  await Promise.all(writes);
});

test('stage1：__global__ 是 scope 保留字，不能用作真实 scope 名', () => {
  // 该字面量完全落在 SCOPE_PATTERN（/^[a-zA-Z0-9_-]+$/）白名单内；若不显式排除，
  // 用户创建同名 scope 后其全部请求会被当成全局独占操作，与所有其他 scope 互相阻塞。
  assert.ok(GLOBAL_SCOPE === '__global__');
  assert.throws(() => validateScope(GLOBAL_SCOPE), /保留字/);
  assert.doesNotThrow(() => validateScope('global'));
  assert.doesNotThrow(() => validateScope('team-a'));
});
