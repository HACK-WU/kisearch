/**
 * 数据源「编辑同步参数」表单：纯函数（表单转换 / 校验 / 差异裁剪），与弹窗解耦便于单测。
 *
 * 口径：身份字段（scope / 源目录 / Git URL / 分支 / 子目录 / 落点 Group）**不可编辑**，
 * 编辑只覆盖同名策略 / 向量化 / 切分参数；后端 `POST /api/datasource/update` 只接受这四个。
 */
import type { DataSourceRecordView, UpdateDataSourceConfigInput } from '@/api/httpApi';

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 150;

// 取值范围与后端 `src/lib/chunker.ts` 同源（web 与 src 是两套 tsconfig，无法跨目录 import，
// 故此处复制一份；改任一侧必须同步另一侧，否则会出现"前端放行、后端拒绝"的分叉）。
/** 段长硬下限：再小语义不完整、chunk 数成倍上涨 */
export const MIN_CHUNK_SIZE = 100;
/** 段长硬上限：中文 4000 字符 ≈ 3000 token，配 1024 维已明显稀释语义 */
export const MAX_CHUNK_SIZE = 4000;
/** 重叠硬上限；下限为 0（不重叠） */
export const MAX_CHUNK_OVERLAP = 500;
/** 建议区间（只用于提示，不阻塞）：低于 500 语义偏碎，高于 2000 检索偏粗 */
export const SUGGESTED_CHUNK_SIZE_MIN = 500;
export const SUGGESTED_CHUNK_SIZE_MAX = 2000;

export const CONFLICT_OPTIONS: { value: string; label: string }[] = [
  { value: 'incremental', label: '增量（同名覆盖）' },
  { value: 'overwrite', label: '覆盖已有文档' },
  { value: 'skip', label: '跳过同名文档' },
  { value: 'suffix', label: '自动添加后缀' },
];

export interface EditConfigForm {
  conflictMode: string;
  conflictSuffix: string;
  vector: boolean;
  /** '' = 使用默认值（1000 / 150） */
  chunkSize: string;
  chunkOverlap: string;
}

export function formFromRecord(record: DataSourceRecordView): EditConfigForm {
  return {
    conflictMode: record.conflictMode || 'incremental',
    conflictSuffix: record.conflictSuffix || '_{n}',
    vector: record.vector !== false,
    chunkSize: record.chunkSize === null || record.chunkSize === undefined ? '' : String(record.chunkSize),
    chunkOverlap: record.chunkOverlap === null || record.chunkOverlap === undefined ? '' : String(record.chunkOverlap),
  };
}

export interface ChunkValidation {
  ok: boolean;
  field?: 'chunkSize' | 'chunkOverlap';
  message?: string;
}

/**
 * 与后端同口径：留空 = 默认（1000 / 150）；段长 100–4000、重叠 0–500；
 * 重叠必须小于段长。
 *
 * `base` 传**存量基准值**（`formFromRecord(record)`）：值没被改动时**跳过范围校验**。
 * 原因：后端旧版只校验 ">0"、无上界，库里可能存着 5000 这类超界值；若按范围硬判，
 * 用户在弹窗里只想改「同名策略」也会被历史值拦住、整条配置改不动。
 */
