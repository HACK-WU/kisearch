/**
 * analysis-store.ts —— 事件源码分析存储（REQ-20261113-003 · S-03）
 *
 * 落点：`{scope}/.events/{eventId}.analysis.json`
 *
 * ═══ 关键不变量 ═══
 * 1. **分文件独立存储**：不写入 `{eventId}.json`，避免后台异步分析与流转/改描述并发覆盖。
 * 2. **不占 KB scope 写锁**：锁键使用 `\0analysis:<hash>`（独立于 `<scope>` 锁），
 *    因此分析任务读写草稿绝不阻塞同 scope 知识库导入/写入（Q6 拍板）。
 * 3. **局部更新 + `runId` 守卫**：后台进度与终态写盘前必须在短锁内重读磁盘并校验
 *    `doc.draft?.runId === runId`，且只更新 `draft`，原样保留并发写入的 `confirmed[]`。
 * 4. **重启僵尸恢复**：携带当前进程 `CURRENT_BOOT_ID`，读取时若发现 `running` 任务
 *    不属当前活跃集合且跨进程或超 120s，立即归一为 `failed (INTERRUPTED)` 允许重跑。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findEventIn, getEventsDir, readAllEvents } from './store.js';
import { readJson } from '../store.js';
import { walWrite } from '../wal.js';
import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import { normalizeChain, pruneChainRefs } from './conclusion-chain.js';
import { normalizeDataFlow } from './data-flow.js';
import {
  hasEditFields,
  validateDraftEdit,
  validateExternalImport,
  type ManualLocationInput,
} from './analysis-edit.js';
import { resolveAnalysisTargetDir, readPromptConfig, defaultPromptConfig } from '../chat/prompt-config.js';
import { loadConfig } from '../config.js';
import { validateTargetRootDir, verifyCandidateLocation } from './analysis-fs-tools.js';
import type {
  AnalysisCandidate,
  AnalysisDraft,
  ConfirmedCodeLocation,
  EventAnalysisDoc,
} from './types.js';

export const CURRENT_BOOT_ID = crypto.randomUUID();
const ZOMBIE_TIMEOUT_MS = 120_000;

export function getAnalysisPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.analysis.json`);
}

function analysisLockKey(scope: string, eventId: string): string {
  const hash = crypto.createHash('sha256').update(`${scope}\0${eventId}`).digest('hex').slice(0, 24);
  return `\u0000analysis:${hash}`;
}

export async function withAnalysisLock<T>(scope: string, eventId: string, operation: string, fn: () => Promise<T>): Promise<T> {
  return withScopeWriteLock(analysisLockKey(scope, eventId), operation, fn);
}

function emptyDoc(eventId: string): EventAnalysisDoc {
  return { version: 1, eventId, draft: null, confirmed: [], updatedAt: 0 };
}

export function readAnalysisDocRaw(scope: string, eventId: string): EventAnalysisDoc {
  try {
    const raw = readJson<EventAnalysisDoc>(getAnalysisPath(scope, eventId));
    if (!raw || typeof raw !== 'object') return emptyDoc(eventId);
    return {
      version: 1,
      eventId,
      draft: raw.draft && typeof raw.draft === 'object' ? raw.draft : null,
      confirmed: Array.isArray(raw.confirmed) ? raw.confirmed : [],
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch (err) {
    console.warn(`[analysis] 分析文件损坏，按空处理（${eventId}）：${(err as Error).message}`);
    return emptyDoc(eventId);
  }
}

export function normalizeAnalysisDocForRead(
  doc: EventAnalysisDoc,
  isActive: boolean,
  now = Date.now(),
): EventAnalysisDoc {
  const d = doc.draft;
  if (!d) return doc;
  /*
   * 字段归一必须在下面那句早退**之前**（历史文件 ready/partial 100% 走早退，
   * 插在僵尸分支里等于只修了 running 的文件）；但**不能 return** ——
   * 否则僵尸 running 的恢复逻辑会被跳过（曾因此让「跨进程僵尸态」测试变红）。
   */
  const rawChain = (d as { chain?: unknown }).chain;
  const chain = normalizeChain(rawChain);
  const conclusionOk = typeof (d as { conclusion?: unknown }).conclusion === 'string';
  /*
   * 历史文件兼容（2026-11-19 引入 chain）：
   * - 旧文件没有 `chain` → 归一为 `[]`，前端回退渲染 `conclusion` 纯文本；
   * - `chain` 是数组但含非法项 → 重新归一（长度变化即判定需要替换）。
   * 两者都"没有变化"时保留原对象引用，避免每次读盘都造新对象
   * （下游有 `normalized === d` 的早退判断，破坏它等于让所有读取都走慢路径）。
   */
  const chainOk = Array.isArray(rawChain) && chain.length === rawChain.length;
  /*
   * `editedAt`（2026-11-23 · 人工校正）同样是历史兼容点：旧文件没有该字段；
   * 非数字（字符串时间戳 / 损坏值）一律视为"没被人工改过"，
   * 否则前端会拿一个垃圾值当徽标开关。
   */
  const rawEditedAt = (d as { editedAt?: unknown }).editedAt;
  const editedAtOk = rawEditedAt === undefined
    || (typeof rawEditedAt === 'number' && Number.isFinite(rawEditedAt));
  /*
   * 数据链路（2026-11-24 · REQ-20261124-001）：与 `chain` 同为历史兼容点，但判据**必须分两支** ——
   * `normalizeDataFlow` 对「非字符串」与「空串/全空白」都返回 undefined，单写 `flow === rawFlow`
   * 会把 `dataFlow: 123` 误判为「无变化」，脏值原样留给前端（React 渲染对象会直接抛
   * `Objects are not valid as a React child`）。
   */
  const rawFlow = (d as { dataFlow?: unknown }).dataFlow;
  const flow = normalizeDataFlow(rawFlow);
  const flowOk = flow === undefined ? rawFlow === undefined : flow === rawFlow;
  const normalized = conclusionOk && chainOk && editedAtOk && flowOk
    ? d
    : {
      ...d,
      conclusion: conclusionOk ? d.conclusion : null,
      chain: chainOk ? d.chain : chain,
      ...(editedAtOk ? {} : { editedAt: undefined }),
      // 写成 undefined 而不是删键：JSON.stringify 落盘时同样会丢掉该键，内存里也不会泄露脏值
      ...(flowOk ? {} : flow === undefined ? { dataFlow: undefined } : { dataFlow: flow }),
    };
  const withNormalized = (draft: typeof d) => (normalized === d ? doc : { ...doc, draft });

  if (normalized.status !== 'running' || isActive) return withNormalized(normalized);
  const staleProcess = normalized.bootId !== undefined && normalized.bootId !== CURRENT_BOOT_ID;
  const timedOut = now - (normalized.updatedAt || normalized.startedAt) > ZOMBIE_TIMEOUT_MS;
  if (!staleProcess && !timedOut) return withNormalized(normalized);
  return {
    ...doc,
    draft: {
      ...normalized,
      status: 'failed',
      errorCode: 'ANALYSIS_INTERRUPTED',
      errorMessage: '服务已重启或分析任务意外中断，请重新发起分析',
      /*
       * 僵尸态也是"分析已经死了"：不清实时思考的话，前端会拿一个永远转圈的
       * 「思考中」展示一段再也不会增长的文本（2026-11-18 增量落盘引入）。
       * 已完成的轮次仍在 steps 里，信息不丢。
       */
      liveThinking: undefined,
    },
  };
}

