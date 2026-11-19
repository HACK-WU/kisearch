/**
 * 通用「带证据的模型检索循环」（2026-11-18 从 `ki_recall` 抽出，供两条入口复用）。
 *
 * **定位**：一个被关在知识库里的子 agent。给它一份系统提示词 + 一段用户消息 + 一组受限工具，
 * 它多轮读正文、判断哪些文档真的有用，最后只带回「清单 + 结论 + 不确定点」。
 *
 * **它不认识业务场景**：不读 `prompt-config` 的某个域、不认「预取/查找」。
 * 场景差异全部落在两处（这是本文件唯一的设计约束）：
 *   ① 调用方构造的 `systemPrompt` / `userMessage`（含强制加载哪个 skill）；
 *   ② 调用方注入的 `runTool`（工具执行器）。
 *
 * 为什么这样切（用户 2026-11-18 拍板）：`find`（给用户）与 `recall`（给 agent）的
 * 差异只在「输入装配 / 出参消费 / 范围来源」，内核完全一样 —— 写两份的结果是
 * 每改一次都要改两处，漏一处就是"查找有 AI 判断、预取没有"。
 *
 * ⚠️ 本文件**不做 IO**：模型调用走 `stream`，工具执行走 `runTool`，这样单测不碰真实库。
 */

import type { ChatTurn, LlmStreamPart, ToolDef } from '../chat/llm-client.js';
import { RecallKernelError } from './codes.js';
import type { NeedMoreItem, NextAction, RecallHit } from './types.js';

/** 一次工具调用的结果 */
export interface GroundedToolOutcome {
  /** 回给模型的文本（调用方负责按字符预算截断） */
  text: string;
  /** 若读了文档正文，回填身份（用于校验「候选必须真读过」） */
  read?: { scope: string; group: string; name: string; truncated: boolean };
  /**
   * `ki_search` 的**实际**检索模式（2026-11-19）。
   *
   * 必须报实际值而不是模型请求值：语义侧不可用时引擎会降级成全文，
   * 照抄入参会让面板把一次降级检索显示成"语义+全文"。
   */
  searchMode?: 'hybrid' | 'fulltext';
}

export type GroundedToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<GroundedToolOutcome>;

