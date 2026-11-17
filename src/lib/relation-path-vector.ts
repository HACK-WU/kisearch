/**
 * `ki-relation` 路径向量的**候选重算与删除**（唯一实现）。
 *
 * 为什么单列：路径向量的 docId **不回写 cache**（cache 只记内容向量），删除侧只能靠重算。
 * 而写入侧的文本形态有三种，少算一种就留孤儿，用户看到的是「文档删了/隐藏了，按名还能搜到」：
 *   ① 单条写入：`buildRelationContent()` 只返回 relation 名；
 *   ② **分块导入**：chunkRelation 形如 `relation-01` / `relation-100`（`chunk-entries.ts::deriveChunkRelation`
 *      恒带两位起后缀，100 chunk 就是三位），由 `import.ts` 按 `e.chunkRelation` 写路径向量；
 *   ③ 历史形态（12d14c4 之前）：`${relation} | Group: ${group 空格化}`。
 *
 * 调用方是 `delete-relation`（文档删除）与 `visibility-index`（hidden 摘除）。
 * 两处**必须同源**：分叉的后果是「删除删得掉、hidden 摘不掉」（2026-11 实测发生过）。
 *
 * ⚠️ docId 只由 relation 名决定 ⇒ **跨组共享**。调用方必须先确认没有其他组持有同名 relation
 * （`delete-relation` 有 otherHolders 判定，`visibility-index` 有 hasOtherHoldersIn）。
 */

import { generateDocId, vectorDelete, vectorSearch, scopeCollectionExists } from './vector-client.js';
import { buildRelationContent } from './path-vectorize.js';

const RELATION_TAG = 'ki-relation';

/** 检索兜底单次取回的候选数（tag 多的库里 20 条会被别的文档挤满） */
const SEARCH_LIMIT = 50;

/**
 * 分块路径向量后缀的**防爆上限**（不是业务上限）：候选数由 cache 记录的内容向量条数驱动，
 * 这里只兜住异常数据。
 */
const MAX_CHUNK_PATH_CANDIDATES = 999;

export interface RemoveRelationPathVectorsParams {
  scope: string;
  relation: string;
  group: string;
  /** cache 记录的内容向量条数（= memoryIds 去掉自定义 tag 后的数量），用于推分块个数 */
  contentVectorCount?: number;
  /** 同组其他 relation 名：若存在名字恰好是 `relation-NN` 的独立文档，该 docId 属于它，不能删 */
  siblingNames?: Set<string>;
}

export interface RemoveRelationPathVectorsResult {
  removed: boolean;
  deleted?: number;
  reason?: string;
  /**
   * 三种形态都查过、库里也没有该路径向量（`removed:false` 但并非失败）。
   * 调用方语义不同：删除侧要把 reason 报给用户（可能本来就该有）；
   * hidden 摘除侧则应视为「已清理」——那里路径向量可能上一轮就摘过了，报失败是误报。
   */
  missing?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 可重算的路径向量 docId 候选（三种文本形态；分块个数由缓存条数驱动） */
export function relationPathVectorIds(params: RemoveRelationPathVectorsParams): string[] {
  const { scope, relation, group } = params;
  const legacyGroupPart = group.split('/').filter(Boolean).join(' ');
  const candidates = new Set([
    generateDocId(buildRelationContent(relation, group), scope, RELATION_TAG),
    generateDocId(`${relation} | Group: ${legacyGroupPart}`, scope, RELATION_TAG),
  ]);
  const contentCount = Math.max(0, params.contentVectorCount ?? 0);
  const chunkPaths = Math.min(MAX_CHUNK_PATH_CANDIDATES, Math.max(1, contentCount));
  for (let i = 1; i <= chunkPaths; i += 1) {
    const chunkName = `${relation}-${String(i).padStart(2, '0')}`;
    if (params.siblingNames?.has(chunkName)) continue;
    candidates.add(generateDocId(chunkName, scope, RELATION_TAG));
  }
  return [...candidates];
}

/**
 * 删除该 relation 的路径向量。
 *
 * 顺序：按重算候选直删（精确、不调用 embedding）→ 仍有缺口才按 tag 检索兜底
 * （更早的文本形态无法穷举）。`errors` 已过滤 NOT_FOUND ⇒ 非空即真失败，必须报出。
 * `contentVectorCount` 为 0 时（纯 FTS-only / 无向量记录）不付检索成本，静默返回未命中。
 */
export async function removeRelationPathVectors(
  params: RemoveRelationPathVectorsParams,
): Promise<RemoveRelationPathVectorsResult> {
  const contentCount = Math.max(0, params.contentVectorCount ?? 0);
  // 库不存在 ⇒ 没有路径向量可清。`vectorDelete` 内部已对空 collection 短路（不再建库），
  // 这里提前返回是为了**省掉后面那次检索兜底**，并保持「本来就没有」不带 reason 的语义。
  if (!scopeCollectionExists(params.scope)) return { removed: false, deleted: 0, missing: true };
  const candidateIds = relationPathVectorIds(params);

  let deleted = 0;
  try {
    const res = await vectorDelete({ scope: params.scope, ids: candidateIds });
    deleted += res.deleted;
    if (res.errors.length > 0) {
      // 候选集天然只有个别形态存在，`deleted > 0` 不足以证明「都删干净了」
      return { removed: false, deleted, reason: `路径向量删除失败 ${res.errors.length} 条: ${res.errors[0].reason}` };
    }
  } catch (err) {
    return { removed: false, deleted: 0, reason: `路径向量删除失败: ${(err as Error).message}` };
  }
  if (deleted > 0) return { removed: true, deleted };
  if (contentCount === 0) return { removed: false, deleted: 0, missing: true };

  try {
    const hits = await vectorSearch({
      scope: params.scope,
      query: params.relation,
      tags: [RELATION_TAG],
      limit: SEARCH_LIMIT,
    });
    const ids = hits
      .filter((hit) => {
        const content = (hit.content || '').trim();
        return content === params.relation
          || content.startsWith(`${params.relation} |`)
          || content.startsWith(`${params.relation} `)
          // 分块形态 `relation-NN`（NN 两位起，100 chunk 的文档是 relation-100）
          || (new RegExp(`^${escapeRegExp(params.relation)}-\\d{2,}$`).test(content)
            && !params.siblingNames?.has(content));
      })
      .map((hit) => hit.memoryId)
      .filter(Boolean) as string[];
    if (ids.length === 0) {
      // cache 声称写过内容向量却没有路径向量 —— 静默会让「删完仍能被按名召回」变成不一致
      return {
        removed: false,
        deleted: 0,
        missing: true,
        reason: '路径向量未命中（已试 单条 / 分块后缀 / 历史 三种形态，库中亦无匹配）',
      };
    }
    const res = await vectorDelete({ scope: params.scope, ids });
    if (res.errors.length > 0) {
      return { removed: false, deleted: res.deleted, reason: `路径向量兜底删除失败: ${res.errors[0].reason}` };
    }
    return res.deleted > 0
      ? { removed: true, deleted: res.deleted }
      : { removed: false, deleted: 0, reason: `路径向量兜底删除未生效（ids=${ids.join(',')}）` };
  } catch (err) {
    return { removed: false, deleted: 0, reason: `路径向量 search 兜底失败: ${(err as Error).message}` };
  }
}
