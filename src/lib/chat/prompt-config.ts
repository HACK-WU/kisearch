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

// ─── AI 分析专属配置常数与工具分组（REQ-20261113-003 · S-01）────────

export const ANALYSIS_MAX_ROUNDS_DEFAULT = 6;
export const ANALYSIS_MAX_ROUNDS_LIMIT = 12;
export const ANALYSIS_MAX_FILES_DEFAULT = 8;
export const ANALYSIS_MAX_FILES_LIMIT = 30;

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
   * ⚠️ 同上：现有「AI 查找」是**确定性检索**（`events/refs-service.ts` 明确不调 LLM），
   *    因此这里**没有生效点**；只有将来引入「LLM 改写检索词」后才会被读取（检查点 F2）。
   */
  findPrompt?: CapabilityPrompt;
  /**
   * **AI 分析独立配置域**（REQ-20261113-003 · S-01）。
   *
   * 与「AI 对话」物理隔离：各自拥有独立的提示词、Skill、预算、思考级别与只读工具开关，
   * 以及全局兜底 / 按 scope 映射的目标代码目录配置。
   */
  analysis?: AnalysisConfig;
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
  maxRounds?: number;
  maxFiles?: number;
  reasoningEffort?: string;
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
const DEFAULT_ANALYSIS_PROMPT = `你是代码定位助手。基于事件标题、可选描述、当前阶段进度以及关联/参考文档清单，在目标代码目录里定位相关代码。

步骤：
1. 查看上下文里的事件信息、阶段进度与文档清单（清单仅含 group 路径与文档名）；如需阅读文档细节，先调用 ki_get_module_info 读取相关文档正文。
2. 从事件与文档中提炼技术线索（报错原文、接口名、组件名、函数/类名、关键路径）。
3. 使用只读文件工具（fs_find / fs_grep / fs_ls / fs_read）在目标目录中定位并精读关键片段，确认因果关系。
4. 只输出经精读证实的候选位置与判断依据；无法确认的部分如实写入未确认点，禁止猜测或臆造文件路径与行号。

约束：只读。不修改文件，不执行命令，不臆造未在事件、文档或源码中出现的信息。`;

/** AI 查找的内置提示词（占位；当前 AI 查找是确定性检索，本提示词无生效点）。 */
const DEFAULT_FIND_PROMPT = `把「事件标题 + 关联文档名」改写成 3-8 个用于知识库检索的关键词。

规则：
1. 保留专有名词、错误码、组件名、接口名。
2. 去掉「排查 / 问题 / 记录」这类无区分度的词。
3. 不要臆造事件里没有出现的词。
4. 只输出关键词，空格分隔，不作解释。`;

export function defaultAnalysisConfig(): AnalysisConfig {
  return {
    targetDirs: { byScope: {} },
    prompt: { content: DEFAULT_ANALYSIS_PROMPT, at: BUILTIN_AT },
    skills: BUILTIN_ANALYSIS_SKILL_IDS.map((id) => builtinAnalysisSkill(id)),
    tools: defaultAnalysisTools(),
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
    findPrompt: { content: DEFAULT_FIND_PROMPT, at: BUILTIN_AT },
    analysis: defaultAnalysisConfig(),
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

  // maxRounds
  if (obj.maxRounds !== undefined) {
    const v = obj.maxRounds;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > ANALYSIS_MAX_ROUNDS_LIMIT) {
      failField('analysis.maxRounds', `应为 1–${ANALYSIS_MAX_ROUNDS_LIMIT} 的整数（轮）`);
    } else {
      out.maxRounds = v;
    }
  }

  // maxFiles
  if (obj.maxFiles !== undefined) {
    const v = obj.maxFiles;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > ANALYSIS_MAX_FILES_LIMIT) {
      failField('analysis.maxFiles', `应为 1–${ANALYSIS_MAX_FILES_LIMIT} 的整数（个）`);
    } else {
      out.maxFiles = v;
    }
  }

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
