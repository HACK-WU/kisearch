/**
 * datasource-mappings.ts —— 「仓库子目录 → 落点 Group」映射的唯一实现（REQ-20261104-002）
 *
 * 为什么独立成模块：
 *  - 归一 / 校验 / 基线分桶三件事在 datasource（登记与同步）、mcp-http-api（HTTP 入口）、
 *    datasource-prune（删除前重算）三处必须**同口径**，各写一份必然漂移；
 *  - 本模块只依赖 `node:path` + `import-path`（同样零重依赖），可被单测直接驱动，
 *    不需要起引擎、不需要临时 KB。
 *
 * 语义（与需求文档一致）：
 *  - 一条映射 = 「扫哪个子目录」+「写到哪个 Group」；`subdir` 空串 = 仓库根；
 *  - `group` 为 null = 按该子目录内的顶层目录自动命名（沿用 resolveGroupForSource）；
 *  - 子目录之间**不允许互相包含**（根包含一切）：同一文件会被导入两次到两个 Group ⇒ 重复文档；
 *  - 多个子目录映射到**同一个 Group 是允许的**（用户 2026-11-04 拍板 Q3），同名文件按同名策略处理。
 */
import path from 'node:path';
import { isRootGroup, isUserAssignableGroup } from './import-path.js';
import type { DataSourceMappingItem } from './datasource-types.js';

/** 映射条数上限（Q6：超过请拆成多个 scope） */
export const MAX_DATASOURCE_MAPPINGS = 20;

const MAX_SUBDIR_LENGTH = 1024;

/**
 * 子目录：相对路径、无 .. / 反斜杠 / 空段 / .git 段；空字符串 = 仓库根。
 *
 * ★ 与 `datasource-clone.isSafeRelativeSubdir` 逐字节同义（那边 re-export 本实现），
 *   不要各写一份：两端口径分叉会出现「预检放行、同步拒绝」或反过来的分叉。
 */
export function isSafeRelativeSubdir(raw: string): boolean {
  const value = raw.trim();
  if (!value) return true;
  if (value.length > MAX_SUBDIR_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) return false;
  return true;
}

/** 归一子目录：去空白 + 去首尾斜杠；`.` → 仓库根 */
export function normalizeSubdir(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().replace(/^\/+|\/+$/g, '');
  return value === '.' ? '' : value;
}

/** 归一落点 Group：空串 → null（= 按顶层子目录自动） */
export function normalizeMappingGroup(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

/** 子目录 → 绝对目录（空串 = 仓库根） */
export function mappingTargetDir(repoRoot: string, subdir: string): string {
  const value = normalizeSubdir(subdir);
  if (!value) return repoRoot;
  return path.join(repoRoot, ...value.split('/'));
}

/**
 * 记录的映射列表（含旧记录兼容）。
 *
 * - `mappings` 是权威：非空数组时逐项归一（保留顺序，脏项丢弃）；
 * - 旧记录（`version:2`，只有单个 `git.relativeRoot` + `group`）合成 1 条，
 *   语义与升级前完全一致 —— 这是 R1 的落地口径；
 * - `mappings` 归一后为空（全部脏项）时**不静默降级成根映射**：仍退回旧字段推导，
 *   避免把"配置坏了"误当成"用户想要整仓库导入"。
 */
export function resolveMappings(input: {
  mappings?: unknown;
  /** 旧字段：git.relativeRoot（非 git 记录传 null） */
  relativeRoot?: string | null;
  /** 旧字段：落点 group */
  group?: string | null;
}): DataSourceMappingItem[] {
  const legacy: DataSourceMappingItem[] = [{
    subdir: normalizeSubdir(input.relativeRoot ?? ''),
    group: normalizeMappingGroup(input.group ?? null),
  }];
  if (!Array.isArray(input.mappings)) return legacy;
  const items: DataSourceMappingItem[] = [];
  for (const raw of input.mappings) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    items.push({
      subdir: normalizeSubdir(v.subdir ?? ''),
      group: normalizeMappingGroup(v.group ?? null),
    });
  }
  return items.length > 0 ? items : legacy;
}

/**
 * 归一**用户输入**的映射数组（HTTP body / 表单）。
 *
 * 与 `resolveMappings` 的分工：那个有"旧字段兜底"（记录读取用），这个**没有兜底** ——
 * 入口侧必须能区分「用户传了空/全脏数组」（要报错）与「用户没传」（保持原值）。
 * 返回 `null` = 不是数组（调用方按参数错误处理）。
 */