function writeAnalysisDoc(scope: string, doc: EventAnalysisDoc): void {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  walWrite(getAnalysisPath(scope, doc.eventId), doc as unknown as Record<string, unknown>);
}

/** 启动分析前在短锁内写入 `running` 草稿（保留已有 `confirmed[]`） */
export async function writeDraftStart(
  scope: string,
  eventId: string,
  draft: AnalysisDraft,
): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-start', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: { ...draft, bootId: CURRENT_BOOT_ID },
      confirmed: cur.confirmed,
      updatedAt: draft.startedAt,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/** 后台更新草稿进度或终态：仅当磁盘 `draft.runId` 匹配时更新 `draft`，绝不覆盖并发 `confirmed[]` */
export async function updateDraftIfMatch(
  scope: string,
  eventId: string,
  runId: string,
  updater: (current: AnalysisDraft) => AnalysisDraft,
): Promise<EventAnalysisDoc | null> {
  return withAnalysisLock(scope, eventId, 'analysis-update', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    if (!cur.draft || cur.draft.runId !== runId) return null;
    const updatedDraft = updater(cur.draft);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: updatedDraft,
      confirmed: cur.confirmed,
      updatedAt: updatedDraft.updatedAt,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/** 勾选确认候选写入 `confirmed`（带 `expectedRunId` 防双标签重跑错绑，按 `file+line` 去重） */
export async function confirmDraftLocations(
  scope: string,
  eventId: string,
  args: { candidateIds: string[]; expectedRunId?: string; discardDraft?: boolean },
  now = Date.now(),
): Promise<{ added: number; doc: EventAnalysisDoc }> {
  return withAnalysisLock(scope, eventId, 'analysis-confirm', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    if (!cur.draft) {
      throw new GovernanceError('ANALYSIS_DRAFT_NOT_FOUND', '当前没有可确认的分析草稿');
    }
    if (args.expectedRunId && cur.draft.runId !== args.expectedRunId) {
      throw new GovernanceError('REVISION_CONFLICT', '分析草稿已被新一轮分析更新，请刷新后重新确认');
    }
    const wanted = new Set(args.candidateIds);
    const existingKeys = new Set(cur.confirmed.map((c) => `${c.file}\0${c.line}`));
    const additions: ConfirmedCodeLocation[] = [];

    for (const cand of cur.draft.candidates) {
      if (!wanted.has(cand.id)) continue;
      const key = `${cand.file}\0${cand.line}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      additions.push({
        id: `loc_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        file: cand.file,
        line: cand.line,
        ...(cand.endLine !== undefined ? { endLine: cand.endLine } : {}),
        snippet: cand.snippet,
        why: cand.why,
        confidence: cand.confidence,
        targetDir: cur.draft.targetDir,
        commit: cur.draft.commit,
        confirmedAt: now,
      });
    }

    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: args.discardDraft ? null : cur.draft,
      confirmed: [...cur.confirmed, ...additions],
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return { added: additions.length, doc: next };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 人工校正（2026-11-23 · REQ-20261123-001）
 *
 * 三条不变量（设计 S01 §3.3，改这里前先读）：
 *   1. **空 patch 不写盘**：六项输入全缺省 → 直接返回，`editedAt` 不变
 *      （否则"点开保存没改东西"也会把卡片标成「已人工修订」）；
 *   2. **清空不置 null**：三块都空是合法终态，`draft` 必须保留 —— 前端靠它区分
 *      「AI 没找到」与「已人工清空」，且整卡渲染门槛依赖 draft 非空；
 *   3. **每次有效写盘必设 `editedAt`**：重跑会重建 draft，从而自然清掉该字段。
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SaveDraftEditsArgs {
  /** 并发闸门：`undefined` 不校验；`null` 期望当前无草稿；字符串须等于当前 `draft.runId` */
  expectedRunId?: string | null;
  /** 以下均为**未校验**的原始输入；未提供的块保持原值 */
  conclusion?: string | null;
  chain?: unknown;
  unconfirmed?: unknown;
  confirmedAdd?: unknown;
  confirmedUpdate?: unknown;
  /** 数据链路（2026-11-24 · S03 §3.2）：只供补丁采纳；省略 = 不动链路，`null`/全空白 = 清空 */
  dataFlow?: string | null;
}

function assertRunIdMatch(current: string | null, expected: string | null | undefined): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (current !== null) {
      throw new GovernanceError(
        'REVISION_CONFLICT',
        '当前已有分析草稿（另一个标签页可能刚跑过分析）：请刷新后重新编辑',
        { runId: current },
      );
    }
    return;
  }
  if (current !== expected) {
    throw new GovernanceError(
      'REVISION_CONFLICT',
      '这次分析已被新一轮分析替换：你的修改仍在编辑器里，可复制后重试',
      { runId: current },
    );
  }
}

