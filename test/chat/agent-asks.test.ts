/**
 * agent 问答只读视图（REQ-20261116-003 · S-02 列表 / S-03 详情）
 *
 * 这是整个需求里**越权与数据归属**最容易出错的地方，重点守：
 *   ① 分桶：`local` 与各 Token 各自成组，组名实时取 Token 现名、删除后回退快照；
 *   ② 可见性：非 admin 只见自己 Token 组，`local` 组仅 admin；
 *   ③ 过滤：超保留期不出现在列表（避免"列表有、点开 410"的鬼影条目）；
 *   ④ 分页：limit / cursor 与主列表同口径（复合游标）；
 *   ⑤ 详情：包含 background 与 sources（用户回放**不排除**展示物，与模型回放相反）；
 *   ⑥ 错误：404（不存在 / 越权同码）/ 410（超保留期）/ 422（损坏且**不删文件**）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/agent-asks.test.ts
 */

import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../../src/lib/config.js';

const DAY = 86_400_000;
const SCOPE = 'default';

let root = '';
let scopeDir = '';
let previousConfig: string | undefined;
let mod: typeof import('../../src/lib/chat/agent-asks.js');

const TOKENS = [
  { id: 'tok-codex', token: 'x', label: 'codex', ownerId: 'u1', scopes: ['all'], createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'tok-cursor', token: 'y', label: 'cursor', ownerId: 'u2', scopes: ['all'], createdAt: '2026-01-01T00:00:00.000Z' },
] as unknown as import('../../src/lib/mcp-token.js').TokenRecord[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-agent-asks-'));
  const chatDir = path.join(root, 'chat');
  scopeDir = path.join(chatDir, SCOPE);
  fs.mkdirSync(scopeDir, { recursive: true });
  previousConfig = process.env.KI_CONFIG_PATH;
  const configPath = path.join(root, 'config.yaml');
  fs.writeFileSync(configPath, `dataDir: ${root}/data\nchatDir: ${chatDir}\n`);
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
  mod = await import('../../src/lib/chat/agent-asks.js');
  mod.__setTokenRecordsForTest(TOKENS);
});

afterEach(() => {
  mod.__setTokenRecordsForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = previousConfig;
  resetConfigCache();
});

let seq = 0;
/** 直接落一个短会话文件（绕过 store，便于构造任意来源与时间） */
function writeSession(opts: {
  origin: Record<string, unknown>;
  createdAt?: string;
  question?: string;
  background?: string;
  sources?: unknown[];
  ownerKey?: string;
}): string {
  seq += 1;
  const createdAt = opts.createdAt ?? new Date().toISOString();
  // 文件名里的 base36 时间与 createdAt 保持一致（真实写入就是这样，见 createAskSession）
  const id = `ka-${Date.parse(createdAt).toString(36)}-${String(seq).padStart(32, '0')}`;
  const messages: Record<string, unknown>[] = [
    { role: 'user', content: opts.question ?? `问题 ${seq}`, at: createdAt, ...(opts.background ? { background: opts.background } : {}) },
    { role: 'assistant', content: `答案 ${seq}`, at: createdAt, ...(opts.sources ? { sources: opts.sources } : {}) },
  ];
  fs.writeFileSync(path.join(scopeDir, `${id}.json`), JSON.stringify({
    version: 2, id, scope: SCOPE, ownerKey: opts.ownerKey ?? 'local', origin: opts.origin, createdAt, updatedAt: createdAt, messages,
  }), 'utf-8');
  return id;
}

const localOrigin = { kind: 'local' };
const tokenOrigin = (id: string, label?: string) => ({ kind: 'token', tokenId: id, ...(label ? { tokenLabel: label } : {}) });
const admin = { role: 'admin', userId: 'u-admin' };

it('① 分桶：本地连接与各 Token 各自成组，local 排第一', async () => {
  writeSession({ origin: localOrigin });
  writeSession({ origin: tokenOrigin('tok-codex') });
  writeSession({ origin: tokenOrigin('tok-codex') });
  writeSession({ origin: tokenOrigin('tok-cursor') });

  const { groups, groupsTotal } = await mod.listAgentAskGroups({ scope: SCOPE, viewer: admin });
  assert.equal(groupsTotal, 3);
  assert.deepEqual(groups.map((g) => g.kind), ['local', 'token', 'token']);
  assert.equal(groups[0]!.label, '本地连接');
  // 组名实时取当前 Token 名（改名即跟随）
  assert.deepEqual(groups.filter((g) => g.kind === 'token').map((g) => g.label).sort(), ['codex', 'cursor']);
  assert.equal(groups.find((g) => g.label === 'codex')!.count, 2);
});

it('①b Token 已删除：分组仍在，标记 tokenDeleted 并回退名称快照', async () => {
  writeSession({ origin: tokenOrigin('tok-gone', '已删的 agent') });
  const { groups } = await mod.listAgentAskGroups({ scope: SCOPE, viewer: admin });
  const g = groups.find((x) => x.kind === 'token')!;
  assert.equal(g.tokenDeleted, true);
  assert.equal(g.label, '已删的 agent', '没有实时记录时应回退落盘快照');
});

