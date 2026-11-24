/**
 * analysis-edit.ts —— 人工校正三块产物的**严格**校验（REQ-20261123-001 · S01）
 *
 * 为什么不能直接用 `conclusion-chain.normalizeChain`：那一份的取向是"模型输出不可信，
 * 宁可少一个节点也不放不可信数据"，所以**静默丢弃**非法项。人工提交正好相反 ——
 * 数据是人给的，需要的是"第 3 个节点超了 200 字"这种**可定位的报错**；静默裁剪会让人
 * 以为保存成功而内容已经变了（模型侧那个 `slice(0,200)` 正是被投诉过的行为）。
 *
 * 两条口径的阈值必须完全一致（节点数 / 文本长度 / ref 形状 / 分支规则），否则会出现
 * "AI 写得进、人改完存不进"的荒谬结果。因此阈值与正则一律**从这里导入**，
 * 本文件不复制任何数字。
 */
import {
  CHAIN_BRANCH_MAX_ITEMS,
  CHAIN_BRANCH_TEXT_MAX,
  CHAIN_MAX_NODES,
  CHAIN_TEXT_MAX,
  CONCLUSION_KINDS,
  REF_PATTERN,
  oneLine,
} from './conclusion-chain.js';
import type { ConclusionNode, ConclusionNodeKind } from './types.js';

/**
 * `conclusion` 的**硬上限**（2026-11-23 H10：取消 120 字软限制，与追问回答统一 4000）。
 *
 * 不再保留"既有超长豁免"：历史值在解析层已被截断到 2000，必然 < 4000，
 * 一个阈值即可覆盖全部存量。
 */
export const CONCLUSION_MAX_CHARS = 4000;
/** 单条未确认点上限（原先**没有任何上限**，2026-11-23 新定） */
export const UNCONFIRMED_ITEM_MAX = 300;
/** 未确认点总条数上限 */
export const UNCONFIRMED_MAX_ITEMS = 20;
/** 手工位置的「理由」上限 */
export const MANUAL_LOCATION_WHY_MAX = 200;
/** 单次请求最多手工新增几个位置（防一次贴一屏） */
export const MANUAL_LOCATION_ADD_MAX = 20;

export type EditField = 'conclusion' | 'chain' | 'unconfirmed' | 'confirmed' | 'candidates';

/** 一条可定位的校验错误；`index` 是该字段内的第几项（0 起） */
export interface EditFieldError {
  field: EditField;
  index?: number;
  reason: string;
}

/** 手工新增位置（尚未验真） */
export interface ManualLocationInput {
  file: string;
  line: number;
  endLine?: number;
  why: string;
}

/** 一次保存请求的原始输入（全部可选，未提供 = 不改该块） */
export interface DraftEditPayload {
  conclusion?: string | null;
  chain?: unknown;
  unconfirmed?: unknown;
  confirmedAdd?: unknown;
  confirmedUpdate?: unknown;
}

