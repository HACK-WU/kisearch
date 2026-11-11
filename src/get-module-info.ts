#!/usr/bin/env node
/**
 * get-module-info.ts - 模块检索
 *
 * 读取本地 KB index.json，返回 Relation 对应的 Markdown 文本，同时更新评分。
 *
 * 用法:
 *   npx jiti src/get-module-info.ts --scope <scope> --group <group> --relation <relationId>
 */

import { Command } from 'commander';
import { readJson, writeJson, scopeDirExists, readGroupIndex } from './lib/store.js';
import {
  getRelationsCachePath,
  getLocalKbDir,
  validateScope,
} from './lib/scope.js';
import { recordUse, calculateScore } from './lib/scoring.js';
import type { Relation } from './lib/scoring.js';
import type { PartitionConfig } from './lib/constants.js';
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import { hasShardedLayout, listGroupPaths, loadGroupCache, loadPartitionConfig, writeGroupCache, buildGroupMatchContext } from './lib/group-cache.js';
// S-04 I2 补口（2026-10-10）：本文件是**读详情**路径，但会回写评分（元数据）→ 必须入提交窗口
import { getSharedOperationCoordinator } from './lib/operation-coordinator.js';
import { searchPath } from './lib/path-search.js';
import { closeEngine } from './lib/vector-client.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { resolveScopeTargets, getViewMembers, isViewRequest } from './lib/scope-view.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
import { contentRevision } from './lib/relation-edit-draft.js';

// ─── 类型定义 ───

interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
}

interface RelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

// ─── 输出 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── 分段读取（长文档分页）───

/**
 * 单次分段返回的字符边界。
 *
 * ⚠️ 分页**默认不生效**：不传 `maxChars` 时仍返回全文，字段集合与引入分页前逐字节一致。
 * 只有「有预算约束的通道」（内置 AI 对话）会显式注入窗口 —— CLI 与外部 MCP 没有预算，
 * 不该被静默降级成只拿到片段。
 */
export const PAGE_MIN_CHARS = 500;
export const PAGE_MAX_CHARS = 200_000;
/** 传了 `maxChars` 但值不可用时的兜底窗口 */
export const PAGE_DEFAULT_CHARS = 8000;

/** 分段窗口参数（全部可选；都不传 = 全文） */
export interface PageWindowParams {
  /** 起始行，1-based（默认 1） */
  startLine?: number;
  /** 起始行内字符偏移，0-based（默认 0）；仅当上次返回的 `nextStart.char > 0` 时才需要 */
  startChar?: number;
  /** 本次返回正文的字符上限 */
  maxChars?: number;
}

