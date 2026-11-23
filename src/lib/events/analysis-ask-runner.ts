/**
 * analysis-ask-runner.ts —— 事件「追问这次分析」执行器（B2 → 2026-11-19 带工具再调查）
 *
 * ═══ 定位（2026-11-19 升级）═══
 * 从「对定稿结果答疑、不给工具」升级为「带只读工具再调查」：
 *   · 工具面 = 源码只读 `fs_*` + 知识库只读 `ki_*` 四件套（与分析同源，不含编排层工具）；
 *   · 上下文 = 事件摘要 + 结论 + 候选前 5 + 已确认前 5 + 最近 2 轮 + 已挂文档清单；
 *   · 轮次上限 5，达上限移除 tools 强制作答；每轮开头复查 runId（分析被重跑则终止）；
 *   · **取消硬预算**：兜底只留单轮请求超时（300s）+ 首字节超时（30s）；
 *   · 限流独立（6 次/60s·scope、并发 2），不再与 `ki_ask` 共享（见 ask-limiter followupLimiter）。
 *
 * 闸门顺序：事件存在 → 草稿存在 → 归一后是否 running → 问题长度 → 模型可用/已确认外发
 * → 追问限流/并发 → 组装上下文 → 工具循环 → 落库。
 */

import crypto from 'node:crypto';
import { loadConfig, runWithConfigSnapshot, type KiConfig } from '../config.js';
import {
  streamChat,
  resolveLlmStatus,
  type ChatTurn,
  type ToolDef,
  type LlmStatus,
} from '../chat/llm-client.js';
import { createAskLimiter } from '../chat/ask/ask-limiter.js';
import { ASK_TOOL_MAX_ROUNDS, ASK_QUESTION_MAX_CHARS } from '../chat/ask/ask-contract.js';
import {
  ANALYSIS_WRITE_TOOL_NAMES,
  defaultPromptConfig,
  readPromptConfig,
  resolveAnalysisTargetDir,
  type AnalysisConfig,
} from '../chat/prompt-config.js';
import { serializeToolResponse } from '../chat/retrieval/tool-response.js';
import { GovernanceError } from '../governance-errors.js';
import { inferAnalysisView, resolveKindLabel, viewProfile } from './analysis-view.js';
import { chainToLines } from './conclusion-chain.js';
import {
  isAnalysisActive,
  readNormalizedAnalysisDoc,
  buildKbReadToolEntries,
  buildKbWriteToolEntries,
  isAnalysisToolEnabled,
  ANALYSIS_TOOL_RESPONSE_CHARS,
  DSML_FORCE_ANSWER_SYSTEM,
} from './analysis-runner.js';
import {
  createFsToolEntries,
  validateTargetRootDir,
  type AnalysisToolEntry,
  type FsSandboxContext,
} from './analysis-fs-tools.js';
import { collectMembers } from './event-service.js';
import { readRefs } from './refs-store.js';
import { appendAskTurn, readAskDoc, startAskRunning, type AskRunningTracker } from './analysis-ask-store.js';
import { diffProposal, extractProposal, validateProposal, type ProposalDiff } from './analysis-ask-patch.js';
import type { AnalysisAskTurn, AskProposal, AskRunningStep, EventAnalysisAskDoc } from './types.js';

/** 单条回答上限（超长截断；模板已不再限制字数，硬上限即此值） */
export const ASK_ANSWER_MAX_CHARS = 4000;
/**
 * 追问上下文里结论区的**预算**。
 *
 * 2026-11-23 与 H10 同步提到 4000：结论本身可到 4000 字，若这里只喂 1200，
 * 模型看到的是被截断的结论 —— 而 S03 的"补丁覆盖结论"是在这个视图上生成的，
 * 一旦确认覆盖就会把没看到的尾巴删掉。宁可多喂几千字符（上下文上限 1000K）。
 */
const CONCLUSION_CHARS = 4000;
const CANDIDATES_USED = 5;
const CONFIRMED_USED = 5;
const HISTORY_TURNS = 2;
const HISTORY_Q_CHARS = 200;
const HISTORY_A_CHARS = 400;
const DESC_CHARS = 800;
const DOCS_MAX = 20;
const THINKING_EVENT_MAX = 500;
const ANALYSIS_REQUEST_TIMEOUT_MS = 300_000;

/**
 * 追问独立限流实例（2026-11-19 决策 B）：6 次/60s·scope、并发 2。
 * 与 `ki_ask` 的默认实例隔离 —— 带工具后单次重得多，共享会互相挤占。
 * 窗口计数不回滚、finally 必释放的语义由 createAskLimiter 保证。
 */