/** 校验通过后的规范化结果（只在 `errors.length === 0` 时使用） */
export interface NormalizedEdit {
  conclusion?: string | null;
  chain?: ConclusionNode[];
  unconfirmed?: string[];
  confirmedAdd?: ManualLocationInput[];
  confirmedUpdate?: Array<{ id: string; why: string }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const EDIT_KEYS: ReadonlyArray<keyof DraftEditPayload> = [
  'conclusion', 'chain', 'unconfirmed', 'confirmedAdd', 'confirmedUpdate',
];

/**
 * 是否真的带来了改动。
 *
 * `conclusion: null` 算改动（显式清空），因此判据是 `!== undefined` 而不是真值判断——
 * 空 patch 不写盘、也不该打 `editedAt`（否则"点保存没改东西"也会被标成已人工修订）。
 */
export function hasEditFields(payload: DraftEditPayload): boolean {
  return EDIT_KEYS.some((key) => payload[key] !== undefined);
}

function validateChain(raw: unknown, errors: EditFieldError[], value: NormalizedEdit): void {
  if (!Array.isArray(raw)) {
    errors.push({ field: 'chain', reason: '结论链必须是数组' });
    return;
  }
  if (raw.length > CHAIN_MAX_NODES) {
    errors.push({ field: 'chain', reason: `结论链最多 ${CHAIN_MAX_NODES} 个节点（当前 ${raw.length} 个）` });
    return;
  }
  const chain: ConclusionNode[] = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push({ field: 'chain', index, reason: '节点格式不合法（应为对象）' });
      return;
    }
    const kindRaw = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
    if (!(CONCLUSION_KINDS as readonly string[]).includes(kindRaw)) {
      errors.push({ field: 'chain', index, reason: `节点类型必须是 ${CONCLUSION_KINDS.join(' / ')} 之一` });
      return;
    }
    const kind = kindRaw as ConclusionNodeKind;
    const text = typeof item.text === 'string' ? oneLine(item.text) : '';
    if (!text) {
      errors.push({ field: 'chain', index, reason: '节点文本不能为空' });
      return;
    }
    if (text.length > CHAIN_TEXT_MAX) {
      errors.push({ field: 'chain', index, reason: `节点文本 ${text.length} 字，超过上限 ${CHAIN_TEXT_MAX} 字` });
      return;
    }
    const node: ConclusionNode = { kind, text };

    // ref：允许不填；填了就必须是「路径:行号」且行号 ≥1（行号 0 会被前端渲染成点不开的胶囊）
    if (item.ref !== undefined && item.ref !== null && item.ref !== '') {
      const refText = typeof item.ref === 'string' ? item.ref.trim() : '';
      const matched = REF_PATTERN.exec(refText);
      if (!matched || Number(matched[2]) < 1) {
        errors.push({ field: 'chain', index, reason: '位置引用要写成「路径:行号」（如 src/a.ts:42）' });
        return;
      }
      node.ref = `${matched[1]}:${Number(matched[2])}`;
    }

    const branchesRaw = item.branches;
    if (branchesRaw !== undefined && branchesRaw !== null) {
      if (!Array.isArray(branchesRaw)) {
        errors.push({ field: 'chain', index, reason: '分支必须是字符串数组' });
        return;
      }
      const branches = branchesRaw
        .map((b) => (typeof b === 'string' ? oneLine(b) : ''))
        .filter(Boolean);
      if (branches.length > 0 && kind !== 'root') {
        errors.push({ field: 'chain', index, reason: '分支只能挂在「根本原因」节点上' });
        return;
      }
      if (branches.length > CHAIN_BRANCH_MAX_ITEMS) {
        errors.push({ field: 'chain', index, reason: `分支最多 ${CHAIN_BRANCH_MAX_ITEMS} 条（当前 ${branches.length} 条）` });
        return;
      }
      const tooLong = branches.find((b) => b.length > CHAIN_BRANCH_TEXT_MAX);
      if (tooLong) {
        errors.push({ field: 'chain', index, reason: `分支文本 ${tooLong.length} 字，超过上限 ${CHAIN_BRANCH_TEXT_MAX} 字` });
        return;
      }
      if (branches.length > 0) node.branches = branches;
    }

    chain.push(node);
  });
  value.chain = chain;
}

function validateUnconfirmed(raw: unknown, errors: EditFieldError[], value: NormalizedEdit): void {
  if (!Array.isArray(raw)) {
    errors.push({ field: 'unconfirmed', reason: '未确认点必须是字符串数组' });
    return;
  }
  if (raw.length > UNCONFIRMED_MAX_ITEMS) {
    errors.push({ field: 'unconfirmed', reason: `未确认点最多 ${UNCONFIRMED_MAX_ITEMS} 条（当前 ${raw.length} 条）` });
    return;
  }
  const seen = new Set<string>();
  const list: string[] = [];
  raw.forEach((item, index) => {
    const text = typeof item === 'string' ? oneLine(item) : '';
    if (!text) {
      errors.push({ field: 'unconfirmed', index, reason: '未确认点不能是空行' });
      return;
    }
    if (text.length > UNCONFIRMED_ITEM_MAX) {
      errors.push({ field: 'unconfirmed', index, reason: `该条 ${text.length} 字，超过上限 ${UNCONFIRMED_ITEM_MAX} 字` });
      return;
    }
    if (seen.has(text)) {
      errors.push({ field: 'unconfirmed', index, reason: '与前文某一条重复' });
      return;
    }
    seen.add(text);
    list.push(text);
  });
  value.unconfirmed = list;
}

