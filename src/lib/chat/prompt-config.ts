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
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteConfig, resolveDefaultChatDir, type KiConfig } from '../config.js';
import { REASONING_EFFORT_MAX_CHARS, REASONING_EFFORT_RESERVED } from '../config-schema.js';
import {
  DEFAULT_CHAT_PROMPT,
  HARD_RULES_BLOCK,
  RETRIEVAL_SKILL_DESCRIPTION,
  RETRIEVAL_SKILL_PROMPT,
  renderSkillCatalog,
} from './retrieval/retrieval-skill.js';
import { CHAT_BUDGET, type PromptInjectionSnapshot } from './chat-contract.js';

// ─── 上限（服务端强制；前端字数提示只是辅助）─────────────────

export const PROMPT_MAX_CHARS = 4000;
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
}

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

/** 内置 skill 的固定 id（默认集合 = 可恢复默认 / 不可删除的边界） */
export const BUILTIN_SKILL_IDS: readonly string[] = ['builtin-retrieval'];

/**
 * 内置默认时间戳：刻意用**固定值**而不是 `new Date()`
 * → 让"默认配置"成为可比较的常量，便于测试断言与「恢复默认」的幂等判断。
 */
const BUILTIN_AT = '1970-01-01T00:00:00.000Z';

export function defaultPromptConfig(): PromptConfig {
  return {
    version: 1,
    prompt: { content: DEFAULT_CHAT_PROMPT, at: BUILTIN_AT },
    skills: [
      {
        id: 'builtin-retrieval',
        name: '知识库检索',
        // 描述（目录里给 AI 判断用）与正文（按需加载）都取自同一常量，避免文案漂移。
        description: RETRIEVAL_SKILL_DESCRIPTION,
        content: RETRIEVAL_SKILL_PROMPT,
        builtin: true,
        enabled: true,
        at: BUILTIN_AT,
      },
    ],
    tools: defaultTools(),
  };
}

/** 内置 skill 的默认内容（供「恢复默认」使用） */
export function builtinSkillDefaultContent(id: string): string | null {
  return id === 'builtin-retrieval' ? RETRIEVAL_SKILL_PROMPT : null;
}

/** 内置 skill 的默认描述（供「恢复默认」使用；与 `defaultPromptConfig` 同源） */
export function builtinSkillDefaultDescription(id: string): string | null {
  return id === 'builtin-retrieval' ? RETRIEVAL_SKILL_DESCRIPTION : null;
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
  const normalized = normalizePromptConfig(parsed, issues, { effortSoft: true, softNotes });
  if (issues.length > 0) {
    return { config: defaultPromptConfig(), issue: `配置字段非法（已回退默认）：${issues.map((i) => i.path).join('、')}` };
  }
  return { config: normalized, issue: softNotes.length > 0 ? softNotes.join('；') : null };
}

// ─── 校验 / 归一化 ─────────────────────────────────────

/**
 * 把外部输入归一化为合法 `PromptConfig`，问题收集进 `issues`（不抛）。
 *
 * 服务端强制的两处（不信任客户端）：
 *   · `builtin` 由 id 是否属于内置集合决定（客户端传什么都被覆盖）
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
        const name = typeof it.name === 'string' ? it.name.trim() : '';
        if (!name) {
          issues.push({ path: `${at}.name`, message: '名称不能为空' });
        } else if (name.length > SKILL_NAME_MAX_CHARS) {
          issues.push({ path: `${at}.name`, message: `名称不得超过 ${SKILL_NAME_MAX_CHARS} 字` });
        } else if (seenNames.has(name)) {
          issues.push({ path: `${at}.name`, message: `名称重复：${name}` });
        }
        seenNames.add(name);
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
        // 内置 skill 不可删除：缺失即报错（可禁用，但不能从列表里消失）
        for (const builtinId of BUILTIN_SKILL_IDS) {
          if (!skills.some((s) => s.id === builtinId)) {
            issues.push({ path: 'skills', message: `内置 skill「${builtinId}」不可删除（可将其 enabled 置为 false 以停用）` });
          }
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
  const existingEffort = readPromptConfig(config).config.reasoningEffort;
  const next = normalizePromptConfig(input, issues, {
    existingEffort,
    effortOptions: config.llm?.reasoningEfforts,
  });
  if (issues.length > 0) throw new PromptConfigError(issues);
  const now = new Date().toISOString();
  // 时间戳由服务端打（客户端时间不可信）
  next.prompt.at = now;
  next.skills = next.skills.map((s) => ({ ...s, at: now }));
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
