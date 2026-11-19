/**
 * prompt-config.ts —— 「提示词 / Skill / 工具开关」配置（对话配置层 · 批次 1）
 *
 * 定位：这是**用户可编辑的对话配置**，与 `chat-contract.ts`（冻结契约，只管消息与事件形状）无关。
 *   落盘：`{chatDir}/prompt-config.json`（chatDir 派生自 dataDir，与 `kb/` 分离
 *   → 快照恢复 / 删除 Group 都不会碰到它；测试可用 `KI_CONFIG_PATH` 指向临时 chatDir 隔离）。
 *
 * ★═══ 默认值与兼容性 ═══★
 *   页面默认/恢复默认与模型注入共用检索 skill + 基础规则两份内容。
 *   配置文件不存在时采用新版默认；已经保存的用户内容、空值及禁用状态仍按文件读取，
 *   不因升级覆盖用户配置。回归由 test/chat/prompt-config.test.ts 守着。
 *
 * ★═══ 批次边界 ═══★
 *   · 工具开关自批次 2（2026-10-08）起**真实生效**：`tool-loop.ts` 每次提问读一次本配置，
 *     以 `tools` 过滤注册表（`mcp-tool-registry.ts`）—— 保存后**下一次提问**即生效。
 *   · **2026-10-13（skill 按需加载）** 起，注入模型变为**会话快照**：
 *     `promptSnapshotBlocks()` 只在**新建会话的首轮**被固化进 `ConversationFile.injected`，
 *     后续轮次从快照拼装、**不再读本配置**；skill 正文不再常驻 system，由 AI 用
 *     `use_skill` 按需加载。⇒ 配置改动的生效范围由「下一次提问」变为「**下一个新建会话**」。
 *   · 用户已保存的 `prompt-config.json` **不会被默认值变更覆盖**（含旧版 skill 文案）：
 *     「恢复默认」与新建时的默认值才用内置最新文案。
 *   · **唯一的例外（2026-11-11）**：内置 skill 的**名称**由服务端常量强制（`BUILTIN_SKILL_NAMES`），
 *     读旧配置时历史名称（`知识库检索`，或首版的 `ki_search`）会被就地迁移成 `knowledge-retrieval`。原因是内置条目在界面上
 *     不可改名，若不强制用户永远改不掉；名称只影响展示与 AI 目录，不影响 `use_skill` 的调用键（id）。
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteConfig, resolveDefaultChatDir, type KiConfig } from '../config.js';
import { REASONING_EFFORT_MAX_CHARS, REASONING_EFFORT_RESERVED } from '../config-schema.js';
import {
  DOC_EDITING_SKILL_DESCRIPTION,
  DOC_EDITING_SKILL_PROMPT,
  DOC_EDITING_SKILL_ID,
  DOC_EDITING_REQUIRED_TOOL,
} from './retrieval/doc-editing-skill.js';
import {
  DEFAULT_CHAT_PROMPT,
  HARD_RULES_BLOCK,
  RETRIEVAL_SKILL_DESCRIPTION,
  RETRIEVAL_SKILL_PROMPT,
  renderSkillCatalog,
} from './retrieval/retrieval-skill.js';
import {
  CODE_LOCATE_SKILL_ID,
  CODE_LOCATE_SKILL_DESCRIPTION,
  CODE_LOCATE_REQUIRED_TOOL,
  CODE_LOCATE_SKILL_PROMPT,
} from './retrieval/code-locate-skill.js';
import {
  REFS_LOCATE_SKILL_ID,
  REFS_LOCATE_SKILL_DESCRIPTION,
  REFS_LOCATE_REQUIRED_TOOL,
  REFS_LOCATE_SKILL_PROMPT,
} from './retrieval/refs-locate-skill.js';
import {
  TASK_RECALL_REQUIRED_TOOL,
  TASK_RECALL_SKILL_DESCRIPTION,
  TASK_RECALL_SKILL_ID,
  TASK_RECALL_SKILL_PROMPT,
} from './retrieval/task-recall-skill.js';
import { CHAT_BUDGET, type PromptInjectionSnapshot } from './chat-contract.js';

// ─── 上限（服务端强制；前端字数提示只是辅助）─────────────────

export const PROMPT_MAX_CHARS = 4000;
/**
 * 能力级提示词上限（AI 分析 / AI 查找，2026-11-15）。
 *
 * 与基础提示词同额度：两者都只占一个「指令位」，要写长内容应做成 skill（按需加载），
 * 而不是把长文塞进一个每次调用都要带上的提示词。
 */
export const CAPABILITY_PROMPT_MAX_CHARS = 4000;
export const SKILL_MAX_CHARS = 8000;
export const SKILL_NAME_MAX_CHARS = 64;
/**
 * skill 描述上限（服务端强制）。
 *
 * 依据 SKILL.md 规范：description 承担"选不选它"，且在清单里**会被截断展示**，
 * 因此要求 1-2 句、建议 ≤`SKILL_DESC_SUGGESTED_CHARS`；**超过本上限即视为不合格**。
 */
export const SKILL_DESC_MAX_CHARS = 200;
/** 描述的建议长度（仅前端字数提示，不是硬闸门） */
export const SKILL_DESC_SUGGESTED_CHARS = 120;
export const MAX_SKILLS = 20;
/** skill id：小写字母/数字开头，允许连字符（与 scope 命名风格一致，便于后续按 id 引用） */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * skill **名称**：必须是英文（2026-11-11 用户拍板）。
 *
 * · 名称会进 AI 的恒注入目录（`renderSkillCatalog`），与 SKILL.md 生态的英文命名保持一致；
 * · **不允许空格**（同一裁决）：名称与 id 在目录同一行展示，空格会让两者边界含糊；
 * · 长度上限已由 `SKILL_NAME_MAX_CHARS` 承担（正则只做保守封顶）。
 *
 * ⚠️ **不得与 MCP 工具名重叠**（同日并罚）：目录里 `- xxx：…` 与工具列表同名时，模型会把
 *   「工具」和「skill」当成一回事（最初取 `ki_search` 就撞了只读工具名）。内置名由
 *   `BUILTIN_SKILL_NAMES` 定、回归由 `web/test/skill-name-english.test.mjs` 守着。
 *
 * ⚠️ 前端 `PromptConfigLayer.tsx::checkName` 手工同源于此（与 `CONTEXT_CHARS_MAX` 同一约定），改动需两侧同步。
 */
export const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** 名称中不允许出现的字符集合（错误文案里给人看的说明，避免只说"不合法"） */
export const SKILL_NAME_RULE_HINT = '以英文字母开头，只能含英文字母、数字、下划线、连字符（不允许空格）';

/**
 * 上下文上限的硬上界（字符数，REQ-20261014-001）。
 *
 * 1 亿字符 ≈ 3000 万 token，远超任何真实模型 —— 只为挡掉荒谬值：分母过大时占比恒为
 * `0.0%`，**预警静默失效**（宁可拒绝也不静默）。与前端 `contextUsage.ts::CONTEXT_CHARS_MAX`
 * **手工同源**，改动需两侧同步。
 */
export const CONTEXT_CHARS_MAX = 100_000_000;

// ─── 工具白名单（★ 取自 src/lib/mcp-tools/ 的真实注册名，共 14 个）───

export interface McpToolGroup {
  key: 'read' | 'write' | 'delete';
  label: string;
  /** 危险组：默认关闭，开启需二次确认 */
  danger: boolean;
  names: readonly string[];
  /**
   * 工具短描述（走查 #7：配置层工具行要能看出这个工具干什么）。
   * 文案是**给人看的 UI 摘要**（非 AI 侧注册说明），SSOT 在此、随 toolGroups 下发，
   * 前端不复制一份（与决策 #10 同理）。
   */
  descs: Readonly<Record<string, string>>;
}

/**
 * 对话工具的配置分组（AI 对话面板的开关来源）。
 *
 * 🔴 **禁止把 `ki_ask` 加进来**（REQ-20261113-001 · S-02 §3.2 决策）：
 *   本清单 ∩ `CHAT_MCP_TOOLS` = **内层工具面**。一旦 `ki_ask` 出现在内层工具面，
 *   模型可以在问答内部再调 `ki_ask`，形成递归；而 `maxToolRounds` 只在最外层计数，
 *   内层每次自调都会重新计数，上限**挡不住**。
 *   若日后确实需要"对话里也能让 ki 自己问答"，必须先设计递归深度限制。
 */
export const MCP_TOOL_GROUPS: readonly McpToolGroup[] = [
  {
    key: 'read',
    label: '只读',
    danger: false,
    names: ['ki_search', 'ki_group_list', 'ki_get_module_info', 'ki_tag_list', 'ki_scope_list'],
    descs: {
      ki_search: '混合 / 字面检索知识库',
      ki_group_list: '查看 Group 树结构',
      ki_get_module_info: '读取指定文档原文',
      ki_tag_list: '列出标签',
      ki_scope_list: '列出 scope 清单（含顶层组与只读标记）',
    },
  },
  {
    key: 'write',
    label: '写入',
    danger: true,
    names: ['ki_store', 'ki_bulk_store', 'ki_sync_relation', 'ki_bulk_sync_relation', 'ki_edit_relation', 'ki_group_create'],
    descs: {
      ki_store: '写入向量',
      ki_bulk_store: '批量写入向量',
      ki_sync_relation: '写入 / 更新关系与 KB 内容',
      ki_bulk_sync_relation: '批量写入关系',
      ki_edit_relation: '编辑既有关系（覆盖原内容）',
      ki_group_create: '在 Group 树中新建节点',
    },
  },
  {
    key: 'delete',
    label: '删除',
    danger: true,
    names: ['ki_delete_relation', 'ki_group_delete_empty'],
    descs: {
      ki_delete_relation: '删除关系及其关联数据',
      ki_group_delete_empty: '删除空 Group 节点（非空请用 CLI ki group delete）',
    },
  },
];

/** 全部合法工具名（校验用；顺序按分组展开） */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOL_GROUPS.flatMap((g) => [...g.names]);

// ─── AI 分析专属工具分组（REQ-20261113-003 · S-01）────────
//
// 2026-11-18：轮次 / 文件数预算整体取消（用户拍板"直接取消"），
// 仅保留 `analysis-runner` 内硬编码的 90s 总超时作为防挂死兜底 —— 不可配、不进设置页。

export interface AnalysisToolGroup {
  key: 'code-read' | 'kb-read';
  label: string;
  names: readonly string[];
  descs: Readonly<Record<string, string>>;
}

/**
 * 「AI 分析」专属工具分组（全部只读、默认全开、不含任何写/删工具）。
 *
 * 🔴 `fs_*` 工具**仅限事件 AI 分析内部使用**，严禁登记进 `MCP_TOOL_GROUPS` / `CHAT_MCP_TOOLS`
 *    或 `/mcp`（Q2 拍板：不做通用代码问答，也不破坏 `/mcp` scope 鉴权模型）。
 */
export const ANALYSIS_TOOL_GROUPS: readonly AnalysisToolGroup[] = [
  {
    key: 'code-read',
    label: '源码只读（AI 分析专属）',
    names: ['fs_read', 'fs_grep', 'fs_find', 'fs_ls'],
    descs: {
      fs_read: '读取目标目录下代码片段（≤200 行 / 64 KB）',
      fs_grep: '按正则关键词检索目标目录源码（≤60 条）',
      fs_find: '按文件名 / 路径模式查找文件（≤80 条）',
      fs_ls: '列出目录结构（≤200 项）',
    },
  },
  {
    key: 'kb-read',
    label: '知识库只读（按需读取上下文关联 / 参考文档）',
    names: ['ki_get_module_info', 'ki_search', 'ki_group_list', 'ki_tag_list'],
    descs: {
      ki_get_module_info: '按 group 与文档名读取知识库正文',
      ki_search: '混合 / 全文检索知识库补充上下文',
      ki_group_list: '查看 Group 树结构与文档清单',
      ki_tag_list: '查看知识库标签',
    },
  },
];

export const ANALYSIS_TOOL_NAMES: readonly string[] = ANALYSIS_TOOL_GROUPS.flatMap((g) => [...g.names]);

function defaultAnalysisTools(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of ANALYSIS_TOOL_NAMES) out[name] = true;
  return out;
}

// ─── AI 查找专属工具分组（REQ-20261116-005）──────────────
//
// 2026-11-18：轮次 / 候选数预算整体取消；检索仍受 `find-runner` 内硬编码的
// 45s 硬超时保护（防挂死），不可配、不进设置页。

/**
 * 「AI 查找」专属工具分组：只有知识库只读四件套。
 *
 * 🔴 刻意**不含** `fs_*`：文件工具属「AI 分析」专属，2026-11-16 需求明确本期不做。
 *    把 `fs_*` 放进查找面 = 给"检索候选文档"这个场景开一个读任意目录的口子。
 */
export const FIND_TOOL_GROUPS: readonly AnalysisToolGroup[] = [
  {
    key: 'kb-read',
    label: '知识库只读',
    names: ['ki_search', 'ki_get_module_info', 'ki_group_list', 'ki_tag_list'],
    descs: {
      ki_search: '混合 / 全文检索知识库',
      ki_get_module_info: '按 group 与文档名读取正文',
      ki_group_list: '查看 Group 树结构与文档清单',
      ki_tag_list: '查看知识库标签',
    },
  },
];

export const FIND_TOOL_NAMES: readonly string[] = FIND_TOOL_GROUPS.flatMap((g) => [...g.names]);

function defaultFindTools(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of FIND_TOOL_NAMES) out[name] = true;
  return out;
}

