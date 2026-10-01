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
 * ★═══ 本批边界（勿越界）═══★
 *   · 工具开关**只存不生效** —— 真正生效在批次 2（暴露 MCP 工具给 AI）时接上；
 *     在此之前不得让任何链路"以为开关已生效"（UI 侧需标注）。
 *   · 不删除 / 不改写现有内置检索链路（`kb-search-tool.ts` / `retrieval-skill.ts` / `degradedPath`）。
 *   · 不修改 `chat-contract.ts`（骨架期冻结）；本模块新增的错误码属**待并入契约**项。
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteConfig, resolveDefaultChatDir, type KiConfig } from '../config.js';
import { DEFAULT_CHAT_PROMPT, RETRIEVAL_SKILL_PROMPT } from './retrieval/retrieval-skill.js';

// ─── 上限（服务端强制；前端字数提示只是辅助）─────────────────

export const PROMPT_MAX_CHARS = 4000;
export const SKILL_MAX_CHARS = 8000;
export const SKILL_NAME_MAX_CHARS = 64;
export const MAX_SKILLS = 20;
/** skill id：小写字母/数字开头，允许连字符（与 scope 命名风格一致，便于后续按 id 引用） */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
    names: ['ki_search', 'ki_query_group', 'ki_get_module_info', 'ki_tag_list', 'ki_scope_list', 'ki_manage_index_list'],
    descs: {
      ki_search: '混合 / 字面检索知识库',
      ki_query_group: '查看 Group 树结构',
      ki_get_module_info: '读取指定文档原文',
      ki_tag_list: '列出标签',
      ki_scope_list: '列出 scope 清单',
      ki_manage_index_list: '列出索引配置',
    },
  },
  {
    key: 'write',
    label: '写入',
    danger: true,
    names: ['ki_store', 'ki_bulk_store', 'ki_sync_relation', 'ki_bulk_sync_relation', 'ki_edit_relation', 'ki_manage_index_create'],
    descs: {
      ki_store: '写入向量',
      ki_bulk_store: '批量写入向量',
      ki_sync_relation: '写入 / 更新关系与 KB 内容',
      ki_bulk_sync_relation: '批量写入关系',
      ki_edit_relation: '编辑既有关系（覆盖原内容）',
      ki_manage_index_create: '在 Group 树中新建节点',
    },
  },
  {
    key: 'delete',
    label: '删除',
    danger: true,
    names: ['ki_delete_relation', 'ki_manage_index_delete'],
    descs: {
      ki_delete_relation: '删除关系及其关联数据',
      ki_manage_index_delete: '删除 Group 节点及其下内容',
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
        // 页面与模型注入共用默认内容，避免文案漂移。
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
  const normalized = normalizePromptConfig(parsed, issues);
  if (issues.length > 0) {
    return { config: defaultPromptConfig(), issue: `配置字段非法（已回退默认）：${issues.map((i) => i.path).join('、')}` };
  }
  return { config: normalized, issue: null };
}

// ─── 校验 / 归一化 ─────────────────────────────────────

/**
 * 把外部输入归一化为合法 `PromptConfig`，问题收集进 `issues`（不抛）。
 *
 * 服务端强制的两处（不信任客户端）：
 *   · `builtin` 由 id 是否属于内置集合决定（客户端传什么都被覆盖）
 *   · `tools` 只接受白名单内的键（未知名报错，不静默丢弃 —— 拼错的开关名会让人以为生效了）
 */
export function normalizePromptConfig(input: unknown, issues: PromptConfigIssue[]): PromptConfig {
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
        const content = typeof it.content === 'string' ? it.content : '';
        if (content.length > SKILL_MAX_CHARS) {
          issues.push({ path: `${at}.content`, message: `不得超过 ${SKILL_MAX_CHARS} 字，实际 ${content.length}` });
        }
        skills.push({
          id,
          name,
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

  return out;
}

// ─── 写 ───────────────────────────────────────────────

/**
 * 校验并保存（原子写 + 保留原文件权限）。
 * @throws {PromptConfigError} 校验失败（不会落盘）
 */
export function savePromptConfig(config: KiConfig, input: unknown): PromptConfig {
  const issues: PromptConfigIssue[] = [];
  const next = normalizePromptConfig(input, issues);
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

// ─── 注入（供 retrieval-skill / tool-loop 使用）──────────────

/**
 * 按序产出要注入的 system 文本块：
 *   `[内置 skill*] → [基础提示词] → [其余启用的 skill*]`
 *
 * · 顺序理由：内置 skill 含反幻觉规则，必须**先于**用户配置出现（既有约定：skill 在前）
 * · 空块不发（调用方据此不留空 system 消息 —— 与既有契约测试口径一致）
 * · 未配置时：产出 [RETRIEVAL_SKILL_PROMPT, DEFAULT_CHAT_PROMPT]，与默认构造器同源。
 */
export function promptConfigSystemBlocks(cfg: PromptConfig): string[] {
  const blocks: string[] = [];
  const push = (text: string): void => {
    if (text && text.trim().length > 0) blocks.push(text);
  };
  cfg.skills.filter((s) => s.builtin && s.enabled).forEach((s) => push(s.content));
  push(cfg.prompt.content);
  cfg.skills.filter((s) => !s.builtin && s.enabled).forEach((s) => push(s.content));
  return blocks;
}
