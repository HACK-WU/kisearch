/**
 * vectorDimensionNotice.ts —— 顶栏「向量维度」告警 banner 的可忽略规则
 *
 * 背景（用户 2026-10-12 反馈）：维度不匹配 / 无法确认的 banner 一直挂在顶栏下方，
 * 除「重新检查」外没有任何消除入口，用户希望异常提示都能手动消掉。
 *
 * 规则：忽略时记下**状态指纹**（scope + state + 维度 + 降级原因 + 请求是否失败）；
 * 指纹不变则不再显示，一旦指纹变化（重建完成 / 维度值改变 / 从 unknown 变 mismatch /
 * 请求恢复或再次失败）立即重新提示 —— 既不再反复打扰，也不把「状态变了」静默吞掉。
 *
 * 纯函数抽出以便单测（web/test/vector-dimension-notice.test.mjs）。
 */

/** 忽略时间戳之外的「已忽略指纹」存储 key（全局，不按 scope 分桶；不同 scope 的指纹本身已含 scope） */
export const VECTOR_DIMENSION_DISMISS_KEY = 'ki.vectorDimensionNoticeDismissed';

export interface DimensionNoticeInput {
  scope: string;
  /** `status.state`（compatible / mismatch / unknown；缺失 = 尚无数据） */
  state?: string;
  persisted?: number;
  configured?: number;
  /** R8 降级原因（当前只有 'timeout'） */
  degradedReason?: string;
  /** 维度状态请求本身失败（`dimensionQuery.error`） */
  hasError?: boolean;
}

/** 需要提示的两种情况：维度不匹配（有 persisted 才算确定不匹配）与无法确认 */
export function dimensionNoticeKind(input: DimensionNoticeInput): 'mismatch' | 'unknown' | null {
  if (input.state === 'mismatch' && input.persisted !== undefined) return 'mismatch';
  if (input.state === 'unknown' || input.hasError) return 'unknown';
  // mismatch 但没有 persisted：既有口径不展示（无从判断旧向量维度）
  return null;
}

/**
 * 状态指纹：字段取值相同 ⇒ 用户此前对该状态的「忽略」继续有效；
 * 任一字段变化（含 degraded 原因、请求失败）⇒ 指纹变化 ⇒ 重新提示。
 */
export function dimensionNoticeFingerprint(input: DimensionNoticeInput): string {
  return JSON.stringify([
    dimensionNoticeKind(input),
    input.scope,
    input.state ?? '',
    input.persisted ?? null,
    input.configured ?? null,
    input.degradedReason ?? '',
    input.hasError ? 'error' : '',
  ]);
}

/** 该状态的提示是否应展示（`dismissedFingerprint` 为 null = 从未忽略） */
export function shouldShowDimensionNotice(input: DimensionNoticeInput, dismissedFingerprint: string | null): boolean {
  if (dimensionNoticeKind(input) === null) return false;
  return dismissedFingerprint !== dimensionNoticeFingerprint(input);
}

/** 读取已忽略的指纹（localStorage 不可用时按未忽略处理） */
export function readDimensionDismissedFingerprint(key = VECTOR_DIMENSION_DISMISS_KEY): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** 记住本次忽略（写入失败不影响本次会话内的隐藏效果，由调用方刷新状态触发重算） */
export function writeDimensionDismissedFingerprint(fingerprint: string, key = VECTOR_DIMENSION_DISMISS_KEY): void {
  try { localStorage.setItem(key, fingerprint); } catch { /* 存储不可用：本次会话内仍隐藏 */ }
}
