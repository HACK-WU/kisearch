/**
 * chunker.ts —— 大文档递归字符切分（固定长度 + 段落边界优先）
 *
 * 设计要点（REQ-20260806-001）：
 *   - 触发条件 = 长度阈值（非段落数）：份数 = ceil(字符数 / chunkSize)，与段落数无关
 *   - 切分点偏好：\n\n > \n > 。 > ； > 硬切（分隔符只决定"在哪切"，不决定"切不切"）
 *   - overlap：chunk 尾部保留部分字符与下个 chunk 重叠，保护跨 chunk 上下文
 *   - 内存中执行：不落盘，chunk 由调用方消费（relation 名 = 文件名-N 由调用方拼）
 */

export interface Chunk {
  /** 1-based chunk 序号 */
  index: number;
  /** chunk 原文 */
  text: string;
}

export interface ChunkOptions {
  /** 目标长度（字符），默认 1000 */
  chunkSize?: number;
  /** 相邻 chunk 重叠字符数，默认 150 */
  overlap?: number;
}

/** 单文件 chunk 数上限（P-7）：超限视为"超大文件"，防单文件向量爆炸 */
export const MAX_CHUNKS_PER_FILE = 500;

/** 分隔符优先级：优先在更干净的语义边界切断 */
const BREAK_PATTERNS: string[] = ['\n\n', '\n', '。', '；'];

/**
 * 在 [start, start+chunkSize] 附近向后查找最合适的切分点。
 * @returns 切分位置（相对于整个文本）；找不到合适分隔符时返回硬切位置
 */
function findBreakPoint(text: string, start: number, chunkSize: number): number {
  const hardEnd = Math.min(text.length, start + chunkSize);
  // 找最近分隔符：从 hardEnd 向后最多看 BREAK_SEARCH_WINDOW 个字符
  const BREAK_SEARCH_WINDOW = 50;
  const searchEnd = Math.min(text.length, hardEnd + BREAK_SEARCH_WINDOW);

  for (const pattern of BREAK_PATTERNS) {
    const idx = text.indexOf(pattern, hardEnd);
    if (idx !== -1 && idx <= searchEnd) {
      // 切在分隔符之后（保留分隔符到下一 chunk 也行，这里切在分隔符前保证边界干净）
      return idx + pattern.length <= text.length ? idx + pattern.length : idx;
    }
  }

  // 无合适分隔符 → 硬切
  return hardEnd;
}

/**
 * 递归字符切分。
 * 输入：完整文本 + 切分参数；输出：Chunk[]（内存中，不落盘）。
 */
export function splitIntoChunks(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkSize = options.chunkSize ?? 1000;
  const overlap = options.overlap ?? 150;

  if (!text) return [];
  if (chunkSize <= 0) throw new Error(`chunkSize 必须为正数：${chunkSize}`);
  if (text.length <= chunkSize) return [{ index: 1, text }];

  const chunks: Chunk[] = [];
  let pos = 0;
  let index = 1;

  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= chunkSize) {
      // 剩余部分直接作为最后一块（不做 overlap 回退，避免重复内容）
      chunks.push({ index, text: text.slice(pos) });
      break;
    }
    const cut = findBreakPoint(text, pos, chunkSize);
    if (cut <= pos) {
      // 防御：切分点无进展时强制推进（硬切）
      chunks.push({ index, text: text.slice(pos, pos + chunkSize) });
      pos += chunkSize;
    } else {
      chunks.push({ index, text: text.slice(pos, cut) });
      // overlap：下个 chunk 回退到 cut - overlap，与上一 chunk 尾部重叠
      // 保证推进：回退后的起点必须 > 当前 chunk 起点
      const nextStart = Math.max(pos + 1, cut - overlap);
      pos = nextStart;
    }
    index++;
  }

  return chunks;
}
