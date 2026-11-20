/**
 * governanceView.ts —— 治理页「视图模式」的前端基础设施（REQ-20261120-001 · S-04）
 *
 * 为什么单开而不是复用 `viewBuckets.ts`：
 *   那边把 `__root__` 映射成库名、并为浏览页的目录树服务；治理页要的是稳定的
 *   「库 / 组」展示与三段复合键。复用会把树的语义带进表格，改一处两边都受影响。
 *
 * 三条约定：
 *   ① 视图判定只看响应里有没有 `view`（与后端 `isViewRequest` 同源口径）；
 *   ② 条目键统一 `scope\0group\0name` —— 跨库同名文档必须能区分；
 *   ③ 单库模式（或旧 daemon 无 `scope`）照常工作：键退化为 `\0group\0name`。
 */

/** 当前响应是否来自视图（单库 / 旧 daemon → false） */
export function isGovernanceView(res: { view?: string } | null | undefined): boolean {
  return typeof res?.view === 'string' && res.view !== '';
}

/**
 * 文档/回收站条目的复合键。
 *
 * 用 NUL 分隔：group 路径本身含 `/`、scope 名允许 `-` `_`，NUL 两者都不可能出现。
 */
export function govDocKey(d: { scope?: string; group: string; name: string }): string {
  return `${d.scope ?? ''}\u0000${d.group}\u0000${d.name}`;
}

/**
 * 列表里展示的「库 / Group」。
 *
 * `__root__` 是根散文件的内部键（不是给人看的路径）→ 只显示库名。
 */
export function govGroupLabel(scope: string, group: string): string {
  return group === '__root__' ? scope : `${scope} / ${group}`;
}

/** 视图下写入口统一的禁用说明（与后端 409 `VIEW_NOT_WRITABLE` 语义一致） */
export const VIEW_WRITE_HINT = '视图为只读聚合，请切到具体知识库后再修改';

/** 视图响应里「读失败」的成员库（后端 `buckets[].error`，其余字段是该库的统计） */
export interface GovFailedMember {
  scope: string;
  error: string;
}

/** 提示条里单个错误信息保留的字数上限：原始 message 可能带整条路径、几百字符 */
const FAILED_ERROR_MAX = 80;

/**
 * 从视图响应里取出**读取失败**的成员库。
 *
 * 为什么必须显式取：后端对每个成员单独 try/catch，失败只写进 `buckets[].error`，
 * 整体仍返回 `200 + ok:true`。不读这个字段，页面表现就只是「某个库的数据凭空少了」，
 * 用户无法区分「该库本来没数据」与「读取失败」（事件 #57）。
 *
 * 单库响应（无 `view`）没有 `buckets`，返回空数组。
 */
export function govFailedMembers(
  meta: { buckets?: Array<{ scope?: string; error?: string }> } | null | undefined,
): GovFailedMember[] {
  const buckets = meta?.buckets;
  if (!Array.isArray(buckets)) return [];
  const out: GovFailedMember[] = [];
  for (const b of buckets) {
    // 只认「有 scope 且有 error」的行：成功行的形状是 {scope, total|docs…}
    if (typeof b?.scope === 'string' && b.scope !== '' && typeof b.error === 'string' && b.error !== '') {
      out.push({ scope: b.scope, error: b.error });
    }
  }
  return out;
}

/**
 * 合并两路失败库（列表请求 + counts 请求）。
 *
 * 为什么要合并：事件页的「列表」与「页头计数」来自两个端点
 * （`/governance/events` 与 `/governance/counts`），各自逐成员 try/catch —— 失败集合
 * 理论上相同但不保证（瞬时抖动、缓存命中差异）。只显示其中一路，就会出现
 * 「提示说没有失败，但数字确实少了」。
 *
 * 按 scope 去重；先传入那一路（页面主数据源）的错误文案优先。
 */
export function govMergeFailed(
  first: GovFailedMember[],
  second: GovFailedMember[],
): GovFailedMember[] {
  if (second.length === 0) return first;
  if (first.length === 0) return second;
  const seen = new Set(first.map((f) => f.scope));
  const out = [...first];
  for (const f of second) {
    if (seen.has(f.scope)) continue;
    seen.add(f.scope);
    out.push(f);
  }
  return out;
}

/**
 * 失败库的统一文案（空数组 → 空串，调用方可无条件拼接）。
 *
 * 正文只列库名，**不内联错误原文**：原始 message 里常带服务器绝对路径
 * （`EACCES: permission denied, scandir /root/.ki-data/xxx`），既占满提示条又不该外露。
 * 原始原因走 {@link govFailedTitle} 挂在 `title` 上，需要排查时悬停可见。
 */
export function govFailedNotice(failed: GovFailedMember[]): string {
  if (failed.length === 0) return '';
  const names = failed.map((f) => f.scope).join('、');
  return `读取失败：${names} —— 这些库的数据不在本次结果里，请切到具体知识库核对。`;
}

/** 失败库的原始原因（挂 `title` 给排查用；空数组 → undefined，便于直接透传） */
export function govFailedTitle(failed: GovFailedMember[]): string | undefined {
  if (failed.length === 0) return undefined;
  return failed
    .map((f) => {
      const reason = f.error.length > FAILED_ERROR_MAX ? `${f.error.slice(0, FAILED_ERROR_MAX)}…` : f.error;
      return `${f.scope}：${reason}`;
    })
    .join('\n');
}

/**
 * 列表被截断的文案（事件 #56）。
 *
 * 判据只用 `hasMore`：视图下后端按**全量 total** 计算它（`offset + page.length < total`），
 * 比 `loaded < total` 更准 —— 单库条目多时同样适用，故两个模式共用。
 */
export function govLoadedNotice(loaded: number, total: number, hasMore: boolean): string {
  if (!hasMore) return '';
  /*
   * 措辞用「当前显示」而不是「已加载前 N 条」：事件列表开了 `includePinned`，
   * 置顶事件**不受状态/类型筛选影响**，列表里的 N 条可能包含筛选外的条目，
   * 与 total（筛选后合计）不是同一个集合的"前 N 条"。
   */
  return `当前显示 ${loaded} 条（共 ${total} 条），还有更多未显示。`;
}
