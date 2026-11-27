/**
 * rules/import-export.ts —— 规则导出包 / 导入校验与整单写入（S-05）
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S05_IMPORT_DESIGN.md` §3–§5
 *
 * 边界：
 *   · 导出只读；导入只接受人工规则，AI 规则一律跳过；
 *   · 导入先 plan（dryRun 同一条路径），确认后 apply 在锁内重新 plan + 一次原子写；
 *   · 覆盖模式只清“包内出现的 scope”的人工规则，AI 规则不动。
 */

import crypto from 'node:crypto';

import type { KiConfig } from '../config.js';
import { listAllScopes } from '../scope.js';
import { readViews } from '../scope-view.js';
import { readRules, withRulesLock, writeRules } from './store.js';
import {
  MAX_INJECT_CHARS,
  MAX_RULE_CHARS,
  RULES_FILE_VERSION,
  RulesError,
  type RuleRecord,
  type RulesFile,
} from './types.js';

export interface ExportRule {
  scope: string;
  text: string;
  source: 'human' | 'ai';
  expiresAt: string | null;
  createdAt: string;
}

export interface ExportPackage {
  version: 1;
  exportedAt: string;
  generator: string;
  rules: ExportRule[];
}

export interface ImportResult {
  imported: number;
  skippedDuplicate: number;
  skippedAi: number;
  expired: number;
  orphanScopes: Array<{ scope: string; count: number }>;
  scopes: number;
}

export interface ImportPlan {
  result: ImportResult;
  nextFile: RulesFile;
}

export type ImportMode = 'merge' | 'replace';

/** 导入包里的人工规则（通过校验后的中间形态） */
interface HumanImport {
  scope: string;
  text: string;
  expiresAt: string | null;
  createdAt: string;
}

const MAX_IMPORT_RULES = 500;

function newRuleId(): string {
  return `r_${crypto.randomBytes(4).toString('hex')}`;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function viewNames(config: KiConfig): Set<string> {
  try {
    return new Set(Object.keys(readViews(config)));
  } catch {
    return new Set();
  }
}

function humanCharsByScope(file: RulesFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const rule of file.rules) {
    if (rule.source !== 'human') continue;
    out.set(rule.scope, (out.get(rule.scope) ?? 0) + rule.text.length);
  }
  return out;
}

/**
 * 构造导出包。
 *
 * @param scopes null = 全部库；否则只导出这些物理 scope（视图由调用方展开）
 * @param includeAi 是否包含 AI 临时规则（默认 false）
 */