function validateConfirmedAdd(raw: unknown, errors: EditFieldError[], value: NormalizedEdit): void {
  if (!Array.isArray(raw)) {
    errors.push({ field: 'confirmed', reason: 'confirmed.add 必须是数组' });
    return;
  }
  if (raw.length > MANUAL_LOCATION_ADD_MAX) {
    errors.push({ field: 'confirmed', reason: `单次最多新增 ${MANUAL_LOCATION_ADD_MAX} 个位置（当前 ${raw.length} 个）` });
    return;
  }
  const list: ManualLocationInput[] = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push({ field: 'confirmed', index, reason: '位置格式不合法（应为对象）' });
      return;
    }
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!file) {
      errors.push({ field: 'confirmed', index, reason: '路径不能为空' });
      return;
    }
    if (/\s/.test(file)) {
      errors.push({ field: 'confirmed', index, reason: '路径不能含空格（写成「路径:行号」会解析不出来）' });
      return;
    }
    const line = typeof item.line === 'number' ? item.line : Number(item.line);
    if (!Number.isInteger(line) || line < 1) {
      errors.push({ field: 'confirmed', index, reason: '行号必须是正整数' });
      return;
    }
    let endLine: number | undefined;
    if (item.endLine !== undefined && item.endLine !== null) {
      const parsed = typeof item.endLine === 'number' ? item.endLine : Number(item.endLine);
      if (!Number.isInteger(parsed) || parsed < line) {
        errors.push({ field: 'confirmed', index, reason: '结束行号必须是整数且不小于起始行号' });
        return;
      }
      endLine = parsed;
    }
    const why = typeof item.why === 'string' ? oneLine(item.why) : '';
    if (!why) {
      errors.push({ field: 'confirmed', index, reason: '理由不能为空' });
      return;
    }
    if (why.length > MANUAL_LOCATION_WHY_MAX) {
      errors.push({ field: 'confirmed', index, reason: `理由 ${why.length} 字，超过上限 ${MANUAL_LOCATION_WHY_MAX} 字` });
      return;
    }
    list.push({ file, line, ...(endLine !== undefined ? { endLine } : {}), why });
  });
  value.confirmedAdd = list;
}

function validateConfirmedUpdate(raw: unknown, errors: EditFieldError[], value: NormalizedEdit): void {
  if (!Array.isArray(raw)) {
    errors.push({ field: 'confirmed', reason: 'confirmed.update 必须是数组' });
    return;
  }
  const list: Array<{ id: string; why: string }> = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push({ field: 'confirmed', index, reason: '位置理由项格式不合法' });
      return;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      errors.push({ field: 'confirmed', index, reason: '缺少位置 id' });
      return;
    }
    const why = typeof item.why === 'string' ? oneLine(item.why) : '';
    if (!why) {
      errors.push({ field: 'confirmed', index, reason: '理由不能为空' });
      return;
    }
    if (why.length > MANUAL_LOCATION_WHY_MAX) {
      errors.push({ field: 'confirmed', index, reason: `理由 ${why.length} 字，超过上限 ${MANUAL_LOCATION_WHY_MAX} 字` });
      return;
    }
    list.push({ id, why });
  });
  value.confirmedUpdate = list;
}

/**
 * 校验一次保存请求。**不裁剪任何内容**，只报错。
 *
 * 只校验请求里出现的字段：未出现的块保持原值（D3：接口允许省略，前端仍整块提交）。
 */
