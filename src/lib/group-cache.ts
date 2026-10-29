/**
 * group-cache.ts —— per-Group relation-cache 分片存储原语（REQ-20260930-002 批次 2，S0-5 正解）
 *
 * 设计（.plans/2026-10-08-stage0-batch2-relation-cache-split/design.md v1）：
 *   <scope>/<RELATIONS_ROOT_DIR>/<groupPath>/cache.json  每组一份元数据分片（镜像 local-kb 布局，
 *                                                        根目录用保留名，见常量注释）
 *   <scope>/<RELATIONS_ROOT_DIR>/manifest.json           scope 级 manifest（partition_config + revision）
 *
 * 读写语义：
 *   - 分片 schema：{ version, scope, hot_relations: Relation[], keywords: [], updatedAt }
 *     Relation 结构与旧 relations-cache.json 的 groups[g].hot_relations[] 完全同构。
 *   - 写路径唯一入口 writeGroupCache / writeGroupCacheBatch：三步曲（护栏 #2）
 *     ① bumpManifestRevision ② walWrite 分片 ③ invalidateScopeCaches
 *     批操作（import 多组）共享一次 bump + 一次失效，避免 manifest 写放大。
 *   - 缓存身份：manifest 的 (mtimeMs, size, revision) 三元组——替代旧"单文件 mtime+size"。
 *     进程内写后主动失效；跨进程（CLI 与 daemon 并发）由 revision 变化兜底。
 *   - 双读兼容（惰性迁移）：读优先新布局；仅旧存在则读旧；写路径遇旧布局首写自动
 *     转换该 scope（读旧全量→写新分片+manifest→旧文件改名 .bak 保留）。
 *   - **键不变量**：组键原样进分片路径，不做前缀改写——同一个 groupPath 同时是
 *     group-index 树路径与 local-kb 目录路径，单侧改写即分叉（第二轮审查 P0）。
 *     若 `项目根` 确为历史虚拟根，唯一合法的剥离时机是它同时从树里消失的那次迁移
 *     （store.ts roots→groups，配对动作为 renameGroupCacheShards）。
 *
 * 本模块只做存储原语，不感知业务（评分/搜索/导出）；业务消费方经 loadGroupCache /
 * readAllGroupCaches / writeGroupCache* 使用。类型 Relation 来自 scoring.js（与旧结构同源）。
 */

import fs from 'fs';
import path from 'path';
import { getKbDir, getRelationsCachePath, validateScope } from './scope.js';
import { readJson, writeJson } from './store.js';
import { walWrite } from './wal.js';
import { DEFAULT_PARTITION_CONFIG, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';

// ─── 布局与路径 ─────────────────────────────────────────

/**
 * 分片根目录名（保留名）：`<scope>/.relations/`。
 *
 * 为什么不用 `relations/`（批次 2 审查 P1-8）：local-kb 的组目录是
 * `<scope>/<groupPath>/index.json`，与分片根同域。若存在顶层名为 `relations` 的
 * Group（用户导入目录恰好有 `relations/` 子目录即可产生），delete-relation 的
 * 「递归删该组 KB 目录」会把 `<scope>/relations/` 整个删掉 —— manifest 与所有组的
 * 分片随之消失（不可逆）。改用点号前缀保留名后，任何组名都不会与该目录同路径
 * （导入扫描本就跳过点号开头目录，见 import.ts collectMarkdownFiles）。
 */
export const RELATIONS_ROOT_DIR = '.relations';

/** 分片根目录：<scope>/.relations/ */
export function getRelationsRoot(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), RELATIONS_ROOT_DIR);
}

/** manifest 路径：<scope>/.relations/manifest.json */
export function getRelationsManifestPath(scope: string): string {
  return path.join(getRelationsRoot(scope), 'manifest.json');
}

/**
 * 判断某目录是否为该 scope 的分片根（delete-relation 等破坏性路径的护栏：
 * 即使未来出现与保留名同名的 Group，也不允许递归删除分片根）。
 */
export function isRelationsRootPath(scope: string, dirPath: string): boolean {
  return path.resolve(dirPath) === path.resolve(getRelationsRoot(scope));
}

