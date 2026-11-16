/**
 * 短会话 GC（REQ-20261113-001 二期 · S-03 §4.4 / 工作项 3）
 *
 * 覆盖 4 条不变量：
 *   ① 超过**保留期**（`createdAt + 7 天`）的 `ka-*` 被删，未过期保留
 *      —— REQ-20261116-003 起判据从"滑动 TTL 过期"改为"保留期到期"：
 *        续接 TTL（10 分钟滑动）只管 `context_id` 还能不能用，不再删文件。
 *   ② **只碰 `ka-*`**：同目录的 `c-*.json`、`assets/`、其他文件一律不动
 *   ③ 损坏文件按"不可用"删除（否则每次调用都报同一个错）
 *   ④ 空目录 / 目录不存在不报错
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/ask-gc.test.ts
 */

import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../../src/lib/config.js';
import { sweepExpiredAskSessions } from '../../src/lib/chat/ask/ask-gc.js';

let root = '';
let scopeDir = '';
let previousConfig: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ask-gc-'));
  scopeDir = path.join(root, 'chat', 'default');
  fs.mkdirSync(scopeDir, { recursive: true });
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

/**
 * 直接落一个短会话文件（绕过 store，便于构造任意时间）。
 *
 * 注意 `createdAt` 才是 GC 判据（保留期按创建时刻起算、**不滑动**）；
 * `updatedAt` 只影响"还能不能续接"，传它是为了构造"续接已过期但仍在保留期内"的边界样本。
 */
function writeSession(id: string, createdAt: string, raw?: string, updatedAt = createdAt): string {
  const filePath = path.join(scopeDir, `${id}.json`);
  fs.writeFileSync(filePath, raw ?? JSON.stringify({
    version: 2, id, scope: 'default', ownerKey: 'local', origin: { kind: 'local' },
    createdAt, updatedAt, messages: [],
  }));
  return filePath;
}

it('① 超保留期删除、保留期内保留', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const DAY = 86_400_000;
  const fresh = writeSession('ka-fresh-0001', new Date(now - 6 * DAY).toISOString()); // 6 天前
  const stale = writeSession('ka-stale-0002', new Date(now - 8 * DAY).toISOString()); // 8 天前

  const result = sweepExpiredAskSessions(now);
  assert.equal(result.scanned, 2);
  assert.equal(result.deleted, 1);
  assert.ok(fs.existsSync(fresh), '保留期内不得删除');
  assert.ok(!fs.existsSync(stale), '超保留期必须删除');
});

it('①b 只按 createdAt 判：updatedAt 很新也照删（保留期不滑动）', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const DAY = 86_400_000;
  // 创建于 30 天前，但"刚刚"还被续接过 —— 续接 TTL 早已过期，保留期同样已过
  const stale = writeSession(
    'ka-stale-0009',
    new Date(now - 30 * DAY).toISOString(),
    undefined,
    new Date(now - 60_000).toISOString(),
  );
  const result = sweepExpiredAskSessions(now);
  assert.equal(result.deleted, 1);
  assert.ok(!fs.existsSync(stale), '高频续接不得让记录永不过期');
});

it('② 只碰 ka-*：c-* / assets / 其他文件不受影响', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const stale = writeSession('ka-stale-0003', new Date(now - 8 * 86_400_000).toISOString());

  const conversation = path.join(scopeDir, 'c-legacy-0001.json');
  fs.writeFileSync(conversation, JSON.stringify({ version: 1, id: 'c-legacy-0001' }));
  const assetsDir = path.join(scopeDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'img.png'), 'x');
  const note = path.join(scopeDir, 'notes.txt');
  fs.writeFileSync(note, 'keep');

  const result = sweepExpiredAskSessions(now);
  assert.equal(result.deleted, 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(conversation), '用户会话 c-* 绝不能被 GC 删掉');
  assert.ok(fs.existsSync(path.join(assetsDir, 'img.png')), 'assets 不能被动');
  assert.ok(fs.existsSync(note), '非会话文件不能被动');
});

it('③ 损坏文件按不可用删除', () => {
  const broken = writeSession('ka-broken-0004', '2026-11-13T11:59:00.000Z', '{ 这不是合法 JSON');
  const result = sweepExpiredAskSessions(Date.parse('2026-11-13T12:00:00.000Z'));
  assert.equal(result.scanned, 1);
  assert.equal(result.deleted, 1);
  assert.ok(!fs.existsSync(broken));
});

it('④ chatDir 不存在时安全返回', () => {
  fs.rmSync(path.join(root, 'chat'), { recursive: true, force: true });
  const result = sweepExpiredAskSessions();
  assert.deepEqual(result, { scanned: 0, deleted: 0 });
});
