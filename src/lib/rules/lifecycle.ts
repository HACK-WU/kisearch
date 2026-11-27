/**
 * rules/lifecycle.ts —— 规则的读取处理、写入校验、容量淘汰与 GC（S-01 · 规则内核）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §3、§5、§6
 *
 * 全局约束：
 *   · 不做权限判定、不展开视图——调用方传入**已鉴权的物理 scope 列表**；
 *   · 读路径只过滤过期，不写盘；GC 才做物理删除；
 *   · 所有写操作必须在 `withRulesLock()` 内完成（读—改—写）；
 *   · AI 规则只按“条数”淘汰，人工规则只按“每 scope 2000 字”限制。
 */

import crypto from 'node:crypto';

import type { KiConfig } from '../config.js';
import { rulesLog } from './log.js';
import { readRules, withRulesLock, writeRules } from './store.js';
import {
  AI_RULES_HARD_CAP,
  AI_SOFT_CAP,
  GC_THROTTLE_MS,
  MAX_INJECT_CHARS,
  MAX_RULE_CHARS,
  RulesError,
  type LoadedRules,
  type RuleRecord,
  type RulesFile,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 进程内 GC 节流：scope → 上次 GC 时间戳（ms） */
const lastGcAt = new Map<string, number>();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function newRuleId(): string {
  return `r_${crypto.randomBytes(4).toString('hex')}`;
}

function validateText(raw: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    throw new RulesError('RULE_TEXT_INVALID', '规则正文不能为空');
  }
  if (text.length > MAX_RULE_CHARS) {
    throw new RulesError('RULE_TEXT_INVALID', `规则正文最多 ${MAX_RULE_CHARS} 字，实际 ${text.length} 字`);
  }
  return text;
}

function validateExpiresAt(raw: string | null, nowMs: number): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new RulesError('RULE_EXPIRY_INVALID', `有效期不是合法时间：${String(raw)}`);
  }
  if (ms <= nowMs) {
    throw new RulesError('RULE_EXPIRY_INVALID', '有效期必须晚于当前时间；续期请选择未来时间');
  }
  return iso(ms);
}

function isExpired(rule: RuleRecord, nowMs: number): boolean {
  if (rule.source !== 'human' || rule.expiresAt === null) return false;
  const at = Date.parse(rule.expiresAt);
  return Number.isFinite(at) && at <= nowMs;
}

function humanChars(file: RulesFile, scope: string): number {
  let total = 0;
  for (const rule of file.rules) {
    if (rule.scope === scope && rule.source === 'human') total += rule.text.length;
  }
  return total;
}

function aiRulesOf(file: RulesFile, scope: string): RuleRecord[] {
  return file.rules.filter((r) => r.scope === scope && r.source === 'ai');
}

function ageMs(rule: RuleRecord, nowMs: number): number {
  const at = Date.parse(rule.createdAt);
  if (!Number.isFinite(at)) return 0; // 时间坏掉时不淘汰，避免误删
  return nowMs - at;
}

function oldestFirst(a: RuleRecord, b: RuleRecord): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function quotaError(scope: string, next: number): RulesError {
  return new RulesError(
    'RULES_SCOPE_QUOTA',
    `知识库「${scope}」的人工规则总字数将达 ${next}，超过上限 ${MAX_INJECT_CHARS}`,
  );
}

/**
 * 读取多个 scope 的规则并处理为可直接注入的形状。
 *
 * 参数：
 *   config — 运行时配置
 *   scopes — 已鉴权的物理 scope 列表（顺序影响并集顺序）
 *   opts.now — 判定过期的时间基准，缺省 `new Date()`
 *   opts.maxChars — 注入正文字符上限，缺省 `MAX_INJECT_CHARS`
 * 返回：`LoadedRules` — byScope / total / truncated / chars
 * 异常：不抛；文件损坏时按空规则处理
 * 预期行为：
 *   1. 逐个 scope 取规则：human 过滤 `expiresAt < now`；ai 不过滤时间
 *   2. 每个 scope 内排序：human 在前，其次 `createdAt` 倒序
 *   3. 跨 scope 按 `text.trim()` 去重（保留先出现的）
 *   4. 按 `maxChars` 截断，记录 `truncated` 与 `chars`
 * 设计文档：§ S-01 §5.1 / §6 / §7
 */
