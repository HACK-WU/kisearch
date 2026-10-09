/**
 * Chat MCP 工具注册表（批次 2 · REQ-20260930-001）
 *
 * 定位：把本服务真实注册的 14 个 MCP 工具**进程内**暴露给 AI 对话模型。
 *   · `def`：OpenAI function-calling 格式的工具定义（**剥离 scope 参数**，N23/§5.1：
 *     scope 由 daemon 从会话注入，模型不可指定；schema 不暴露 + 解析白名单双重保证）
 *   · `run`：进程内直调底层 `executeXxx`（与 MCP 工具同一批函数，S07 已否决 MCP 自连接）
 *   · 只读与写/删一律经 `OperationCoordinator`（scope 维度）排队 —— 与 `chat-kb-search`
 *     先例同款：生成期间的 zvec / local KB 读写必须与同 scope 写操作互斥；
 *     无 scope 参数的两个枚举工具（ki_scope_list / ki_manage_index_list）直接执行
 *     （与 MCP HTTP 层"只读不排队"口径一致）。
 *
 * ★ 与 `src/lib/mcp-tools/*` 的关系：参数语义、默认值、超时档位（READ/WRITE/BULK）
 *   均按各 registerXxxTool 的 zod schema 逐一对齐（改 MCP 工具参数时须同步此处）；
 *   但**暴露面刻意收窄**（如 ki_search 的 limit 上限压到 CHAT_BUDGET.maxHitsPerCall，
 *   不暴露 threshold / tags / timeout / include_original —— 模型无需调参，暴露即增加失控面）。
 *
 * ═══ 本批边界 ═══
 *   · 工具开关由 `PromptConfig.tools` 过滤（tool-loop 调 `enabledChatToolEntries`）；
 *   · 默认只读 6 个开启，写 6 / 删 2 需用户在配置层显式开启（2026-10-08 拍板）；
 *   · 写/删工具执行层**不再逐次确认** —— 配置层显式开启即授权（拍板 D6）；
 *   · `ki_search` 的结果由 tool-loop 投影为 `SourceRef[]`（`producesSources`，R7 不退化）。
 *
 * @see .plans/2026-10-08-chat-mcp-tools-batch2/plan.md（决策 D1~D6）
 */

import { CHAT_BUDGET, type RetrievalMode } from './chat-contract.js';
import type { ToolDef } from './llm-client.js';
import { getSharedOperationCoordinator } from '../operation-coordinator.js';
import { runWithConfigSnapshot, loadConfig } from '../config.js';
import { withTimeout, TOOL_TIMEOUT } from '../mcp-tools/util.js';
import { executeSearch } from '../../search.js';
import { executeQueryGroup } from '../../query-group.js';
import { executeGetModuleInfo, executeGetModuleInfoBatch } from '../../get-module-info.js';
import { executeTagList } from '../../tag.js';
import { executeScopeList } from '../../scope.js';
import { executeManageCreate, executeListScopes, executeManageDeleteEmpty } from '../../manage-index.js';
import { executeStore } from '../../store.js';
import { executeBulkStore } from '../../bulk-store.js';
import { executeSyncRelation, executeBulkSyncRelation } from '../../sync-relation.js';
import { executeEditRelation } from '../../edit-relation.js';
import { executeDeleteRelation } from '../../delete-relation.js';

/** 模型给的原始参数（JSON 解析 + 白名单取键 + 钳制后的结果） */
export type ChatToolArgs = Record<string, unknown>;

/** tool_start 事件的展示摘要：检索类给 query/mode，其余给 args 串 */
export interface ChatToolDescribe {
  query?: string;
  mode?: RetrievalMode;
  args?: string;
}

