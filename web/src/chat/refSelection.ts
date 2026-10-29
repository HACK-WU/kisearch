/**
 * refSelection.ts —— 「选中文档内容 → AI 引用」的判定与守卫（**单一来源**）。
 *
 * 为什么抽出来：加入引用有两条入口 ——
 *   ① 面板「+ 加入引用」进入 armed 态后划选（mouseup）；
 *   ② 选中文档内容后按 Ctrl+L（2026-10-15 新增）。
 * 两条入口必须共用**同一套**上限 / 去重判定与提示文案，否则会出现"一条拦得住、另一条放行，
 * 直到发送时才被后端 400 打回"的漂移（后端 `CHAT_REF_TOTAL_MAX=6000` 是硬闸门，
 * 前端漏拦 = 操作看似合法但发送必失败）。
 */
import {
  CHAT_REF_MAX_COUNT,
  CHAT_REF_TEXT_MAX,
  CHAT_REF_TOTAL_MAX,
  type ChatRef,
} from '@/api/chatContract';

/** 引用候选（尚未通过守卫） */
export interface RefCandidate {
  group: string;
  /** 文档名（= relation） */
  doc: string;
  /** 选区原文（可能超长，由 `checkRefAdd` 截断） */
  text: string;
}

/**
 * 守卫不通过的原因。
 * `empty` / `not-in-drawer` / `no-doc` 属**静默忽略**（选区不构成引用，不打扰用户）；
 * 其余三类必须给可见提示（`message` 非空）。
 */
export type RefGuardReason =
  | 'empty'
  | 'not-in-drawer'
  | 'no-doc'
  | 'max-count'
  | 'total-max'
  | 'duplicate';

export type RefAddResult =
  | { ok: true; ref: ChatRef; message: string }
  | { ok: false; reason: RefGuardReason; message: string };

/** 选区锚点 → 所在文档查看器（`.ki-drawer`）；选区不在查看器内时返回 null */
export function drawerOfSelection(selection: Selection | null): Element | null {
  const anchor = selection?.anchorNode ?? null;
  const el = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  return el?.closest('.ki-drawer') ?? null;
}

/** 由「选区文本 + 查看器元素」构造引用候选；空文本或缺文档身份时返回 null */
export function buildRefCandidate(raw: string, drawer: Element | null): RefCandidate | null {
  const text = raw.trim();
  if (!text || !drawer) return null;
  const doc = drawer.getAttribute('data-ki-doc-name') ?? '';
  if (!doc) return null;
  return { group: drawer.getAttribute('data-ki-doc-group') ?? '', doc, text };
}

/**
 * 守卫判定（纯数据，可单测）：条数 → 单条长度（截断）→ 合计长度 → 重复。
 *
 * 返回的 `message` 即用户可见提示（成功分支含"超长已截断"说明）——文案与口径只维护这一份。
 */
export function checkRefAdd(refs: readonly ChatRef[], candidate: RefCandidate): RefAddResult {
  if (refs.length >= CHAT_REF_MAX_COUNT) {
    return {
      ok: false,
      reason: 'max-count',
      message: `一次提问最多引用 ${CHAT_REF_MAX_COUNT} 段内容，请先移除一条`,
    };
  }
  const text = candidate.text.length > CHAT_REF_TEXT_MAX
    ? candidate.text.slice(0, CHAT_REF_TEXT_MAX)
    : candidate.text;
  // 总量守卫：只限条数与单条长度时，5 × 2000 可合法凑出 10000 字，而后端
  // `CHAT_REF_TOTAL_MAX`（6000）会直接 400 —— 必须在前端拦住并说明原因
  const usedChars = refs.reduce((n, r) => n + r.text.length, 0);
  if (usedChars + text.length > CHAT_REF_TOTAL_MAX) {
    return {
      ok: false,
      reason: 'total-max',
      message: `引用内容合计不得超过 ${CHAT_REF_TOTAL_MAX} 字（当前 ${usedChars} 字），请先移除部分引用`,
    };
  }
  if (refs.some((r) => r.group === candidate.group && r.doc === candidate.doc && r.text === text)) {
    return { ok: false, reason: 'duplicate', message: `这段内容已在引用中：${candidate.doc}` };
  }
  const ref: ChatRef = { group: candidate.group, doc: candidate.doc, text };
  return {
    ok: true,
    ref,
    message: candidate.text.length > CHAT_REF_TEXT_MAX
      ? `已加入引用（超长已截断至 ${CHAT_REF_TEXT_MAX} 字）：${candidate.doc}`
      : `已加入引用：${candidate.doc}（${text.length} 字）`,
  };
}
