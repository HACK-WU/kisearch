/**
 * 短会话存储 v2（REQ-20261116-003 · S-01）
 *
 * 守四件事：
 * 1. 新文件写 `origin` / `background` / `sources`，版本为 2；
 * 2. 旧文件（version:1，无 origin）**读时归一**，不写回；
 * 3. **保留期按 createdAt 起算**（不滑动），与续接 TTL 解耦；
 * 4. `appendAskTurn` 走字段白名单 —— 多传的字段不得落盘。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/ask-store-v2.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../src/lib/config.js';

/**
 * ⚠️ 必须用 `KI_CONFIG_PATH` 指向临时配置，**不能只设 `KI_DATA_DIR`**：
 * 本机 `~/.ki/config.yaml` 里显式写了 `chatDir: /root/chat`，
 * 而 `chatRootDir()` 优先读 `cfg.chatDir` —— 只改 dataDir 会让测试直接写进真实会话目录
 * （2026-11-16 实测踩过：`/root/chat/test-ask-store/` 被写过一次，已清理）。
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ask-store-'));
const CONFIG_PATH = path.join(ROOT, 'config.yaml');
fs.writeFileSync(CONFIG_PATH, `dataDir: ${ROOT}/data\nchatDir: ${ROOT}/chat\n`);
process.env.KI_CONFIG_PATH = CONFIG_PATH;

const SCOPE = 'test-ask-store';
const DAY = 86_400_000;
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

let store: typeof import('../src/lib/chat/ask/ask-store.js');
let chatPkg: typeof import('../src/lib/chat/chat-store.js');

before(async () => {
  resetConfigCache();
  store = await import('../src/lib/chat/ask/ask-store.js');
  chatPkg = await import('../src/lib/chat/chat-store.js');
  // 落点必须在临时目录里 —— 这条断言本身就是"别再污染真实目录"的守卫
  const dir = chatPkg.chatDirFor(SCOPE);
  if (!dir.startsWith(ROOT)) throw new Error(`会话目录未隔离：${dir}`);
});

after(() => {
  delete process.env.KI_CONFIG_PATH;
  resetConfigCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

/** 直接落一份"旧版"文件（绕过 createAskSession） */
function writeLegacyFile(id: string, ownerKey: string, createdAt: string): void {
  const dir = chatPkg.chatDirFor(SCOPE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    version: 1,
    id,
    scope: SCOPE,
    ownerKey,
    createdAt,
    updatedAt: createdAt,
    messages: [{ role: 'user', content: '旧问题', at: createdAt }],
  }), 'utf-8');
}

describe('短会话结构 v2', () => {
  it('新建即写入 version:2 与 origin', async () => {
    const file = await store.createAskSession(SCOPE, 'local', { kind: 'local' });
    assert.equal(file.version, 2);
    assert.deepEqual(file.origin, { kind: 'local' });
    const back = await store.readAskSession(SCOPE, file.id);
    assert.deepEqual(back?.origin, { kind: 'local' });
  });

  it('Token 来源带名称快照（Token 删除后仍能显示原名）', async () => {
    const file = await store.createAskSession(SCOPE, 'tok-abc12345', {
      kind: 'token', tokenId: 'tok-abc12345', tokenLabel: 'codex',
    });
    const back = await store.readAskSession(SCOPE, file.id);
    assert.deepEqual(back?.origin, { kind: 'token', tokenId: 'tok-abc12345', tokenLabel: 'codex' });
  });

  it('appendAskTurn 落盘 background 与 sources，且只接受白名单字段', async () => {
    const file = await store.createAskSession(SCOPE, 'local', { kind: 'local' });
    await store.appendAskTurn(SCOPE, file.id, [
      { role: 'user', content: '问', at: '2026-11-16T04:00:00.000Z', background: '背景原文' },
      {
        role: 'assistant',
        content: '答',
        at: '2026-11-16T04:00:00.000Z',
        sources: [{ group: 'g', doc: 'd', lineStart: 1, lineEnd: 2, snippet: 's' }],
        // 白名单外的字段（模拟将来给消息加内部字段）：不得落盘
        // @ts-expect-error 故意越界
        reasoning: '不应落盘',
      },
    ]);
    const back = await store.readAskSession(SCOPE, file.id);
    const [u, a] = back!.messages;
    assert.equal(u!.background, '背景原文');
    assert.equal(a!.sources?.length, 1);
    assert.equal('reasoning' in (a as object), false, '白名单外字段被写进了文件');
  });

  it('不传 background / sources 时不写空字段', async () => {
    const file = await store.createAskSession(SCOPE, 'local', { kind: 'local' });
    await store.appendAskTurn(SCOPE, file.id, [
      { role: 'user', content: '问', at: isoAgo(1000) },
      { role: 'assistant', content: '答', at: isoAgo(1000) },
    ]);
    const back = await store.readAskSession(SCOPE, file.id);
    assert.equal('background' in back!.messages[0]!, false);
    assert.equal('sources' in back!.messages[1]!, false);
  });
});

describe('旧文件（version:1）读时归一', () => {
  it('ownerKey 为 tokenId → 推导为 token 来源', async () => {
    const id = 'ka-legacy1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    writeLegacyFile(id, 'tok-legacy9', isoAgo(DAY));
    const back = await store.readAskSession(SCOPE, id);
    assert.deepEqual(back?.origin, { kind: 'token', tokenId: 'tok-legacy9' });
  });

  it("ownerKey 为 'local' → 推导为本地来源", async () => {
    const id = 'ka-legacy2-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writeLegacyFile(id, 'local', isoAgo(DAY));
    const back = await store.readAskSession(SCOPE, id);
    assert.deepEqual(back?.origin, { kind: 'local' });
  });
});

describe('保留期（按 createdAt，不滑动）', () => {
  it('6 天内未过期、8 天后过期', () => {
    assert.equal(store.isAskSessionPastRetention({ createdAt: isoAgo(6 * DAY) }, 7), false);
    assert.equal(store.isAskSessionPastRetention({ createdAt: isoAgo(8 * DAY) }, 7), true);
  });

  it('即使 updatedAt 很新，只要 createdAt 超期就算过期（不滑动）', async () => {
    const id = 'ka-legacy3-cccccccccccccccccccccccccccccccc';
    writeLegacyFile(id, 'local', isoAgo(30 * DAY));
    // 手工把 updatedAt 刷成"刚刚"，模拟高频续接的老记录
    const p = path.join(chatPkg.chatDirFor(SCOPE), `${id}.json`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(p, JSON.stringify({ ...raw, updatedAt: new Date().toISOString() }), 'utf-8');

    const back = await store.readAskSession(SCOPE, id);
    assert.equal(store.isAskSessionExpired(back!, 600_000), false, '续接 TTL 应判为"未过期"');
    assert.equal(store.isAskSessionPastRetention(back!, 7), true, '保留期必须按 createdAt 判');
  });

  it('retainUntil = createdAt + N 天', () => {
    const createdAt = '2026-11-16T00:00:00.000Z';
    assert.equal(
      store.askSessionRetainUntil({ createdAt }, 7),
      '2026-11-23T00:00:00.000Z',
    );
  });
});
