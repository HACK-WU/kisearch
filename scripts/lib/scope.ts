/**
 * Scope 校验与路径构造
 * 
 * scope 参数仅允许字母、数字、连字符、下划线，拒绝路径遍历字符
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './config.js';

// scope 合法字符正则
const SCOPE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 校验 scope 参数合法性
 * @throws Error 如果 scope 不合法
 */
export function validateScope(scope: string): void {
  if (!scope || typeof scope !== 'string') {
    throw new Error('scope 不能为空');
  }
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error(
      `scope "${scope}" 不合法：仅允许字母、数字、连字符、下划线，禁止路径遍历字符`
    );
  }
}

/**
 * 获取 kb/{scope}/ 目录绝对路径
 * 优先使用 config.scopes[scope].kbDir，fallback 到 config.dataDir/{scope}
 */
export function getKbDir(scope: string): string {
  validateScope(scope);
  const config = loadConfig();
  return getScopeDataDir(config, scope);
}

/**
 * 获取 group-index.json 绝对路径
 */
export function getGroupIndexPath(scope: string): string {
  return path.join(getKbDir(scope), 'group-index.json');
}

/**
 * 获取 relations-cache.json 绝对路径
 */
export function getRelationsCachePath(scope: string): string {
  return path.join(getKbDir(scope), 'relations-cache.json');
}

/**
 * 获取 scan-index.json 绝对路径
 */
export function getScanIndexPath(scope: string): string {
  return path.join(getKbDir(scope), 'scan-index.json');
}

/**
 * 获取本地 KB 中某个 Group 的 index.json 路径
 * @param scope 项目标识
 * @param groupPath Group 路径，如 "监控/告警中心"
 */
export function getLocalKbDir(scope: string, groupPath: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), groupPath, 'index.json');
}

// ─── group-index.json 的 source 块（S-01） ───

/**
 * source 块：记录知识库的外部来源信息
 * - dir: 外部知识库根目录绝对路径
 * - rootName: 顶层 Group 名称
 * - commit: 导入时源仓库的 git HEAD commit hash（增量 diff 的起点）
 */
export interface GroupIndexSource {
  dir: string;
  rootName: string;
  commit: string;
}

/**
 * 读取 group-index.json 中的 source 块
 * - 文件不存在 → 返回 null
 * - 文件存在但 source 字段缺失 → 返回 null（存量兼容）
 * - JSON 解析失败 → throw
 */
export function getSource(scope: string): GroupIndexSource | null {
  const filePath = getGroupIndexPath(scope);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as { source?: GroupIndexSource | null };
  const source = data.source;
  if (!source || typeof source !== 'object') return null;
  if (!source.dir || !source.rootName || !source.commit) return null;
  return { dir: source.dir, rootName: source.rootName, commit: source.commit };
}

// ─── GroupIndex 类型与迁移 ───

/**
 * GroupIndex 数据结构（v2：去掉 roots 包裹层）
 *
 * 旧格式（v1）: { roots: { "项目根": { "API": {} } } }
 * 新格式（v2）: { groups: { "API": {} } }
 *
 * 外部导入的 rootName 直接作为顶层 Group 名（如 "BK-Monitor-Wiki"）
 */
export interface GroupIndex {
  version: number;
  scope: string;
  groups: Record<string, Record<string, unknown>>;
  updatedAt: string | null;
  source?: GroupIndexSource | null;
}

/**
 * 自动迁移旧格式 group-index.json（roots → groups）
 *
 * 迁移规则：
 * - "项目根"（默认根节点）的子节点提升到顶层
 * - 其他根节点（如 "BK-Monitor-Wiki"）作为顶层 Group 保留
 * - 迁移后删除 roots 字段
 *
 * @returns 迁移后的 GroupIndex；如果无需迁移返回 null
 */
export function migrateGroupIndex(data: Record<string, unknown>): GroupIndex | null {
  // 已经是新格式
  if (data.groups !== undefined && data.roots === undefined) return null;

  // 没有旧格式字段
  if (!data.roots || typeof data.roots !== 'object') return null;

  const roots = data.roots as Record<string, Record<string, unknown>>;
  // 保留已有 groups 数据（防止 roots + groups 同时存在时覆盖）
  const groups: Record<string, Record<string, unknown>> =
    (data.groups && typeof data.groups === 'object')
      ? { ...data.groups as Record<string, Record<string, unknown>> }
      : {};

  for (const [rootName, children] of Object.entries(roots)) {
    if (rootName === '项目根') {
      // 默认根节点的子节点提升到顶层
      if (children && typeof children === 'object') {
        Object.assign(groups, children);
      }
    } else {
      // 外部导入的 rootName 作为顶层 Group 保留
      groups[rootName] = children || {};
    }
  }

  const migrated: GroupIndex = {
    version: (data.version as number) || 1,
    scope: (data.scope as string) || '',
    groups,
    updatedAt: (data.updatedAt as string | null) || null,
    source: (data.source as GroupIndexSource | null) || null,
  };

  return migrated;
}

/**
 * 确保 Group 路径在 GroupIndex.groups 树中完整存在
 * 路径中缺失的节点自动补建，Group 树只增不删。
 *
 * @example ensureGroupPathInTree(index, "配置/API/鉴权")
 *           → 依次确保 "配置"、"API"、"鉴权" 节点存在
 */
export function ensureGroupPathInTree(index: GroupIndex, groupPath: string): void {
  const segments = groupPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length === 0) return;

  if (!index.groups[segments[0]]) {
    index.groups[segments[0]] = {};
  }
  let current: Record<string, unknown> = index.groups[segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
}

// ─── Scope 枚举 ───

/**
 * 列出 kb/ 下所有已初始化的 scope
 * - 仅返回符合 scope 命名规则的目录
 * - 仅返回包含 relations-cache.json 的目录（即已初始化的 scope）
 */
export function listAllScopes(): string[] {
  const config = loadConfig();
  const scopeSet = new Set<string>();

  // 1. 扫描 dataDir 下的目录
  if (fs.existsSync(config.dataDir)) {
    const entries = fs.readdirSync(config.dataDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(e.name)) {
        const scopeDir = path.join(config.dataDir, e.name);
        if (fs.existsSync(path.join(scopeDir, 'relations-cache.json'))) {
          scopeSet.add(e.name);
        }
      }
    }
  }

  // 2. 合并 config.scopes 中配置的自定义 kbDir 的 scope
  for (const [name, sc] of Object.entries(config.scopes)) {
    if (sc.kbDir && fs.existsSync(path.join(sc.kbDir, 'relations-cache.json'))) {
      scopeSet.add(name);
    }
  }

  return [...scopeSet];
}

/**
 * 写入 / 更新 source 块到 group-index.json
 * - 不修改 groups / version / scope 字段
 * - 自动刷新 updatedAt
 * @throws Error 如果 group-index.json 不存在（调用方应先确保 ensureScopeDir）
 */
export function setSource(scope: string, source: GroupIndexSource): void {
  const filePath = getGroupIndexPath(scope);
  if (!fs.existsSync(filePath)) {
    throw new Error(`group-index.json 不存在：${filePath}，请先 ensureScopeDir`);
  }
  if (!source.dir || !source.rootName || !source.commit) {
    throw new Error('setSource 要求 source.{dir,rootName,commit} 均非空');
  }

  // 读取原始数据，先尝试迁移确保数据是新格式
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const migrated = migrateGroupIndex(parsed);
  const data: Record<string, unknown> = migrated
    ? (migrated as unknown as Record<string, unknown>)
    : parsed;

  data.source = { dir: source.dir, rootName: source.rootName, commit: source.commit };
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