// ─── AI 预取专属工具分组（REQ-20261118-004）──────────────

/**
 * 「AI 预取」可用的工具：知识库只读五件套。
 *
 * 比「AI 查找」多一个 `ki_scope_list` —— 预取的范围由调用方传 `scope`，模型偶尔需要
 * 自己确认「这个库里到底有什么」，而查找的范围来自事件，不需要。
 * 不含 `fs_*`：预取只回答"该读哪几篇知识库文档"，不读源码目录。
 */
export const RECALL_TOOL_GROUPS: readonly AnalysisToolGroup[] = [
  {
    key: 'kb-read',
    label: '知识库只读',
    names: ['ki_search', 'ki_get_module_info', 'ki_group_list', 'ki_scope_list', 'ki_tag_list'],
    descs: {
      ki_search: '混合 / 全文检索知识库',
      ki_get_module_info: '按 group 与文档名读取正文',
      ki_group_list: '查看 Group 树结构与文档清单',
      ki_scope_list: '列出可用知识库（确认 scope 时用）',
      ki_tag_list: '查看知识库标签',
    },
  },
];

export const RECALL_TOOL_NAMES: readonly string[] = RECALL_TOOL_GROUPS.flatMap((g) => [...g.names]);

/**
 * **锁定工具**：不可取消勾选。
 *
 * 提示词的第一条硬规则是「必须先读正文才允许给候选」，而读正文只能靠它 —— 允许关掉
 * 就等于允许模型仅凭标题猜，规则直接失效。保存时强制归一化为 `true`（不报错）。
 */
export const RECALL_LOCKED_TOOL_NAMES: readonly string[] = ['ki_get_module_info'];

/** 预取的轮次上限默认值（硬规则：45s 硬顶内能跑完的值） */
export const RECALL_DEFAULT_ROUNDS = 5;
/** 单次工具结果字符上限默认值（≈ 一篇常规正文） */
export const RECALL_DEFAULT_TOOL_CHARS = 8000;
/** 轮次下限 / 上限（配置校验边界，前端 limits 同源下发） */
export const RECALL_MIN_ROUNDS = 2;
export const RECALL_MAX_ROUNDS = 12;
/** 工具结果字符上下界 */
export const RECALL_MIN_TOOL_CHARS = 2000;
export const RECALL_MAX_TOOL_CHARS = 40000;

function defaultRecallTools(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of RECALL_TOOL_NAMES) out[name] = true;
  return out;
}

/** 默认开关：只读全开，写入/删除全关（危险工具默认不可见） */
function defaultTools(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const g of MCP_TOOL_GROUPS) for (const n of g.names) out[n] = !g.danger;
  return out;
}

// ─── 类型 ─────────────────────────────────────────────

export interface PromptSkill {
  id: string;
  name: string;
  /**
   * 规范描述（SKILL.md 的 description）：AI 判断"要不要加载这个 skill"的**唯一依据**，
   * 也是目录（恒注入）里展示的内容。
   *
   * · 上限 `SKILL_DESC_MAX_CHARS`；建议 ≤`SKILL_DESC_SUGGESTED_CHARS`
   * · **旧配置缺该字段 → 空串**（不报错）：目录回退「正文摘要」，兼容护栏 #2/#6
   */
  description: string;
  content: string;
  /** 内置条目：**不可删除**（可禁用、可改内容、可恢复默认内容） */
  builtin: boolean;
  enabled: boolean;
  /** 最后修改时间（ISO）；未改过时等于内置默认时间戳 */
  at: string;
}

export interface PromptConfig {
  version: 1;
  prompt: { content: string; at: string };
  skills: PromptSkill[];
  /** 工具名 → 是否暴露给 AI（批次 2 生效；本批只存） */
  tools: Record<string, boolean>;
  /**
   * **用户覆盖的上下文上限**（字符数，REQ-20261014-001）。
   *
   * ⚠️ 语义是"覆盖"而非"配置本体"，三级优先链的**第一级**：
   *   本字段 → `~/.ki/config.yaml` 的 `llm.contextChars`（**部署默认**）→ 内置 1000K。
   *
   * · **缺省（undefined）= 未覆盖** ⇒ 前端「恢复默认」= **删掉本字段**（回到部署默认），
   *   而不是写死 1000K —— 运维把默认设成 500K 时，"恢复默认"就该回到 500K。
   * · 为什么单独存这里、不写 `config.yaml`：`config.yaml` 是**运维级**配置（含 apiKey / 模型 /
   *   scope，且是 yaml 整文件重写、会丢手写注释），对话配置是**产品级**配置；两者的
   *   责任人与变更频率都不同，混在一起会让"界面上的一次点击"写出运维级文件的 diff。
   *
   * ⚠️ 本字段同样受 `readPromptConfig` 的「**任一字段非法 → 整体回退默认**」语义约束：
   *   手工把 JSON 里的它改成非整数，会让**整个**对话配置（含提示词与 skill）在界面上显示为默认
   *   （磁盘内容仍在，仅读取时回退，`issue` 会透出）。该事实由
   *   `test/chat/context-limit-config.test.ts` ⑨ 钉住 —— 改这条语义前先看那组用例。
   */
  contextChars?: number;
  /**
   * **用户覆盖的工具返回字符上限**（REQ-20261015-001）。
   *
   * ⚠️ 与 `contextChars` 同语义：本字段是**用户覆盖值**，缺省 = 未覆盖 → 内置
   * `CHAT_BUDGET.maxToolResponseChars`（10000）；界面改的值**只存本文件**、不写 `config.yaml`（D1 裁决）。
   */
  toolResponseChars?: number;
  /**
   * **用户覆盖的检索条数默认值**（REQ-20261015-001）。
   *
   * 语义边界：它是「AI 未传 `limit` 时使用的条数」，**不是上限** ——
   * 上限是代码常量 `CHAT_BUDGET.maxHitsPerCallHardMax`（50，AI 可在 1–50 内自主传值）。
   * 缺省 = 未覆盖 → 内置 `CHAT_BUDGET.maxHitsPerCall`（5）。
   */
  searchHitsPerCall?: number;
  /**
   * **用户覆盖的思考级别**（REQ-20261016-001 · OpenAI 通用协议纯透传）。
   *
   * 三级链第一级：本值 → `config.yaml` 的 `llm.reasoningEffort`（部署默认档）→ **不下发**。
   * 缺省 = 未覆盖（**不是空串**）；面板的「跟随模型默认」等价于**删除本字段**（设计 §5 决策 3）。
   *
   * ⚠️ **读取宽松 / 保存严格**（设计 §5 决策 7）：本字段非法时（读取路径）**只忽略它**并透出 `issue`，
   *    **不触发**"任一字段非法 → 整份回退默认" —— 避免一个可选增强字段的笔误把提示词 / skill /
   *    工具开关一起显示成默认值（磁盘内容其实未变）。
   */
  reasoningEffort?: string;
  /**
   * **能力级提示词 · AI 分析**（2026-11-15）。
   *
   * ⚠️ **当前没有任何消费方**：事件页的「AI 分析」仍是方案说明弹窗（无后端调用）。
   *    本字段只为"提前设计"存在，改了**不产生行为** —— 界面必须如实标注「未接入」，
   *    不得显示成已生效（检查点 F1）。
   * 缺省 = 未覆盖 → 用 `DEFAULT_ANALYSIS_PROMPT`（`defaultPromptConfig()` 已填入，故读取后恒有值）。
   */
  analysisPrompt?: CapabilityPrompt;
  /**
   * **能力级提示词 · AI 查找**（2026-11-15）。
   *
   * @deprecated 2026-11-16（REQ-20261116-005）起由 `find.prompt` 取代。
   *   保留仅为**读取兼容**：老配置只有本字段时，读取路径把它迁移为 `find.prompt` 并写 `softNotes`；
   *   写入路径不再产出本字段（统一写 `find`），避免双写漂移。
   */
  findPrompt?: CapabilityPrompt;
  /**
   * **AI 分析独立配置域**（REQ-20261113-003 · S-01）。
   *
   * 与「AI 对话」物理隔离：各自拥有独立的提示词、Skill、预算、思考级别与只读工具开关，
   * 以及全局兜底 / 按 scope 映射的目标代码目录配置。
   */
  analysis?: AnalysisConfig;
  /**
   * **AI 查找独立配置域**（REQ-20261116-005）。
   *
   * 缺失时的口径：读取路径从 `defaultPromptConfig()` 出发归一化（`normalizePromptConfig`
   * 的 `out` 初值即默认配置），因此 **GET 恒有本字段** —— 磁盘没有该域时它就是
   * `defaultFindConfig()` 的内容，**不报 issue**（报 issue 会触发「任一字段非法 → 整份
   * 回退默认」，把对话提示词 / skill / 工具一起显示成默认值）。
   *
   * 域**内**字段非法时同理：只忽略该项并写 `softNotes`（`findSoft`），其余照常读取。
   * 老字段 `findPrompt` 存在时承接为 `find.prompt`，优先级低于 `find`。
   */
  find?: FindConfig;
  /**
   * **能力级配置 · AI 预取**（REQ-20261118-004）。
   *
   * ⚠️ 本域**只影响 `ki_recall`**（任务前预取），与 `find`（事件详情的 AI 查找）物理独立：
   *    两条链路各有自己的提示词 / skill / 工具集，互不覆盖。
   */
  recall?: RecallSectionConfig;
}

export interface AnalysisTargetConfig {
  defaultDir?: string;
  byScope: Record<string, string>;
}

export interface AnalysisConfig {
  targetDirs: AnalysisTargetConfig;
  prompt: CapabilityPrompt;
  skills: PromptSkill[];
  tools: Record<string, boolean>;
  /**
   * 思考级别。
   *
   * ⚠️ 2026-11-18：原 `maxRounds` / `maxFiles` 两项预算已**整体取消**，
   *    旧配置里的这两个键读取时静默忽略（轮次与文件数不再设限，超时由内部 90s 兜底）。
   */
  reasoningEffort?: string;
}

/**
 * **AI 查找 · 检索范围**（REQ-20261116-005）。
 *
 * 语义："当前事件所在库恒定在范围内"+ 本表列出的额外单元；当前库**不写入**本表，
 * 否则"默认当前库"就要在每个库各配一次。
 */
export interface FindRangeConfig {
  /** 额外放开的检索单元（scope 名或视图名） */
  extraScopes: string[];
  /**
   * **预留（本期不实现、界面不暴露、校验时忽略）**：按事件所在库覆盖 `extraScopes`。
   *
   * 存在理由：`extraScopes` 是全局一份，而事件分散在不同库 —— 给 A 库事件配的
   * "可查 B 库"会同样作用于 C 库事件。将来要差异化时，有这个字段只是"放开 UI +
   * 解析取覆盖值"，没有它则要改结构 + 迁移配置。
   */
  byScope?: Record<string, string[]>;
}

/**
 * **AI 查找独立配置域**（REQ-20261116-005），与 `analysis` 同级、物理独立。
 *
 * ⚠️ 生效范围（2026-11-18 起「AI 查找」只剩模型通道，确定性快速查找已下线）：
 *    `ranges` 由 HTTP 层解析成本次的检索 targets，其余字段在模型工具循环里读取。
 */
export interface FindConfig {
  ranges: FindRangeConfig;
  /** 检索定位提示词（深度通道注入；快速通道不读） */
  prompt: CapabilityPrompt;
  /** AI 查找专属 skill（与对话 / 分析的 skill 互相独立） */
  skills: PromptSkill[];
  /** 工具名 → 是否暴露；键必须是 `FIND_TOOL_GROUPS` 展开后的名字 */
  tools: Record<string, boolean>;
  /**
   * 思考级别（三级链同 analysis）。
   *
   * ⚠️ 2026-11-18：原 `maxRounds` / `maxCandidates` / `timeoutMs` 三项预算已**整体取消**，
   *    旧配置里的这些键读取时静默忽略（轮次与候选数不再设限，超时由内部 45s 兜底）。
   */
  reasoningEffort?: string;
  /**
   * **单次查找允许 AI 调用工具的次数上限**（2026-11-19）。
   *
   * 语义：一次查找请求内**实际执行**的工具调用总数（检索 / 读正文 / 列树 / 列标签合计），
   *     计数口径与过程面板的 `metrics.calls` 同源（内核 `toolTrace.length`）；
   *     **不是轮次**（轮次仍由 `deep-find-core` 内部固定），**不是跨请求频率额度**。
   *
   * **恒有上限，没有"不限制"**（2026-11-19 用户拍板）：缺省按 `FIND_DEFAULT_TOOL_CALLS`（15）算 ——
   * 读取路径补齐缺字段，运行期内核再兜一次（手改坏配置也不会退化成无限调用）。
   * 同一份数会写进系统提示词，让模型提前规划调用顺序。
   */
  maxToolCalls?: number;
}

/**
 * **AI 预取独立配置域**（REQ-20261118-004），与 `analysis` / `find` 同级、物理独立。
 *
 * 与 find 的差异：
 *   - **没有 `ranges`**：预取的检索范围由调用方 `scope` 决定，服务端不设默认库
 *     （否则「查了哪个库」无法从入参复盘，见 D-02-1）
 *   - **有 `maxRounds` / `toolResponseChars`**：预取是"模型多轮读正文"的循环，
 *     这两项直接决定能不能在 45s 内跑完；查找侧对应预算是硬编码的
 */