it('② 非 admin 只见自己 Token 组，本地连接组不可见', async () => {
  writeSession({ origin: localOrigin });
  writeSession({ origin: tokenOrigin('tok-codex') });   // ownerId u1
  writeSession({ origin: tokenOrigin('tok-cursor') });  // ownerId u2

  const u1 = await mod.listAgentAskGroups({ scope: SCOPE, viewer: { role: 'user', userId: 'u1' } });
  assert.equal(u1.groupsTotal, 1);
  assert.equal(u1.groups[0]!.label, 'codex');

  const anon = await mod.listAgentAskGroups({ scope: SCOPE, viewer: { role: 'user' } });
  assert.equal(anon.groupsTotal, 0, '无 userId 不得看到任何组');

  // 显式指定他人组：返回空而不是报错（不泄露"存在这个组"）
  const peek = await mod.listAgentAskGroups({ scope: SCOPE, viewer: { role: 'user', userId: 'u1' }, group: 'token:tok-cursor' });
  assert.equal(peek.groupsTotal, 0);
});

it('③ 超保留期不出现在列表（避免"列表有、点开 410"）', async () => {
  writeSession({ origin: localOrigin });
  writeSession({ origin: localOrigin, createdAt: new Date(Date.now() - 8 * DAY).toISOString() });
  const { groups } = await mod.listAgentAskGroups({ scope: SCOPE, viewer: admin });
  assert.equal(groups[0]!.count, 1);
});

it('④ 分页：limit 生效且 nextCursor 能翻到下一页', async () => {
  for (let i = 0; i < 3; i += 1) {
    writeSession({ origin: localOrigin, createdAt: new Date(Date.now() - i * 60_000).toISOString() });
  }
  const first = await mod.listAgentAskGroups({ scope: SCOPE, viewer: admin, limit: 2 });
  const g1 = first.groups[0]!;
  assert.equal(g1.items.length, 2);
  assert.equal(g1.count, 3);
  assert.equal(g1.hasMore, true);
  assert.ok(g1.nextCursor);

  const second = await mod.listAgentAskGroups({ scope: SCOPE, viewer: admin, limit: 2, cursor: g1.nextCursor });
  const g2 = second.groups[0]!;
  assert.equal(g2.items.length, 1);
  assert.equal(g2.hasMore, false);
  assert.ok(!g1.items.some((a) => g2.items.some((b) => b.id === a.id)), '两页不得重叠');
});

it('⑤ 详情：包含提问背景与来源（用户回放不排除展示物）', async () => {
  const id = writeSession({
    origin: localOrigin,
    question: '怎么排查？',
    background: '项目 kisearch 0.1.0，本机 macOS',
    sources: [{ group: 'g', doc: 'd', lineStart: 1, lineEnd: 2, snippet: 's' }],
  });
  const detail = await mod.getAgentAsk({ scope: SCOPE, viewer: admin, id });
  assert.equal(detail.messages[0]!.background, '项目 kisearch 0.1.0，本机 macOS');
  assert.equal(detail.messages[1]!.sources?.length, 1);
  assert.equal(detail.origin.label, '本地连接');
});

it('⑥ 详情错误：不存在 404 / 超保留期 410 / 损坏 422 且不删文件', async () => {
  await assert.rejects(
    () => mod.getAgentAsk({ scope: SCOPE, viewer: admin, id: 'ka-missing-0000000000000000000000000000' }),
    (e: unknown) => (e as { code?: string }).code === 'AGENT_ASK_NOT_FOUND',
  );

  const stale = writeSession({ origin: localOrigin, createdAt: new Date(Date.now() - 8 * DAY).toISOString() });
  await assert.rejects(
    () => mod.getAgentAsk({ scope: SCOPE, viewer: admin, id: stale }),
    (e: unknown) => (e as { status?: number }).status === 410,
  );

  const broken = path.join(scopeDir, 'ka-broken-1111111111111111111111111111111.json');
  fs.writeFileSync(broken, '{ not json', 'utf-8');
  await assert.rejects(
    () => mod.getAgentAsk({ scope: SCOPE, viewer: admin, id: 'ka-broken-1111111111111111111111111111111' }),
    (e: unknown) => (e as { status?: number }).status === 422,
  );
  assert.ok(fs.existsSync(broken), '只读接口不得删损坏文件（与续接路径的"损坏即删"相反）');
});

it('⑥b 详情越权与不存在同码（404），不泄露存在性', async () => {
  const id = writeSession({ origin: tokenOrigin('tok-codex') });
  await assert.rejects(
    () => mod.getAgentAsk({ scope: SCOPE, viewer: { role: 'user', userId: 'u2' }, id }),
    (e: unknown) => (e as { status?: number }).status === 404,
  );
});
