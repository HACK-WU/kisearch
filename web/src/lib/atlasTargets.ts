/**
 * atlasTargets.ts —— 视图下「该看哪一份图集」的**唯一判定**（纯函数，不引 React）
 *
 * 为什么必须收敛成一处：页面（渲染 iframe）与顶栏（渲染切换器）各判一次的话，
 * 一旦分叉就会出现「页面直出 A、顶栏却说有 2 个可切」——用户同时看到两个答案。
 * 独立成纯函数还能被 `web/test` 直接 ssrLoadModule 单测：本仓前端测试没有 jsdom，
 * 组件行为只能真机走查，判定逻辑留在纯函数里才测得到。
 *
 * 背景（2026-11-25 用户拍板）：图集是**整幅 HTML 画布**，多库合并不了，也不给视图
 * 单独装一份（`/open/v1/atlas/*` 显式拒绝视图名）。所以视图下要做的不是「合并图集」，
 * 而是「从成员库里挑一份来看」，并且只配了一个时不要再让用户点一次。
 */

/** 一个成员库的图集探针（pending 由调用方先挡掉，这里只处理「已有结果」） */
export interface AtlasProbe {
  scope: string;
  /**
   * 该目标是主库还是图集库（2026-11-27）。
   * 缺省按 `main` 处理：旧调用方 / 测试不必改。
   */
  kind?: 'main' | 'atlas';
  /** 归一后的主库名（图集库取其主库；主库取自身） */
  mainScope?: string;
  /** 状态读取失败：**不等于**没装图集，不能并进 absent（否则用户以为图集丢了） */
  failed: boolean;
  /** failed=false 时有效 */
  exists: boolean;
  /** ISO 上传时间；旧包 / 旧 daemon 可能缺 */
  uploadedAt?: string;
}

/**
 * `AtlasTarget`（hooks.ts）的结构子集：这里只要这四个字段，用鸭子类型而不是 import
 * 是为了让本模块**不反向依赖 hooks**（判定模块不该知道 React Query 的存在）。
 */
export interface AtlasTargetLike {
  scope: string;
  isError: boolean;
  exists: boolean;
  uploadedAt?: string;
  kind?: 'main' | 'atlas';
  mainScope?: string;
}

/** 页面与顶栏都调它得出同一份判定输入（各写一份容易漏字段、慢慢漂移） */
export function toAtlasProbes(targets: AtlasTargetLike[]): AtlasProbe[] {
  return targets.map((item) => ({
    scope: item.scope,
    kind: item.kind ?? 'main',
    mainScope: item.mainScope ?? item.scope,
    failed: item.isError,
    exists: item.exists,
    uploadedAt: item.uploadedAt,
  }));
}

// ─── 图集库映射（数据来自 ki_scope_list.atlas，不在前端读 config） ───

/** 与后端 `AtlasScopeMap` 同构；旧 daemon 不返回时用默认值兜底 */
export interface AtlasMapLike {
  suffix: string;
  mappings: Record<string, string>;
}

export const DEFAULT_ATLAS_MAP: AtlasMapLike = { suffix: '-atlas', mappings: {} };

/**
 * 主库 → 图集库。与 `src/lib/atlas/scope-map.ts::atlasScopeFor` **必须同规则**：
 * 已有映射值（本身是图集库）与后缀自指都不二次追加。
 */
export function atlasScopeOf(scope: string, map: AtlasMapLike): string {
  const isMappedAtlas = !Object.prototype.hasOwnProperty.call(map.mappings, scope)
    && Object.values(map.mappings).includes(scope);
  if (isMappedAtlas) return scope;
  const explicit = map.mappings[scope];
  if (explicit) return explicit;
  if (scope.endsWith(map.suffix) && scope.length > map.suffix.length) return scope;
  return `${scope}${map.suffix}`;
}

/** 图集库 → 主库；不是图集库返回 null */
export function mainScopeOf(scope: string, map: AtlasMapLike): string | null {
  for (const [main, atlas] of Object.entries(map.mappings)) {
    if (atlas === scope) return main;
  }
  if (scope.endsWith(map.suffix) && scope.length > map.suffix.length) {
    return scope.slice(0, -map.suffix.length);
  }
  return null;
}

