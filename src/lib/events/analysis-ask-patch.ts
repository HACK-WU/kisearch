/**
 * analysis-ask-patch.ts —— 追问末端的「结论补丁」提取 / 模板校验 / 差异比对
 * （REQ-20261123-001 · S03 · 批 5）
 *
 * ═══ 为什么单独一个模块 ═══
 * 1. **校验不放 `analysis-edit.ts`**：那份被 `PATCH /analysis` 共用，而补丁要比人工编辑
 *    多一条「槽位必须落在该事件类型的视角骨架内」的规则。加进去会把人工路径也锁死
 *    （需求类事件就再也加不了「根本原因」），见 S03 D2。
 * 2. **解析是"尽力而为"**：模型可能不出块、出坏 JSON、出骨架外的槽位。任何失败都只能
 *    降级成纯文本回答，**不能让追问本身失败**（N13）；因此这里全部返回错误字符串，
 *    不抛异常。
 *
 * ═══ 真实世界的输出形状（2026-11-23 真机踩过）═══
 * 只按教科书围栏写正则会漏。实测模型给过这些形状：
 *   ```ki-conclusion-patch↵{...}↵```            ← 标准
 *   ```ki-conclusion-patch{...}```               ← 标记与 JSON 同一行（**踩坑的那次**）
 *   ki-conclusion-patch{...}                     ← 连围栏都没有
 *   ```ki-conclusion-patch↵{...}                 ← 闭合围栏被截断丢掉
 *   ```ki-conclusion-patch↵{...}↵``` 后面还有解释文字
 * 因此这里改成：**先定位标记 → 从 `{` 做起括号配对 → 删掉整段补丁区**，
 * 而不是依赖成对围栏。并且**无论解析成败，只要出现过标记就把补丁区从正文删掉** ——
 * 用户永远不该在答案里看到一坨 JSON。
 */
import { CONCLUSION_MAX_CHARS, validateDraftEdit } from './analysis-edit.js';
import { oneLine } from './conclusion-chain.js';
import { viewProfile, type AnalysisView } from './analysis-view.js';
import type { AskProposal, ConclusionNode } from './types.js';

export type { AskProposal };

/** 约定的围栏语言标记：模型按 ```` ```ki-conclusion-patch ```` 输出（也容忍不带围栏） */
export const PATCH_FENCE_LANG = 'ki-conclusion-patch';

export type ProposalDiffBlock = {
  block: 'conclusion' | 'chain';
  kind: '改' | '增' | '删';
  /** 展示用摘要（chain 用节点文本，不走 kind 词表） */
  before?: string;
  after?: string;
};

export interface ProposalDiff {
  changed: boolean;
  blocks: ProposalDiffBlock[];
}

/**
 * 从 `start`（必须指向 `{`）起做**字符串感知**的括号配对，返回结束位置（含 `}`）。
 *
 * 不能用正则找 `}`：JSON 正文里就有 `}`（如 `"text":"补 {x} 兜底"`），
 * 也不能简单取最后一个 `}` —— 后面可能还有解释文字。
 */
function matchJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 兜底擦除：把正文里**任何**残留的「标记（+ 紧跟的 JSON）」整段删掉。
 *
 * 为什么需要第二道：主解析只处理**选中的那一个**标记。若模型写了两个块、
 * 或在块之后又提了一句"以上为 ki-conclusion-patch 格式"，选中点之外的
 * 标记与 JSON 会原样留在正文里 —— 那正是"用户看到一坨 JSON"的复现路径。
 * 这里按同一套配对规则再扫一遍，保证**返回的正文里不可能出现补丁 JSON**。
 */
