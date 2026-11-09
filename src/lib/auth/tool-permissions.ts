/**
 * tool-permissions.ts —— MCP / chat 工具能力表（REQ-20261103-001 · S-03）
 *
 * 白名单 + 默认拒绝：未登记工具一律拒绝。
 * `/mcp` 的工具注册仍由 readOnly 控制（viewer 5 / editor 13）；
 * AI 对话工具循环使用本表按 principal 能力过滤，并拦截构造调用。
 */

import type { Capability } from './capabilities.js';

export const TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
  // 读工具（6）
  ki_search: 'knowledge.read',
  ki_get_module_info: 'knowledge.read',
  ki_group_list: 'knowledge.read',
  ki_scope_list: 'knowledge.read',
  ki_view_list: 'knowledge.read',
  ki_tag_list: 'knowledge.read',
  // 写工具（8）
  ki_store: 'knowledge.write',
  ki_bulk_store: 'knowledge.write',
  ki_sync_relation: 'knowledge.write',
  ki_bulk_sync_relation: 'knowledge.write',
  ki_edit_relation: 'knowledge.write',
  ki_group_create: 'knowledge.write',
  ki_delete_relation: 'knowledge.write',
  ki_group_delete_empty: 'knowledge.write',
};

export const ALL_TOOL_NAMES: readonly string[] = Object.keys(TOOL_CAPABILITIES);

export function capabilityForTool(name: string): Capability | undefined {
  return TOOL_CAPABILITIES[name];
}

export function canUseTool(capabilities: ReadonlySet<Capability>, name: string): boolean {
  const capability = capabilityForTool(name);
  return capability !== undefined && capabilities.has(capability);
}