export interface ChatMcpToolEntry {
  readonly name: string;
  /** 暴露给模型的工具定义（parameters 中**不得出现 scope**） */
  readonly def: ToolDef;
  /** 只读（决定前端时间线措辞；排队上一律入队，见文件头） */
  readonly readOnly: boolean;
  /** 结果是 SearchResult → tool-loop 据此投影 sources（仅 ki_search） */
  readonly producesSources?: boolean;
  /** 解析模型 arguments JSON（白名单 + 钳制 + 必填校验）；失败抛 Error（不静默） */
  parse(raw: string): ChatToolArgs;
  /** 进程内执行（scope 由 daemon 注入；含排队 + 配置快照 + 超时） */
  run(scope: string, args: ChatToolArgs): Promise<unknown>;
  /** 从解析后参数提取展示摘要（大字段如 module_info / edits 不进摘要） */
  describe(args: ChatToolArgs): ChatToolDescribe;
}

// ─── 参数解析（白名单 + 宽松钳制，与 kb-search-tool 的既有哲学一致）──────────

interface ArgSpec {
  key: string;
  type: 'string' | 'int' | 'boolean' | 'enum' | 'stringArray' | 'objectArray';
  required?: boolean;
  /** 缺省时的默认值（与 MCP zod schema 的 default 对齐） */
  default?: unknown;
  min?: number;
  max?: number;
  /** enum：合法值 */
  values?: readonly string[];
  /** stringArray：条数上限 */
  maxItems?: number;
  /** objectArray：条目保留键 / 必填键 */
  itemKeys?: readonly string[];
  itemRequired?: readonly string[];
}

function asInt(v: unknown, spec: ArgSpec): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  let i = Math.floor(n);
  if (spec.min !== undefined) i = Math.max(i, spec.min);
  if (spec.max !== undefined) i = Math.min(i, spec.max);
  return i;
}

/**
 * 解析模型 arguments JSON 字符串。
 *
 * · 非法 JSON / 非对象 / 缺必填 → 抛 Error（tool-loop 转 tool_end.error，模型可见并自行修正）
 * · 类型不符 → 尽量钳制（数字串→int、'true'→true）；钳不动时用默认值或忽略（不报错：
 *   报错会让模型陷入"参数错了→改参数→再试"循环，N19 要求收敛）
 * · 越界参数（如模型幻觉出的 `scope`）→ **静默丢弃**（白名单取键，N23 双重保证之一）
 */
