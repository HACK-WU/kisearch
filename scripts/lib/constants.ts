/**
 * 知识索引 SKILL 全局常量
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { loadConfig } from './config.js';

// ─── 数据版本 ───
export const CURRENT_DATA_VERSION = 1;

// ─── 评分相关 ───
export const MIN_RECORD_INTERVAL_MINUTES = 5;
export const MAX_USE_COUNT = 10;

// ─── 分区配置 ───
export interface PartitionConfig {
  hotPercent: number;
  warmPercent: number;
  reservedEmerging: number;
  recentHours: number;
  minHotCount: number;
  decayStep: number;
  halfLifeHours: number;
  maxHotCount: number;
  maxWarmCount: number | null;
  maxColdCount: number | null;
  maxKeywordCount: number;
}

export const DEFAULT_PARTITION_CONFIG: PartitionConfig = {
  hotPercent: 0.3,
  warmPercent: 0.5,
  reservedEmerging: 10,
  recentHours: 48,
  minHotCount: 1,
  decayStep: 5,
  halfLifeHours: 24,
  maxHotCount: 10,
  maxWarmCount: 50,
  maxColdCount: null,
  maxKeywordCount: 50,
};

// ─── 默认根节点 ───
export const DEFAULT_ROOT_NAME = '项目根';

// ─── 路径常量 ───
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** knowledge-index/ 根目录（从 scripts/lib/ 上溯 2 级） */
export const KI_ROOT = path.resolve(__dirname, '..', '..');

/**
 * kb/ 运行时数据目录（延迟初始化）。
 *
 * 从 loadConfig() 获取 dataDir，首次调用时缓存。
 * 已移除 KI_DATA_DIR 环境变量支持，改用配置文件机制。
 */
let _baseDir: string | null = null;

export function getKbBaseDir(): string {
  if (_baseDir === null) {
    _baseDir = loadConfig().dataDir;
  }
  return _baseDir;
}

/** _template/ 模板目录（始终为包内置，不从 KI_DATA_DIR 读取） */
export const TEMPLATE_DIR = path.join(KI_ROOT, '_template');
