/**
 * scope-map.ts —— 主库 ↔ 图集库的**唯一**解析（设计 2026-11-27 S-01）
 *
 * 背景：一个主库（如 `kisearch`）对应一个图集库（如 `kisearch-atlas`）。
 * 图集包与导出的 md 副本都落图集库；主库页自动回落；图集库自动加入主库所在视图。
 *
 * 为什么必须只有一份：CLI（`ki atlas upload/link`）、Web（`useAtlasTargets`）、
 * AI（`ki_scope_list` / recall）三处都要知道这个映射。各写一份推导 →
 * 一旦命名不合约定就静默失配，而且排查时三个地方给出三个不同答案。
 *
 * 解析优先级（不可调换）：
 *   1. 传入名本身是某个映射的 value（已是图集库）→ 自指
 *   2. 传入名是映射的 key                     → 返回映射值
 *   3. 传入名以 `suffix` 结尾                  → 自指
 *   4. 其余                                   → `${name}${suffix}`
 */
import { validateScope } from '../scope.js';
import type { AtlasConfig, KiConfig } from '../config.js';

/** 归一后的映射（纯值，可直接序列化给前端 / daemon） */
export interface AtlasScopeMap {
  /** 主库 → 图集库（显式登记，优先于后缀） */
  mappings: Record<string, string>;
  /** 兜底后缀，默认 `-atlas` */
  suffix: string;
}

export const DEFAULT_ATLAS_SUFFIX = '-atlas';
const SUFFIX_MIN = 2;
const SUFFIX_MAX = 32;

/** 配置层非法（schema 管不到 map 的键值语义，故在这里 fail-loud） */
export class AtlasScopeMapError extends Error {
  readonly code = 'ATLAS_MAP_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AtlasScopeMapError';
  }
}

function normalizeSuffix(raw?: string): string {
  if (raw === undefined) return DEFAULT_ATLAS_SUFFIX;
  const suffix = String(raw);
  if (suffix.length < SUFFIX_MIN || suffix.length > SUFFIX_MAX) {
    throw new AtlasScopeMapError(
      `atlas.suffix 长度应为 ${SUFFIX_MIN}~${SUFFIX_MAX}，实际 "${suffix}"。` +
        `（图集库后缀，例如默认 ${DEFAULT_ATLAS_SUFFIX}）`,
    );
  }
  if (suffix.includes('/') || /\s/.test(suffix)) {
    throw new AtlasScopeMapError(`atlas.suffix 不能包含 "/" 或空白，实际 "${suffix}"`);
  }
  return suffix;
}

function normalizeMappings(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [main, atlas] of Object.entries(raw)) {
    // schema 已保证值类型为 string；这里兜住直接构造 config 对象（测试 / 内部调用）的路径
    if (typeof atlas !== 'string') {
      throw new AtlasScopeMapError(`atlas.mappings.${main} 的值必须是字符串`);
    }
    try {
      validateScope(main);
      validateScope(atlas);
    } catch (err) {
      throw new AtlasScopeMapError(
        `atlas.mappings 中的 scope 名非法（${main} → ${atlas}）：${(err as Error).message}`,
      );
    }
    out[main] = atlas;
  }
  return out;
}

/**
 * 环检测：从每个 key 沿 value 走，走出映射表即止；遇到本次路径上已出现的节点即判环。
 *
 * 环的后果是 `atlasScopeFor` 与 `mainScopeFor` 互相推导不停（或得到彼此矛盾的结果），
 * 必须在加载期直接拒绝，而不是运行期靠调用方兜底。
 */
function assertNoCycle(mappings: Record<string, string>): void {
  for (const start of Object.keys(mappings)) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = mappings[cur];
      if (cur !== undefined && seen.has(cur)) {
        throw new AtlasScopeMapError(
          `atlas.mappings 存在环：${[...path, cur].join(' → ')}。请删除环上的映射`,
        );
      }
    }
  }
}

/** 从配置解析归一映射；非法配置抛 {@link AtlasScopeMapError} */
export function resolveAtlasMap(config: KiConfig): AtlasScopeMap {
  const raw: AtlasConfig | undefined = config.atlas;
  const suffix = normalizeSuffix(raw?.suffix);
  const mappings = normalizeMappings(raw?.mappings);
  assertNoCycle(mappings);
  return { suffix, mappings };
}

/** 传入名是否已是某个主库的图集库 */
function isMappedAtlasScope(scope: string, map: AtlasScopeMap): boolean {
  return Object.prototype.hasOwnProperty.call(map.mappings, scope)
    ? false
    : Object.values(map.mappings).includes(scope);
}

/** 主库 → 图集库；已带后缀 / 已是映射值则自指 */
export function atlasScopeFor(mainScope: string, map: AtlasScopeMap): string {
  if (isMappedAtlasScope(mainScope, map)) return mainScope;
  const explicit = map.mappings[mainScope];
  if (explicit) return explicit;
  if (mainScope.endsWith(map.suffix) && mainScope.length > map.suffix.length) return mainScope;
  return `${mainScope}${map.suffix}`;
}

/** 图集库 → 主库；不是图集库返回 null */
export function mainScopeFor(atlasScope: string, map: AtlasScopeMap): string | null {
  for (const [main, atlas] of Object.entries(map.mappings)) {
    if (atlas === atlasScope) return main;
  }
  if (atlasScope.endsWith(map.suffix) && atlasScope.length > map.suffix.length) {
    return atlasScope.slice(0, -map.suffix.length);
  }
  return null;
}

/** 判断某 scope 是否图集库（前端展示名与上传按钮文案使用） */
export function isAtlasScope(scope: string, map: AtlasScopeMap): boolean {
  return mainScopeFor(scope, map) !== null;
}