export function parseToolArgs(raw: string, toolName: string, specs: readonly ArgSpec[]): ChatToolArgs {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${toolName} 参数为空：期望 JSON 对象`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${toolName} 参数不是合法 JSON：${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${toolName} 参数应为 JSON 对象`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: ChatToolArgs = {};

  for (const spec of specs) {
    const has = Object.prototype.hasOwnProperty.call(obj, spec.key) && obj[spec.key] !== undefined && obj[spec.key] !== null;
    const v = has ? obj[spec.key] : spec.default;

    if (v === undefined) {
      if (spec.required) throw new Error(`${toolName} 缺少必填参数 ${spec.key}`);
      continue;
    }

    switch (spec.type) {
      case 'string': {
        const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
        if (s === undefined) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 应为字符串`);
          continue;
        }
        if (spec.required && s.trim().length === 0) throw new Error(`${toolName} 参数 ${spec.key} 不能为空`);
        out[spec.key] = s;
        break;
      }
      case 'int': {
        const n = asInt(v, spec);
        if (n === undefined) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 应为整数`);
          continue;
        }
        out[spec.key] = n;
        break;
      }
      case 'boolean': {
        const b = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
        if (b === undefined) continue;
        out[spec.key] = b;
        break;
      }
      case 'enum': {
        const s = typeof v === 'string' ? v : undefined;
        if (s !== undefined && spec.values?.includes(s)) {
          out[spec.key] = s;
        } else if (spec.default !== undefined) {
          // 非法枚举值 → 回落默认（与 kb-search-tool 旧哲学一致：不报错，模型无需懂合法值）
          out[spec.key] = spec.default;
        } else if (spec.required) {
          // ★ 必填枚举且无默认（如 ki_edit_relation.action）：非法值不得静默丢键 ——
          //   否则 undefined 直达底层 execute，行为不可预期。抛错让模型自我修正。
          throw new Error(`${toolName} 参数 ${spec.key} 应为以下值之一：${spec.values?.join(' | ')}`);
        }
        break;
      }
      case 'stringArray': {
        const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : undefined;
        if (arr === undefined) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 应为字符串数组`);
          continue;
        }
        const strs = arr.map((x) => (typeof x === 'string' ? x : String(x))).filter((s) => s.trim().length > 0);
        if (strs.length === 0) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 至少包含一个名称`);
          continue;
        }
        if (spec.maxItems !== undefined && strs.length > spec.maxItems) {
          throw new Error(`${toolName} 参数 ${spec.key} 最多 ${spec.maxItems} 条（收到 ${strs.length}）`);
        }
        out[spec.key] = strs;
        break;
      }
      case 'objectArray': {
        const arr = Array.isArray(v) ? v : undefined;
        if (arr === undefined) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 应为数组`);
          continue;
        }
        if (spec.maxItems !== undefined && arr.length > spec.maxItems) {
          throw new Error(`${toolName} 参数 ${spec.key} 最多 ${spec.maxItems} 条（收到 ${arr.length}）`);
        }
        const items: Record<string, unknown>[] = [];
        for (const item of arr) {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${toolName} 参数 ${spec.key} 的条目应为对象`);
          }
          const src = item as Record<string, unknown>;
          const keep: Record<string, unknown> = {};
          for (const k of spec.itemKeys ?? []) {
            if (src[k] !== undefined && src[k] !== null) keep[k] = src[k];
          }
          for (const k of spec.itemRequired ?? []) {
            const val = keep[k];
            if (val === undefined || (typeof val === 'string' && val.trim().length === 0)) {
              throw new Error(`${toolName} 参数 ${spec.key} 条目缺少 ${k}`);
            }
          }
          items.push(keep);
        }
        if (items.length === 0) {
          if (spec.required) throw new Error(`${toolName} 参数 ${spec.key} 至少包含一条`);
          continue;
        }
        out[spec.key] = items;
        break;
      }
    }
  }
  return out;
}

// ─── 执行底座：排队 + 配置快照 + 超时（对齐 kb-search-tool / MCP 双口径）──────

/**
 * 带 scope 的工具执行：入 OperationCoordinator（scope 维度）。
 * 配置快照语义与 runKbSearch 一致（队列出队后用入队时的配置，不用磁盘最新）。
 */
async function submitScoped<T>(toolName: string, scope: string, fn: () => Promise<T>): Promise<T> {
  const config = loadConfig();
  const outcome = await getSharedOperationCoordinator().submit(
    { operation: `chat-mcp-${toolName}`, params: { scope } },
    () => runWithConfigSnapshot(config, fn),
    [scope],
  );
  return outcome.result as T;
}

/** 无 scope 参数的枚举工具：直接执行（不排队，与 MCP HTTP 层只读口径一致） */
async function runDirect<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

// ─── 展示摘要（大字段不进摘要）────────────────────────────────────────