export interface GroundedInput {
  /** 系统提示词（判定口径 + 硬规则 + 输出格式） */
  systemPrompt: string;
  /** 用户消息（任务/事件画像 + 线索 + 范围 + 已读清单 + 种子候选） */
  userMessage: string;
  /** 已读清单：命中的候选会被剔除（`scope::group::name` 或 `group::name`） */
  exclude?: string[];
  /** 候选条数上限 */
  limit: number;
  /** 工具开关（键必须出现在 `TOOL_DEFS` 里；未开启的工具模型调了会被拒） */
  tools: Record<string, boolean>;
  /** 轮次上限（用尽后自动走一次「收口轮」） */
  maxRounds: number;
  /**
   * 工具调用次数上限（缺省 = 不限制）。计数口径 = 本次**实际执行**的调用数
   * （即结果里的 `toolTrace.length`），与过程面板的 `metrics.calls` 同一份数。
   *
   * 达到上限后：本轮剩余调用一律回错误文本（否则模型会一直等工具结果），并立即收口，
   * 不再消耗后续轮次 —— 只在外层轮次判断会让"一轮并发 3 个调用"超发。
   */
  maxToolCalls?: number;
  /** 模型参数（baseURL / apiKey / model / temperature / maxTokens / reasoningEffort） */
  llm: Record<string, unknown>;
  /** 模型流式接口（生产 = `streamChat`） */
  stream: (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;
  /** 工具执行器（缺失时任何工具调用都返回错误文本） */
  runTool?: GroundedToolRunner;
  now?: () => number;
  signal?: AbortSignal;
  /**
   * 每次**工具调用结束**时回调（2026-11-19）。
   *
   * 给需要"边跑边显示"的入口用（当前是「AI 查找」的过程面板）：内核本身不关心传输层，
   * 只是把事件交出去；SSE / WebSocket 由调用方决定。
   */
  onToolCall?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void;
}

export interface GroundedResult {
  summary: string;
  candidates: RecallHit[];
  uncertainties: string[];
  needMore: NeedMoreItem[];
  nextActions: NextAction[];
  /** 被校验剔除的条数（编造 / 只读过片段） */
  dropped: number;
  /**
   * 工具调用轨迹（按调用顺序）。**给过程面板用**：
   * 「AI 查找」把它映射成 steps，让用户看到"检索了什么、读了几篇"。
   */
  toolTrace: Array<{ name: string; args: Record<string, unknown>; ms: number; ok: boolean }>;
  /** 模型输出是否可解析（false = 面板应显示"模型未给出可解析结果"，而不是"没有相关文档"） */
  parsedOk: boolean;
  rounds: number;
  partial?: boolean;
  /**
   * 提前收口的原因（调用方据此如实告知用户）：
   *   · `timeout` = 模型调用超时 / 被 abort；
   *   · `budget`  = 工具调用次数用尽（`maxToolCalls`）。
   * 缺失（而 `partial` 为真）= 只读到片段导致的降级，与收口无关。
   */
  stopReason?: 'timeout' | 'budget';
  /**
   * 本次所有检索轮次的**聚合模式**（工具未回填时缺省）：
   * 全部轮次都降级为全文才算 `fulltext`；只要有一轮走了语义就是 `hybrid`。
   * 没有任何检索（模型凭清单判断）也不返回 —— 调用方按 `hybrid` 处理，不声称降级。
   */
  mode?: 'hybrid' | 'fulltext';
  durationMs: number;
}

// ─── 工具定义（OpenAI function schema）──────────────────

const TOOL_DEFS: Record<string, ToolDef> = {
  ki_search: {
    type: 'function',
    function: {
      name: 'ki_search',
      description: '在知识库里做语义 + 全文混合检索，返回最相关的片段。用同义表达多试几次比一次广撒网更有效。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（短句或关键词组合，不要整段任务描述）' },
          mode: { type: 'string', enum: ['hybrid', 'fulltext'], description: '缺省 hybrid' },
          limit: { type: 'number', description: '返回条数 1~20，缺省 8' },
        },
        required: ['query'],
      },
    },
  },
  ki_get_module_info: {
    type: 'function',
    function: {
      name: 'ki_get_module_info',
      description: '按 group 与文档名读取整篇正文。**判断一篇文档是否相关，必须调它把正文读完**。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '组路径' },
          relation: { type: 'string', description: '文档名（不含 .md）' },
          scope: { type: 'string', description: '库名；缺省在当前范围内找' },
        },
        required: ['group', 'relation'],
      },
    },
  },
  ki_group_list: {
    type: 'function',
    function: {
      name: 'ki_group_list',
      description: '列出某库的 Group 树与其中的文档名，用于发现同主题的其他文档。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: '库名' },
          groups: { type: 'string', description: '只看某个组（可选）' },
          depth: { type: 'number', description: '展开层级，缺省 2' },
        },
      },
    },
  },
  ki_scope_list: {
    type: 'function',
    function: {
      name: 'ki_scope_list',
      description: '列出当前可用的知识库。',
      parameters: { type: 'object', properties: {} },
    },
  },
  ki_tag_list: {
    type: 'function',
    function: {
      name: 'ki_tag_list',
      description: '列出知识库里出现过的标签。',
      parameters: { type: 'object', properties: {} },
    },
  },
};

/** 供调用方按白名单取工具定义（顺序稳定，便于测试） */
export function toolDefsFor(tools: Record<string, boolean>): ToolDef[] {
  return Object.entries(tools)
    .filter(([, on]) => on === true)
    .map(([name]) => TOOL_DEFS[name])
    .filter((d): d is ToolDef => d !== undefined);
}

