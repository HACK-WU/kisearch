/**
 * mcpClient.ts —— MCP 通信封装（C-03 已确认浏览器端可行）
 *
 * 前端与 ki mcp --http 同源（--web 提供静态页面），经 MCP SDK
 * StreamableHTTPClientTransport 直接调用 ki 的 MCP 工具，无 CORS。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── 类型（对齐 ki 后端返回结构） ─────────────────────

/** ki_scope_list 返回的 scope 条目（scope.ts ScopeEntry） */
export interface ScopeInfo {
  scope: string;
  kb: boolean;
  vector: boolean;
  registered: boolean;
  wikiCount: number;
}

export interface SearchHit {
  group?: string;
  relation?: string;
  score?: number;
  original?: string;
  originalRetrieved?: boolean;
  deduplicated?: boolean;
  /** 本条命中向量的 tag（多 tag 文档去重后只保留一条命中，此字段仅含其一） */
  tag?: string;
  /** 文档级自定义标签全量（来自 relations-cache relation.tags 反查） */
  tags?: string[];
  [k: string]: unknown;
}

export interface SearchResult {
  results?: SearchHit[];
  [k: string]: unknown;
}

export interface ModuleInfoResult {
  ok?: boolean;
  content?: string;
  [k: string]: unknown;
}

export interface StoreResult {
  ok?: boolean;
  [k: string]: unknown;
}

// ─── MCP client 单例 ──────────────────────────────────

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL('/mcp', window.location.origin),
    );
    const c = new Client({ name: 'ki-web', version: '0.1.0' });
    await c.connect(transport);
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** 会话失效后重建（服务重启/空闲回收） */
export async function reconnect(): Promise<void> {
  client = null;
  connecting = null;
  await getClient();
}

/**
 * 调用 MCP 工具，返回解析后的 JSON。
 * callTool 的 content[0].text 是 JSON 字符串（ki 工具返回结构化数据）。
 */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    const c = await getClient();
    const res = await c.callTool({ name, arguments: args });
    const content = res.content as { type?: string; text?: unknown }[] | undefined;
    const text = content?.[0]?.text;
    if (typeof text !== 'string') return text as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (err) {
    // 会话失效（如服务重启）→ 重建后重试一次
    await reconnect();
    const c = await getClient();
    const res = await c.callTool({ name, arguments: args });
    const content = res.content as { type?: string; text?: unknown }[] | undefined;
    const text = content?.[0]?.text;
    if (typeof text !== 'string') return text as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

// ─── 业务工具封装 ─────────────────────────────────────

export interface ScopeListResponse {
  ok?: boolean;
  scopeMode?: string;
  count?: number;
  scopes: ScopeInfo[];
  /** 向量层是否可用；false 表示已降级为仅 KB 层枚举（如向量库被导入进程持锁） */
  vectorAvailable?: boolean;
  /** 向量层不可用原因（降级时用于悬停提示） */
  vectorReason?: string;
}

export async function kiScopeList(): Promise<ScopeListResponse> {
  return callTool<ScopeListResponse>('ki_scope_list', {});
}

export async function kiSearch(
  query: string,
  opts: { scope?: string; tags?: string[]; threshold?: number; limit?: number } = {},
): Promise<SearchResult> {
  return callTool<SearchResult>('ki_search', {
    query,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags.join(',') } : {}),
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    include_original: true,
  });
}

export async function kiGetModuleInfo(
  scope: string,
  group: string,
  relation: string,
): Promise<ModuleInfoResult> {
  return callTool<ModuleInfoResult>('ki_get_module_info', { scope, group, relation });
}

export async function kiStore(args: {
  scope: string;
  content: string;
  tags?: string[];
}): Promise<StoreResult> {
  return callTool<StoreResult>('ki_store', {
    scope: args.scope,
    text: args.content,
    ...(args.tags && args.tags.length > 0 ? { tags: args.tags.join(',') } : {}),
  });
}

export async function kiSyncRelation(args: {
  scope: string;
  group: string;
  relation: string;
  content: string;
  vector?: boolean;
  tags?: string[];
}): Promise<StoreResult> {
  return callTool<StoreResult>('ki_sync_relation', {
    scope: args.scope,
    group: args.group,
    relation: args.relation,
    module_info: args.content,
    ...(args.vector !== undefined ? { vector: args.vector } : {}),
    ...(args.tags && args.tags.length > 0 ? { tags: args.tags.join(',') } : {}),
  });
}
