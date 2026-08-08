// chunker.mjs —— demo 验证用：splitIntoChunks 最小实现（对齐 chunker.ts：段落边界 + overlap）
// 验证目的：R-01/R-04 切分行为（清洗后文本切分、chunk 数、原文/清洗隔离）

export const MAX_CHUNKS_PER_FILE = 500;

const BREAK_PATTERNS = ['\n\n', '\n', '。', '；'];

function findBreakPoint(text, start, chunkSize) {
  const hardEnd = Math.min(text.length, start + chunkSize);
  const BREAK_SEARCH_WINDOW = 50;
  const searchEnd = Math.min(text.length, hardEnd + BREAK_SEARCH_WINDOW);
  for (const pattern of BREAK_PATTERNS) {
    const idx = text.indexOf(pattern, hardEnd);
    if (idx !== -1 && idx <= searchEnd) {
      return idx + pattern.length <= text.length ? idx + pattern.length : idx;
    }
  }
  return hardEnd;
}

export function splitIntoChunks(text, options = {}) {
  const chunkSize = options.chunkSize ?? 1000;
  const overlap = options.overlap ?? 150;

  if (!text) return [];
  if (chunkSize <= 0) throw new Error(`chunkSize 必须为正数：${chunkSize}`);
  if (text.length <= chunkSize) return [{ index: 1, text }];

  const chunks = [];
  let pos = 0;
  let index = 1;

  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= chunkSize) {
      chunks.push({ index, text: text.slice(pos) });
      break;
    }
    const cut = findBreakPoint(text, pos, chunkSize);
    if (cut <= pos) {
      chunks.push({ index, text: text.slice(pos, pos + chunkSize) });
      pos += chunkSize;
    } else {
      chunks.push({ index, text: text.slice(pos, cut) });
      const nextStart = Math.max(pos + 1, cut - overlap);
      pos = nextStart;
    }
    index++;
  }
  return chunks;
}