/**
 * 按主库折叠：同一主库与其图集库只留一个，**图集库优先**。
 *
 * 为什么必须折叠：存量 `default` 未迁期间，主库与图集库可能同时有图集，
 * 不折叠则切换器里出现同一图集两项，且 `uploadedAt` 谁新选谁 → 可能选中旧副本。
 */
export function collapseAtlasTargets(probes: AtlasProbe[]): AtlasProbe[] {
  const groups = new Map<string, AtlasProbe[]>();
  const order: string[] = [];
  for (const probe of probes) {
    const key = probe.mainScope ?? probe.scope;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(probe);
  }
  const out: AtlasProbe[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const atlasWithData = group.find((p) => p.kind === 'atlas' && !p.failed && p.exists);
    const mainWithData = group.find((p) => p.kind !== 'atlas' && !p.failed && p.exists);
    const fallback = group.find((p) => p.kind !== 'atlas') ?? group[0];
    out.push(atlasWithData ?? mainWithData ?? fallback);
  }
  return out;
}

/** 切换器展示名：不暴露 `-atlas` 后缀 */
export function displayNameOf(probe: AtlasProbe): string {
  return probe.mainScope ?? probe.scope;
}

/**
 * 单库回落：图集库有图集 → 用它；否则主库有 → 用主库（兼容旧部署）；都没有 → 主库（空态）。
 * 图集库 403 已被调用方剔除（见 hooks），这里不重复判。
 */
export function pickSingleTarget(probes: AtlasProbe[]): AtlasProbe | null {
  if (probes.length === 0) return null;
  const collapsed = collapseAtlasTargets(probes);
  return collapsed[0] ?? null;
}

export interface AtlasViewShape {
  /** 装了图集的成员（按成员顺序，不按上传时间重排 —— 切换器列表要稳定） */
  members: string[];
  /** 读取失败的成员 */
  failed: string[];
  /** 确定没装图集的成员 */
  absent: string[];
  /** 当前该看的那份；members 为空时 `null` */
  selected: string | null;
}

/**
 * 视图下的选中优先级：记得的那个（仍可用）> 最近上传 > 成员顺序首个。
 *
 * 「记得」来自 URL `?member=`（顶栏切换时写入）：刷新、收藏、分享都停在同一份。
 * 指向已被移出视图的库时静默回落 —— 视图成员会被 `ki view update` 改。
 *
 * ⚠️ 最近上传只用于**首次进入**：一旦用户手动切过，URL 就是最高优先。否则
 *    「刚给 B 上了新版本」会把正在看 A 的人弹走，属于抢用户的选择。
 */
export function resolveAtlasView(
  probes: AtlasProbe[],
  remembered: string | null | undefined,
): AtlasViewShape {
  const members = probes.filter((p) => !p.failed && p.exists).map((p) => p.scope);
  const failed = probes.filter((p) => p.failed).map((p) => p.scope);
  const absent = probes.filter((p) => !p.failed && !p.exists).map((p) => p.scope);

  let selected: string | null = null;
  if (members.length > 0) {
    if (remembered && members.includes(remembered)) {
      selected = remembered;
    } else {
      selected = members[0];
      let latest = -Infinity;
      for (const probe of probes) {
        if (!members.includes(probe.scope)) continue;
        // 非法/缺失 → NaN，`Number.isFinite` 挡住，自然回落到成员顺序首个
        const at = Date.parse(probe.uploadedAt ?? '');
        if (Number.isFinite(at) && at > latest) {
          latest = at;
          selected = probe.scope;
        }
      }
    }
  }

  return { members, failed, absent, selected };
}

/**
 * 切换器末尾那行补充说明：「另有 K 个成员库未配置图集 · M 个读取失败」。
 *
 * 两类必须分开说：把读失败混进「未配置」等于告诉用户「这些库没有图集」，
 * 而事实上是**没读到**（R5）。没有可说的内容时返回 `null`，调用方不渲染该行。
 */
export function atlasMemberNote(shape: AtlasViewShape): string | null {
  const parts: string[] = [];
  if (shape.absent.length > 0) parts.push(`另有 ${shape.absent.length} 个成员库未配置图集`);
  if (shape.failed.length > 0) parts.push(`${shape.failed.length} 个成员库读取失败`);
  return parts.length > 0 ? parts.join(' · ') : null;
}