export function loadRulesForScopes(
  config: KiConfig,
  scopes: string[],
  opts?: { now?: Date; maxChars?: number },
): LoadedRules {
  const file = readRules(config);
  const nowMs = (opts?.now ?? new Date()).getTime();
  const rawMax = opts?.maxChars;
  const maxChars = rawMax === undefined || !Number.isFinite(rawMax)
    ? MAX_INJECT_CHARS
    : Math.max(0, Math.floor(rawMax));

  const flat: Array<{ scope: string; rule: RuleRecord }> = [];
  const seen = new Set<string>();

  for (const scope of scopes) {
    const scoped = file.rules
      .filter((r) => r.scope === scope && !isExpired(r, nowMs))
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'human' ? -1 : 1;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });

    for (const rule of scoped) {
      const key = rule.text.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({ scope, rule });
    }
  }

  let chars = 0;
  let truncated = 0;
  const kept: typeof flat = [];
  for (let i = 0; i < flat.length; i += 1) {
    const item = flat[i]!;
    const len = item.rule.text.length;
    if (chars + len > maxChars) {
      truncated = flat.length - i;
      break;
    }
    chars += len;
    kept.push(item);
  }

  const byScope = Object.create(null) as Record<string, RuleRecord[]>;
  for (const { scope, rule } of kept) {
    (byScope[scope] ??= []).push(rule);
  }

  return { byScope, total: flat.length, truncated, chars };
}

/**
 * 写入一条 AI 规则（含去重、容量淘汰、硬上限）。
 *
 * 参数：config、input（scope / text / createdBy）、now 可选
 * 返回：`{ rule, evicted, deduped }`
 * 异常：
 *   `RULE_TEXT_INVALID` — text 空 / 超 200 字
 *   `RULES_AI_HARD_CAP` — 淘汰后仍达到 100 条且无可淘汰项
 *   `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 预期行为：
 *   1. 持锁 → 读 → 校验 text
 *   2. 同 scope 同 `text.trim()` 的 AI 规则已存在 → 直接返回 `deduped: true`
 *   3. 若 AI 条数 ≥ 20：删“age > 1 天”的最早项，直到 < 20
 *   4. 若淘汰后仍 ≥ 100 且无可淘汰项 → `RULES_AI_HARD_CAP`
 *   5. 插入新规则（`expiresAt: null`）→ 写盘 → 返回
 * 设计文档：§ S-01 §5.2 / §5.3 / §6
 */
export function addAiRule(
  config: KiConfig,
  input: { scope: string; text: string; createdBy: string },
  now?: Date,
): { rule: RuleRecord; evicted: RuleRecord[]; deduped: boolean } {
  const text = validateText(input.text);

  return withRulesLock(config, () => {
    const nowMs = (now ?? new Date()).getTime();
    const ts = iso(nowMs);
    const file = readRules(config);
    const ai = aiRulesOf(file, input.scope);

    const existing = ai.find((r) => r.text.trim() === text);
    if (existing) {
      return { rule: existing, evicted: [], deduped: true };
    }

    const evicted: RuleRecord[] = [];
    while (ai.length >= AI_SOFT_CAP) {
      const candidate = ai.filter((r) => ageMs(r, nowMs) > DAY_MS).sort(oldestFirst)[0];
      if (!candidate) break;
      const idx = file.rules.indexOf(candidate);
      if (idx < 0) break;
      file.rules.splice(idx, 1);
      const aiIdx = ai.indexOf(candidate);
      if (aiIdx >= 0) ai.splice(aiIdx, 1);
      evicted.push(candidate);
    }

    if (ai.length >= AI_RULES_HARD_CAP) {
      throw new RulesError(
        'RULES_AI_HARD_CAP',
        `知识库「${input.scope}」的 AI 规则已达 ${AI_RULES_HARD_CAP} 条硬上限，且暂无可淘汰项；请先删除旧规则`,
      );
    }

    const rule: RuleRecord = {
      id: newRuleId(),
      scope: input.scope,
      text,
      source: 'ai',
      expiresAt: null,
      createdAt: ts,
      updatedAt: ts,
      createdBy: input.createdBy,
    };
    file.rules.push(rule);
    writeRules(config, file);

    rulesLog('add', {
      who: input.createdBy,
      scope: input.scope,
      ruleId: rule.id,
      chars: text.length,
      evicted: evicted.length,
    });

    return { rule, evicted, deduped: false };
  });
}

