/**
 * mcp-server-factory.ts —— MCP Server 装配（按会话授权注册哪些工具）。
 *
 * 从 `src/mcp-server.ts` 抽出的原因：该文件末尾有 `startMcpServer()` 入口副作用，
 * 任何 import 它的单测都会真的把服务跑起来；装配逻辑独立成模块后可直接白盒验证
 * 「只读会话到底注册了哪几个工具」。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerGroupListTool } from './mcp-tools/group-list.js';
import { registerGetModuleInfoTool } from './mcp-tools/get-module-info.js';
import { registerGetImageTool } from './mcp-tools/get-image.js';
import { registerSyncRelationTool } from './mcp-tools/sync-relation.js';
import { registerEditRelationTool } from './mcp-tools/edit-relation.js';
import { registerBulkSyncRelationTool } from './mcp-tools/bulk-sync-relation.js';
import { registerGroupTools } from './mcp-tools/group.js';
import { registerSearchTool } from './mcp-tools/search.js';
import { registerStoreTool } from './mcp-tools/store.js';
import { registerBulkStoreTool } from './mcp-tools/bulk-store.js';
import { registerDeleteRelationTool } from './mcp-tools/delete-relation.js';
import { registerScopeListTool } from './mcp-tools/scope-list.js';
import { registerViewListTool } from './mcp-tools/view-list.js';
import { registerTagListTool } from './mcp-tools/tag-list.js';
import { registerLifecycleListTool } from './mcp-tools/lifecycle-list.js';
import { registerEventListTool } from './mcp-tools/event-list.js';
import { registerEventTypeListTool } from './mcp-tools/event-type-list.js';
import { registerEventGetTool } from './mcp-tools/event-get.js';
import { registerEventCreateTool } from './mcp-tools/event-create.js';
import { registerEventDeleteTool } from './mcp-tools/event-delete.js';
/** 事件编辑（2026-11-23 · REQ-20261123-009）：docs / refs / set_stage / 上传结论 / 改描述 合并为一个工具 */
import { registerEventEditTool } from './mcp-tools/event-edit.js';
import { registerAskTool } from './mcp-tools/ask.js';
import { registerRecallTool } from './mcp-tools/recall.js';
import { READ_ONLY_INSTRUCTIONS } from './mcp-tools/tool-access.js';
import { readKiVersion } from './version-guard.js';
import { SERVICE_NAME } from './constants.js';
import type { TokenAuth } from './mcp-token.js';

/**
 * 构建一个 kisearch McpServer 并按会话授权注册工具。
 * stdio 与 HTTP 传输复用同一工厂：HTTP 模式下每个会话新建一个实例，
 * daemon 进程内按 scope 复用 Collection engine，并由 coordinator 统一调度。
 *
 * @param auth 会话授权（null = 免鉴权，如本机 stdio / 回环 HTTP）；只读会话只注册读工具，
 *   并通过 MCP `instructions` 告知客户端「当前为只读」，避免 AI 只能靠猜为什么没有写入工具。
 */
export function buildKiMcpServer(auth: TokenAuth | null = null): McpServer {
  const readOnly = auth?.readOnly === true;
  const authScopes = auth ? auth.scopes : null;
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      version: readKiVersion(),
    },
    readOnly ? { instructions: READ_ONLY_INSTRUCTIONS } : undefined,
  );
  // ── 读工具（6 个）：只读会话同样注册 ──
  // ⚠️ 新增读工具时同步加入 mcp-tools/tool-access.ts::READ_ONLY_TOOL_NAMES，
  //    否则只读 Token 看不见它（方向安全，但功能缺失）。
  registerSearchTool(server);
  registerGetModuleInfoTool(server);
  /**
   * `ki_get_image`（REQ-20261123-008）：读文档里图片的**实际内容**。
   * 只读（不改库），但会把图片字节外发给客户端 —— 已在 product 层确认按只读工具处理。
   */
  registerGetImageTool(server);
  registerGroupListTool(server);
  registerScopeListTool(server, authScopes);
  registerViewListTool(server, authScopes);
  registerTagListTool(server);
  registerLifecycleListTool(server);
  registerEventListTool(server);
  registerEventTypeListTool(server);
  /** `ki_event_get`（2026-11-18）：list 用来找、get 用来读；过程与候选正文不返回，见 event-detail.ts 文件头 */
  registerEventGetTool(server);
  /**
   * `ki_recall`（REQ-20261118-004）：任务前上下文预取。
   *
   * **放在只读块**：产出只有文档清单与判断、不写任何数据，产品判定「它本来就是只读」，
   * 故只读 Token 也能看见并调用（已从 `MODEL_CONSUMING_TOOL_NAMES` 移出）。
   * 虽然内部会跑模型，但代价（模型额度 + 内容外发）已由产品确认接受（S-02 D-02-3）。
   */
  registerRecallTool(server, auth?.id ?? 'local');
  // ── 写工具（13 个）：只读会话**不注册** ⇒ tools/list 不出现（用户诉求「不显示」）──
  // ⚠️ 新增写工具必须放在本块内，否则会暴露给只读 Token；
  //    tools/call 侧另有一道白名单拦截（mcp-http.ts::findReadOnlyViolation）兜住缓存/构造调用。
  if (!readOnly) {
    // 事件 CRUD（REQ-20261116-004）
    registerEventCreateTool(server);
    registerEventDeleteTool(server);
    /*
     * 事件编辑（2026-11-23 · REQ-20261123-009）：原 `ki_event_docs` / `ki_event_refs` /
     * `ki_event_set_stage` 三工具已合并为 `ki_event_edit`（单值 action）。旧名不保留别名——
     * 双份维护会让模型在旧名与新名之间随机选，排查时更难定位。
     */
    registerEventEditTool(server);
    registerSyncRelationTool(server);
    registerEditRelationTool(server);
    registerBulkSyncRelationTool(server);
    registerGroupTools(server);
    registerStoreTool(server);
    registerBulkStoreTool(server);
    registerDeleteRelationTool(server);

    // ── 模型消耗型工具（REQ-20261113-001）：只读会话**不注册** ──
    // ⚠️ 它**不是写工具**（对库只做只读检索），但会消耗上游 LLM 额度并外发知识库内容，
    //    所以按"只读 Token 不可用"处理 —— 与写工具同块，理由是准入相同而非语义相同。
    //    注意读白名单方向：`ki_ask` 不在 READ_ONLY_TOOL_NAMES，只读会话看不见它也调不动
    //    （tools/call 侧另有 mcp-http 的模型消耗型闸门兜住缓存/构造调用）。
    registerAskTool(server, auth?.id ?? 'local');
  }
  return server;
}
