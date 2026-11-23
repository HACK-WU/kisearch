/**
 * `ki_get_image` —— 读取知识库文档中图片的实际内容（只读，REQ-20261123-008 B2）
 *
 * ═══ 为什么需要这个工具（而不是把图塞进读文档的返回）═══
 * 图字节进 `ki_get_module_info` 会让**每次读文档**都拖上图片：一张 1024² 图 = 652 tokens，
 * 且 base64 会撞穿工具返回的 10000 字符预算。所以清单只给元数据，图由模型**按需**取（DESIGN D1/D2）。
 *
 * ═══ 返回形状 ═══
 * 对外是标准 MCP content：一段 JSON 摘要 + 每张图一个 `{type:'image'}`。
 * 内部对话链路走 `chat/mcp-tool-registry.ts` 的同名 entry，返回判别形状
 * `{kind:'images'}`（字节不进 `tool_end` 事件，见 `chat/retrieval/tool-image.ts`）。
 *
 * ═══ scope 的处理 ═══
 * 本工具是**对外** MCP 面，schema 里有 `scope`（外部客户端需要指定库）。
 * 内部对话面**没有** scope 参数 —— 那个由 daemon 注入（N23 禁止跨 scope）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGetImage, MAX_IMAGES_PER_CALL } from '../asset-image.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerGetImageTool(server: McpServer): void {
  server.tool(
    'ki_get_image',
    '读取知识库文档里某张图片的**实际内容**（像素），返回图片供你直接查看。'
      + '入参 refs 用 ki_get_module_info 返回的 images[].ref 原样传（一次 1~3 张）；'
      + '图片引用可能失效或格式不支持，返回体会逐条说明哪张没取到以及原因',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      group: z.string().describe('文档所属 Group（与读该文档时用的 group 一致）'),
      refs: z
        .array(z.string())
        .min(1)
        .max(MAX_IMAGES_PER_CALL)
        .describe(`images[].ref 原样传回，1~${MAX_IMAGES_PER_CALL} 张`),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          // allowSvg：SVG 走 worker 栅格化（DESIGN D9）。整次超时用 READ 档 30s ——
          // 覆盖"3 张 × 单张 10s"的最坏情况（B2 时该参数为 false，B3 打开）
          executeGetImage({ scope: args.scope, group: args.group, refs: args.refs, allowSvg: true }),
          TOOL_TIMEOUT.READ,
          'ki_get_image',
        );

        const summary = {
          ok: result.images.length > 0,
          text: result.text,
          count: result.images.length,
          images: result.images.map((img) => ({
            ref: img.ref,
            mime: img.mimeType,
            bytes: img.bytes,
            ...(img.width !== undefined ? { width: img.width } : {}),
            ...(img.height !== undefined ? { height: img.height } : {}),
            ...(img.sourceFormat ? { sourceFormat: img.sourceFormat } : {}),
          })),
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
            ...result.images.map((img) => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
          ],
          // 一张都没取到 ⇒ 标错误，让客户端不要把它当成"成功但空"
          ...(result.images.length === 0 ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: (err as Error).message }],
        };
      }
    },
  );
}