const followupLimiter = createAskLimiter({ rateMax: 6, concurrentMax: 2 });

// ─── 列表页标记用的进程内状态（2026-11-23 · 事件列表「追问中 / 追问完成」）───

/**
 * 正在追问的事件（内存 Map，**不碰磁盘**）。
 *
 * 与 `activeRuns`（分析）同构：`GET /governance/events/running` 4s 轮询读它，
 * 前端在列表行上打「追问中」浮标。之所以不扫磁盘的 `.ask.running.json`：
 * 那是给「切页回来接续」用的单事件快照，扫全库要 readdir + 逐文件读，
 * 而这里只需要一个 id 列表，内存即可、且与分析的标记同生命周期（重启即清）。
 */
const activeAsks = new Map<string, { startedAt: number }>();

/** 最近结束的追问（列表行「追问完成 / 追问失败」；上限裁剪，重启即清） */
export interface FinishedAsk {
  eventId: string;
  /** 成功时才有的那一轮 id —— 前端据此判断「是否已看过这条结果」 */
  turnId: string | null;
  status: 'ok' | 'failed';
  at: number;
}

const finishedAsks = new Map<string, FinishedAsk>();
const FINISHED_ASKS_MAX = 200;

function askKey(scope: string, eventId: string): string {
  return `${scope}\u0000${eventId}`;
}

/** 该 scope 下正在追问的事件 id 清单（供列表「追问中」标记） */
export function listActiveAskIds(scope: string): string[] {
  const prefix = `${scope}\u0000`;
  const ids: string[] = [];
  for (const key of activeAsks.keys()) {
    if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
  }
  return ids;
}

/** 该 scope 下最近结束的追问（供列表「追问完成 / 追问失败」徽标） */
export function listFinishedAsks(scope: string): FinishedAsk[] {
  const prefix = `${scope}\u0000`;
  const out: FinishedAsk[] = [];
  for (const key of finishedAsks.keys()) {
    if (key.startsWith(prefix)) out.push(finishedAsks.get(key)!);
  }
  return out;
}

/** 记一条结束态；超上限丢最早插入的（Map 迭代顺序 = 插入顺序） */
function rememberFinishedAsk(key: string, ask: FinishedAsk): void {
  finishedAsks.set(key, ask);
  while (finishedAsks.size > FINISHED_ASKS_MAX) {
    const oldest = finishedAsks.keys().next().value;
    if (oldest === undefined) break;
    finishedAsks.delete(oldest);
  }
}

/** 新一轮开跑：上一轮的「完成」徽标立刻作废（列表该显示「追问中」） */
function forgetFinishedAsk(key: string): void {
  finishedAsks.delete(key);
}

/** 供治理层传进来的最小事件形状 */
export interface AskTargetEvent {
  id: string;
  shortId?: number;
  title: string;
  description?: string | null;
  /**
   * 事件类型 id（2026-11-20）：只用于把结论链的措辞对齐到本次分析的视角 ——
   * 卡面写「差距与成因」、喂给模型写「根本原因」会让模型顺着错词答。
   * 缺省（旧调用方 / 测试）按原模板 `fault` 处理。
   */
  typeId?: string;
}

/**
 * SSE 转发给前端的过程步骤事件（追加事件，旧前端忽略）。
 *
 * 2026-11-19 步骤流：每类步骤一个稳定 `id`，`text` 为该步骤的**累积全文**（不是增量），
 * 前端按 id upsert 成步骤列表 —— 像 AI 分析过程区那样逐步增长、实时滚动。
 * 保留 tool/thinking 两种原子事件供只需要单次提示的消费者（本前端已改用 step）。
 */
export type AskStep = {
  id: string;
  kind: 'thinking' | 'tool' | 'answer';
  /** 步骤标题，如「第 1 轮 · 核查证据」「读取 fs_read」 */
  label: string;
  /** 累积文本（thinking 的思考正文 / tool 的结果摘要 / answer 的正文） */
  text: string;
  at: number;
};

export type AskProgressEvent =
  | { type: 'step'; step: AskStep }
  | { type: 'tool'; name: string; label: string }
  | { type: 'thinking'; text: string };

