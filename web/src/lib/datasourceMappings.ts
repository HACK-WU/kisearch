/**
 * datasourceMappings.ts —— 「仓库子目录 → 落点 Group」的表单模型与校验（REQ-20261104-002）
 *
 * 为什么独立成纯函数模块：添加弹窗、编辑弹窗、列表列、详情参数区四处都要用同一套
 * 归一 / 校验 / 文案；写成组件内部逻辑会出现「弹窗拦住了、详情展示又不一样」。
 *
 * ★ 判据必须与后端 `src/lib/datasource-mappings.ts` **逐条对齐**（前端只做体验前置拦截，
 *   服务端仍是权威）。两边消息文案故意保持一致，避免同一问题两套说法。
 */

/** 一条映射（表单态：`group` 用空串表示「自动」，便于受控输入） */
export interface MappingRow {
  subdir: string;
  group: string;
}

/** 提交给服务端的形状（与后端 `DataSourceMappingItem` 一致） */
export interface MappingPayload {
  subdir: string;
  group: string | null;
}

export const MAX_MAPPINGS = 20;

const MAX_SUBDIR_LENGTH = 1024;

export function emptyRow(): MappingRow {
  return { subdir: '', group: '' };
}

/** 归一子目录：去空白 + 去首尾斜杠；`.` → 仓库根 */
export function normalizeSubdir(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().replace(/^\/+|\/+$/g, '');
  return value === '.' ? '' : value;
}

/** 子目录合法性（与后端 `isSafeRelativeSubdir` 同判据） */
export function isSafeSubdir(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (value.length > MAX_SUBDIR_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git');
}

/** Group 合法性（与后端 `isUserAssignableGroup` 同判据：路径安全 + 非根保留名） */
export function isAssignableGroup(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (value.split('/').includes('..')) return false;
  return value !== '__root__';
}

/** 服务端记录 → 表单行（旧记录没有 mappings 时按单值合成 1 条） */
export function rowsFromMappings(
  mappings: readonly MappingPayload[] | undefined,
  legacy?: { relativeRoot?: string | null; group?: string | null },
): MappingRow[] {
  const list: readonly MappingPayload[] = mappings && mappings.length > 0
    ? mappings
    : [{ subdir: legacy?.relativeRoot ?? '', group: legacy?.group ?? null }];
  return list.map((item) => ({ subdir: normalizeSubdir(item.subdir), group: item.group ?? '' }));
}

/** 表单行 → 提交负载 */
export function toMappingPayload(rows: readonly MappingRow[]): MappingPayload[] {
  return rows.map((row) => ({
    subdir: normalizeSubdir(row.subdir),
    group: row.group.trim() ? row.group.trim() : null,
  }));
}

export interface MappingValidationError {
  code: 'MAPPING_EMPTY' | 'MAPPING_LIMIT' | 'INVALID_SUBDIR' | 'INVALID_GROUP' | 'MAPPING_DUPLICATE' | 'MAPPING_OVERLAP';
  message: string;
  /** 出问题的行（0 基） */
  index?: number;
  /** 与之冲突的另一行 */
  conflictIndex?: number;
}

const labelOf = (index: number): string => `第 ${index + 1} 条`;

/** 两个子目录是否互相包含（含「仓库根包含一切」） */
function overlaps(a: string, b: string): boolean {
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 表单校验（只返回第一个问题：逐个弹错会把用户淹没）。
 * 顺序与后端一致：条数 → 逐条字段 → 重复 → 包含。
 */
export function validateMappingRows(rows: readonly MappingRow[]): MappingValidationError | null {
  if (rows.length === 0) {
    return { code: 'MAPPING_EMPTY', message: '至少保留 1 条「子目录 → Group」映射' };
  }
  if (rows.length > MAX_MAPPINGS) {
    return { code: 'MAPPING_LIMIT', message: `最多 ${MAX_MAPPINGS} 条映射（当前 ${rows.length} 条），请拆成多个 Scope` };
  }
  for (let i = 0; i < rows.length; i += 1) {
    const subdir = normalizeSubdir(rows[i].subdir);
    if (!isSafeSubdir(subdir)) {
      return {
        code: 'INVALID_SUBDIR',
        index: i,
        message: `${labelOf(i)}：非法仓库子目录「${rows[i].subdir}」（不可为绝对路径、含 .. / 反斜杠 / .git 段；留空表示仓库根）`,
      };
    }
    if (!isAssignableGroup(rows[i].group)) {
      return {
        code: 'INVALID_GROUP',
        index: i,
        message: `${labelOf(i)}：非法 Group 路径「${rows[i].group}」（不可为绝对路径、含 .. / 反斜杠，或使用保留名 "__root__"）`,
      };
    }
  }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = normalizeSubdir(rows[i].subdir);
      const b = normalizeSubdir(rows[j].subdir);
      if (a === b) {
        return {
          code: 'MAPPING_DUPLICATE',
          index: i,
          conflictIndex: j,
          message: `${labelOf(i)}与${labelOf(j)} 的子目录相同（${a || '仓库根'}）；同一目录只需登记一次`,
        };
      }
      if (overlaps(a, b)) {
        const detail = !a || !b ? '仓库根会包含所有子目录' : `「${a}」包含「${b}」`;
        return {
          code: 'MAPPING_OVERLAP',
          index: i,
          conflictIndex: j,
          message: `${labelOf(i)}与${labelOf(j)} 的子目录互相包含（${detail}）；同一批文件会被导入两次并产生重复文档`,
        };
      }
    }
  }
  return null;
}

