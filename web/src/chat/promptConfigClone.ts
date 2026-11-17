/**
 * 对话配置草稿的**深拷贝**（从 `PromptConfigLayer` 抽出，2026-11-15）。
 *
 * 为什么要独立成文件：这是全项目最容易静默出错的一段代码 ——
 *   · `PUT /api/chat/prompt-config` 是**整份替换**，草稿漏一个字段就等于"保存时把它清空"；
 *   · 它是**白名单拷贝**（不是 `structuredClone`），因此每加一个可选字段都必须显式搬运。
 * 历史上已踩过 4 次（contextChars / toolResponseChars / searchHitsPerCall / reasoningEffort），
 * 每次症状都一样：「改了 skill 保存一下，另一项配置被静默清回默认」。
 *
 * 抽成纯函数的直接收益：可以用单测机械锁住白名单（`web/test/prompt-config-clone.test.mjs`），
 * 不必为了测一个拷贝函数去渲染整个配置层。
 */

import type { PromptConfig } from '@/api/chatContract';

/**
 * 白名单式深拷贝：只搬运**已知字段**，可选字段逐个显式展开。
 *
 * ⚠️ 新增 `PromptConfig` 可选字段时，**必须**在这里补一行，并同步补测试用例；
 *    漏了不会报错、不会崩，只会静默清空（这是它危险的地方）。
 */
export const clonePromptConfig = (c: PromptConfig): PromptConfig => ({
  version: c.version,
  prompt: { ...c.prompt },
  skills: c.skills.map((s) => ({ ...s })),
  tools: { ...c.tools },
  ...(c.contextChars !== undefined ? { contextChars: c.contextChars } : {}),
  ...(c.toolResponseChars !== undefined ? { toolResponseChars: c.toolResponseChars } : {}),
  ...(c.searchHitsPerCall !== undefined ? { searchHitsPerCall: c.searchHitsPerCall } : {}),
  ...(c.reasoningEffort !== undefined ? { reasoningEffort: c.reasoningEffort } : {}),
  // 能力级提示词（AI 分析 / AI 查找）：内容与时间戳都要搬，且要**深拷一层**
  // （浅拷对象会让改草稿时顺手改到基线，表现为"没保存也生效了"）
  ...(c.analysisPrompt !== undefined ? { analysisPrompt: { ...c.analysisPrompt } } : {}),
  ...(c.findPrompt !== undefined ? { findPrompt: { ...c.findPrompt } } : {}),
  ...(c.analysis !== undefined
    ? {
        analysis: {
          targetDirs: {
            ...(c.analysis.targetDirs.defaultDir !== undefined ? { defaultDir: c.analysis.targetDirs.defaultDir } : {}),
            byScope: { ...c.analysis.targetDirs.byScope },
          },
          prompt: { ...c.analysis.prompt },
          skills: c.analysis.skills.map((s) => ({ ...s })),
          tools: { ...c.analysis.tools },
          ...(c.analysis.maxRounds !== undefined ? { maxRounds: c.analysis.maxRounds } : {}),
          ...(c.analysis.maxFiles !== undefined ? { maxFiles: c.analysis.maxFiles } : {}),
          ...(c.analysis.reasoningEffort !== undefined ? { reasoningEffort: c.analysis.reasoningEffort } : {}),
        },
      }
    : {}),
  /**
   * AI 查找域（REQ-20261116-005）：漏搬任何一项都会在「改别的配置保存」时被静默清空。
   * `ranges.byScope` 是预留字段 —— 即使本期不渲染也必须搬，否则手工改过的文件会被清掉。
   */
  ...(c.find !== undefined
    ? {
        find: {
          ranges: {
            extraScopes: [...c.find.ranges.extraScopes],
            ...(c.find.ranges.byScope !== undefined ? { byScope: { ...c.find.ranges.byScope } } : {}),
          },
          prompt: { ...c.find.prompt },
          skills: c.find.skills.map((s) => ({ ...s })),
          tools: { ...c.find.tools },
          ...(c.find.maxRounds !== undefined ? { maxRounds: c.find.maxRounds } : {}),
          ...(c.find.maxCandidates !== undefined ? { maxCandidates: c.find.maxCandidates } : {}),
          ...(c.find.timeoutMs !== undefined ? { timeoutMs: c.find.timeoutMs } : {}),
          ...(c.find.reasoningEffort !== undefined ? { reasoningEffort: c.find.reasoningEffort } : {}),
        },
      }
    : {}),
});