export interface RecallSectionConfig {
  prompt: CapabilityPrompt;
  /** 预取阶段可加载的 skill（默认空，无内置） */
  skills: PromptSkill[];
  /** 工具名 → 是否暴露；键必须是 `RECALL_TOOL_NAMES`，锁定项恒 true */
  tools: Record<string, boolean>;
  reasoningEffort?: string;
  /** 模型循环轮次上限（读几篇正文的机会），默认 5 */
  maxRounds: number;
  /** 单次工具结果字符上限，默认 8000（≈ 一篇常规正文） */
  toolResponseChars: number;
}

/**
 * 能力级提示词载体（AI 分析 / AI 查找）：形状与 `prompt` 同构，
 * 便于复用同一套编辑弹窗与时间戳口径。
 */
export interface CapabilityPrompt {
  content: string;
  at: string;
}

/** 能力级提示词的字段名（校验 / 时间戳 / 前端遍历共用，避免三处各写一份字符串） */
export const CAPABILITY_PROMPT_KEYS = ['analysisPrompt', 'findPrompt'] as const;
export type CapabilityPromptKey = (typeof CAPABILITY_PROMPT_KEYS)[number];

export interface PromptConfigIssue {
  path: string;
  message: string;
}

/** 校验失败：携带全部问题（一次性报全，不挤牙膏） */
export class PromptConfigError extends Error {
  readonly code = 'PROMPT_CONFIG_INVALID';
  readonly issues: PromptConfigIssue[];
  constructor(issues: PromptConfigIssue[]) {
    super(`对话配置非法（共 ${issues.length} 处）：${issues.map((i) => `${i.path} ${i.message}`).join('；')}`);
    this.name = 'PromptConfigError';
    this.issues = issues;
  }
}

// ─── 默认值 ───────────────────────────────────────────

/**
 * 内置 skill 的**固定名称**（英文）—— 名称的 SSOT。
 *
 * 为什么做成表：内置条目在界面上**不可改名**（`canRename=false`），所以名称只能由服务端定；
 * 读旧配置时也靠它把历史名称（`知识库检索` / 曾用名 `ki_search`）就地迁移，**不需要迁移脚本**。
 *
 * ⚠️ 取值**不得与 MCP 工具名重叠**：`ki_search` 既是 skill 名又是只读工具名时，AI 看目录会
 *   把两者当成一回事（2026-11-11 首次落地即因此改名）—— 回归见 `web/test/skill-name-english.test.mjs`。
 */
export const BUILTIN_SKILL_NAMES: Readonly<Record<string, string>> = {
  'builtin-retrieval': 'knowledge-retrieval',
  [DOC_EDITING_SKILL_ID]: 'doc-editing',
};

/**
 * 内置 skill 与 MCP 工具的**前置依赖**：skill 启用前，对应工具必须是开启状态（2026-11-11）。
 *
 * 两处执行（缺一不可）：
 *   · 保存路径：skill 开 + 工具关 ⇒ 400（前端有同源拦截，这里是防 API 直连绕过）；
 *   · 读取路径：不报 issue（否则会触发整份回退默认），改为**就地停用**该 skill 并写明原因。
 *
 * ⚠️ 前端 `PromptConfigLayer.tsx::SKILL_REQUIRED_TOOLS` 手工同源，改动需两侧同步（有源码守卫拦）。
 */
export const SKILL_REQUIRED_TOOLS: Readonly<Record<string, string>> = {
  [DOC_EDITING_SKILL_ID]: DOC_EDITING_REQUIRED_TOOL,
};

/** AI 分析内置 skill 固定名称（与 `BUILTIN_SKILL_NAMES` 同一服务端强制模式） */
export const BUILTIN_ANALYSIS_SKILL_NAMES: Readonly<Record<string, string>> = {
  [CODE_LOCATE_SKILL_ID]: 'code-locate',
};
export const BUILTIN_ANALYSIS_SKILL_IDS: readonly string[] = Object.keys(BUILTIN_ANALYSIS_SKILL_NAMES);

export const ANALYSIS_SKILL_REQUIRED_TOOLS: Readonly<Record<string, string>> = {
  [CODE_LOCATE_SKILL_ID]: CODE_LOCATE_REQUIRED_TOOL,
};

const BUILTIN_ANALYSIS_SKILL_CONTENT: Readonly<Record<string, string>> = {
  [CODE_LOCATE_SKILL_ID]: CODE_LOCATE_SKILL_PROMPT,
};

const BUILTIN_ANALYSIS_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [CODE_LOCATE_SKILL_ID]: CODE_LOCATE_SKILL_DESCRIPTION,
};

const BUILTIN_ANALYSIS_SKILL_ENABLED: Readonly<Record<string, boolean>> = {
  [CODE_LOCATE_SKILL_ID]: true,
};

function builtinAnalysisSkill(id: string, at: string = BUILTIN_AT): PromptSkill {
  return {
    id,
    name: BUILTIN_ANALYSIS_SKILL_NAMES[id]!,
    description: BUILTIN_ANALYSIS_SKILL_DESCRIPTIONS[id] ?? '',
    content: BUILTIN_ANALYSIS_SKILL_CONTENT[id] ?? '',
    builtin: true,
    enabled: BUILTIN_ANALYSIS_SKILL_ENABLED[id] ?? true,
    at,
  };
}

// ─── AI 查找内置 skill（REQ-20261116-005 · S-01）────────────────────

/** AI 查找内置 skill 固定名称（与 `BUILTIN_SKILL_NAMES` 同一服务端强制模式） */
export const BUILTIN_FIND_SKILL_NAMES: Readonly<Record<string, string>> = {
  [REFS_LOCATE_SKILL_ID]: 'refs-locate',
  /**
   * 第二个内置 skill：为「一次任务」挑先读文档（REQ-20261118-004）。
   * 两个 skill 共用同一份提示词与工具集，**场景差异只由加载哪个 skill 决定**。
   */
  [TASK_RECALL_SKILL_ID]: 'task-recall',
};
export const BUILTIN_FIND_SKILL_IDS: readonly string[] = Object.keys(BUILTIN_FIND_SKILL_NAMES);

/**
 * **场景 skill**：同一套内核 + 同一份配置，靠「加载哪个 skill」区分场景（2026-11-18 用户拍板）。
 * 入口各取其一，代码里不出现场景分支：
 *   · AI 查找（给用户）→ `refs-locate`
 *   · AI 预取（给 agent）→ `task-recall`
 */
export const FIND_SCENARIO_SKILL_ID = REFS_LOCATE_SKILL_ID;
export const RECALL_SCENARIO_SKILL_ID = TASK_RECALL_SKILL_ID;

export const FIND_SKILL_REQUIRED_TOOLS: Readonly<Record<string, string>> = {
  [REFS_LOCATE_SKILL_ID]: REFS_LOCATE_REQUIRED_TOOL,
  // 预取场景的核心动作是「读正文核对」，关掉它这个 skill 就无从执行
  [TASK_RECALL_SKILL_ID]: TASK_RECALL_REQUIRED_TOOL,
};

const BUILTIN_FIND_SKILL_CONTENT: Readonly<Record<string, string>> = {
  [REFS_LOCATE_SKILL_ID]: REFS_LOCATE_SKILL_PROMPT,
  [TASK_RECALL_SKILL_ID]: TASK_RECALL_SKILL_PROMPT,
};

const BUILTIN_FIND_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [REFS_LOCATE_SKILL_ID]: REFS_LOCATE_SKILL_DESCRIPTION,
  [TASK_RECALL_SKILL_ID]: TASK_RECALL_SKILL_DESCRIPTION,
};

/**
 * 默认启用（S-01 D-01-6）：本 skill 只读、且是深度通道发挥作用的前提；
 * 与 `doc-editing`（默认停用，因它会写库且依赖默认关闭的写工具）刻意不同。
 */
const BUILTIN_FIND_SKILL_ENABLED: Readonly<Record<string, boolean>> = {
  [REFS_LOCATE_SKILL_ID]: true,
  [TASK_RECALL_SKILL_ID]: true,
};

function builtinFindSkill(id: string, at: string = BUILTIN_AT): PromptSkill {
  return {
    id,
    name: BUILTIN_FIND_SKILL_NAMES[id]!,
    description: BUILTIN_FIND_SKILL_DESCRIPTIONS[id] ?? '',
    content: BUILTIN_FIND_SKILL_CONTENT[id] ?? '',
    builtin: true,
    enabled: BUILTIN_FIND_SKILL_ENABLED[id] ?? true,
    at,
  };
}

/** 内置 skill 的正文（「恢复默认」与默认配置共用；不在表内 = 没有内置内容） */
const BUILTIN_SKILL_CONTENT: Readonly<Record<string, string>> = {
  'builtin-retrieval': RETRIEVAL_SKILL_PROMPT,
  [DOC_EDITING_SKILL_ID]: DOC_EDITING_SKILL_PROMPT,
};

/** 内置 skill 的描述（同上） */
const BUILTIN_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'builtin-retrieval': RETRIEVAL_SKILL_DESCRIPTION,
  [DOC_EDITING_SKILL_ID]: DOC_EDITING_SKILL_DESCRIPTION,
};

/**
 * 内置 skill 的默认启用状态。
 *
 * `doc-editing` **默认停用**：它会写知识库，且依赖 `ki_edit_relation`（工具默认关）——
 * 默认开着等于给 AI 一个调不到、还会催促用户授权的入口。
 */
const BUILTIN_SKILL_ENABLED: Readonly<Record<string, boolean>> = {
  'builtin-retrieval': true,
  [DOC_EDITING_SKILL_ID]: false,
};

/** 按 id 造一条内置 skill（默认配置与「读取补齐」共用，避免两处漂移） */
function builtinSkill(id: string, at: string = BUILTIN_AT): PromptSkill {
  return {
    id,
    name: BUILTIN_SKILL_NAMES[id]!,
    description: BUILTIN_SKILL_DESCRIPTIONS[id] ?? '',
    content: BUILTIN_SKILL_CONTENT[id] ?? '',
    builtin: true,
    enabled: BUILTIN_SKILL_ENABLED[id] ?? false,
    at,
  };
}

/** 内置 skill 的固定 id（默认集合 = 可恢复默认 / 不可删除的边界） */
export const BUILTIN_SKILL_IDS: readonly string[] = Object.keys(BUILTIN_SKILL_NAMES);

/**
 * 内置默认时间戳：刻意用**固定值**而不是 `new Date()`
 * → 让"默认配置"成为可比较的常量，便于测试断言与「恢复默认」的幂等判断。
 */
const BUILTIN_AT = '1970-01-01T00:00:00.000Z';

/**
 * AI 分析的内置提示词（REQ-20261113-003）。
 *
 * 与当前 `EventRecord` 对齐：包含标题、可选描述、当前阶段进度与关联/参考文档清单
 * （仅 `group` 路径与文档名，不含正文），引导模型按需用 `ki_get_module_info` 读正文，
 * 再用 `fs_*` 在目标目录中定位真实代码位置。
 */
const DEFAULT_ANALYSIS_PROMPT = `你是代码定位助手。任务：在一段代码目录里，为一条已登记的软件问题找出**可被证实的**代码位置与成因。
**找不到是可接受的结果**，它比给出一个凑数的位置更有价值。

## 一、先定档，再写输出
- **已证实**：读了具体代码，能说清「这段代码如何导致事件描述的现象」→ 写进 candidates，confidence ≥ 0.8
- **疑似**：只匹配到符号 / 路径 / 片段，因果链缺一环 → 可写进 candidates，但 confidence ≤ 0.5，并在 unconfirmed 写清缺哪一步
- **无证据**：没找到，或找到的都跟现象对不上 → candidates 为空，conclusion 写「未定位到可证实的代码位置」，unconfirmed 写清已排查的方向与排除理由

candidates 为空是**正常交付**。不允许为了"有输出"把疑似提级成已证实。

## 二、证据门槛（每条候选必须答全三问，答不全就不能进 candidates）
1. 在哪儿：file + line，必须来自本次工具的实际返回
2. 怎么导致：一句话因果链，不能是「可能与此有关」
3. 我会错在哪：把最可能的反例写进 why 末尾

以下一律不算证据：文件名 / 目录名相似；函数名或注释"看起来像"；单行 grep 片段（必须读 ±40 行上下文）；「这类项目通常这么写」——本仓事实只能来自本仓代码。

## 三、confidence 口径
0.9 以上：读到具体分支 / 条件，能复述触发条件
0.7–0.9：读到调用链，缺最后一环（如入参来源未确认）
0.5–0.7：只确认符号存在与位置，因果未证实
0.5 以下：不要写进 candidates，改写成 unconfirmed 的一条

## 四、运行环境
目标目录与本次可用工具见系统提示里的「运行环境」段落。不要自行假设根目录，也不要调用未列出的工具。

## 五、输出前自检
- 每条 candidates 的 file / line 都能在本次工具返回里找到
- conclusion 是一句话总结（≤120 字），细节在 chain 里，不重复
- chain 顺序是 现象 → 直接原因 → 根本原因 → 影响面 → 建议，缺哪层就跳过
- chain 里每个 ref 都指向 candidates 中的位置（file:line），指不到就删掉 ref 字段
- 正文里提到的文件路径都用反引号包住（有行号写 \`src/a.ts:128\`），别写成裸文本 —— 反引号片段才会变成可点开的位置
- conclusion 与 chain 里都不出现 candidates 之外的位置
- unconfirmed 写的是「缺什么证据」，不是「可能 / 也许」
- candidates 为空时，conclusion 必须说明已排查哪些方向，chain 可以是空数组

约束：只读。不修改文件，不执行命令，不臆造未在事件、文档或源码中出现的信息。`;

