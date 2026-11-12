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

// ─── scope 级用量统计（REQ-20261112-001 S-01）───
/**
 * flush 间隔。
 *
 * ★ 为什么不做同步写：同一 scope 的 `coordinator.submit()` 与引擎任务串行，导入收尾期
 *   队列本就会积压（历史事故：`/api/doc/list` 25s 挂死）。请求路径上多一次同步磁盘写
 *   会直接放大该积压。统计是「天级」指标，30s 的滞后无产品影响。
 */
export const USAGE_FLUSH_INTERVAL_MS = 30_000;
/** 累计事件到达该数量时提前 flush（避免短时爆发要等到下个周期） */
export const USAGE_FLUSH_THRESHOLD = 500;
/** 日桶保留天数；`firstSeen` / `lastUsedAt` 不随之裁剪 */
export const USAGE_RETENTION_DAYS = 90;
/**
 * 统计文件容纳的 scope 名上限。
 * 埋点取的是 `args.scope` 原始字面量（不走 resolveScope）且失败调用也计入，
 * 没有上限时拼错的名字会无界膨胀统计文件。
 */
export const MAX_USAGE_SCOPES = 2000;
/** 固定三档窗口（服务端一次算全，前端切换零请求） */
export const SCOPE_USAGE_WINDOWS = [7, 30, 90] as const;
/** scope / 视图名合法字符集（与 validateScope 对齐），非法名不建统计 key */
export const SCOPE_USAGE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * scope 冷热分区配置：以默认值为基线，**刻意偏离两处**。
 *
 * - `reservedEmerging: 0`：group 给「新兴」留保底席位是为了新内容曝光；scope 的诉求是
 *   「谁在被用」，保底会让一个刚被调用 1 次的新库挤掉调用千次的老库。
 * - `maxWarmCount: null`：列表本就渲染全量 scope，截断会让第 61 个活跃库掉进「冷」区。
 */
export const SCOPE_HEAT_CONFIG: PartitionConfig = {
  ...DEFAULT_PARTITION_CONFIG,
  reservedEmerging: 0,
  maxWarmCount: null,
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
