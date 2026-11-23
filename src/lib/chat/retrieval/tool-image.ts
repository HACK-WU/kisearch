/**
 * 工具图片结果的判别与转换（REQ-20261123-008 · B2）
 *
 * ═══ 为什么需要判别形状（DESIGN §6.3）═══
 * 工具 `run()` 的返回值一律经 `serializeToolResponse` → `JSON.stringify` → 按字符二分截断。
 * 图片若以 base64 混在普通对象里，会**瞬间撞穿 10000 字符预算**，而且截断后的 base64
 * 不可解码（模型拿到坏图）。所以取图工具必须返回一个**可判别**的形状，让 `tool-loop`
 * 在序列化**之前**把字节抽走、正文只留摘要。
 *
 * ═══ ★ 判别必须精确比较 `kind === 'images'` ═══
 * 既有工具已经在返回体里使用 `kind` 字段：
 *   `ki_lifecycle_list` → `kind: 'wiki' | 'temp' | 'event'`（src/lib/mcp-tools/lifecycle-list.ts）
 *   `ki_ask` 的 principal → `kind: 'local' | 'token'`
 * 因此**绝不能**写成 `'kind' in value` 或 `typeof value.kind === 'string'` ——
 * 那会把上面这些工具的正常结果误判成图片结果，导致正文被丢弃（评审 N1）。
 */

import type { ChatContentPart, ChatTurn } from '../llm-client.js';
// 类型真源在 asset-image（取图执行层），这里只做判别与转换，避免两处各定义一份
import type { GetImageResult, ToolImagePayload } from '../../asset-image.js';

export type { ToolImagePayload };

/** 取图工具的返回形状 */
export type ToolImageResult = GetImageResult;

/**
 * 是否图片结果。
 *
 * 三个条件同时成立才算：`kind` 精确等于 `'images'`、`text` 是字符串、`images` 是数组。
 * 只看 `kind` 不够 —— 形状不对时宁可让调用方走普通序列化，也不要半途拆出空图片。
 */
export function isToolImageResult(value: unknown): value is ToolImageResult {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'images' && typeof v.text === 'string' && Array.isArray(v.images);
}

/**
 * 转成上游 content parts：首个 text 摘要 + 每张图一个 `image_url`（**顺序与入参一致**）。
 *
 * `data:` URI 是唯一可行的内联方式 —— 图在本机 KB 目录，`127.0.0.1` 模型侧取不到。
 */
export function toImageParts(result: ToolImageResult, textOverride?: string): ChatContentPart[] {
  const parts: ChatContentPart[] = [{ type: 'text', text: textOverride ?? result.text }];
  for (const img of result.images) {
    if (!img?.data || !img?.mimeType) continue; // 半截载荷直接跳过，不让它污染 content
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
  }
  return parts;
}

/**
 * 把**更早的**图片从上下文里降级成文本占位（REQ-20261123-008 · B4，DESIGN §3 ④）。
 *
 * ═══ 为什么必须做 ═══
 * `messages` 在单次生成内是**只增不删**的数组，第 1 轮取的图会一直躺在里面，
 * 而每一轮请求都会把它重新发给上游 —— 一张 1024² 图 652 tokens × 剩余轮数，
 * 外加每次都重传 150KB~5MB 的 base64。表现是"越聊越慢、越聊越贵"，且没有任何报错。
 *
 * ═══ 调用时机 ═══
 * 在 push **新的**带图 tool 消息**之前**调用：这样任何时刻最多只有一条消息带图，
 * 且带图的一定是最新那条（模型刚看过的）。反过来（先 push 再降级）就得额外判断
 * "最后一条别降"，容易写错。
 *
 * 跨**用户**轮次不需要它：`conv.messages` 只落字符串，历史轮次的图根本不会重建。
 *
 * @returns 被降级的消息条数（供测试与排查）
 */
export function demoteOlderImages(messages: ChatTurn[]): number {
  let demoted = 0;
  for (const m of messages) {
    if (m.role !== 'tool' || typeof m.content === 'string') continue;
    const images = m.content.filter((p) => p.type === 'image_url').length;
    if (images === 0) continue;
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    // 换回普通字符串：既不占图片预算，也让后续 `computeContextChars` 走最常见的分支
    m.content = `${text ? `${text}\n` : ''}[图片×${images}（已省略，如需重看请重新调用 ki_get_image）]`;
    demoted += 1;
  }
  return demoted;
}

/**
 * 生成给页面/落盘用的**摘要对象** —— 用它替代原始结果去 `serializeToolResponse`。
 *
 * 关键：**不含 base64**。`tool_end` 事件会落盘并在前端展示，把字节塞进去会 double 膨胀。
 */
export function toToolImageSummary(result: ToolImageResult): Record<string, unknown> {
  return {
    ok: true,
    kind: 'images',
    text: result.text,
    images: result.images.map((img) => ({
      ref: img.ref,
      mime: img.mimeType,
      bytes: img.bytes,
      ...(img.width !== undefined ? { width: img.width } : {}),
      ...(img.height !== undefined ? { height: img.height } : {}),
      ...(img.sourceFormat ? { sourceFormat: img.sourceFormat } : {}),
    })),
  };
}