export interface AskEventAnalysisArgs {
  question: string;
  /** 限流主体：HTTP 层无身份，固定 'local' */
  principalKey?: string;
  /** 流式答案增量回调（只吐最终 answer 文本，不掺工具响应） */
  onDelta?: (text: string) => void;
  /** 进度事件回调（tool / thinking，只推不落盘） */
  onEvent?: (event: AskProgressEvent) => void;
  deps?: {
    loadConfigFn?: typeof loadConfig;
    resolveLlmStatusFn?: typeof resolveLlmStatus;
    streamChatFn?: typeof streamChat;
    nowFn?: () => number;
    /** 仅测试注入：模拟 KB 工具执行，不连真实向量库 */
    kbExecutor?: {
      getModuleInfo?: (args: { scope: string; group: string; relation: string; startLine?: number; startChar?: number; maxChars?: number }) => Promise<unknown>;
      search?: (args: { scope: string; query: string; mode: 'hybrid' | 'fulltext'; limit: number }) => Promise<unknown>;
    };
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface DocRef { group: string; name: string }

/** 把本次分析压成受字数上限约束的上下文（含已挂文档清单，不含正文/snippet） */
function buildContext(args: {
  event: AskTargetEvent;
  draft: NonNullable<ReturnType<typeof readNormalizedAnalysisDoc>['draft']>;
  confirmed: Array<{ file: string; line: number; why: string }>;
  history: AnalysisAskTurn[];
  attachedDocs: { members: DocRef[]; refs: DocRef[] };
}): {
  text: string;
  stats: {
    conclusionChars: number;
    candidatesUsed: number;
    confirmedUsed: number;
    historyUsed: number;
    attachedDocsUsed: { members: number; refs: number };
  };
} {
  const { event, draft, confirmed, history, attachedDocs } = args;
  /*
   * 结论区 = 一句话总结 + 因果链逐行（2026-11-19）。
   * 只喂 conclusion 会让追问丢掉全部细节 —— 分层后 conclusion 被收窄成一句总结，
   * 根因/影响/建议都在 chain 里，不带上的话模型答"为什么这么修"只能靠猜。
   * 二者共用 `conclusionChars` 预算（口径是"结论区总字数"）。
   */
  const conclusion = draft.conclusion ?? '';
  const chainLines = chainToLines(draft.chain ?? [], inferAnalysisView(event.typeId));
  const conclusionBody = [conclusion, ...chainLines].filter(Boolean).join('\n');
  const cands = draft.candidates.slice(0, CANDIDATES_USED);
  const locs = confirmed.slice(0, CONFIRMED_USED);
  const recent = history.slice(-HISTORY_TURNS);
  const members = attachedDocs.members.slice(0, DOCS_MAX);
  const refs = attachedDocs.refs.slice(0, DOCS_MAX);

  const lines: string[] = [
    `<event>`,
    `标题：${event.title}`,
    event.description?.trim() ? `描述：${clip(event.description.trim(), DESC_CHARS)}` : '描述：（空）',
    `</event>`,
  ];
  lines.push('<attached_docs>');
  lines.push('关联文档（仅路径/名称，可用 ki_get_module_info 读正文）：');
  lines.push(...(members.length ? members.map((d) => `- group: ${d.group} | name: ${d.name}`) : ['（无）']));
  lines.push('参考文档（同上）：');
  lines.push(...(refs.length ? refs.map((d) => `- group: ${d.group} | name: ${d.name}`) : ['（无）']));
  lines.push('</attached_docs>');
  if (conclusionBody) {
    lines.push('<conclusion>', clip(conclusionBody, CONCLUSION_CHARS), '</conclusion>');
  }
  if (cands.length) {
    lines.push('<candidates>');
    for (const c of cands) {
      lines.push(`- ${c.file}:${c.line}｜${clip(c.why, 200)}｜置信度 ${c.confidence}`);
    }
    lines.push('</candidates>');
  }
  if (locs.length) {
    lines.push('<confirmed>');
    for (const l of locs) lines.push(`- ${l.file}:${l.line}｜${clip(l.why, 200)}`);
    lines.push('</confirmed>');
  }
  if (recent.length) {
    lines.push('<history>');
    for (const t of recent) {
      lines.push(`问：${clip(t.question, HISTORY_Q_CHARS)}`);
      lines.push(`答：${clip(t.answer, HISTORY_A_CHARS)}`);
    }
    lines.push('</history>');
  }

  return {
    text: lines.join('\n'),
    stats: {
      conclusionChars: conclusionBody ? Math.min(conclusionBody.length, CONCLUSION_CHARS) : 0,
      candidatesUsed: cands.length,
      confirmedUsed: locs.length,
      historyUsed: recent.length,
      attachedDocsUsed: { members: members.length, refs: refs.length },
    },
  };
}

/** 解析本次追问可用的只读工具条目（源码 fs_* + 知识库 ki_*，复用分析的工厂） */
function buildAskToolEntries(
  scope: string,
  cfg: KiConfig,
  analysisCfg: AnalysisConfig,
  deps: AskEventAnalysisArgs['deps'],
  controller: AbortController,
): { entries: readonly AnalysisToolEntry[]; targetDir: string | null } {
  const rawTargetDir = resolveAnalysisTargetDir(analysisCfg.targetDirs, scope);
  let fsEntries: readonly AnalysisToolEntry[] = [];
  let targetDir: string | null = rawTargetDir;
  if (rawTargetDir) {
    const dirCheck = validateTargetRootDir(rawTargetDir);
    if (dirCheck.ok) {
      const fsCtx: FsSandboxContext = {
        rawRoot: rawTargetDir,
        realRoot: dirCheck.realRoot,
        filesRead: new Set(),
        signal: controller.signal,
      };
      fsEntries = createFsToolEntries(fsCtx);
    } else {
      targetDir = null;
    }
  }
  const kbEntries = buildKbReadToolEntries(scope, cfg, deps?.kbExecutor ? { kbExecutor: deps.kbExecutor } : undefined);
  // 写入组与分析共用同一份 `analysis.tools`（REQ-20261123-004 H4；与 REQ-20261123-002 REQ-06 一致）
  const writeEntries = buildKbWriteToolEntries(scope);
  const entries = [...fsEntries, ...kbEntries, ...writeEntries].filter(
    (e) => isAnalysisToolEnabled(analysisCfg, e.name),
  );
  return { entries, targetDir };
}

/**
 * 本轮补丁的对外视图（S03 §3.5）。
 *
 * `valid:false` 也要下发：前端要能告诉用户"AI 想改但建议不合规、原因是什么"，
 * 而不是假装没有建议（N14）。`diff`/`patch` 仅 `valid:true` 时存在。
 */
export interface AskProposalView {
  valid: boolean;
  reason?: string;
  reasons?: string[];
  diff?: ProposalDiff;
  patch?: AskProposal;
}

export async function askEventAnalysis(
  scope: string,
  event: AskTargetEvent,
  args: AskEventAnalysisArgs,
): Promise<{ turn: AnalysisAskTurn; doc: EventAnalysisAskDoc; proposal?: AskProposalView }> {
  const deps = args.deps;
  const now = (deps?.nowFn ?? (() => Date.now()))();
  const question = args.question.trim();

  // ① 草稿必须存在（未分析就没有可追问的上下文）
  const analysis = readNormalizedAnalysisDoc(scope, event.id);
  if (!analysis.draft) {
    throw new GovernanceError('ANALYSIS_DRAFT_NOT_FOUND', '这次事件还没有分析结果，无法追问');
  }
  const draftRunId = analysis.draft.runId;
  // ② 运行中不追问（归一后的 running 才算，僵尸 draft 视为已失败）
  if (analysis.draft.status === 'running' && isAnalysisActive(scope, event.id)) {
    throw new GovernanceError('ANALYSIS_ALREADY_RUNNING', '分析仍在进行中，等完成后可追问');
  }
  // ③ 问题长度
  if (!question) {
    throw new GovernanceError('ANALYSIS_ASK_QUESTION_TOO_LONG', '问题不能为空');
  }
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    throw new GovernanceError(
      'ANALYSIS_ASK_QUESTION_TOO_LONG',
      `问题过长（${question.length} 字），上限 ${ASK_QUESTION_MAX_CHARS} 字`,
      { limit: ASK_QUESTION_MAX_CHARS },
    );
  }

  // ④ 模型可用 + 已确认外发（与 AI 分析共用同一套闸门口径）
  const cfg = (deps?.loadConfigFn ?? loadConfig)();
  const llmStatus = (deps?.resolveLlmStatusFn ?? resolveLlmStatus)(cfg, cfg._configPath ?? '');
  if (llmStatus.ackRequired) {
    throw new GovernanceError('ANALYSIS_DISCLOSURE_REQUIRED', '尚未确认知识库内容外发给上游模型，请先完成隐私确认');
  }
  if (!llmStatus.enabled) {
    throw new GovernanceError('ANALYSIS_LLM_UNAVAILABLE', llmStatus.reason ?? '未配置 LLM 模型，无法追问');
  }

  // ⑤ 追问独立限流 + 并发（6 次/60s·scope、并发 2，不再与 ki_ask 共享）
  const principalKey = args.principalKey ?? 'local';
  const slot = followupLimiter.acquire(principalKey, scope);
  if (!slot.ok) {
    const rate = slot.code === 'ASK_RATE_LIMITED';
    throw new GovernanceError(
      rate ? 'ANALYSIS_FOLLOWUP_RATE_LIMITED' : 'ANALYSIS_FOLLOWUP_BUSY',
      rate
        ? `追问太频繁，请 ${slot.retryAfterSec}s 后再试`
        : `同时进行的追问过多，请 ${slot.retryAfterSec}s 后再试`,
      { retryAfterSec: slot.retryAfterSec },
    );
  }

  /*
   * 运行态（#82）：让「切页 / 刷新」回来的人还能看到这一轮在跑
   * （问题 + 已生成的半截 + 过程步骤）。首写同步、后续 800ms 节流；
   * 成功 / 失败 / 异常三条出口统一由 finally 删除。
   */
  let running: AskRunningTracker | null = null;
  const thisAskKey = askKey(scope, event.id);
  /** 本轮落库的 turn id（null = 没成功，finally 据此记「追问失败」） */
  let askTurnId: string | null = null;
  try {
    running = startAskRunning(scope, event.id, { question, runId: draftRunId });
    // 列表标记：这一轮开始 → 显示「追问中」，上一轮的「完成」徽标作废
    activeAsks.set(thisAskKey, { startedAt: now });
    forgetFinishedAsk(thisAskKey);
    const history = readAskDoc(scope, event.id).turns;
    const attachedDocs = {
      members: collectMembers(scope, event.id).map((m) => ({ group: m.group, name: m.name })),
      refs: readRefs(scope, event.id).map((r) => ({ group: r.group, name: r.name })),
    };
    const ctx = buildContext({ event, draft: analysis.draft, confirmed: analysis.confirmed, history, attachedDocs });

    // prompt-config 是可选文件（缺失即用默认值）；测试注入的最小 cfg 可能无 dataDir，
    // 此时路径解析会抛错 —— 按"从未配置过"回退默认值，与文件缺失同口径（fail-loud 只对非法内容）。
    let analysisCfg: AnalysisConfig;
    try {
      analysisCfg = readPromptConfig(cfg).config.analysis ?? defaultPromptConfig().analysis!;
    } catch {
      analysisCfg = defaultPromptConfig().analysis!;
    }

    const controller = new AbortController();
    const { entries, targetDir } = buildAskToolEntries(scope, cfg, analysisCfg, deps, controller);
    const toolDefs: ToolDef[] = entries.map((e) => e.def);
    const entryMap = new Map(entries.map((e) => [e.name, e] as const));

    /*
     * 补丁槽位必须**把可选值列给模型**：真机实测它会把 root 写成 `root_cause`，
     * 然后被模板校验整份拒掉（降级正确，但白跑一轮）。骨架按事件类型取，与校验同源。
     */
    const patchView = inferAnalysisView(event.typeId);
    const patchKinds = viewProfile(patchView).skeleton
      .map((k) => `${k}（${resolveKindLabel(patchView, k)}）`)
      .join(' / ');

    const systemContent = [
      '你是这次事件分析结果的答疑助手，可调用只读工具重新取证：',
      '先基于给定上下文判断；用户质疑结论或信息不足时，用工具查证（fs_* 读源码、ki_* 读知识库）。',
      targetDir ? '' : '（当前未配置源码目录，只有知识库工具可用；请改用 ki_* 查证。）',
      attachedDocs.refs.length || attachedDocs.members.length
        ? '已挂文档清单里的 group/name 可用 ki_get_module_info 读取正文。'
        : '本事件未挂文档；如需背景可用 ki_search 检索知识库。',
      ' 引用路径/行号必须来自本次工具返回或给定上下文，不得臆造；查不到就说明查了哪些方向。',
      ' 查证后用中文简洁作答；**正文里不要出现代码块**（唯一的例外是下面的补丁块）；不改文件、不执行系统命令、不调用编排类工具。',
      /*
       * 结论补丁（S03）：让模型在"结论该变"时给结构化建议，由服务端校验 + diff，
       * 前端弹框由用户决定是否覆盖。不输出这块也不会错 —— 只是这轮没有可采纳的建议。
       */
      ' 若这轮回答意味着**分析结论本身应当修改**，请在正文之后另起一行，输出且仅输出一个围栏块：',
      '```ki-conclusion-patch',
      '{"conclusion":"一句话总结","chain":[{"kind":"symptom","text":"节点文本"}],"reason":"一句话说明改了什么"}',
      '```',
      ` 补丁的硬要求：chain 的 kind **只能**取这几个值：${patchKinds}（不要自造 root_cause / fix_suggestion 之类的名字）；`,
      ' 最多 5 个节点、每节点不超过 200 字（分支 branches 只能挂 root）；',
      'conclusion 不能为空（不要用补丁把结论清空）；结论没有变化时**不要**输出该块。',
    ].join('');

    const messages: ChatTurn[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: `${ctx.text}\n\n<question>\n${question}\n</question>` },
    ];

    let answer = '';
    /** 本轮已生成正文（每轮开头清零；运行态与答案 flush 共用同一口径，见 syncRunning 注释） */
    let roundContent = '';
    let promptTokens = 0;
    let completionTokens = 0;
    const toolCallNames: string[] = [];
    let forceAnswerNext = false;
    const streamFn = deps?.streamChatFn ?? streamChat;

    /*
     * 步骤流（2026-11-19）：按 id upsert 累积文本后推给前端。
     * 关键：text 传**累积全文**而非增量 —— 前端用同 id 覆盖即可，无需自己拼接，
     * 也避免增量乱序/丢段导致步骤内容与最终答案对不上。
     */
    const stepText = new Map<string, string>();
    /** 运行态用的步骤快照：按 id upsert，Map 保留首次插入顺序（与前端渲染一致） */
    const stepMeta = new Map<string, AskRunningStep>();
    /**
     * 把「已落定的 answer + 本轮已生成正文」写进运行态。
     *
     * 口径必须**全处统一**：正文既可能在 content 增量里推进，也可能在轮末由 emitStep 推进；
     * 两处各写各的（一处带 roundContent、一处只写 answer）会互相清零 ——
     * 真机实测过：正文到 29 字后被同轮的 emitStep 覆盖成空。
     */
    const syncRunning = (): void => {
      running?.update({
        answer: (answer + roundContent).slice(0, ASK_ANSWER_MAX_CHARS),
        steps: [...stepMeta.values()],
      });
    };
    const emitStep = (id: string, kind: AskStep['kind'], label: string, delta: string): void => {
      const text = (stepText.get(id) ?? '') + delta;
      stepText.set(id, text);
      const step: AskStep = { id, kind, label, text, at: now };
      stepMeta.set(id, step);
      args.onEvent?.({ type: 'step', step });
      syncRunning();
    };

    for (let round = 0; round < ASK_TOOL_MAX_ROUNDS + 1; round += 1) {
      // 每轮开头复查 runId：分析已被重跑则终止，避免用新代码回答老结论
      const current = readNormalizedAnalysisDoc(scope, event.id);
      if (!current.draft || current.draft.runId !== draftRunId) {
        throw new GovernanceError('REVISION_CONFLICT', '分析已被重新运行，请基于新结果重新追问', { runId: draftRunId });
      }

      if (forceAnswerNext) {
        messages.push({ role: 'system', content: DSML_FORCE_ANSWER_SYSTEM });
      }

      let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
      roundContent = '';
      try {
        const stream = streamFn(messages, {
          tools: forceAnswerNext || toolDefs.length === 0 ? undefined : toolDefs,
          signal: controller.signal,
          requestTimeoutMs: cfg.llm?.requestTimeoutMs ?? ANALYSIS_REQUEST_TIMEOUT_MS,
          firstByteTimeoutMs: cfg.llm?.firstByteTimeoutMs ?? 30_000,
          idleTimeoutMs: cfg.llm?.idleTimeoutMs ?? 60_000,
          llm: {
            baseURL: cfg.llm?.baseURL ?? '',
            apiKey: cfg.llm?.apiKey ?? '',
            model: cfg.llm?.model ?? '',
            temperature: cfg.llm?.temperature,
            maxTokens: cfg.llm?.maxTokens,
          },
        });
        for await (const part of stream) {
          if (part.type === 'content') {
            // ★ 先只缓冲到本轮：中间轮的 content 常是"我先读一下…"这类过渡语，
            //   不是答案。只有确认本轮无 tool_calls（=最终作答轮）才 flush 到 answer/delta。
            //   这与 analysis-runner 的 finalText 口径一致，避免过渡语被当成答案套卡片。
            roundContent += part.text;
            /*
             * 运行态必须**逐段**跟（#82）：正文是在这里流式产生的，`answer` 只在轮末才累加，
             * 不在这里补一手的话，切页回来只能看到「过程步骤」而看不到那半截答案 ——
             * 那正是用户最想确认的东西。落定的 answer + 本轮已生成 = 当前可见全文。
             * 代价：中间轮的过渡语也会短暂出现在答案区，最终轮 flush 时被正式正文覆盖。
             */
            syncRunning();
          } else if (part.type === 'reasoning') {
            // 思考步骤按轮 upsert、累积文本（前端步骤流实时增长，不再被单行进度覆盖）
            emitStep(`r${round}-think`, 'thinking', `第 ${round + 1} 轮 · 思考`, part.text.slice(0, THINKING_EVENT_MAX));
          } else if (part.type === 'tool_calls') {
            pendingCalls = part.calls;
          } else if (part.type === 'usage') {
            promptTokens += part.promptTokens ?? 0;
            completionTokens += part.completionTokens ?? 0;
          }
        }
      } catch (err) {
        // 用户取消（未来 SSE abort）或单轮请求超时/上游异常：都退出循环，
        // 由下方按"有无内容"决定收口 —— 有内容保留（截断），无内容 → ANALYSIS_ASK_TIMEOUT。
        // 取消硬预算后不再有 setTimeout abort，但保留 abort 分支以防未来 SSE 取消。
        void err;
        // 异常轮：本轮已缓冲的正文按"最终作答"flush，避免丢内容
        if (roundContent) {
          // 先并入 answer 再清零：运行态口径恒为「answer + roundContent」，不会瞬时写进双倍正文
          const produced = roundContent;
          roundContent = '';
          answer += produced;
          args.onDelta?.(produced);
          emitStep('answer', 'answer', '作答', produced);
        }
        break;
      }

      if (pendingCalls.length === 0 || forceAnswerNext) {
        // 最终作答轮：flush 本轮正文到答案气泡 + 步骤流（只此一处，不重复）
        if (roundContent) {
          // 先并入 answer 再清零：运行态口径恒为「answer + roundContent」，不会瞬时写进双倍正文
          const produced = roundContent;
          roundContent = '';
          answer += produced;
          args.onDelta?.(produced);
          emitStep('answer', 'answer', '作答', produced);
        }
        break;
      }

      // 中间轮的过渡语（"我先读一下…"）只进步骤流作说明，不进答案气泡
      if (roundContent.trim()) {
        emitStep(`r${round}-note`, 'thinking', `第 ${round + 1} 轮 · 说明`, roundContent);
      }

      messages.push({
        role: 'assistant',
        content: roundContent,
        tool_calls: pendingCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of pendingCalls) {
        const entry = entryMap.get(call.name);
        let resultObj: Record<string, unknown>;
        if (!entry) {
          resultObj = { error: `工具 ${call.name} 未启用或不存在于本次追问工具白名单` };
        } else {
          let parsedArgs: Record<string, unknown> = {};
          let parseError = false;
          try {
            parsedArgs = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
          } catch {
            parseError = true;
          }
          if (parseError) {
            resultObj = { error: '工具参数不是合法 JSON' };
          } else {
            try {
              resultObj = await runWithConfigSnapshot(cfg, () => entry.run(parsedArgs));
            } catch (err) {
              resultObj = { error: (err as Error).message };
            }
          }
          if (!toolCallNames.includes(entry.name)) toolCallNames.push(entry.name);
          args.onEvent?.({ type: 'tool', name: entry.name, label: entry.name });
        }
        const serialized = serializeToolResponse(resultObj, ANALYSIS_TOOL_RESPONSE_CHARS);
        const stepId = `r${round}-tool-${call.id}`;
        // 写入类工具的结果不是"读到的内容"：摘要与包裹标签都要与读取区分（R7，追问侧同口径）
        const isWriteTool = ANALYSIS_WRITE_TOOL_NAMES.includes(call.name);
        // `ok === false` 也要算失败：批量写部分失败时只有 ok:false、没有 error 字段
        const resultSummary = typeof resultObj.error === 'string'
          ? `失败：${resultObj.error}`
          : resultObj.ok === false
            ? '失败：工具返回 ok:false'
            : call.name.startsWith('fs_')
              ? '已读取源码片段'
              : isWriteTool
                ? '已写入知识库'
                : '已读取知识库内容';
        emitStep(stepId, 'tool', `第 ${round + 1} 轮 · ${call.name}`, resultSummary);
        const tagWrap = call.name.startsWith('fs_') ? 'source_code' : isWriteTool ? 'kb_write_result' : 'kb_doc';
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `<${tagWrap}>\n${serialized.text}\n</${tagWrap}>`,
        });
      }

      // 下一轮即达上限 → 标记强制作答（下一轮开头注入 DSML 收口 system、移除 tools）
      if (round + 1 >= ASK_TOOL_MAX_ROUNDS) forceAnswerNext = true;
    }