export function validateDraftEdit(
  payload: DraftEditPayload,
): { errors: EditFieldError[]; value: NormalizedEdit } {
  const errors: EditFieldError[] = [];
  const value: NormalizedEdit = {};

  if (payload.conclusion !== undefined) {
    if (payload.conclusion === null) {
      value.conclusion = null;
    } else if (typeof payload.conclusion !== 'string') {
      errors.push({ field: 'conclusion', reason: '结论必须是字符串或 null' });
    } else {
      const text = oneLine(payload.conclusion);
      if (!text) {
        value.conclusion = null;
      } else {
        if (text.length > CONCLUSION_MAX_CHARS) {
          errors.push({
            field: 'conclusion',
            reason: `结论 ${text.length} 字，超过上限 ${CONCLUSION_MAX_CHARS} 字`,
          });
        } else {
          value.conclusion = text;
        }
      }
    }
  }

  if (payload.chain !== undefined) validateChain(payload.chain, errors, value);
  if (payload.unconfirmed !== undefined) validateUnconfirmed(payload.unconfirmed, errors, value);
  if (payload.confirmedAdd !== undefined) validateConfirmedAdd(payload.confirmedAdd, errors, value);
  if (payload.confirmedUpdate !== undefined) validateConfirmedUpdate(payload.confirmedUpdate, errors, value);

  return { errors, value };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 外部结论上传的校验（2026-11-23 · REQ-20261123-009 · S-01）
 *
 * 与人工校正同一取向：**严格报错、绝不静默裁剪**。不复用 `normalizeChain`
 * （模型侧那份会 `slice` 超长节点）：外部 AI 会以为上传成功而内容已被改。
 *
 * 三条额外规则（人工校正不需要，外部入口必须有）：
 *   1. `candidates` 必填且 ≥1 —— 没有代码位置的结论进不了「确认位置」链路；
 *   2. `chain` 至少 1 个节点 —— 只有一句 conclusion 的产物没有因果链；
 *   3. `chain[].ref` 必须落在 `candidates` 内 —— 否则前端胶囊永远点不开
 *      （`ConclusionChain` 要求 ref 在 confirmed 命中且 snippet 非空）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 单次外部上传的候选位置上限（与人工新增位置同档，防一次贴一屏） */
export const EXTERNAL_CANDIDATE_MAX = MANUAL_LOCATION_ADD_MAX;
/** 候选缺省置信度：外部 AI 未标注时用中性值，不伪造 1.0 */
export const EXTERNAL_CANDIDATE_DEFAULT_CONFIDENCE = 0.5;

/** 外部上传的候选位置（尚未验真；验真在 service 层做） */
export interface ExternalCandidateInput {
  file: string;
  line: number;
  endLine?: number;
  why: string;
  confidence: number;
}

export interface ExternalImportPayload {
  conclusion?: string | null;
  chain?: unknown;
  candidates: unknown;
  unconfirmed?: unknown;
}

export interface NormalizedExternalImport {
  conclusion?: string | null;
  chain: ConclusionNode[];
  candidates: ExternalCandidateInput[];
  unconfirmed?: string[];
}

function validateExternalCandidates(raw: unknown, errors: EditFieldError[]): ExternalCandidateInput[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: 'candidates', reason: '候选位置必须是数组（外部上传至少 1 条）' });
    return [];
  }
  if (raw.length === 0) {
    errors.push({ field: 'candidates', reason: '外部上传必须至少带 1 条代码位置' });
    return [];
  }
  if (raw.length > EXTERNAL_CANDIDATE_MAX) {
    errors.push({ field: 'candidates', reason: `候选位置最多 ${EXTERNAL_CANDIDATE_MAX} 条（当前 ${raw.length} 条）` });
    return [];
  }
  const seen = new Set<string>();
  const list: ExternalCandidateInput[] = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push({ field: 'candidates', index, reason: '位置格式不合法（应为对象）' });
      return;
    }
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!file) {
      errors.push({ field: 'candidates', index, reason: '路径不能为空' });
      return;
    }
    if (/\s/.test(file)) {
      errors.push({ field: 'candidates', index, reason: '路径不能含空格（写成「路径:行号」会解析不出来）' });
      return;
    }
    const line = typeof item.line === 'number' ? item.line : Number(item.line);
    if (!Number.isInteger(line) || line < 1) {
      errors.push({ field: 'candidates', index, reason: '行号必须是正整数' });
      return;
    }
    let endLine: number | undefined;
    if (item.endLine !== undefined && item.endLine !== null) {
      const parsed = typeof item.endLine === 'number' ? item.endLine : Number(item.endLine);
      if (!Number.isInteger(parsed) || parsed < line) {
        errors.push({ field: 'candidates', index, reason: '结束行号必须是整数且不小于起始行号' });
        return;
      }
      endLine = parsed;
    }
    const why = typeof item.why === 'string' ? oneLine(item.why) : '';
    if (!why) {
      errors.push({ field: 'candidates', index, reason: '理由不能为空（说明这处代码为什么是证据）' });
      return;
    }
    if (why.length > MANUAL_LOCATION_WHY_MAX) {
      errors.push({ field: 'candidates', index, reason: `理由 ${why.length} 字，超过上限 ${MANUAL_LOCATION_WHY_MAX} 字` });
      return;
    }
    let confidence = EXTERNAL_CANDIDATE_DEFAULT_CONFIDENCE;
    if (item.confidence !== undefined && item.confidence !== null) {
      const parsed = typeof item.confidence === 'number' ? item.confidence : Number(item.confidence);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        errors.push({ field: 'candidates', index, reason: '置信度必须是 0~1 之间的数字' });
        return;
      }
      confidence = parsed;
    }
    const key = `${file}:${line}`;
    if (seen.has(key)) {
      errors.push({ field: 'candidates', index, reason: `与前文某条重复（${key}）` });
      return;
    }
    seen.add(key);
    list.push({ file, line, ...(endLine !== undefined ? { endLine } : {}), why, confidence });
  });
  return list;
}

