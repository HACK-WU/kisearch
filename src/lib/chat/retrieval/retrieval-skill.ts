/**
 * 检索工具 schema + 检索 skill 正文（S07 §3.2 / §3.3）
 *
 * ═══ ★ 同源约束（本需求唯一的"双份同源"点）═══
 * 本文件的 `KB_SEARCH_TOOL.function.description` 与 `RETRIEVAL_SKILL_PROMPT` 中的
 * **模式选择规则**必须措辞一致。任一侧修改必须同步另一侧。
 * 实现时须在两处互相指向（注释），并由 `tests/contract/SR-01/retrieval-skill.test.mjs` 机械核验。
 *
 * ═══ 为什么工具只有 3 个参数 ═══
 * · 不暴露 `scope` → N23 禁止跨 scope，由 daemon 从会话强制注入，**模型不可指定**
 * · 不暴露 `threshold`/`tags`/`timeout`/`include_original` → 模型无需调参；
 *   `include_original` 尤其危险（会把整篇原文灌进上下文）
 * · `limit` 上限压到 5（R21 / T11）
 *
 * @see design/S07_检索与工具调用_DESIGN.md §3.2 / §3.3
 */

import type { ToolDef } from '../llm-client.js';

/** 工具名：**刻意不用 `ki_search`**，避免与 MCP 工具混淆（两条链路不同入口） */
export const KB_SEARCH_TOOL_NAME = 'kb_search';

/** 暴露给模型的工具定义（OpenAI function-calling 格式） */
export const KB_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: KB_SEARCH_TOOL_NAME,
    description: 'STUB:SR-01:KB_SEARCH_TOOL.description',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['fulltext', 'hybrid'] },
        limit: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['query'],
    },
  },
};

/**
 * 检索 skill 正文（注入 system 消息**前半段**，优先于用户自定义 prompt）。
 *
 * **硬性规则**（不得删减，N17 依赖它们）：
 * 1. 检索无命中 → 必须回答「知识库中未找到相关内容」，**不得用自身知识冒充**
 * 2. 检索不可用 → 必须说明「本次未检索」，**不得静默按普通对话作答**
 * 3. 引用须与返回片段一致，不得改写/扩写/推测
 * 4. 检索次数上限（与 `CHAT_BUDGET.maxToolRounds` 一致，**不得各写一个数**）
 */
export const RETRIEVAL_SKILL_PROMPT: string = 'STUB:SR-01:RETRIEVAL_SKILL_PROMPT';

/**
 * 组装 system 消息：`[检索 skill, 会话自定义 prompt]`。
 *
 * · 顺序不可颠倒：skill 在前，保证反幻觉规则**优先于**用户自定义提示词
 * · 空值：会话 `systemPrompt` 为空时只返回 skill 一段（不留空 system 消息）
 */
export function buildSystemMessages(convSystemPrompt: string): Array<{ role: 'system'; content: string }> {
  throw new Error(`STUB:SR-01:buildSystemMessages`);
}

/** 供预检索降级（T10）构造"自动检索"上下文前缀 */
export function buildAutoRetrievalContext(hitsSummary: string): string {
  throw new Error(`STUB:SR-01:buildAutoRetrievalContext`);
}
