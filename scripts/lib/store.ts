/**
 * JSON 存储层
 * 
 * - readJson: 读取 JSON + version 检查
 * - writeJson: WAL 写入
 * - initScope: 从 _template 初始化新 scope
 * - ensureScopeDir: 确保 kb/{scope}/ 目录存在
 */

import fs from 'fs';
import path from 'path';
import { walWrite } from './wal.js';
import { getKbDir, getGroupIndexPath, getRelationsCachePath, validateScope, migrateGroupIndex } from './scope.js';
import { loadConfig } from './config.js';
import { CURRENT_DATA_VERSION, TEMPLATE_DIR } from './constants.js';

// ─── JSON 读写 ───

/**
 * 读取 JSON 文件，检查 version 兼容性
 * @returns 解析后的数据对象，文件不存在返回 null
 */
export function readJson<T = Record<string, unknown>>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  let data: T & { version?: number };
  try {
    data = JSON.parse(content) as T & { version?: number };
  } catch (parseErr) {
    const errDetail = parseErr instanceof SyntaxError ? parseErr.message : String(parseErr);
    const error = new Error(
      `JSON 文件损坏：${filePath}\n` +
      `解析错误：${errDetail}\n` +
      `建议：从备份恢复或从 _template/ 重新初始化此 scope`
    );
    (error as any).code = 'CORRUPT_JSON';
    throw error;
  }

  // version 检查：当前版本 1，旧版本数据做兼容处理
  if (data.version !== undefined && data.version > CURRENT_DATA_VERSION) {
    console.warn(
      `警告：文件 ${filePath} 版本 ${data.version} 高于当前支持版本 ${CURRENT_DATA_VERSION}，可能存在兼容性问题`
    );
  }

  return data;
}

/**
 * WAL 写入 JSON 文件
 * 自动添加 version 字段和 updatedAt 时间戳
 */