export function buildExportPackage(
  config: KiConfig,
  opts: { scopes: string[] | null; includeAi: boolean; now?: Date },
): ExportPackage {
  const file = readRules(config);
  const wanted = opts.scopes === null ? null : new Set(opts.scopes);
  const rules = file.rules
    .filter((r) => (wanted === null || wanted.has(r.scope)) && (opts.includeAi || r.source === 'human'))
    .map((r) => ({
      scope: r.scope,
      text: r.text,
      source: r.source,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));

  return {
    version: RULES_FILE_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    generator: 'kisearch/ai-rules',
    rules,
  };
}

/**
 * 校验导入包并计算“导入后文件”（不写盘）。dryRun 与 apply 共用本函数。
 *
 * @throws RulesError `RULES_IMPORT_INVALID` / `RULES_IMPORT_TOO_LARGE` /
 *         `RULES_IMPORT_QUOTA` / `RULES_IMPORT_EMPTY` / `RULE_TEXT_INVALID`
 */
export function planImport(
  config: KiConfig,
  raw: unknown,
  mode: ImportMode,
  now: Date = new Date(),
): ImportPlan {
  if (!isRecord(raw)) throw new RulesError('RULES_IMPORT_INVALID', '导入内容必须是 JSON 对象');
  if (raw.version !== RULES_FILE_VERSION) {
    throw new RulesError('RULES_IMPORT_INVALID', `不支持的导入包版本：${String(raw.version)}`);
  }
  if (!Array.isArray(raw.rules)) throw new RulesError('RULES_IMPORT_INVALID', '导入包缺少 rules 数组');
  if (raw.rules.length > MAX_IMPORT_RULES) {
    throw new RulesError(
      'RULES_IMPORT_TOO_LARGE',
      `导入包最多 ${MAX_IMPORT_RULES} 条规则，实际 ${raw.rules.length} 条`,
    );
  }
  if (raw.rules.length === 0) throw new RulesError('RULES_IMPORT_EMPTY', '导入包没有规则');

  const humanItems: HumanImport[] = [];
  const scopes = new Set<string>();
  const views = viewNames(config);
  let skippedAi = 0;
  let expired = 0;

  for (let idx = 0; idx < raw.rules.length; idx += 1) {
    const item = raw.rules[idx];
    const n = idx + 1;
    if (!isRecord(item)) throw new RulesError('RULES_IMPORT_INVALID', `第 ${n} 条不是对象`);

    const scope = typeof item.scope === 'string' ? item.scope.trim() : '';
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!scope) throw new RulesError('RULES_IMPORT_INVALID', `第 ${n} 条缺少 scope`);
    if (views.has(scope)) {
      throw new RulesError(
        'RULES_IMPORT_INVALID',
        `第 ${n} 条 scope「${scope}」是视图，规则只能落到物理库`,
      );
    }
    if (!text) throw new RulesError('RULE_TEXT_INVALID', `第 ${n} 条内容为空`);
    if (text.length > MAX_RULE_CHARS) {
      throw new RulesError('RULE_TEXT_INVALID', `第 ${n} 条 ${text.length} 字，超过 ${MAX_RULE_CHARS} 字上限`);
    }

    const source = item.source === undefined ? 'human' : item.source;
    if (source !== 'human' && source !== 'ai') {
      throw new RulesError('RULES_IMPORT_INVALID', `第 ${n} 条 source 只能是 human / ai`);
    }
    const expiresAt = item.expiresAt === undefined || item.expiresAt === null
      ? null
      : (isIsoDate(item.expiresAt) ? new Date(item.expiresAt).toISOString() : null);
    if (item.expiresAt !== undefined && item.expiresAt !== null && expiresAt === null) {
      throw new RulesError('RULES_IMPORT_INVALID', `第 ${n} 条 expiresAt 不是合法时间`);
    }
    const createdAt = item.createdAt === undefined
      ? now.toISOString()
      : (isIsoDate(item.createdAt) ? new Date(item.createdAt).toISOString() : null);
    if (createdAt === null) {
      throw new RulesError('RULES_IMPORT_INVALID', `第 ${n} 条 createdAt 不是合法时间`);
    }

    scopes.add(scope);
    if (source === 'ai') {
      skippedAi += 1;
      continue;
    }
    if (expiresAt !== null && Date.parse(expiresAt) < now.getTime()) expired += 1;
    humanItems.push({ scope, text, expiresAt, createdAt });
  }

  if (humanItems.length === 0) {
    throw new RulesError('RULES_IMPORT_EMPTY', '导入包没有可导入的人工规则（AI 规则不会导入）');
  }

  const current = readRules(config);
  let nextFile: RulesFile = {
    version: RULES_FILE_VERSION,
    rules: current.rules.map((r) => ({ ...r })),
  };

  if (mode === 'replace') {
    const replaceScopes = new Set(humanItems.map((i) => i.scope));
    nextFile.rules = nextFile.rules.filter((r) => !(r.source === 'human' && replaceScopes.has(r.scope)));
  }

  const existing = new Set(
    nextFile.rules.filter((r) => r.source === 'human').map((r) => `${r.scope}\u0000${r.text.trim()}`),
  );

  let imported = 0;
  let skippedDuplicate = 0;
  const nowIso = now.toISOString();
  const importedScopes = new Map<string, number>();

  for (const item of humanItems) {
    const key = `${item.scope}\u0000${item.text}`;
    if (existing.has(key)) {
      skippedDuplicate += 1;
      continue;
    }
    existing.add(key);

    const rule: RuleRecord = {
      id: newRuleId(),
      scope: item.scope,
      text: item.text,
      source: 'human',
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      updatedAt: nowIso,
      createdBy: 'import',
    };
    nextFile.rules.push(rule);
    imported += 1;
    importedScopes.set(item.scope, (importedScopes.get(item.scope) ?? 0) + 1);
  }

  const chars = humanCharsByScope(nextFile);
  for (const [scope, total] of chars) {
    if (total > MAX_INJECT_CHARS) {
      throw new RulesError(
        'RULES_IMPORT_QUOTA',
        `导入后「${scope}」人工规则合计 ${total} 字，超过 ${MAX_INJECT_CHARS} 字上限，整单未导入`,
      );
    }
  }

  const known = knownScopesWithConfig();
  const orphanScopes = [...importedScopes.entries()]
    .filter(([scope]) => !known.has(scope))
    .map(([scope, count]) => ({ scope, count }));

  return {
    result: {
      imported,
      skippedDuplicate,
      skippedAi,
      expired,
      orphanScopes,
      scopes: scopes.size,
    },
    nextFile,
  };
}

/** 导入实际写盘：锁内重新 plan，再一次原子写（整单事务） */
export function applyImport(
  config: KiConfig,
  raw: unknown,
  mode: ImportMode,
  now: Date = new Date(),
): ImportResult {
  return withRulesLock(config, () => {
    const plan = planImport(config, raw, mode, now);
    if (plan.result.imported > 0) writeRules(config, plan.nextFile);
    return plan.result;
  });
}

/** 物理 scope（KB 层）；视图不是规则落点，导入时已拒绝 */
function knownScopesWithConfig(): Set<string> {
  const known = new Set<string>();
  try {
    for (const s of listAllScopes()) known.add(s);
  } catch {
    /* ignore */
  }
  return known;
}
