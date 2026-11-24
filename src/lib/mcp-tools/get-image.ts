/**
 * `ki_get_image` —— 读取知识库文档中图片的实际内容（只读，REQ-20261123-008 B2）
 *
 * ═══ 2026-11-24 降级（REQ-20261124-002 · S-04，事件 #90）═══
 * 本文件是**协议适配层**：它决定 MCP `content` 里放什么。实测（B6 真 HTTP + 真 MCP SDK）
 * 服务端返回的标准 `{type:'image', data, mimeType}` 是对的，但**IDE 侧 MCP 客户端**
 * 把图片转成 `image_url` 后不解码，反而把 base64 当文本注入并截断 → 模型拿不到图，
 * 能力等于不可用。该层不在本仓库内，无法修复。
 *
 * 因此本层改为 **text-only**：给出图片清单 + 两条 HTTP 取件链接 + 本地取件命令。
 * **执行层（`asset-image.ts::executeGetImage`）不变** —— 内部对话面板走
 * `chat/mcp-tool-registry.ts` 的同名 entry，直接调用执行层，**仍能拿到真图片**
 * （实测模型能说出 README 里没有的像素级信息），故本降级不影响自家对话能力。
 *
 * ═══ scope 的处理 ═══
 * 本工具是**对外** MCP 面，schema 里有 `scope`（外部客户端需要指定库）。
 * 内部对话面**没有** scope 参数 —— 那个由 daemon 注入（N23 禁止跨 scope）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGetImage, MAX_IMAGES_PER_CALL } from '../asset-image.js';
import { assetUrls, type DocLinkContext } from './doc-link.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

/** 降级期统一提示：三条取件路 + 两种 404 成因 + 分批口径 */
const DEGRADED_HINT = [
  '本通道不返回图片内容（MCP 客户端不渲染 image content，返回 base64 只会被当文本截断）。取件三条路：',
  '① 程序：GET apiUrl，需 `Authorization: Bearer <token>`；',
  '② 人看一眼：本机浏览器打开 humanUrl（回环免登录；跨机 / 反代需要 Web 登录态）；',
  '③ 落盘后交给读图能力：ki-client asset get --remote <name> --scope <scope> --group <group> --refs <ref> --out <dir>（打印绝对路径）。',
  '若两条链接都返回 404：可能服务端关闭了下载接口（mcp.http.downloadApi=false）或附件已删除；',
  '此时图片清单仍可从 ki_get_module_info 的 images[] 取，取件需运维开启下载接口。',
  `单次最多 ${MAX_IMAGES_PER_CALL} 张，更多请分次调用。`,
].join('\n');

export function registerGetImageTool(server: McpServer): void {
  server.tool(
    'ki_get_image',
    '返回图片清单与 HTTP 取件地址。**本通道不返回图片内容**（客户端无法渲染 MCP image content）；'
      + '需要看图请用返回体里的 apiUrl（程序，带 Bearer）或 humanUrl（浏览器），'
      + '或用 ki-client 把图落到本地再交给读图能力。入参 refs 用 ki_get_module_info 的 images[].ref 原样传（1~3 张）',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      group: z.string().describe('文档所属 Group（与读该文档时用的 group 一致）'),
      refs: z
        .array(z.string())
        .min(1)
        .max(MAX_IMAGES_PER_CALL)
        .describe(`images[].ref 原样传回，1~${MAX_IMAGES_PER_CALL} 张`),
    },
    async (args, extra) => {
      try {
        const result = await withTimeout(
          // allowSvg：SVG 仍要过执行层（栅格化 / 有效性校验），只是字节不再下发给 MCP 客户端
          executeGetImage({ scope: args.scope, group: args.group, refs: args.refs, allowSvg: true }),
          TOOL_TIMEOUT.READ,
          'ki_get_image',
        );

        const images = result.images.map((img) => {
          const urls = assetUrls(
            { scope: args.scope, group: args.group, path: img.ref },
            extra as DocLinkContext,
          );
          return {
            ref: img.ref,
            mime: img.mimeType,
            bytes: img.bytes,
            ...(img.width !== undefined ? { width: img.width } : {}),
            ...(img.height !== undefined ? { height: img.height } : {}),
            ...(img.sourceFormat ? { sourceFormat: img.sourceFormat } : {}),
            ...urls,
          };
        });

        const summary = {
          ok: result.images.length > 0,
          text: result.text,
          count: result.images.length,
          images,
          hint: DEGRADED_HINT,
        };

        return {
          // 只有 text part：这是本降级的全部意义（不再发 image content）
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
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