export function writeJson(filePath: string, data: Record<string, unknown>): void {
  const enriched = {
    ...data,
    version: data.version ?? CURRENT_DATA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  walWrite(filePath, enriched);
}

// ─── Scope 初始化 ───

/**
 * 读取 group-index.json，自动迁移旧格式（roots → groups）
 *
 * 读取后如果检测到旧格式（有 roots 无 groups），自动迁移并写回。
 * 同时迁移 relations-cache.json 中以 "项目根/" 开头的旧 group key。
 * 调用方只需处理新格式的 GroupIndex。
 */
export function readGroupIndex(scope: string): import('./scope.js').GroupIndex | null {
  const indexPath = getGroupIndexPath(scope);
  const raw = readJson<Record<string, unknown>>(indexPath);
  if (!raw) return null;

  const migrated = migrateGroupIndex(raw);
  if (migrated) {
    // 旧格式 → 自动迁移 group-index.json 并写回（用 writeJson 刷新 updatedAt）
    writeJson(indexPath, migrated as unknown as Record<string, unknown>);
    console.warn(`已自动迁移 group-index.json：roots → groups（scope: ${scope}）`);

    // 同时迁移 relations-cache.json 中以 "项目根/" 开头的旧 key
    migrateRelationsCacheKeys(scope);

    return migrated;
  }

  // 已经是新格式，直接返回
  return raw as unknown as import('./scope.js').GroupIndex;
}

/** 旧 key 前缀：默认根节点名称 + "/" */
const LEGACY_ROOT_PREFIX = '项目根/';

/**
 * 迁移 relations-cache.json 中以 "项目根/" 开头的旧 group key
 * 例如 "项目根/API/配置" → "API/配置"
 */
function migrateRelationsCacheKeys(scope: string): void {
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<Record<string, unknown>>(cachePath);
  if (!cache || typeof cache.groups !== 'object' || !cache.groups) return;

  const groups = cache.groups as Record<string, unknown>;
  const keysToRename: Array<{ oldKey: string; newKey: string }> = [];

  let mergedCount = 0;
  const keysToDelete: string[] = [];

  for (const key of Object.keys(groups)) {
    if (key.startsWith(LEGACY_ROOT_PREFIX)) {
      const newKey = key.slice(LEGACY_ROOT_PREFIX.length);
      if (!newKey) continue;

      if (!groups[newKey]) {
        // 新 key 不存在，直接重命名
        keysToRename.push({ oldKey: key, newKey });
      } else {
        // 新 key 已存在，合并数据（去重）
        const oldData = groups[key] as Record<string, unknown>;
        const newData = groups[newKey] as Record<string, unknown>;

        if (oldData !== null && typeof oldData === 'object' && newData !== null && typeof newData === 'object') {
          // 合并 hot_relations（按 text 去重）
          if (Array.isArray(oldData.hot_relations) && Array.isArray(newData.hot_relations)) {
            const existingTexts = new Set(newData.hot_relations.map((r: any) => r.text));
            for (const rel of oldData.hot_relations) {
              if (!existingTexts.has((rel as any).text)) newData.hot_relations.push(rel);
            }
          }
          // 合并 keywords（去重）
          if (Array.isArray(oldData.keywords) && Array.isArray(newData.keywords)) {
            for (const kw of oldData.keywords) {
              if (!newData.keywords.includes(kw)) newData.keywords.push(kw);
            }
          }
        }

        keysToDelete.push(key);
        mergedCount++;
      }
    }
  }

  // 删除已合并的旧 key
  for (const key of keysToDelete) {
    delete groups[key];
  }

  if (keysToRename.length === 0 && mergedCount === 0) return;

  for (const { oldKey, newKey } of keysToRename) {
    groups[newKey] = groups[oldKey];
    delete groups[oldKey];
  }

  walWrite(cachePath, cache);
  const total = keysToRename.length + mergedCount;
  const detail = mergedCount > 0
    ? `${keysToRename.length} 个重命名，${mergedCount} 个合并`
    : `${keysToRename.length} 个 group key 去掉 "项目根/" 前缀`;
  console.warn(`已自动迁移 relations-cache.json：${detail}（scope: ${scope}）`);
}

/**
 * 确保 kb/{scope}/ 目录存在，不存在则从 _template 初始化
 *
 * 校验规则：如果 ki 配置文件存在但 scope 未在 scopes 中注册，
 * 且数据目录不存在，拒绝自动创建空目录并给出修复建议。
 */
export function ensureScopeDir(scope: string): void {
  validateScope(scope);
  const kbDir = getKbDir(scope);

  // Scope 配置校验：配置文件存在但 scope 未注册时，拒绝并给出修复建议
  const config = loadConfig();
  if (config._configPath && !(scope in config.scopes)) {
    const available = Object.keys(config.scopes);
    const lines: string[] = [
      `scope "${scope}" 未在 ki 配置中注册。`,
    ];
    if (available.length > 0) {
      lines.push(`已注册的 scope：${available.join(', ')}`);
    } else {
      lines.push(`配置文件中尚未注册任何 scope。`);
    }
    lines.push(
      ``,
      `修复方式：`,
      `  1. 在 ${config._configPath} 的 scopes 中添加 "${scope}"`,
      `  2. 或使用已注册的 scope 名称执行命令`,
    );
    throw new Error(lines.join('\n'));
  }

  // 目录不存在 → 全新 scope，从模板初始化
  if (!fs.existsSync(kbDir)) {
    initScope(scope);
    return;
  }

  // 目录存在但两个关键文件都缺失 → 视为未初始化，从模板初始化
  const groupIndexPath = path.join(kbDir, 'group-index.json');
  const relationsCachePath = path.join(kbDir, 'relations-cache.json');
  if (!fs.existsSync(groupIndexPath) && !fs.existsSync(relationsCachePath)) {
    initScope(scope);
    return;
  }

  // 目录存在且至少一个关键文件存在 → 认为 scope 已初始化
  // （如果只有其中一个文件缺失，视为损坏，由调用方处理）

  // 旧数据迁移提示：检查 kbDir 根目录下是否有旧数据（kbDir 语义变更前遗留）
  // 只要有旧数据就警告，不依赖新数据是否存在
  if (config.scopes[scope]?.kbDir) {
    const rawKbDir = config.scopes[scope].kbDir!;
    const oldGroupIndex = path.join(rawKbDir, 'group-index.json');
    if (fs.existsSync(oldGroupIndex)) {
      process.stderr.write(
        `⚠ 检测到旧数据：${oldGroupIndex}\n` +
        `  kbDir 语义已变更，数据应位于 ${path.join(rawKbDir, 'kb', scope)}/\n` +
        `  建议：将旧数据迁移到新路径，或删除旧文件后重新导入\n`
      );
    }
  }
}

/**
 * 从 _template/ 初始化新 scope
 * 复制 group-index.json 和 relations-cache.json，替换 scope 字段
 */
export function initScope(scope: string): void {
  validateScope(scope);
  const kbDir = getKbDir(scope);

  // 创建目录
  fs.mkdirSync(kbDir, { recursive: true });

  const templateGroupIndex = path.join(TEMPLATE_DIR, 'group-index.json');
  const templateRelationsCache = path.join(TEMPLATE_DIR, 'relations-cache.json');

  // Fail-fast：两个模板文件都不存在时，给出精确错误信息
  if (!fs.existsSync(templateGroupIndex) && !fs.existsSync(templateRelationsCache)) {
    throw new Error(
      `scope 初始化失败：模板文件缺失\n` +
      `模板目录：${TEMPLATE_DIR}\n` +
      `原因：npm 包可能未包含 _template/ 目录\n` +
      `修复：重新安装最新版 knowledge-indexer，或从源码仓库手动复制 _template/ 目录到上述路径`
    );
  }

  // 复制 group-index.json
  const targetGroupIndex = getGroupIndexPath(scope);
  if (fs.existsSync(templateGroupIndex)) {
    const data = JSON.parse(fs.readFileSync(templateGroupIndex, 'utf-8'));
    data.scope = scope;
    data.updatedAt = new Date().toISOString();
    walWrite(targetGroupIndex, data);
  }

  // 复制 relations-cache.json
  const targetRelationsCache = getRelationsCachePath(scope);
  if (fs.existsSync(templateRelationsCache)) {
    const data = JSON.parse(fs.readFileSync(templateRelationsCache, 'utf-8'));
    data.scope = scope;
    data.updatedAt = new Date().toISOString();
    walWrite(targetRelationsCache, data);
  }
}
