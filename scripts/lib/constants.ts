/**
 * 知识索引 SKILL 全局常量
 */

import { fileURLToPath } from 'url';
import path from 'path';

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
 * kb/ 运行时数据目录。
 *
 * 优先级：
 * 1. 环境变量 KI_DATA_DIR — 自定义数据目录
 * 2. 默认 — 项目根下的 kb/ 目录（开发模式）
 *
 * 全局安装时建议设置 KI_DATA_DIR，避免数据落入 node_modules。
 * 示例：export KI_DATA_DIR=$HOME/.ki-data
 */
export const KB_BASE_DIR = (() => {
  const envDir = process.env.KI_DATA_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  return path.join(KI_ROOT, 'kb');
})();

/** _template/ 模板目录（始终为包内置，不从 KI_DATA_DIR 读取） */
export const TEMPLATE_DIR = path.join(KI_ROOT, '_template');
