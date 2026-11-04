/**
 * viewBuckets.ts —— 视图模式下的「跨库唯一键」基础设施（REQ-20261104-005）
 *
 * 背景：浏览页内部**所有索引都以 `group` 为键**。单库时 group 全局唯一，
 * 但视图模式下两个库都可以有 `projects` —— 于是：
 *   - `docsByGroup` 缓存互相覆盖（切到 A 库显示 B 库的文档）
 *   - `knownDocs.find(group === x && name === y)` 打开**错误的库**的文档
 *   - 目录过滤串台（B 库的组因 A 库的命中被隐藏）
 * 这三处都是**静默**的：不报错，只是数据不对。
 *
 * 本模块只提供复合键与形状归一，不碰渲染；`BrowsePage` 逐步改为使用它们。
 */

/** 视图模式下文档的唯一标识 */
export interface DocumentRef {
  scope: string;
  group: string;
  relation: string;
}

/**
 * 复合键：`scope\0group`。
 *
 * 用 `\u0000` 而不是 `/` 或 `:` —— group 路径本身就含 `/`，而 scope 名允许 `-` `_`，
 * NUL 是两者都不可能出现、也不参与任何展示的字符。
 */
export function docKey(scope: string, group: string): string {
  return `${scope}\u0000${group}`;
}

/** 从复合键还原（供调试与少量需要拆回的场景；热路径请直接用两个字段） */
export function splitDocKey(key: string): { scope: string; group: string } {
  const idx = key.indexOf('\u0000');
  if (idx < 0) return { scope: '', group: key };
  return { scope: key.slice(0, idx), group: key.slice(idx + 1) };
}

/** 文档三元组 → 复合键（与目录树、缓存、过滤共用同一口径） */
export function refKey(ref: { scope?: string; group?: string; relation?: string }): string {
  return [ref.scope ?? '', ref.group ?? '', ref.relation ?? ''].join('\u0000');
}

// ─── /api/doc/list 响应形状 ───────────────────────────────

export interface DocListBucketPayload {
  scope: string;
  docs?: { group?: string; name?: string; [k: string]: unknown }[];
  offset?: number;
  total?: number;
  truncated?: boolean;
  groups?: { name: string; count: number }[];
  tags?: string[];
  error?: string;
}

export interface DocListViewPayload {
  ok?: boolean;
  view: string;
  members: string[];
  buckets: DocListBucketPayload[];
  /** 顶层合并去重的 tag（供 tag 下拉，它只能吃扁平列表） */
  tags?: string[];
  skipped?: { scope: string; reason: string }[];
}

/**
 * 是否是多成员视图响应。
 *
 * 判据用 `'buckets' in data` 而不是 `view !== undefined`：单库响应**不出现**该字段
 * （`buildDocListPayload` 的 `{ok, ...payload}` 展开里没有它），所以这个判断对
 * 「旧版 daemon」与「单库」都安全地返回 false，退化路径不需要额外分支。
 */
export function isViewDocList<T extends object>(data: T | undefined): data is T & DocListViewPayload {
  return data != null && Array.isArray((data as { buckets?: unknown }).buckets);
}

/** 取某个成员库的桶；不存在返回 undefined */
export function bucketOf(payload: DocListViewPayload | undefined, scope: string): DocListBucketPayload | undefined {
  return payload?.buckets.find((b) => b.scope === scope);
}

/**
 * 把分桶响应拍平成「带 scope 的文档列表」。
 *
 * 用途：需要"全视图文档总数"或"跨库搜索命中的统一列表"时。
 * **不用于目录树**——树必须保留库节点层级，拍平会让用户看不出文档属于哪个库。
 */
export function flattenBuckets(
  payload: DocListViewPayload | undefined,
): { scope: string; doc: { group?: string; name?: string; [k: string]: unknown } }[] {
  if (!payload) return [];
  const out: { scope: string; doc: { group?: string; name?: string; [k: string]: unknown } }[] = [];
  for (const b of payload.buckets) {
    for (const d of b.docs ?? []) out.push({ scope: b.scope, doc: d });
  }
  return out;
}

