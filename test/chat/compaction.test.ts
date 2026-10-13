/**
 * 手动压缩上下文 · 存储层（REQ-20261013-001 R8）
 *
 * ═══ 本文件存在的理由 ═══
 * 压缩是**不可逆**的消息改写：写错一次就是用户的对话历史没了。三条硬约束必须锁住
 * （plan 护栏 #4/#5）：
 *   ① **无备份不压缩** —— 备份失败/缺失时绝不改会话；
 *   ② **摘要失败不落盘** —— 上游报错时会话保持原样（不静默降级为截断）；
 *   ③ **期间变化不写回** —— 拿到快照后、提交前若会话又长了（新一轮问答），
 *      必须拒绝而不是把新一轮静默吃掉（N11 同源风险）；
 *   ④ 撤销能恢复被移出的消息，备份缺失/损坏时 **fail-loud**（不假装成功）。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/compaction.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MessageInvalidError,
  appendMessage,
  chatDirFor,
  compactConversation,
  createConversation,
  listConversations,
  planCompaction,
  readConversation,
  undoCompaction,
} from '../../src/lib/chat/chat-store.js';
import type { ChatMessage } from '../../src/lib/chat/chat-contract.js';

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-chat-compact-'));
  const cfgPath = path.join(tmpRoot, 'config.yaml');
  fs.writeFileSync(cfgPath, [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    `chatDir: ${path.join(tmpRoot, 'chat')}`,
    'scopeMode: default',
    'scopes:',
    '  default: {}',
    'embedding:',
    '  provider: mock',
    '  baseURL: http://127.0.0.1:1/v1',
    '  model: mock-embedding',
    '  dimension: 8',
    '  apiKey: mock-key',
  ].join('\n'), 'utf8');
  process.env.KI_CONFIG_PATH = cfgPath;
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.KI_CONFIG_PATH;
});

const msg = (id: string, role: 'user' | 'assistant', content: string): ChatMessage =>
  ({ id, role, content, at: '2026-01-01T00:00:00Z' });

/** 建一个含 n 条消息的会话 */
async function seed(n: number): Promise<string> {
  const conv = await createConversation('default', { title: 't' });
  for (let i = 0; i < n; i += 1) {
    await appendMessage('default', conv.id, {
      id: '', role: i % 2 === 0 ? 'user' : 'assistant', content: `第${i}条消息的内容`, at: new Date().toISOString(),
    });
  }
  return conv.id;
}

describe('planCompaction（纯函数）', () => {
  it('空会话 / 消息过少 → 明确拒绝并给出人话原因', () => {
    assert.equal(planCompaction([]).ok, false);
    const few = [msg('m1', 'user', 'a'), msg('m2', 'assistant', 'b')];
    const r = planCompaction(few);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /消息过少/);
  });

  it('keepRecent=0 被拒绝（不得把会话压空）', () => {
    const messages = Array.from({ length: 7 }, (_, i) => msg(`m${i + 1}`, i % 2 === 0 ? 'user' : 'assistant', `c${i}`));
    const r = planCompaction(messages, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /至少为 1/);
  });

  it('保留最近 4 条，其余为被压缩部分', () => {
    const messages = Array.from({ length: 7 }, (_, i) => msg(`m${i + 1}`, i % 2 === 0 ? 'user' : 'assistant', `c${i}`));
    const r = planCompaction(messages);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.covered.length, 3);
    assert.equal(r.keep.length, 4);
    assert.equal(r.keep[0]!.id, 'm4');
  });
});