/**
 * 新增一条人工规则。
 *
 * 参数：config、input（scope / text / expiresAt / createdBy）
 * 返回：新建的 `RuleRecord`
 * 异常：
 *   `RULE_TEXT_INVALID` — text 空 / 超 200 字
 *   `RULE_EXPIRY_INVALID` — `expiresAt` 非空且不是未来时间
 *   `RULES_SCOPE_QUOTA` — 该 scope 人工规则总字数将超 2000
 *   `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 预期行为：持锁 → 读取 → 校验 text/expiresAt/配额 → 插入 → 原子写
 * 设计文档：§ S-01 §5.1 / §6
 */
export function createHumanRule(
  config: KiConfig,
  input: { scope: string; text: string; expiresAt: string | null; createdBy: string },
): RuleRecord {
  const text = validateText(input.text);

  return withRulesLock(config, () => {
    const nowMs = Date.now();
    const expiresAt = validateExpiresAt(input.expiresAt, nowMs);
    const file = readRules(config);
    const current = humanChars(file, input.scope);
    if (current + text.length > MAX_INJECT_CHARS) {
      throw quotaError(input.scope, current + text.length);
    }

    const ts = iso(nowMs);
    const rule: RuleRecord = {
      id: newRuleId(),
      scope: input.scope,
      text,
      source: 'human',
      expiresAt,
      createdAt: ts,
      updatedAt: ts,
      createdBy: input.createdBy,
    };
    file.rules.push(rule);
    writeRules(config, file);

    rulesLog('add', {
      who: input.createdBy,
      scope: input.scope,
      ruleId: rule.id,
      chars: text.length,
    });
    return rule;
  });
}

/**
 * 修改一条人工规则（仅 text / expiresAt）。
 *
 * 参数：config、id、patch、actor
 * 返回：更新后的 `RuleRecord`
 * 异常：
 *   `RULE_NOT_FOUND` — id 不存在
 *   `RULE_NOT_HUMAN` — 目标是 AI 规则（AI 规则只能转永久或删除）
 *   `RULE_PATCH_EMPTY` — text 与 expiresAt 都没传
 *   `RULE_TEXT_INVALID` / `RULE_EXPIRY_INVALID` / `RULES_SCOPE_QUOTA`
 *   `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 预期行为：持锁 → 定位 → 校验 patch 非空 → 重算配额 → 更新 `updatedAt` → 写盘
 * 设计文档：§ S-01 §5.1 / §6
 */
export function updateHumanRule(
  config: KiConfig,
  id: string,
  patch: { text?: string; expiresAt?: string | null },
  actor: string,
): RuleRecord {
  void actor;
  return withRulesLock(config, () => {
    const nowMs = Date.now();
    const file = readRules(config);
    const idx = file.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new RulesError('RULE_NOT_FOUND', `规则不存在：${id}`);
    const rule = file.rules[idx]!;
    if (rule.source !== 'human') {
      throw new RulesError('RULE_NOT_HUMAN', '这是 AI 规则：只能转永久或删除，不能直接编辑');
    }
    if (patch.text === undefined && patch.expiresAt === undefined) {
      throw new RulesError('RULE_PATCH_EMPTY', '至少提供 text 或 expiresAt 之一');
    }

    const nextText = patch.text === undefined ? rule.text : validateText(patch.text);
    const nextExpires = patch.expiresAt === undefined
      ? rule.expiresAt
      : validateExpiresAt(patch.expiresAt, nowMs);
    const current = humanChars(file, rule.scope) - rule.text.length;
    if (current + nextText.length > MAX_INJECT_CHARS) {
      throw quotaError(rule.scope, current + nextText.length);
    }

    const updated: RuleRecord = {
      ...rule,
      text: nextText,
      expiresAt: nextExpires,
      updatedAt: iso(nowMs),
    };
    file.rules[idx] = updated;
    writeRules(config, file);
    return updated;
  });
}

