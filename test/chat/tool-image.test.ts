/**
 * 工具图片结果的判别与转换（REQ-20261123-008 · B2）
 *
 * ═══ 本文件守的是什么 ═══
 * `ki_get_image` 的返回里带 base64。若判别写错，两个方向的损失都很隐蔽：
 *   · **判漏**（该判没判）→ base64 走 `JSON.stringify` 撞穿字符预算，且被二分截断后
 *     不可解码，模型拿到坏图（表现为"看不懂这张图"而不是报错）；
 *   · **判多**（不该判却判了）→ `ki_lifecycle_list` 这类**返回体里本来就有 `kind` 字段**
 *     的工具会被误当图片结果，正文被丢掉。
 *
 * 所以这里把「精确比较 `kind === 'images'`」与「既有 kind 值不吃误判」都钉成回归。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/tool-image.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isToolImageResult,
  toImageParts,
  toToolImageSummary,
  demoteOlderImages,
  type ToolImageResult,
} from '../../src/lib/chat/retrieval/tool-image.js';
import type { ChatTurn } from '../../src/lib/chat/llm-client.js';

const payload = {
  mimeType: 'image/png',
  data: Buffer.from('fake-png-bytes').toString('base64'),
  ref: 'assets/x.png',
  bytes: 14,
};

const result: ToolImageResult = {
  kind: 'images',
  text: '已读取 1 张图片：assets/x.png',
  images: [payload],
};

describe('isToolImageResult', () => {
  it('合法形状判为图片结果', () => {
    assert.equal(isToolImageResult(result), true);
  });

  it('★ 既有 kind 值不得误判（lifecycle / ask principal 已在用 kind）', () => {
    // ki_lifecycle_list 的返回体条目
    assert.equal(isToolImageResult({ kind: 'wiki', label: '长期保留' }), false);
    assert.equal(isToolImageResult({ kind: 'temp', ttlOptions: [7, 30, 90] }), false);
    assert.equal(isToolImageResult({ kind: 'event' }), false);
    // ki_ask 的 principal
    assert.equal(isToolImageResult({ kind: 'token', tokenId: 'x' }), false);
    assert.equal(isToolImageResult({ kind: 'local' }), false);
  });

  it('形状残缺不判（避免拆出空图片、把正文吞掉）', () => {
    assert.equal(isToolImageResult({ kind: 'images' }), false, '缺 text/images');
    assert.equal(isToolImageResult({ kind: 'images', text: 'x' }), false, 'images 不是数组');
    assert.equal(isToolImageResult({ kind: 'images', text: 'x', images: 'oops' }), false);
    assert.equal(isToolImageResult({ kind: 'images', images: [] }), false, '缺 text');
  });

  it('非对象/null 不判', () => {
    assert.equal(isToolImageResult(null), false);
    assert.equal(isToolImageResult(undefined), false);
    assert.equal(isToolImageResult('kind=images'), false);
    assert.equal(isToolImageResult([{ kind: 'images' }]), false);
  });
});

describe('toImageParts', () => {
  it('首块是文本摘要，随后每张图一个 image_url（data URI）', () => {
    const parts = toImageParts(result);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], { type: 'text', text: result.text });
    const img = parts[1]!;
    assert.equal(img.type, 'image_url');
    if (img.type !== 'image_url') return;
    assert.equal(img.image_url.url, `data:image/png;base64,${payload.data}`);
    // ★ base64 只能出现在 data URI 里，不得混进 text 分片
    assert.equal(parts[0]!.type === 'text' && parts[0].text.includes(payload.data), false);
  });

  it('多张图顺序与入参一致', () => {
    const multi: ToolImageResult = {
      kind: 'images',
      text: '2 张',
      images: [
        { ...payload, ref: 'a.png' },
        { ...payload, ref: 'b.png', mimeType: 'image/jpeg' },
      ],
    };
    const parts = toImageParts(multi);
    assert.equal(parts.length, 3);
    const urls = parts.slice(1).map((p) => (p.type === 'image_url' ? p.image_url.url.slice(0, 22) : ''));
    assert.deepEqual(urls, ['data:image/png;base64,', 'data:image/jpeg;base64']);
  });

  it('载荷残缺的条目跳过，不产生空 image part', () => {
    const broken: ToolImageResult = {
      kind: 'images',
      text: '1 张',
      images: [{ ...payload, data: '' }],
    };
    const parts = toImageParts(broken);
    assert.equal(parts.length, 1, '只剩文本块');
  });

  it('可覆盖文本（用于把序列化后的摘要作为 text 分片）', () => {
    const parts = toImageParts(result, 'OVERRIDE');
    assert.deepEqual(parts[0], { type: 'text', text: 'OVERRIDE' });
  });
});

describe('demoteOlderImages（B4 · 旧图降级）', () => {
  const toolWithImage = (n: number): ChatTurn => ({
    role: 'tool',
    tool_call_id: `c${n}`,
    content: [
      { type: 'text', text: `摘要${n}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,aaa${n}` } },
    ],
  });

  it('把带图 tool 消息降级成纯文本 + 占位（不丢摘要）', () => {
    const messages: ChatTurn[] = [toolWithImage(1)];
    const n = demoteOlderImages(messages);
    assert.equal(n, 1);
    assert.equal(typeof messages[0]!.content, 'string');
    const text = messages[0]!.content as string;
    assert.match(text, /摘要1/, '原摘要要保留');
    assert.match(text, /\[图片×1（已省略/);
    assert.equal(text.includes('aaa1'), false, 'base64 必须消失');
  });

  it('多条带图消息全部降级，各条张数分别标注', () => {
    const messages: ChatTurn[] = [toolWithImage(1), toolWithImage(2), toolWithImage(3)];
    assert.equal(demoteOlderImages(messages), 3);
    for (const [i, m] of messages.entries()) {
      assert.equal(typeof m.content, 'string');
      assert.match(m.content as string, new RegExp(`摘要${i + 1}`));
    }
  });

  it('纯文本消息与 user/assistant 不受影响', () => {
    const messages: ChatTurn[] = [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '答' },
      { role: 'tool', tool_call_id: 'x', content: '普通工具返回' },
    ];
    assert.equal(demoteOlderImages(messages), 0);
    assert.equal(messages[0]!.content, '问题');
    assert.equal(messages[2]!.content, '普通工具返回');
  });

  it('★ 模拟 tool-loop 顺序：先降级再 push 新图 ⇒ 始终只有一条带图', () => {
    const messages: ChatTurn[] = [toolWithImage(1), toolWithImage(2)];
    // 第二张图到达时：先降级更早的，再 push 新的
    demoteOlderImages(messages);
    messages.push(toolWithImage(3));

    const withImages = messages.filter((m) => Array.isArray(m.content));
    assert.equal(withImages.length, 1, '任何时刻最多一条消息带图');
    assert.equal(withImages[0]!.tool_call_id, 'c3', '带图的必须是最新那条');
  });
});

describe('toToolImageSummary', () => {
  it('★ 摘要绝不含 base64（tool_end 会落盘并在前端展示）', () => {
    const summary = toToolImageSummary(result);
    const text = JSON.stringify(summary);
    assert.equal(text.includes(payload.data), false, 'base64 泄漏进事件/落盘');
    assert.equal(summary.kind, 'images');
    assert.equal(summary.text, result.text);
    const images = summary.images as Array<Record<string, unknown>>;
    assert.equal(images[0]!.ref, 'assets/x.png');
    assert.equal(images[0]!.mime, 'image/png');
    assert.equal(images[0]!.bytes, 14);
  });

  it('尺寸与来源格式仅在存在时出现', () => {
    const withMeta = toToolImageSummary({
      kind: 'images',
      text: 'x',
      images: [{ ...payload, width: 1568, height: 743, sourceFormat: 'image/svg+xml' }],
    });
    const first = (withMeta.images as Array<Record<string, unknown>>)[0]!;
    assert.equal(first.width, 1568);
    assert.equal(first.height, 743);
    assert.equal(first.sourceFormat, 'image/svg+xml');

    const plain = toToolImageSummary(result);
    const p = (plain.images as Array<Record<string, unknown>>)[0]!;
    assert.equal('width' in p, false);
    assert.equal('sourceFormat' in p, false);
  });
});
