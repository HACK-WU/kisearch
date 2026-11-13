/**
 * tool-access.ts —— MCP 工具访问模式（只读 / 读写）的**唯一事实源**。
 *
 * 只读 Token 的两个消费点都读这里，避免"注册用一套清单、拦截用另一套清单"漂移：
 *   1. `mcp-server-factory.ts::buildKiMcpServer` —— 只读会话只注册本清单内的工具（⇒ tools/list 看不到写工具）
 *   2. `mcp-http.ts::findReadOnlyViolation` —— tools/call 中工具名**不在**本清单 → 403
 *      （客户端可能缓存了建连时的旧列表、或直接构造 JSON-RPC，仅靠不注册挡不住）
 *
 * ⚠️ 本文件有三个**互不等价**的清单，按维度分开维护，禁止把它们合并成一个：
 *
 *   | 清单 | 维度 | 决定什么 |
 *   |------|------|---------|
 *   | `READ_ONLY_TOOL_NAMES` | 语义（是否修改知识库数据） | 只读 Token 能不能看见 / 调用 |
 *   | `SCOPE_LESS_ENUM_TOOL_NAMES` | 参数形状（schema 是否含 scope） | 越权校验跳过 / 调度不占 scope |
 *   | `operation-coordinator.ts::READ_MCP_TOOLS` | 并发（能否与导入长任务并行） | read 通道还是 write 串行 |
 *
 * ★ `READ_ONLY_TOOL_NAMES` 与 `READ_MCP_TOOLS` **禁止互相引用**：两者口径不同，
 *   例 `ki_tag_list` 只读（在只读白名单内），但全库扫描、导入期间结果不可信，
 *   故**不在** `READ_MCP_TOOLS`。合并会二选一坏掉：只读 Token 丢失 `ki_tag_list`，
 *   或调度把只读工具错误串行化。
 * ★ `SCOPE_LESS_ENUM_TOOL_NAMES` 则是**跨口径共用**的（无 scope 参数是客观事实，
 *   不随"是否只读"或"能否并行"变化），故 `mcp-http.ts` 与 `operation-coordinator.ts`
 *   都引用它 —— 这不是打破上面的禁止条款。
 *
 * ★ 白名单方向（fail-safe）：新增工具漏登记时，只读 Token 默认看不见也调不动；
 *   若改成"写工具黑名单"，漏登记就等于静默放开写入（安全属性 fail-open）。
 */

/** 只读 Token 可见 / 可调的工具名单（6 个，均为纯读） */
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  'ki_search',
  'ki_get_module_info',
  'ki_group_list',
  'ki_scope_list',
  'ki_view_list',
  'ki_tag_list',
];

/**
 * 无 `scope` 参数、纯本地枚举的只读工具。
 *
 * ⚠️ 新增此类工具时必须同步两处，否则会分别坏在不同地方：
 *   1. `lib/mcp-http.ts::SCOPE_LESS_TOOLS` —— 漏 → 受限 Token 无参调用被 scope 校验拦成 403
 *   2. `lib/operation-coordinator.ts::kindForMcpToolNames` 的跳过分支 —— 漏 → 被写操作串行阻塞
 */
export const SCOPE_LESS_ENUM_TOOL_NAMES: readonly string[] = [
  'ki_scope_list',
  'ki_view_list',
];

/**
 * 「检索类」工具 —— 只有它们计入 scope 用量统计的「查询」列（REQ-20261112-001 S-01）。
 *
 * ★ 与 `READ_ONLY_TOOL_NAMES` 刻意不同：那个清单回答「只读 Token 能不能调」，
 *   本清单回答「算不算一次检索」。`ki_tag_list` / `ki_scope_list` / `ki_view_list`
 *   是枚举类（全库扫描或无 scope），计入会让「翻页/枚举」被当成「检索」。
 * ★ 与 `operation-coordinator.ts::READ_MCP_TOOLS` 也不同：那里还有管理类读
 *   （如 doc 列表），它们**不计**查询次数 —— 否则管理员在浏览页翻几次就能把库刷成「热」。
 */
export const SEARCH_TOOL_NAMES: readonly string[] = [
  'ki_search',
  'ki_group_list',
  'ki_get_module_info',
];

/**
 * 「模型消耗型」工具 —— 会消耗上游 LLM 额度、且把知识库内容外发给模型（REQ-20261113-001 · S-02 §3.2）。
 *
 * ⚠️ 与 `READ_ONLY_TOOL_NAMES` **正交**，不要合并：
 *   `ki_ask` 在两个名单里都"不在"，但理由完全不同 ——
 *   不在只读名单是因为**有成本、有外发**（不是"改数据"）。
 *   若复用 `TOKEN_READONLY` 的错误码与文案，会说成"不能调用写入工具"，
 *   理由错误、把调用方引去查写权限，排查方向从一开始就偏了。
 *
 * 白名单方向仍然安全：只读 Token 的闸门是 `isReadOnlyTool()`，
 * 新工具不登记进 READ_ONLY_TOOL_NAMES 就默认被拒（fail-safe 不变）。
 */
export const MODEL_CONSUMING_TOOL_NAMES: readonly string[] = ['ki_ask'];

/** 该工具是否会消耗模型额度（只读 Token 同样不得调用） */
export function isModelConsumingTool(name: string): boolean {
  return MODEL_CONSUMING_TOOL_NAMES.includes(name);
}

/**
 * 只读 Token 调用「模型消耗型」工具的专用错误码。
 * ⚠️ 与 `TOKEN_READONLY` 刻意分开：后者文案讲的是"写入"。
 */
export const TOKEN_MODEL_FORBIDDEN = 'TOKEN_MODEL_FORBIDDEN' as const;

/**
 * 只读 Token 调用模型消耗型工具的拒绝文案。
 *
 * 四要素缺一不可（MCP 客户端只看得到这段文本）：
 * ① 原因（只读 Token 不允许触发模型调用）② 现象解释（工具列表是建连快照）
 * ③ 正确出路（换读写 Token / 管理员改权限）④ 双因提示（模型未配置时换 Token 也没用）
 */
export function modelConsumingRejectMessage(toolName: string, tokenId?: string): string {
  const idText = tokenId ? `（id: ${tokenId}）` : '';
  return `Forbidden: 该 Token${idText}为只读，不能调用会消耗模型额度的工具 ${toolName}。`
    + '注意：这个工具可能仍出现在你当前会话的工具列表里（列表是建连时的快照），但已被禁用。'
    + '它不是写入工具，拒绝原因也不是权限不足，而是"只读 Token 不允许触发上游模型调用"。'
    + '请改用读写 Token，或由管理员执行 ki mcp token update <id> --read-write 切换为读写。'
    + '若模型本身未配置（config.yaml 的 llm 段），即使换成读写 Token 也无法问答。';
}

/** 该工具是否允许只读 Token 调用 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.includes(name);
}

/** 该工具是否计入「查询」调用量 */
export function isSearchTool(name: string): boolean {
  return SEARCH_TOOL_NAMES.includes(name);
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