export function validateChunkFields(
  chunkSize: string,
  chunkOverlap: string,
  base?: Pick<EditConfigForm, 'chunkSize' | 'chunkOverlap'>,
): ChunkValidation {
  const parse = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
  const size = parse(chunkSize);
  const overlap = parse(chunkOverlap);
  const sizeUnchanged = base !== undefined && chunkSize === base.chunkSize;
  const overlapUnchanged = base !== undefined && chunkOverlap === base.chunkOverlap;
  // 类型约束始终生效（存量值必然是整数，不会误伤）
  if (size !== null && (!Number.isInteger(size) || size <= 0)) {
    return { ok: false, field: 'chunkSize', message: '段长必须为正整数（留空 = 默认 1000）' };
  }
  if (overlap !== null && (!Number.isInteger(overlap) || overlap < 0)) {
    return { ok: false, field: 'chunkOverlap', message: '重叠必须为非负整数（留空 = 默认 150）' };
  }
  // 范围约束只对**本次改动过的值**生效
  if (size !== null && !sizeUnchanged && (size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE)) {
    return {
      ok: false,
      field: 'chunkSize',
      message: `段长需在 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE} 之间（当前 ${size}）；`
        + `建议 ${SUGGESTED_CHUNK_SIZE_MIN}–${SUGGESTED_CHUNK_SIZE_MAX}`,
    };
  }
  if (overlap !== null && !overlapUnchanged && overlap > MAX_CHUNK_OVERLAP) {
    return {
      ok: false,
      field: 'chunkOverlap',
      message: `重叠需不超过 ${MAX_CHUNK_OVERLAP}（当前 ${overlap}）`,
    };
  }
  const effSize = size ?? DEFAULT_CHUNK_SIZE;
  const effOverlap = overlap ?? DEFAULT_CHUNK_OVERLAP;
  if (effOverlap >= effSize) {
    return { ok: false, field: 'chunkOverlap', message: `重叠（${effOverlap}）必须小于段长（${effSize}）` };
  }
  return { ok: true };
}

/**
 * 存量值的「已超出范围但本次未改」提醒（软提示，**不阻塞保存**）。
 *
 * 旧版数据源参数没有上下限，库里可能存着 6000 这类值。`validateChunkFields` 对未改动的
 * 存量值放行（否则用户只想改「同名策略」也会被拦住），但**不等于它合规** —— 不提示的话
 * 用户看到输入框里 6000 与提示里的 "100–4000" 并存，会以为一切正常。
 * 真正越界的**新输入**仍由 `validateChunkFields` 硬拦，这里只负责让存量值可见。
 */
export function chunkRangeNotice(
  chunkSize: string,
  chunkOverlap: string,
  base: Pick<EditConfigForm, 'chunkSize' | 'chunkOverlap'>,
): string | null {
  const parse = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
  const size = parse(chunkSize);
  const overlap = parse(chunkOverlap);
  const outOfRange: string[] = [];
  if (
    size !== null && Number.isInteger(size) && chunkSize === base.chunkSize
    && (size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE)
  ) {
    outOfRange.push(`段长 ${size}（应 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE}）`);
  }
  if (
    overlap !== null && Number.isInteger(overlap) && chunkOverlap === base.chunkOverlap
    && (overlap < 0 || overlap > MAX_CHUNK_OVERLAP)
  ) {
    outOfRange.push(`重叠 ${overlap}（应 0–${MAX_CHUNK_OVERLAP}）`);
  }
  if (outOfRange.length === 0) return null;
  return `沿用着超出范围的历史值：${outOfRange.join('、')}；不影响保存其它项，建议一并改到 `
    + `${SUGGESTED_CHUNK_SIZE_MIN}–${SUGGESTED_CHUNK_SIZE_MAX}`;
}

function chunkValue(raw: string): number | null {
  return raw.trim() === '' ? null : Number(raw);
}

/** 只返回与基准不同的字段（全等 = 空对象，调用方据此跳过请求） */
export function buildConfigPatch(
  base: DataSourceRecordView,
  form: EditConfigForm,
): UpdateDataSourceConfigInput['patch'] {
  const baseForm = formFromRecord(base);
  const patch: UpdateDataSourceConfigInput['patch'] = {};
  if (form.conflictMode !== baseForm.conflictMode) patch.conflictMode = form.conflictMode;
  if (form.conflictSuffix !== baseForm.conflictSuffix) patch.conflictSuffix = form.conflictSuffix;
  if (form.vector !== baseForm.vector) patch.vector = form.vector;
  const size = chunkValue(form.chunkSize);
  const overlap = chunkValue(form.chunkOverlap);
  if (size !== chunkValue(baseForm.chunkSize)) patch.chunkSize = size;
  if (overlap !== chunkValue(baseForm.chunkOverlap)) patch.chunkOverlap = overlap;
  return patch;
}

export function isConfigDirty(base: DataSourceRecordView, form: EditConfigForm): boolean {
  return Object.keys(buildConfigPatch(base, form)).length > 0;
}
