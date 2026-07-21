/**
 * Group 路径解析公共模块
 *
 * 提供 Group 路径自动补全、树遍历等能力，供 query-group / get-module-info / sync-relation 等命令复用。
 */

import type { GroupIndex } from './scope.js';
import { searchPath } from './path-search.js';

// ─── 类型定义 ───

export interface ResolveResult {
  /** 解析后的实际 Group 路径（可能经过补全） */
  resolvedPath: string;
  /** 补全提示信息（空字符串表示直接匹配，无需提示） */
  hint: string;
  /** 是否匹配成功（路径存在，即使无 Relations 也算成功） */
  matched: boolean;
  /** 当有多个候选时的候选列表 */
  candidates?: string[];
  /** 是否来自向量近似匹配 */
  fuzzyMatched?: boolean;
  /** 向量匹配分数 */
  fuzzyScore?: number;
}

// ─── 树遍历工具函数 ───

/**
 * 检查路径是否在 group-index 树中存在
 */
export function pathExistsInTree(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): boolean {
  const segments = groupPath.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  let current: unknown = groups[segments[0]];
  if (current === undefined) return false;

  for (let i = 1; i < segments.length; i++) {
    if (typeof current !== 'object' || current === null) return false;
    current = (current as Record<string, unknown>)[segments[i]];
    if (current === undefined) return false;
  }
  return true;
}

/**
 * 在 group-index 树中找到路径的最长存在前缀
 * @returns 最长存在的路径段，如 "BK-Monitor-Wiki/告警系统设计"；若第一段就不存在返回 null
 */
export function findLongestExistingPrefix(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): string | null {
  const segments = groupPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  if (groups[segments[0]] === undefined) return null;

  let lastValidPath = segments[0];
  let current: unknown = groups[segments[0]];

  for (let i = 1; i < segments.length; i++) {
    if (typeof current !== 'object' || current === null) break;
    if ((current as Record<string, unknown>)[segments[i]] === undefined) break;
    lastValidPath = `${lastValidPath}/${segments[i]}`;
    current = (current as Record<string, unknown>)[segments[i]];
  }

  return lastValidPath;
}

/**
 * 获取树中某节点下的直接子节点名列表
 */
export function getDirectChildren(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): string[] {
  const segments = groupPath.split('/').filter(Boolean);
  let current: unknown = groups;

  for (const seg of segments) {
    if (typeof current !== 'object' || current === null) return [];
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return [];
  }

  if (typeof current !== 'object' || current === null) return [];
  return Object.keys(current as Record<string, unknown>);
}

// ─── Group 路径自动补全 ───

/**
 * 解析 Group 路径：直接匹配失败时，自动尝试在顶层 Group 下补全路径
 *
 * 匹配策略（四层查找 + 向量兜底）：
 * 1. 直接匹配：groupsData 精确匹配 或 group-index 树精确匹配
 * 2. 整段补全：拼接顶层 Group 前缀后匹配
 *    - 唯一命中 → 自动补全
 *    - 多个命中 → 提示候选列表
 * 3. 部分匹配：找到最长存在前缀，记录提示但不立即返回
 * 4. 向量兜底：通过语义向量搜索找到近似路径（优先于部分匹配提示）
 *    - 命中 → 返回近似匹配结果
 *    - 未命中 → 回退到部分匹配提示
 * 5. 完全无匹配 → 提示可用顶层 Group
 *
 * @param userInput 用户输入的 Group 路径
 * @param groupIndex group-index.json 数据
 * @param groupsData relations-cache 中的 groups 数据（用于直接匹配有 Relation 数据的 Group）
 * @param scope 可选，传入 scope 以启用向量语义兜底
 */
export async function resolveGroupPath(
  userInput: string,
  groupIndex: GroupIndex,
  groupsData: Record<string, unknown>,
  scope?: string
): Promise<ResolveResult> {
  // 1. 直接匹配 groupsData
  if (groupsData[userInput]) {
    return { resolvedPath: userInput, hint: '', matched: true };
  }

  // 2. 在 group-index 树中直接查找（路径完整但 relations-cache 无数据的情况）
  if (pathExistsInTree(groupIndex.groups, userInput)) {
    return { resolvedPath: userInput, hint: '', matched: true };
  }

  // 3. 尝试在每个顶层 Group 下整段补全
  const topGroups = Object.keys(groupIndex.groups);
  const candidates: string[] = [];

  for (const top of topGroups) {
    const candidate = `${top}/${userInput}`;
    if (groupsData[candidate] || pathExistsInTree(groupIndex.groups, candidate)) {
      candidates.push(candidate);
    }
  }

  // 4. 唯一命中 → 自动补全
  if (candidates.length === 1) {
    return {
      resolvedPath: candidates[0],
      hint: `💡 路径已自动补全："${userInput}" → "${candidates[0]}"`,
      matched: true,
    };
  }

  // 5. 多个命中 → 提示候选
  if (candidates.length > 1) {
    return {
      resolvedPath: userInput,
      hint: `⚠️ 路径 "${userInput}" 匹配到多个顶层 Group 下的节点，请指定完整路径：\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
      matched: false,
      candidates,
    };
  }

  // 6. 整段补全失败 → 尝试部分匹配，收集提示信息（不立即返回，留给向量兜底一次机会）
  let partialMatchHint: string | null = null;

  for (const top of topGroups) {
    const fullCandidate = `${top}/${userInput}`;
    const longestPrefix = findLongestExistingPrefix(groupIndex.groups, fullCandidate);

    if (longestPrefix && longestPrefix !== fullCandidate) {
      const failedPart = fullCandidate.slice(longestPrefix.length + 1);
      const children = getDirectChildren(groupIndex.groups, longestPrefix);
      const childHint = children.length > 0
        ? `"${longestPrefix}" 下的子节点：${children.join(', ')}`
        : `"${longestPrefix}" 下无子节点`;

      partialMatchHint = `⚠️ 路径 "${userInput}" 补全为 "${fullCandidate}" 后，"${failedPart}" 不存在。\n${childHint}`;
      break;
    }
  }

  // 7. 向量语义兜底（仅当 scope 提供时启用）
  if (scope) {
    const fuzzyResult = await searchPath(userInput, 'ki-path', scope);
    if (fuzzyResult && fuzzyResult.matched) {
      const candidatePath = fuzzyResult.extractedPath;
      // 校验向量兜底返回的路径是否真实存在于 group-index 或 groupsData 中
      if (pathExistsInTree(groupIndex.groups, candidatePath) || groupsData[candidatePath]) {
        return {
          resolvedPath: candidatePath,
          hint: `💡 近似匹配："${userInput}" → "${candidatePath}"（score: ${fuzzyResult.score.toFixed(2)}）`,
          matched: true,
          fuzzyMatched: true,
          fuzzyScore: fuzzyResult.score,
        };
      }
      // 向量匹配到的路径不存在于索引中，跳过（可能是旧数据残留）
    }
  }

  // 8. 向量兜底也失败 → 使用部分匹配的提示（如有）
  if (partialMatchHint) {
    return {
      resolvedPath: userInput,
      hint: partialMatchHint,
      matched: false,
    };
  }

  // 9. 完全无匹配 → 提示可用顶层 Group
  const topGroupHint = topGroups.length > 0
    ? `可用的顶层 Group：${topGroups.join(', ')}`
    : '该 scope 下暂无 Group';
  return {
    resolvedPath: userInput,
    hint: `⚠️ 路径 "${userInput}" 未匹配到任何 Group。${topGroupHint}`,
    matched: false,
  };
}
