/**
 * vectorDimensionCopy.ts —— 向量维度提示文案（R8，REQ-20261009-003）
 *
 * 纯函数抽出（可被 `web/test/*.test.mjs` 以 vite.ssrLoadModule 单测），替代 AppShell 内联 IIFE。
 *
 * 语义（守 N9）：`degraded` 表示「引擎未在超时上限内响应，**本次未确认**」，
 * 而**不是**「快照缺失 / 引擎故障」—— 文案必须区分，否则用户会以为维度信息丢了。
 */

/** 降级时展示的标题（与未确认标题区分，见测试断言「两分支文案不同」） */
export const DEGRADED_TITLE = '向量维度刷新未完成';
/** 无降级时沿用原标题 */
export const UNKNOWN_TITLE = '暂无法确认向量维度';

/** 时间格式对齐 `TasksPage.timeLabel`（dateStyle short + timeStyle medium）；跨天不误导 */
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' });

export interface DimensionCopyStatus {
  configured?: number;
  persisted?: number;
  checkedAt?: number;
  error?: string;
}

export interface DimensionCopyDegraded {
  reason?: string;
  waitedMs?: number;
}

/**
 * 生成 banner 副文案。
 *
 * - 无 `degraded` → 既有口径：`status.error` 或缺省话术（与改动前一致，不回归）；
 * - 有 `degraded`：
 *   - `persisted` 存在 → 「…显示上次结果：N 维（检查于 …）」；
 *   - `persisted` 缺失（快照缺失/过期/unknown 时 `readVectorDimensionSnapshot` 只返回
 *     `configured`）→ **不得把当前配置冒充"上次结果"**，改为「本次未取到维度快照（当前配置 N 维）」；
 *   - `waitedMs` 非有限数（缺字段/换版后端）→ 兜底话术，不渲染 "NaNs"。
 */
export function dimensionStatusDetail(input: {
  degraded?: DimensionCopyDegraded | undefined;
  status?: DimensionCopyStatus | undefined;
}): string {
  const { degraded, status } = input;
  if (!degraded) return status?.error ?? '维度快照缺失或已过期';

  const waitedMs = degraded.waitedMs;
  const waited = waitedMs !== undefined && Number.isFinite(waitedMs) && waitedMs >= 0
    ? `引擎未在 ${Math.round(waitedMs / 1000)}s 内响应`
    : '引擎未在预期时间内响应';

  const persisted = status?.persisted;
  if (persisted === undefined) {
    const configured = status?.configured;
    const current = configured !== undefined && Number.isFinite(configured) ? `（当前配置 ${configured} 维）` : '';
    return `${waited}，本次未取到维度快照${current}`;
  }

  const checkedAt = status?.checkedAt;
  const at = checkedAt !== undefined && Number.isFinite(checkedAt) && checkedAt > 0
    ? `（检查于 ${TIME_FORMAT.format(checkedAt)}）`
    : '';
  return `${waited}，显示上次结果：${persisted} 维${at}`;
}