/**
 * AI 查找的内置提示词（检索定位）。
 *
 * 只写"任务与判定口径"，不写工具调用协议 —— 工具步骤在 `refs-locate` skill 正文里，
 * 硬规则与输出格式由代码追加（S-03 D-03-4）。这样用户改本字段不会把工具协议一起改坏。
 */
const DEFAULT_FIND_PROMPT = `你在知识库里做一次「带证据的检索」：判断哪些文档真的与本次目标相关，只带回清单与结论。

## 一、必须先读正文再判断
- 只凭文档名 / 片段 / 检索分数都不能下结论：至少要读完一篇正文（ki_get_module_info，且结果未被截断）
- 每篇要进候选，必须答出「它对本次目标的哪一部分有用」；答不出来 → 不采纳

## 二、宁少勿滥
- 3 篇讲得清用途，优于 8 篇看起来都沾边
- 读到的内容与目标不符 → 主动排除，并在结论里说明「X 篇看似相关但讲的是另一件事」
- 检索跑完、也换过同义表达仍没有 → 返回空数组，并说明查了什么、为什么没有

## 三、不确定要说出来
- 判断不了的事写进「不确定」，不许猜成结论
- 缺关键信息才能判断时，写进「还缺什么」，不要自己编

## 四、禁止
- 不得出现检索结果里没见过的 group 或文档名
- 不得重复推荐排除清单（已关联 / 已参考 / 已读）里的文档
- 不得用「相关资料」「可参考」这类空理由

约束：只读，不修改任何文档。

> 本次要挑的是「什么」，由随后加载的 skill 说明（refs-locate = 给事件挑参考文档；task-recall = 给任务挑先读文档）。`;

/**
 * AI 预取的默认提示词（REQ-20261118-004）。
 *
 * 与 `DEFAULT_FIND_PROMPT` 同源思路：只写"任务与判定口径"，工具协议与输出格式由代码追加。
 * 三条硬规则（必须先读正文 / 宁少勿滥 / 不确定要说出来）是产品拍板的核心，不留给模型自由发挥。
 */
const DEFAULT_RECALL_PROMPT = `为一次开发任务做「开工前的资料预取」：给出该先读哪几篇文档，以及为什么。
**0 篇是合法结果**，且优于 3 篇讲不清用途的。

## 一、必须先读正文再判断
- 只凭文档名 / 片段 / 检索分数都不能下结论：至少要读完整一篇正文（ki_get_module_info，且结果未被截断）
- 每篇要进候选，必须能答出「它对这个任务的哪一部分有用」（哪一环 / 哪个现象 / 哪个约束）
- 答不出来 → 不采纳

## 二、宁少勿滥
- 3 篇讲得清用途，优于 8 篇看起来都沾边
- 读到的内容与任务背景不符 → 主动排除，并在结论里说明「X 篇看似相关但讲的是另一件事」
- 检索跑完、也换过同义表达仍没有 → 返回空数组，并说明查了什么、为什么没有

## 三、不确定要说出来
- 判断不了的事（两篇口径冲突 / 某模块是否已废弃 / 某篇读不到）写进「不确定」，不许猜成结论
- 缺关键信息才能判断时，写进「还缺什么」，不要自己编

## 四、禁止
- 不得出现检索结果里没见过的 group 或文档名
- 不得重复推荐调用方已读清单（exclude）里的文档
- 不得用「相关资料」「可参考」这类空理由

约束：只读，不修改任何文档。`;

/** AI 预取的默认配置（`recall` 域缺失时的补齐来源；读取路径用它，不报 issue） */
export function defaultRecallConfig(): RecallSectionConfig {
  return {
    prompt: { content: DEFAULT_RECALL_PROMPT, at: BUILTIN_AT },
    // 默认没有任何内置 skill：预取阶段的 skill 由用户按需添加
    skills: [],
    tools: defaultRecallTools(),
    maxRounds: RECALL_DEFAULT_ROUNDS,
    toolResponseChars: RECALL_DEFAULT_TOOL_CHARS,
  };
}

export function defaultAnalysisConfig(): AnalysisConfig {
  return {
    targetDirs: { byScope: {} },
    prompt: { content: DEFAULT_ANALYSIS_PROMPT, at: BUILTIN_AT },
    skills: BUILTIN_ANALYSIS_SKILL_IDS.map((id) => builtinAnalysisSkill(id)),
    tools: defaultAnalysisTools(),
  };
}

/** AI 查找的默认配置（`find` 缺失时的补齐来源；读取路径用它，不报 issue） */
export function defaultFindConfig(): FindConfig {
  return {
    // 默认不放开任何额外库：与"只查当前事件所在库"的历史行为一致
    ranges: { extraScopes: [] },
    prompt: { content: DEFAULT_FIND_PROMPT, at: BUILTIN_AT },
    skills: BUILTIN_FIND_SKILL_IDS.map((id) => builtinFindSkill(id)),
    tools: defaultFindTools(),
    // 默认就有上限（15 次）：AI 查找没有"不限制"档，缺字段按这个值算
    maxToolCalls: FIND_DEFAULT_TOOL_CALLS,
  };
}

export function defaultPromptConfig(): PromptConfig {
  return {
    version: 1,
    prompt: { content: DEFAULT_CHAT_PROMPT, at: BUILTIN_AT },
    // 顺序 = `BUILTIN_SKILL_NAMES` 的声明顺序；描述与正文都取自同一常量，避免文案漂移
    skills: BUILTIN_SKILL_IDS.map((id) => builtinSkill(id)),
    tools: defaultTools(),
    // 能力级提示词：默认即"内置文案"，因此读取后恒有值（界面据此判断"默认 / 已修改"）
    analysisPrompt: { content: DEFAULT_ANALYSIS_PROMPT, at: BUILTIN_AT },
    // @deprecated 字段：仅为兼容老配置读取，默认配置仍带上它（老前端读 defaults.findPrompt 不炸）
    findPrompt: { content: DEFAULT_FIND_PROMPT, at: BUILTIN_AT },
    analysis: defaultAnalysisConfig(),
    find: defaultFindConfig(),
    recall: defaultRecallConfig(),
  };
}

/** 按 scope 解析分析目标目录（scope 精确映射优先，其次全局 defaultDir） */
export function resolveAnalysisTargetDir(targetDirs: AnalysisTargetConfig | undefined, scope: string): string | null {
  if (!targetDirs) return null;
  const scoped = Object.prototype.hasOwnProperty.call(targetDirs.byScope, scope)
    ? targetDirs.byScope[scope]?.trim()
    : '';
  if (scoped) return scoped;
  const def = targetDirs.defaultDir?.trim() ?? '';
  return def || null;
}

/** 内置 skill 的默认内容（供「恢复默认」使用） */
export function builtinSkillDefaultContent(id: string): string | null {
  return BUILTIN_SKILL_CONTENT[id] ?? BUILTIN_ANALYSIS_SKILL_CONTENT[id] ?? null;
}

/** 内置 skill 的默认描述（供「恢复默认」使用；与 `defaultPromptConfig` 同源） */
export function builtinSkillDefaultDescription(id: string): string | null {
  return BUILTIN_SKILL_DESCRIPTIONS[id] ?? BUILTIN_ANALYSIS_SKILL_DESCRIPTIONS[id] ?? null;
}

// ─── 路径 ─────────────────────────────────────────────

/** 配置文件路径：`{chatDir}/prompt-config.json`（chatDir 缺省派生自 dataDir） */
export function promptConfigPath(config: KiConfig): string {
  const chatDir = config.chatDir ?? resolveDefaultChatDir(config.dataDir);
  return path.join(chatDir, 'prompt-config.json');
}

// ─── 读 ───────────────────────────────────────────────

export interface ReadPromptConfigResult {
  config: PromptConfig;
  /**
   * 非 null = 配置源有问题（文件损坏 / 字段非法），**已回退默认值**。
   * 为什么回退而不是抛：本函数在**生成链路**上（每次提问都会读），抛错会让对话整个不可用；
   * 问题通过本字段向上暴露（API 回给前端展示），仍属"fail-loud + 给出路"。
   */
  issue: string | null;
}

export function readPromptConfig(config: KiConfig): ReadPromptConfigResult {
  const file = promptConfigPath(config);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    // 文件不存在 = 从未配置过（可预期的产品状态，不算问题）
    return { config: defaultPromptConfig(), issue: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: defaultPromptConfig(), issue: `配置文件不是合法 JSON：${(err as Error).message}` };
  }
  const issues: PromptConfigIssue[] = [];
  // ★ REQ-20261016-001（设计 §5 决策 7）：思考级别走**软通道** —— 非法时只忽略该字段，
  //   不把提示词 / skill / 工具开关一起拉进"整份回退默认"。
  const softNotes: string[] = [];
  // 两个读取侧开关，各自挡一种「整份回退默认」：
  //   skillNameSoft —— 老配置里的中文名 skill；skillDependencySoft —— skill 开着但依赖的工具没开
  //   （就地停用并透出原因）。内置 skill 缺失由 normalize 无条件补齐，无需额外开关。
  const normalized = normalizePromptConfig(parsed, issues, {
    effortSoft: true,
    softNotes,
    skillNameSoft: true,
    skillDependencySoft: true,
    capabilityPromptSoft: true,
    analysisSoft: true,
    findSoft: true,
    recallSoft: true,
  });
  if (issues.length > 0) {
    return { config: defaultPromptConfig(), issue: `配置字段非法（已回退默认）：${issues.map((i) => i.path).join('、')}` };
  }
  return { config: normalized, issue: softNotes.length > 0 ? softNotes.join('；') : null };
}

// ─── 校验 / 归一化 ─────────────────────────────────────

/**
 * 把外部输入归一化为合法 `PromptConfig`，问题收集进 `issues`（不抛）。
 *
 * 服务端强制的三处（不信任客户端）：
 *   · `builtin` 由 id 是否属于内置集合决定（客户端传什么都被覆盖）
 *   · 内置 skill 的 `name` 由 `BUILTIN_SKILL_NAMES` 决定（同上；老配置的中文名就地迁移）
 *   · `tools` 只接受白名单内的键（未知名报错，不静默丢弃 —— 拼错的开关名会让人以为生效了）
 */
/** `normalizePromptConfig` 的上下文（REQ-20261016-001）：决定思考级别字段的**软/硬**处理与白名单。 */
export interface NormalizePromptConfigOptions {
  /**
   * `true` = **读取路径**（`readPromptConfig`）：思考级别字段非法 / 脱离清单时**只忽略该字段**并把原因
   * 写入 `softNotes`（不产生 issue ⇒ 不触发整份回退默认）。缺省 = **保存路径**（严格，进 issues → 400）。
   */
  effortSoft?: boolean;
  /** 软通道说明收集器（仅 `effortSoft` 时有意义；调用方负责并入 `ReadPromptConfigResult.issue`）。 */
  softNotes?: string[];
  /** 当前磁盘上的覆盖值（保存路径传入）：**既有值脱离清单时放行**（防止运维改小清单导致保存死锁）。 */
  existingEffort?: string;
  /** 可选档位清单（保存路径传入 = `config.yaml` 的 `llm.reasoningEfforts`；`undefined` = 运维未配置）。 */
  effortOptions?: readonly string[];
  /**
   * `true` = **读取路径**（`readPromptConfig`）：skill 名称**不做英文字符校验**。
   *
   * 与 `effortSoft` 同一动机：读取时一旦报 issue，`readPromptConfig` 会「任一字段非法 → 整份回退默认」，
   * 老配置里的中文名 skill 会连累用户的提示词 / 工具开关一起显示成默认值（磁盘内容其实没变）。
   */
  skillNameSoft?: boolean;
  /**
   * 磁盘上既有的 skill 名称集合（保存路径传入）：**未改名的既有值放行**。
   *
   * 场景：升级前用户已建了中文名 skill —— 若保存时一刀切拒收，他改描述 / 开关都会被 400 卡死
   * （整体替换语义会把那条旧名一起提交）。放行既有名、只拦「新增 / 改名」，是唯一不死锁的口径。
   */
  existingSkillNames?: ReadonlySet<string>;
  /**
   * `true` = **读取路径**：skill 与其依赖工具不一致时**就地停用该 skill**并写 `softNotes`，不报 issue。
   *
   * 保存路径（缺省）严格：400 + 指出缺哪个工具（防 API 直连绕过前端拦截）。
   */
  skillDependencySoft?: boolean;
  /**
   * `true` = **读取路径**：`analysisPrompt` / `findPrompt` 非法时**只忽略该字段**并写 `softNotes`。
   *
   * 与 `effortSoft` 同一动机，且风险更大：这两个字段是"提前设计"的可选能力，
   * 一旦在读取路径报 issue，会让用户的**对话提示词 / skill / 工具开关一起**显示成默认值。
   * 保存路径（缺省）保持严格 —— 400 + 字段级 details，且**不落盘**（不会写坏文件）。
   */
  capabilityPromptSoft?: boolean;
  /**
   * `true` = **读取路径**：`analysis` 独立配置域内字段非法时只忽略/回退对应项并写 `softNotes`，
   * 绝不连累对话配置整份回退默认。
   */
  analysisSoft?: boolean;
  /** 磁盘上既有的分析 skill 名称集合（保存路径传入，放行未改名的旧名称） */
  existingAnalysisSkillNames?: ReadonlySet<string>;
  /** 磁盘上既有的分析思考级别覆盖值 */
  existingAnalysisEffort?: string;
  /**
   * `true` = **读取路径**：`find` 独立配置域内字段非法时只忽略/回退对应项并写 `softNotes`。
   *
   * 与 `analysisSoft` 同一动机：`find` 是 2026-11-16 新增域，老配置里根本没有它；
   * 若读取路径报 issue，会触发「整份回退默认」，把用户的对话提示词 / skill / 工具一起显示成默认值。
   */
  findSoft?: boolean;
  /** 磁盘上既有的查找 skill 名称集合（保存路径传入，放行未改名的旧名称） */
  existingFindSkillNames?: ReadonlySet<string>;
  /** 磁盘上既有的查找思考级别覆盖值 */
  existingFindEffort?: string;
  /**
   * 磁盘上既有的 `find` 域（保存路径传入）：作为归一化基底，实现**字段级增量**。
   *
   * 不传它时从 `defaultFindConfig()` 出发 —— 那会让"本次只提交 find.prompt"把
   * 用户先前关掉的工具开关悄悄打开（工具默认全开），属静默丢失（S-01 D-01-5）。
   */
  existingFind?: FindConfig;
  /**
   * 读取路径软通道（REQ-20261118-004）：`recall` 是 2026-11-18 新增域，老配置里根本没有它；
   * 域内字段非法时只忽略该项并写 `softNotes`，绝不触发「整份回退默认」（那会连带打回
   * 对话提示词 / skill / 工具开关，而磁盘内容其实没变）。
   */
  recallSoft?: boolean;
  /** 保存路径：磁盘既有值里出现过的 skill 名（改名口径的放行依据，与 find 同语义） */
  existingRecallSkillNames?: ReadonlySet<string>;
  /** 保存路径：磁盘既有思考级别（脱离清单时放行） */
  existingRecallEffort?: string;
  /** 保存路径：以既有域为基底做字段级增量（未提交的子字段沿用旧值） */
  existingRecall?: RecallSectionConfig;
}

