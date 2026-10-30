/**
 * tool-access.ts —— MCP 工具访问模式（只读 / 读写）的**唯一事实源**。
 *
 * 只读 Token 的两个消费点都读这里，避免"注册用一套清单、拦截用另一套清单"漂移：
 *   1. `mcp-server.ts::buildKiMcpServer` —— 只读会话只注册本清单内的工具（⇒ tools/list 看不到写工具）
 *   2. `mcp-http.ts::findReadOnlyViolation` —— tools/call 中工具名**不在**本清单 → 403
 *      （客户端可能缓存了建连时的旧列表、或直接构造 JSON-RPC，仅靠不注册挡不住）
 *
 * ⚠️ 与 `operation-coordinator.ts::READ_MCP_TOOLS` 是**两套不同口径，禁止互相引用**：
 *   · 本文件：语义口径「是否修改知识库数据」→ 决定只读 Token 能不能看见/调用。
 *     例：`ki_tag_list` 只读，在本清单内。
 *   · `READ_MCP_TOOLS`：并发调度口径「能否与导入长任务并行」→ `ki_tag_list` 全库扫描、
 *     结果在导入期间不可信，故**不在**该清单内（按 write 串行）。
 *   合并两者会导致：只读 Token 丢失 `ki_tag_list`，或调度把只读工具错误串行化。
 *
 * ★ 白名单方向（fail-safe）：新增工具漏登记时，只读 Token 默认看不见也调不动；
 *   若改成"写工具黑名单"，漏登记就等于静默放开写入（安全属性 fail-open）。
 */

/** 只读 Token 可见 / 可调的工具名单（5 个，均为纯读） */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  'ki_search',
  'ki_get_module_info',
  'ki_group_list',
  'ki_scope_list',
  'ki_tag_list',
];

/** 该工具是否允许只读 Token 调用 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.includes(name);
}

/**
 * 只读 Token 越权写入的错误码。
 * ⚠️ 必须与 `scope-policy.ts::SCOPE_READONLY` 区分：后者表示「整个库只读」，
 * 其文案给出的出路是 `ki scope readonly <scope> --off`；两者混用会让调用方关掉库级保护。
 */
export const TOKEN_READONLY = 'TOKEN_READONLY' as const;

/**
 * 只读 Token 触发写入的拒绝文案。
 *
 * 必须自解释（MCP 客户端只看到这段文本），四要素缺一不可：
 *   ① 原因 ② 现象解释（工具列表可能是建连快照，与实际权限不一致）③ 正确出路 ④ 双因提示
 * ⚠️ 绝不可复用 `scope-policy.ts::SCOPE_READONLY` 的文案 —— 那条出路是
 *   `ki scope readonly <scope> --off`，会让 AI 顺手把整个库的只读保护关掉。
 */
export function readonlyRejectMessage(toolName: string, tokenId?: string): string {
  const idText = tokenId ? `（id: ${tokenId}）` : '';
  return `Forbidden: 该 Token${idText}为只读，不能调用写入工具 ${toolName}。`
    + '注意：这个工具可能仍出现在你当前会话的工具列表里（列表是建连时的快照），但已被禁用。'
    + '请改用读写 Token，或由管理员执行 ki mcp token update <id> --read-write 切换为读写。'
    + '若该 scope 本身被设为只读库，即使换成读写 Token 也无法写入。';
}

/** 只读会话注入给客户端的 MCP instructions（AI 一建连就知道自己是只读，不必靠猜） */
export const READ_ONLY_INSTRUCTIONS =
  '当前连接使用只读 Token：只能检索与读取知识库，没有任何写入工具'
  + '（新建、修改、删除、批量写入均不可用）。'
  + '当用户要求写入时，请直接说明「当前连接是只读的，无法写入」，'
  + '并建议改用读写 Token，或由管理员执行 ki mcp token update <id> --read-write。'
  + '不要尝试构造工具名或反复重试。';
