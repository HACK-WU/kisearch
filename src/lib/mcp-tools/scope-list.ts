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
         * 视图可见性（REQ-20261104-004 D3 / R-02）：**授权视图 ∧ 授权全部成员**，
         * 缺任一则整个视图不出现（全有或全无，**不做部分可见**）。
         *
         * 为什么必须是"与"而不是"或"：只判视图名授权时，给一个视图授权就等于给了它
         * 全部成员的内容 —— 视图会变成越权通道。收紧之后视图才退化为纯便利层。
         *
         * 注意：**成员列表本身仍不过滤**（看得到视图 = 看得到它的全部成员名）。
         * 隐藏库名会让前端的「来源库标记」无法解释，也会让浏览页拿不到成员的只读态。
         */
        const visibleViews = result.views === undefined
          ? undefined
          : authScopes === null
            ? result.views
            : result.views.filter((v) =>
              isScopeAuthorized(authScopes, v.view)
              && v.members.every((m) => isScopeAuthorized(authScopes, m)));
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
