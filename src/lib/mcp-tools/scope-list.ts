import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeScopeList } from '../../scope.js';
import { isScopeAuthorized } from '../mcp-token.js';
import { filterAuthorizedViews } from './view-auth.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import type { AtlasScopeMap } from '../atlas/scope-map.js';

/**
 * 图集映射的 RBAC 过滤：主库与图集库**都**可授权才保留该条。
 *
 * 与 scopes / views 同一口径：受限 Token 不能借 `atlas.mappings` 枚举未授权库名。
 */
function filterAtlasMap(atlas: AtlasScopeMap, authScopes: string[]): AtlasScopeMap {
  const mappings: Record<string, string> = {};
  for (const [main, target] of Object.entries(atlas.mappings)) {
    if (isScopeAuthorized(authScopes, main) && isScopeAuthorized(authScopes, target)) {
      mappings[main] = target;
    }
  }
  return { suffix: atlas.suffix, mappings };
}

/**
 * 注册 ki_scope_list 工具。
 * @param authScopes 当前会话的授权 scope 集合（null = 免鉴权不限）；非 null 时按授权过滤，
 *   避免持有受限 Token 的客户端通过枚举泄露未授权 scope 的存在与结构。
 */
export function registerScopeListTool(server: McpServer, authScopes: string[] | null = null): void {
  server.tool(
    'ki_scope_list',
    '列出所有 scope（KB 目录层 + 向量语义层并集，标注每个 scope 存在于哪层、是否已在配置注册）。'
    + '精确查询像翻书：本工具 → ki_group_list → ki_get_module_info 逐层定位到整篇原文，结果确定无遗漏；'
    + '只有模糊描述、不知落在哪一篇时改用 ki_search（语义检索）。',
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
        // 视图可见性（D3 / R-02）走共享实现，与 ki_view_list 同一口径，见 view-auth.ts
        const visibleViews = filterAuthorizedViews(result.views, authScopes);
        const payload = authScopes === null
          ? result
          : {
            ...result,
            count: visible.length,
            scopes: visible,
            ...(visibleViews === undefined ? { views: undefined } : { views: visibleViews }),
            ...(result.atlas ? { atlas: filterAtlasMap(result.atlas, authScopes) } : {}),
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
