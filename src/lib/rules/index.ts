/**
 * rules/index.ts —— AI 规则内核的对外出口（S-01）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §9 影响范围
 *
 * 约束：
 *   · `withRulesLock` 是内部实现，**不从这里导出**；
 *   · 内核不判权限、不展开视图；调用方传已鉴权的物理 scope。
 */

export type {
  LoadedRules,
  RuleRecord,
  RulesErrorCode,
  RuleSource,
  RulesFile,
} from './types.js';

export {
  AI_RULES_HARD_CAP,
  AI_SOFT_CAP,
  GC_THROTTLE_MS,
  MAX_INJECT_CHARS,
  MAX_RULE_CHARS,
  RULES_FILE_VERSION,
  RulesError,
} from './types.js';

export { readRules, rulesFilePath, writeRules } from './store.js';

export {
  addAiRule,
  createHumanRule,
  deleteAiRule,
  deleteRule,
  gcRules,
  loadRulesForScopes,
  maybeGcRules,
  promoteAiRule,
  updateHumanRule,
} from './lifecycle.js';

export { buildRulesBlock } from './block.js';

export { applyImport, buildExportPackage, planImport } from './import-export.js';
export type {
  ExportPackage,
  ExportRule,
  ImportMode,
  ImportPlan,
  ImportResult,
} from './import-export.js';

export { rulesLog } from './log.js';
export type { RulesLogEvent, RulesLogFields } from './log.js';
