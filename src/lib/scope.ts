/**
 * Scope 校验与路径构造（src 版）
 *
 * scope 参数仅允许字母、数字、连字符、下划线，拒绝路径遍历字符
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './config.js';

// scope 合法字符正则
const SCOPE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** scope 校验错误码（NEG-03：统一错误码/文案） */
export type ScopeErrorCode = 'EMPTY_SCOPE' | 'INVALID_SCOPE';

export class ScopeError extends Error {
  code: ScopeErrorCode;
  constructor(code: ScopeErrorCode, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

/**
 * 校验 scope 参数合法性
 * @throws ScopeError 如果 scope 不合法
 */
export function validateScope(scope: string): void {
  if (!scope || typeof scope !== 'string') {
    throw new ScopeError('EMPTY_SCOPE', 'scope 不能为空');
  }
  if (!SCOPE_PATTERN.test(scope)) {
    // 标出具体非法字符，便于定位（去重保留顺序）
    const illegal = Array.from(new Set(scope.split('').filter((c) => !/[a-zA-Z0-9_-]/.test(c))));
    throw new ScopeError(
      'INVALID_SCOPE',
      `scope "${scope}" 不合法：仅允许字母、数字、连字符(-)、下划线(_)，禁止路径遍历字符` +
        (illegal.length > 0 ? `\n  非法字符：${illegal.map((c) => JSON.stringify(c)).join(', ')}` : '')
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

// ─── group-index.json 的 source 块 ───

export interface GroupIndexSource {
  dir: string;
  rootName: string;
  commit: string;
}

/**
 * 读取 group-index.json 中的 source 块
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

export interface GroupIndex {
  version: number;
  scope: string;
  groups: Record<string, Record<string, unknown>>;
  updatedAt: string | null;
  source?: GroupIndexSource | null;
}

/**
 * 自动迁移旧格式 group-index.json（roots → groups）
 */
export function migrateGroupIndex(data: Record<string, unknown>): GroupIndex | null {
  if (data.groups !== undefined && data.roots === undefined) return null;
  if (!data.roots || typeof data.roots !== 'object') return null;

  const roots = data.roots as Record<string, Record<string, unknown>>;
  const groups: Record<string, Record<string, unknown>> =
    (data.groups && typeof data.groups === 'object')
      ? { ...data.groups as Record<string, Record<string, unknown>> }
      : {};

  for (const [rootName, children] of Object.entries(roots)) {
    if (rootName === '项目根') {
      if (children && typeof children === 'object') {
        Object.assign(groups, children);
      }
    } else {
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
 */
export function listAllScopes(): string[] {
  const config = loadConfig();
  const scopeSet = new Set<string>();

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

  for (const name of Object.keys(config.scopes)) {
    const kbScopeDir = getKbDir(name);
    if (fs.existsSync(path.join(kbScopeDir, 'relations-cache.json'))) {
      scopeSet.add(name);
    }
  }

  return [...scopeSet];
}

/**
 * 写入 / 更新 source 块到 group-index.json
 */
export function setSource(scope: string, source: GroupIndexSource): void {
  const filePath = getGroupIndexPath(scope);
  if (!fs.existsSync(filePath)) {
    throw new Error(`group-index.json 不存在：${filePath}，请先 ensureScopeDir`);
  }
  if (!source.dir || !source.rootName || !source.commit) {
    throw new Error('setSource 要求 source.{dir,rootName,commit} 均非空');
  }

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