/**
 * 把一条 AI 规则转为人工永久规则。
 *
 * 参数：config、id、actor
 * 返回：更新后的 `RuleRecord`（source='human'、expiresAt=null）
 * 异常：
 *   `RULE_NOT_FOUND` / `RULE_NOT_AI`
 *   `RULES_SCOPE_QUOTA` — 转永久后人工总字数将超 2000
 *   `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 预期行为：持锁 → 定位 AI 规则 → 校验人工配额 → 改 source/expiresAt → 写盘
 * 设计文档：§ S-01 §5.1 / §6
 */
export function promoteAiRule(
  config: KiConfig,
  id: string,
  actor: string,
): RuleRecord {
  void actor;
  return withRulesLock(config, () => {
    const nowMs = Date.now();
    const file = readRules(config);
    const idx = file.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new RulesError('RULE_NOT_FOUND', `规则不存在：${id}`);
    const rule = file.rules[idx]!;
    if (rule.source !== 'ai') {
      throw new RulesError('RULE_NOT_AI', '只有 AI 规则可以转永久');
    }

    const current = humanChars(file, rule.scope);
    if (current + rule.text.length > MAX_INJECT_CHARS) {
      throw quotaError(rule.scope, current + rule.text.length);
    }

    const updated: RuleRecord = {
      ...rule,
      source: 'human',
      expiresAt: null,
      updatedAt: iso(nowMs),
    };
    file.rules[idx] = updated;
    writeRules(config, file);
    return updated;
  });
}

/**
 * 按 id 删除任意规则（人工管理面使用）。
 *
 * 参数：config、id、actor
 * 返回：被删除的 `RuleRecord`
 * 异常：`RULE_NOT_FOUND` / `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 约束：**Agent 面禁止直接调用**，必须走 `deleteAiRule()`
 * 设计文档：§ S-01 §5.1
 */
export function deleteRule(
  config: KiConfig,
  id: string,
  actor: string,
): RuleRecord {
  return withRulesLock(config, () => {
    const file = readRules(config);
    const idx = file.rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new RulesError('RULE_NOT_FOUND', `规则不存在：${id}`);
    const [removed] = file.rules.splice(idx, 1);
    writeRules(config, file);
    rulesLog('delete', {
      who: actor,
      scope: removed!.scope,
      ruleId: removed!.id,
      chars: removed!.text.length,
    });
    return removed!;
  });
}

/**
 * Agent 专用删除：只删 AI 规则。
 *
 * 参数：config、target（`id` 或 `text` 二选一，必须带 `scope`）、actor
 * 返回：被删除的 `RuleRecord`
 * 异常：
 *   `RULE_TARGET_INVALID` — id 与 text 都没传
 *   `RULE_NOT_FOUND` — 无匹配
 *   `RULE_NOT_AI` — 命中人工规则
 *   `RULE_AMBIGUOUS` — 命中多条 AI 规则（正常不应发生）
 *   `RULES_BUSY` / `RULES_WRITE_FAILED`
 * 预期行为：持锁 → 按 id 或 `scope + text.trim()` 定位 → 校验 source → 删除 → 写盘
 * 设计文档：§ S-01 §5.1 / §6
 */
