/**
 * import-conflict.ts —— 文档导入同名冲突策略。
 *
 * 冲突边界：同一 Group 下的 relation 名称。
 * 判定优先级（2026-10-10 REQ-20261010-001 R2 修订）：
 *   1. 与**库中已有**关系同 sourcePath → 幂等覆盖（重导更新语义，优先级最高）；
 *   2. **本批内**重复 rel **不算幂等覆盖**，与"同名不同来源"同等对待 → 交给所选
 *      策略处理（此前它会命中 ①，使 skip / suffix 全部失效，且"覆盖"是用户没选过的
 *      行为）。注：旧实现并未因此产生孤儿向量——import.ts 命中 overwrite 时会丢弃
 *      本批先前的同 relation 记录，本项修正的是"策略被截胡"而非孤儿向量。
 *      另：Web 上传层对同批同名文件本就 fail-loud（见 mcp-http-api 的重复相对路径校验），
 *      故本项属防御性修正，正常路径不可达；
 *   3. 无冲突 → 新建。
 */

import type { Relation } from './scoring.js';

export type ImportConflictMode = 'incremental' | 'overwrite' | 'skip' | 'suffix';
export type ImportConflictAction = 'overwrite' | 'skip' | 'suffix';

/**
 * 默认策略（2026-10-10 REQ-20261010-001 D9：CLI 与 Web 同默认）= 增量导入。
 * 语义：同 sourcePath 重复导入时，内容未变则跳过重算、内容变了照常覆盖；
 * 对"同名不同 sourcePath"与同批重复 rel **一律按覆盖处理**（不引入后缀副本）。
 */
export const DEFAULT_IMPORT_CONFLICT_MODE: ImportConflictMode = 'incremental';
export const DEFAULT_IMPORT_CONFLICT_SUFFIX = '_{n}';

export interface ImportConflictResolution {
  /** 最终写入 relations-cache/local KB 的 relation 名。 */
  relation: string;
  /** create 表示无冲突；其他 action 表示命中了已有 sourcePath 或同名 relation。 */
  action: 'create' | ImportConflictAction;
  /** 是否为不同 sourcePath 的真实同名冲突。 */
  conflicted: boolean;
  /**
   * 本次的"名字/来源冲突"是否来自**本批已计划项**（同一次导入内）——包含两种：
   * ① 本批已有同 sourcePath（同一文件在本批出现两次）；
   * ② 本批已占用 baseRelation 名（如剥离顶层段后 `a/foo.md` 与 `b/foo.md`）。
   * 用于观测与测试；调用方丢弃"被覆盖者"仍按 `group + relation` 定位（见 import.ts）。
   */
  conflictFromBatch: boolean;
  existing?: Relation;
}

export function validateImportConflictMode(value: string | undefined): ImportConflictMode {
  const mode = (value ?? DEFAULT_IMPORT_CONFLICT_MODE).trim();
  if (mode === 'incremental' || mode === 'overwrite' || mode === 'skip' || mode === 'suffix') return mode;
  throw new Error(`非法同名冲突策略：${mode}；允许值为 incremental、overwrite、skip、suffix`);
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
 * @param args.relations      库中已有关系（该 Group 分片）
 * @param args.batchRelations 本批已计划关系（同 Group）——参与"名字是否被占"的判定，
 *   但**不**参与"同 sourcePath → 幂等覆盖"的短路（同批重复 rel 视为撞名）
 */
export function resolveImportConflict(args: {
  relations: Relation[];
  batchRelations?: Relation[];
  baseRelation: string;
  sourcePath: string;
  mode?: string;
  suffix?: string;
}): ImportConflictResolution {
  const mode = validateImportConflictMode(args.mode);
  const suffix = validateImportConflictSuffix(args.suffix);
  const batch = args.batchRelations ?? [];
  // 先按 sourcePath 在**库中**查找，确保已经通过 suffix 导入的文件再次导入时仍更新
  // 原 relation，而不是继续生成 _2、_3。
  const sameSource = args.relations.find((relation) => relation.sourcePath === args.sourcePath);
  if (sameSource) {
    return { relation: sameSource.text, action: 'overwrite', conflicted: false, conflictFromBatch: false, existing: sameSource };
  }

  // 本批内重复 rel：不再走幂等覆盖（否则 skip/suffix 全部失效、且产生孤儿向量），
  // 而是与"同名不同来源"同等对待——由下方按用户所选策略处理。
  const conflictFromBatch = batch.some((relation) => relation.sourcePath === args.sourcePath)
    || batch.some((relation) => relation.text === args.baseRelation);
  const occupied = new Map<string, Relation>();
  for (const relation of args.relations) occupied.set(relation.text, relation);
  for (const relation of batch) if (!occupied.has(relation.text)) occupied.set(relation.text, relation);
  const sameName = occupied.get(args.baseRelation);
  if (!sameName) {
    return { relation: args.baseRelation, action: 'create', conflicted: false, conflictFromBatch };
  }

  // 增量导入对"同名不同来源"的处理 = **直接覆盖**（用户 2026-10-10 拍板：不搞后缀兜底，
  // "管他同源不同源"）。于是 incremental ≡ overwrite + 「内容未变则跳过重算」，
  // 两者差异收敛为一处：未变内容是否重做（扫描阶段判定）。后缀模板只在 suffix 模式有意义。
  //
  // ⚠️ 与上传层的耦合（challenger 2026-10-10）：正常路径下本分支的"覆盖"**不可达**——
  // mcp-http-api 对同批同名文件本就 fail-loud（「当前请求包含重复相对路径」/「暂存文件已存在
  // 且内容不同」），两组同名文件不会同时进入一次导入。若将来放开上传去重，覆盖会**静默丢掉
  // 先到者**，必须在那一刻补守卫（拒绝或显式提示），不能沿用本注释假设。
  const effectiveMode: ImportConflictAction = mode === 'incremental' ? 'overwrite' : mode;
  if (effectiveMode === 'skip') {
    return { relation: args.baseRelation, action: 'skip', conflicted: true, conflictFromBatch, existing: sameName };
  }
  if (effectiveMode === 'overwrite') {
    return { relation: args.baseRelation, action: 'overwrite', conflicted: true, conflictFromBatch, existing: sameName };
  }

  for (let index = 1; index <= 100_000; index += 1) {
    const candidate = `${args.baseRelation}${renderSuffix(suffix, index)}`;
    if (!occupied.has(candidate)) {
      return { relation: candidate, action: 'suffix', conflicted: true, conflictFromBatch, existing: sameName };
    }
  }
  throw new Error(`无法为文档 "${args.baseRelation}" 生成可用后缀：候选序号已超过 100000`);
}
