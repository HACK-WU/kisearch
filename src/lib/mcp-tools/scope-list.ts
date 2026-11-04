import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeScopeList } from '../../scope.js';
import { isScopeAuthorized } from '../mcp-token.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

/**
 * 注册 ki_scope_list 工具。
 * @param authScopes 当前会话的授权 scope 集合（null = 免鉴权不限）；非 null 时按授权过滤，
 *   避免持有受限 Token 的客户端通过枚举泄露未授权 scope 的存在与结构。
 */
export function registerScopeListTool(server: McpServer, authScopes: string[] | null = null): void {
  server.tool(
    'ki_scope_list',
    '列出所有 scope（KB 目录层 + 向量语义层并集，标注每个 scope 存在于哪层、是否已在配置注册）',
    {},
    async () => {
      try {
        const result = await withTimeout(
          executeScopeList(),
          TOOL_TIMEOUT.READ,
          'ki_scope_list'
        );
        // RBAC：按授权 scope 过滤（null 免鉴权不过滤；否则仅保留授权范围内的 scope）
        const visible = authScopes === null
          ? result.scopes
          : result.scopes.filter((s) => isScopeAuthorized(authScopes, s.scope));
        /**
         * 视图按「视图本身的授权」过滤，不做成员级过滤。
         *
         * 为什么不滤成员：授权视图即授权其成员内容（S-04 D3）；隐藏库名会让前端的
         * 「来源库标记」无法解释，也会让浏览页拿不到成员的只读态（memberMeta）。
         *
         * ⚠️ REQ-20261104-004 将收紧为「授权视图 ∧ 授权全部成员」才可见（全有或全无），
         * 届时只改这一处过滤条件。
         */
        const visibleViews = result.views === undefined
          ? undefined
          : authScopes === null
            ? result.views
            : result.views.filter((v) => isScopeAuthorized(authScopes, v.view));
        const payload = authScopes === null
          ? result
          : {
            ...result,
            count: visible.length,
            scopes: visible,
            ...(visibleViews === undefined ? { views: undefined } : { views: visibleViews }),
          };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );
}