function summarize(entries: Array<[string, unknown]>): string {
  return entries
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${shorten(String(v))}`)
    .join(' ');
}

function shorten(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── 14 个工具注册 ────────────────────────────────────────────────────

/** 工具入口工厂（specs → parse/describe 的公共装配） */
function makeEntry(config: {
  name: string;
  def: ToolDef;
  readOnly: boolean;
  producesSources?: boolean;
  specs: readonly ArgSpec[];
  /** 覆盖默认展示摘要（默认：小字段拼 key=value；module_info/edits/text/items 等大字段排除） */
  describe?: (args: ChatToolArgs) => ChatToolDescribe;
  run: (scope: string, args: ChatToolArgs) => Promise<unknown>;
}): ChatMcpToolEntry {
  const defaultDescribe = (args: ChatToolArgs): ChatToolDescribe => {
    const keys = config.specs
      .map((s) => s.key)
      .filter((k) => k !== 'module_info' && k !== 'edits' && k !== 'text' && k !== 'items');
    return { args: summarize(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])) };
  };
  return {
    name: config.name,
    def: config.def,
    readOnly: config.readOnly,
    ...(config.producesSources ? { producesSources: config.producesSources } : {}),
    parse: (raw: string) => parseToolArgs(raw, config.name, config.specs),
    run: config.run,
    describe: config.describe ?? defaultDescribe,
  };
}

const SEARCH_DESC = [
  '检索当前会话的知识库（scope 由系统注入，不可指定），返回带 group/文档/行号的命中片段。',
  '当提问包含【确切字面片段】（引号内文字 / 报错信息 / 函数名 / 配置键 / 文件路径）时用 mode=fulltext（不调用 embedding，快且精确）；其余概念性问题用 mode=hybrid（语义+全文）。',
  '无需检索的闲聊不调用；证据足够后停止，勿重复相同查询。',
  '若未命中，必须如实说明"知识库中未找到"，不得用自身知识冒充知识库结论。',
].join(' ');

export const CHAT_MCP_TOOLS: readonly ChatMcpToolEntry[] = [
  // ── 只读 6 ─────────────────────────────────────────────
  makeEntry({
    name: 'ki_search',
    readOnly: true,
    producesSources: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_search',
        description: SEARCH_DESC,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索文本；fulltext 模式建议直接给字面片段' },
            mode: {
              type: 'string',
              enum: ['fulltext', 'hybrid'],
              description: 'fulltext=仅全文（快，不调 embedding）；hybrid=语义+全文（默认）',
            },
            limit: { type: 'integer', minimum: 1, maximum: CHAT_BUDGET.maxHitsPerCall, description: `返回条数上限，默认 ${CHAT_BUDGET.maxHitsPerCall}` },
          },
          required: ['query'],
        },
      },
    },
    specs: [
      { key: 'query', type: 'string', required: true },
      { key: 'mode', type: 'enum', values: ['fulltext', 'hybrid'], default: 'hybrid' },
      { key: 'limit', type: 'int', min: 1, max: CHAT_BUDGET.maxHitsPerCall, default: CHAT_BUDGET.maxHitsPerCall },
    ],
    describe: (args: ChatToolArgs): ChatToolDescribe => ({
      query: args.query as string | undefined,
      mode: args.mode as RetrievalMode | undefined,
    }),
    run: (scope, a) => submitScoped('ki_search', scope, () =>
      withTimeout(
        executeSearch({
          scope,
          query: a.query as string,
          mode: a.mode as RetrievalMode | undefined ?? 'hybrid',
          limit: a.limit as number | undefined ?? CHAT_BUDGET.maxHitsPerCall,
        }),
        TOOL_TIMEOUT.WRITE,
        'ki_search',
      )),
  }),
  makeEntry({
    name: 'ki_query_group',
    readOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_query_group',
        description: '查询当前会话知识库的 Group 树结构与 Relations（支持按分区 hot/warm/cold/emerging/full 展示、按 Group 路径或子树过滤）。先看结构再精确检索时使用。',
        parameters: {
          type: 'object',
          properties: {
            groups: { type: 'string', description: '逗号分隔的 Group 路径（支持模糊匹配），展示这些 Group 的 Relations' },
            subtree: { type: 'string', description: '以指定 Group 路径为根输出子树结构（与 groups 互斥）' },
            mode: { type: 'string', description: '展示分区：hot|warm|cold|emerging|full（逗号分隔），默认 hot' },
            depth: { type: 'integer', minimum: 1, maximum: 10, description: '索引层级深度，默认 4' },
          },
        },
      },
    },
    specs: [
      { key: 'groups', type: 'string' },
      { key: 'subtree', type: 'string' },
      { key: 'mode', type: 'string', default: 'hot' },
      { key: 'depth', type: 'int', min: 1, max: 10, default: 4 },
    ],
    run: (scope, a) => submitScoped('ki_query_group', scope, () =>
      withTimeout(
        executeQueryGroup({
          scope,
          groupsParam: a.groups as string | undefined,
          subtreeParam: a.subtree as string | undefined,
          hotCount: 5,
          depth: a.depth as number | undefined ?? 4,
          modes: String(a.mode ?? 'hot').split(',').map((m) => m.trim()).filter(Boolean),
          autoFallback: true,
        }),
        TOOL_TIMEOUT.READ,
        'ki_query_group',
      )),
  }),
  makeEntry({
    name: 'ki_get_module_info',
    readOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_get_module_info',
        description: '读取当前会话知识库中指定 Group 下某个/多个 Relation（文档）的本地 KB Markdown 全文（批量 ≤10 条，须同 Group）。检索只拿到片段、需要完整原文时使用。',
        parameters: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Group 路径（支持向量语义兜底）' },
            relation: { type: 'string', description: 'Relation（文档）名称，精确匹配。单条查询用；与 relations 二选一' },
            relations: { type: 'array', items: { type: 'string' }, maxItems: 10, description: '同 Group 下批量查询（≤10 条）。与 relation 二选一' },
          },
          required: ['group'],
        },
      },
    },
    specs: [
      { key: 'group', type: 'string', required: true },
      { key: 'relation', type: 'string' },
      { key: 'relations', type: 'stringArray', maxItems: 10 },
    ],
    run: (scope, a) => submitScoped('ki_get_module_info', scope, async () => {
      if (a.relations !== undefined) {
        return withTimeout(
          executeGetModuleInfoBatch({ scope, group: a.group as string, relations: a.relations as string[] }),
          TOOL_TIMEOUT.READ,
          'ki_get_module_info',
        );
      }
      return withTimeout(
        executeGetModuleInfo({ scope, group: a.group as string, relation: a.relation as string }),
        TOOL_TIMEOUT.READ,
        'ki_get_module_info',
      );
    }),
  }),
  makeEntry({
    name: 'ki_tag_list',
    readOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_tag_list',
        description: '列出当前会话知识库下使用过的 tag（含文档数，按数量降序）。用于发现可用的过滤标签。',
        parameters: { type: 'object', properties: {} },
      },
    },
    specs: [],
    run: (scope) => submitScoped('ki_tag_list', scope, () =>
      withTimeout(executeTagList({ scope }), TOOL_TIMEOUT.READ, 'ki_tag_list')),
  }),
  makeEntry({
    name: 'ki_scope_list',
    readOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_scope_list',
        description: '列出所有知识库 scope（KB 目录层 + 向量语义层并集，标注存在层与注册状态）。注意：对话工具固定作用于当前会话 scope，本工具仅用于了解 scope 全貌。',
        parameters: { type: 'object', properties: {} },
      },
    },
    specs: [],
    run: () => runDirect(() => withTimeout(executeScopeList(), TOOL_TIMEOUT.READ, 'ki_scope_list')),
  }),
  makeEntry({
    name: 'ki_manage_index_list',
    readOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'ki_manage_index_list',
        description: '列出所有 scope 及其顶层 Group（带 registered/initialized 标注），用于了解索引配置全貌。',
        parameters: { type: 'object', properties: {} },
      },
    },
    specs: [],
    // executeListScopes 是同步函数（读配置与目录）—— 包一层 Promise 以统一超时底座
    run: () => runDirect(() => withTimeout(Promise.resolve(executeListScopes()), TOOL_TIMEOUT.READ, 'ki_manage_index_list')),
  }),

  // ── 写入 6（默认关闭；配置层显式开启后才暴露给模型）────────────
  makeEntry({
    name: 'ki_store',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_store',
        description: '存储一段文本到当前会话知识库的向量索引（用户要求记录某条知识/笔记时使用）。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '待存储的文本内容' },
            tags: { type: 'string', description: '逗号分隔的标签，默认 ki-search' },
          },
          required: ['text'],
        },
      },
    },
    specs: [
      { key: 'text', type: 'string', required: true },
      { key: 'tags', type: 'string', default: 'ki-search' },
    ],
    run: (scope, a) => submitScoped('ki_store', scope, () =>
      withTimeout(
        executeStore({ scope, text: a.text as string, tags: a.tags as string | undefined }),
        TOOL_TIMEOUT.WRITE,
        'ki_store',
      )),
  }),
  makeEntry({
    name: 'ki_bulk_store',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_bulk_store',
        description: '从本地 JSON 文件批量导入文本到向量索引（仅在用户明确给出文件路径时使用）。',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: '批量数据 JSON 文件路径' } },
          required: ['input'],
        },
      },
    },
    specs: [{ key: 'input', type: 'string', required: true }],
    run: (scope, a) => submitScoped('ki_bulk_store', scope, () =>
      withTimeout(
        executeBulkStore({ scope, inputFile: a.input as string }),
        TOOL_TIMEOUT.BULK,
        'ki_bulk_store',
      )),
  }),
  makeEntry({
    name: 'ki_sync_relation',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_sync_relation',
        description: '写入/更新一条 Relation（文档）及其本地 KB Markdown 内容到当前会话知识库（自动补建 Group 树）。小文档直接用本工具提交完整正文。',
        parameters: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Group 路径（支持 / 层级嵌套）' },
            relation: { type: 'string', description: 'Relation（文档）名称' },
            module_info: { type: 'string', description: '该文档的完整 Markdown 内容' },
            vector: { type: 'boolean', description: '是否写入语义向量层（默认 true；false=仅全文索引，不调 embedding）' },
            tags: { type: 'string', description: '自定义标签（逗号分隔，叠加在默认之上）' },
          },
          required: ['group', 'relation', 'module_info'],
        },
      },
    },
    specs: [
      { key: 'group', type: 'string', required: true },
      { key: 'relation', type: 'string', required: true },
      { key: 'module_info', type: 'string', required: true },
      { key: 'vector', type: 'boolean', default: true },
      { key: 'tags', type: 'string' },
    ],
    run: (scope, a) => submitScoped('ki_sync_relation', scope, () =>
      withTimeout(
        executeSyncRelation({
          scope,
          group: a.group as string,
          relation: a.relation as string,
          moduleInfo: a.module_info as string,
          vector: a.vector as boolean | undefined ?? true,
          tags: a.tags as string | undefined,
        }),
        TOOL_TIMEOUT.WRITE,
        'ki_sync_relation',
      )),
  }),
  makeEntry({
    name: 'ki_bulk_sync_relation',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_bulk_sync_relation',
        description: '批量写入/更新多条 Relation + 本地 KB（单次 ≤50 条，一次 embedding，比逐条 ki_sync_relation 快）。同时写入多条文档时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              maxItems: 50,
              description: '批量写入条目',
              items: {
                type: 'object',
                properties: {
                  group: { type: 'string', description: 'Group 路径' },
                  relation: { type: 'string', description: 'Relation 名称' },
                  module_info: { type: 'string', description: 'Markdown 内容' },
                  tags: { type: 'string', description: '自定义标签（可选）' },
                },
                required: ['group', 'relation', 'module_info'],
              },
            },
            vector: { type: 'boolean', description: '是否写入语义向量层（默认 true）' },
          },
          required: ['items'],
        },
      },
    },
    specs: [
      {
        key: 'items',
        type: 'objectArray',
        required: true,
        maxItems: 50,
        itemKeys: ['group', 'relation', 'module_info', 'tags'],
        itemRequired: ['group', 'relation', 'module_info'],
      },
      { key: 'vector', type: 'boolean', default: true },
    ],
    describe: (args: ChatToolArgs): ChatToolDescribe => {
      const count = Array.isArray(args.items) ? (args.items as unknown[]).length : 0;
      return { args: `items=${count}${args.vector !== undefined ? ` vector=${String(args.vector)}` : ''}` };
    },
    run: (scope, a) => submitScoped('ki_bulk_sync_relation', scope, () =>
      withTimeout(
        executeBulkSyncRelation({
          scope,
          // BulkSyncItem 用 snake 键（与 MCP zod schema 对齐）
          items: (a.items as Array<Record<string, string>>).map((it) => ({
            group: it.group,
            relation: it.relation,
            module_info: it.module_info,
            ...(it.tags !== undefined ? { tags: it.tags } : {}),
          })),
          vector: a.vector as boolean | undefined ?? true,
        }),
        TOOL_TIMEOUT.BULK,
        'ki_bulk_sync_relation',
      )),
  }),
  makeEntry({
    name: 'ki_edit_relation',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_edit_relation',
        description: [
          '局部修改已有的大 Relation：edit 可多轮、每轮同时修改多个不重叠行区间（行号从 1 开始且包含 end_line）；view 查看草稿/发布状态；finish 提交终稿并更新索引；cancel 放弃草稿。',
          '注意：finish 是异步的——返回 queued 后必须用 view 轮询到 published/failed；finish 会覆盖写回该 Relation 的源文件。',
          '小 Relation 建议直接用 ki_sync_relation 提交完整正文。',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['edit', 'view', 'finish', 'cancel'], description: 'edit 修改草稿；view 查询状态；finish 提交；cancel 放弃' },
            group: { type: 'string', description: '精确 Group 路径；首次 edit 必填' },
            relation: { type: 'string', description: '精确 Relation 名称；首次 edit 必填' },
            edit_id: { type: 'string', description: '草稿 ID；后续 edit/view/finish/cancel 必填' },
            expected_revision: { type: 'string', description: '首次 edit 用 ki_get_module_info 返回的 revision；后续用草稿返回的 revision' },
            edits: {
              type: 'array',
              description: '同批修改的多个不重叠区域（按草稿当前行号）',
              items: {
                type: 'object',
                properties: {
                  start_line: { type: 'integer', description: '起始行，1-based' },
                  end_line: { type: 'integer', description: '结束行（含）' },
                  new_text: { type: 'string', description: '替换后的新正文；空字符串删除该区间' },
                },
                required: ['start_line', 'end_line', 'new_text'],
              },
            },
            request_id: { type: 'string', description: 'finish 必填：幂等请求 ID，重试沿用' },
            start_line: { type: 'integer', description: 'view 可选：查看草稿起始行' },
            end_line: { type: 'integer', description: 'view 可选：查看草稿结束行（含）' },
          },
          required: ['action'],
        },
      },
    },
    specs: [
      { key: 'action', type: 'enum', values: ['edit', 'view', 'finish', 'cancel'], required: true },
      { key: 'group', type: 'string' },
      { key: 'relation', type: 'string' },
      { key: 'edit_id', type: 'string' },
      { key: 'expected_revision', type: 'string' },
      {
        key: 'edits',
        type: 'objectArray',
        itemKeys: ['start_line', 'end_line', 'new_text'],
        itemRequired: ['start_line', 'end_line', 'new_text'],
      },
      { key: 'request_id', type: 'string' },
      { key: 'start_line', type: 'int', min: 1 },
      { key: 'end_line', type: 'int', min: 1 },
    ],
    run: (scope, a) => submitScoped('ki_edit_relation', scope, () =>
      withTimeout(
        executeEditRelation({
          action: a.action as 'edit' | 'view' | 'finish' | 'cancel',
          scope,
          group: a.group as string | undefined,
          relation: a.relation as string | undefined,
          editId: a.edit_id as string | undefined,
          expectedRevision: a.expected_revision as string | undefined,
          edits: a.edits !== undefined
            ? (a.edits as Array<Record<string, unknown>>).map((e) => ({
                start_line: Number(e.start_line),
                end_line: Number(e.end_line),
                new_text: String(e.new_text ?? ''),
              }))
            : undefined,
          requestId: a.request_id as string | undefined,
          startLine: a.start_line as number | undefined,
          endLine: a.end_line as number | undefined,
        }),
        a.action === 'cancel' ? TOOL_TIMEOUT.BULK : TOOL_TIMEOUT.WRITE,
        'ki_edit_relation',
      )),
  }),
  makeEntry({
    name: 'ki_manage_index_create',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_manage_index_create',
        description: '在当前会话知识库的 Group 树中创建新节点（scope 不存在则自动创建）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '新节点名称（不能包含 /）' },
            parent: { type: 'string', description: '父节点路径（省略则挂在根层）' },
          },
          required: ['name'],
        },
      },
    },
    specs: [
      { key: 'name', type: 'string', required: true },
      { key: 'parent', type: 'string' },
    ],
    run: (scope, a) => submitScoped('ki_manage_index_create', scope, () =>
      withTimeout(
        executeManageCreate({ scope, name: a.name as string, parent: a.parent as string | undefined }),
        TOOL_TIMEOUT.WRITE,
        'ki_manage_index_create',
      )),
  }),

  // ── 删除 2（默认关闭；配置层显式开启后才暴露给模型）────────────
  makeEntry({
    name: 'ki_delete_relation',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_delete_relation',
        description: '删除当前会话知识库中的一条 Relation 及其关联数据（relations-cache + 本地 KB + wiki 文件 + 向量）。仅当用户明确要求删除时使用。',
        parameters: {
          type: 'object',
          properties: {
            group: { type: 'string', description: 'Group 路径（支持模糊匹配）' },
            relation: { type: 'string', description: 'Relation 名称（精确匹配）' },
          },
          required: ['group', 'relation'],
        },
      },
    },
    specs: [
      { key: 'group', type: 'string', required: true },
      { key: 'relation', type: 'string', required: true },
    ],
    run: (scope, a) => submitScoped('ki_delete_relation', scope, () =>
      withTimeout(
        executeDeleteRelation({ scope, group: a.group as string, relation: a.relation as string }),
        TOOL_TIMEOUT.WRITE,
        'ki_delete_relation',
      )),
  }),
  makeEntry({
    name: 'ki_manage_index_delete',
    readOnly: false,
    def: {
      type: 'function',
      function: {
        name: 'ki_manage_index_delete',
        description: '删除 Group 树中的**空**节点（仅限无子节点、无 relation、无本地 KB 的节点；非空节点会被拒绝）。仅当用户明确要求删除时使用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要删除的节点名称（不能包含 /）' },
            parent: { type: 'string', description: '父节点路径（省略则在顶层查找）' },
          },
          required: ['name'],
        },
      },
    },
    specs: [
      { key: 'name', type: 'string', required: true },
      { key: 'parent', type: 'string' },
    ],
    run: (scope, a) => submitScoped('ki_manage_index_delete', scope, () =>
      withTimeout(
        executeManageDeleteEmpty({ scope, name: a.name as string, parent: a.parent as string | undefined }),
        TOOL_TIMEOUT.WRITE,
        'ki_manage_index_delete',
      )),
  }),
];

// ── 查询接口 ────────────────────────────────────────────────────────

/** 按名查工具（tool-loop 解析模型 tool_calls 用） */
export function getChatTool(name: string): ChatMcpToolEntry | undefined {
  return CHAT_MCP_TOOLS.find((t) => t.name === name);
}

/**
 * 工具开关过滤：注册表 ∩ `PromptConfig.tools`（值为 true 才暴露）。
 * 开关里未登记的名字一律视为关闭（保守侧）。
 */
export function enabledChatToolEntries(tools: Record<string, boolean>): ChatMcpToolEntry[] {
  return CHAT_MCP_TOOLS.filter((t) => tools[t.name] === true);
}
