/**
 * groupTree.ts —— 浏览/选择场景共用的 Group 树构建与展开态操作
 *
 * 数据源：/api/doc/list 的 groups（完整 Group 路径 + 本组文档数，不受 docs 分页截断影响）。
 * 约定：
 * - 节点 open（展开态）保存在节点上；所有操作都是纯函数，返回新树而不改写入参。
 * - 未命中任何变更时返回**原数组引用**，便于 React 直接跳过重渲染。
 */

import type { DocGroup } from '@/api/httpApi';

export interface GroupTreeNode {
  name: string;
  path: string;
  /** 仅此 Group 的文档数，不含子 Group。 */
  count: number;
  children: GroupTreeNode[];
  open: boolean;
}

/** 从 groups 列表（完整 group 路径 + count）构建递归树（内含隐含父节点，唯一纯目录根上提一层） */
export function buildGroupTree(groups: DocGroup[]): GroupTreeNode[] {
  const roots: GroupTreeNode[] = [];
  const map = new Map<string, GroupTreeNode>();
  const getNode = (path: string): GroupTreeNode => {
    let node = map.get(path);
    if (!node) {
      node = { name: path.split('/').pop() || path, path, count: 0, children: [], open: false };
      map.set(path, node);
    }
    return node;
  };

  for (const group of groups) {
    const segments = group.name.split('/').filter(Boolean);
    let parent: GroupTreeNode | null = null;
    for (let i = 0; i < segments.length; i++) {
      const node = getNode(segments.slice(0, i + 1).join('/'));
      if (parent) {
        if (!parent.children.some((child) => child.path === node.path)) parent.children.push(node);
      } else if (!roots.some((root) => root.path === node.path)) {
        roots.push(node);
      }
      parent = node;
    }
    if (parent) parent.count = group.count;
  }

  // 只有纯目录节点才能上提；有自身文档的根 Group 必须留在树中供选择。
  if (roots.length === 1 && roots[0].count === 0 && roots[0].children.length > 0) return roots[0].children;
  return roots;
}

/** 优先展示第一个有自身文档的 Group，返回其路径（全树都没有自身文档时返回空串） */
export function firstGroupWithDocuments(nodes: GroupTreeNode[]): string {
  for (const node of nodes) {
    if (node.count > 0) return node.path;
    const child = firstGroupWithDocuments(node.children);
    if (child) return child;
  }
  return '';
}

/** 浏览场景中，有自身文档的父 Group 与叶子 Group 都可选；写入场景仍允许任意父 Group。 */
export function isGroupSelectable(node: GroupTreeNode, allowParentPick = false): boolean {
  return allowParentPick || node.count > 0 || node.children.length === 0;
}

/** 子树文档总数（本组 + 各子组） */
export function countDocs(node: GroupTreeNode): number {
  return node.count + node.children.reduce((sum, child) => sum + countDocs(child), 0);
}

/** 按完整路径查找节点（未找到返回 null） */
export function findGroupNode(nodes: GroupTreeNode[], path: string): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findGroupNode(node.children, path);
    if (found) return found;
  }
  return null;
}

/** 默认展开一级，子级折叠（新树） */
export function withDefaultOpen(nodes: GroupTreeNode[], depth = 0): GroupTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    open: depth === 0,
    children: withDefaultOpen(node.children, depth + 1),
  }));
}

/**
 * 自底向上重写树：mapper 收到（原节点，可能已更新的子节点），返回 null 表示该节点无需变更。
 * 任一层都没有变更时逐层返回原引用，调用方可用引用比较跳过渲染。
 */
function rewriteTree(
  nodes: GroupTreeNode[],
  mapper: (node: GroupTreeNode, children: GroupTreeNode[]) => GroupTreeNode | null,
): GroupTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    const children = node.children.length > 0 ? rewriteTree(node.children, mapper) : node.children;
    const updated = mapper(node, children);
    if (!updated || updated === node) return node;
    changed = true;
    return updated;
  });
  return changed ? next : nodes;
}

/** 切换指定路径的展开态（新树；路径不存在或状态未变时返回原引用） */
export function toggleNodeOpen(nodes: GroupTreeNode[], path: string): GroupTreeNode[] {
  return rewriteTree(nodes, (node, children) => {
    if (node.path === path) return { ...node, open: !node.open, children };
    return children === node.children ? null : { ...node, children };
  });
}

/** 全部展开/折叠（新树；状态未变时返回原引用） */
export function withAllOpen(nodes: GroupTreeNode[], open: boolean): GroupTreeNode[] {
  return rewriteTree(nodes, (node, children) => {
    if (node.children.length === 0) return null;
    if (node.open === open && children === node.children) return null;
    return { ...node, open, children };
  });
}

/**
 * 展开目标 Group 的祖先链，使其在树中可见（新树）。
 * 只处理严格祖先，不改动目标自身与无关分支；已可见时返回原引用。
 */
export function revealGroupPath(nodes: GroupTreeNode[], path: string): GroupTreeNode[] {
  return rewriteTree(nodes, (node, children) => {
    const isAncestor = node.children.length > 0 && path.startsWith(`${node.path}/`);
    if (!isAncestor) return null;
    if (node.open && children === node.children) return null;
    return { ...node, open: true, children };
  });
}