/**
 * 分片文件路径：<scope>/.relations/<groupPath>/cache.json（镜像 local-kb 布局，根目录为保留名）。
 *
 * ⚠️ **不变量（第二轮审查 P0 修复，2026-10-09）**：组键**原样**作为路径段，
 * 不做任何前缀改写。原因是同一个 groupPath 同时是三处的坐标系：
 *   ① group-index 树的节点路径　② local-kb 目录（`<kb>/<groupPath>/index.json`）
 *   ③ 分片目录
 * 只改写其中一处（早期实现无条件剥 `项目根/`）会让三处分叉 →
 * `export` 静默导出 0 条、`query-group` 报「暂无 Relations」、`delete-group`
 * 收集不到 relation（向量/FTS 残留）且分片不删、单条 `delete-relation`
 * 报 ok 但 cacheRemoved=false（实测见 `temp/repro-prefix-*.ts`）。
 * 另外「剥前缀」是非单射映射：组 `项目根/X` 与 `X` 会撞同一分片并互相覆盖。
 *
 * `项目根` 若真是历史虚拟根，唯一合法的剥离时机是它**同时**从树里消失的时刻——
 * 即 `store.ts` 的 `roots → groups` 迁移（`migrateRelationsCacheKeys`，那里会
 * 连带把分片一起改名，见 `renameGroupCacheShards`）。
 */
