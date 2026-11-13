/**
 * 短会话 GC（REQ-20261113-001 二期 · S-03 §4.4 / 工作项 3）
 *
 * 覆盖 4 条不变量：
 *   ① 过期 `ka-*` 被删，未过期保留（滑动 TTL 不误杀）
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

/** 直接落一个短会话文件（绕过 store，便于构造任意 updatedAt） */
function writeSession(id: string, updatedAt: string, raw?: string): string {
  const filePath = path.join(scopeDir, `${id}.json`);
  fs.writeFileSync(filePath, raw ?? JSON.stringify({
    version: 1, id, scope: 'default', ownerKey: 'local',
    createdAt: updatedAt, updatedAt, messages: [],
  }));
  return filePath;
}

it('① 过期删除、未过期保留', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const fresh = writeSession('ka-fresh-0001', '2026-11-13T11:55:00.000Z'); // 5 分钟前
  const stale = writeSession('ka-stale-0002', '2026-11-13T11:40:00.000Z'); // 20 分钟前

  const result = sweepExpiredAskSessions(now);
  assert.equal(result.scanned, 2);
  assert.equal(result.deleted, 1);
  assert.ok(fs.existsSync(fresh), '未过期不得删除');
  assert.ok(!fs.existsSync(stale), '过期必须删除');
});

it('② 只碰 ka-*：c-* / assets / 其他文件不受影响', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const stale = writeSession('ka-stale-0003', '2026-11-13T11:00:00.000Z');

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
