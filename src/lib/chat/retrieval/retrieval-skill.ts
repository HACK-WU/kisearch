/**
 * 检索工具 schema + 检索 skill 正文（S07 §3.2 / §3.3）
 *
 * ═══ ★ 同源约束（本需求唯一的"双份同源"点）═══
 * 本文件的 `KB_SEARCH_TOOL.function.description` 与 `RETRIEVAL_SKILL_PROMPT` 中的
 * **模式选择规则**必须措辞一致。任一侧修改必须同步另一侧。
 * 实现时须在两处互相指向（注释），并由 `tests/contract/SR-01/retrieval-skill.test.mjs` 机械核验。
 *
 * **本实现的强化**：不靠"注释约定同步"，而是把**模式选择规则抽为共享常量**
 * `MODE_SELECTION_RULES`，两处均引用同一份文本 → 从结构上杜绝漂移
 * （比 S07 原文的"任一侧修改必须同步另一侧"更可靠：后者依赖人/模型自觉）。
 *
 * ═══ 为什么工具只有 3 个参数 ═══
 * · 不暴露 `scope` → N23 禁止跨 scope，由 daemon 从会话强制注入，**模型不可指定**
 * · 不暴露 `threshold`/`tags`/`timeout`/`include_original` → 模型无需调参；
 *   `include_original` 尤其危险（会把整篇原文灌进上下文）
 * · `limit` 上限压到 5（R21 / T11）
 *
 * @see design/S07_检索与工具调用_DESIGN.md §3.2 / §3.3
 */

import { CHAT_BUDGET } from '../chat-contract.js';
import type { ToolDef } from '../llm-client.js';

/** 工具名：**刻意不用 `ki_search`**，避免与 MCP 工具混淆（两条链路不同入口） */
export const KB_SEARCH_TOOL_NAME = 'kb_search';

/**
 * ★ 同源常量：模式选择规则（`KB_SEARCH_TOOL.description` 与 `RETRIEVAL_SKILL_PROMPT` 共用）
 *
 * 措辞来源：`design/S07` §3.2 的 `description` 与 §3.3 的"判断使用哪种检索模式"两段，
 * 二者本应一致；此处合并为单一 SSOT 文本，两处引用。
 */
export const MODE_SELECTION_RULES = [
  '当提问包含【确切字面片段】（引号内文字 / 报错信息 / 函数名 / 配置键 / 文件路径）时用 mode=fulltext（不调用 embedding，快且精确）；',
  '其余概念性问题用 mode=hybrid（语义+全文）。',
].join(' ');

/**
 * 暴露给模型的工具定义（OpenAI function-calling 格式）
 *
 * ⚠️ `description` 的模式选择规则引用 `MODE_SELECTION_RULES`（同源约束见文件头）。
 */
export const KB_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: KB_SEARCH_TOOL_NAME,
    description: [
      '检索当前知识库，返回可核对的来源片段。',
      MODE_SELECTION_RULES,
      '若本次未命中，必须如实说明"知识库中未找到"，不得用自身知识作答。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索文本；fulltext 模式建议直接给字面片段' },
        mode: {
          type: 'string',
          enum: ['fulltext', 'hybrid'],
          description: 'fulltext=仅全文（快，不调 embedding）；hybrid=语义+全文（默认）',
        },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: '返回条数上限，默认 5' },
      },
      required: ['query'],
    },
  },
};

/** 反幻觉规则（硬性，N17 依赖它们）—— 第 4 条的次数与 `CHAT_BUDGET.maxToolRounds` 同源 */
export const ANTI_HALLUCINATION_RULES = [
  '1. 若检索结果为空，必须明确回答「知识库中未找到相关内容」，不得用你自己的知识冒充知识库内容。',
  '2. 若检索过程不可用（工具报错 / 未检索），必须明确说明「本次未检索」，不得静默按普通对话作答。',
  '3. 回答中引用知识库内容时，须与返回片段一致，不得改写、扩写或推测原文未写的细节。',
  // ★ 次数取自 CHAT_BUDGET.maxToolRounds（SSOT），不得各写一个数（文件头"硬性规则 4"）
  `4. 检索次数有限（最多 ${CHAT_BUDGET.maxToolRounds} 次）；若 ${CHAT_BUDGET.maxToolRounds} 次仍无相关结果，直接如实说明，不要继续尝试。`,
];

/**
 * 检索 skill 正文（注入 system 消息**前半段**，优先于用户自定义 prompt）。
 *
 * **硬性规则**（不得删减，N17 依赖它们）
 * 1. 检索无命中 → 必须回答「知识库中未找到相关内容」，**不得用自身知识冒充**
 * 2. 检索不可用 → 必须说明「本次未检索」，**不得静默按普通对话作答**
 * 3. 引用须与返回片段一致，不得改写/扩写/推测
 * 4. 检索次数上限（与 `CHAT_BUDGET.maxToolRounds` 一致，**不得各写一个数**）
 */
export const RETRIEVAL_SKILL_PROMPT: string = [
  '【检索知识库】',
  `回答用户问题前，你应当先检索知识库。可用工具：${KB_SEARCH_TOOL_NAME}(query, mode, limit)。`,
  '',
  '判断使用哪种检索模式：',
  '· 提问中包含【确切字面片段】→ mode=fulltext',
  '  —— 例如：引号内的原句、报错信息、函数名、配置键、文件路径、命令名。',
  '  —— 特征：用户已经知道要找的"字面"，只是想定位它在哪。（此模式不产生 embedding 调用，更快）',
  '· 其余情况（概念性、原理性、"怎么用"、"为什么"）→ mode=hybrid（语义+全文）。',
  '',
  '反幻觉规则（硬性）：',
  ...ANTI_HALLUCINATION_RULES,
].join('\n');

/**
 * 组装 system 消息：`[检索 skill, 会话自定义 prompt]`。
 *
 * · 顺序不可颠倒：skill 在前，保证反幻觉规则**优先于**用户自定义提示词
 * · 空值：会话 `systemPrompt` 为空时只返回 skill 一段（不留空 system 消息）
 */
export function buildSystemMessages(convSystemPrompt: string): Array<{ role: 'system'; content: string }> {
  const msgs: Array<{ role: 'system'; content: string }> = [
    { role: 'system', content: RETRIEVAL_SKILL_PROMPT },
  ];
  // 空值：不留空 system 消息（契约测试断言 every(content.trim().length > 0)）
  if (convSystemPrompt && convSystemPrompt.trim().length > 0) {
    msgs.push({ role: 'system', content: convSystemPrompt });
  }
  return msgs;
}

/** 供预检索降级（T10）构造"自动检索"上下文前缀 */
export function buildAutoRetrievalContext(hitsSummary: string): string {
  return [
    '【自动检索结果】（本次未使用工具检索，由系统代跑一次检索，结果如下）',
    hitsSummary,
    '回答要求：只依据以上片段作答；若片段不相关或为空，必须明确说明「本次未检索」或「知识库中未找到相关内容」，不得用自身知识作答。',
  ].join('\n');
}