export function getGroupCachePath(scope: string, groupPath: string): string {
  validateScope(scope);
  const root = getRelationsRoot(scope);
  // 双锚点校验（复用 getAssetsDir/getScopeCollectionPath 模式）：原样 join
  // 会搬移锚点 → 拒绝绝对路径与含 .. / . / 空段（合法 groupPath 为干净相对路径段序列）
  if (path.isAbsolute(groupPath) || groupPath.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`非法的 Group 路径（拒绝路径穿越）：${groupPath}`);
  }
  const target = path.join(root, groupPath, 'cache.json');
  // 复核 join 结果仍在分片根之下（段校验之外的兜底）
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Group 路径越界：${groupPath}`);
  }
  return target;
}

// ─── 类型 ───────────────────────────────────────────────

/** 分片文件结构（design.md §2；keywords 恒空保留字段——决策 #3） */
export interface GroupCacheDoc {
  version: number;
  scope: string;
  hot_relations: Relation[];
  keywords: string[];
  updatedAt?: string | null;
}

/** manifest 结构（design.md §3） */
export interface RelationsManifest {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  /** 缓存身份：单调递增，每次写操作批前 +1 */
  revision: number;
  updatedAt?: string | null;
}

/** 缓存身份戳：manifest (mtimeMs, size, revision)；不存在时 null（= 无新布局） */
export interface RelationsCacheIdentity {
  mtimeMs: number;
  size: number;
  revision: number;
}

// ─── 失效广播 ───────────────────────────────────────────

/**
 * scope 缓存失效回调注册表（daemon 进程内主动失效；跨进程靠 revision 兜底）。
 * 消费方注册：docListCache / relation-map / scopeDocCountCache / hiddenEditIndexIds。
 */
type InvalidateListener = (scope: string) => void;
const invalidateListeners = new Set<InvalidateListener>();

/** 注册失效监听（模块加载期注册一次；幂等） */
export function onScopeRelationsInvalidated(listener: InvalidateListener): void {
  invalidateListeners.add(listener);
}

function invalidateScopeCaches(scope: string): void {
  for (const listener of invalidateListeners) {
    try {
      listener(scope);
    } catch {
      // 单个消费方失效失败不阻断其他消费方与写路径本身；
      // 该消费方仍有 manifest revision 兜底（下次读缓存时身份不匹配即重算）
    }
  }
}

/**
 * 外部触发的 scope 缓存失效广播（W7：restore 覆盖 scope 目录后调用——
 * 快照数据替换了 relations 分片/manifest，daemon 进程内的
 * docListCache/relation-map/scopeDocCountCache 等必须立即失效，
 * 不能等下次读时靠身份戳兜底——design.md §6 B1/B2 场景）。
 */
export function notifyScopeRelationsInvalidated(scope: string): void {
  invalidateScopeCaches(scope);
}

// ─── manifest ───────────────────────────────────────────

/** 读取 manifest；不存在返回 null（= 尚未迁移/未初始化新布局）。
 *  **文件存在但结构不可用** → 抛错（fail-loud）。
 *  第二轮审查 P2 修复：原实现静默返回 null → `loadPartitionConfig` 退回默认
 *  `halfLifeHours`（全库评分跳变）、`ensureManifest` 把 revision 归零并丢弃
 *  partition_config，且与 `getRelationsCacheIdentity` 的 fail-loud 口径矛盾。 */
export function readRelationsManifest(scope: string): RelationsManifest | null {
  const manifestPath = getRelationsManifestPath(scope);
  if (!fs.existsSync(manifestPath)) return null;
  const data = readJson<RelationsManifest>(manifestPath);
  if (!data || typeof data !== 'object' || typeof data.revision !== 'number' || Number.isNaN(data.revision)) {
    throw new Error(`relations manifest 损坏（缺少有效 revision）：${manifestPath}`);
  }
  return {
    ...data,
    partition_config: data.partition_config ?? DEFAULT_PARTITION_CONFIG,
  };
}

/** 两种布局是否都无 relations 数据（= scope 尚未初始化）。用于区分「空库」与「读失败」。 */
export function hasNoRelationsData(scope: string): boolean {
  return !hasShardedLayout(scope) && !fs.existsSync(getRelationsCachePath(scope));
}

/**
 * 缓存身份戳（批次 2 R6-R10 统一失效锚）：布局感知三元组。
 * - 新布局：manifest 的 (mtimeMs, size, revision)
 * - 旧布局：relations-cache.json 的 (mtimeMs, size)，revision = -1 哨兵
 * - 两者皆无：null（scope 无 relations 数据，消费方按空数据语义处理）
 *
 * 布局转换（惰性迁移）必然使三元组变化（-1 → 0+），消费方缓存自动失效；
 * 任一写路径 bump revision 同样改变三元组（跨进程失效兜底）。
 * manifest 文件存在但解析失败时抛错（fail-loud：WAL 写保证该情形理论不可达，
 * 若真发生宁可拒绝服务也不静默回退读旧文件造成 stale）。
 */
export function getRelationsCacheIdentity(scope: string): RelationsCacheIdentity | null {
  const manifestPath = getRelationsManifestPath(scope);
  let manifestStat: fs.Stats | null = null;
  try {
    manifestStat = fs.statSync(manifestPath);
  } catch { /* 无 manifest → 旧布局判定 */ }
  if (manifestStat) {
    // readRelationsManifest 自身 fail-loud（结构不可用即抛错），此处只需取三元组
    const manifest = readRelationsManifest(scope);
    if (!manifest) {
      throw new Error(`relations manifest 损坏：${manifestPath}`);
    }
    return { mtimeMs: manifestStat.mtimeMs, size: manifestStat.size, revision: manifest.revision };
  }
  const cachePath = getRelationsCachePath(scope);
  try {
    const stat = fs.statSync(cachePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size, revision: -1 };
  } catch {
    return null;
  }
}

/** 初始化（或重建）manifest：保留既有 partition_config / 取最大 revision */
function ensureManifest(scope: string): RelationsManifest {
  const existing = readRelationsManifest(scope);
  if (existing) return existing;
  return {
    version: 1,
    scope,
    partition_config: { ...DEFAULT_PARTITION_CONFIG },
    revision: 0,
  };
}

/**
 * bump revision（WAL 原子）。批操作开头调用一次；批内其余写分片不再 bump。
 * @returns bump 后的 revision
 */
function bumpManifestRevision(scope: string): number {
  const manifest = ensureManifest(scope);
  const next: RelationsManifest = { ...manifest, revision: manifest.revision + 1 };
  walWrite(getRelationsManifestPath(scope), next as unknown as Record<string, unknown>);
  return next.revision;
}

// ─── 双读：新布局读取 + 旧布局 fallback ─────────────────

/** 新布局是否已就位（manifest 存在即视为新布局生效） */
export function hasShardedLayout(scope: string): boolean {
  return fs.existsSync(getRelationsManifestPath(scope));
}

/** 旧单文件布局是否存在（未改名 .bak 的原文件） */
function hasLegacyLayout(scope: string): boolean {
  return fs.existsSync(getRelationsCachePath(scope));
}

/**
 * 旧布局组数据形状归一（**只补字段、不改键**）。
 *
 * 第二轮审查 P0 修复：原实现顺带剥 `项目根/` 前缀并做同名合并——但对象键天然唯一，
 * 「同名合并」只可能由剥离本身制造；而剥离会让分片键与树/KB 分叉（且 `项目根/X`
 * 与 `X` 是两个不同的合法组，不该合并）。键改名只发生在树同时被提升的
 * `store.ts` roots→groups 迁移里。
 */
function sanitizeLegacyGroups(groups: Record<string, { hot_relations?: Relation[]; keywords?: string[] }>): Record<string, { hot_relations: Relation[]; keywords: string[] }> {
  const clean: Record<string, { hot_relations: Relation[]; keywords: string[] }> = {};
  for (const [key, data] of Object.entries(groups)) {
    if (!key) continue;
    clean[key] = {
      hot_relations: data?.hot_relations ?? [],
      keywords: data?.keywords ?? [],
    };
  }
  return clean;
}

/**
 * 读旧单文件；不存在/损坏返回 null。
 * @param sanitize true=键清洗（剥 `项目根/` 前缀+同名合并）——**仅迁移路径用**；
 *   false=原样返回——兼容读语义（旧布局里 cache 键与 group-index 树成对使用前缀，
 *   兼容期单侧清洗会破坏配对；R2 教训）。
 */
function readLegacyCache(scope: string, sanitize = false): { partition_config: PartitionConfig; groups: Record<string, { hot_relations: Relation[]; keywords: string[] }> } | null {
  const legacyPath = getRelationsCachePath(scope);
  if (!fs.existsSync(legacyPath)) return null;
  const raw = readJson<{
    partition_config?: PartitionConfig;
    groups?: Record<string, { hot_relations?: Relation[]; keywords?: string[] }>;
  }>(legacyPath);
  if (!raw) return null;
  const groups = raw.groups ?? {};
  return {
    partition_config: raw.partition_config ?? { ...DEFAULT_PARTITION_CONFIG },
    groups: sanitize
      ? sanitizeLegacyGroups(groups)
      : groups as Record<string, { hot_relations: Relation[]; keywords: string[] }>,
  };
}

// ─── 读原语 ─────────────────────────────────────────────

/**
 * 读取单个 Group 分片（新布局）；分片不存在返回 null（组无元数据 = 空，与旧布局
 * "组键不存在"语义一致）。不触发迁移。
 */
export function readGroupCache(scope: string, groupPath: string): GroupCacheDoc | null {
  const shardPath = getGroupCachePath(scope, groupPath);
  if (!fs.existsSync(shardPath)) return null;
  const doc = readJson<GroupCacheDoc>(shardPath);
  if (!doc || !Array.isArray(doc.hot_relations)) {
    // 分片损坏：fail-loud（与 readJson CORRUPT_JSON 一致；这里只是结构层兜底）
    throw new Error(`Group 分片结构损坏：${shardPath}（缺少 hot_relations 数组）`);
  }
  return doc;
}

/**
 * 枚举全部 group 路径（轻量：只列目录名/键名，不读分片内容）——resolveGroupPath
 * 的模糊匹配上下文用（S0-5：单文档读取链路避免为树匹配做全量聚合）。
 * 语义对齐旧布局键集合：**含 cache.json 的目录**才是组（父组无分片、子组有 →
 * 只列子组；但目录树仍全量遍历，不假设分片层级连续）。
 */
/**
 * 遍历分片根，收集「含 cache.json 的目录」的相对路径（= 组键集合）。
 *
 * 单点实现供 listGroupPaths / readAllGroupCaches / 迁移残留清理共用——
 * 三处对「什么算一个组」的判定必须完全一致，否则会出现
 * 「列表里没有、聚合里有」这类不自洽。
 */
function collectShardGroupPaths(root: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // 第二轮审查 P2：原实现一律吞掉 → EACCES/EMFILE 时全库静默显示为空
      //（与「已初始化但 0 组」不可区分）。只容忍并发删除/非目录这类竞态。
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw new Error(`读取 relations 分片目录失败：${dir}（${(err as Error).message}）`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childDir = path.join(dir, entry.name);
      // 有分片文件的目录才是"组"（对齐旧布局 groups 键集合语义）
      if (fs.existsSync(path.join(childDir, 'cache.json'))) {
        paths.push(childPath);
      }
      // 无论自身是否有分片都继续深入——父组无分片、子组可能有的层级跳跃是合法形态
      walk(childDir, childPath);
    }
  };
  walk(root, '');
  return paths;
}

export function listGroupPaths(scope: string): string[] {
  if (hasShardedLayout(scope)) {
    return collectShardGroupPaths(getRelationsRoot(scope));
  }
  const legacy = readLegacyCache(scope);
  return legacy ? Object.keys(legacy.groups) : [];
}

/**
 * 构造 resolveGroupPath 的「有 relation 数据的组」上下文（组键 → 占位对象）。
 *
 * ⚠️ 值必须是**真值对象**：`resolveGroupPath` 用真值判断是否命中
 * （`group-resolve.ts` 的 `if (groupsData[userInput])`）。传 `null` 会让
 * 「relations 有该组、group-index 树没有/不同步」的兜底分支静默失效，
 * 表现为自动补全失败并报"父节点路径不存在"（批次 2 审查 P1-2）。
 */
export function buildGroupMatchContext(groupPaths: string[]): Record<string, { hot_relations: Relation[] }> {
  return Object.fromEntries(groupPaths.map((groupPath) => [groupPath, { hot_relations: [] as Relation[] }]));
}

/**
 * 清理「不在 expected 组集合内」的分片目录（迁移残留清理，审查 P1-7）。
 *
 * 场景：上一次惰性迁移在写 manifest 前被中断 → 分片根里留下比旧文件更早的分片快照；
 * 期间若用旧布局删除路径删过组（旧布局不清理分片），二次迁移会把该组重新按旧文件
 * 重写……但旧文件里已无该组，残留分片就成了孤儿，被 readAllGroupCaches 收养后
 * 「已删除的组复活」。
 *
 * 只应在「以旧文件为唯一真相」的迁移时机调用（此时分片根内容必为残留）。
 * 空目录一并清掉，避免残留空壳目录堆积。
 */
function pruneStaleShards(scope: string, expected: Set<string>): void {
  const root = getRelationsRoot(scope);
  if (!fs.existsSync(root)) return;
  for (const stale of collectShardGroupPaths(root)) {
    if (expected.has(stale)) continue;
    // 祖先安全：stale 若是某个待保留组的父路径，递归删除会连带删掉它
    //（`a` 不在旧文件里、但 `a/b` 在 → 只删 `a` 自身会误伤 `a/b`）。留待下一次迁移清理。
    let isAncestorOfExpected = false;
    for (const keep of expected) {
      if (keep.startsWith(`${stale}/`)) { isAncestorOfExpected = true; break; }
    }
    if (isAncestorOfExpected) continue;
    try {
      fs.rmSync(path.dirname(getGroupCachePath(scope, stale)), { recursive: true, force: true });
    } catch { /* 清理失败不阻断迁移主流程（残留最多造成孤儿组，不会丢数据） */ }
  }
}

/**
 * 双读：新布局优先，仅旧布局存在则读旧（惰性迁移前的兼容读，行为与拆分前一致）。
 * 返回该组元数据（分片或旧 groups[groupPath]）；两组来源皆无该组 → null。
 */
export function loadGroupCache(scope: string, groupPath: string): GroupCacheDoc | null {
  if (hasShardedLayout(scope)) {
    return readGroupCache(scope, groupPath);
  }
  const legacy = readLegacyCache(scope);
  if (!legacy) return null;
  const data = legacy.groups[groupPath];
  if (!data) return null;
  return {
    version: 1,
    scope,
    hot_relations: data.hot_relations ?? [],
    keywords: data.keywords ?? [],
    updatedAt: null,
  };
}

/**
 * 全量读取（双读）：新布局 readdir 分片根逐组读取；旧布局读单文件全量。
 * 返回 Map<groupPath, GroupData>；空库返回空 Map。
 */
export function readAllGroupCaches(
  scope: string,
): Map<string, { hot_relations: Relation[]; keywords: string[] }> {
  const result = new Map<string, { hot_relations: Relation[]; keywords: string[] }>();
  if (hasShardedLayout(scope)) {
    // 组键集合与 listGroupPaths 同源（collectShardGroupPaths），避免"列表有/聚合无"的不自洽
    for (const groupPath of collectShardGroupPaths(getRelationsRoot(scope))) {
      const doc = readGroupCache(scope, groupPath);
      if (doc) result.set(groupPath, { hot_relations: doc.hot_relations, keywords: doc.keywords });
    }
    return result;
  }
  const legacy = readLegacyCache(scope);
  if (!legacy) return result;
  for (const [groupPath, data] of Object.entries(legacy.groups)) {
    result.set(groupPath, { hot_relations: data.hot_relations ?? [], keywords: data.keywords ?? [] });
  }
  return result;
}

/**
 * 读 partition_config（双读）：manifest 优先，旧单文件 fallback，皆无走默认。
 * get-module-info / query-group / sync-relation 等的评分参数来源。
 */
export function loadPartitionConfig(scope: string): PartitionConfig {
  if (hasShardedLayout(scope)) {
    const manifest = readRelationsManifest(scope);
    if (manifest) return manifest.partition_config ?? DEFAULT_PARTITION_CONFIG;
  }
  const legacy = readLegacyCache(scope);
  return legacy?.partition_config ?? DEFAULT_PARTITION_CONFIG;
}

// ─── 惰性迁移 ───────────────────────────────────────────

/**
 * 旧布局 → 新布局一次性转换（惰性迁移，幂等）：
 * 读旧全量（含 `项目根/` 键清洗）→ 清理残留分片 → 逐组写分片 → 写 manifest → 旧文件改名 .bak。
 * 已是新布局时 no-op；旧文件不存在时视为全新 scope（仅建 manifest，**不动已有分片**）。
 * 返回迁移的组数（0 = 无事发生）。
 */
export function migrateLegacyRelationsCache(scope: string): number {
  if (hasShardedLayout(scope)) return 0;
  // 迁移是键清洗的唯一时机（护栏 #7：旧 key 不进分片路径）
  const legacy = readLegacyCache(scope, true);
  if (!legacy) {
    // 全新 scope：仅初始化 manifest（revision 0）。
    // 注意：此处**不清理由旧文件缺失但分片存在**的场景（可能是 manifest 被手工删除），
    // 那些分片是仅存的数据，清理等于丢数据。
    walWrite(getRelationsManifestPath(scope), ensureManifest(scope) as unknown as Record<string, unknown>);
    return 0;
  }
  // 以旧文件为唯一真相：清掉上一次中断迁移留下的、旧文件里已不存在的孤儿分片
  // （否则二次迁移后这些组会"复活"，审查 P1-7）。键原样使用（不变量：分片键 = 组路径）。
  pruneStaleShards(scope, new Set(Object.keys(legacy.groups)));
  let migrated = 0;
  for (const [groupPath, data] of Object.entries(legacy.groups)) {
    const shardPath = getGroupCachePath(scope, groupPath);
    const doc: GroupCacheDoc = {
      version: 1,
      scope,
      hot_relations: data.hot_relations,
      keywords: data.keywords ?? [],
      updatedAt: null,
    };
    walWrite(shardPath, doc as unknown as Record<string, unknown>);
    migrated++;
  }
  // manifest：partition_config 平移旧值，revision 从 0 起
  const manifest: RelationsManifest = {
    version: 1,
    scope,
    partition_config: legacy.partition_config,
    revision: 0,
  };
  walWrite(getRelationsManifestPath(scope), manifest as unknown as Record<string, unknown>);
  // 旧文件改名 .bak 保留（不自动删除）；改名失败不阻断（下次迁移 no-op 已由 manifest 挡住）
  const legacyPath = getRelationsCachePath(scope);
  try {
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, `${legacyPath}.bak`);
    }
  } catch (err) {
    process.stderr.write(`警告：旧 relations-cache.json 改名 .bak 失败（${(err as Error).message}），已忽略；可手动改名\n`);
  }
  invalidateScopeCaches(scope);
  return migrated;
}

// ─── 写原语（三步曲，生产代码唯一写入口）─────────────────

/**
 * 写单个 Group 分片（三步曲：bump → WAL 写分片 → 失效）。
 * 适合单组写路径（sync-relation / delete-relation / relation-edit-publish 等）。
 */
export function writeGroupCache(scope: string, groupPath: string, doc: GroupCacheDoc): void {
  // 惰性迁移：旧布局存在时先转换（本函数随后按新布局写目标组）
  if (!hasShardedLayout(scope) && hasLegacyLayout(scope)) {
    migrateLegacyRelationsCache(scope);
  } else if (!hasShardedLayout(scope)) {
    // 全新 scope：初始化 manifest
    const manifest = ensureManifest(scope);
    walWrite(getRelationsManifestPath(scope), manifest as unknown as Record<string, unknown>);
  }
  bumpManifestRevision(scope);
  walWrite(getGroupCachePath(scope, groupPath), doc as unknown as Record<string, unknown>);
  invalidateScopeCaches(scope);
}

/**
 * 批量写（import 等多组场景；批内共享一次 bump + 一次失效——design.md §3）：
 * ① 惰性迁移（如旧布局）→ ② bump 一次 → ③ 逐组 WAL 写分片 → ④ 失效一次。
 * @param docs 组路径 → 分片内容
 */
export function writeGroupCacheBatch(scope: string, docs: Map<string, GroupCacheDoc>): void {
  if (docs.size === 0) return;
  if (!hasShardedLayout(scope) && hasLegacyLayout(scope)) {
    migrateLegacyRelationsCache(scope);
  } else if (!hasShardedLayout(scope)) {
    const manifest = ensureManifest(scope);
    walWrite(getRelationsManifestPath(scope), manifest as unknown as Record<string, unknown>);
  }
  bumpManifestRevision(scope);
  for (const [groupPath, doc] of docs) {
    walWrite(getGroupCachePath(scope, groupPath), doc as unknown as Record<string, unknown>);
  }
  invalidateScopeCaches(scope);
}

/**
 * 删除组分片目录（delete-group 级联用；目录递归删除 = 自身 + 全部子组）。
 *
 * 第二轮审查 P2 修复：原实现在 `hasShardedLayout` 为假时直接 no-op。中断迁移
 * （分片已落、manifest 未落）或 manifest 被删的窗口里，级联删除会静默不生效，
 * 残留分片随后被 `readAllGroupCaches` 收养 → 已删组复活。改为**只要分片目录存在就删**，
 * manifest 不存在时跳过 bump（无身份可涨，读侧身份为 null 本身就不会命中缓存）。
 */
export function deleteGroupCache(scope: string, groupPath: string): void {
  deleteGroupCacheBatch(scope, [groupPath]);
}

/**
 * 批量删除（manage-index 级联等多组场景；共享一次 bump + 一次失效）。
 * @param groupPaths 待删组路径；目录不存在者跳过
 */
export function deleteGroupCacheBatch(scope: string, groupPaths: Iterable<string>): void {
  const dirs: string[] = [];
  for (const groupPath of groupPaths) {
    const shardDir = path.dirname(getGroupCachePath(scope, groupPath));
    if (fs.existsSync(shardDir)) dirs.push(shardDir);
  }
  if (dirs.length === 0) return;
  if (hasShardedLayout(scope)) bumpManifestRevision(scope);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  invalidateScopeCaches(scope);
}

/**
 * 把分片从 `oldPath` 改名到 `newPath`（键改名，非删除）；目标已存在时按 relation text 合并。
 *
 * 用途：`store.ts` 的 `roots → groups` 迁移会**把树里的 `项目根` 虚拟根节点提升掉**，
 * 键必须跟着改名才能保持「分片键 = 树路径」不变量（第二轮审查 P0 的配对动作）。
 * 未迁移的惰性转换本身不改键——`项目根` 作为字面组名时树里仍有该节点，改名即分叉。
 *
 * 批内共享一次 bump + 一次失效；返回实际改名的组数。
 */
export function renameGroupCacheShards(
  scope: string,
  renames: Array<{ from: string; to: string }>,
): number {
  if (renames.length === 0) return 0;
  let moved = 0;
  const done = new Set<string>();
  for (const { from, to } of renames) {
    if (from === to || done.has(from)) continue;
    const fromDir = path.dirname(getGroupCachePath(scope, from));
    const toDir = path.dirname(getGroupCachePath(scope, to));
    if (!fs.existsSync(fromDir) || fromDir === toDir) continue;
    const source = readGroupCache(scope, from);
    if (!source) continue;
    const target = readGroupCache(scope, to);
    const merged = target
      ? (() => {
          const texts = new Set(target.hot_relations.map((r) => r.text));
          const hot = [...target.hot_relations];
          for (const rel of source.hot_relations) {
            if (!texts.has(rel.text)) hot.push(rel);
          }
          return { ...target, hot_relations: hot };
        })()
      : { ...source, scope };
    walWrite(getGroupCachePath(scope, to), merged as unknown as Record<string, unknown>);
    fs.rmSync(fromDir, { recursive: true, force: true });
    done.add(from);
    moved++;
  }
  if (moved > 0) {
    if (hasShardedLayout(scope)) bumpManifestRevision(scope);
    invalidateScopeCaches(scope);
  }
  return moved;
}

// ─── 测试辅助 ───────────────────────────────────────────

/** 清空失效监听（测试隔离用） */
export function clearInvalidateListeners(): void {
  invalidateListeners.clear();
}

// ─── 兼容层：旧 RelationsCache 内存形状 ↔ 新布局（消费方迁移桥）─────────

/** 旧 RelationsCache 内存形状（迁移期兼容：消费方内部逻辑零改动） */
export interface LegacyRelationsCacheShape {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, { hot_relations: Relation[]; keywords: string[] }>;
  updatedAt: string | null;
}

/**
 * 双轨读当前布局 → 旧 RelationsCache 内存形状（批次 2 兼容桥）。
 * 新布局 = 分片聚合 + manifest 的 partition_config；旧布局 = 旧单文件原样。
 * 消费方（import/sync-relation/delete-relation 等）内部逻辑保持旧形状零改动，
 * 落盘时经 persistCacheShape 回到分片。
 *
 * ⚠️ 一定是**全量**读：需要单组读的路径（S0-5 核心收益）应直接用 loadGroupCache /
 * listGroupPaths，不要在这里加"只读某几组"的参数——旧布局分支只能整文件读，
 * 加参数会让同一调用在新旧布局下语义分叉（批次 2 审查 P2-7 已删除过一版死参数）。
 */
export function loadCacheShape(scope: string): LegacyRelationsCacheShape {
  if (hasShardedLayout(scope)) {
    const manifest = readRelationsManifest(scope);
    const groups: Record<string, { hot_relations: Relation[]; keywords: string[] }> = {};
    for (const [groupPath, data] of readAllGroupCaches(scope)) {
      groups[groupPath] = { hot_relations: data.hot_relations, keywords: data.keywords };
    }
    return {
      version: 1,
      scope,
      partition_config: manifest?.partition_config ?? DEFAULT_PARTITION_CONFIG,
      groups,
      updatedAt: null,
    };
  }
  const legacyPath = getRelationsCachePath(scope);
  const legacy = readJson<LegacyRelationsCacheShape>(legacyPath);
  if (!legacy) {
    throw new Error(`scope 元数据不存在（relations 分片与旧 relations-cache.json 均缺失）：${scope}`);
  }
  // 兼容读语义（关键）：未迁移的旧布局**不清洗** `项目根/` 前缀——旧数据里 cache 键与
  // group-index 树根成对使用前缀，单侧清洗会破坏配对（树匹配失败 → 展示为空）。
  // 键清洗只发生在两个明确时机：①migrateLegacyRelationsCache 迁移落分片时；
  // ②活写入路径的入口归一（写入侧不再产生前缀键）。R2 教训：兼容读必须与
  // 旧行为逐字节一致，"顺手规范化"在兼容期是语义破坏。
  // 同理不做 `?? {}` 兜底：groups 缺失/非对象属结构损坏，交由消费方的
  // assertCacheShape 按原语义 CACHE_SHAPE_INVALID 拦截（吞掉 = 把 fail-loud 降级为空库）。
  const groups = legacy.groups;
  return { ...legacy, groups };
}

/**
 * 把旧形状内存结构落到当前布局（批次 2 兼容桥）：
 * 新布局 → 先惰性迁移（如仍为旧布局）再批写 touchedGroups（一次 bump+失效）；
 * 旧布局 → 整文件 writeJson（回退语义，正常流程会先经 migrate）。
 * @param touchedGroups 被触达的组集合；undefined = 全量组（Phase 4 正式落盘语义）
 */
export function persistCacheShape(
  scope: string,
  cache: LegacyRelationsCacheShape,
  touchedGroups?: Set<string>,
): void {
  const groups = touchedGroups ?? new Set(Object.keys(cache.groups));
  if (groups.size === 0) return;
  if (hasShardedLayout(scope)) {
    const docs = new Map<string, GroupCacheDoc>();
    for (const groupPath of groups) {
      const data = cache.groups[groupPath];
      if (!data) continue;
      // 不变量：键原样落盘（分片键 = 树路径 = local-kb 目录）。早期实现在此处剥
      // `项目根/` 前缀，与迁移/树/KB 三处分叉，已被第二轮审查判定为 P0。
      if (!groupPath) continue;
      docs.set(groupPath, {
        version: 1,
        scope,
        hot_relations: data.hot_relations,
        keywords: data.keywords ?? [],
        updatedAt: null,
      });
    }
    writeGroupCacheBatch(scope, docs);
  } else {
    writeJson(getRelationsCachePath(scope), cache as unknown as Record<string, unknown>);
  }
}