const FORBIDDEN_TARGET_ROOTS = new Set(['/', '/proc', '/sys', '/dev']);
const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateTargetDirString(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: '目录路径应为字符串' };
  const value = raw.trim();
  if (!value) return { ok: true, value: '' };
  if (value.includes('\0')) return { ok: false, message: '目录路径不能包含空字符' };
  if (!path.isAbsolute(value)) return { ok: false, message: '目录路径必须是绝对路径（例如 /root/project）' };
  const resolved = path.resolve(value);
  if (
    FORBIDDEN_TARGET_ROOTS.has(resolved)
    || resolved.startsWith('/proc/')
    || resolved.startsWith('/sys/')
    || resolved.startsWith('/dev/')
  ) {
    return { ok: false, message: `不允许将系统路径（${resolved}）设为分析目标目录` };
  }
  return { ok: true, value: resolved };
}

/** 额外放开的检索单元上限（含视图；当前事件所在库不计入，故上限比较宽松） */
export const FIND_MAX_TARGETS = 5;

/**
 * 工具调用次数上限的取值边界（2026-11-19）。
 *
 * 下界为什么是 2 而不是 1：`refs-locate` 的硬规则是「至少读完整一篇正文才允许给候选」，
 * 而读正文之前通常还要先检索定位 —— 给 1 等于保证模型只能检索、无法读，结果必然是 0 候选。
 * 上界 30：轮次固定 6 轮、每轮现实里并发 1–4 个调用，30 已远超正常需要，同时能兜住失控。
 */
export const FIND_MIN_TOOL_CALLS = 2;
export const FIND_MAX_TOOL_CALLS = 30;
/**
 * 默认上限（2026-11-19 用户拍板：默认 15 次，**不允许"不限制"**）。
 *
 * 15 的来历：轮次固定 6 轮，正常一次查找是「1–2 次检索 + 3–5 次读正文」；
 * 留出约一倍余量，够模型在拿不准时多读两篇，同时仍能在反复试探时及时收口。
 */
export const FIND_DEFAULT_TOOL_CALLS = 15;

/**
 * `find` 独立配置域的归一化（REQ-20261116-005）。
 *
 * 与 `normalizeAnalysisSection` 同一范式：
 *   · **读取路径**（`findSoft`）→ 非法项只忽略并写 `softNotes`，绝不整份回退默认
 *     （回退会把对话提示词 / skill / 工具一起显示成默认值，磁盘其实没变）；
 *   · **保存路径**（缺省）→ 进 `issues`（400 且不落盘）。
 *
 * `ranges.byScope` 本期**忽略**（预留字段，S-01 D-01-8）：传了不报错、也不写入 ——
 * 静默接受但不生效会给用户"已经按库差异化"的错觉，故在校验注释与界面文案里都说明"未启用"。
 */