export function normalizeMappingInput(raw: unknown): DataSourceMappingItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DataSourceMappingItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    out.push({
      subdir: normalizeSubdir(v.subdir ?? ''),
      group: normalizeMappingGroup(v.group ?? null),
    });
  }
  return out;
}

/**
 * 从"记录形状"取映射（**容忍缺字段**）。
 *
 * 为什么不让调用方直接 `record.mappings`：归一由 `normalizeRecord` 保证，但
 * 测试夹具 / 旧快照 / 跨层传递的裸对象未必过归一，直读 `record.mappings.length`
 * 会抛 `Cannot read properties of undefined`（实测：`datasource-format` 6 例全挂）。
 * 缺字段时按旧字段合成 1 条，语义与 `normalizeRecord` 完全一致。
 */
export function mappingsOf(record: {
  mappings?: DataSourceMappingItem[] | null;
  git?: { relativeRoot?: string | null } | null;
  group?: string | null;
}): DataSourceMappingItem[] {
  return resolveMappings({
    mappings: record.mappings ?? undefined,
    relativeRoot: record.git?.relativeRoot ?? '',
    group: record.group ?? null,
  });
}

export type MappingErrorCode =
  | 'MAPPING_EMPTY'
  | 'MAPPING_LIMIT'
  | 'INVALID_SUBDIR'
  | 'INVALID_GROUP'
  | 'MAPPING_DUPLICATE'
  | 'MAPPING_OVERLAP';

export interface MappingIssue {
  code: MappingErrorCode;
  /** 面向用户、可直接渲染（含"第 N 条"定位） */
  error: string;
  /** 出问题的映射下标（0 基）；空目录等整体性问题时缺省 */
  index?: number;
  /** 与之冲突的另一条下标（重叠 / 重复时给出，供前端同时高亮两行） */
  conflictIndex?: number;
}

const label = (index: number): string => `第 ${index + 1} 条`;

