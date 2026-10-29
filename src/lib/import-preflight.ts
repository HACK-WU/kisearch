/**
 * import-preflight.ts —— 重复导入预检（REQ-20261010-001 R6 / A10）。
 *
 * 目的：导入**前**告诉用户「本次 N 篇与库中已有文档内容一致，但 sourcePath 不同，
 * 会作为新文档创建」，由用户确认后才继续；取消则什么都不发生（本模块**只读**：
 * 不复制附件、不写 local KB / 向量 / 元数据）。
 *
 * 为什么需要它：路径口径对齐（R1）之后，跨入口重复导入已被幂等覆盖吸收；剩下的
 * "内容一致但 rel 不同"（例如同一份 wiki 被克隆到别处、或目录层级不同）仍会产生副本，
 * 而这类重复从进度条上看不出来。
 *
 * 判据已抽到 `duplicate-index.ts`（REQ-20261019-002）：因为导入侧「跳过重复」必须复用
 * 同一判据，而本模块依赖 `import.ts` 的 `collectMarkdownFiles`，直接反向引用会成环。
 * 判据细节（原文 sha256、`sourcePath !== rel`、空 sourcePath 视为命中）见该模块文件头。
 *
 * 成本：O(库内文档数) 次 sha256 + O(本次文件数)。数万篇量级为数十~数百毫秒；
 * 暂不设上限（如需可加“库内文档数超阈值则跳过预检”的降级）。
 */

import { collectDuplicateHits } from './duplicate-index.js';
import { collectMarkdownFiles } from './import.js';
import { DEFAULT_EXTENSIONS } from './config.js';

export interface ImportPreflightDuplicate {
  /** 本次待导入文件的相对路径（与 `ki import` 的 rel 同口径） */
  rel: string;
  /** 库中命中的文档落点 */
  existingGroup: string;
  existingRelation: string;
  /** 库中该文档记录的来源路径（可能为空：手工 sync-relation 写入的文档没有 sourcePath） */
  existingSourcePath: string;
}

export interface ImportPreflightResult {
  ok: true;
  scope: string;
  files: {
    /** 本次预检扫描到的 Markdown 文件数 */
    scanned: number;
    /** 命中「内容一致但来源不同」的文件数（完整计数，不受明细截断影响） */
    matched: number;
  };
  duplicates: ImportPreflightDuplicate[];
  /** 明细被截断（`duplicates.length` 达到上限；`files.matched` 仍是完整计数） */
  truncated: boolean;
}

export const DEFAULT_PREFLIGHT_MAX_DETAIL = 50;

/**
 * 预检暂存目录（`~/.ki/import-uploads/<uploadId>/`）里的文件是否与库中已有文档重复。
 *
 * @param args.onlyRelPaths 只检查这些相对路径（「重试未完成」子集与 run 同口径）
 */
export function preflightImportDuplicates(args: {
  scope: string;
  sourceDir: string;
  onlyRelPaths?: string[];
  /**
   * 本次导入的显式 group（与 `/api/import/run` 同参数）。
   * ★ 必传才能判断"是否同一篇文档"：落点 = group + rel，只比裸 rel 会在 group 吸收路径前缀时误判。
   */
  group?: string;
  maxDetail?: number;
  extensions?: string[];
}): ImportPreflightResult {
  const maxDetail = args.maxDetail ?? DEFAULT_PREFLIGHT_MAX_DETAIL;
  const { files } = collectMarkdownFiles(args.sourceDir, args.extensions ?? DEFAULT_EXTENSIONS);
  const onlySet = args.onlyRelPaths ? new Set(args.onlyRelPaths) : null;
  const effective = (onlySet ? files.filter((rel) => onlySet.has(rel)) : files).sort();
  // 判据单一真相：与导入侧「跳过重复」共用同一实现（排序保证明细顺序稳定）
  const hits = collectDuplicateHits({
    scope: args.scope,
    sourceDir: args.sourceDir,
    relPaths: effective,
    ...(args.group ? { group: args.group } : {}),
  });
  const duplicates: ImportPreflightDuplicate[] = [];
  for (const [rel, hit] of hits) {
    if (duplicates.length >= maxDetail) break;
    duplicates.push({ rel, ...hit });
  }
  return {
    ok: true,
    scope: args.scope,
    files: { scanned: effective.length, matched: hits.size },
    duplicates,
    truncated: hits.size > duplicates.length,
  };
}