/**
 * 人工位置验真所需的代码根目录。
 *
 * **不依赖草稿**：重置分析后 `draft` 为空，但用户仍要能手工补位置（R-03）。
 * 目录只从配置解析 —— 与 `startEventAnalysis` 同一真源（`resolveAnalysisTargetDir`）。
 */
function resolveEditableTargetRoot(scope: string, cfg = loadConfig()): string {
  const promptCfg = readPromptConfig(cfg).config;
  const analysisCfg = promptCfg.analysis ?? defaultPromptConfig().analysis!;
  const configured = resolveAnalysisTargetDir(analysisCfg.targetDirs, scope);
  if (!configured) {
    throw new GovernanceError(
      'ANALYSIS_TARGET_NOT_CONFIGURED',
      `未配置 scope「${scope}」或默认的代码目录，请先到「AI 设置 → AI 分析 → 代码目录」配置`,
      { scope },
    );
  }
  const dirCheck = validateTargetRootDir(configured);
  if (!dirCheck.ok) {
    throw new GovernanceError('ANALYSIS_TARGET_UNREADABLE', dirCheck.error, { targetDir: configured });
  }
  return dirCheck.realRoot;
}

async function buildManualLocations(
  realRoot: string,
  adds: readonly ManualLocationInput[],
  commit: string | null,
  now: number,
): Promise<ConfirmedCodeLocation[]> {
  const out: ConfirmedCodeLocation[] = [];
  for (const add of adds) {
    const verified = await verifyCandidateLocation(realRoot, add.file, add.line, add.endLine);
    if (!verified.ok) {
      throw new GovernanceError(
        'ANALYSIS_LOCATION_VERIFY_FAILED',
        `${add.file}:${add.line} 验真失败：${verified.reason}`,
        { file: add.file, line: add.line, reason: verified.reason },
      );
    }
    out.push({
      id: `loc_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      file: verified.file,
      line: verified.line,
      ...(verified.endLine !== undefined ? { endLine: verified.endLine } : {}),
      snippet: verified.realSnippet,
      why: add.why,
      /*
       * `0` 的语义是"非 AI 判定"，不是"AI 置信度 0"——两者在数据层不可区分，
       * 因此**不靠数值区分**：前端 `CodeLocRow` 见 0 时打「人工」标记。
       */
      confidence: 0,
      targetDir: realRoot,
      commit,
      confirmedAt: now,
    });
  }
  return out;
}

/** 无草稿时保存 → 新建一份"人工草稿"（Q1 已拍板允许） */
function buildManualDraft(realRoot: string, now: number): AnalysisDraft {
  return {
    runId: `manual_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    status: 'ready',
    targetDir: realRoot,
    commit: null,
    conclusion: null,
    chain: [],
    candidates: [],
    unconfirmed: [],
    steps: [],
    stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: now,
    updatedAt: now,
    editedAt: now,
  };
}

function mergeConfirmed(
  existing: ConfirmedCodeLocation[],
  additions: ConfirmedCodeLocation[],
  updates: ReadonlyArray<{ id: string; why: string }>,
): ConfirmedCodeLocation[] {
  const seen = new Set(existing.map((c) => `${c.file}\u0000${c.line}`));
  const added: ConfirmedCodeLocation[] = [];
  for (const loc of additions) {
    const key = `${loc.file}\u0000${loc.line}`;
    // 同一位置重复添加是幂等操作（用户可能连点两次），静默跳过而不是报错
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(loc);
  }
  let merged = [...existing, ...added];
  if (updates.length === 0) return merged;
  const byId = new Map(merged.map((c) => [c.id, c] as const));
  for (const upd of updates) {
    const hit = byId.get(upd.id);
    if (!hit) {
      throw new GovernanceError('ANALYSIS_LOCATION_NOT_FOUND', `代码位置「${upd.id}」不存在`);
    }
    byId.set(upd.id, { ...hit, why: upd.why });
  }
  merged = merged.map((c) => byId.get(c.id) ?? c);
  return merged;
}

/**
 * 三块产物的人工校正写入口（唯一）。
 *
 * 顺序上**验真在锁外、锁内二次校验**：验真要读真实文件（几十 ms），持锁会阻塞
 * 同事件的后台分析写盘与 confirm（设计 D7）。锁内重读是必须的——锁外到锁内之间
 * 可能被另一轮分析整份替换。
 */
export async function saveDraftEdits(
  scope: string,
  eventId: string,
  args: SaveDraftEditsArgs,
  now = Date.now(),
  deps?: { loadConfigFn?: () => ReturnType<typeof loadConfig> },
): Promise<EventAnalysisDoc> {
  // 不变量 1：空 patch 不写盘
  if (!hasEditFields(args)) return readAnalysisDocRaw(scope, eventId);

  const before = readAnalysisDocRaw(scope, eventId);
  if (before.draft?.status === 'running') {
    throw new GovernanceError('ANALYSIS_ALREADY_RUNNING', '分析仍在进行中：请先「停止」或等待完成，再修改结论');
  }
  assertRunIdMatch(before.draft?.runId ?? null, args.expectedRunId);

  const { errors, value } = validateDraftEdit(args);
  if (errors.length > 0) {
    throw new GovernanceError('ANALYSIS_EDIT_INVALID', errors[0]!.reason, { errors });
  }

  // 需要代码目录的两种情况：有手工位置，或要新建草稿（draft.targetDir 是必填）
  const needRoot = (value.confirmedAdd?.length ?? 0) > 0 || !before.draft;
  const realRoot = needRoot ? resolveEditableTargetRoot(scope, deps?.loadConfigFn?.()) : null;
  const additions = realRoot && value.confirmedAdd?.length
    ? await buildManualLocations(realRoot, value.confirmedAdd, before.draft?.commit ?? null, now)
    : [];

  return withAnalysisLock(scope, eventId, 'analysis-save-edits', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    if (cur.draft?.status === 'running') {
      throw new GovernanceError('ANALYSIS_ALREADY_RUNNING', '分析仍在进行中：请先「停止」或等待完成，再修改结论');
    }
    assertRunIdMatch(cur.draft?.runId ?? null, args.expectedRunId);

    /*
     * `realRoot` 是**锁外**按"当时有没有草稿"决定的；锁内可能已被「重置分析」清掉，
     * 这时 `realRoot` 为 null。若直接 `buildManualDraft(realRoot!)` 写入，`!` 只是
     * 骗过类型，`targetDir` 会真的变成 null，后续验真与前端展示全错 —— 必须在此**重新
     * 解析一次**（读配置是同步小开销，可接受）。
     */
    const base = cur.draft ?? buildManualDraft(
      realRoot ?? resolveEditableTargetRoot(scope, deps?.loadConfigFn?.()),
      now,
    );
    const nextDraft: AnalysisDraft = {
      ...base,
      ...(value.conclusion !== undefined ? { conclusion: value.conclusion } : {}),
      ...(value.chain !== undefined ? { chain: value.chain } : {}),
      ...(value.unconfirmed !== undefined ? { unconfirmed: value.unconfirmed } : {}),
      /*
       * 数据链路：`undefined` = 未提供 ⇒ 保留原值；`null` = 显式清空 ⇒ 写成 `undefined`
       * （`walWrite` 走 JSON.stringify，该键会被丢掉，与读侧的 `normalizeDataFlow` 口径一致）。
       * 不能写 `null`：契约是 `dataFlow?: string`，前端遇到 null 会当成"有链路"渲染空块。
       */
      ...(value.dataFlow !== undefined ? { dataFlow: value.dataFlow ?? undefined } : {}),
      // 不变量 3：有效写盘必设 editedAt；清空 liveThinking 避免留下永不结束的"思考中"
      editedAt: now,
      updatedAt: now,
      liveThinking: undefined,
    };
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: nextDraft,
      confirmed: mergeConfirmed(cur.confirmed, additions, value.confirmedUpdate ?? []),
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 外部结论上传（2026-11-23 · REQ-20261123-009 · S-01）
 *
 * 与 `saveDraftEdits` 的分工：那边是**人工校正**（必打 `editedAt`），这边是
 * **外部来源写入**（打 `source` / `importedAt`，**不打** `editedAt`）。刻意分成
 * 两个函数而不是加参数：`buildManualDraft` 必设 `editedAt`、`expectedRunId: null`
 * 的语义是「期望没有草稿」，与「允许覆盖外部草稿」直接冲突，塞在一起两条语义会互相污染。
 *
 * 顺序：**验真在锁外、锁内二次校验**（同 `saveDraftEdits`）——验真要读真实文件，
 * 持锁会阻塞同事件的后台分析写盘与 confirm。
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ExternalAnalysisInput {
  conclusion?: string | null;
  chain?: unknown;
  candidates: unknown;
  unconfirmed?: unknown;
  /**
   * 数据链路（2026-11-24 · S03 §3.3）：**整篇覆盖语义** —— 不传 = 这份结论明确没有链路，
   * 覆盖后原值随之消失。与追问补丁的「不传即保留」正相反，别照抄那一边的判据。
   */
  dataFlow?: string;
  /** 传入时必须等于配置解析出的分析根目录（两个基准会让 ref 解析漂移） */
  targetDir?: string;
  commit?: string | null;
  /** 覆盖已有【非外部】结论必须显式 true；**不豁免** expectedRunId */
  overwrite?: boolean;
  /** 允许剔除验真失败的候选（默认 false = 整批失败） */
  skipInvalidCandidates?: boolean;
  expectedRunId?: string | null;
  sourceClient?: string;
}

export interface ExternalAnalysisOutcome {
  doc: EventAnalysisDoc;
  /** 被剔除的无效候选；仅 skipInvalidCandidates 时可能非空 */
  dropped: Array<{ file: string; line: number; reason: string }>;
  /** 是否覆盖了已有草稿 */
  overwritten: boolean;
  /** 本次上传**直接生效**的候选位置数（已写入 `confirmed[]`，无需人工确认） */
  autoConfirmed: number;
}

/** 上传闸门：运行中 / 期望 runId / 覆盖权限。锁外与锁内各判一次，规则必须完全一致 */
function assertExternalImportGate(doc: EventAnalysisDoc, input: ExternalAnalysisInput): void {
  if (doc.draft?.status === 'running') {
    throw new GovernanceError(
      'ANALYSIS_ALREADY_RUNNING',
      '分析仍在进行中：请先「停止」或等待完成，再上传结论',
      { runId: doc.draft.runId },
    );
  }
  assertRunIdMatch(doc.draft?.runId ?? null, input.expectedRunId);
  if (doc.draft && doc.draft.source !== 'external' && input.overwrite !== true) {
    throw new GovernanceError(
      'ANALYSIS_DRAFT_EXISTS',
      '当前已有 AI 分析结论：覆盖它需要显式 overwrite=true（覆盖后原结论不可恢复）',
      { currentRunId: doc.draft.runId, source: doc.draft.source ?? 'ai' },
    );
  }
}

/** `targetDir` 只接受与配置根等价的路径（realpath 后比较，防符号链接绕过） */
function assertTargetDirMatchesRoot(configRoot: string, requested: string): void {
  const norm = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  if (norm(requested) !== norm(configRoot)) {
    throw new GovernanceError(
      'ANALYSIS_TARGET_OUT_OF_ROOT',
      `targetDir 必须是分析配置根目录「${configRoot}」，收到「${requested}」`,
      { configRoot, targetDir: requested },
    );
  }
}

/**
 * 写入一份外部上传的分析结论。
 *
 * 产出形状与 `buildManualDraft` 同族（无分析过程：`steps: []`、`stats` 全 0），
 * 差别只有三处：`runId` 前缀 `ext_`、带 `source/importedAt/sourceClient`、**不设 `editedAt`**。
 */
export async function saveExternalAnalysis(
  scope: string,
  eventId: string,
  input: ExternalAnalysisInput,
  now = Date.now(),
  deps?: { loadConfigFn?: () => ReturnType<typeof loadConfig> },
): Promise<ExternalAnalysisOutcome> {
  /*
   * 事件必须存在：分析产物是**独立文件**，不校验的话外部传一个错的 eventId 也能落盘，
   * 结果是一个永远没人打开、也不会随事件删除清理的孤儿文件（S-01 §6）。
   */
  if (!findEventIn(readAllEvents(scope), eventId)) {
    throw new GovernanceError('EVENT_NOT_FOUND', `事件「${eventId}」不存在`);
  }

  const before = readAnalysisDocRaw(scope, eventId);
  assertExternalImportGate(before, input);

  const { errors, value } = validateExternalImport({
    ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
    ...(input.chain !== undefined ? { chain: input.chain } : {}),
    candidates: input.candidates,
    ...(input.unconfirmed !== undefined ? { unconfirmed: input.unconfirmed } : {}),
    ...(input.dataFlow !== undefined ? { dataFlow: input.dataFlow } : {}),
  });
  if (errors.length > 0) {
    throw new GovernanceError('ANALYSIS_EDIT_INVALID', errors[0]!.reason, { errors });
  }

  const configRoot = resolveEditableTargetRoot(scope, deps?.loadConfigFn?.());
  if (input.targetDir !== undefined && input.targetDir !== null) {
    assertTargetDirMatchesRoot(configRoot, input.targetDir);
  }

  /* 验真：默认整批失败（fail-loud）；允许剔除时逐条记录原因 */
  const dropped: ExternalAnalysisOutcome['dropped'] = [];
  const candidates: AnalysisCandidate[] = [];
  for (const [index, cand] of value.candidates.entries()) {
    const verified = await verifyCandidateLocation(configRoot, cand.file, cand.line, cand.endLine);
    if (!verified.ok) {
      if (input.skipInvalidCandidates === true) {
        dropped.push({ file: cand.file, line: cand.line, reason: verified.reason });
        continue;
      }
      throw new GovernanceError(
        'ANALYSIS_LOCATION_VERIFY_FAILED',
        `第 ${index + 1} 条候选位置 ${cand.file}:${cand.line} 验真失败：${verified.reason}`,
        { index, file: cand.file, line: cand.line, reason: verified.reason },
      );
    }
    candidates.push({
      id: `cand_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      file: verified.file,
      line: verified.line,
      ...(verified.endLine !== undefined ? { endLine: verified.endLine } : {}),
      snippet: verified.realSnippet,
      why: cand.why,
      confidence: cand.confidence,
    });
  }
  if (candidates.length === 0) {
    throw new GovernanceError(
      'ANALYSIS_CANDIDATE_ALL_DROPPED',
      `全部候选位置验真失败（${dropped.length} 条），没有可用位置无法上传`,
      { dropped },
    );
  }
  /*
   * 剔除模式下链上的 ref 可能指向被剔掉的位置：按 `pruneChainRefs` 的既有策略
   * **只剪 ref、保留节点文本**（那句因果判断通常仍成立）。
   */
  const chain = input.skipInvalidCandidates === true
    ? pruneChainRefs(value.chain, candidates)
    : value.chain;

  return withAnalysisLock(scope, eventId, 'analysis-import', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    assertExternalImportGate(cur, input);
    /*
     * 外部上传的候选位置**直接生效**（2026-11-23 用户拍板，取代原「上传后等人工确认」）：
     *   · 外部 AI 已经把位置验真过了（上面逐条 `verifyCandidateLocation`），再要人确认一遍
     *     只是形式；而页面上的「确认」带 `expectedRunId`，外部反复上传必然把页面拖进
     *     `REVISION_CONFLICT`（真机踩到：点确认报"草稿已被新一轮分析更新"）。
     *   · 直接写 `confirmed[]` 还让 `ConclusionChain` 的引用胶囊立刻可点（它要求 ref 命中
     *     confirmed 且有 snippet），比"先待确认"少一步。
     * 去重复用 `mergeConfirmed`（同 `file+line` 幂等），所以重复上传不会堆重复位置。
     */
    const autoConfirmed: ConfirmedCodeLocation[] = candidates.map((c) => ({
      id: `loc_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      file: c.file,
      line: c.line,
      ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
      snippet: c.snippet,
      why: c.why,
      confidence: c.confidence,
      targetDir: configRoot,
      commit: input.commit ?? null,
      confirmedAt: now,
    }));
    const merged = mergeConfirmed(cur.confirmed, autoConfirmed, []);
    const draft: AnalysisDraft = {
      runId: `ext_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      status: 'ready',
      targetDir: configRoot,
      commit: input.commit ?? null,
      conclusion: value.conclusion ?? null,
      chain,
      // 已全部转成 confirmed：留空 = 页面不再出现「待确认的代码位置」
      candidates: [],
      unconfirmed: value.unconfirmed ?? [],
      /*
       * 整篇覆盖：**不传就不带该键**（⇒ 旧链路消失）。这里刻意不写
       * `dataFlow: value.dataFlow` —— 那会落一个 `undefined` 键，读侧虽能归一掉，
       * 但 `draft` 的内存对象会与"从磁盘读回来"的形状不一致，测试和 diff 都会困惑。
       */
      ...(value.dataFlow ? { dataFlow: value.dataFlow } : {}),
      steps: [],
      stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
      startedAt: now,
      updatedAt: now,
      source: 'external',
      importedAt: now,
      ...(input.sourceClient ? { sourceClient: input.sourceClient } : {}),
    };
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft,
      confirmed: merged,
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return {
      doc: next,
      dropped,
      overwritten: cur.draft !== null,
      autoConfirmed: merged.length - cur.confirmed.length,
    };
  });
}

export async function discardAnalysisDraft(scope: string, eventId: string, now = Date.now()): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-discard', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: null,
      confirmed: cur.confirmed,
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

/**
 * 整份重置（2026-11-23 · 用户要求「清空 AI 分析的结论与已关联的代码」）。
 *
 * 与 {@link discardAnalysisDraft} 的**唯一区别**：那个只清 `draft`、原样保留 `confirmed[]`
 * （"这次结论不满意，重跑一次但位置留着"）；本函数把两者一起清，回到"从没分析过"。
 * 两者必须在 UI 上表现为两个按钮 —— 把"保留已确认位置"的人误清掉是最典型的误操作。
 *
 * 两个约束：
 *   1. **一次锁内写完整份 doc**：分两次写会出现「草稿没了、位置还在」的半清态；
 *   2. **幂等**：已经是空的再调一次也成功（按钮可能被点两次，不该报错）。
 *
 * 断点 / 追问 / 列表徽标是**别的文件 / 别的缓存**，由调用方（HTTP 层）组合清理：
 * 在这里调会让 store 之间互相依赖。
 */
export async function resetAnalysis(scope: string, eventId: string, now = Date.now()): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-reset', async () => {
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: null,
      confirmed: [],
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

export async function removeConfirmedLocation(
  scope: string,
  eventId: string,
  locId: string,
  now = Date.now(),
): Promise<EventAnalysisDoc> {
  return withAnalysisLock(scope, eventId, 'analysis-remove-loc', async () => {
    const cur = readAnalysisDocRaw(scope, eventId);
    const filtered = cur.confirmed.filter((c) => c.id !== locId);
    if (filtered.length === cur.confirmed.length) {
      throw new GovernanceError('ANALYSIS_LOCATION_NOT_FOUND', `代码位置「${locId}」不存在`);
    }
    const next: EventAnalysisDoc = {
      version: 1,
      eventId,
      draft: cur.draft,
      confirmed: filtered,
      updatedAt: now,
    };
    writeAnalysisDoc(scope, next);
    return next;
  });
}

export function removeAnalysisFile(scope: string, eventId: string): void {
  try {
    fs.rmSync(getAnalysisPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[analysis] 删除分析文件失败 ${eventId}: ${(err as Error).message}`);
  }
}
