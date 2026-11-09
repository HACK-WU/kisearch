#!/usr/bin/env node
/**
 * scope.ts - ki scope CLI（src 版）
 *
 * scope 生命周期管理（统一作用于 KB 目录层 + 向量语义层）。
 *
 * 用法:
 *   ki scope list
 *   ki scope delete <name> --yes          # default 不可删除
 *   ki scope clear  <name> [--tags t1,t2] --yes
 *
 * 说明:
 *   - list：列出两层（KB / 向量）并集，标注每个 scope 存在于哪层
 *   - delete：清向量文档 + 删 KB 目录 + 移除 config.scopes 条目（尽力而为）
 *   - clear：清向量文档 + 清 KB 目录内容（保留目录与配置）；带 --tags 时仅清向量层对应 tag，不动 KB
 *   - delete/clear 为破坏性操作，需向量服务可用且强制 --yes
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { listAllScopes, getKbDir, getRelationsCachePath, getGroupIndexPath, validateScope } from './lib/scope.js';
import { readJson } from './lib/store.js';
import { getSharedOperationCoordinator } from './lib/operation-coordinator.js';
import {
  loadConfig,
  removeScopeFromConfigFile,
  getScopeWikiSync,
  isScopeReadonly,
  setScopeReadonlyInConfigFile,
  type KiConfig,
} from './lib/config.js';
import { withScopeWriteLock } from './lib/scope-write-lock.js';
import { readViews, isViewName, getViewMembers } from './lib/scope-view.js';
import { readViewDimensionState } from './lib/view-dimension-state.js';
import { isFtsOnlyIndexedRelation, type Relation } from './lib/scoring.js';
import {
  vectorListScopes,
  vectorCountScope,
  vectorDeleteScope,
  ensureVectorAvailable,
  closeEngine,
} from './lib/vector-client.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
import { deleteFtsCollection, ftsDeleteByFilter } from './lib/fts-client.js';
import { removeScopeCollection } from './lib/scope-collection.js';
import { getRelationsCacheIdentity, loadCacheShape, onScopeRelationsInvalidated } from './lib/group-cache.js';
import { listRegisteredDataSourceRecords } from './lib/datasource.js';
import { buildMemberMeta } from './lib/view-member-meta.js';
import { resolveWikiRootDir } from './lib/wiki-sync.js';

// ─── KB 目录辅助 ───

function kbDirExists(scope: string): boolean {
  return fs.existsSync(getKbDir(scope));
}

/** 删除整个 KB 目录（scope delete 用） */
function removeKbDir(scope: string): boolean {
  const dir = getKbDir(scope);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 清空 KB 目录内容但保留目录本身（scope clear 用） */
function clearKbDir(scope: string): boolean {
  const dir = getKbDir(scope);
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return true;
}

// ─── 纯函数：scope list ───

export interface ScopeEntry {
  scope: string;
  kb: boolean;         // 存在于 KB 目录层
  vector: boolean;     // 存在于向量语义层
  registered: boolean; // 在 config.scopes 中注册
  /**
   * 只读（REQ-20261029-001）：该 scope 禁止**逐条写入**（Web / MCP / CLI 单条）。
   * 批量更新（`ki import`、数据源同步）与运维通道仍放行，读侧不受影响。
   */
  readonly: boolean;
  /** KB 层文档数（relations-cache 的 hot_relations 总数 = 文件级 relation 数；无 cache 时为 0） */
  wikiCount: number;
  /** 完整登记在 FTS-only Collection 且没有 dense 向量的文档数。 */
  ftsOnlyDocCount: number;
  /** 有 FTS 索引的文档数（含 dense+FTS 混合）；用于「FTS 层是否已建立」的运行态判断。 */
  ftsDocCount: number;
  /** 顶层组名（仅第一层）；读失败为空数组 */
  topGroups: string[];
  /** topGroups 是否可能过期（该 scope 正在提交窗口内或读取失败） */
  topGroupsStale: boolean;
  /**
   * Wiki 写回状态（资源页「Scope 与 Wiki 同步」需要）。
   *
   * ⚠️ **只看配置开关会误导**：`wikiSync.enabled` 为 true 但 `source` 块指向的是单个文件
   * （单文件导入）且没配 `wikiSync.sourceDir` 时，写回会直接 fail-loud（ENOTDIR）。
   * 因此这里给出**解析后的实际可用目录**，与 `resolveWikiRootDir` 同源。
   */
  wikiSync: ScopeWikiStatus;
}

/** 单个 scope 的 wiki 写回可用性（`ki_scope_list` 输出，见 {@link ScopeEntry.wikiSync}） */
export interface ScopeWikiStatus {
  /** 配置开关：存在 wikiSync 段且未显式 `enabled:false`；与写入门禁 `enabled !== false` 同口径 */
  enabled: boolean;
  /** 实际可用的写回根目录（绝对路径）；null = 不可用 */
  writableDir: string | null;
  /** 写回目录来源：group-index 的 source 块 / config 的 wikiSync.sourceDir / 无 */
  writableFrom: 'source' | 'wiki-sync' | null;
  /** `source` 块被判为不可用时的原因（fail-loud 诊断文案，来自 resolveWikiRootDir） */
  rejectReason?: string;
}

/** 统计 Scope 的 KB 文档数与完整 FTS-only 文档数（每个 relation 计一次）。 */
interface ScopeDocCounts { wikiCount: number; ftsOnlyDocCount: number; ftsDocCount: number; }

const EMPTY_SCOPE_DOC_COUNTS: ScopeDocCounts = { wikiCount: 0, ftsOnlyDocCount: 0, ftsDocCount: 0 };

/**
 * scope 文档计数缓存（S0-3 前置，REQ-20260930-002；批次 2 R6 身份升级）：
 * 身份戳改布局感知三元组（新布局 = manifest mtime/size/revision，旧布局 = 旧文件
 * mtime/size + revision=-1），任何写路径（含分片写 bump）变化即失效。
 * daemon 内重复 ki_scope_list / Web Dashboard 刷新不再逐 scope 全量 parse 关系缓存。
 * 仅进程内缓存、不落盘：ki_scope_list 走只读队列，落盘会在读路径引入与 import 的
 * 写竞争，且磁盘缓存格式属批次 2（per-Group 拆分 manifest）的职责——阶段 0 不为
 * JSON 路径新增长效机制。
 */
const scopeDocCountCache = new Map<string, { mtimeMs: number; size: number; revision: number; counts: ScopeDocCounts }>();

// 批次 2（D3）写后主动失效：写路径落盘即丢弃本 scope 计数缓存（跨进程由身份三元组兜底）
onScopeRelationsInvalidated((scope) => {
  scopeDocCountCache.delete(getRelationsCachePath(scope));
});

export function countScopeDocs(scope: string): ScopeDocCounts {
  // 布局感知身份（R6）：新布局 manifest / 旧布局单文件 / 均无 = null
  const identity = getRelationsCacheIdentity(scope);
  const cachePath = getRelationsCachePath(scope);
  if (!identity) {
    // 两布局均无数据：清缓存并按 0 计（与旧 existsSync 语义一致）
    scopeDocCountCache.delete(cachePath);
    return EMPTY_SCOPE_DOC_COUNTS;
  }
  const cached = scopeDocCountCache.get(cachePath);
  if (
    cached
    && cached.mtimeMs === identity.mtimeMs
    && cached.size === identity.size
    && cached.revision === identity.revision
  ) {
    return cached.counts;
  }
  const counts = computeScopeDocCounts(scope);
  scopeDocCountCache.set(cachePath, { ...identity, counts });
  return counts;
}

/**
 * 计算 scope 文档计数（**不做静默降级**）。
 *
 * 第二轮审查 P2：原实现整体 catch → 返回 0 计数，损坏与"空库"不可区分。
 * 现改为抛错，由调用方决定可见性（`executeScopeListLocal` 逐 scope 兜底并告警，
 * 避免单个损坏 scope 让整个 scope 列表不可用；`ScopeEntry` 契约不含错误字段，
 * 故不在响应里加字段）。
 */
function computeScopeDocCounts(scope: string): ScopeDocCounts {
  {
    // 批次 2（R6）：双轨读（新布局分片聚合 / 旧布局旧文件）
    const cache = loadCacheShape(scope) as {
      groups?: Record<string, { hot_relations?: Partial<Pick<Relation, 'memoryId' | 'memoryIds' | 'ftsIds' | 'ftsIndexComplete'>>[] }>;
    };
    let wikiCount = 0;
    let ftsOnlyDocCount = 0;
    let ftsDocCount = 0;
    for (const g of Object.values(cache.groups || {})) {
      const relations = g?.hot_relations ?? [];
      wikiCount += relations.length;
      for (const relation of relations) {
        if ((relation.ftsIds?.length ?? 0) > 0 && relation.ftsIndexComplete !== false) ftsDocCount += 1;
        if (isFtsOnlyIndexedRelation(relation)) ftsOnlyDocCount += 1;
      }
    }
    return { wikiCount, ftsOnlyDocCount, ftsDocCount };
  }
}

/**
 * 视图的成员元信息。
 *
 * ★ 必需原因：`scopes[]` 按 Token 授权过滤，而视图成员通常**不在授权列表内**
 * （授权视图 ≠ 授权成员名）。前端在视图模式下要判断「这个成员是不是只读库」
 * 「有没有向量索引」，只能从这里取；缺了它，`useScopeReadonly(成员名)` 查不到条目
 * → readonly 默认 false → **只读库在视图下被显示成可写**。
 */
/**
 * 视图成员的向量集合维度状态（相对当前 `config.embedding.dimension`）。
 *
 * 三态是刻意的：读不到快照时只能说「未确认」，不能默认「一致」——
 * 维度不一致会让语义检索**直接跳过该库**，把不清楚写成没问题等于静默漏召回。
 */
export type ViewDimensionState = 'ok' | 'mismatch' | 'unknown';

export interface ViewMemberMeta {
  scope: string;
  kb: boolean;
  vector: boolean;
  readonly: boolean;
  /**
   * 向量集合维度状态。`mismatch` = 已确认不一致（语义检索会跳过该库）；
   * `unknown` = 快照缺失或过期，未确认；`undefined` = 无 dense 集合或旧数据。
   *
   * ⚠ 这是「已确认清单」而非全量保证：没标 mismatch 不代表维度正常。
   */
  dimensionState?: ViewDimensionState;
  /**
   * 该成员库的文档数（`countScopeDocs().wikiCount`，与 scope 列表「N 篇」同一口径）。
   *
   * 用途：区分**空库**（库存在但 0 篇）与**缺失**（KB 与向量层都没有）——
   * 两者在页面上必须不同标记，否则用户看到 `iso-scan-…` 与 `grp-dbg2` 长得一样，
   * 分不清是"还没导入"还是"库没了"。
   *
   * ⚠ 缺省（undefined）= 未统计（计数失败时不要报 0，否则会把统计失败误标成空库）。
   */
  docCount?: number;
  /**
   * 该成员库配了**定时同步**（数据源 `schedule.enabled === true`）。
   *
   * 页面标 `· 定时`：视图成员会自己跟着计划更新，用户据此判断"这个库是不是最新"。
   * 缺省 = 未配置（不是"未知"）。
   */
  scheduled?: boolean;
  /**
   * 定时**上一次自动执行失败**（`schedule.lastAutoState === 'failed'`）。
   *
   * 页面据此区分 `定时` 与 `定时（上次失败）`：只显示「定时」会让一直跑挂的源
   * 看起来仍是最新的，用户不会去查。
   * 仅在 `scheduled === true` 时有意义。
   */
  scheduledFailed?: boolean;
}

/**
 * 视图摘要（`ki_scope_list` / `ki scope list` 的 `views[]` 元素）。
 *
 * ⚠ `canEdit` **不在这里**：MCP / CLI 没有"登录用户"上下文，判断不了写权限。
 * 它由页面入口 `/api/views` 在服务端算好返回（D6 / §1.6），前端不得自己比 userId。
 */
export interface ViewInfo {
  view: string;
  /** 稳定 ID（D7）：`viewGrants` 以它为锚，改名不变 */
  id: string;
  members: string[];
  /** 与 members 同序 */
  memberMeta: ViewMemberMeta[];
  /** 至少有一层（KB 或向量）存在的成员数 */
  availableCount: number;
  /** 两层都不存在的成员名 */
  missing: string[];
  /** 创建者 userId（不是显示名）；旧视图缺失 = 无主，仅管理员可改 */
  createdBy?: string;
  /** ISO 8601 UTC；旧视图缺失 → 不伪造，前端显示 `—` */
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  /** 乐观锁（N7）：页面保存时回传，不符则 409 */
  revision: number;
}

export type ScopeListResult = {
  ok: true;
  scopeMode: 'default' | 'strict';
  vectorAvailable: boolean;
  vectorReason?: string;
  count: number;
  scopes: ScopeEntry[];
  /** 视图定义（按当前 Token 的授权过滤在工具层做；这里给全集） */
  views?: ViewInfo[];
  /**
   * 视图定义读取失败（已按「无视图」降级）。
   *
   * ★ 与 `views` 是两件事，必须分开表达：没有该字段 = 读过且确实没有视图；
   *   有该字段 = **没读成**，此时 `views` 缺省不代表"一个都没建"。
   */
  viewsWarning?: string;
};

/**
 * scope 的两层枚举结果（KB 目录层 + 向量语义层）。
 *
 * 抽出来的原因：视图成员元信息（`availableCount` / `missing`）依赖这两层判定，
 * 而 `ki_scope_list` 与 `ki_view_list` 都要用 —— 各写一份必然漂移成两套事实。
 */
export interface ScopeLayers {
  kbScopes: Set<string>;
  vectorScopes: Set<string>;
  vectorAvailable: boolean;
  vectorReason?: string;
}

/**
 * 枚举 scope 的两层存在性，供 scope 列表与视图列表共用。
 *
 * fastFail：scope 枚举走单次 probe，撞锁立即降级为仅 KB 层（不依赖向量引擎），
 * 不像写入/检索路径那样重试等锁——scope 下拉不应因向量锁挂起十余秒。
 */
export async function collectScopeLayers(): Promise<ScopeLayers> {
  const kbScopes = new Set(listAllScopes());

  let vectorScopes = new Set<string>();
  let vectorAvailable = true;
  let vectorReason: string | undefined;

  const avail = await ensureVectorAvailable(undefined, { fastFail: true });
  if (avail.available) {
    try {
      vectorScopes = new Set(await vectorListScopes());
    } catch (err) {
      vectorAvailable = false;
      vectorReason = (err as Error).message;
    }
  } else {
    vectorAvailable = false;
    vectorReason = avail.reason;
  }

  return { kbScopes, vectorScopes, vectorAvailable, vectorReason };
}

export interface ViewsBuildResult {
  /** 无视图定义时**不带**该字段（与 `executeScopeListLocal` 的既有口径一致） */
  views?: ViewInfo[];
  /** 非空 = 视图定义文件损坏，已按「无视图」降级 */
  warning?: string;
}

/**
 * 组装视图摘要（`ki_scope_list` / `ki_view_list` 共用的**唯一**实现）。
 *
 * 为什么单独抽：视图 DTO 的组装一旦各写一份，就会出现「页面有 docCount/scheduled、
 * MCP 侧没有」的静默差异 —— 同一个类型、同一份语义、多个入口给不同的东西。
 *
 * @param kbScopes     KB 目录层存在的 scope（决定 `memberMeta.kb` / `docCount`）
 * @param vectorScopes 向量语义层存在的 scope（决定 `memberMeta.vector` / `dimensionState`）
 */
export function buildViews(
  config: KiConfig,
  kbScopes: Set<string>,
  vectorScopes: Set<string>,
): ViewsBuildResult {
  try {
    const viewsMap = readViews(config);
    const names = Object.keys(viewsMap).sort();
    // 配了定时同步的 scope → 上次自动执行是否失败（与 /api/views 同源，一次算好）
    let scheduledScopes = new Map<string, boolean>();
    try {
      scheduledScopes = new Map(
        listRegisteredDataSourceRecords(config)
          .filter(({ record }) => record.schedule?.enabled === true)
          .map(({ scope, record }) => [scope, record.schedule?.lastAutoState === 'failed']),
      );
    } catch {
      scheduledScopes = new Map(); // 数据源文件损坏不阻断 scope 列表，只是不标「定时」
    }
    /*
     * 维度状态：纯 fs 读 `.vector-status` 快照（零锁），按 scope 缓存一次算好，
     * 供所有视图复用。与 /api/views 走同一个 readViewDimensionState，
     * 避免页面与 MCP 给出两套事实。
     */
    const dimensionCache = new Map<string, ViewDimensionState>();
    const dimensionStateOf = (s: string): ViewDimensionState => {
      let state = dimensionCache.get(s);
      if (state === undefined) {
        state = readViewDimensionState(config, s);
        dimensionCache.set(s, state);
      }
      return state;
    };

    if (names.length === 0) return {};

    return {
      views: names.map((name) => {
        const def = viewsMap[name];
        const members = def.members;
        /*
         * ★ 成员元信息走共享实现：`/api/views` 与这里必须是同一份口径，
         *   否则页面有 docCount/scheduled、MCP 侧没有 —— 同一 DTO 两套事实。
         */
        const { memberMeta, missing, availableCount } = buildMemberMeta({
          members,
          kbScopes,
          vectorScopes,
          isReadonly: (scope) => isScopeReadonly(config, scope),
          docCountOf: (scope) => {
            try {
              return countScopeDocs(scope).wikiCount;
            } catch (err) {
              console.warn(
                `⚠️ scope "${scope}" 的文档数统计失败，成员不标「空」：${(err as Error).message}`,
              );
              return undefined;
            }
          },
          scheduledScopes,
          dimensionStateOf,
        });
        return {
          view: name,
          id: def.id,
          members,
          memberMeta,
          availableCount,
          missing,
          // 缺失字段一律不输出（而不是给空串）：前端据此区分「旧视图没有记录」与「记录为空」
          ...(def.createdBy ? { createdBy: def.createdBy } : {}),
          ...(def.createdAt ? { createdAt: def.createdAt } : {}),
          ...(def.updatedBy ? { updatedBy: def.updatedBy } : {}),
          ...(def.updatedAt ? { updatedAt: def.updatedAt } : {}),
          revision: def.revision,
        };
      }),
    };
  } catch (err) {
    const message = (err as Error).message;
    // 视图文件损坏不应让整个 scope 列表不可用；告警后按「无视图」返回。
    console.warn(`⚠️ 视图定义读取失败，已按无视图处理：${message}`);
    // ★ 同时透出给调用方：否则 MCP 客户端只看到「没有 views 字段」，
    //   模型会把"读坏了"当成"一个都没建"讲给用户。
    return { warning: `视图定义读取失败，已按无视图返回：${message}` };
  }
}

export async function executeScopeListLocal(): Promise<ScopeListResult> {
  const config = loadConfig();
  const { kbScopes, vectorScopes, vectorAvailable, vectorReason } = await collectScopeLayers();

  // 只读名单也纳入枚举：否则"设了只读但该 scope 尚无数据/未注册"时列表里看不到，
  // 用户无法确认设置是否生效（REQ-20261029-001 验收 1）。
  /**
   * ★ 视图不是知识库：必须从 scope 列表里剔除。
   *
   * 即便磁盘上真有 `dataDir/<视图名>/`（历史遗留的脏目录），也不能把它当作一个
   * scope 展示 —— 用户会看到一个 0 篇、无向量、可写的同名「知识库」，
   * 而实际上它是只读聚合。视图只出现在下面的 `views[]` 里。
   */
  let viewNames = new Set<string>();
  try {
    viewNames = new Set(Object.keys(readViews(config)));
  } catch {
    viewNames = new Set();   // 视图文件损坏时不阻塞 scope 列表
  }
  const all = new Set<string>([
    ...kbScopes,
    ...vectorScopes,
    ...Object.keys(config.scopes),
    ...config.scopeReadonly,
  ].filter((s) => !viewNames.has(s)));
  const scopes: ScopeEntry[] = [...all].sort().map((s) => {
    // 逐 scope 兜底：单个 scope 的 relations 元数据损坏不应让整个 scope 列表不可用，
    // 但必须留下可见告警（不再静默当成 0 条）
    let docCounts = { wikiCount: 0, ftsOnlyDocCount: 0, ftsDocCount: 0 };
    if (kbScopes.has(s)) {
      try {
        docCounts = countScopeDocs(s);
      } catch (err) {
        console.warn(`⚠️ scope "${s}" 的 relations 元数据读取失败，计数暂按 0 计：${(err as Error).message}`);
      }
    }
    let topGroups: string[] = [];
    let topGroupsStale = false;
    try {
      const gi = readJson<{ groups?: Record<string, unknown> }>(getGroupIndexPath(s));
      topGroups = gi?.groups ? Object.keys(gi.groups) : [];
    } catch {
      topGroupsStale = true;
    }
    try {
      if (getSharedOperationCoordinator().isScopeCommitting(s)) topGroupsStale = true;
    } catch { /* 协调器不可用时忽略 */ }

    // wiki 写回可用性：只看配置开关会误导（source 块指向单个文件时写回仍会 ENOTDIR），
    // 统一用与写回路径同源的解析器，逐 scope 兜底（解析异常不拖垮整个列表）。
    const wikiCfg = getScopeWikiSync(config, s);
    let wikiSync: ScopeWikiStatus = {
      // 开关口径与 writeBackToWiki / resolveWikiSyncTarget 一致：缺省视为开启，显式 false 才算关闭
      enabled: wikiCfg !== null && wikiCfg.enabled !== false,
      writableDir: null,
      writableFrom: null,
    };
    try {
      const root = resolveWikiRootDir(s);
      wikiSync = {
        ...wikiSync,
        writableDir: root.dir,
        writableFrom: root.from,
        ...(root.sourceRejected ? { rejectReason: root.sourceRejected } : {}),
      };
    } catch (err) {
      console.warn(`⚠️ scope "${s}" 的 wiki 写回目录解析失败，按不可用处理：${(err as Error).message}`);
    }

    return {
      scope: s,
      kb: kbScopes.has(s),
      vector: vectorScopes.has(s),
      registered: Object.prototype.hasOwnProperty.call(config.scopes, s),
      readonly: isScopeReadonly(config, s),
      ...docCounts,
      topGroups,
      topGroupsStale,
      wikiSync,
    };
  });

  // 视图：只在存在定义时带上该字段（无视图的用户响应与改造前完全一致）
  const { views, warning: viewsWarning } = buildViews(config, kbScopes, vectorScopes);

  return {
    ok: true,
    scopeMode: config.scopeMode,
    vectorAvailable,
    vectorReason,
    count: scopes.length,
    scopes,
    ...(views ? { views } : {}),
    ...(viewsWarning ? { viewsWarning } : {}),
  };
}

export async function executeScopeList(): Promise<ScopeListResult> {
  if (shouldUseDaemonClient()) return callDaemon<ScopeListResult>('scope-list', {});
  return executeScopeListLocal();
}

// ─── 纯函数：scope delete ───

export type ScopeDeleteResult =
  | {
    ok: true;
    scope: string;
    deletedVectors: number;
    kbRemoved: boolean;
    configRemoved: boolean;
    /** FTS-only collection 目录是否被删除（无该目录时为 false） */
    ftsRemoved?: boolean;
    ftsError?: string;
    /** S-05：托管 clone（`~/.ki/datasources/<scope>`）是否删除 */
    managedCloneRemoved?: boolean;
    managedCloneDir?: string;
    managedCloneError?: string;
    /** 该 clone 仍被其他 scope 引用（已保留，不视为错误） */
    managedCloneShared?: boolean;
  }
  | {
      ok: false;
      error: string;
      requireConfirm?: boolean;
      willDelete?: { vectorCount: number; kbExists: boolean; registered: boolean; managedCloneDir?: string };
    };

/** 读取该 scope 的托管 clone 目录（无登记/非托管返回 null）；动态 import 避免 scope↔datasource 循环依赖 */
async function managedCloneDirForScope(scope: string): Promise<string | null> {
  try {
    const [{ readDataSource }, { managedCloneDirOf }] = await Promise.all([
      import('./lib/datasource.js'),
      import('./lib/datasource-clone.js'),
    ]);
    const read = readDataSource(scope);
    return read.ok ? managedCloneDirOf(read.record) : null;
  } catch {
    return null;
  }
}

async function executeScopeDeleteLocal(params: { scope: string; yes: boolean; forceReadonly?: boolean }): Promise<ScopeDeleteResult> {
  try {
    validateScope(params.scope);
    if (params.scope === 'default') {
      return { ok: false, error: 'default scope 不可删除' };
    }
    // D17（REQ-20261029-001）：只读库的破坏性运维保留能力，但 `--yes` 不足以确认
    //（只读挡得住"改一个字"，挡不住"清空整库"——不可逆操作多拦一道）
    if (isScopeReadonly(loadConfig(), params.scope) && params.forceReadonly !== true) {
      return {
        ok: false,
        error: `scope "${params.scope}" 为只读，破坏性操作需额外确认：加 --force-readonly`,
        requireConfirm: true,
      };
    }

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}），拒绝删除以免两层不一致` };
    }

    const config = loadConfig();
    const vectorCount = await vectorCountScope({ scope: params.scope });
    const kbExists = kbDirExists(params.scope);
    const registered = Object.prototype.hasOwnProperty.call(config.scopes, params.scope);
    const managedCloneDir = await managedCloneDirForScope(params.scope);

    if (!params.yes) {
      return {
        ok: false,
        error: `破坏性操作需 --yes 确认：将删除向量 ${vectorCount} 条${kbExists ? ' + KB 目录' : ''}${registered ? ' + 配置条目' : ''}${managedCloneDir ? ` + 托管 clone ${managedCloneDir}` : ''}`,
        requireConfirm: true,
        willDelete: {
          vectorCount, kbExists, registered,
          ...(managedCloneDir ? { managedCloneDir } : {}),
        },
      };
    }

    const deletedVectors = (await vectorDeleteScope({ scope: params.scope })).deleted;
    // daemon 内只关闭被删除 scope 的 engine，不能影响其他 scope 的并行请求。
    await closeEngine(params.scope);
    // FTS-only collection 独立于 dense collection：不删会留下 fts-collections/<scope> 孤儿目录
    let ftsRemoved = false;
    let ftsError: string | undefined;
    try {
      ftsRemoved = (await deleteFtsCollection(params.scope)).removed;
    } catch (err) {
      ftsError = (err as Error).message;
    }
    const kbRemoved = removeKbDir(params.scope);
    const configResult = removeScopeFromConfigFile(params.scope);
    removeScopeCollection(config, params.scope);

    // S-05：托管 clone 是派生资源，登记随 KB 目录一起删除 ⇒ 一并清理，避免孤儿 clone。
    let managedCloneRemoved = false;
    let managedCloneError: string | undefined;
    let managedCloneShared = false;
    if (managedCloneDir) {
      try {
        const { countManagedRepoRefs, withManagedCloneLock } = await import('./lib/datasource.js');
        const repoRoot = path.join(managedCloneDir, 'repo');
        const locked = await withManagedCloneLock(repoRoot, 'datasource-purge', async () => {
          const refs = countManagedRepoRefs(repoRoot, config);
          if (refs > 0) return { refs, purge: null };
          const { purgeManagedCloneDir } = await import('./lib/datasource-clone.js');
          const purge = await purgeManagedCloneDir(managedCloneDir);
          return {
            refs,
            purge: purge.removed === false && 'error' in purge
              ? { removed: false, error: purge.error }
              : { removed: purge.removed },
          };
        });
        if (locked.refs > 0) {
          managedCloneShared = true;
          managedCloneError = `该托管 clone 仍被 ${locked.refs} 个其他 scope 引用，已保留：${managedCloneDir}`;
        } else if (locked.purge) {
          managedCloneRemoved = locked.purge.removed;
          if (!locked.purge.removed && locked.purge.error) managedCloneError = locked.purge.error;
        }
      } catch (err) {
        managedCloneError = (err as Error).message;
      }
    }

    return {
      ok: true, scope: params.scope, deletedVectors, kbRemoved, configRemoved: configResult.removed,
      ftsRemoved,
      ...(ftsError ? { ftsError } : {}),
      ...(managedCloneDir
        ? {
          managedCloneRemoved,
          managedCloneDir,
          ...(managedCloneShared ? { managedCloneShared } : {}),
          ...(managedCloneError ? { managedCloneError } : {}),
        }
        : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeScopeDelete(params: { scope: string; yes: boolean; forceReadonly?: boolean }): Promise<ScopeDeleteResult> {
  if (shouldUseDaemonClient()) return callDaemon<ScopeDeleteResult>('scope-delete', params);
  try {
    return await withScopeWriteLock(params.scope, 'scope-delete', () => executeScopeDeleteLocal(params));
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

// ─── 纯函数：scope clear ───

export type ScopeClearResult =
  | {
    ok: true;
    scope: string;
    tags: string[] | 'all';
    deletedVectors: number;
    kbCleared: boolean;
    /** 全量 clear：FTS collection 目录是否被删除 */
    ftsRemoved?: boolean;
    /** 带 tags clear：FTS 中按 tag 删除的文档数 */
    ftsDeletedDocs?: number;
    ftsError?: string;
  }
  | {
      ok: false;
      error: string;
      requireConfirm?: boolean;
      willDelete?: { vectorCount: number; kbWillClear: boolean };
    };

async function executeScopeClearLocal(params: { scope: string; tags?: string[]; yes: boolean; forceReadonly?: boolean }): Promise<ScopeClearResult> {
  try {
    validateScope(params.scope);
    // D17：只读库的破坏性运维需额外确认（理由同 scope delete）
    if (isScopeReadonly(loadConfig(), params.scope) && params.forceReadonly !== true) {
      return {
        ok: false,
        error: `scope "${params.scope}" 为只读，破坏性操作需额外确认：加 --force-readonly`,
        requireConfirm: true,
      };
    }

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}），拒绝清理以免两层不一致` };
    }

    // KB 目录仅在未按 tag 过滤时清理（tag 是向量层概念，KB 层无 tag）
    const kbWillClear = !params.tags && kbDirExists(params.scope);

    if (!params.yes) {
      // 计数仅服务破坏性操作预告；vectorCountScope 带 tags 超过 SCAN_HARD_CAP 会
      // fail-loud（S0-1：拒绝低报值作为确认依据）。--yes 路径不做计数——实际删除
      // 数由 vectorDeleteScope 循环删除返回，超大库确认后不应被计数失败阻断。
      const vectorCount = await vectorCountScope({ scope: params.scope, tags: params.tags });
      return {
        ok: false,
        error: `破坏性操作需 --yes 确认：将清除向量 ${vectorCount} 条${kbWillClear ? ' + KB 目录内容' : ''}`,
        requireConfirm: true,
        willDelete: { vectorCount, kbWillClear },
      };
    }

    const deletedVectors = (await vectorDeleteScope({ scope: params.scope, tags: params.tags })).deleted;
    const kbCleared = !params.tags ? clearKbDir(params.scope) : false;
    // FTS-only 与 dense 是两套索引：clear 必须同时清，否则全文检索仍能召回旧文档
    let ftsRemoved = false;
    let ftsDeletedDocs = 0;
    let ftsError: string | undefined;
    try {
      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          ftsDeletedDocs += await ftsDeleteByFilter({ scope: params.scope, tag });
        }
      } else {
        ftsRemoved = (await deleteFtsCollection(params.scope)).removed;
      }
    } catch (err) {
      ftsError = (err as Error).message;
    }

    return {
      ok: true, scope: params.scope, tags: params.tags ?? 'all', deletedVectors, kbCleared,
      ...(params.tags && params.tags.length > 0 ? { ftsDeletedDocs } : { ftsRemoved }),
      ...(ftsError ? { ftsError } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeScopeClear(params: { scope: string; tags?: string[]; yes: boolean; forceReadonly?: boolean }): Promise<ScopeClearResult> {
  if (shouldUseDaemonClient()) return callDaemon<ScopeClearResult>('scope-clear', params);
  try {
    return await withScopeWriteLock(params.scope, 'scope-clear', () => executeScopeClearLocal(params));
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

// ─── 纯函数：scope readonly（REQ-20261029-001） ───

export type ScopeSetReadonlyResult =
  | {
    ok: true;
    scope: string;
    readonly: boolean;
    /** 状态是否真的发生变化（false = 幂等重复设置） */
    changed: boolean;
    configPath: string;
    warning?: string;
  }
  | {
    ok: false;
    error: string;
    code?: 'NO_CONFIG_FILE' | 'WRITE_FAILED' | 'BAD_SCOPE' | 'DAEMON_OUTDATED';
  };

/**
 * 设置 / 解除只读（本地执行）。
 *
 * ⚠️ **不得包 `withScopeWriteLock`**：该函数写的是配置文件（策略本身），不是 scope 内容；
 * 若加锁且 op 未进 `EXEMPT_OPS`，只读库将永远无法解除只读（自锁死锁）。
 */
export function executeScopeSetReadonlyLocal(params: { scope: string; readonly: boolean }): ScopeSetReadonlyResult {
  try {
    validateScope(params.scope);
  } catch (err) {
    return { ok: false, code: 'BAD_SCOPE', error: (err as Error).message };
  }
  /**
   * 视图不是知识库：拒绝设置只读态。
   *
   * 为什么挂在这里而不是写锁：`scope-readonly` **刻意不经过 `withScopeWriteLock`**
   * （否则只读库永远解不开，见本函数上方注释），所以 S-03 的写门禁覆盖不到它，
   * 必须在本路径单独拦。
   */
  try {
    if (isViewName(loadConfig(), params.scope)) {
      let members: string[] = [];
      try { members = getViewMembers(loadConfig(), params.scope); } catch { members = []; }
      const hint = members.length > 0
        ? `\n  成员库如需只读：${members.map((m) => `ki scope readonly ${m}`).join('；')}`
        : '';
      return {
        ok: false,
        code: 'BAD_SCOPE',
        error: `「${params.scope}」是一个视图，不是知识库，无法设置只读状态。${hint}`,
      };
    }
  } catch {
    // 视图文件损坏时按「不是视图」处理，与 isViewName 内部策略一致
  }
  let result: ReturnType<typeof setScopeReadonlyInConfigFile>;
  try {
    result = setScopeReadonlyInConfigFile(params.scope, params.readonly);
  } catch (err) {
    // 配置文件本身损坏（YAML 解析失败）时 `loadConfig()` 会在写回函数入口抛错：
    // 转成结构化失败，避免 CLI 甩出裸堆栈（文件未被改动，属安全失败）
    return { ok: false, code: 'WRITE_FAILED', error: `读取/写入配置失败：${(err as Error).message}` };
  }
  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  // 尚无数据的 scope 允许预锁：仅在"设为只读"时提示其未来创建/写入会被拒，
  // 解除时不提示（避免 --off 也回显"锁定后…"这类误导文案）
  const warning = params.readonly && !kbDirExists(params.scope)
    ? '该 scope 当前无数据，锁定后其创建与单条写入将被拒绝（导入/数据源同步仍可创建）'
    : undefined;
  return {
    ok: true,
    scope: result.scope,
    readonly: result.readonly,
    changed: result.changed,
    configPath: result.configPath,
    ...(warning ? { warning } : {}),
  };
}

export async function executeScopeSetReadonly(params: {
  scope: string;
  readonly: boolean;
}): Promise<ScopeSetReadonlyResult> {
  /**
   * **本地写，不走 daemon RPC**（实施期决策，见 .plans/2026-10-29-scope-readonly 「决策与偏差」）。
   *
   * 原因：`callDaemon` 会先 `ensureDaemon()`——为改一个配置项而**拉起整个 daemon** 属明显过重，
   * 且 daemon 预检失败时会让"设置只读"直接不可用（实测复现）。
   *
   * 常驻 daemon 的时效性由 `setScopeReadonlyInConfigFile` 末尾的 `utimes` 保证：
   * `loadConfig` 以 `mtime+size` 判新鲜度，抬高 mtime 后 daemon 下一次取配置必然重读
   * ⇒ 无需进程内 reset 也能立即生效（等长名单改写同样覆盖）。
   * daemon 侧仍保留 `scope-readonly` op（幂等、无害），供将来需要进程内立即 reset 时使用。
   */
  return executeScopeSetReadonlyLocal(params);
}

// ─── 辅助 ───

function parseTags(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const arr = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  return arr.length > 0 ? arr : undefined;
}

// ─── CLI ───

const program = new Command();
program.name('scope').showHelpAfterError().description('scope 生命周期管理（KB 目录层 + 向量语义层）');

program
  .command('list')
  .description('列出所有 scope（两层并集，标注所在层）')
  .option('--json', '以 JSON 格式输出（脚本解析用）', false)
  /**
   * 视图段默认**不输出**：该命令长期被脚本按行解析（docs/query-kb.md 教用户用它），
   * 追加段落会打断 grep/awk 类脚本且不报错。要看视图请显式加 --views，或用 ki view list。
   */
  .option('--views', '附加输出「视图」段（默认不输出，保持文本格式向后兼容）', false)
  .action(async (opts) => {
    // 结构化错误处理：relations 元数据损坏（manifest 无法解析）时 executeScopeList 会
    // fail-loud 抛错，裸抛会变成 unhandled rejection（堆栈 + 退出码 1，用户看不到出路）。
    let result: Awaited<ReturnType<typeof executeScopeList>>;
    try {
      result = await executeScopeList();
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
      await closeEngine();
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      await closeEngine();
      return;
    }
    // 人类可读表格输出（默认）——动态列宽适配长 scope 名
    // 视图段：仅在 --views 时追加（见上面 option 注释）
    const nameWidth = Math.max(10, ...result.scopes.map((s) => s.scope.length));
    const header = `  ${'scope'.padEnd(nameWidth)}  KB     Vector   Registered  Readonly  Docs`;
    const sep = '─'.repeat(header.length + 2);
    console.log(`\nScopes (${result.count}) — mode: ${result.scopeMode}`);
    console.log(sep);
    console.log(header);
    console.log(sep);
    for (const s of result.scopes) {
      console.log(
        `  ${s.scope.padEnd(nameWidth)}  ${s.kb ? '✓'.padEnd(6) : '✗'.padEnd(6)}  ${s.vector ? '✓'.padEnd(6) : '✗'.padEnd(6)}  ${s.registered ? '✓'.padEnd(9) : '✗'.padEnd(9)}  ${(s.readonly ? '✓' : '✗').padEnd(8)}  ${s.wikiCount}`
      );
    }
    console.log(sep);
    // 视图段：默认不打印（保持既有文本格式供脚本解析），显式 --views 才追加
    if (opts.views) {
      const views = result.views ?? [];
      if (views.length === 0) {
        console.log('\nViews (0) — 尚无视图定义；创建：ki view create <名称> --members <scope1>,<scope2>');
      } else {
        console.log(`\nViews (${views.length}) — 视图可当 scope 用于所有读命令`);
        for (const v of views) {
          const tail = v.missing.length > 0 ? `   ⚠ 缺失：${v.missing.join(', ')}` : '';
          console.log(`  ${v.view}  ${v.availableCount}/${v.members.length} 可用   ${v.members.join(' / ')}${tail}`);
        }
      }
    }
    if (!result.vectorAvailable) {
      console.log(`\n⚠ 向量层不可用：${result.vectorReason || '未知原因'}`);
      console.log('  （scope 列表来自 KB 目录层 + config；向量层数据暂不可见）');
    }
    console.log('');
    await closeEngine();
  });

program
  .command('delete')
  .description('彻底删除 scope（向量 + KB 目录 + 配置条目）；default 不可删除')
  .argument('<name>', 'scope 名称')
  .option('--yes', '确认执行（缺省则仅预览并拒绝）', false)
  .option('--force-readonly', '该 scope 为只读时仍执行（破坏性操作需额外确认）', false)
  .action(async (name: string, opts) => {
    const result = await executeScopeDelete({ scope: name, yes: !!opts.yes, forceReadonly: !!opts.forceReadonly });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (result.ok && result.managedCloneShared) {
      process.stderr.write(`ⓘ ${result.managedCloneError ?? '托管 clone 仍被其他 scope 使用，已保留'}\n`);
    } else if (result.ok && result.managedCloneError) {
      process.stderr.write(`⚠ 托管 clone 未删除，请手动清理 ${result.managedCloneDir ?? ''}：${result.managedCloneError}\n`);
    }
    if (!result.ok) process.exit(1);
  });

program
  .command('clear')
  .description('清空 scope 内容（保留 scope 与配置）；带 --tags 时仅清向量层对应 tag')
  .argument('<name>', 'scope 名称')
  .option('--tags <tags>', '仅清指定标签，逗号分隔多值（省略则清全部并清 KB 目录内容）')
  .option('--yes', '确认执行（缺省则仅预览并拒绝）', false)
  .option('--force-readonly', '该 scope 为只读时仍执行（破坏性操作需额外确认）', false)
  .action(async (name: string, opts) => {
    const result = await executeScopeClear({
      scope: name,
      tags: parseTags(opts.tags),
      yes: !!opts.yes,
      forceReadonly: !!opts.forceReadonly,
    });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

program
  .command('readonly')
  .description('设置 scope 只读（禁止逐条写入；导入/数据源同步与运维仍放行）；--off 解除只读')
  .argument('<name>', 'scope 名称')
  .option('--off', '解除只读（恢复可写）', false)
  .option('--yes', '确认对 default scope 生效（default 为兜底 scope，影响所有未显式指定 scope 的写入）', false)
  .action(async (name: string, opts) => {
    const readonly = !opts.off;
    // default 是兜底 scope：设只读会波及所有未显式传 scope 的写入，要求显式确认
    if (name === 'default' && readonly && !opts.yes) {
      console.error(JSON.stringify({
        ok: false,
        code: 'BAD_SCOPE',
        error: 'default 为兜底 scope：设只读会让所有未显式传 scope 的写入被拒。确需如此请加 --yes',
      }, null, 2));
      await closeEngine();
      process.exit(1);
    }
    const result = await executeScopeSetReadonly({ scope: name, readonly });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (!result.ok) process.exit(1);
    // 强制回显最终状态：`--off` 是"解除只读"，语义易反转，必须让人一眼看到当前状态
    process.stderr.write(
      `ⓘ ${result.scope} 现在 ${result.readonly ? '只读' : '可写'}${result.changed ? '' : '（状态未变化）'}\n`,
    );
    if (result.warning) process.stderr.write(`ⓘ ${result.warning}\n`);
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
