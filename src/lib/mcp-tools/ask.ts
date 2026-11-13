/**
 * ask.ts —— MCP 工具 `ki_ask`（REQ-20261113-001 · S-02）
 *
 * ═══ 它是什么 ═══
 * 让外部 AI 客户端**一次调用**拿到「ki 自己用知识库检索 + 合成」的答案与来源。
 * 每次调用都是**独立问答**：不建会话、不读历史、不落盘、不进 web 会话列表。
 * 若只要原始文档片段，应当用 `ki_search`（本工具的价值在"检索编排 + 合成"，不在"取片段"）。
 *
 * ═══ 准入顺序（顺序固定，见 S-02 §4a.3）═══
 * 入参 → scope 形态 → scope 存在性 → **隐私闸门** → 限流 → runAsk → 审计 → 释放 → 归一返回
 *
 * ═══ 三道安全约束 ═══
 * 1. **只读 Token 不可用**：本工具不在 `READ_ONLY_TOOL_NAMES`（fail-safe），
 *    且 `mcp-http` 侧用 `MODEL_CONSUMING_TOOL_NAMES` 给出专用错误码与文案。
 * 2. **隐私确认不可绕过**：内部检索会把知识库内容发给上游模型，与页面 `/api/chat/*`
 *    的 `DISCLOSURE_REQUIRED` 是同一件事，不得因为换了 MCP 通道就放行。
 * 3. **内层恒只读**：固定传 `READ_ONLY_CAPABILITIES`，与用户在对话配置里打开了
 *    哪些工具**无关**（否则一个"问答"工具会带写库副作用）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadConfig } from '../config.js';
import { executeScopeList } from '../../scope.js';
import { readViews } from '../scope-view.js';
import { resolveLlmStatus } from '../chat/llm-client.js';
import { runAsk } from '../chat/ask/ask-runner.js';
import { acquireAskSlot, releaseAskSlot } from '../chat/ask/ask-limiter.js';
import { ASK_LOG_EVENTS, askLog } from '../chat/ask/ask-log.js';
import { ASK_QUESTION_MAX_CHARS, type AskResult } from '../chat/ask/ask-contract.js';
import type { Capability } from '../auth/capabilities.js';
import { TOOL_TIMEOUT, ToolTimeoutError, withTimeout } from './util.js';

/**
 * 内层工具面的**能力上界**（S-01 §7「内层恒只读」）。
 *
 * `canUseTool` 只放行 `knowledge.read` 的工具 ⇒ 内层只剩 6 个只读检索工具。
 * 这不是"调用方权限校验"，而是**给内层设上界**，因此不受 Token 能力集影响。
 */
const READ_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['knowledge.read']);

/** 对外失败形状：**展平** S-01 的嵌套 `error`（S-02 §4a.3 步骤 9） */
function failResult(
  code: string,
  message: string,
  retryable: boolean,
  extra?: Record<string, unknown>,
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: false, code, message, retryable, ...(extra ?? {}) }, null, 2),
    }],
  };
}

