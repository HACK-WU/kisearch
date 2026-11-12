/**
 * 内置 skill「doc-editing」—— 按用户要求修改知识库中**已有文档**的内容（2026-11-11）。
 *
 * ═══ 三条硬约束（改动前先读）═══
 *  1. **默认停用**：`defaultPromptConfig` 给它 `enabled: false`。它会写入知识库，属于高危能力，
 *     不该在用户不知情时出现在 AI 的可用清单里。
 *  2. **依赖 `ki_edit_relation` 工具**：工具默认关（write 组 danger），未启用时本 skill 无法工作。
 *     依赖由 `prompt-config.ts::SKILL_REQUIRED_TOOLS` 声明：保存路径强校验（400）、读取路径软降级（停用该 skill）。
 *  3. **正文必须与工具的真实语义一致**：`ki_edit_relation` 是「按行区间改草稿 → view 核对 →
 *     finish 异步发布并轮询」的流程，**不是**整篇覆盖。配置层里那句「编辑既有关系（覆盖原内容）」
 *     若被照抄进正文，AI 会整篇重写而不是改指定段落（工具描述见 `mcp-tools/edit-relation.ts`）。
 *
 * 正文按 SKILL.md 规范组织：`# 标题` → `## 概述`（目的/功能/使用场景）→ `## 指令` → `## 示例`；
 * `name` / `description` 是结构化字段，不在正文里重复。
 */

/** 内置 skill id（与 `prompt-config.ts::BUILTIN_SKILL_NAMES` 同源） */
export const DOC_EDITING_SKILL_ID = 'builtin-doc-editing';

/**
 * skill 描述（SKILL.md 的 description）：AI 判断"要不要加载它"的唯一依据，也是目录里展示的内容。
 * 建议 ≤120 字符、≤200 硬上限。
 */
export const DOC_EDITING_SKILL_DESCRIPTION =
  '按用户明确要求修改知识库中已有文档的指定内容（局部行编辑，不是整篇重写）。触发："改一下这篇文档"、"把这段更新进去"、"修订某章节"。';

/** 该 skill 依赖的 MCP 工具（未启用则本 skill 不可用；SSOT 见 `prompt-config.ts::SKILL_REQUIRED_TOOLS`） */
export const DOC_EDITING_REQUIRED_TOOL = 'ki_edit_relation';

/**
 * skill 正文（**按需加载**，不常驻 system）。
 *
 * 写作依据：`mcp-tools/edit-relation.ts` 的 action 语义 + `get-module-info.ts` 的 revision 约定。
 */
export const DOC_EDITING_SKILL_PROMPT: string = [
  '# doc-editing',
  '',
  '## 概述',
  '',
  '**目的**：在用户明确要求的前提下，修改知识库中**已有文档**的指定内容，其余部分保持原样。',
  '**功能**：读取原文并取版本号 → 按行区间编辑草稿（可多轮）→ 核对草稿 → 提交发布并轮询结果；放弃或失败时收口草稿。',
  '**使用场景**：',
  '· 用户指出某篇文档的某段需要补充、修正、替换或删除时；',
  '· 不适用：新建文档（用写入类工具）、删除整篇、以及用户只是在询问或讨论（直接回答，不动文档）。',
  '',
  '## 指令',
  '',
  '### 一、先确认：授权与工具可用性',
  '只有用户**明确提出修改**时才动手；只是询问、比较、质疑时先给结论，不写库。',
  '本 skill 依赖 `ki_edit_relation`。调用前先看本次工具列表里有没有它：不在列表说明当前对话配置未启用该工具，应如实告诉用户「需要在对话配置 → 工具 → 写入 中启用 ki_edit_relation」，然后停下。不得声称已修改，也不得改用其他工具绕过写入限制。',
  '',
  '### 二、定位目标并取版本号',
  '先用 `ki_search` / `ki_group_list` 找到目标文档的 group 与 relation（要精确路径），再用 `ki_get_module_info` 读取正文 —— 返回里的 `revision` 就是首次 edit 要用的 `expected_revision`（它始终是整篇修订号，分页读取后同样可用）。',
  '目标文档或改动位置不明确时（"帮我改一下"却没说是哪篇/哪段），先问一个必要的澄清问题，不凭猜测改。',
  '',
  '### 三、改草稿：edit',
  '`ki_edit_relation(action="edit", group, relation, expected_revision, edits=[{start_line, end_line, new_text}])`：',
  '· 行号 1-based，`end_line` **包含**该行；多轮 edit 后行号以**当前草稿版本**为准（看返回的 `revision` / `totalLines`，必要时先 view 确认行号）。',
  '· 同一次调用可改多个**互不重叠**的区间；删除整行把 `new_text` 置为空串。',
  '· 未涉及的段落必须逐字保持原样：不顺手改格式、措辞、顺序或无关内容。',
  '· 返回 `revision` 是后续 edit / finish 要用的草稿版本；报版本冲突时先 view 最新草稿再重试，不要猜一个新版本号。',
  '',
  '### 四、提交前核对：view',
  '`ki_edit_relation(action="view", edit_id, start_line?, end_line?)` 确认：改动落在预期行、上下文没被破坏、没有误删。',
  '核对有偏差就继续 edit 修正，不要带着错误 finish。',
  '',
  '### 五、提交与轮询：finish',
  '`ki_edit_relation(action="finish", edit_id, expected_revision, request_id)`：',
  '· `request_id` 由你生成，并在**超时重试时原样沿用**（幂等）。',
  '· finish 是异步的：返回 queued 后必须继续用 view 轮询到 `published` 或失败，**不要立即宣布已完成**。',
  '· view 显示 `published=true` 表示正文已生效（此时 finish 只负责清理旧索引）。',
  '',
  '### 六、收口与失败处理：cancel',
  '用户改主意、或中止本次修改时，调用 `action="cancel"` 丢弃未发布的草稿 —— 残留草稿会导致该 Relation 的删除被拒绝。',
  '工具报错时按报错信息处理：版本冲突 → 重新读取后重试；文档不存在 → 如实说明；权限不足 → 说明限制。**不把失败说成成功**，也不隐瞒只改了一部分。',
  '',
  '## 示例',
  '· 「把 XX 文档第 12-15 行改成 YY」→ 读原文取 revision → edit 改 12-15 行 → view 核对 → finish → 轮询到 published 再回报。',
  '· 「这段描述过时了，帮我更新」→ 先确认是哪一段（用户指认或问一句），再按上面流程改，其余段落一字不动。',
  '· 「帮我改一下」但没说是哪篇 → 先问清文档与位置；工具未启用 → 说明去对话配置里开启，然后停。',
].join('\n');
