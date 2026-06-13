/**
 * Scope 校验与路径构造
 * 
 * scope 参数仅允许字母、数字、连字符、下划线，拒绝路径遍历字符
 */

import fs from 'fs';
import path from 'path';
import { KB_BASE_DIR } from './constants.js';

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
 */
export function getKbDir(scope: string): string {
  validateScope(scope);
  return path.join(KB_BASE_DIR, scope);
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
  return path.join(KB_BASE_DIR, scope, groupPath, 'index.json');
}

// ─── group-index.json 的 source 块（S-01） ───

/**
 * source 块：记录知识库的外部来源信息
 * - dir: 外部知识库根目录绝对路径
 * - rootName: Group 根节点名称
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

// ─── Scope 枚举 ───

/**
 * 列出 kb/ 下所有已初始化的 scope
 * - 仅返回符合 scope 命名规则的目录
 * - 仅返回包含 relations-cache.json 的目录（即已初始化的 scope）
 */
export function listAllScopes(): string[] {
  if (!fs.existsSync(KB_BASE_DIR)) return [];
  const entries = fs.readdirSync(KB_BASE_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
    .filter((name) =>
      fs.existsSync(path.join(KB_BASE_DIR, name, 'relations-cache.json'))
    );
}

/**
 * 写入 / 更新 source 块到 group-index.json
 * - 不修改 roots / version / scope 字段
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

  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  data.source = { dir: source.dir, rootName: source.rootName, commit: source.commit };
  data.updatedAt = new Date().toISOString();

  // 同步写盘（与 store.ts 的 writeJson 一致：直接覆盖，不走 WAL；
  // 此处仅更新 source 子字段，体量小，原子性由调用方串行执行保证）
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