export interface DocSlice {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** true = 文末还有未返回的内容，按 `nextStart` 续读 */
  truncated: boolean;
  nextStart?: { line: number; char: number };
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** UTF-16 高位代理（0xD800–0xDBFF）：切在它前面才不会劈开一个字符 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 按**行边界**截取文档的一段（单行超过窗口时才退化为字符切分）。
 *
 * 为什么沿行边界而不是按字符硬切：分段结果会被 JSON 序列化后交给模型，
 * 切在字符串中间会让 JSON 不闭合，模型连已返回的部分都无法解析
 * （串行化层的硬切正是引入分页要解决的问题）。
 */
export function sliceDocWindow(markdown: string, opts: PageWindowParams = {}): DocSlice {
  const lines = markdown.split(/\r?\n/);
  const totalLines = lines.length;
  const maxChars = clampInt(opts.maxChars, PAGE_MIN_CHARS, PAGE_MAX_CHARS, PAGE_DEFAULT_CHARS);
  const startLine = clampInt(opts.startLine, 1, totalLines, 1);
  let char = clampInt(opts.startChar, 0, Number.MAX_SAFE_INTEGER, 0);

  const parts: string[] = [];
  let used = 0;
  let i = startLine - 1;
  let nextStart: { line: number; char: number } | undefined;
  /** 末行只返回了前半个（单行超窗）→ endLine 仍算该行 */
  let splitMidLine = false;

  while (i < totalLines) {
    const line = lines[i];
    const seg = char > 0 ? line.slice(char) : line;
    if (char > 0 && seg.length === 0) {
      // 续读位置正好落在该行末尾：顺延到下一行行首
      i += 1;
      char = 0;
      continue;
    }
    const sep = parts.length > 0 ? 1 : 0; // 行间 '\n'
    if (used + seg.length + sep > maxChars) {
      if (parts.length === 0) {
        // 首行就超窗：退化为字符切分，但至少前进 1 个字符 —— 保证续读有进展、不死循环
        let take = Math.max(1, Math.min(maxChars, seg.length));
        // 不许把代理对（emoji 等）劈成半个，否则续读拼回去就变成了乱码
        if (take > 1 && take < seg.length && isHighSurrogate(seg.charCodeAt(take - 1))) take -= 1;
        parts.push(seg.slice(0, take));
        nextStart = { line: i + 1, char: char + take };
        splitMidLine = true;
      } else {
        nextStart = { line: i + 1, char };
      }
      break;
    }
    parts.push(seg);
    used += seg.length + sep;
    i += 1;
    char = 0;
  }

  const truncated = nextStart !== undefined;
  const endLine = !truncated
    ? totalLines
    : splitMidLine
      ? nextStart!.line
      : nextStart!.line - 1;

  return {
    content: parts.join('\n'),
    startLine,
    endLine,
    totalLines,
    truncated,
    ...(nextStart ? { nextStart } : {}),
  };
}

/** 分段续读提示（拼进 `hint`，模型据此决定下一次调用参数） */
function pagingHint(slice: DocSlice): string {
  const range = `第 ${slice.startLine}–${slice.endLine} 行（共 ${slice.totalLines} 行）`;
  if (!slice.truncated || !slice.nextStart) return `【分段】本次返回${range}，已到文末。`;
  const next = slice.nextStart.char > 0
    ? `start_line: ${slice.nextStart.line}, start_char: ${slice.nextStart.char}`
    : `start_line: ${slice.nextStart.line}`;
  return `【分段】本次返回${range}，后面还有内容；继续读取请传 ${next}。`;
}

// ─── MCP / CLI 共享纯函数 ───

export interface GetModuleInfoParams extends PageWindowParams {
  scope: string;
  group: string;
  relation: string;
}

export type GetModuleInfoResult =
  | {
    ok: true;
    scope: string;
    content: string;
    /** **整篇**正文的修订号（不是片段的）—— `ki_edit_relation` 依赖它 */
    revision: string;
    totalLines: number;
    hint?: string;
    /** 落点来源（REQ-20261021-001）：仅兜底写入时下发，缺省即显式 */
    groupSource?: 'scope-fallback';
    /** 以下字段仅在传了 `maxChars` 时出现（老行为不新增字段） */
    startLine?: number;
    endLine?: number;
    /** true = 文末还有内容 */
    truncated?: boolean;
    nextStart?: { line: number; char: number };
  }
  | { ok: false; error: string; hint?: string };

/**
 * 在 Group 内查找 Relation：先精确匹配（id 或名称），未命中再走向量模糊兜底。
 * 供单条/批量两条链路复用；searchPath 自带降级（向量不可用返回 null，静默跳过模糊匹配）。
 *
 * @param noVectorFallback true = **跳过**向量兜底（纯元数据读，不打开 zvec）。
 *   这是 HTTP `/api/doc/get` 能以 `read` 类型入队的前提（read 契约要求不触碰引擎，
 *   见 operation-coordinator.ts 的 TaskKind 说明）。
 */
async function findRelationWithFuzzy(
  groupData: GroupData,
  relation: string,
  scope: string,
  noVectorFallback = false
): Promise<{ rel: Relation; fuzzyHint?: string } | null> {
  const exact = groupData.hot_relations.find(
    (r) => r.id === relation || r.text === relation
  );
  if (exact) return { rel: exact };
  if (noVectorFallback) return null;

  const fuzzyRel = await searchPath(relation, 'ki-relation', scope);
  if (fuzzyRel && fuzzyRel.matched) {
    const fuzzyRelText = fuzzyRel.extractedPath;
    const fuzzyMatchedRel = groupData.hot_relations.find((r) => r.text === fuzzyRelText);
    if (fuzzyMatchedRel) {
      return {
        rel: fuzzyMatchedRel,
        fuzzyHint: `💡 近似匹配：Relation "${relation}" → "${fuzzyRelText}"（score: ${fuzzyRel.score.toFixed(2)}）`,
      };
    }
  }
  return null;
}

/**
 * 读详情的选项（REQ 2026-10-13 读通道解耦）：
 * `noVectorFallback=true` 时全程不打开 zvec —— 不做 group 路径与 relation 名的向量模糊兜底。
 * 这是 HTTP `/api/doc/get` 能以 `read` 类型入队的前提（read 只与「元数据提交窗口」互斥、
 * 可旁路导入/向量化长任务；见 operation-coordinator.ts 的 TaskKind 契约）。
 */
export interface GetModuleInfoReadOptions {
  noVectorFallback?: boolean;
}

export async function executeGetModuleInfoLocal(
  params: GetModuleInfoParams,
  opts: GetModuleInfoReadOptions = {}
): Promise<GetModuleInfoResult> {
  try {
    const { scope, relation } = params;
    const group = String(params.group).replace(/^\/+|\/+$/g, '');

    validateScope(scope);
    // 读路径不得建目录：scope 不存在就如实报「尚未导入」，而不是凭空造一个空库
    if (!scopeDirExists(scope)) {
      return {
        ok: false as const,
        error: `知识库 "${scope}" 尚未导入（KB 目录不存在）`,
        hint: `确认 scope 名是否正确；需要新建请执行 ki import --scope ${scope} …`,
      };
    }

    // 批次 2（R1，S0-5 核心收益点）：单文档读取改单组读——新布局只读目标组分片
    //（树匹配用 listGroupPaths 轻量枚举键，不聚合全量 relation），评分回写只写该组。
    // 旧布局保持整读整写（兼容期行为不变）。
    const hasSharded = hasShardedLayout(scope);
    let groupsContext: Record<string, unknown>;
    let partitionConfig: PartitionConfig;
    if (hasSharded) {
      const keys = listGroupPaths(scope);
      // 占位值须为真值对象（resolveGroupPath 用 truthy 判断；传 null 会让树/cache 不同步时
      // 的“直接匹配”兜底分支失效——批次 2 审查 P1-2）
      groupsContext = buildGroupMatchContext(keys);
      partitionConfig = loadPartitionConfig(scope);
    } else {
      const cache = readJson<RelationsCache>(getRelationsCachePath(scope));
      if (!cache) {
        return { ok: false, error: 'relations-cache.json 不存在', hint: '请先使用 sync-relation.ts 写入关系' };
      }
      groupsContext = cache.groups;
      partitionConfig = cache.partition_config || DEFAULT_PARTITION_CONFIG;
    }

    const groupIndex = readGroupIndex(scope);
    // 不传 scope ⇒ 关闭 resolveGroupPath 步骤 7 的向量语义兜底（noVectorFallback 场景）
    const resolved = await resolveGroupPath(
      group,
      groupIndex || { version: 1, scope, groups: {}, updatedAt: null },
      groupsContext,
      opts.noVectorFallback ? undefined : scope
    );

    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到有效路径`, hint: resolved.hint };
    }

    const resolvedGroup = resolved.resolvedPath;
    const hints: string[] = [];
    if (resolved.hint) hints.push(resolved.hint);

    // R1：新布局按 resolvedGroup 精确读目标组分片；旧布局读整文件中该组（兼容）
    // R1：按 resolvedGroup 精确读目标组（新布局=单组分片；旧布局=整文件中该组）
    const groupData: GroupData | null = hasSharded
      ? loadGroupCache(scope, resolvedGroup)
      : (groupsContext[resolvedGroup] as GroupData | undefined) ?? null;
    if (!groupData) {
      return {
        ok: false,
        error: `Group "${resolvedGroup}" 在 relations-cache 中暂无 Relation 数据`,
        hint: '该 Group 路径存在但尚未写入知识条目，请先使用 sync-relation.ts 写入',
      };
    }

    let rel: Relation | null = null;
    {
      const found = await findRelationWithFuzzy(groupData, relation, scope, opts.noVectorFallback === true);
      if (found) {
        rel = found.rel;
        if (found.fuzzyHint) hints.push(found.fuzzyHint);
      }
    }

    if (!rel) {
      const availableRelations = groupData.hot_relations.map((r) => r.text);
      const relationHint = availableRelations.length > 0
        ? `Group "${resolvedGroup}" 中可用的 Relation：\n${availableRelations.map((r) => `  - ${r}`).join('\n')}`
        : `Group "${resolvedGroup}" 中暂无 Relation`;
      return {
        ok: false,
        error: `Relation "${relation}" 不存在于 Group "${resolvedGroup}" 中`,
        hint: relationHint,
      };
    }

    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    const localKb = readJson<Record<string, string>>(localKbPath);

    if (!localKb) {
      return {
        ok: false,
        error: `本地 KB 文件不存在：${localKbPath}`,
        hint: [
          '本地 KB 缺失的可能原因与修复方式：',
          `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
          '2. 如果是从外部 Wiki 导入的数据，检查 ki import 是否完整执行',
          '3. 检查数据文件是否被误删除或备份恢复不完整',
        ].join('\n'),
      };
    }

    const markdown = localKb[rel.text] ?? null;
    if (!markdown) {
      return {
        ok: false,
        error: `本地 KB 中未找到 "${rel.text}" 的内容`,
        hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
      };
    }

    // 分段读取：**只在调用方显式给了窗口时生效**，否则 content 仍是全文（老行为）
    let slice: DocSlice | null = null;
    if (params.maxChars === undefined && (params.startLine !== undefined || params.startChar !== undefined)) {
      // 只给起点、不给窗口：静默返回全文会让调用方以为「从第 N 行读到了文末」——
      // 起点参数被无声忽略是最难发现的一类错，直接吵出来
      return {
        ok: false,
        error: '传了 start_line / start_char 但没有 max_chars：分段读取必须显式指定窗口',
        hint: '补上 max_chars（如 8000）；只想读全文则不要传 start_line / start_char',
      };
    }
    if (params.maxChars !== undefined) {
      const totalLines = markdown.split(/\r?\n/).length;
      if (params.startLine !== undefined && params.startLine > totalLines) {
        // 静默钳制会让调用方以为读到了文末 —— 越界一律 fail-loud 并回报真实行数
        return {
          ok: false,
          error: `start_line ${params.startLine} 超出文档行数（共 ${totalLines} 行）`,
          hint: `从 1–${totalLines} 之间取值；不传 start_line 则从第 1 行开始`,
        };
      }
      slice = sliceDocWindow(markdown, {
        startLine: params.startLine,
        startChar: params.startChar,
        maxChars: params.maxChars,
      });
      hints.push(pagingHint(slice));
    }

    // 更新评分（recordUse）
    const now = Date.now();
    const updatedRel = recordUse(rel, now);
    updatedRel.score = calculateScore(updatedRel.useCount, updatedRel.lastUsedTime, now, partitionConfig.halfLifeHours);

    const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel.id);
    groupData.hot_relations[relIdx] = updatedRel;
    // R1（S0-5 核心收益）：评分回写只写该组分片（三步曲：bump→WAL→失效）；
    // 旧布局保持整文件回写（兼容期行为不变）。
    //
    // 第二轮审查 P2：布局在本函数 `await resolveGroupPath`（含向量兜底，窗口可达秒级）
    // 期间可能被另一进程惰性迁移——按入口快照写会把评分回写进已改名 `.bak` 的旧文件，
    // 此后无人读（静默丢失）。这里按**写入时刻**的布局重判。
    const writeShard = (): void => {
      writeGroupCache(scope, resolvedGroup, {
        version: 1,
        scope,
        hot_relations: groupData.hot_relations,
        keywords: groupData.keywords ?? [],
        updatedAt: null,
      });
    };
    // ★ S-04 I2 补口（2026-10-10）：评分回写属**元数据写**，必须入「元数据提交窗口」。
    // 本函数是**读详情**路径（工具调用本身串行），但自 I4 起 `read` 通道任务可与写任务
    // 并行 ⇒ 窗外写会让并发读看到"半新半旧"（跨文件不一致）。
    // 窗口只包住写本身（毫秒级），**不含**上面的 `await resolveGroupPath`（可达秒级）。
    getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
      if (hasShardedLayout(scope)) {
        writeShard();
      } else {
        // 旧布局：读改写完整 cache（partition_config 等顶层字段不可丢）
        const legacyPath = getRelationsCachePath(scope);
        const fullCache = readJson<RelationsCache>(legacyPath);
        if (fullCache) {
          fullCache.groups[resolvedGroup] = groupData;
          writeJson(legacyPath, fullCache as unknown as Record<string, unknown>);
        } else {
          // 旧文件已在本轮 await 期间被迁移（改名 .bak）→ 补写分片
          writeShard();
        }
      }
    });

    return {
      ok: true,
      scope,
      content: slice ? slice.content : markdown,
      // ★ 始终是**整篇**的修订号：分页读取后仍要能用它做 ki_edit_relation 的 expected_revision
      revision: contentRevision(markdown),
      totalLines: markdown.split(/\r?\n/).length,
      ...(hints.length > 0 ? { hint: hints.join('\n') } : {}),
      // 落点来源留痕（REQ-20261021-001）：只在兜底时下发
      ...(rel.groupSource ? { groupSource: rel.groupSource } : {}),
      ...(slice
        ? {
          startLine: slice.startLine,
          endLine: slice.endLine,
          truncated: slice.truncated,
          ...(slice.nextStart ? { nextStart: slice.nextStart } : {}),
        }
        : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeGetModuleInfo(params: GetModuleInfoParams): Promise<GetModuleInfoResult> {
  if (shouldUseDaemonClient()) return callDaemon<GetModuleInfoResult>('get-module-info', params);
  return executeGetModuleInfoLocal(params);
}

// ─── 批量查询（同 Group 下多个 Relation，CLI/MCP 共享纯函数） ───

/** 单次批量查询上限：超限 fail-loud（防 AI 单次拖爆上下文），提示拆批 */
export const MAX_BATCH_RELATIONS = 10;

/** 批量分段时，每条结果除正文外的结构开销估算（relation 名 + 提示 + 分页字段 + JSON 缩进） */
const BATCH_ITEM_OVERHEAD = 300;

export interface BatchRelationResult {
  /** 调用方传入的 Relation 名称/ID */
  relation: string;
  /** 近似匹配命中时的实际 Relation 名（精确匹配时不出现） */
  matchedRelation?: string;
  ok: boolean;
  content?: string;
  error?: string;
  hint?: string;
  /** 以下字段仅在传了整批 `maxChars` 时出现（每条独立窗口，窗口 = maxChars ÷ 条数） */
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated?: boolean;
  nextStart?: { line: number; char: number };
}

export type GetModuleInfoBatchResult =
  | {
      ok: true;
      scope: string;
      /** 路径解析后的实际 Group */
      group: string;
      results: BatchRelationResult[];
      succeeded: number;
      failed: number;
      /** Group 路径解析提示（自动补全/近似匹配） */
      hint?: string;
    }
  | { ok: false; error: string; hint?: string };

export interface BatchGetModuleInfoParams {
  scope: string;
  group: string;
  relations: string[];
  /**
   * 整批正文的字符上限，按条数**均分**给每条（每项 `floor(maxChars ÷ 条数)`，下限 `PAGE_MIN_CHARS`）。
   * 不传 = 每条都返回全文（老行为）。
   */
  maxChars?: number;
  /** 批量下「第几行」语义歧义 —— 传了即 fail-loud，要求改用单条 relation 分页 */
  startLine?: number;
  /** 同上：批量下没有「某一行内偏移」的共同语义，传了即 fail-loud */
  startChar?: number;
}

/**
 * 批量读取同 Group 下多个 Relation 的本地 KB Markdown 内容（≤ MAX_BATCH_RELATIONS 条）。
 *
 * 与逐条调用 executeGetModuleInfo 相比的收益：
 *   1. Group 路径解析（resolveGroupPath 向量语义兜底）只做一次——省 N-1 次 embedding 调用；
 *   2. localKb index.json 一次读取（同 Group 共享同一文件）；
 *   3. N 条评分更新合并一次 writeJson 落盘。
 *
 * 语义：
 *   - 逐条独立 ok：某条不存在/KB 缺内容仅该条失败，不阻塞其他条目；
 *   - relations 去重（保留首次出现顺序），重复条目只查询一次（recordUse 5min 防刷也会拦截重复计分）；
 *   - 超上限 fail-loud 报错（不静默截断）；
 *   - 整体性失败（cache/group/KB 缺失）返回 ok:false，与单条链路同语义。
 */
async function executeGetModuleInfoBatchLocal(params: BatchGetModuleInfoParams): Promise<GetModuleInfoBatchResult> {
  try {
    const { scope } = params;
    const group = String(params.group).replace(/^\/+|\/+$/g, '');

    // 入参护栏：去重（保留首次出现顺序）、空判、上限 fail-loud
    const rawList = Array.isArray(params.relations) ? params.relations : [];
    const relations = [...new Set(rawList.map((r) => String(r ?? '').trim()).filter(Boolean))];
    if (relations.length === 0) {
      return { ok: false, error: 'relations 不能为空' };
    }
    if (relations.length > MAX_BATCH_RELATIONS) {
      return {
        ok: false,
        error: `批量查询上限为 ${MAX_BATCH_RELATIONS} 条（去重后 ${relations.length} 条），请拆分调用`,
        hint: `建议分 ${Math.ceil(relations.length / MAX_BATCH_RELATIONS)} 批查询`,
      };
    }
    // 每条的「第几行」在批量下没有共同语义 —— 与其猜一个，不如直接指路
    if (params.startLine !== undefined || params.startChar !== undefined) {
      return {
        ok: false,
        error: '批量查询不支持 start_line / start_char：一次批量只能整体从文首返回',
        hint: '需要分段读取某一条时，改用单条 relation 传 start_line / max_chars',
      };
    }

    validateScope(scope);
    // 读路径不得建目录：scope 不存在就如实报「尚未导入」，而不是凭空造一个空库
    if (!scopeDirExists(scope)) {
      return {
        ok: false as const,
        error: `知识库 "${scope}" 尚未导入（KB 目录不存在）`,
        hint: `确认 scope 名是否正确；需要新建请执行 ki import --scope ${scope} …`,
      };
    }

    // 批次 2（R1 批量）：单组读（同单条模式——批量本就限定同一 Group）
    const batchSharded = hasShardedLayout(scope);
    let batchGroupsContext: Record<string, unknown>;
    let batchPartitionConfig: PartitionConfig;
    if (batchSharded) {
      const keys = listGroupPaths(scope);
      batchGroupsContext = buildGroupMatchContext(keys);
      batchPartitionConfig = loadPartitionConfig(scope);
    } else {
      const cache = readJson<RelationsCache>(getRelationsCachePath(scope));
      if (!cache) {
        return { ok: false, error: 'relations-cache.json 不存在', hint: '请先使用 sync-relation.ts 写入关系' };
      }
      batchGroupsContext = cache.groups;
      batchPartitionConfig = cache.partition_config || DEFAULT_PARTITION_CONFIG;
    }

    // Group 路径解析：批量只做一次（省 N-1 次向量语义兜底调用）
    const groupIndex = readGroupIndex(scope);
    const resolved = await resolveGroupPath(group, groupIndex || { version: 1, scope, groups: {}, updatedAt: null }, batchGroupsContext, scope);
    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到有效路径`, hint: resolved.hint };
    }
    const resolvedGroup = resolved.resolvedPath;

    const groupData: GroupData | null = batchSharded
      ? loadGroupCache(scope, resolvedGroup)
      : (batchGroupsContext[resolvedGroup] as GroupData | undefined) ?? null;
    if (!groupData) {
      return {
        ok: false,
        error: `Group "${resolvedGroup}" 在 relations-cache 中暂无 Relation 数据`,
        hint: '该 Group 路径存在但尚未写入知识条目，请先使用 sync-relation.ts 写入',
      };
    }

    const localKbPath = getLocalKbDir(scope, resolvedGroup);
    const localKb = readJson<Record<string, string>>(localKbPath);
    if (!localKb) {
      return {
        ok: false,
        error: `本地 KB 文件不存在：${localKbPath}`,
        hint: [
          '本地 KB 缺失的可能原因与修复方式：',
          `1. 使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation <名称> --module-info <内容>`,
          '2. 如果是从外部 Wiki 导入的数据，检查 ki import 是否完整执行',
          '3. 检查数据文件是否被误删除或备份恢复不完整',
        ].join('\n'),
      };
    }

    const now = Date.now();
    const config = batchPartitionConfig;
    const results: BatchRelationResult[] = [];
    let scoreUpdated = false;
    /**
     * 整批窗口均分给每条：批量本来就是为了「一次多拿」，让总量守住预算才算真的省。
     * 不传 → undefined → 每条全文（老行为）。
     *
     * ★ 要扣掉**每条的结构开销**（relation 名 + 分段提示 + 分页字段 + JSON 缩进，实测约
     *   250–350 字符）。只做 `maxChars ÷ 条数` 的话，10 条 × 750 的正文加上 10 份开销会
     *   顶破上游预算，等于白分页 —— 又回到被硬切的老路。
     */
    const perItemChars = params.maxChars !== undefined
      ? Math.max(PAGE_MIN_CHARS, Math.floor(params.maxChars / relations.length) - BATCH_ITEM_OVERHEAD)
      : undefined;

    for (const relation of relations) {
      const found = await findRelationWithFuzzy(groupData, relation, scope);
      if (!found) {
        const availableRelations = groupData.hot_relations.map((r) => r.text);
        const relationHint = availableRelations.length > 0
          ? `Group "${resolvedGroup}" 中可用的 Relation：\n${availableRelations.map((r) => `  - ${r}`).join('\n')}`
          : `Group "${resolvedGroup}" 中暂无 Relation`;
        results.push({
          relation,
          ok: false,
          error: `Relation "${relation}" 不存在于 Group "${resolvedGroup}" 中`,
          hint: relationHint,
        });
        continue;
      }

      const { rel, fuzzyHint } = found;
      const markdown = localKb[rel.text] ?? null;
      if (!markdown) {
        results.push({
          relation,
          ...(fuzzyHint ? { matchedRelation: rel.text } : {}),
          ok: false,
          error: `本地 KB 中未找到 "${rel.text}" 的内容`,
          hint: `请使用 sync-relation 重新写入：ki sync-relation --scope ${scope} --group "${resolvedGroup}" --relation "${rel.text}" --module-info <内容>`,
        });
        continue;
      }

      // 更新评分（recordUse，5min 防刷对每条独立生效）；批量合并一次落盘
      const updatedRel = recordUse(rel, now);
      updatedRel.score = calculateScore(updatedRel.useCount, updatedRel.lastUsedTime, now, config.halfLifeHours);
      const relIdx = groupData.hot_relations.findIndex((r) => r.id === rel.id);
      groupData.hot_relations[relIdx] = updatedRel;
      scoreUpdated = true;

      const slice = perItemChars !== undefined
        ? sliceDocWindow(markdown, { maxChars: perItemChars })
        : null;
      const itemHint = [fuzzyHint, slice ? pagingHint(slice) : undefined]
        .filter((h): h is string => Boolean(h))
        .join('\n');

      results.push({
        relation,
        ...(fuzzyHint ? { matchedRelation: rel.text } : {}),
        ...(itemHint ? { hint: itemHint } : {}),
        ok: true,
        content: slice ? slice.content : markdown,
        ...(slice
          ? {
            startLine: slice.startLine,
            endLine: slice.endLine,
            totalLines: slice.totalLines,
            truncated: slice.truncated,
            ...(slice.nextStart ? { nextStart: slice.nextStart } : {}),
          }
          : {}),
      });
    }

    if (scoreUpdated) {
      // ★ S-04 I2 补口（见上处说明）：批量查询的评分回写同样入窗
      getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
        if (batchSharded) {
          writeGroupCache(scope, resolvedGroup, {
            version: 1,
            scope,
            hot_relations: groupData.hot_relations,
            keywords: groupData.keywords ?? [],
            updatedAt: null,
          });
        } else {
          const fullCache = readJson<RelationsCache>(getRelationsCachePath(scope));
          if (fullCache) {
            fullCache.groups[resolvedGroup] = groupData;
            writeJson(getRelationsCachePath(scope), fullCache as unknown as Record<string, unknown>);
          }
        }
      });
    }

    const failed = results.filter((r) => !r.ok).length;
    return {
      ok: true,
      scope,
      group: resolvedGroup,
      results,
      succeeded: results.length - failed,
      failed,
      ...(resolved.hint ? { hint: resolved.hint } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeGetModuleInfoBatch(params: BatchGetModuleInfoParams): Promise<GetModuleInfoBatchResult> {
  if (shouldUseDaemonClient()) return callDaemon<GetModuleInfoBatchResult>('get-module-info-batch', params);
  return executeGetModuleInfoBatchLocal(params);
}

// ─── CLI ───

/** 整数选项：非法值直接 fail-loud（CLI 用户看得懂，静默忽略只会读错文档） */
function optInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    output({ ok: false, error: `${name} 应为整数，收到 "${v}"` });
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name('get-module-info')
  .showHelpAfterError()
  .description('模块检索：读取本地 KB + 更新评分')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('-g, --group <group>', 'Group 路径')
  .requiredOption('-r, --relation <relation>', 'Relation ID 或名称（多个用逗号分隔，≤10 条批量查询，须同 Group）')
  .option('--member <scope>', '视图模式下指定来源知识库（同一 group+relation 在多个库都存在时必填）')
  .option('--start-line <n>', '分段读取：起始行（1-based，默认 1；需配合 --max-chars）')
  .option('--start-char <n>', '分段读取：起始行内字符偏移（默认 0；仅上次返回 nextStart.char > 0 时需要）')
  .option('--max-chars <n>', '分段读取：本次正文的字符上限（不传 = 返回全文，与以前一致）')
  .action(async (opts) => {
    const optStartLine = optInt(opts.startLine, '--start-line');
    const optStartChar = optInt(opts.startChar, '--start-char');
    const optMaxChars = optInt(opts.maxChars, '--max-chars');
    const pageArgs = {
      ...(optStartLine !== undefined ? { startLine: optStartLine } : {}),
      ...(optStartChar !== undefined ? { startChar: optStartChar } : {}),
      ...(optMaxChars !== undefined ? { maxChars: optMaxChars } : {}),
    };
    const config = loadConfig();
    const targets = resolveScopeTargets(config, opts.scope);

    /**
     * 视图模式：`group + relation` 在成员库之间**可能多命中**，不能静默选一个。
     *
     * 静默选一个 = 让用户读错库的文档，而且事后无法发现（两份文档可能同名而异义）。
     * 因此：显式 `--member` 优先；否则全部试一遍，唯一命中才返回，多命中 fail-loud
     * 并给出可直接复制执行的 `--member` 命令（S-07 D3）。
     */
    if (isViewRequest(targets)) {
      const viewName = targets.views[0];
      if (targets.scopes.length === 0) {
        output({
          ok: false,
          view: viewName,
          error: `视图 ${viewName} 没有可用的成员库`,
          skipped: targets.skipped,
        });
        await closeEngine();
        process.exit(1);
      }

      const relationArgs = String(opts.relation || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      let candidates: string[];
      if (opts.member) {
        const members = getViewMembers(config, viewName);
        if (!members.includes(opts.member)) {
          output({
            ok: false,
            view: viewName,
            error: `--member "${opts.member}" 不是视图 ${viewName} 的成员。`,
            hint: `该视图的成员：${members.join('、')}`,
          });
          await closeEngine();
          process.exit(1);
        }
        candidates = [opts.member];
      } else {
        candidates = targets.scopes;
      }

      /**
       * 批量（`-r a,b`）在视图下必须落到**单一成员库**（一次查询只能对一个库）。
       * ★ 单成员视图无歧义，自动取唯一成员，不强制 `--member`：
       *   否则 `ki view create solo --members a` 之后连批量读都会被要求 `--member a`，
       *   等于把一个「还没扩成员的视图」判成不可用。
       */
      if (relationArgs.length > 1) {
        const member = opts.member ?? (targets.scopes.length === 1 ? targets.scopes[0] : undefined);
        if (!member) {
          output({
            ok: false,
            view: viewName,
            error: '视图模式下批量查询必须指定 --member（一次批量只能查一个库）。',
            hint: `候选库：${candidates.join('、')}；例：ki get-module-info --scope ${viewName} -g "${opts.group}" -r "${opts.relation}" --member ${candidates[0]}`,
          });
          await closeEngine();
          process.exit(1);
        }
        const batch = await executeGetModuleInfoBatch({
          scope: member,
          group: opts.group,
          relations: relationArgs,
          ...(optMaxChars !== undefined ? { maxChars: optMaxChars } : {}),
          // 起点参数一律下传：批量下它们没有语义，交给核心函数 fail-loud 指路，不静默吞掉
          ...(optStartLine !== undefined ? { startLine: optStartLine } : {}),
          ...(optStartChar !== undefined ? { startChar: optStartChar } : {}),
        });
        output(batch as unknown as Record<string, unknown>);
        await closeEngine();
        if (!batch.ok) process.exit(1);
        return;
      }

      // 逐库探测：命中结果**直接复用**，不再重读一次（曾经是"探针 + 正式读"两次全量 IO）
      const hits: { scope: string; result: GetModuleInfoResult & { ok: true } }[] = [];
      /** 探测失败（引擎锁 / 维度不匹配…）与"没这篇文档"必须分流，否则故障会被说成不存在 */
      const failures: { scope: string; reason: string }[] = [];
      for (const member of candidates) {
        const r = await executeGetModuleInfo({
          scope: member,
          group: opts.group,
          relation: opts.relation,
          ...pageArgs,
        });
        if (r.ok) hits.push({ scope: member, result: r });
        // 单个成员失败不视为命中；若是显式 --member 则直接报错
        else if (opts.member) {
          output({ ok: false, scope: member, error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
          await closeEngine();
          process.exit(1);
        } else {
          failures.push({ scope: member, reason: r.hint ? `${r.error}（${r.hint}）` : r.error });
        }
      }

      if (hits.length === 1) {
        const only = hits[0];
        if (only.result.hint) console.error(only.result.hint);
        console.log(`[scope: ${only.scope}]\n${only.result.content}`);
        await closeEngine();
        return;
      }
      if (hits.length === 0) {
        output({
          ok: false,
          view: viewName,
          error: `在视图 ${viewName} 的 ${candidates.length} 个成员库中均未找到该文档。`,
          hint: `已在以下库中查找：${candidates.join('、')}`,
          ...(failures.length > 0
            ? { failed: failures, note: '部分成员库读取失败（不是"文档不存在"），见 failed 明细' }
            : {}),
        });
        await closeEngine();
        process.exit(1);
      }
      output({
        ok: false,
        view: viewName,
        error: `该文档在视图 ${viewName} 的多个知识库中同时存在，请指定来源库。`,
        candidates: hits.map((h) => ({ scope: h.scope, sourcePath: (h.result as { sourcePath?: string }).sourcePath })),
        hint: `ki get-module-info --scope ${viewName} -g "${opts.group}" -r "${opts.relation}" --member <scope>`,
      });
      await closeEngine();
      process.exit(1);
    }

    const scope = resolveScope(loadConfig(), opts.scope);
    const relationArgs = String(opts.relation || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    // 批量模式（对齐 ki_search 多 scope 逗号分隔先例）：多条逗号分隔 → 一次查同一 Group
    if (relationArgs.length > 1) {
      const batch = await executeGetModuleInfoBatch({
        scope,
        group: opts.group,
        relations: relationArgs,
        ...(optMaxChars !== undefined ? { maxChars: optMaxChars } : {}),
        ...(optStartLine !== undefined ? { startLine: optStartLine } : {}),
        ...(optStartChar !== undefined ? { startChar: optStartChar } : {}),
      });
      output(batch as unknown as Record<string, unknown>);
      await closeEngine();
      if (!batch.ok) process.exit(1);
      return;
    }

    const result = await executeGetModuleInfo({
      scope,
      group: opts.group,
      relation: opts.relation,
      ...pageArgs,
    });
    if (result.ok) {
      if (result.hint) console.error(result.hint);
      // 文本展示输出：开头标注 scope，保证输出内容自解释
      console.log(`[scope: ${result.scope}]\n${result.content}`);
    } else {
      output({ ok: false, scope: opts.scope, error: result.error, ...(result.hint ? { hint: result.hint } : {}) });
    }
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK）
    await closeEngine();
    if (!result.ok) process.exit(1);
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