/** 输出格式说明：两条入口共用同一份 JSON 契约，故由内核统一追加 */
export const GROUNDED_OUTPUT_SPEC = [
  '## 输出格式（最后一条消息必须是这个 JSON，不要有别的文字）',
  '{"summary":"3 句以内：最该先读什么、为什么；没找到时说明查了什么",',
  ' "candidates":[{"scope":"库名","group":"组路径","name":"文档名","why":"它对这个任务的哪一部分有用"}],',
  ' "uncertainties":["我判断不了的点"],',
  ' "needMore":[{"field":"symptom|errorCode|module","hint":"要调用方补什么"}]}',
  '若一条候选都没有，candidates 给空数组，summary 必须说明查了什么、为什么没有。',
].join('\n');

// ─── 输出解析 ──────────────────────────────────────────

interface ParsedOutput {
  summary: string;
  candidates: Array<Record<string, unknown>>;
  uncertainties: string[];
  needMore: NeedMoreItem[];
}

/** 从模型输出里抠出 JSON：允许 ```json 围栏，也允许前后有解释文字 */
export function parseGroundedOutput(text: string): ParsedOutput | null {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const candidates = Array.isArray(obj.candidates)
    ? obj.candidates.filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && !Array.isArray(c))
    : [];
  const uncertainties = Array.isArray(obj.uncertainties)
    ? obj.uncertainties.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, 8)
    : [];
  const needMore: NeedMoreItem[] = [];
  if (Array.isArray(obj.needMore)) {
    for (const item of obj.needMore) {
      if (item === null || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const field = it.field;
      if (field !== 'symptom' && field !== 'errorCode' && field !== 'module') continue;
      const hint = typeof it.hint === 'string' ? it.hint.trim() : '';
      if (!hint) continue;
      needMore.push({ field, hint: hint.slice(0, 200) });
    }
  }
  return { summary, candidates, uncertainties, needMore: needMore.slice(0, 5) };
}

// ─── 主流程 ────────────────────────────────────────────