export function deleteAiRule(
  config: KiConfig,
  target: { id?: string; scope: string; text?: string },
  actor: string,
): RuleRecord {
  if (!target.id && !target.text) {
    throw new RulesError('RULE_TARGET_INVALID', '删除规则必须提供 id 或 text 之一');
  }
  return withRulesLock(config, () => {
    const file = readRules(config);
    let rule: RuleRecord | undefined;

    if (target.id) {
      rule = file.rules.find((r) => r.id === target.id && r.scope === target.scope);
    } else {
      const wanted = target.text!.trim();
      const matches = file.rules.filter((r) => r.scope === target.scope && r.text.trim() === wanted);
      if (matches.length > 1) {
        throw new RulesError(
          'RULE_AMBIGUOUS',
          `匹配到多条规则，请改用 id 删除：${matches.map((r) => r.id).join('、')}`,
        );
      }
      rule = matches[0];
    }

    if (!rule) throw new RulesError('RULE_NOT_FOUND', `在「${target.scope}」中未找到匹配的规则`);
    if (rule.source !== 'ai') {
      throw new RulesError('RULE_NOT_AI', '这是人工规则：Agent 只能删除 AI 规则，人工规则请在设置页删除');
    }

    const idx = file.rules.indexOf(rule);
    file.rules.splice(idx, 1);
    writeRules(config, file);
    rulesLog('delete', {
      who: actor,
      scope: rule.scope,
      ruleId: rule.id,
      chars: rule.text.length,
    });
    return rule;
  });
}

/**
 * 物理清理：删除超容的 AI 规则（只删 AI，不删人工）。
 *
 * 参数：config、scopes、now 可选
 * 返回：`{ removed }`
 * 异常：内部捕获并记日志，不向调用方抛
 * 预期行为：持锁 → 逐 scope 淘汰“age > 1 天且超出 20 条”的最早项 → 有变化才写盘
 * 约束：由 `maybeGcRules()` 异步触发；读路径不得 await 它
 * 设计文档：§ S-01 §3.3 / §5.3
 */
export function gcRules(
  config: KiConfig,
  scopes: string[],
  now?: Date,
): { removed: number } {
  const nowMs = (now ?? new Date()).getTime();
  let removed = 0;

  try {
    withRulesLock(config, () => {
      const file = readRules(config);
      let changed = false;
      let count = 0;

      for (const scope of new Set(scopes)) {
        const ai = aiRulesOf(file, scope);
        while (ai.length > AI_SOFT_CAP) {
          const candidate = ai.filter((r) => ageMs(r, nowMs) > DAY_MS).sort(oldestFirst)[0];
          if (!candidate) break;
          const idx = file.rules.indexOf(candidate);
          if (idx < 0) break;
          file.rules.splice(idx, 1);
          const aiIdx = ai.indexOf(candidate);
          if (aiIdx >= 0) ai.splice(aiIdx, 1);
          count += 1;
          changed = true;
        }
      }

      if (changed) {
        writeRules(config, file);
        removed = count;
      }
    });
  } catch (err) {
    rulesLog('error', {
      code: err instanceof RulesError ? err.code : 'RULES_WRITE_FAILED',
      scope: scopes.join(','),
    });
    return { removed: 0 };
  }

  if (removed > 0) {
    rulesLog('gc', { scope: scopes.join(','), evicted: removed });
  }
  return { removed };
}

/**
 * 读调用后的异步 GC 触发器（fire-and-forget）。
 *
 * 参数：config、scopes、now 可选
 * 返回：void
 * 异常：不抛
 * 预期行为：
 *   1. 逐 scope 比对 `lastGcAt`；距上次 < 5 分钟则跳过
 *   2. 命中则更新 `lastGcAt`，`setImmediate` 里跑一次 `gcRules`
 * 约束：
 *   · **只读 Token 的调用方不得调用**（由 S-02 工具层判定）；
 *   · 不阻塞、不 await、不因 GC 失败影响本次检索
 * 设计文档：§ S-01 §3.3 / §7
 */
export function maybeGcRules(
  config: KiConfig,
  scopes: string[],
  now?: Date,
): void {
  const at = (now ?? new Date()).getTime();
  for (const scope of new Set(scopes)) {
    const last = lastGcAt.get(scope) ?? 0;
    if (at - last < GC_THROTTLE_MS) continue;
    lastGcAt.set(scope, at);
    setImmediate(() => {
      try {
        gcRules(config, [scope], now);
      } catch (err) {
        // gcRules 内部已吞错；这里只兜住同步阶段之外的意外
        rulesLog('error', {
          code: err instanceof RulesError ? err.code : 'RULES_WRITE_FAILED',
          scope,
        });
      }
    });
  }
}
