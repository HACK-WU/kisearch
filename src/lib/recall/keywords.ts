/**
 * recall/keywords.ts —— 把「任务画像」转成可检索的两路线索（S-01 §3.2）。
 *
 * 为什么不复用 `events/refs-service.ts::extractKeywords`：
 *   那个函数按空白/标点切词，**中文无标点长句会被整句当成一个 token**（标题短所以没事，
 *   任务画像是 100~2000 字，直接套用等于「拿整段话去检索」）。本文件专治这一点。
 *
 * 两路分工（**不要合并成一路**）：
 *   - `blocks`：语义查询块，8~40 字、最多 4 块 → 走 hybrid 语义检索；
 *   - `tokens`：精确线索（错误码 / 路径 / 英文标识符 / 中文 2~4 字窗口）→ 走备用全文检索 +
 *     作为 `why`（命中理由）的证据。
 *
 * 纯函数、无 IO、无正则回溯风险（所有正则均为线性量词），2000 字耗时 < 5ms。
 */

import { MAX_BLOCKS, MAX_TOKENS, type RecallTerms } from './types.js';

/** 语义块长度上限（超过按 40 字硬切） */
const MAX_BLOCK_CHARS = 40;

/**
 * 中文虚字：n-gram **首尾**命中即丢弃。
 *
 * 只写在首尾而不是「包含即丢」——「上传回写」这类真实词组中间可能恰好含虚字，
 * 一律剔除会把有效术语误杀。
 */
const CN_STOP_CHARS = new Set(Array.from('的了和与及在是有不为对把被会要就也都没个这那么怎样吗呢请帮我你它'));

/** 英文停用词：任务画像里常混的虚词，对检索无区分度 */
const EN_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for',
  'with', 'and', 'or', 'not', 'it', 'this', 'that', 'as', 'at', 'by', 'from', 'we', 'you',
]);

const RE_PATH = /[A-Za-z0-9_.\-/]+\.[a-z]{2,4}\b/g;
const RE_ERROR_CODE = /\b[A-Z][A-Z0-9]*[-_]?\d{2,}\b/g;
const RE_IDENT = /[A-Za-z][A-Za-z0-9_.\-]{1,}/g;

function isHan(ch: string): boolean {
  return /\p{Script=Han}/u.test(ch);
}

/** 中文窗口中至少要有 2 个汉字，且首尾不是虚字（否则「是什么」「了和」这类噪声会占满 tokens） */
function isUsefulHanWindow(win: string): boolean {
  if (win.length < 2) return false;
  let hanCount = 0;
  for (const ch of win) if (isHan(ch)) hanCount += 1;
  if (hanCount < 2) return false;
  const first = win[0];
  const last = win[win.length - 1];
  if (first === undefined || last === undefined) return false;
  if (CN_STOP_CHARS.has(first) || CN_STOP_CHARS.has(last)) return false;
  // 全同字（「哈哈哈」）无区分度
  return !Array.from(win).every((ch) => ch === first);
}

/**
 * 从任务画像 + 强线索抽取两路检索词。
 *
 * @param args.task 任务画像（建议 ≤2000 字；超长由工具层拦截，本函数不截断以免静默丢线索）
 * @param args.hints 强线索：原样进 tokens 头部（它们通常是最有区分度的）
 */
export function extractRecallTerms(args: {
  task: string;
  hints?: string[];
  maxBlocks?: number;
  maxTokens?: number;
}): RecallTerms {
  const maxBlocks = args.maxBlocks ?? MAX_BLOCKS;
  const maxTokens = args.maxTokens ?? MAX_TOKENS;

  // NFKC：全角标点/字母统一，避免「ＡＰＩ」与「API」被当成两个线索
  const normalized = args.task.normalize('NFKC');
  const hints = (args.hints ?? []).map((h) => h.trim()).filter((h) => h.length > 0);

  const sentences = normalized
    .split(/[。！？!?;\n]+/)
    .map((s) => s.trim())
    // 纯标点/符号段（如「...」）没有检索价值：留着会变成一个语义块，把真正的描述挤掉
    .filter((s) => s.length > 0 && /[\p{L}\p{N}]/u.test(s));

  // ── blocks：短句先合并到 ~40 字，再切块 ──
  const units: string[] = [];
  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += MAX_BLOCK_CHARS) {
      units.push(sentence.slice(i, i + MAX_BLOCK_CHARS));
    }
  }
  const blocks: string[] = [];
  for (const unit of units) {
    const tail = blocks[blocks.length - 1];
    if (tail !== undefined && tail.length + unit.length + 1 <= MAX_BLOCK_CHARS) {
      blocks[blocks.length - 1] = `${tail}，${unit}`;
      continue;
    }
    if (blocks.length < maxBlocks) blocks.push(unit);
  }

  // ── 线索分两段：strong（精确，进主 query）与 weak（中文窗口，只兜底）──
  const strong: string[] = [];
  const weak: string[] = [];
  const seen = new Set<string>();
  const add = (target: string[], raw: string): boolean => {
    const value = raw.trim();
    if (value.length < 2) return false;
    const isAscii = /^[\x20-\x7E]+$/.test(value);
    const key = isAscii ? value.toLowerCase() : value;
    if (isAscii && EN_STOP.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    target.push(value);
    return true;
  };

  for (const hint of hints) add(strong, hint);

  const scanText = [normalized, ...hints].join(' ');
  for (const m of scanText.matchAll(RE_PATH)) add(strong, m[0]);
  for (const m of scanText.matchAll(RE_ERROR_CODE)) add(strong, m[0]);
  for (const m of scanText.matchAll(RE_IDENT)) add(strong, m[0]);

  // 中文窗口：3 字优先（区分度更高），再补 2 字。**只进 weak** —— 碎片混进主 query 会稀释强线索
  for (const size of [3, 2] as const) {
    for (const sentence of sentences) {
      for (let i = 0; i + size <= sentence.length; i += 1) {
        if (weak.length >= maxTokens) break;
        const win = sentence.slice(i, i + size);
        if (isUsefulHanWindow(win)) add(weak, win);
      }
    }
  }

  const strongCapped = strong.slice(0, maxTokens);
  const tokens = [...strongCapped, ...weak].slice(0, maxTokens);
  return { blocks, strong: strongCapped, weak, tokens };
}