export async function runGroundedRecall(input: GroundedInput): Promise<GroundedResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const exclude = (input.exclude ?? []).map((e) => e.trim()).filter(Boolean);
  const excludeKeys = new Set(exclude.flatMap((e) => [e, e.includes('::') ? e.split('::').slice(1).join('::') : e]));

  /** 工具调用轨迹（顺序即发生顺序） */
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; ms: number; ok: boolean }> = [];
  /** 本次真正读到文档 / 检索模式足迹 */
  const sawSearchModes = new Set<'hybrid' | 'fulltext'>();
  const aggregatedMode = (): 'hybrid' | 'fulltext' | undefined => {
    if (sawSearchModes.size === 0) return undefined;
    // 只要有一轮走了语义就是 hybrid；全部降级才如实报 fulltext
    return sawSearchModes.has('hybrid') || !sawSearchModes.has('fulltext') ? 'hybrid' : 'fulltext';
  };
  /** 本次真正读到的文档：key = group\0name（`~` 前缀 = 只读到片段） */
  const readDocs = new Map<string, { scope: string; group: string; name: string; truncated: boolean }>();
  const messages: ChatTurn[] = [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: input.userMessage },
  ];

  const toolDefs = toolDefsFor(input.tools);
  let finalText = '';
  let rounds = 0;
  let timedOut = false;
  let stopReason: 'timeout' | 'budget' | undefined;
  /*
   * 工具调用预算：`undefined` = 不限制（**只有 `ki_recall` 会落到这一档** —— 预取不设上限；
   * 「AI 查找」的调用方 `deep-find-core` 恒传一个归一化过的整数，故查找永远有限）。
   * 归一化放在这里而不是调用方：入参可能来自手改文件或第三方调用方，非法值不能让内核崩。
   */
  const maxToolCalls = typeof input.maxToolCalls === 'number' && Number.isFinite(input.maxToolCalls) && input.maxToolCalls > 0
    ? Math.floor(input.maxToolCalls)
    : undefined;

  for (let round = 1; round <= input.maxRounds; round += 1) {
    /*
     * 轮首判配额（2026-11-19 review 抓到）：这里**必须**判，不能只靠"调用被拒时置位"。
     *   ① 配额在轮末**恰好用满**时没有任何一次调用被拒，stopReason 不会置位 ——
     *      少了这一判就会再发一整轮请求，既白烧一次模型调用，也让"已用满"丢了 budget 标记；
     *   ② 它同时兜住了"本轮有调用被拒"的情形，故轮末不需要再 break 一次（去掉更省心）。
     */
    if (maxToolCalls !== undefined && toolTrace.length >= maxToolCalls) {
      stopReason = 'budget';
      break;
    }
    rounds = round;
    let text = '';
    let calls: Array<{ id: string; name: string; arguments: string }> = [];
    try {
      const stream = input.stream(messages, {
        llm: input.llm,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for await (const part of stream) {
        if (part.type === 'content') text += part.text;
        else if (part.type === 'tool_calls') calls = part.calls;
      }
    } catch (err) {
      if (err instanceof Error && /abort|timeout|超时/i.test(err.message)) {
        timedOut = true;
        stopReason = 'timeout';
        finalText = text;
        break;
      }
      throw new RecallKernelError('ALL_TARGETS_FAILED', `模型调用失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (calls.length === 0) {
      finalText = text;
      break;
    }

    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of calls) {
      /*
       * 预算判断必须在**单次调用**这一层：一轮里模型可以并发发起多个调用，
       * 只在轮次层面判断会整轮超发（例：上限 2、一轮并发 3 个调用 → 实际执行 3 次）。
       * 每个被拒的调用都要回一条 tool 消息，否则模型会一直等它的结果。
       */
      if (maxToolCalls !== undefined && toolTrace.length >= maxToolCalls) {
        stopReason = 'budget';
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            error: `工具调用次数已达上限（${maxToolCalls} 次），不能再调用工具；请基于已读到的内容直接给出结论`,
          }),
          tool_call_id: call.id,
        });
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments || '{}');
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        messages.push({ role: 'tool', content: JSON.stringify({ error: '参数不是合法 JSON' }), tool_call_id: call.id });
        continue;
      }
      // 白名单校验：模型只能调配置里开启的工具
      if (input.tools[call.name] !== true) {
        messages.push({ role: 'tool', content: JSON.stringify({ error: `工具未启用：${call.name}` }), tool_call_id: call.id });
        continue;
      }
      const callStarted = now();
      let outcome: GroundedToolOutcome;
      if (!input.runTool) {
        outcome = { text: JSON.stringify({ error: '工具执行器未装配' }) };
      } else {
        try {
          outcome = await input.runTool(call.name, args);
        } catch (err) {
          outcome = { text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) };
        }
      }
      const traceItem = {
        name: call.name,
        args,
        ms: now() - callStarted,
        ok: !outcome.text.startsWith('{"error"'),
      };
      toolTrace.push(traceItem);
      if (outcome.searchMode) sawSearchModes.add(outcome.searchMode);
      try {
        input.onToolCall?.({ ...traceItem, round });
      } catch {
        /* 进度回调失败不能影响主流程 */
      }
      if (outcome.read && !outcome.read.truncated) {
        readDocs.set(`${outcome.read.group}\u0000${outcome.read.name}`, outcome.read);
      } else if (outcome.read) {
        readDocs.set(`~${outcome.read.group}\u0000${outcome.read.name}`, outcome.read);
      }
      messages.push({ role: 'tool', content: outcome.text, tool_call_id: call.id });
    }

  }

  /*
   * 收口轮（2026-11-18 真机首调暴露）：轮次用完时模型**还在调工具**是常态 ——
   * 直接退出会拿到空结论（实测 rounds=5、candidates=0）。因此额外补一次**不带工具**的请求，
   * 明确要求它把已有证据收敛成 JSON。
   *
   * 收口原因要如实说：次数用尽却告诉它"轮次已用完"，模型会以为还有轮次可用而重新规划。
   */
  if (!finalText.trim()) {
    const why = stopReason === 'budget'
      ? `工具调用次数已用完（上限 ${maxToolCalls ?? 0} 次），不能再调用任何工具`
      : stopReason === 'timeout'
        ? '本次查找已超时，不能再调用任何工具'
        : '轮次已用完，不能再调用任何工具';
    const closing: ChatTurn[] = [
      ...messages,
      {
        role: 'user',
        content: `${why}。请**现在**基于你已读到的内容输出最终 JSON：`
          + '{"summary":"…","candidates":[…],"uncertainties":[…],"needMore":[…]}。'
          + '没有候选就给空数组，并在 summary 里说明你查了什么、为什么没有。',
      },
    ];
    let closingText = '';
    try {
      const stream = input.stream(closing, {
        llm: input.llm,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for await (const part of stream) {
        if (part.type === 'content') closingText += part.text;
      }
    } catch {
      /* 收口失败：走下面的兜底文案，不因此整体报错（已有证据仍可返回） */
    }
    if (closingText.trim()) {
      finalText = closingText;
      rounds += 1;
    }
  }

  const parsed = parseGroundedOutput(finalText);
  if (!parsed) {
    return {
      summary: finalText.trim().slice(0, 600)
        || `模型在 ${rounds} 轮内未给出结论（可能轮次不够或输入过泛）；请补强线索或缩小范围后重试`,
      candidates: [],
      uncertainties: [],
      needMore: [],
      nextActions: [],
      dropped: 0,
      rounds,
      partial: true,
      ...(stopReason ? { stopReason } : {}),
      toolTrace,
      parsedOk: false,
      ...(aggregatedMode() ? { mode: aggregatedMode()! } : {}),
      durationMs: now() - started,
    };
  }

  // ── 校验：候选必须本次读过正文；只读到片段的降级为 snippet ──
  let dropped = 0;
  const full: RecallHit[] = [];
  const snippets: RecallHit[] = [];
  for (const raw of parsed.candidates) {
    const scope = typeof raw.scope === 'string' ? raw.scope.trim() : '';
    const group = typeof raw.group === 'string' ? raw.group.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const why = typeof raw.why === 'string' ? raw.why.trim().slice(0, 300) : '';
    if (!group || !name || !why) { dropped += 1; continue; }
    if (excludeKeys.has(`${group}::${name}`) || excludeKeys.has(`${scope}::${group}::${name}`)) { dropped += 1; continue; }
    const readFull = readDocs.get(`${group}\u0000${name}`);
    const readSnippet = readDocs.get(`~${group}\u0000${name}`);
    if (readFull) {
      full.push({ scope: readFull.scope || scope, group, name, why, evidence: 'full' });
      continue;
    }
    if (readSnippet) {
      snippets.push({ scope: readSnippet.scope || scope, group, name, why, evidence: 'snippet' });
      continue;
    }
    // 没读过 = 编造或凭标题猜
    dropped += 1;
  }

  // 有 full 就只留 full；否则最多 2 条 snippet（宁少勿滥）
  const candidates = full.length > 0
    ? full.slice(0, input.limit)
    : snippets.slice(0, Math.min(2, input.limit));
  const snippetOnly = full.length === 0 ? candidates.length : 0;

  const baseSummary = parsed.summary
    || (candidates.length > 0 ? '只给出候选，模型未给结论' : '本次没有找到值得先读的文档');
  /*
   * 一致性兜底（2026-11-19 真机）：实测出现过「candidates 为空、summary 却说该先读某篇」——
   * 那篇没进候选是因为正文没读全/被排除。这里如实补一句，避免调用方按结论去猜文档。
   */
  const droppedNote = candidates.length === 0 && dropped > 0
    ? `（另有 ${dropped} 篇被提及但未通过校验：正文未读全或与已读清单重复，故未列入候选）`
    : '';
  const summary = `${baseSummary}${droppedNote}`;

  return {
    summary: summary.slice(0, 600),
    candidates,
    uncertainties: parsed.uncertainties,
    needMore: parsed.needMore,
    nextActions: candidates.slice(0, 3).map((c) => ({
      tool: 'ki_get_module_info' as const,
      args: { scope: c.scope, group: c.group, relation: c.name, max_chars: 8000 },
      why: c.why,
    })),
    dropped,
    rounds,
    ...(timedOut || stopReason === 'budget' || snippetOnly > 0 ? { partial: true } : {}),
    ...(stopReason ? { stopReason } : {}),
    toolTrace,
    parsedOk: true,
    ...(aggregatedMode() ? { mode: aggregatedMode()! } : {}),
    durationMs: now() - started,
  };
}
