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

/**
 * 「向量维度」小面板的状态角标（REQ-20261016-002 / 用户裁决 D3②）。
 *
 * 语义边界（守 N9 同款诚实性）：**只有 `persisted` 存在**时才敢断言"一致 / 不符"；
 * 其余一律「未确认」—— 绝不把"没取到"渲染成"一致"。
 * 与顶栏 banner 的判定口径同源（`dimensionNoticeKind`：mismatch 也只在有 persisted 时成立）。
 */
export interface DimensionBadge {
  text: string;
  /** 复用 `.ki-badge--{ok|warn|off}` 三个色调 */
  tone: 'ok' | 'warn' | 'off';
  title: string;
}

export function dimensionBadge(input: {
  state?: string;
  persisted?: number;
  hasError?: boolean;
  scope?: string;
}): DimensionBadge {
  if (input.state === 'mismatch' && input.persisted !== undefined) {
    const scopeArg = input.scope && input.scope.length > 0 ? ` ${input.scope}` : ' <scope>';
    return {
      text: `集合 ${input.persisted} 维`,
      tone: 'warn',
      title: `集合维度与当前配置不符：需执行 ki restore${scopeArg} --rebuild-vector --yes 重建向量`,
    };
  }
  if (input.state === 'compatible' && input.persisted !== undefined) {
    return {
      text: '集合一致',
      tone: 'ok',
      title: `集合维度 ${input.persisted} 维，与当前配置一致`,
    };
  }
  return {
    text: '未确认',
    tone: 'off',
    title: input.hasError
      ? '维度状态请求失败；可稍后重试或执行 ki doctor 排查'
      : '尚未取到集合维度（快照缺失或已过期）',
  };
}

/**
 * 模型名面板的 hover 全文：完整模型名 + provider + baseURL（D4②）。
 * 兼作**省略号后的全文入口**（模型名可能被截断，见 `.ki-stat-value--text`）。
 * 三者全缺（旧 daemon）时返回 undefined ⇒ 不渲染空的 title 属性。
 */
export function embeddingIdentityTitle(status?: {
  model?: string;
  provider?: string;
  baseURL?: string;
}): string | undefined {
  const parts = [status?.model, status?.provider, status?.baseURL]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