    const text = answer.trim();
    if (!text) {
      throw new GovernanceError('ANALYSIS_ASK_TIMEOUT', '回答超时且未产生内容，请重试');
    }

    /*
     * 结论补丁（S03 §3.2~3.4）：剥块 → 模板校验 → 与当前草稿 diff。
     *
     * 三步里任何一步失败都只**降级**（记一条步骤说明），绝不让追问本身失败（N13）：
     * 用户问的是问题，补丁只是附带的建议。
     */
    const extracted = extractProposal(text);
    let proposalView: AskProposalView | undefined;
    if (extracted.patch) {
      // 与提示词同源：同一个视角算出来的骨架，避免"提示说能写、校验说不能"
      const reasons = validateProposal(extracted.patch, patchView);
      if (reasons.length > 0) {
        // N14/N20：整份判不合规并说明原因，不做"删掉不合规节点后照用"的静默裁剪
        emitStep('proposal', 'thinking', '结论补丁', `AI 建议不合规，已忽略：${reasons[0]}`);
        proposalView = { valid: false, reason: reasons[0]!, reasons };
      } else {
        const diff = diffProposal(
          { conclusion: analysis.draft?.conclusion ?? null, chain: analysis.draft?.chain ?? [] },
          extracted.patch,
        );
        if (diff.changed) {
          proposalView = { valid: true, diff, patch: extracted.patch };
        } else {
          // N16：与当前一致就不打扰
          emitStep('proposal', 'thinking', '结论补丁', 'AI 的结论与当前一致，无需覆盖');
        }
      }
    } else if (extracted.error) {
      emitStep('proposal', 'thinking', '结论补丁', `未采用建议：${extracted.error}`);
    }