/**
 * 校验一次外部结论上传。**不裁剪**，只报错。
 *
 * 结论 / 链 / 未确认点三块复用 `validateDraftEdit`（阈值与人工入口同源），
 * 本函数只追加外部入口特有的三条规则与自身字段校验。
 */
export function validateExternalImport(
  payload: ExternalImportPayload,
): { errors: EditFieldError[]; value: NormalizedExternalImport } {
  const errors: EditFieldError[] = [];
  const base = validateDraftEdit({
    ...(payload.conclusion !== undefined ? { conclusion: payload.conclusion } : {}),
    ...(payload.chain !== undefined ? { chain: payload.chain } : {}),
    ...(payload.unconfirmed !== undefined ? { unconfirmed: payload.unconfirmed } : {}),
  });
  errors.push(...base.errors);

  const candidates = validateExternalCandidates(payload.candidates, errors);
  const chain = base.value.chain ?? [];
  if (chain.length === 0) {
    errors.push({ field: 'chain', reason: '结论链至少需要 1 个节点（现象 → 原因 → 根因 → 影响 → 建议）' });
  } else if (candidates.length > 0) {
    /*
     * ref ⊆ candidates：`pruneChainRefs` 只在模型侧剪枝，外部入口若放过悬空 ref，
     * 前端胶囊会因 confirmed 无匹配而永久不可点（用户看到「无法预览」却查不出原因）。
     */
    const allowed = new Set(candidates.map((c) => `${c.file}:${c.line}`));
    chain.forEach((node, index) => {
      if (node.ref && !allowed.has(node.ref)) {
        errors.push({
          field: 'chain',
          index,
          reason: `引用位置「${node.ref}」不在候选位置内（确认后也点不开）`,
        });
      }
    });
  }

  return {
    errors,
    value: {
      ...(base.value.conclusion !== undefined ? { conclusion: base.value.conclusion } : {}),
      chain,
      candidates,
      ...(base.value.unconfirmed !== undefined ? { unconfirmed: base.value.unconfirmed } : {}),
    },
  };
}