/** 表单是否与已保存值等价（决定「保存」按钮是否可点） */
export function mappingRowsEqual(
  a: readonly MappingRow[],
  b: readonly MappingPayload[] | undefined,
  legacy?: { relativeRoot?: string | null; group?: string | null },
): boolean {
  const left = toMappingPayload(a);
  const right = toMappingPayload(rowsFromMappings(b, legacy));
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.subdir === right[index].subdir && item.group === right[index].group);
}

/**
 * 落点配置区该用哪种形态（REQ-20261104-002 修复：目录源不该出现映射表）。
 *
 * - `editor`：Git 源且 daemon 支持多映射 → 可增删改的映射表；
 * - `single`：**普通目录源** → 只有一个落点 Group（子目录映射对它没有含义，
 *   后端也会以 `INVALID_SUBDIR` 拒绝），渲染成单行只读；
 * - `readonly`：旧 daemon 不下发 `mappings` → 只读展示并提示升级（不做假功能）。
 *
 * ★ 别退回「`mappings !== undefined` 就出编辑器」：`normalizeRecord` 对**所有**记录
 *   都会填 `mappings`（目录源得到 1 条根映射），那样目录源又会冒出三列映射表。
 */
export type MappingUiMode = 'editor' | 'single' | 'readonly';

/** 是否 Git 源：旧 daemon 可能不返回 `type`，有 `git` 元信息同样按 Git 处理 */
function isGitSource(record: { type?: string; git?: unknown }): boolean {
  return record.type === 'git' || record.git !== undefined;
}

export function mappingUiMode(record: {
  type?: string;
  git?: unknown;
  mappings?: unknown;
}): MappingUiMode {
  // 目录源永远只有一个落点（与 daemon 版本无关）——先判类型，不能先判 mappings，
  // 否则旧 daemon 的目录源会落到「升级后就能增删映射」的误导文案上
  if (!isGitSource(record)) return 'single';
  if (record.mappings === undefined) return 'readonly';
  return 'editor';
}

/**
 * 基本信息里的「源类型」文案。
 *
 * ★ 必须与 `mappingUiMode` **解耦**：旧 daemon 的 Git 源 `mappingUiMode` 是 `readonly`，
 *   若用"能否编辑映射"反推类型，就会把它显示成「普通目录」（2026-11-04 自查发现）。
 */
export function sourceTypeLabel(record: { type?: string; git?: unknown }): 'Git 仓库' | '普通目录' {
  return isGitSource(record) ? 'Git 仓库' : '普通目录';
}

/** 子目录展示：空 = 仓库根 */
export function subdirLabel(subdir: string): string {
  return normalizeSubdir(subdir) || '（仓库根）';
}

/** 落点展示：null = 自动 */
export function groupLabel(group: string | null): string {
  return group && group.trim() ? group : '自动：按顶层子目录';
}

/**
 * 列表「落点 Group」列的文案（R7）。
 * 1 条：显示原值（保持旧观感）；≥2 条：`N 个映射`，完整映射进 title。
 */
export function summarizeGroupColumn(
  mappings: MappingPayload[] | undefined,
  legacyGroup?: string | null,
): { text: string; title: string } {
  const list = mappings && mappings.length > 0
    ? mappings
    : [{ subdir: '', group: legacyGroup ?? null }];
  if (list.length === 1) {
    const group = list[0].group ?? null;
    const text = group ? group : '(自动)';
    return { text, title: text };
  }
  const title = list.map((item) => `${subdirLabel(item.subdir)} → ${item.group ?? '自动'}`).join('\n');
  return { text: `${list.length} 个映射`, title };
}