// ─── 归一：把分桶响应折成「单库形状」，让下游零改动 ─────────

/** 视图模式下，成员库的 group 在树里以「库名/原路径」呈现；根散文件直接挂在库节点下 */
export function prefixGroup(member: string, group: string): string {
  return group === '__root__' ? member : `${member}/${group}`;
}

/**
 * 反解树上的路径（视图模式）。
 *
 * 懒加载 `fetchGroupDocsAll` 要的是**真实 scope + 真实 group**，
 * 而树里拿到的是 `ai-docs/projects`。第一段是库名，其余是组路径。
 * 单库模式下原样返回 `{ member: fallback, group: raw }`。
 */
export function decodeGroupPath(
  raw: string,
  members: readonly string[],
  fallback: string,
): { member: string; group: string } {
  const idx = raw.indexOf('/');
  if (idx <= 0) {
    // 裸库名（根散文件）→ 该库的 __root__
    return members.includes(raw) ? { member: raw, group: '__root__' } : { member: fallback, group: raw };
  }
  const head = raw.slice(0, idx);
  if (!members.includes(head)) return { member: fallback, group: raw };
  return { member: head, group: raw.slice(idx + 1) };
}

/**
 * 把 `/api/doc/list` 的响应归一成**单库形状**（`{ scope, groups, docs, tags }`）。
 *
 * 为什么不改内部键而选择「给 group 加库名前缀」：
 * 浏览页有 4 处以 `group` 为键的索引（`docsByGroup` / `loadedGroupsRef` /
 * `knownDocs` / `matchedDocKeys`）外加目录树路径。**加前缀就让 group 天然跨库唯一**，
 * 四处索引与树、深链、过滤全部不用改——这也正是「把各库根目录合并成独立目录」的字面实现。
 *
 * 单库模式（或旧版 daemon）**原样返回**，一个字段都不动。
 */
export function normalizeDocData<T extends { scope?: string; groups?: unknown[]; docs?: unknown[]; tags?: string[] }>(
  data: T | undefined,
): T | undefined {
  if (!data) return data;
  if (!isViewDocList(data)) return data;   // 单库：零改动

  const payload = data as unknown as DocListViewPayload;
  const groups: { name: string; count: number }[] = [];
  const docs: Record<string, unknown>[] = [];
  const tagSet = new Set<string>();

  for (const b of payload.buckets) {
    for (const g of b.groups ?? []) groups.push({ name: prefixGroup(b.scope, g.name), count: g.count });
    for (const d of b.docs ?? []) {
      // 打上来源库，跨库同名文档因此可区分（`knownDocs` / 搜索命中靠它消歧）。
      // ★ `rawGroup` 保留**后端真实 group**：树路径带库名前缀，但 `get-module-info`
      //   要在成员库里按真实 group 找文档，传前缀过去会报「未匹配到有效路径」。
      docs.push({
        ...d,
        group: prefixGroup(b.scope, String(d.group ?? '__root__')),
        rawGroup: d.group ?? '__root__',
        scope: b.scope,
      });
    }
    for (const t of b.tags ?? []) tagSet.add(t);
  }

  // 组计数按合并后的名字聚合（同名组已因前缀而唯一，这里只是兜底）
  const groupMap = new Map<string, number>();
  for (const g of groups) groupMap.set(g.name, (groupMap.get(g.name) ?? 0) + g.count);

  // total = 各成员库真实总数之和（桶里的 `total` 是未截断的全量，`docs` 可能只到 500）
  const total = payload.buckets.reduce((sum, b) => sum + (b.total ?? (b.docs?.length ?? 0)), 0);

  return {
    ...data,
    scope: payload.view,                       // 让下游 `data.scope === scope` 的守卫成立
    groups: [...groupMap].map(([name, count]) => ({ name, count })),
    docs,
    total,
    tags: [...tagSet].sort(),
  } as unknown as T;
}
