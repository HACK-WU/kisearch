/**
 * 短会话存储（REQ-20261113-001 二期 · S-03 §4.2 / 工作项 2）
 *
 * 覆盖 7 条不变量：
 *   ① create → read 往返一致，id 为 `ka-` 形态，messages 初始为空
 *   ② append 追加消息，且 `updatedAt` **前进**（滑动 TTL 的唯一依据）
 *   ③ 防路径穿越：非法 id（含 `../`、`c-` 前缀、空）一律 null，不抛不写
 *   ④ 同 id 并发 append 串行化（两条都在，不丢消息 —— N10）
 *   ⑤ delete 幂等
 *   ⑥ `listAskSessionIds` 只认 `ka-*`，**绝不**返回 `c-*` / assets
 *   ⑦ 过期判定：未过期 / 已过期 / 脏时间（按过期处理）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/ask-store.test.ts
 */

import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../../src/lib/config.js';
import {
  appendAskTurn,
  askSessionExpiresAt,
  createAskSession,
  deleteAskSession,
  isAskSessionExpired,
  isValidAskId,
  listAskSessionIds,
  readAskSession,
} from '../../src/lib/chat/ask/ask-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

let root = '';
let previousConfig: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ask-store-'));
  previousConfig = process.env.KI_CONFIG_PATH;
  const configPath = path.join(root, 'config.yaml');
  fs.writeFileSync(configPath, `dataDir: ${root}/data\nchatDir: ${root}/chat\n`);
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = previousConfig;
  resetConfigCache();
});

it('① create → read 往返一致，messages 初始为空', async () => {
  const created = await createAskSession('default', 'tok-1');
  assert.match(created.id, /^ka-[a-z0-9]+-[0-9a-f]{32}$/, 'id = ka- + 时间 + 128bit 随机');
  assert.equal(created.ownerKey, 'tok-1');
  assert.equal(created.messages.length, 0);

  const readBack = await readAskSession('default', created.id);
  assert.ok(readBack !== null);
  assert.equal(readBack.id, created.id);
  assert.equal(readBack.scope, 'default');
  assert.equal(readBack.ownerKey, 'tok-1');
});

it('② append 追加消息，且 updatedAt 前进（滑动 TTL 依据）', async () => {
  const created = await createAskSession('default', 'tok-1');
  await sleep(12); // 保证毫秒时间戳前进（writeJson 用 ISO 毫秒）
  const afterFirst = await appendAskTurn('default', created.id, [
    { role: 'user', content: '问题一', at: new Date().toISOString() },
    { role: 'assistant', content: '答案一', at: new Date().toISOString() },
  ]);
  assert.ok(afterFirst !== null);
  assert.equal(afterFirst.messages.length, 2);
  assert.ok(
    Date.parse(afterFirst.updatedAt) > Date.parse(created.updatedAt),
    '追加必须刷新 updatedAt，否则 TTL 不会滑动',
  );

  await sleep(12);
  const afterSecond = await appendAskTurn('default', created.id, [
    { role: 'user', content: '问题二', at: new Date().toISOString() },
  ]);
  assert.ok(afterSecond !== null);
  assert.equal(afterSecond.messages.length, 3);
  assert.ok(Date.parse(afterSecond.updatedAt) > Date.parse(afterFirst.updatedAt));
  assert.deepEqual(afterSecond.messages.map((m) => m.content), ['问题一', '答案一', '问题二']);
});

it('③ 防路径穿越：非法 id 一律 null，不抛不写', async () => {
  for (const bad of ['../escape', 'c-abc123', 'ka-', '', 'ka-a/b', 'ka-a.b']) {
    assert.equal(isValidAskId(bad), false, `${bad} 应判非法`);
    assert.equal(await readAskSession('default', bad), null);
    assert.equal(await appendAskTurn('default', bad, []), null);
  }
  // 合法形态仍可放行
  assert.equal(isValidAskId('ka-abc-0123456789abcdef0123456789abcdef'), true);
});

it('④ 同 id 并发 append 串行化：两条都在（不丢消息）', async () => {
  const created = await createAskSession('default', 'tok-1');
  await Promise.all([
    appendAskTurn('default', created.id, [{ role: 'user', content: 'A', at: new Date().toISOString() }]),
    appendAskTurn('default', created.id, [{ role: 'user', content: 'B', at: new Date().toISOString() }]),
  ]);
  const final = await readAskSession('default', created.id);
  assert.ok(final !== null);
  assert.equal(final.messages.length, 2, '无锁时后写会覆盖先写（Last-Write-Wins）');
  assert.deepEqual(new Set(final.messages.map((m) => m.content)), new Set(['A', 'B']));
});

it('⑤ delete 幂等：删两次都不报错，删后读为 null', async () => {
  const created = await createAskSession('default', 'tok-1');
  deleteAskSession('default', created.id);
  deleteAskSession('default', created.id);
  assert.equal(await readAskSession('default', created.id), null);
});

it('⑥ listAskSessionIds 只认 ka-*，不返回 c-* 与 assets', async () => {
  const created = await createAskSession('default', 'tok-1');
  const scopeDir = path.join(root, 'chat', 'default');
  fs.mkdirSync(path.join(scopeDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'c-legacy.json'), '{}');
  fs.writeFileSync(path.join(scopeDir, 'notes.txt'), 'x');

  const ids = listAskSessionIds('default');
  assert.deepEqual(ids, [created.id], '只能看到短会话，不能把 c-* 带出来');
});

it('⑦ 过期判定：未过期 / 已过期 / 脏时间按过期处理', () => {
  const now = Date.parse('2026-11-13T10:00:00.000Z');
  const fresh = { updatedAt: '2026-11-13T09:55:00.000Z' }; // 5 分钟前
  const stale = { updatedAt: '2026-11-13T09:45:00.000Z' }; // 15 分钟前
  const ttl = 10 * 60_000;

  assert.equal(isAskSessionExpired(fresh, ttl, now), false);
  assert.equal(isAskSessionExpired(stale, ttl, now), true);
  assert.equal(isAskSessionExpired({ updatedAt: '不是时间' }, ttl, now), true, '脏数据按过期处理');

  assert.equal(askSessionExpiresAt(fresh, ttl), '2026-11-13T10:05:00.000Z');
});
