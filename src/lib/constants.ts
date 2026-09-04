/**
 * 知识索引 SKILL 全局常量（src 版）
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { loadConfig } from './config.js';

// ─── 数据版本 ───
export const CURRENT_DATA_VERSION = 1;

// ─── 服务身份 ───
/**
 * MCP 服务身份标识（healthz `name` 契约 + McpServer name + 探活判断共用）。
 * 写入方与读取方必须引用同一常量，避免改名时手动同步遗漏导致单例复用失效。
 */
export const SERVICE_NAME = 'kisearch';

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
  halfLifeHours: number;
  /** 热区展示上限（仅展示口径，非存储上限；0 = 热区不展示，null/undefined = 不限制） */
  maxHotCount: number | null;
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
  halfLifeHours: 24,
  maxHotCount: 10,
  maxWarmCount: 50,
  maxColdCount: null,
  maxKeywordCount: 50,
};

// ─── 默认根节点 ───
export const DEFAULT_ROOT_NAME = '项目根';

// ─── 默认标签集（S-05） ───
/** 不传 tags 时默认查询的三类标签 */
export const DEFAULT_TAGS = ['ki-search', 'ki-path', 'ki-relation'] as const;

/** 内部保留标签（用户不可用，写向量时过滤） */
const RESERVED_TAGS = new Set(['ki-search', 'ki-relation', 'ki-path']);

/**
 * 解析自定义 tags：逗号分隔、去空、去重、过滤内部保留 tag（ki-search/ki-relation/ki-path）。
 * import / sync-relation 共用，避免重复实现。
 */
export function parseContentTags(tags?: string): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const raw of tags.split(',')) {
    const t = raw.trim().toLowerCase();
    if (t.length === 0 || RESERVED_TAGS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

// ─── 路径常量 ───
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** knowledge-index/ 根目录（从 src/lib/ 上溯 2 级） */
export const KI_ROOT = path.resolve(__dirname, '..', '..');

/**
 * kb/ 运行时数据目录（延迟初始化）。
 */
let _baseDir: string | null = null;

export function getKbBaseDir(): string {
  if (_baseDir === null) {
    _baseDir = loadConfig().dataDir;
  }
  return _baseDir;
}

/** _template/ 模板目录（始终为包内置） */
export const TEMPLATE_DIR = path.join(KI_ROOT, '_template');
