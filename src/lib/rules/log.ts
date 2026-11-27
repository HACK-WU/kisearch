/**
 * rules/log.ts —— 规则写入/GC 的单行审计日志（S-01 / S-04）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §7；
 *          `.requirements/ai-rules/AI_RULES_S04_AGENT_DESIGN.md` §5
 *
 * 格式固定为 `[rules] {json}` 一行，供 `grep` / `jq` 使用。
 * 不写多行、不打印规则全文（只记字符数）。
 */

export type RulesLogEvent = 'add' | 'delete' | 'gc' | 'error';

export interface RulesLogFields {
  /** 调用方键：`token:<id>` / `user:<id>` / `system` */
  who?: string;
  /** 物理 scope */
  scope?: string;
  /** 规则 id */
  ruleId?: string;
  /** 规则正文字符数 */
  chars?: number;
  /** 本次淘汰条数 */
  evicted?: number;
  /** 错误码 */
  code?: string;
  /** 耗时 */
  ms?: number;
}

/**
 * 输出一行规则审计日志。
 *
 * 参数：event — `add` / `delete` / `gc` / `error`；fields — 结构化字段
 * 返回：void
 * 异常：不抛（日志失败静默）
 * 预期行为：`process.stderr.write('[rules] ' + JSON.stringify({ ev, ...fields }) + '\n')`
 * 约束：只记元数据，不记规则正文
 * 设计文档：§ S-01 §7 / § S-04 §5
 */
export function rulesLog(event: RulesLogEvent, fields: RulesLogFields = {}): void {
  try {
    const payload: Record<string, unknown> = { ev: event, ...fields };
    process.stderr.write(`[rules] ${JSON.stringify(payload)}\n`);
  } catch {
    /* 日志失败不影响业务 */
  }
}
