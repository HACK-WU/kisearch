#!/usr/bin/env node
/**
 * manage-index.ts - Group 树索引管理 CLI
 * 
 * 用法:
 *   npx jiti scripts/manage-index.ts --scope <scope> --action create-root --root-name <name>
 *   npx jiti scripts/manage-index.ts --scope <scope> --action create --parent <path> --name <name>
 *   npx jiti scripts/manage-index.ts --scope <scope> --action delete --parent <path> --name <name> [--force]
 */

import { Command } from 'commander';
import { readJson, writeJson, ensureScopeDir } from './lib/store.js';
import { getGroupIndexPath, validateScope } from './lib/scope.js';
import { DEFAULT_ROOT_NAME } from './lib/constants.js';

// ─── 类型定义 ───

interface GroupIndex {
  version: number;
  scope: string;
  roots: Record<string, Record<string, unknown>>;
  updatedAt: string | null;
}

// ─── 辅助函数 ───

/**
 * 在树中按路径查找"容器"节点：
 * - parentPath 为空字符串时，返回 roots（根容器），用于操作根节点本身
 * - parentPath 为 "a/b" 时，返回 a 节点下的 b 节点对象（即 b 的子节点容器）
 *
 * 注意：在树结构中，每个节点本身就是其子节点的容器（Record<string, unknown>）。
 * 删除/创建子节点等价于在父容器上 delete/赋值 对应 key。
 *
 * @returns [父容器对象, 路径段数组] 或 null（路径不存在）
 */
function findContainer(
  roots: Record<string, Record<string, unknown>>,
  parentPath: string
): [Record<string, unknown>, string[]] | null {
  const segments = parentPath.split('/').filter(Boolean);

  // 空路径：返回 roots 作为容器（用于操作根节点）
  if (segments.length === 0) {
    return [roots as Record<string, unknown>, []];
  }

  // 第一段是根节点名
  const rootName = segments[0];
  let current: Record<string, unknown> | undefined = roots[rootName];
  if (current === undefined) return null;

  // 遍历后续段
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      return null;
    }
    current = current[seg] as Record<string, unknown>;
  }

  return [current, segments];
}

/**
 * 检查节点是否为空（无子节点）
 */
function isEmptyNode(node: Record<string, unknown>): boolean {
  return Object.keys(node).length === 0;
}

/**
 * 输出 JSON 结果并退出
 */
function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── CLI 定义 ───

const program = new Command();

program
  .name('manage-index')
  .description('Group 树索引管理')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .option('--action <action>', '操作：create | delete | create-root', 'create')
  .option('--parent <parent>', '父节点路径（create/delete 时使用）')
  .option('--name <name>', '节点名称（create 时使用）')
  .option('--root-name <rootName>', '根节点名称（create-root 时使用）')
  .option('--force', '强制删除非空节点', false)
  .action(async (opts) => {
    try {
      const { scope, action, parent, name, rootName, force } = opts;

      // 校验 scope
      validateScope(scope);

      // 确保 scope 目录存在
      ensureScopeDir(scope);

      const indexPath = getGroupIndexPath(scope);
      const data = readJson<GroupIndex>(indexPath);

      if (!data) {
        output({ ok: false, error: `group-index.json 不存在：${indexPath}` });
        process.exit(1);
      }

      switch (action) {
        // ─── 创建根节点 ───
        case 'create-root': {
          if (!rootName) {
            output({ ok: false, error: 'create-root 需要 --root-name 参数' });
            process.exit(1);
          }
          if (data.roots[rootName]) {
            output({ ok: false, error: `根节点 "${rootName}" 已存在` });
            process.exit(1);
          }
          data.roots[rootName] = {};
          writeJson(indexPath, data);
          output({ ok: true, path: rootName });
          break;
        }

        // ─── 创建子节点 ───
        case 'create': {
          if (parent === undefined || parent === null) {
            output({ ok: false, error: 'create 需要 --parent 参数（顶层节点请使用 create-root）' });
            process.exit(1);
          }
          if (!name) {
            output({ ok: false, error: 'create 需要 --name 参数' });
            process.exit(1);
          }
          if (typeof name === 'string' && name.includes('/')) {
            output({ ok: false, error: `节点名 "${name}" 不能包含 "/"` });
            process.exit(1);
          }
          if (!parent) {
            output({ ok: false, error: 'create 的父节点路径不能为空，顶层节点请使用 create-root' });
            process.exit(1);
          }

          const result = findContainer(data.roots, parent);
          if (!result) {
            output({ ok: false, error: `父节点路径不存在：${parent}` });
            process.exit(1);
          }

          const [parentNode] = result;
          if (parentNode[name] !== undefined) {
            output({ ok: false, error: `节点 "${name}" 已存在于 "${parent}" 下` });
            process.exit(1);
          }

          parentNode[name] = {};
          writeJson(indexPath, data);
          output({ ok: true, path: `${parent}/${name}` });
          break;
        }

        // ─── 删除节点 ───
        case 'delete': {
          // 允许 --parent="" 删除根节点本身
          if (parent === undefined || parent === null) {
            output({ ok: false, error: 'delete 需要 --parent 参数（删除根节点请传 --parent ""）' });
            process.exit(1);
          }
          if (!name) {
            output({ ok: false, error: 'delete 需要 --name 参数' });
            process.exit(1);
          }

          // 默认根节点不可删除：仅当 parent 为空（即操作的是根节点）且 name === DEFAULT_ROOT_NAME 时拦截
          if (parent === '' && name === DEFAULT_ROOT_NAME) {
            output({ ok: false, error: `默认根节点 "${DEFAULT_ROOT_NAME}" 不可删除` });
            process.exit(1);
          }

          const result = findContainer(data.roots, parent);
          if (!result) {
            output({ ok: false, error: `父节点路径不存在：${parent}` });
            process.exit(1);
          }

          const [parentNode] = result;
          if (parentNode[name] === undefined) {
            output({ ok: false, error: `节点 "${name}" 不存在于 "${parent || '(根)'}" 下` });
            process.exit(1);
          }

          const targetNode = parentNode[name] as Record<string, unknown>;

          // 非空节点需要 --force
          if (!isEmptyNode(targetNode) && !force) {
            output({
              ok: false,
              error: `节点 "${name}" 非空，包含子节点。使用 --force 强制删除`,
              children: Object.keys(targetNode),
            });
            process.exit(1);
          }

          delete parentNode[name];
          writeJson(indexPath, data);
          output({ ok: true, path: parent ? `${parent}/${name}` : name });
          break;
        }

        default:
          output({ ok: false, error: `未知操作：${action}` });
          process.exit(1);
      }
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