function normalizeFindSection(
  raw: unknown,
  issues: PromptConfigIssue[],
  opts?: NormalizePromptConfigOptions,
): FindConfig {
  // 保存路径：以磁盘既有值为基底（字段级增量，未提交的子字段沿用旧值）；
  // 读取路径不传 existingFind，从内置默认出发（文件里缺的字段按默认补齐）。
  const out: FindConfig = opts?.existingFind
    ? {
      ...opts.existingFind,
      ranges: { ...opts.existingFind.ranges, extraScopes: [...opts.existingFind.ranges.extraScopes] },
      skills: opts.existingFind.skills.map((s) => ({ ...s })),
      tools: { ...opts.existingFind.tools },
    }
    : defaultFindConfig();
  const soft = opts?.findSoft === true;
  const failField = (fieldPath: string, message: string): void => {
    if (soft) {
      opts?.softNotes?.push(`${fieldPath}：${message}（已忽略该项，其余配置照常读取）`);
      return;
    }
    issues.push({ path: fieldPath, message });
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failField('find', '应为对象');
    return out;
  }
  const obj = raw as Record<string, unknown>;

  // ── ranges.extraScopes ──
  if (obj.ranges !== undefined) {
    const r = obj.ranges;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      failField('find.ranges', '应为对象 { extraScopes }');
    } else {
      const rObj = r as Record<string, unknown>;
      const rawScopes = rObj.extraScopes;
      if (rawScopes !== undefined) {
        if (!Array.isArray(rawScopes)) {
          failField('find.ranges.extraScopes', '应为字符串数组');
        } else if (rawScopes.length > FIND_MAX_TARGETS) {
          failField('find.ranges.extraScopes', `最多 ${FIND_MAX_TARGETS} 项，实际 ${rawScopes.length}`);
        } else {
          const next: string[] = [];
          for (const item of rawScopes) {
            if (typeof item !== 'string') {
              failField('find.ranges.extraScopes', '应为字符串数组');
              continue;
            }
            const name = item.trim();
            if (!name) {
              // 空串不静默跳过：保存路径若接受它，界面会显示"配了 1 项"但实际没生效
              failField('find.ranges.extraScopes', '库名不能为空');
              continue;
            }
            if (FORBIDDEN_RECORD_KEYS.has(name)) {
              failField(`find.ranges.extraScopes.${name}`, '库名称非法');
              continue;
            }
            if (!next.includes(name)) next.push(name);
          }
          out.ranges = { extraScopes: next };
        }
      }
    }
  }

  // ── prompt ──
  if (obj.prompt !== undefined) {
    const p = obj.prompt;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      failField('find.prompt', '应为对象 { content }');
    } else {
      const pObj = p as Record<string, unknown>;
      const content = pObj.content;
      if (typeof content !== 'string') {
        failField('find.prompt.content', 'content 应为字符串');
      } else if (content.length > CAPABILITY_PROMPT_MAX_CHARS) {
        failField('find.prompt.content', `不得超过 ${CAPABILITY_PROMPT_MAX_CHARS} 字，实际 ${content.length}`);
      } else {
        out.prompt = {
          content,
          at: typeof pObj.at === 'string' ? String(pObj.at) : BUILTIN_AT,
        };
      }
    }
  }

  // ── tools（白名单；未知键必须报错，静默丢弃会让拼错的开关"看起来生效了"）──
  if (obj.tools !== undefined) {
    const t = obj.tools;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      failField('find.tools', '应为对象 { 工具名: 布尔值 }');
    } else {
      // 基底用 out.tools（可能来自磁盘既有值）而非 defaultFindTools()：
      // 否则"只提交 ki_search:false"会把其它被关掉的开关按默认（全开）打开
      const tools: Record<string, boolean> = { ...out.tools };
      for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
        if (!FIND_TOOL_NAMES.includes(name)) {
          failField(`find.tools.${name}`, `未知查找工具名（可用：${FIND_TOOL_NAMES.join(' | ')}）`);
          continue;
        }
        if (typeof value !== 'boolean') {
          failField(`find.tools.${name}`, '应为布尔值');
          continue;
        }
        tools[name] = value;
      }
      out.tools = tools;
    }
  }

  // ── skills ──
  if (obj.skills !== undefined) {
    const list = obj.skills;
    if (!Array.isArray(list)) {
      failField('find.skills', '应为数组');
    } else if (list.length > MAX_SKILLS) {
      failField('find.skills', `最多 ${MAX_SKILLS} 条，实际 ${list.length}`);
    } else {
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      const skills: PromptSkill[] = [];
      let skillFailed = false;
      list.forEach((item, i) => {
        const at = `find.skills[${i}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          failField(at, '应为对象');
          skillFailed = true;
          return;
        }
        const it = item as Record<string, unknown>;
        const id = typeof it.id === 'string' ? it.id : '';
        if (!SKILL_ID_RE.test(id)) {
          failField(`${at}.id`, 'id 需为小写字母/数字开头、可含连字符（≤64 字符）');
          skillFailed = true;
          return;
        }
        if (seenIds.has(id)) {
          failField(`${at}.id`, `id 重复：${id}`);
          skillFailed = true;
          return;
        }
        seenIds.add(id);
        const builtinName = BUILTIN_FIND_SKILL_NAMES[id];
        const name = builtinName ?? (typeof it.name === 'string' ? it.name.trim() : '');
        if (!name) {
          failField(`${at}.name`, '名称不能为空');
          skillFailed = true;
        } else if (name.length > SKILL_NAME_MAX_CHARS) {
          failField(`${at}.name`, `名称不得超过 ${SKILL_NAME_MAX_CHARS} 字`);
          skillFailed = true;
        } else {
          const exempt = builtinName !== undefined
            || opts?.skillNameSoft === true
            || opts?.existingFindSkillNames?.has(name) === true;
          if (!exempt && !SKILL_NAME_RE.test(name)) {
            failField(`${at}.name`, `名称须为英文：${SKILL_NAME_RULE_HINT}（例：refs-locate）`);
            skillFailed = true;
          } else if (seenNames.has(name.toLowerCase())) {
            failField(`${at}.name`, `名称重复：${name}`);
            skillFailed = true;
          }
        }
        seenNames.add(name.toLowerCase());
        const description = typeof it.description === 'string' ? it.description.trim() : '';
        if (description.length > SKILL_DESC_MAX_CHARS) {
          failField(`${at}.description`, `描述不得超过 ${SKILL_DESC_MAX_CHARS} 字，实际 ${description.length}`);
          skillFailed = true;
        }
        const content = typeof it.content === 'string' ? it.content : '';
        if (content.length > SKILL_MAX_CHARS) {
          failField(`${at}.content`, `不得超过 ${SKILL_MAX_CHARS} 字，实际 ${content.length}`);
          skillFailed = true;
        }
        skills.push({
          id,
          name,
          description,
          content,
          builtin: BUILTIN_FIND_SKILL_IDS.includes(id),
          enabled: it.enabled !== false,
          at: typeof it.at === 'string' ? it.at : BUILTIN_AT,
        });
      });
      if (!skillFailed) {
        for (const builtinId of BUILTIN_FIND_SKILL_IDS) {
          if (!skills.some((s) => s.id === builtinId)) skills.push(builtinFindSkill(builtinId));
        }
        out.skills = skills;
      }
    }
  }

  // ── 预算三件套（2026-11-18 取消：旧配置里的 maxRounds / maxCandidates / timeoutMs 静默忽略）──

  // ── 思考级别（本期只做形状校验；档位清单校验在深度通道接入时与 analysis 对齐）──
  if (obj.reasoningEffort !== undefined) {
    const v = obj.reasoningEffort;
    const known = typeof v === 'string' && v === opts?.existingFindEffort;
    if (typeof v !== 'string') {
      failField('find.reasoningEffort', '应为字符串');
    } else if (!v.trim() || v.length > REASONING_EFFORT_MAX_CHARS) {
      failField('find.reasoningEffort', `应为 1–${REASONING_EFFORT_MAX_CHARS} 字符的非空字符串`);
    } else if (v === REASONING_EFFORT_RESERVED && !known) {
      failField('find.reasoningEffort', `"${REASONING_EFFORT_RESERVED}" 是内部保留值，不应提交`);
    } else {
      out.reasoningEffort = v;
    }
  }

  // ── 工具调用次数上限（2026-11-19）：越界 fail-loud，不静默钳制 ──
  // 静默把 1 钳到 2、把 99 钳到 30，界面会显示"你设的是 99"而实际跑 30 —— 属于说谎。
  // 缺字段 = 沿用基底（读取路径的基底是默认值 10，因此**读出来恒有上限**）。
  if (obj.maxToolCalls !== undefined) {
    const v = obj.maxToolCalls;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < FIND_MIN_TOOL_CALLS || v > FIND_MAX_TOOL_CALLS) {
      failField(
        'find.maxToolCalls',
        `应为 ${FIND_MIN_TOOL_CALLS}~${FIND_MAX_TOOL_CALLS} 之间的整数（没有"不限制"），实际=${String(v)}`,
      );
    } else {
      out.maxToolCalls = v;
    }
  }

  // ── skill ↔ tool 依赖（看归一化后的 tools）──
  const blocked = out.skills.filter((s) => {
    const need = FIND_SKILL_REQUIRED_TOOLS[s.id];
    return need !== undefined && s.enabled && out.tools[need] !== true;
  });
  for (const s of blocked) {
    const need = FIND_SKILL_REQUIRED_TOOLS[s.id]!;
    if (opts?.skillDependencySoft === true) {
      s.enabled = false;
      opts.softNotes?.push(`查找 skill「${s.name}」依赖的工具 ${need} 未启用，已自动停用该 skill（其余配置照常读取）`);
    } else {
      issues.push({
        path: 'find.skills',
        message: `查找 skill「${s.name}」需要先启用工具 ${need}，否则它无法工作`,
      });
    }
  }

  return out;
}

function normalizeAnalysisSection(
  raw: unknown,
  issues: PromptConfigIssue[],
  opts?: NormalizePromptConfigOptions,
): AnalysisConfig {
  const out = defaultAnalysisConfig();
  const soft = opts?.analysisSoft === true;
  const failField = (fieldPath: string, message: string): void => {
    if (soft) {
      opts?.softNotes?.push(`${fieldPath}：${message}（已忽略该项，其余配置照常读取）`);
      return;
    }
    issues.push({ path: fieldPath, message });
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failField('analysis', '应为对象');
    return out;
  }
  const obj = raw as Record<string, unknown>;

  // targetDirs
  if (obj.targetDirs !== undefined) {
    const td = obj.targetDirs;
    if (td === null || typeof td !== 'object' || Array.isArray(td)) {
      failField('analysis.targetDirs', '应为对象 { defaultDir?, byScope }');
    } else {
      const tdObj = td as Record<string, unknown>;
      const nextTarget: AnalysisTargetConfig = { byScope: {} };
      if (tdObj.defaultDir !== undefined) {
        const checked = validateTargetDirString(tdObj.defaultDir);
        if (!checked.ok) {
          failField('analysis.targetDirs.defaultDir', checked.message);
        } else if (checked.value) {
          nextTarget.defaultDir = checked.value;
        }
      }
      if (tdObj.byScope !== undefined) {
        if (tdObj.byScope === null || typeof tdObj.byScope !== 'object' || Array.isArray(tdObj.byScope)) {
          failField('analysis.targetDirs.byScope', '应为对象 { scope: 目录路径 }');
        } else {
          for (const [scopeKey, dirVal] of Object.entries(tdObj.byScope as Record<string, unknown>)) {
            const key = scopeKey.trim();
            if (!key || FORBIDDEN_RECORD_KEYS.has(key)) {
              failField(`analysis.targetDirs.byScope.${scopeKey}`, 'scope 名称非法');
              continue;
            }
            const checked = validateTargetDirString(dirVal);
            if (!checked.ok) {
              failField(`analysis.targetDirs.byScope.${key}`, checked.message);
              continue;
            }
            if (checked.value) nextTarget.byScope[key] = checked.value;
          }
        }
      }
      out.targetDirs = nextTarget;
    }
  }

  // prompt
  if (obj.prompt !== undefined) {
    const p = obj.prompt;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      failField('analysis.prompt', '应为对象 { content }');
    } else {
      const content = (p as Record<string, unknown>).content;
      if (typeof content !== 'string') {
        failField('analysis.prompt.content', '应为字符串');
      } else if (content.length > CAPABILITY_PROMPT_MAX_CHARS) {
        failField('analysis.prompt.content', `不得超过 ${CAPABILITY_PROMPT_MAX_CHARS} 字，实际 ${content.length}`);
      } else {
        out.prompt = {
          content,
          at: typeof (p as Record<string, unknown>).at === 'string' ? String((p as Record<string, unknown>).at) : BUILTIN_AT,
        };
      }
    }
  }

  // tools（放在 skills 之前，方便后置校验 skill ↔ tool 依赖）
  if (obj.tools !== undefined) {
    const t = obj.tools;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      failField('analysis.tools', '应为对象 { 工具名: 布尔值 }');
    } else {
      const tools: Record<string, boolean> = defaultAnalysisTools();
      for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
        if (!ANALYSIS_TOOL_NAMES.includes(name)) {
          failField(`analysis.tools.${name}`, `未知分析工具名（可用：${ANALYSIS_TOOL_NAMES.join(' | ')}）`);
          continue;
        }
        if (typeof value !== 'boolean') {
          failField(`analysis.tools.${name}`, '应为布尔值');
          continue;
        }
        tools[name] = value;
      }
      out.tools = tools;
    }
  }

  // skills
  if (obj.skills !== undefined) {
    const list = obj.skills;
    if (!Array.isArray(list)) {
      failField('analysis.skills', '应为数组');
    } else if (list.length > MAX_SKILLS) {
      failField('analysis.skills', `最多 ${MAX_SKILLS} 条，实际 ${list.length}`);
    } else {
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      const skills: PromptSkill[] = [];
      let skillFailed = false;
      list.forEach((item, i) => {
        const at = `analysis.skills[${i}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          failField(at, '应为对象');
          skillFailed = true;
          return;
        }
        const it = item as Record<string, unknown>;
        const id = typeof it.id === 'string' ? it.id : '';
        if (!SKILL_ID_RE.test(id)) {
          failField(`${at}.id`, 'id 需为小写字母/数字开头、可含连字符（≤64 字符）');
          skillFailed = true;
          return;
        }
        if (seenIds.has(id)) {
          failField(`${at}.id`, `id 重复：${id}`);
          skillFailed = true;
          return;
        }
        seenIds.add(id);
        const builtinName = BUILTIN_ANALYSIS_SKILL_NAMES[id];
        const name = builtinName ?? (typeof it.name === 'string' ? it.name.trim() : '');
        if (!name) {
          failField(`${at}.name`, '名称不能为空');
          skillFailed = true;
        } else if (name.length > SKILL_NAME_MAX_CHARS) {
          failField(`${at}.name`, `名称不得超过 ${SKILL_NAME_MAX_CHARS} 字`);
          skillFailed = true;
        } else {
          const exempt = builtinName !== undefined
            || opts?.skillNameSoft === true
            || opts?.existingAnalysisSkillNames?.has(name) === true;
          if (!exempt && !SKILL_NAME_RE.test(name)) {
            failField(`${at}.name`, `名称须为英文：${SKILL_NAME_RULE_HINT}（例：code-locate）`);
            skillFailed = true;
          } else if (seenNames.has(name.toLowerCase())) {
            failField(`${at}.name`, `名称重复：${name}`);
            skillFailed = true;
          }
        }
        seenNames.add(name.toLowerCase());
        const description = typeof it.description === 'string' ? it.description.trim() : '';
        if (description.length > SKILL_DESC_MAX_CHARS) {
          failField(`${at}.description`, `描述不得超过 ${SKILL_DESC_MAX_CHARS} 字，实际 ${description.length}`);
          skillFailed = true;
        }
        const content = typeof it.content === 'string' ? it.content : '';
        if (content.length > SKILL_MAX_CHARS) {
          failField(`${at}.content`, `不得超过 ${SKILL_MAX_CHARS} 字，实际 ${content.length}`);
          skillFailed = true;
        }
        skills.push({
          id,
          name,
          description,
          content,
          builtin: BUILTIN_ANALYSIS_SKILL_IDS.includes(id),
          enabled: it.enabled !== false,
          at: typeof it.at === 'string' ? it.at : BUILTIN_AT,
        });
      });
      if (!skillFailed) {
        for (const builtinId of BUILTIN_ANALYSIS_SKILL_IDS) {
          if (!skills.some((s) => s.id === builtinId)) skills.push(builtinAnalysisSkill(builtinId));
        }
        out.skills = skills;
      }
    }
  }

  // maxRounds / maxFiles（2026-11-18 取消：旧配置里的这两个键静默忽略）

  // reasoningEffort
  if (obj.reasoningEffort !== undefined) {
    const v = obj.reasoningEffort;
    const effortSoft = opts?.effortSoft === true;
    const rejectEffort = (msg: string, dropField: boolean): void => {
      if (!effortSoft && !soft) {
        issues.push({ path: 'analysis.reasoningEffort', message: msg });
        return;
      }
      opts?.softNotes?.push(
        `AI 分析思考级别：${msg}（${dropField ? '已忽略该字段' : '仍会按此值发送，可在设置页点「恢复默认」'}，其余配置照常读取）`,
      );
      if (!dropField && typeof v === 'string' && v.trim() !== '') out.reasoningEffort = v;
    };
    const options = opts?.effortOptions;
    const known = typeof v === 'string' && v === opts?.existingAnalysisEffort;
    if (typeof v !== 'string') {
      rejectEffort('应为字符串', true);
    } else if (!v.trim() || v.length > REASONING_EFFORT_MAX_CHARS) {
      rejectEffort(`应为 1–${REASONING_EFFORT_MAX_CHARS} 字符的非空字符串`, true);
    } else if (v === REASONING_EFFORT_RESERVED) {
      rejectEffort(`"${REASONING_EFFORT_RESERVED}" 是内部保留值，不应提交`, true);
    } else if (!known && options === undefined) {
      rejectEffort('未配置可选档位清单（config.yaml 的 llm.reasoningEfforts）', false);
    } else if (!known && !(options as readonly string[]).includes(v)) {
      rejectEffort(`不在可选档位清单内（可用：${(options as readonly string[]).join(' | ') || '（清单为空）'}）`, false);
    } else {
      out.reasoningEffort = v;
    }
  }

  // skill ↔ tool 前置依赖
  const blocked = out.skills.filter((s) => {
    const need = ANALYSIS_SKILL_REQUIRED_TOOLS[s.id];
    return need !== undefined && s.enabled && out.tools[need] !== true;
  });
  if (blocked.length > 0) {
    if (opts?.skillDependencySoft === true) {
      for (const s of blocked) s.enabled = false;
      for (const s of blocked) {
        const need = ANALYSIS_SKILL_REQUIRED_TOOLS[s.id]!;
        opts.softNotes?.push(`AI 分析 skill「${s.name}」依赖的工具 ${need} 未启用，已自动停用该 skill`);
      }
    } else {
      for (const s of blocked) {
        issues.push({
          path: 'analysis.skills',
          message: `AI 分析 skill「${s.name}」需要先启用工具 ${ANALYSIS_SKILL_REQUIRED_TOOLS[s.id]}，否则它无法工作`,
        });
      }
    }
  }

  return out;
}

/**
 * `recall` 域的归一化（REQ-20261118-004）。
 *
 * 与 `normalizeFindSection` 同结构，差异有意保留两处：
 *   · 没有 `ranges`（范围由调用方 `scope` 决定，服务端不设默认库）
 *   · 锁定工具 `RECALL_LOCKED_TOOL_NAMES` **强制 true**（不报错）—— 它失效等于「必须先读正文」失效
 */