    const toolCalls = toolCallNames.map((name) => ({ name, at: now }));
    const turn: AnalysisAskTurn = {
      id: `ask_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      question,
      /*
       * 正文用**剥掉补丁块**的版本：用户不该看到一坨 JSON。
       * ⚠️ 不能写成 `extracted.answer || text` —— 若补丁是全文唯一内容，剥离后为空，
       * 那个 `||` 会把**含 JSON 的原文**塞回正文（真机踩过这个坑）。
       */
      answer: (
        ((extracted.patch || extracted.error) ? extracted.answer : text).slice(0, ASK_ANSWER_MAX_CHARS)
        || '（本轮只给出了结论建议，没有文字说明）'
      ),
      runId: draftRunId,
      at: now,
      usage: { promptTokens, completionTokens },
      toolCalls,
      context: ctx.stats,
      // 只落**有效且确有差异**的补丁；不合规/无差异的不进记录（避免回看时误以为"当时建议过"）
      ...(proposalView?.valid && proposalView.patch
        ? { proposal: { ...proposalView.patch, at: now } }
        : {}),
    };
    const saved = await appendAskTurn(scope, event.id, turn);
    askTurnId = turn.id;
    return { turn, doc: saved.doc, ...(proposalView ? { proposal: proposalView } : {}) };
  } finally {
    // 运行态必须删：留着会让「切页回来」的人永远看到「正在追问」（成功 / 失败 / 异常同待遇）
    running?.stop();
    /*
     * 列表标记收口：撤掉「追问中」，记一条结束态。
     * `askTurnId` 为空 = 这一轮没落库（超时 / 上游异常 / 闸门内报错）→ 记 failed，
     * 让列表行能提示「追问失败」，而不是静默消失。
     */
    activeAsks.delete(thisAskKey);
    rememberFinishedAsk(thisAskKey, {
      eventId: event.id,
      turnId: askTurnId,
      status: askTurnId ? 'ok' : 'failed',
      at: Date.now(),
    });
    // 所有出口都必须释放追问限流的并发槽，否则计数泄漏、后续追问全被判 BUSY
    followupLimiter.release();
  }
}
