/**
 * rules/types.ts —— AI 规则的领域类型、常量与错误码（S-01 · 规则内核）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §4 数据模型、§5.3 容量口径
 *
 * 全局约束：
 *   · 规则是 AI 行为配置，**不进 KB 向量、不随 KB 快照**；
 *   · 视图不落盘，只按物理 scope 存；
 *   · `source='ai'` 的 `expiresAt` 恒为 `null`（1 天是淘汰年龄，不是 TTL）；
 *   · 读路径只做内存过滤，写路径必须持锁。
 */

/** 规则来源：人写 / Agent 写 */
export type RuleSource = 'human' | 'ai';

/**
 * 一条规则的完整记录。
 * 设计锚点：§4.1 持久化结构
 */
export interface RuleRecord {
  /** `r_<8hex>`；导入时重新生成，避免跨库碰撞 */
  id: string;
  /** 物理 scope 名（目录名）；视图不落盘 */
  scope: string;
  /** 1~200 字符（中文按 1 字） */
  text: string;
  /** human = 人写；ai = Agent 写 */
  source: RuleSource;
  /** ISO 8601；仅 human 使用，null = 永久；ai 恒为 null */
  expiresAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
  /** `user:<id>` | `token:<id>` | `system` */
  createdBy: string;
}

/** `{chatDir}/scope-rules.json` 的落盘形状 */
export interface RulesFile {
  version: 1;
  rules: RuleRecord[];
}

/** 读取并处理后的结果：按 scope 分组、已过滤/排序，未截断前统计 */
export interface LoadedRules {
  /** 已过滤、已排序；key 为物理 scope */
  byScope: Record<string, RuleRecord[]>;
  /** 截断前总条数 */
  total: number;
  /** 被 2000 字上限截掉的条数 */
  truncated: number;
  /** 实际注入字符数（只算规则正文） */
  chars: number;
}

/** 当前规则文件版本；不识别时读降级为空、写拒绝覆盖 */
export const RULES_FILE_VERSION = 1 as const;

/** 单条规则正文字数上限 */
export const MAX_RULE_CHARS = 200;

/** 单次调用注入的规则正文字数上限 */
export const MAX_INJECT_CHARS = 2000;

/** AI 规则每 scope 软上限（淘汰目标） */
export const AI_SOFT_CAP = 20;

/** AI 规则每 scope 硬上限（安全阀；淘汰后达到即拒绝新增） */
export const AI_RULES_HARD_CAP = 100;

/** GC 节流：同一 scope 5 分钟内最多触发一次 */
export const GC_THROTTLE_MS = 5 * 60 * 1000;

/** 内核错误码（对外由 S-03 / S-04 映射为 HTTP / MCP 错误） */
export type RulesErrorCode =
  | 'RULE_TEXT_INVALID'
  | 'RULE_EXPIRY_INVALID'
  | 'RULE_NOT_FOUND'
  | 'RULE_NOT_AI'
  | 'RULE_NOT_HUMAN'
  | 'RULE_AMBIGUOUS'
  | 'RULE_PATCH_EMPTY'
  | 'RULE_TARGET_INVALID'
  | 'RULES_SCOPE_QUOTA'
  | 'RULES_AI_HARD_CAP'
  | 'RULES_BUSY'
  | 'RULES_CORRUPT'
  | 'RULES_WRITE_FAILED';

/**
 * 规则内核统一错误。
 *
 * 设计锚点：§6 异常处理
 * 约束：`code` 必须取 `RulesErrorCode`；调用方按 code 映射，不解析 message。
 */
export class RulesError extends Error {
  readonly code: RulesErrorCode;

  constructor(code: RulesErrorCode, message: string) {
    super(message);
    this.name = 'RulesError';
    this.code = code;
  }
}
