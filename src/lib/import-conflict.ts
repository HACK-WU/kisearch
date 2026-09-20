/**
 * import-conflict.ts —— 文档导入同名冲突策略。
 *
 * 冲突边界：同一 Group 下的 relation 名称。
 * 同一 sourcePath 优先命中，保持重复导入的幂等覆盖语义；只有不同
 * sourcePath 的同名文档才应用用户选择的冲突策略。
 */

import type { Relation } from './scoring.js';

export type ImportConflictMode = 'overwrite' | 'skip' | 'suffix';
export type ImportConflictAction = 'overwrite' | 'skip' | 'suffix';

export const DEFAULT_IMPORT_CONFLICT_MODE: ImportConflictMode = 'suffix';
export const DEFAULT_IMPORT_CONFLICT_SUFFIX = '_{n}';

export interface ImportConflictResolution {
  /** 最终写入 relations-cache/local KB 的 relation 名。 */
  relation: string;
  /** create 表示无冲突；其他 action 表示命中了已有 sourcePath 或同名 relation。 */
  action: 'create' | ImportConflictAction;
  /** 是否为不同 sourcePath 的真实同名冲突。 */
  conflicted: boolean;
  existing?: Relation;
}

export function validateImportConflictMode(value: string | undefined): ImportConflictMode {
  const mode = (value ?? DEFAULT_IMPORT_CONFLICT_MODE).trim();
  if (mode === 'overwrite' || mode === 'skip' || mode === 'suffix') return mode;
  throw new Error(`非法同名冲突策略：${mode}；允许值为 overwrite、skip、suffix`);
}

export function validateImportConflictSuffix(template: string | undefined): string {
  const value = (template ?? DEFAULT_IMPORT_CONFLICT_SUFFIX).trim();
  const placeholderCount = value.split('{n}').length - 1;
  if (!value || placeholderCount !== 1) {
    throw new Error('非法同名后缀模板：必须包含且只能包含一个 {n}，例如 _{n} 或 -副本_{n}');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error('非法同名后缀模板：不能包含 /、\\ 或 ..');
  }
  return value;
}

function renderSuffix(template: string, index: number): string {
  return template.replace('{n}', String(index));
}

/**
 * 在单个 Group 内解析文件级 relation 冲突。
 *
 * 先按 sourcePath 查找，确保已经通过 suffix 导入的文件再次导入时仍更新
 * 原 relation，而不是继续生成 _2、_3。
 */
export function resolveImportConflict(args: {
  relations: Relation[];
  baseRelation: string;
  sourcePath: string;
  mode?: string;
  suffix?: string;
}): ImportConflictResolution {
  const mode = validateImportConflictMode(args.mode);
  const suffix = validateImportConflictSuffix(args.suffix);
  const sameSource = args.relations.find((relation) => relation.sourcePath === args.sourcePath);
  if (sameSource) {
    return { relation: sameSource.text, action: 'overwrite', conflicted: false, existing: sameSource };
  }

  const sameName = args.relations.find((relation) => relation.text === args.baseRelation);
  if (!sameName) {
    return { relation: args.baseRelation, action: 'create', conflicted: false };
  }

  if (mode === 'skip') {
    return { relation: args.baseRelation, action: 'skip', conflicted: true, existing: sameName };
  }
  if (mode === 'overwrite') {
    return { relation: args.baseRelation, action: 'overwrite', conflicted: true, existing: sameName };
  }

  const occupied = new Set(args.relations.map((relation) => relation.text));
  for (let index = 1; index <= 100_000; index += 1) {
    const candidate = `${args.baseRelation}${renderSuffix(suffix, index)}`;
    if (!occupied.has(candidate)) {
      return { relation: candidate, action: 'suffix', conflicted: true, existing: sameName };
    }
  }
  throw new Error(`无法为文档 "${args.baseRelation}" 生成可用后缀：候选序号已超过 100000`);
}
