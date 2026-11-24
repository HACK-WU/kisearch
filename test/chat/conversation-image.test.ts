/**
 * 会话图片存储与编辑语义（REQ-20261123-006）
 *
 * 守四件事：
 *   ① 字节落 `assets/{convId}__{id}.{ext}`、会话 JSON **只存元数据**（不存 base64）；
 *   ② 读不到时返回 `null`（不抛）—— 调用方要能区分"被清理"与"读盘故障"；
 *   ③ 删会话级联删本地图，但**不碰 KB 资产**（N15）；
 *   ④ 编辑重发时 `images` 传 undefined = 保留原图（Q-A），传空数组 = 清空。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/conversation-image.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { useTempHome } from '../isolate-home.js';
import { registerTestScope } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import {
  createConversation,
  saveConversationImage,
  readConversationImage,
  statConversationImage,
  deleteConversationImage,
  deleteConversation,
  appendMessage,
  readConversation,
  truncateAfterAndEdit,
  chatRootDir,
} from '../../src/lib/chat/chat-store.js';

const tempHome = useTempHome('ki-conv-image-');
process.env.KI_CONFIG_PATH = path.join(tempHome.home, 'config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const SCOPE = `img-${Date.now()}`;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 9),
]);

before(() => {
  registerTestScope(SCOPE);
  initScope(SCOPE);
});

after(() => {
  try {
    fs.rmSync(getKbDir(SCOPE), { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe('saveConversationImage', () => {
  it('落盘并返回元数据（不含 base64），文件名带会话前缀', async () => {
    const conv = await createConversation(SCOPE, { title: 't' });
    const image = await saveConversationImage(SCOPE, conv.id, PNG, 'image/png');

    assert.equal(image.mime, 'image/png');
    assert.equal(image.bytes, PNG.byteLength);
    assert.match(image.id, /^[A-Za-z0-9-]{8,40}$/);

    const file = path.join(chatRootDir(), SCOPE, 'assets', `${conv.id}__${image.id}.png`);
    assert.equal(fs.existsSync(file), true, `应落在 assets 目录：${file}`);

    // ★ 会话 JSON 里不能出现 base64
    const onDisk = fs.readFileSync(
      path.join(chatRootDir(), SCOPE, `${conv.id}.json`),
      'utf8',
    );
    assert.equal(onDisk.includes(Buffer.from(PNG).toString('base64').slice(0, 20)), false);
  });

  it('不支持的 mime 直接拒绝（不落任何文件）', async () => {
    const conv = await createConversation(SCOPE, { title: 't2' });
    await assert.rejects(
      () => saveConversationImage(SCOPE, conv.id, PNG, 'image/svg+xml'),
      /不支持的图片格式/,
    );
  });
});

describe('读 / stat / 删除', () => {
  it('读回字节与 mime；stat 不读整份内容', async () => {
    const conv = await createConversation(SCOPE, { title: 't3' });
    const image = await saveConversationImage(SCOPE, conv.id, PNG, 'image/webp');

    const back = await readConversationImage(SCOPE, conv.id, image.id);
    assert.ok(back);
    assert.equal(back!.mime, 'image/webp');
    assert.deepEqual([...back!.buffer], [...PNG]);

    const meta = await statConversationImage(SCOPE, conv.id, image.id);
    assert.deepEqual(meta, { mime: 'image/webp', bytes: PNG.byteLength });
  });

  it('不存在返回 null（不抛）；非法 id 一律 null（防路径穿越）', async () => {
    const conv = await createConversation(SCOPE, { title: 't4' });
    assert.equal(await readConversationImage(SCOPE, conv.id, 'nonexistent-id'), null);
    assert.equal(await readConversationImage(SCOPE, conv.id, '../../kb/x'), null);
    assert.equal(await statConversationImage(SCOPE, conv.id, 'a/b'), null);
    assert.equal(await deleteConversationImage(SCOPE, conv.id, '../../etc/passwd'), false);
  });

  it('删除幂等：删两次都是 false，第一次 true', async () => {
    const conv = await createConversation(SCOPE, { title: 't5' });
    const image = await saveConversationImage(SCOPE, conv.id, PNG, 'image/png');
    assert.equal(await deleteConversationImage(SCOPE, conv.id, image.id), true);
    assert.equal(await deleteConversationImage(SCOPE, conv.id, image.id), false);
    assert.equal(await readConversationImage(SCOPE, conv.id, image.id), null);
  });
});

describe('删会话级联', () => {
  it('删会话清掉 {convId}__*，且不影响其它会话的图', async () => {
    const a = await createConversation(SCOPE, { title: 'a' });
    const b = await createConversation(SCOPE, { title: 'b' });
    const imgA = await saveConversationImage(SCOPE, a.id, PNG, 'image/png');
    const imgB = await saveConversationImage(SCOPE, b.id, PNG, 'image/png');

    await deleteConversation(SCOPE, a.id);

    assert.equal(await readConversationImage(SCOPE, a.id, imgA.id), null, 'A 的图应被级联删除');
    assert.ok(await readConversationImage(SCOPE, b.id, imgB.id), 'B 的图不能被误删');
  });
});

describe('编辑重发的 images 语义（Q-A）', () => {
  it('不传 images ⇒ 保留原图；传空数组 ⇒ 清空', async () => {
    const conv = await createConversation(SCOPE, { title: 'edit' });
    const image = await saveConversationImage(SCOPE, conv.id, PNG, 'image/png');
    const withMsg = await appendMessage(SCOPE, conv.id, {
      id: '',
      role: 'user',
      content: '看图',
      at: new Date().toISOString(),
      images: [{ id: image.id, mime: image.mime, bytes: image.bytes }],
    });
    const userMsg = withMsg.messages.at(-1)!;
    assert.equal(userMsg.images?.length, 1);

    // ① 不传 images：保留
    const kept = await truncateAfterAndEdit(SCOPE, conv.id, userMsg.id, '改个说法');
    assert.equal(kept.conv.messages.at(-1)!.images?.length, 1, '编辑不应默默丢图');
    assert.equal(kept.conv.messages.at(-1)!.content, '改个说法');

    // ② 传空数组：清空
    const cleared = await truncateAfterAndEdit(SCOPE, conv.id, userMsg.id, '不要图了', undefined, []);
    assert.equal(cleared.conv.messages.at(-1)!.images, undefined);

    const back = await readConversation(SCOPE, conv.id);
    assert.equal(back!.messages.at(-1)!.images, undefined);
  });
});