function normalizeRecallSection(
  raw: unknown,
  issues: PromptConfigIssue[],
  opts?: NormalizePromptConfigOptions,
): RecallSectionConfig {
  const out: RecallSectionConfig = opts?.existingRecall
    ? {
      ...opts.existingRecall,
      skills: opts.existingRecall.skills.map((s) => ({ ...s })),
      tools: { ...opts.existingRecall.tools },
    }
    : defaultRecallConfig();
  const soft = opts?.recallSoft === true;
  const failField = (fieldPath: string, message: string): void => {
    if (soft) {
      opts?.softNotes?.push(`${fieldPath}：${message}（已忽略该项，其余配置照常读取）`);
      return;
    }
    issues.push({ path: fieldPath, message });
  };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failField('recall', '应为对象');
    return out;
  }
  const obj = raw as Record<string, unknown>;

  // ── prompt ──
  if (obj.prompt !== undefined) {
    const p = obj.prompt;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      failField('recall.prompt', '应为对象 { content }');
    } else {
      const pObj = p as Record<string, unknown>;
      const content = pObj.content;
      if (typeof content !== 'string') {
        failField('recall.prompt.content', 'content 应为字符串');
      } else if (content.length > CAPABILITY_PROMPT_MAX_CHARS) {
        failField('recall.prompt.content', `不得超过 ${CAPABILITY_PROMPT_MAX_CHARS} 字，实际 ${content.length}`);
      } else {
        out.prompt = { content, at: typeof pObj.at === 'string' ? String(pObj.at) : BUILTIN_AT };
      }
    }
  }

  // ── tools（白名单；锁定项强制 true）──
  if (obj.tools !== undefined) {
    const t = obj.tools;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      failField('recall.tools', '应为对象 { 工具名: 布尔值 }');
    } else {
      const tools: Record<string, boolean> = { ...out.tools };
      for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
        if (!RECALL_TOOL_NAMES.includes(name)) {
          failField(`recall.tools.${name}`, `未知预取工具名（可用：${RECALL_TOOL_NAMES.join(' | ')}）`);
          continue;
        }
        if (typeof value !== 'boolean') {
          failField(`recall.tools.${name}`, '应为布尔值');
          continue;
        }
        tools[name] = value;
      }
      // 锁定项：无论提交什么值都强制 true（不报错 —— 前端把开关置灰，旧前端可能仍提交 false）
      for (const name of RECALL_LOCKED_TOOL_NAMES) tools[name] = true;
      out.tools = tools;
    }
  }

  // ── skills（规则与 find 一致：id / 英文名 / 描述 / 正文长度）──
  if (obj.skills !== undefined) {
    const list = obj.skills;
    if (!Array.isArray(list)) {
      failField('recall.skills', '应为数组');
    } else if (list.length > MAX_SKILLS) {
      failField('recall.skills', `最多 ${MAX_SKILLS} 条，实际 ${list.length}`);
    } else {
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      const skills: PromptSkill[] = [];
      list.forEach((item, i) => {
        const at = `recall.skills[${i}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          failField(at, '应为对象');
          return;
        }
        const it = item as Record<string, unknown>;
        const id = typeof it.id === 'string' ? it.id : '';
        if (!SKILL_ID_RE.test(id)) {
          failField(`${at}.id`, 'id 需为小写字母/数字开头、可含连字符（≤64 字符）');
          return;
        }
        if (seenIds.has(id)) {
          failField(`${at}.id`, `id 重复：${id}`);
          return;
        }
        seenIds.add(id);
        const name = typeof it.name === 'string' ? it.name.trim() : '';
        if (!name) {
          failField(`${at}.name`, '名称不能为空');
        } else if (name.length > SKILL_NAME_MAX_CHARS) {
          failField(`${at}.name`, `名称不得超过 ${SKILL_NAME_MAX_CHARS} 字`);
        } else {
          const exempt = opts?.skillNameSoft === true
            || opts?.existingRecallSkillNames?.has(name) === true;
          if (!exempt && !SKILL_NAME_RE.test(name)) {
            failField(`${at}.name`, `名称须为英文：${SKILL_NAME_RULE_HINT}（例：refs-locate）`);
          } else if (seenNames.has(name.toLowerCase())) {
            failField(`${at}.name`, `名称重复：${name}`);
          }
        }
        seenNames.add(name.toLowerCase());
        const description = typeof it.description === 'string' ? it.description.trim() : '';
        if (description.length > SKILL_DESC_MAX_CHARS) {
          failField(`${at}.description`, `描述不得超过 ${SKILL_DESC_MAX_CHARS} 字，实际 ${description.length}`);
        }
        const content = typeof it.content === 'string' ? it.content : '';
        if (content.length > SKILL_MAX_CHARS) {
          failField(`${at}.content`, `不得超过 ${SKILL_MAX_CHARS} 字，实际 ${content.length}`);
        }
        skills.push({
          id,
          name,
          description,
          content,
          builtin: false,
          enabled: it.enabled === undefined ? true : it.enabled === true,
          at: typeof it.at === 'string' ? String(it.at) : BUILTIN_AT,
        });
      });
      out.skills = skills;
    }
  }

  // ── reasoningEffort（口径同 find）──
  if (obj.reasoningEffort !== undefined) {
    const v = obj.reasoningEffort;
    const known = typeof v === 'string' && v === opts?.existingRecallEffort;
    if (typeof v !== 'string') {
      failField('recall.reasoningEffort', '应为字符串');
    } else if (!v.trim() || v.length > REASONING_EFFORT_MAX_CHARS) {
      failField('recall.reasoningEffort', `应为 1–${REASONING_EFFORT_MAX_CHARS} 字符的非空字符串`);
    } else if (v === REASONING_EFFORT_RESERVED && !known) {
      failField('recall.reasoningEffort', `"${REASONING_EFFORT_RESERVED}" 是内部保留值，不应提交`);
    } else {
      out.reasoningEffort = v;
    }
  }

  // ── maxRounds / toolResponseChars（越界 fail-loud，不静默钳制）──
  const intField = (key: 'maxRounds' | 'toolResponseChars', min: number, max: number): void => {
    const v = obj[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      failField(`recall.${key}`, `应为 ${min}~${max} 之间的整数，实际=${String(v)}`);
      return;
    }
    if (key === 'maxRounds') out.maxRounds = v;
    else out.toolResponseChars = v;
  };
  intField('maxRounds', RECALL_MIN_ROUNDS, RECALL_MAX_ROUNDS);
  intField('toolResponseChars', RECALL_MIN_TOOL_CHARS, RECALL_MAX_TOOL_CHARS);

  return out;
}

export function normalizePromptConfig(
  input: unknown,
  issues: PromptConfigIssue[],
  opts?: NormalizePromptConfigOptions,
): PromptConfig {
  const out = defaultPromptConfig();
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    issues.push({ path: '(root)', message: '应为对象' });
    return out;
  }
  const obj = input as Record<string, unknown>;

  // prompt
  if (obj.prompt !== undefined) {
    const p = obj.prompt;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      issues.push({ path: 'prompt', message: '应为对象 { content }' });
    } else {
      const content = (p as Record<string, unknown>).content;
      if (typeof content !== 'string') {
        issues.push({ path: 'prompt.content', message: '应为字符串' });
      } else if (content.length > PROMPT_MAX_CHARS) {
        issues.push({ path: 'prompt.content', message: `不得超过 ${PROMPT_MAX_CHARS} 字，实际 ${content.length}` });
      } else {
        out.prompt = { content, at: typeof (p as Record<string, unknown>).at === 'string' ? String((p as Record<string, unknown>).at) : BUILTIN_AT };
      }
    }
  }

  // 能力级提示词（AI 分析 / AI 查找，2026-11-15）—— **读取宽松 / 保存严格**
  //   读取路径（capabilityPromptSoft）非法时只忽略该字段并写 softNotes：
  //   这两个字段是"提前设计"的可选能力，若报 issue 会触发整份回退默认，
  //   把用户的对话提示词 / skill / 工具开关一起打回内置值（磁盘内容其实没变）。
  for (const key of CAPABILITY_PROMPT_KEYS) {
    const raw = obj[key];
    if (raw === undefined) continue;
    /** 非法：软通道 → 忽略该字段 + 说明；严格（保存）→ 进 issues（400 且不落盘） */
    const reject = (message: string): void => {
      if (opts?.capabilityPromptSoft === true) {
        opts.softNotes?.push(`${key}：${message}（已忽略该字段，其余配置照常读取）`);
        return;
      }
      issues.push({ path: key, message });
    };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      reject('应为对象 { content }');
      continue;
    }
    const item = raw as Record<string, unknown>;
    const content = item.content;
    if (typeof content !== 'string') {
      reject('content 应为字符串');
      continue;
    }
    if (content.length > CAPABILITY_PROMPT_MAX_CHARS) {
      reject(`content 不得超过 ${CAPABILITY_PROMPT_MAX_CHARS} 字，实际 ${content.length}`);
      continue;
    }
    out[key] = {
      content,
      at: typeof item.at === 'string' ? item.at : BUILTIN_AT,
    };
  }

  // skills
  if (obj.skills !== undefined) {
    const list = obj.skills;
    if (!Array.isArray(list)) {
      issues.push({ path: 'skills', message: '应为数组' });
    } else if (list.length > MAX_SKILLS) {
      issues.push({ path: 'skills', message: `最多 ${MAX_SKILLS} 条，实际 ${list.length}` });
    } else {
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      const skills: PromptSkill[] = [];
      list.forEach((item, i) => {
        const at = `skills[${i}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          issues.push({ path: at, message: '应为对象' });
          return;
        }
        const it = item as Record<string, unknown>;
        const id = typeof it.id === 'string' ? it.id : '';
        if (!SKILL_ID_RE.test(id)) {
          issues.push({ path: `${at}.id`, message: 'id 需为小写字母/数字开头、可含连字符（≤64 字符）' });
          return;
        }
        if (seenIds.has(id)) {
          issues.push({ path: `${at}.id`, message: `id 重复：${id}` });
          return;
        }
        seenIds.add(id);
        // ★ 内置 skill 的名称**由服务端强制**（与 `builtin` 字段同一模式，不看客户端传值）：
        //   内置条目在界面上不可改名，名称只能由 `BUILTIN_SKILL_NAMES` 决定 —— 顺带让老配置里的
        //   历史中文名（`知识库检索`）在**读取时**即完成迁移，无需单独的迁移脚本。
        const builtinName = BUILTIN_SKILL_NAMES[id];
        const name = builtinName ?? (typeof it.name === 'string' ? it.name.trim() : '');
        if (!name) {
          issues.push({ path: `${at}.name`, message: '名称不能为空' });
        } else if (name.length > SKILL_NAME_MAX_CHARS) {
          issues.push({ path: `${at}.name`, message: `名称不得超过 ${SKILL_NAME_MAX_CHARS} 字` });
        } else {
          /**
           * 英文口径（2026-11-11 用户拍板）—— 三处豁免，各自对应一种不能炸的场景：
           *   ① 内置名：常量自己定的，恒合法；
           *   ② 读取路径（`skillNameSoft`）：报 issue 会导致整份回退默认，老配置会"凭空丢失"；
           *   ③ 保存路径下与磁盘同名的既有值：老配置里的中文名不能让用户连开关都改不了。
           * 查重按**小写**比对：目录里 `Foo` 与 `foo` 对 AI 是不可分辨的两条，放过去等于埋歧义。
           */
          const exempt = builtinName !== undefined
            || opts?.skillNameSoft === true
            || opts?.existingSkillNames?.has(name) === true;
          if (!exempt && !SKILL_NAME_RE.test(name)) {
            issues.push({ path: `${at}.name`, message: `名称须为英文：${SKILL_NAME_RULE_HINT}（例：knowledge-retrieval）` });
          } else if (seenNames.has(name.toLowerCase())) {
            issues.push({ path: `${at}.name`, message: `名称重复：${name}` });
          }
        }
        seenNames.add(name.toLowerCase());
        // 描述：**允许缺失**（旧配置没有该字段）→ 空串；超上限即不合格（SKILL.md 规范）。
        const description = typeof it.description === 'string' ? it.description.trim() : '';
        if (description.length > SKILL_DESC_MAX_CHARS) {
          issues.push({ path: `${at}.description`, message: `描述不得超过 ${SKILL_DESC_MAX_CHARS} 字，实际 ${description.length}` });
        }
        const content = typeof it.content === 'string' ? it.content : '';
        if (content.length > SKILL_MAX_CHARS) {
          issues.push({ path: `${at}.content`, message: `不得超过 ${SKILL_MAX_CHARS} 字，实际 ${content.length}` });
        }
        skills.push({
          id,
          name,
          description,
          content,
          // ★ 服务端强制：内置与否由 id 决定，不看客户端传的 builtin
          builtin: BUILTIN_SKILL_IDS.includes(id),
          enabled: it.enabled !== false,
          at: typeof it.at === 'string' ? it.at : BUILTIN_AT,
        });
      });
      if (issues.length === 0) {
        /**
         * 内置 skill「不可删除」的落地口径（2026-11-11 调整）：**缺了就补回默认条目**（追加到末尾），
         * 不再报错。两个原因：
         *   · 读取路径若报 issue，会触发「任一字段非法 → 整份回退默认」—— 新增第二个内置 skill 后，
         *     所有老配置都缺它，用户提示词 / 正文 / 工具开关会一起消失（最贵的翻车）；
         *   · 保存路径同理：客户端不认识某条内置 skill 时，补回默认比 400 更有用，且与 `builtin`
         *     字段的服务端强制语义一致（内置内容由服务端说了算，客户端传什么都覆盖不了）。
         * 补齐沿用**默认启用状态**：`doc-editing` 默认停用，补齐不会凭空获得写库能力。
         */
        for (const builtinId of BUILTIN_SKILL_IDS) {
          if (!skills.some((s) => s.id === builtinId)) skills.push(builtinSkill(builtinId));
        }
        out.skills = skills;
      }
    }
  }

  // tools
  if (obj.tools !== undefined) {
    const t = obj.tools;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      issues.push({ path: 'tools', message: '应为对象 { 工具名: 布尔值 }' });
    } else {
      const tools: Record<string, boolean> = defaultTools();
      for (const [name, value] of Object.entries(t as Record<string, unknown>)) {
        if (!MCP_TOOL_NAMES.includes(name)) {
          issues.push({ path: `tools.${name}`, message: `未知工具名（可用：${MCP_TOOL_NAMES.join(' | ')}）` });
          continue;
        }
        if (typeof value !== 'boolean') {
          issues.push({ path: `tools.${name}`, message: '应为布尔值' });
          continue;
        }
        tools[name] = value;
      }
      out.tools = tools;
    }
  }

  // contextChars（**用户覆盖值**；缺省 = 不覆盖，不是 0）
  if (obj.contextChars !== undefined) {
    const v = obj.contextChars;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      issues.push({ path: 'contextChars', message: '应为正整数（字符数；1000K = 1000000）' });
    } else if (v > CONTEXT_CHARS_MAX) {
      issues.push({
        path: 'contextChars',
        message: `不得超过 ${CONTEXT_CHARS_MAX}（分母过大会让占比与预警失去意义）`,
      });
    } else {
      out.contextChars = v;
    }
  }

  // toolResponseChars（**用户覆盖值**；缺省 = 不覆盖 → 内置 10000）
  if (obj.toolResponseChars !== undefined) {
    const v = obj.toolResponseChars;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < CHAT_BUDGET.toolResponseCharsMin) {
      issues.push({
        path: 'toolResponseChars',
        message: `应为 ${CHAT_BUDGET.toolResponseCharsMin}–${CHAT_BUDGET.toolResponseCharsMax} 的整数（字符数）`,
      });
    } else if (v > CHAT_BUDGET.toolResponseCharsMax) {
      issues.push({
        path: 'toolResponseChars',
        message: `不得超过 ${CHAT_BUDGET.toolResponseCharsMax}（再大没有实际意义，且会挤爆上下文）`,
      });
    } else {
      out.toolResponseChars = v;
    }
  }

  // searchHitsPerCall（**用户覆盖值**；缺省 = 不覆盖 → 内置 5）
  if (obj.searchHitsPerCall !== undefined) {
    const v = obj.searchHitsPerCall;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      issues.push({ path: 'searchHitsPerCall', message: `应为 1–${CHAT_BUDGET.maxHitsPerCallHardMax} 的整数（条）` });
    } else if (v > CHAT_BUDGET.maxHitsPerCallHardMax) {
      issues.push({
        path: 'searchHitsPerCall',
        message: `不得超过 ${CHAT_BUDGET.maxHitsPerCallHardMax}（须与 AI 可自主传值的硬上界一致）`,
      });
    } else {
      out.searchHitsPerCall = v;
    }
  }

  // reasoningEffort（REQ-20261016-001 · 设计 §4.3 / §8.2「两段校验 + 读取宽松」）
  //
  //   ① 值 === 既有已存值 ⇒ **放行**（运维改小清单时，用户仍能保存其它字段 —— 防保存死锁）
  //   ② 值 ∈ 清单 ⇒ 放行
  //   ③ 新提交且 ∉ 清单 / 清单未配置 / 类型非法 / 保留字 ⇒ 严格模式报错（400）、宽松模式忽略该字段
  if (obj.reasoningEffort !== undefined) {
    const v = obj.reasoningEffort;
    const soft = opts?.effortSoft === true;
    /**
     * 统一出口。两类问题的处理**不同**（设计 §4.3 vs §11）：
     *   · `dropField = true`（形状非法：非字符串 / 空串 / 超长 / 保留字）⇒ 读取时**忽略该字段**；
     *   · `dropField = false`（清单相关：脱离清单 / 清单未配置）⇒ **保留该值**（设计 §11 明确"照发"，
     *     面板负责明示"不在可选清单内"）—— 若这里也忽略，保存路径会读不到既有值 ⇒ 保存死锁复现。
     */
    const reject = (msg: string, dropField: boolean): void => {
      if (!soft) {
        issues.push({ path: 'reasoningEffort', message: msg });
        return;
      }
      opts?.softNotes?.push(
        `思考级别 reasoningEffort：${msg}（${dropField ? '已忽略该字段' : '仍会按此值发送，可在面板点「恢复默认」'}，其余配置照常读取）`,
      );
      if (!dropField && typeof v === 'string' && v.trim() !== '') out.reasoningEffort = v;
    };
    const options = opts?.effortOptions;
    const known = typeof v === 'string' && v === opts?.existingEffort;
    if (typeof v !== 'string') {
      reject('应为字符串', true);
    } else if (!v.trim() || v.length > REASONING_EFFORT_MAX_CHARS) {
      reject(`应为 1–${REASONING_EFFORT_MAX_CHARS} 字符的非空字符串`, true);
    } else if (v === REASONING_EFFORT_RESERVED) {
      reject(`"${REASONING_EFFORT_RESERVED}" 是内部保留值，不应提交（"跟随模型默认" = 删除本字段）`, true);
    } else if (!known && options === undefined) {
      reject('未配置可选档位清单（config.yaml 的 llm.reasoningEfforts）', false);
    } else if (!known && !(options as readonly string[]).includes(v)) {
      reject(`不在可选档位清单内（可用：${(options as readonly string[]).join(' | ') || '（清单为空）'}）`, false);
    } else {
      out.reasoningEffort = v;
    }
  }

  // skill ↔ tool 前置依赖（2026-11-11）：放在最后，因为要看**归一化后**的 tools
  //   （客户端可能只传 skills 不传 tools，那时 out.tools 是默认值 —— 危险工具默认关）
  const blocked = out.skills.filter((s) => {
    const need = SKILL_REQUIRED_TOOLS[s.id];
    return need !== undefined && s.enabled && out.tools[need] !== true;
  });
  if (blocked.length > 0) {
    if (opts?.skillDependencySoft === true) {
      // 读取路径：就地停用（保持"工具没开就用不了"的语义），并把原因透给界面，绝不整份回退默认
      for (const s of blocked) s.enabled = false;
      for (const s of blocked) {
        const need = SKILL_REQUIRED_TOOLS[s.id]!;
        opts.softNotes?.push(`skill「${s.name}」依赖的工具 ${need} 未启用，已自动停用该 skill（其余配置照常读取）`);
      }
    } else {
      for (const s of blocked) {
        issues.push({
          path: 'skills',
          message: `skill「${s.name}」需要先启用工具 ${SKILL_REQUIRED_TOOLS[s.id]}（工具 → 写入 → ${SKILL_REQUIRED_TOOLS[s.id]}），否则它无法工作`,
        });
      }
    }
  }

  // analysis 独立配置域（REQ-20261113-003 · S-01）
  if (obj.analysis !== undefined) {
    out.analysis = normalizeAnalysisSection(obj.analysis, issues, opts);
  } else if (obj.analysisPrompt !== undefined && out.analysisPrompt) {
    // 老配置仅有顶层 analysisPrompt：平滑承接为 analysis.prompt
    out.analysis = { ...defaultAnalysisConfig(), prompt: { ...out.analysisPrompt } };
  }

  // find 独立配置域（REQ-20261116-005）
  if (obj.find !== undefined) {
    out.find = normalizeFindSection(obj.find, issues, opts);
  } else if (obj.findPrompt !== undefined && out.findPrompt) {
    // 老配置只有顶层 findPrompt（2026-11-15 预埋、无生效点）：平滑承接为 find.prompt。
    // 读取路径**不写盘**（读操作不改文件）；保存路径会在写回时统一写成 find.prompt。
    out.find = { ...defaultFindConfig(), prompt: { ...out.findPrompt } };
    if (opts?.findSoft === true) {
      opts.softNotes?.push('findPrompt 已迁移为 find.prompt（下次保存后统一写入 find）');
    }
  }

  // recall 独立配置域（REQ-20261118-004）—— 无老字段承接（本域首次引入即终态）
  if (obj.recall !== undefined) {
    out.recall = normalizeRecallSection(obj.recall, issues, opts);
  }

  return out;
}

