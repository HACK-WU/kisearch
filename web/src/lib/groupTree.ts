/** 从 /api/doc/list 的完整 Group 路径与本组文档数构建浏览树。 */
export interface GroupTreeNode {
  name: string;
  path: string;
  /** 仅此 Group 的文档数，不含子 Group。 */
  count: number;
  children: GroupTreeNode[];
  open: boolean;
}

export function buildGroupTree(groups: { name: string; count: number }[]): GroupTreeNode[] {
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

/** 优先展示第一个有自身文档的 Group，避免首次打开落在旧的深层叶子节点。 */
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
