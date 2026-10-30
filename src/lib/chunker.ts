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

// ─── 切分参数取值范围（全项目单一事实源）───
// 前端 web/src/lib/datasourceEdit.ts 复制了一份同值常量（web 与 src 是两套 tsconfig，
// 无法跨目录 import），改动时必须两边同时改。

/** 目标长度默认值（字符） */
export const DEFAULT_CHUNK_SIZE = 1000;
/** 相邻 chunk 重叠默认值（字符） */
export const DEFAULT_CHUNK_OVERLAP = 150;

/**
 * 目标长度硬下限：100 字符 ≈ 半句话，再小语义不完整、chunk 数还会成倍上涨。
 * 仅在词条 / 表格行这类"一句一条"的语料上才有意义。
 */
export const MIN_CHUNK_SIZE = 100;
/**
 * 目标长度硬上限：4000 字符（中文 ≈ 3000 token）配 1024 维向量已是 ~3:1 压缩，
 * 再大语义稀释、检索精度明显下降。
 * 注意这不是**模型**的上限——`qwen3.7-text-embedding-flash` 支持 128K token，
 * 此处取的是"效果尚可"的边界。
 */
export const MAX_CHUNK_SIZE = 4000;
/** 重叠字符数硬上限（与前端提示同源）；下限为 0（不重叠） */
export const MAX_CHUNK_OVERLAP = 500;

/** 建议取值区间（只用于提示文案，不阻塞）：低于 500 语义偏碎，高于 2000 检索偏粗 */
export const SUGGESTED_CHUNK_SIZE_MIN = 500;
export const SUGGESTED_CHUNK_SIZE_MAX = 2000;

/** 切分参数校验出错的字段（供调用方定位到具体输入框） */
export type ChunkParamField = 'chunkSize' | 'chunkOverlap';

export interface ChunkParamError {
  field: ChunkParamField;
  message: string;
}

/**
 * 校验切分参数取值范围 + 二者关系（overlap 必须小于段长）。
 *
 * `null` / `undefined` 表示"未指定，用默认值"，该字段**跳过校验**——这样
 * 「只改了其中一个字段」的更新路径可以只校验本次传入的值，
 * 不会被存量里已超界的旧值拦住（存量值读得到、改得动，只有新值受约束）。
 */
export function validateChunkParams(values: {
  chunkSize?: number | null;
  chunkOverlap?: number | null;
}): ChunkParamError | null {
  const { chunkSize, chunkOverlap } = values;
  if (chunkSize !== undefined && chunkSize !== null) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      // NaN（如 CLI 传了 --chunk-size abc）拼进文案会变成「当前 NaN」，对用户是噪音
      return {
        field: 'chunkSize',
        message: Number.isFinite(chunkSize)
          ? `段长必须为正整数（当前 ${chunkSize}）`
          : '段长必须是数字（收到非数字输入）',
      };
    }
    if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      return {
        field: 'chunkSize',
        message: `段长需在 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE} 之间（当前 ${chunkSize}）；`
          + `建议 ${SUGGESTED_CHUNK_SIZE_MIN}–${SUGGESTED_CHUNK_SIZE_MAX}`,
      };
    }
  }
  if (chunkOverlap !== undefined && chunkOverlap !== null) {
    if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0) {
      return {
        field: 'chunkOverlap',
        message: Number.isFinite(chunkOverlap)
          ? `重叠必须为非负整数（当前 ${chunkOverlap}）`
          : '重叠必须是数字（收到非数字输入）',
      };
    }
    if (chunkOverlap > MAX_CHUNK_OVERLAP) {
      return { field: 'chunkOverlap', message: `重叠需不超过 ${MAX_CHUNK_OVERLAP}（当前 ${chunkOverlap}）` };
    }
  }
  if (
    chunkSize !== undefined && chunkSize !== null
    && chunkOverlap !== undefined && chunkOverlap !== null
    && chunkOverlap >= chunkSize
  ) {
    return { field: 'chunkOverlap', message: `重叠（${chunkOverlap}）必须小于段长（${chunkSize}）` };
  }
  return null;
}

/** 分隔符优先级：优先在更干净的语义边界切断 */
const BREAK_PATTERNS: string[] = ['\n\n', '\n', '。', '；'];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * JavaScript 的 string.length/slice 按 UTF-16 code unit 工作。
 * 切分点落在代理对中间时，必须把低代理一起放进前一个 chunk，
 * 否则下一个 chunk 会以孤立低代理开头，部分 Embedding API 会拒绝该请求。
 */
function moveCutToCodePointBoundary(text: string, cut: number): number {
  if (
    cut > 0 &&
    cut < text.length &&
    isHighSurrogate(text.charCodeAt(cut - 1)) &&
    isLowSurrogate(text.charCodeAt(cut))
  ) {
    return cut + 1;
  }
  return cut;
}

function moveStartToCodePointBoundary(text: string, start: number): number {
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    return start + 1;
  }
  return start;
}

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
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP;

  if (!text) return [];
  // 只拦"无法切分"的非法值（<=0）。上下限（MIN/MAX_CHUNK_SIZE）**故意不在此拦**：
  // `group-index.json.source.chunkSize` 可能存着历史超界值，重建 / 编辑发布会复用
  // 它重新切分，硬抛会让老 scope 再也跑不起来。范围约束统一在各写入入口做。
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
    const cut = moveCutToCodePointBoundary(text, findBreakPoint(text, pos, chunkSize));
    if (cut <= pos) {
      // 防御：切分点无进展时强制推进（硬切）
      const hardCut = moveCutToCodePointBoundary(text, pos + chunkSize);
      chunks.push({ index, text: text.slice(pos, hardCut) });
      pos = hardCut;
    } else {
      chunks.push({ index, text: text.slice(pos, cut) });
      // overlap：下个 chunk 回退到 cut - overlap，与上一 chunk 尾部重叠
      // 保证推进：回退后的起点必须 > 当前 chunk 起点
      const nextStart = Math.max(pos + 1, cut - overlap);
      pos = moveStartToCodePointBoundary(text, nextStart);
    }
    index++;
  }

  return chunks;
}