/** 成功形状：与既有 14 个工具一致（`content[0].text` 是 JSON 字符串） */
function okResult(result: AskResult, scope: string): { content: Array<{ type: 'text'; text: string }> } {
  const payload = {
    ok: true,
    scope,
    answer: result.answer,
    sources: result.sources,
    // 净化前的条数：调用方据此判断"来源是被截断了"还是"证据本来就只有这些"
    sourcesTotal: result.sourcesTotal,
    // 二期：下一次追问把它传回 context_id（不传则每次全新）
    contextId: result.contextId,
    expiresAt: result.expiresAt,
    resumed: result.resumed,
    rounds: result.rounds,
    elapsedMs: result.elapsedMs,
    truncated: result.truncated,
    ...(result.truncatedReason ? { truncatedReason: result.truncatedReason } : {}),
    ...(result.degraded ? { degraded: result.degraded } : {}),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** 工具描述：外部 AI 决定"要不要用 / 怎么用"的唯一依据，四要素缺一不可 */
const TOOL_DESCRIPTION = '让 ki 用它自己的模型 + 指定知识库回答一个问题：内部会自动多轮检索再合成，返回答案与来源。'
  + '默认每次调用都是全新问答；要追问就把上一次返回的 contextId 作为 context_id 传回（10 分钟内有效，每次交互顺延）。'
  + '适合"需要知识库综合结论"的问题；若只要原始文档片段，请用 ki_search。'
  + '单次耗时通常 5~30 秒，超过 45 秒会返回已生成的部分答案（truncated=true）。';

/**
 * 注册 `ki_ask`。
 * @param principalKey 调用方键（`tokenId` / `'local'`），用于限流归属与审计
 */
export function registerAskTool(server: McpServer, principalKey = 'local'): void {
  server.tool(
    'ki_ask',
    TOOL_DESCRIPTION,
    {
      scope: z.string().min(1).describe(
        '知识库名（必填）。必须是单个具体知识库，不接受视图名或逗号分隔多库；可用 ki_scope_list 查看',
      ),
      question: z.string().min(1).describe(
        '自然语言问题（建议一句话并带上必要限定条件）',
      ),
      context_id: z.string().optional().describe(
        '续接上一次问答：传回它返回的 contextId。缺省（推荐）＝每次全新问答。'
        + '有效期 10 分钟（滑动：每次交互顺延）；过期/不存在/非本人会明确报错，不会静默新开。'
        + '⚠️ 只在真正追问时传 —— 无关问题传了会把两件事串成一轮对话。',
      ),
    },
    async (args) => {
      const scope = args.scope.trim();
      const question = args.question.trim();

      // ① 入参：zod 的 min(1) 挡不住纯空白；长度上限防"把整段代码/日志当问题"（成本 + 延迟）
      if (question.length === 0) {
        return failResult('ASK_QUESTION_INVALID', '问题为空：请给出一个具体问题。', false);
      }
      if (question.length > ASK_QUESTION_MAX_CHARS) {
        return failResult(
          'ASK_QUESTION_INVALID',
          `问题过长（${question.length} 字符，上限 ${ASK_QUESTION_MAX_CHARS}）：请精简到一句话核心问题；`
          + '若要引用大段材料，请改用 ki_search 取片段后自行归纳（问答不负责"读长文"）。',
          false,
        );
      }

      // ② scope 形态：一期只支持单个具体知识库
      if (scope.includes(',')) {
        return failResult(
          'ASK_SCOPE_VIEW_UNSUPPORTED',
          'ki_ask 一期只支持单个知识库：请传一个具体的库名（用 ki_scope_list 查看），不要用逗号分隔多个库或视图名。',
          false,
        );
      }
      const config = loadConfig();
      try {
        const views = readViews(config);
        // 原型链防御：视图名表是普通对象，避免 `constructor` 之类被误判成视图
        if (Object.prototype.hasOwnProperty.call(views, scope)) {
          return failResult(
            'ASK_SCOPE_VIEW_UNSUPPORTED',
            `「${scope}」是视图（多库聚合），ki_ask 一期只支持单个知识库：请改传视图里某个具体库名。`,
            false,
          );
        }
      } catch {
        // 视图配置不可读不阻塞：继续按普通 scope 校验（存在性那步会兜住）
      }

      // ③ scope 存在性（KB 层或向量层任一存在即可）
      try {
        const list = await withTimeout(executeScopeList(), TOOL_TIMEOUT.READ, 'ki_ask.scope-check');
        const hit = list.scopes.find((entry) => entry.scope === scope);
        if (!hit || (!hit.kb && !hit.vector)) {
          return failResult(
            'ASK_SCOPE_NOT_FOUND',
            `知识库「${scope}」不存在（KB 与向量层都没有）：请用 ki_scope_list 确认库名后再试。`,
            false,
          );
        }
      } catch (err) {
        return failResult('ASK_INTERNAL', `知识库校验失败：${(err as Error).message}`, true);
      }

      // ④ 隐私闸门（合规，不可省）：内部检索会把知识库内容外发给上游模型
      //    ⚠️ `enabled === false` 交给 runAsk 判，避免两处重复实现同一判定
      const status = resolveLlmStatus(config, config._configPath ?? '');
      if (status.ackRequired) {
        return failResult(
          'ASK_DISCLOSURE_REQUIRED',
          '知识库内容外发未确认：问答会把知识库片段发送给上游模型。'
          + '请先在 ki 的「AI 对话」配置里完成隐私确认（写入 llm.kbDisclosureAck），或由管理员在 config.yaml 中设置。',
          false,
        );
      }

      // ⑤ 限流准入（频率 + 全局并发）
      const slot = acquireAskSlot(principalKey, scope);
      if (!slot.ok) {
        const code = slot.code;
        askLog(ASK_LOG_EVENTS.THROTTLED, {
          scope, principalKey, questionChars: question.length, code, retryable: true,
        });
        return failResult(
          code,
          code === 'ASK_BUSY'
            ? '当前问答并发已达上限（全局 2 个在途）：请稍后重试。'
            : `调用过于频繁：每个知识库 60 秒内最多 10 次问答，请 ${slot.retryAfterSec} 秒后重试。`,
          true,
          { retryAfterSec: slot.retryAfterSec },
        );
      }

      // ⑥⑦⑧ 执行 → 审计 → 释放（释放必须在 finally）
      try {
        const contextIdArg = typeof args.context_id === 'string' ? args.context_id.trim() : '';
        const result = await withTimeout(
          runAsk({
            scope,
            question,
            ...(contextIdArg.length > 0 ? { contextId: contextIdArg } : {}),
            // 归属校验用：不同 Token 不能续接同一个 contextId（S-03 §4.3）
            principalKey,
            capabilities: READ_ONLY_CAPABILITIES,
          }),
          TOOL_TIMEOUT.ASK,
          'ki_ask',
        );
        askLog(result.ok ? ASK_LOG_EVENTS.DONE : ASK_LOG_EVENTS.ERROR, {
          scope,
          principalKey,
          rounds: result.rounds,
          elapsedMs: result.elapsedMs,
          truncated: result.truncated,
          ...(result.truncatedReason ? { truncatedReason: result.truncatedReason } : {}),
          questionChars: question.length,
          ...(result.usage?.promptTokens !== undefined ? { promptTokens: result.usage.promptTokens } : {}),
          ...(result.usage?.completionTokens !== undefined ? { completionTokens: result.usage.completionTokens } : {}),
          ...(result.error ? { code: result.error.code, retryable: result.error.retryable } : {}),
        });

        if (!result.ok) {
          const err = result.error ?? { code: 'ASK_INTERNAL', message: '问答失败（无错误详情）', retryable: true };
          return failResult(err.code, err.message, err.retryable);
        }
        return okResult(result, scope);
      } catch (err) {
        const timedOut = err instanceof ToolTimeoutError;
        const code = timedOut ? 'ASK_TIMEOUT' : 'ASK_INTERNAL';
        askLog(ASK_LOG_EVENTS.ERROR, {
          scope, principalKey, questionChars: question.length, code, retryable: true,
        });
        return failResult(
          code,
          timedOut
            ? `问答超过 ${Math.round(TOOL_TIMEOUT.ASK / 1000)} 秒仍未返回：建议缩小问题范围后重试。`
            : `问答内部错误：${(err as Error).message}`,
          true,
        );
      } finally {
        releaseAskSlot();
      }
    },
  );
}