/** 两个子目录是否互相包含（含"根包含一切"） */
function overlaps(a: string, b: string): boolean {
  const x = normalizeSubdir(a);
  const y = normalizeSubdir(b);
  if (!x || !y) return true; // 至少一方是仓库根 ⇒ 根包含一切
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * 映射合法性校验（HTTP 入口 / 登记 / 编辑保存共用）。
 *
 * 顺序固定：条数 → 逐条字段 → 重复 → 包含。**只返回第一个问题**——
 * 表单一次只需要指出一处，逐条弹错会把用户淹没。
 */
export function validateMappings(mappings: readonly DataSourceMappingItem[]): MappingIssue | null {
  if (mappings.length === 0) {
    return { code: 'MAPPING_EMPTY', error: '至少保留 1 条「子目录 → Group」映射' };
  }
  if (mappings.length > MAX_DATASOURCE_MAPPINGS) {
    return {
      code: 'MAPPING_LIMIT',
      error: `最多 ${MAX_DATASOURCE_MAPPINGS} 条映射（当前 ${mappings.length} 条），请拆成多个 Scope`,
    };
  }
  for (let i = 0; i < mappings.length; i += 1) {
    const item = mappings[i];
    const subdir = normalizeSubdir(item.subdir);
    if (!isSafeRelativeSubdir(subdir)) {
      return {
        code: 'INVALID_SUBDIR',
        index: i,
        error: `${label(i)}：非法仓库子目录「${item.subdir}」（不可为绝对路径、含 .. / 反斜杠 / .git 段；留空表示仓库根）`,
      };
    }
    const group = item.group;
    if (group !== null && group !== undefined && !isUserAssignableGroup(group)) {
      return {
        code: 'INVALID_GROUP',
        index: i,
        error: `${label(i)}：非法 Group 路径「${group}」（不可为绝对路径、含 .. / 反斜杠，或使用保留名 "__root__"）`,
      };
    }
    if (group && isRootGroup(group)) {
      return {
        code: 'INVALID_GROUP',
        index: i,
        error: `${label(i)}：Group 不能是保留名 "__root__"（根由「Group 留空」表达）`,
      };
    }
  }
  for (let i = 0; i < mappings.length; i += 1) {
    for (let j = i + 1; j < mappings.length; j += 1) {
      const a = normalizeSubdir(mappings[i].subdir);
      const b = normalizeSubdir(mappings[j].subdir);
      if (a === b) {
        return {
          code: 'MAPPING_DUPLICATE',
          index: i,
          conflictIndex: j,
          error: `${label(i)}与${label(j)} 的子目录相同（${a || '仓库根'}）；同一目录只需登记一次`,
        };
      }
      if (overlaps(a, b)) {
        const detail = !a || !b
          ? '仓库根会包含所有子目录'
          : `「${a}」包含「${b}」`;
        return {
          code: 'MAPPING_OVERLAP',
          index: i,
          conflictIndex: j,
          error: `${label(i)}与${label(j)} 的子目录互相包含（${detail}）；同一批文件会被导入两次并产生重复文档`,
        };
      }
    }
  }
  return null;
}

/**
 * 基线键：`subdir/rel`（子目录为仓库根时就是 `rel`）。
 *
 * ★ 为什么要分桶：`seenRels` 是"本数据源上次见过哪些文件"的判据，原先是相对 sourceDir 的裸路径。
 *   多映射下 `docs/guide/a.md` 与 `docs/api/a.md` 都会记成 `a.md` ⇒ 撞名 ⇒
 *   增量与待删候选互相污染（可能把在用文档列成待删）。
 */
export function seenRelKey(subdir: string, rel: string): string {
  const dir = normalizeSubdir(subdir);
  const clean = rel.replace(/^\/+/, '');
  return dir ? `${dir}/${clean}` : clean;
}

/**
 * 把扁平基线按映射切桶，返回与 `mappings` 等长的裸 rel 列表。
 *
 * 匹配规则：**最长子目录前缀胜**（`a/b` 优先于 `a`）；仓库根是长度 0 的兜底。
 * 用最长前缀而不是"顺序取第一个命中"，是因为「根 + 子目录」虽被 validateMappings 拒绝，
 * 但历史记录/手改文件仍可能出现，取最长前缀是唯一不会把文件算到错误桶里的选择。
 */
export function splitSeenRelsByMapping(
  seenRels: readonly string[],
  mappings: readonly DataSourceMappingItem[],
): string[][] {
  const buckets: string[][] = mappings.map(() => []);
  const dirs = mappings.map((item) => normalizeSubdir(item.subdir));
  for (const key of seenRels) {
    if (typeof key !== 'string' || !key) continue;
    let best = -1;
    let bestLen = -1;
    for (let i = 0; i < dirs.length; i += 1) {
      const dir = dirs[i];
      const hit = dir === '' ? true : (key === dir || key.startsWith(`${dir}/`));
      if (!hit) continue;
      if (dir.length > bestLen) {
        best = i;
        bestLen = dir.length;
      }
    }
    if (best < 0) continue; // 不属于任何映射（映射被删过）：不进任何桶，自然退化为"库中存在、本次没有"
    const dir = dirs[best];
    buckets[best].push(dir ? key.slice(dir.length + 1) : key);
  }
  return buckets;
}

/** 切桶的逆操作：把各映射的裸 rel 重新拼成扁平基线（合并 lastSync 时用） */
export function joinSeenRelsByMapping(
  mappings: readonly DataSourceMappingItem[],
  buckets: readonly string[][],
): string[] {
  const merged: string[] = [];
  mappings.forEach((item, index) => {
    for (const rel of buckets[index] ?? []) merged.push(seenRelKey(item.subdir, rel));
  });
  return merged.sort();
}

/** 映射展示：`（仓库根）` / `docs/guide` + 落点 */
export function describeMapping(item: DataSourceMappingItem): string {
  const subdir = normalizeSubdir(item.subdir) || '（仓库根）';
  return `${subdir} → ${item.group ?? '自动'}`;
}

/**
 * 两条映射列表是否等价（CLI 重复登记 / 编辑保存的幂等判据）。
 *
 * **顺序敏感**：`mappings[0]` 决定兼容位 `dir` / `group` / `git.relativeRoot`，
 * 顺序变了就是一次实质变更，不能只看集合相等。
 */
export function sameMappings(
  a: readonly DataSourceMappingItem[] | undefined,
  b: readonly DataSourceMappingItem[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((item, index) => normalizeSubdir(item.subdir) === normalizeSubdir(y[index].subdir)
    && normalizeMappingGroup(item.group) === normalizeMappingGroup(y[index].group));
}