describe('compactConversation（摘要式）', () => {
  it('① 摘要式：改写 messages、写 compaction、留备份；备份不被列表当成会话', async () => {
    const id = await seed(6);
    let coveredSeen = 0;
    const r = await compactConversation('default', id, {
      summarize: async (covered) => {
        coveredSeen = covered.length;
        return '摘要正文：用户问了若干问题。';
      },
    });

    assert.equal(r.mode, 'summary');
    assert.equal(r.coveredCount, 2);
    assert.equal(coveredSeen, 2, '摘要器应拿到被压缩的 2 条');
    assert.ok(r.charsAfter < r.charsBefore, '压缩后字符数应下降');

    const after = await readConversation('default', id);
    assert.equal(after!.messages.length, 4);
    assert.equal(after!.messageCount, 4);
    assert.equal(after!.compaction!.summary, '摘要正文：用户问了若干问题。');
    assert.equal(after!.compaction!.mode, 'summary');
    assert.equal(after!.compaction!.backup, r.backup);

    // 备份 = 压缩前原样
    const backupPath = path.join(chatDirFor('default'), r.backup);
    assert.equal(fs.existsSync(backupPath), true, '备份文件必须存在');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as { messages: ChatMessage[] };
    assert.equal(backup.messages.length, 6, '备份里应是被压缩前的全部消息');

    // ★ 备份名带 `.`：不匹配 `c-*.json` 会话文件名规则 → 不出现在会话列表
    const list = await listConversations('default', {});
    assert.equal(list.items.length, 1, '备份不得被当成会话');
    assert.equal(list.items[0]!.messageCount, 4);
  });

  it('② 截断式：不调摘要器 → summary=null 且 mode=truncate（降级形态可辨识）', async () => {
    const id = await seed(6);
    const r = await compactConversation('default', id);
    assert.equal(r.mode, 'truncate');
    const after = await readConversation('default', id);
    assert.equal(after!.compaction!.summary, null);
    assert.equal(after!.compaction!.mode, 'truncate');
  });

  it('③ 摘要失败 → 抛错且**会话保持原样**（不静默降级为截断）', async () => {
    const id = await seed(6);
    await assert.rejects(
      () => compactConversation('default', id, { summarize: async () => { throw new Error('上游 500'); } }),
      /上游 500/,
    );
    const after = await readConversation('default', id);
    assert.equal(after!.messages.length, 6, '失败时消息必须一条不少');
    assert.equal(after!.compaction, undefined, '失败时不得留下压缩记录');
  });

  it('④ 压缩期间会话又长了 → 拒绝写回（不静默吃掉新一轮问答）', async () => {
    const id = await seed(6);
    await assert.rejects(
      () => compactConversation('default', id, {
        summarize: async () => {
          // 模拟"摘要生成期间用户又完成了一轮问答"
          await appendMessage('default', id, { id: '', role: 'user', content: '新一轮提问', at: new Date().toISOString() });
          return '摘要';
        },
      }),
      /会话在压缩期间发生变化/,
    );
    const after = await readConversation('default', id);
    assert.equal(after!.messages.length, 7, '新增消息不得被吃掉');
    assert.equal(after!.compaction, undefined);
  });

  it('⑥ 注入投影回调 → compaction.contextChars 落盘（面板据此显示压缩后的值）', async () => {
    const id = await seed(6);
    const r = await compactConversation('default', id, {
      summarize: async () => '摘要',
      projectContextChars: (conv) => conv.messages.length * 1000,
    });
    assert.equal(r.mode, 'summary');
    const after = await readConversation('default', id);
    assert.equal(after!.compaction!.contextChars, 4000, '投影值为 保留 4 条 × 1000');
  });

  it('⑦ 未注入投影回调 → 不写 contextChars（字段缺失，前端回退旧值）', async () => {
    const id = await seed(6);
    await compactConversation('default', id, { summarize: async () => '摘要' });
    const after = await readConversation('default', id);
    assert.equal('contextChars' in after!.compaction!, false);
  });

  it('⑤ 消息过少 → 明确报错（错误信息可直接展示给用户）', async () => {
    const id = await seed(3);
    await assert.rejects(
      () => compactConversation('default', id, { summarize: async () => 'x' }),
      (err: unknown) => err instanceof MessageInvalidError && /消息过少/.test(err.message),
    );
  });
});

describe('undoCompaction（撤销）', () => {
  it('① 从备份恢复全部消息并清除压缩记录', async () => {
    const id = await seed(6);
    const r = await compactConversation('default', id, { summarize: async () => '摘要' });
    assert.equal((await readConversation('default', id))!.messages.length, 4);

    const undone = await undoCompaction('default', id);
    assert.equal(undone.restored, 6);
    const after = await readConversation('default', id);
    assert.equal(after!.messages.length, 6, '被移出的消息应全部回来');
    assert.equal(after!.messageCount, 6);
    assert.equal(after!.compaction, undefined, '撤销后不得残留压缩记录');
    assert.equal(fs.existsSync(path.join(chatDirFor('default'), r.backup)), true, '备份保留（可人工取证）');
  });

  it('② 无压缩记录 → 人话报错', async () => {
    const id = await seed(6);
    await assert.rejects(() => undoCompaction('default', id), /没有可撤销的压缩记录/);
  });

  it('③ 备份缺失 → fail-loud（不假装恢复成功）', async () => {
    const id = await seed(6);
    const r = await compactConversation('default', id, { summarize: async () => '摘要' });
    fs.unlinkSync(path.join(chatDirFor('default'), r.backup));
    await assert.rejects(() => undoCompaction('default', id), /备份已不存在/);
    assert.equal((await readConversation('default', id))!.messages.length, 4, '撤销失败时状态不变');
  });
});