function scrubPatch(text: string): string {
  const re = new RegExp(PATCH_FENCE_LANG, 'gi');
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(cursor, m.index);
    const afterMarker = m.index + PATCH_FENCE_LANG.length;
    const tail = text.slice(afterMarker);
    const brace = tail.indexOf('{');
    // 只有"标记后很快就是 JSON"才按补丁处理；否则只吃掉这个标记词
    if (brace >= 0 && brace <= 60) {
      const end = matchJsonObject(tail, brace);
      cursor = end < 0 ? text.length : afterMarker + end;
      // 顺带吃掉紧随的闭合围栏
      const rest = text.slice(cursor);
      const fence = /^\s*```\s*/.exec(rest);
      if (fence) cursor += fence[0].length;
    } else {
      cursor = afterMarker;
    }
    re.lastIndex = cursor;
  }
  out += text.slice(cursor);
  // 标记前后的残余围栏与空行收一下，避免答案末尾挂个孤零零的 ```
  return out.replace(/```\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从回答里剥出补丁块。
 *
 * - 取**第一个"标记后紧跟 JSON"的位置**（真实补丁）；都不像补丁时退回最后一个，
 *   走错误路径。取最后一个会漏掉"块 + 末尾又提了一句格式"这种写法；
 * - 标记前后可能带围栏 / 换行 / 解释文字，一律按"标记 + JSON 主体"处理；
 * - 无论解析成败，**都从正文里删掉补丁区**（另有 `scrubPatch` 兜底擦除）；
 * - 解析失败只返回 `error`，`patch` 为空，调用方据此降级。
 *
 * **不变量**：`patch` 或 `error` 有值 ⟺ 正文里出现过标记。调用方据此决定
 * 展示哪个文本（见 `analysis-ask-runner`），不要自己再判断标记存在性。
 */
export function extractProposal(answer: string): {
  answer: string;
  patch?: AskProposal;
  error?: string;
} {
  /*
   * 大小写不敏感：模型写过全大写标记，不能因此漏解析。
   * 用 matchAll 拿**原串**下标（`toLowerCase()` 对个别 Unicode 字符会改变长度，不能用它算下标）。
   *
   * 选点规则：优先**第一个"标记后 60 字内出现 `{`"**的位置（那才是真补丁）；
   * 全都不像补丁时退回最后一个，让错误路径能报出"有标记但没内容"。
   */
  const positions = [...answer.matchAll(new RegExp(PATCH_FENCE_LANG, 'gi'))].map((m) => m.index ?? -1);
  if (positions.length === 0) return { answer };
  const looksLikePatch = (at: number): boolean =>
    answer.slice(at + PATCH_FENCE_LANG.length, at + PATCH_FENCE_LANG.length + 60).includes('{');
  const markerAt = positions.find(looksLikePatch) ?? positions[positions.length - 1]!;

  /*
   * 标记**前面**可能还挂着一个开围栏（```` ``` ```` / ```` ```json ````），
   * 它不属于正文，必须一并删掉 —— 否则用户会看到一段以孤零零的 ```` ``` ```` 结尾的回答。
   */
  const before = answer
    .slice(0, markerAt)
    .replace(/```[a-zA-Z0-9_-]*\s*$/, '')
    .replace(/\s+$/, '');
  const tail = answer.slice(markerAt + PATCH_FENCE_LANG.length);

  // 标记后面通常紧跟 ``` 或换行；都当分隔符吃掉
  const bodyStart = tail.search(/[{\n]/);
  if (bodyStart < 0) {
    return { answer: scrubPatch(before), error: '补丁标记后没有内容' };
  }
  const bodyText = tail.slice(bodyStart);
  const braceAt = bodyText.indexOf('{');
  if (braceAt < 0) {
    // 有标记有换行但没有 JSON：把标记之后全删（宁可少一段，也不给用户看残留）
    return { answer: scrubPatch(before), error: '补丁缺少 JSON 主体' };
  }

  const end = matchJsonObject(bodyText, braceAt);
  const jsonEnd = end < 0 ? bodyText.length : end;
  const after = end < 0
    // 括号没闭合（被截断）：补丁区直到末尾，正文只留标记之前的部分
    ? ''
    // 正常闭合：吃掉后面可能存在的闭合围栏，再把剩余解释文字接回去
    : bodyText.slice(jsonEnd).replace(/^\s*```\s*/, '');
  const stripped = [before.replace(/\s+$/, ''), after.replace(/^\s+/, '')]
    .filter((s) => s !== '')
    .join('\n\n')
    .trim();

  const jsonText = bodyText.slice(braceAt, jsonEnd).trim();
  if (end < 0) {
    // 与"坏 JSON"归一类：都进 N13 的降级路径，文案说清是哪一种
    return { answer: scrubPatch(stripped), error: '补丁不是合法 JSON（缺少闭合括号，可能被截断）' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { answer: scrubPatch(stripped), error: `补丁不是合法 JSON：${(err as Error).message.slice(0, 80)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { answer: scrubPatch(stripped), error: '补丁必须是 JSON 对象' };
  }
  const obj = parsed as Record<string, unknown>;
  const conclusion = typeof obj.conclusion === 'string' ? oneLine(obj.conclusion) : '';
  const chainRaw = obj.chain;
  if (!conclusion) return { answer: scrubPatch(stripped), error: '补丁缺少结论文本（或为空）' };
  if (!Array.isArray(chainRaw)) return { answer: scrubPatch(stripped), error: '补丁的 chain 必须是数组' };
  const chain: ConclusionNode[] = chainRaw
    .filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === 'object' && !Array.isArray(n))
    .map((n) => ({
      kind: typeof n.kind === 'string' ? (n.kind.trim().toLowerCase() as ConclusionNode['kind']) : ('symptom' as const),
      text: typeof n.text === 'string' ? oneLine(n.text) : '',
      ...(typeof n.ref === 'string' && n.ref.trim() ? { ref: n.ref.trim() } : {}),
      ...(Array.isArray(n.branches)
        ? { branches: n.branches.filter((b): b is string => typeof b === 'string').map(oneLine).filter(Boolean) }
        : {}),
    }));
  return {
    answer: scrubPatch(stripped),
    patch: {
      conclusion,
      chain,
      reason: typeof obj.reason === 'string' ? oneLine(obj.reason).slice(0, 200) : '',
    },
  };
}

/**
 * 按事件类型的**视角骨架**校验补丁（S03 §3.3）。
 *
 * 字段级规则（节点数 / 文本长度 / ref 形状 / 分支只挂 root）复用 `validateDraftEdit`，
 * 这里只额外加"槽位必须在骨架内"那一条 —— 两处口径不一致就会出现
 * "AI 补丁能过、人工编辑过不了"（或反过来）。
 */
export function validateProposal(patch: AskProposal, view: AnalysisView): string[] {
  const errors: string[] = [];

  if (patch.conclusion.length > CONCLUSION_MAX_CHARS) {
    errors.push(`结论 ${patch.conclusion.length} 字，超过上限 ${CONCLUSION_MAX_CHARS} 字`);
  }

  const allowed = viewProfile(view).skeleton;
  const outside = patch.chain.find((n) => !allowed.includes(n.kind));
  if (outside) {
    errors.push(`「${outside.kind}」不在该事件类型的模板里（可用槽位：${allowed.join(' / ')}）`);
  }

  const checked = validateDraftEdit({ chain: patch.chain });
  for (const e of checked.errors) {
    errors.push(e.index === undefined ? e.reason : `第 ${e.index + 1} 个节点：${e.reason}`);
  }
  return errors;
}

function sameNode(a: ConclusionNode | undefined, b: ConclusionNode | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind
    && oneLine(a.text) === oneLine(b.text)
    && (a.ref ?? '') === (b.ref ?? '')
    && JSON.stringify(a.branches ?? []) === JSON.stringify(b.branches ?? []);
}

/**
 * 补丁与当前草稿的差异（S03 §3.4）。
 *
 * **由程序判定**而不是问模型"你觉得变了吗"（D3）：模型自陈不稳定，会出现
 * "每次都说变了"或"真变了却说没变"。比较前统一 `oneLine` 归一，
 * 避免"只差空格"也弹框。
 */
export function diffProposal(
  current: { conclusion: string | null; chain: ConclusionNode[] },
  patch: AskProposal,
): ProposalDiff {
  const blocks: ProposalDiffBlock[] = [];

  const before = current.conclusion ? oneLine(current.conclusion) : '';
  if (before !== oneLine(patch.conclusion)) {
    blocks.push({ block: 'conclusion', kind: '改', ...(before ? { before } : {}), after: oneLine(patch.conclusion) });
  }

  const max = Math.max(current.chain.length, patch.chain.length);
  for (let i = 0; i < max; i += 1) {
    const a = current.chain[i];
    const b = patch.chain[i];
    if (sameNode(a, b)) continue;
    if (a && b) blocks.push({ block: 'chain', kind: '改', before: oneLine(a.text), after: oneLine(b.text) });
    else if (b) blocks.push({ block: 'chain', kind: '增', after: oneLine(b.text) });
    else if (a) blocks.push({ block: 'chain', kind: '删', before: oneLine(a.text) });
  }

  return { changed: blocks.length > 0, blocks };
}
