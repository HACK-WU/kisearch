/**
 * tool-permissions.ts —— MCP / chat 工具能力表（REQ-20261103-001 · S-03）
 *
 * 白名单 + 默认拒绝：未登记工具一律拒绝。
 * `/mcp` 的工具注册仍由 readOnly 控制（viewer 5 / editor 13）；
 * AI 对话工具循环使用本表按 principal 能力过滤，并拦截构造调用。
 */

import type { Capability } from './capabilities.js';

export const TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
  // 读工具（11）
  ki_search: 'knowledge.read',
  ki_get_module_info: 'knowledge.read',
  /**
   * 取图（REQ-20261123-008）：读 KB 里的图片字节，与读正文同档。
   *
   * ★ 2026-11-25：本工具**只存在于内部对话面与分析面**，不再在 `/mcp` 注册
   *   （取件改由 `ki-client asset get` 承担）。登记项**必须保留** —— chat 的
   *   `tool-loop` 靠它做 `canUseTool` 过滤，删掉会让模型静默失去看图能力。
   *   因此它是「chat 有、对外 MCP 无」的唯一工具，`capability-coverage` 测试
   *   为此单列了例外（`INTERNAL_ONLY_TOOL_NAMES`）。
   *
   * ⚠️ 本表是**默认拒绝**白名单：新增工具漏登记 ⇒ `canUseTool` 恒 false ⇒
   *    工具被 `tool-loop` 静默过滤，模型只会说"我没有这个工具"，不会报错。
   *    新增 chat 工具必须同步：`CHAT_MCP_TOOLS`、`MCP_TOOL_GROUPS`、本表、
   *    `operation-coordinator::READ_MCP_TOOLS`；若同时对外暴露，
   *    还要加 `READ_ONLY_TOOL_NAMES` 并在 `mcp-server-factory` 注册。
   */
  ki_get_image: 'knowledge.read',
  ki_group_list: 'knowledge.read',
  ki_scope_list: 'knowledge.read',
  ki_view_list: 'knowledge.read',
  ki_tag_list: 'knowledge.read',
  ki_lifecycle_list: 'knowledge.read',
  ki_event_list: 'knowledge.read',
  ki_event_type_list: 'knowledge.read',
  /** 单事件详情（2026-11-18）：纯读，与 list 同档；不进 CHAT_MCP_TOOLS（事件族整体不在对话工具面） */
  ki_event_get: 'knowledge.read',
  // 模型消耗型（REQ-20261113-001）：与"读"分离，可单独撤销
  // ⚠️ 本表只服务 **chat 工具循环**；`/mcp` 通道的实际闸门是 scope + readOnly
  //    （`ki_ask` 不进 CHAT_MCP_TOOLS，所以这一行当前是"为将来预留 + 语义完整"）
  ki_ask: 'knowledge.ask',
  /**
   * 开工前预取（REQ-20261118-004）：产出只有文档清单与判断、不写任何数据，
   * 故按 `knowledge.read` 而非 `knowledge.ask`（后者是"给答案"的能力）。不进 CHAT_MCP_TOOLS。
   */
  ki_recall: 'knowledge.read',
  // 写工具（11）
  ki_store: 'knowledge.write',
  ki_bulk_store: 'knowledge.write',
  ki_sync_relation: 'knowledge.write',
  ki_bulk_sync_relation: 'knowledge.write',
  ki_edit_relation: 'knowledge.write',
  ki_group_create: 'knowledge.write',
  ki_delete_relation: 'knowledge.write',
  ki_group_delete_empty: 'knowledge.write',
  // 事件 CRUD 与文档/阶段编辑（REQ-20261116-004；2026-11-23 三个工具合并为 ki_event_edit）
  ki_event_create: 'knowledge.write',
  ki_event_delete: 'knowledge.write',
  /** 事件编辑（REQ-20261123-009）：描述 / 结论上传 / 关联文档 / 参考文档 / 阶段，单值 action */
  ki_event_edit: 'knowledge.write',
};

export const ALL_TOOL_NAMES: readonly string[] = Object.keys(TOOL_CAPABILITIES);

export function capabilityForTool(name: string): Capability | undefined {
  return TOOL_CAPABILITIES[name];
}

export function canUseTool(capabilities: ReadonlySet<Capability>, name: string): boolean {
  const capability = capabilityForTool(name);
  return capability !== undefined && capabilities.has(capability);
}