// ─── 写 ───────────────────────────────────────────────

/**
 * 校验并保存（原子写 + 保留原文件权限）。
 * @throws {PromptConfigError} 校验失败（不会落盘）
 */
export function savePromptConfig(config: KiConfig, input: unknown): PromptConfig {
  const issues: PromptConfigIssue[] = [];
  // ★ REQ-20261016-001（设计 §5 决策 6/7）：保存路径**严格**，但**既有值脱离清单时放行** ——
  //   否则运维改小清单后，用户连 skill 都改不动（整体替换语义会把旧档位值一并提交）。
  const existing = readPromptConfig(config).config;
  const next = normalizePromptConfig(input, issues, {
    existingEffort: existing.reasoningEffort,
    // 同理（2026-11-11 名称英文口径）：升级前建的中文名 skill 是既有值，如实提交（未改名）时放行
    existingSkillNames: new Set(existing.skills.map((s) => s.name)),
    existingAnalysisSkillNames: new Set((existing.analysis?.skills ?? []).map((s) => s.name)),
    existingAnalysisEffort: existing.analysis?.reasoningEffort,
    existingFindSkillNames: new Set((existing.find?.skills ?? []).map((s) => s.name)),
    existingFindEffort: existing.find?.reasoningEffort,
    ...(existing.find ? { existingFind: existing.find } : {}),
    existingRecallSkillNames: new Set((existing.recall?.skills ?? []).map((s) => s.name)),
    ...(existing.recall?.reasoningEffort !== undefined ? { existingRecallEffort: existing.recall.reasoningEffort } : {}),
    ...(existing.recall ? { existingRecall: existing.recall } : {}),
    effortOptions: config.llm?.reasoningEfforts,
  });
  if (issues.length > 0) throw new PromptConfigError(issues);
  /**
   * ★ 旧前端兼容（2026-11-15）：`PUT` 是**整份替换**，而旧版前端不认识能力级提示词 ——
   *   请求体里没有这两个键，`normalize` 会从 `defaultPromptConfig()` 取内置默认，
   *   于是「在一个没刷新的旧标签页里改一下工具开关」就会把用户写好的分析提示词
   *   **重置为默认**（保存成功、无任何提示，是最难排查的一类丢失）。
   *
   *   处理：入参**缺该键** ⇒ 视为「本次不涉及」，沿用磁盘现值；显式传 `{content}` 才是覆盖。
   *   （注意与可选覆盖值不同：`contextChars` 缺省 = 未覆盖，天然不会写坏。）
   */
  const rawInput = (input !== null && typeof input === 'object' && !Array.isArray(input))
    ? (input as Record<string, unknown>)
    : {};
  if (rawInput.analysisPrompt === undefined && existing.analysisPrompt) {
    next.analysisPrompt = existing.analysisPrompt;
  }
  if (rawInput.findPrompt === undefined && existing.findPrompt) {
    next.findPrompt = existing.findPrompt;
  }
  if (rawInput.analysis === undefined && existing.analysis) {
    next.analysis = {
      ...existing.analysis,
      ...(rawInput.analysisPrompt !== undefined && next.analysisPrompt ? { prompt: { ...next.analysisPrompt } } : {}),
    };
  }
  if (rawInput.find === undefined && existing.find) {
    // 未提交 find 时沿用既有域；若本次只改了老字段 findPrompt，则把提示词承接到 find.prompt
    next.find = {
      ...existing.find,
      ...(rawInput.findPrompt !== undefined && next.findPrompt ? { prompt: { ...next.findPrompt } } : {}),
    };
  }
  if (rawInput.recall === undefined && existing.recall) {
    // 同 analysis / find：旧前端（不认识 recall 域）保存时不得把用户的 AI 预取配置重置为默认
    next.recall = existing.recall;
  }
  const now = new Date().toISOString();
  // 时间戳由服务端打（客户端时间不可信）
  next.prompt.at = now;
  next.skills = next.skills.map((s) => ({ ...s, at: now }));
  // 能力级提示词（2026-11-15）：与 prompt / skills 同口径，时间戳由服务端覆盖
  for (const key of CAPABILITY_PROMPT_KEYS) {
    const p = next[key];
    if (p) p.at = now;
  }
  if (next.analysis) {
    next.analysis.prompt = { ...next.analysis.prompt, at: now };
    next.analysis.skills = next.analysis.skills.map((s) => ({ ...s, at: now }));
    // 新版 analysis 提交而未单独提交 analysisPrompt 时，双写同步旧字段便于旧消费方兼容
    if (rawInput.analysis !== undefined && rawInput.analysisPrompt === undefined) {
      next.analysisPrompt = { ...next.analysis.prompt };
    }
  }
  if (next.find) {
    // 同 analysis 口径：提交 find 而未单独提交 findPrompt 时镜像到旧字段。
    // 与 S-01 D-01-2「写入统一进 find」并不冲突 —— 旧字段这里只是**镜像**（值同源），
    // 保证老前端读 defaults.findPrompt 不炸；唯一权威仍是 find.prompt。
    if (rawInput.find !== undefined && rawInput.findPrompt === undefined) {
      next.findPrompt = { ...next.find.prompt };
    }
  }
  if (next.recall) {
    // 时间戳由服务端打（与 prompt / skills 同口径）
    next.recall.prompt = { ...next.recall.prompt, at: now };
    next.recall.skills = next.recall.skills.map((s) => ({ ...s, at: now }));
  }
  const file = promptConfigPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteConfig(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ─── 注入（供 tool-loop 使用）──────────────────────────

/**
 * 按序产出**恒定注入**的 system 文本块（2026-10-13 起为会话快照的内容）：
 *   `[skill 目录] → [基础提示词] → [硬性规则]`
 *
 * 三条不可动摇的约定（改动前先读护栏 #1）：
 *   · **skill 正文不进这里** —— 正文由 AI 通过 `use_skill` 按需加载（加载后由 tool-loop 追加）；
 *   · **硬性规则必须在** —— N17 依赖它，且它不能随 skill 一起"按需"，否则未加载时出现约束空窗；
 *   · 空块不发（调用方据此不留空 system 消息 —— 与既有契约测试口径一致）。
 *
 * @param cfg 当前对话配置（**只在新建会话的首轮**被读取，之后走会话快照）
 */
export function promptSnapshotBlocks(cfg: PromptConfig): string[] {
  const blocks: string[] = [];
  const push = (text: string | null): void => {
    if (text && text.trim().length > 0) blocks.push(text);
  };
  push(renderSkillCatalog(cfg.skills));
  push(cfg.prompt.content);
  push(HARD_RULES_BLOCK);
  return blocks;
}

/** 快照里冻结的"可被 `use_skill` 调用"的 skill 清单（启用项，顺序 = 配置顺序） */
export function enabledSkillIds(cfg: PromptConfig): string[] {
  return cfg.skills.filter((s) => s.enabled).map((s) => s.id);
}

/**
 * 构造注入快照（纯函数，SSOT）。
 *
 * ★ 生成链路与"建快照"必须共用本函数：换个算法就会与首轮实际注入的字节漂移（护栏 #3 同源）。
 * ★ 快照**只含目录/提示词/硬规则 + 可调用 id 列表，绝不含 skill 正文**（护栏 #4：20×8000=16 万字）。
 */
export function buildInjectionSnapshot(cfg: PromptConfig, at: string = new Date().toISOString()): PromptInjectionSnapshot {
  return { version: 1, at, blocks: promptSnapshotBlocks(cfg), skillIds: enabledSkillIds(cfg) };
}

/** 按 id 取启用中的 skill（`use_skill` 用）；禁用或不存在 → `null`（调用方须回可见错误） */
export function findEnabledSkill(cfg: PromptConfig, id: string): PromptSkill | null {
  return cfg.skills.find((s) => s.id === id && s.enabled) ?? null;
}
