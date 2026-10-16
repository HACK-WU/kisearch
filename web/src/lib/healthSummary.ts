/**
 * healthSummary.ts —— 服务健康状态的**纯逻辑判据**（REQ-20261016-003）
 *
 * 从 hooks.ts 抽出：徽标 / 横幅 / 总览卡 / 明细面板四处共用同一判据，且必须能被单测
 * （不依赖 react-query 与浏览器环境）。`hooks.ts` 只负责 query 封装并 re-export 本模块。
 *
 * ★ 核心区分（历史踩坑，**不可改**）：只要拿到了 HTTP 应答，服务就是活的 —— 检查超时或
 *   某项失败都不能说成「未就绪」，否则用户会去重启一个本来正常的 daemon。
 * ★ 徽标文案口径（REQ-20261016-003 D2）：不再使用 `MCP HTTP` 前缀 —— 该判据实为 doctor
 *   自检（含 embedding / 目录 / 配置字段），与"服务是否存活"不是同一件事。
 */

import type { HealthItem, HealthResponse } from '@/api/httpApi';

export type HealthLevel = 'checking' | 'unreachable' | 'slow' | 'fail' | 'warn' | 'ok';

/** 一条非 pass 的健康检查项（明细面板的最小单元） */
export interface HealthIssue {
  name: string;
  status: 'warn' | 'fail';
  /** 后端 detail（已含原因与修复指引）；旧 daemon 缺 detail 时退化为 message，两者皆空则为空串 */
  detail: string;
}

export interface HealthSummary {
  level: HealthLevel;
  /** 徽标可见短文案：受 .ki-service-badge 固定宽度 + nowrap 约束，必须短（完整内容在明细面板） */
  label: string;
  /** 首项原因（兼容既有消费方：横幅 / 总览卡）；完整清单见 issues */
  detail: string;
  /** 全部非 pass 项：**fail 在前、warn 在后**，各自保持 report.items 原序 */
  issues: HealthIssue[];
  /** doctor 侧计数（report.pass/warn/fail 原值）；未拿到报告时为 undefined（旧 daemon / 请求失败） */
  counts?: { pass: number; warn: number; fail: number };
  /** 是否拿到了带 items 的报告（false ⇒ 面板显示「后端未返回健康明细」而非空列表） */
  hasReport: boolean;
}

/** 把 doctor 报告拆成异常项清单：fail 全部在前，其余保持原序 */
export function toHealthIssues(items: HealthItem[]): HealthIssue[] {
  const pick = (status: 'fail' | 'warn'): HealthIssue[] =>
    items
      .filter((i) => i.status === status)
      .map((i) => ({ name: i.name, status, detail: (i.detail ?? i.message ?? '').trim() }));
  return [...pick('fail'), ...pick('warn')];
}

/** 复制按钮的载荷：优先 detail（含原因与修复指引），为空时退化为项名 */
export function healthIssueCopyText(issue: HealthIssue): string {
  return issue.detail.length > 0 ? issue.detail : issue.name;
}

/**
 * 网络层失败时浏览器给的原始文案（`Failed to fetch` / `NetworkError…`）对用户无意义，
 * 统一换成可行动的人话；其余 message 原样透出（后端真实原因不该被前端覆盖）。
 */
export function humanizeHealthError(message: string | undefined): string {
  const raw = (message ?? '').trim();
  if (raw && !/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(raw)) {
    return raw;
  }
  return '无法连接服务（服务未启动或网络异常），请确认 ki mcp --http --web 正在运行';
}

/**
 * 健康状态的唯一判据，徽标 / 横幅 / 总览卡片 / 明细面板共用。
 *
 * REQ-20261016-003 起额外输出 issues / counts / hasReport（供明细面板与总览角标使用）；
 * **level 判定优先级未变**：checking → unreachable/slow → 首个 fail → 首个 warn → ok。
 */
export function summarizeHealth(
  data: HealthResponse | undefined,
  error: unknown,
  pending: boolean,
): HealthSummary {
  const none = { issues: [] as HealthIssue[], hasReport: false };
  // TanStack Query 无错误时给的是 null 而非 undefined，只能用真值判定
  if (pending || (!data && !error)) {
    return { level: 'checking', label: '检测中…', detail: '', ...none };
  }
  if (error) {
    const e = error as { status?: number; message?: string; body?: HealthResponse };
    // 无 status = fetch 直接 reject，才是真的连不上；有 status = 服务应答了
    if (e.status === undefined) {
      return { level: 'unreachable', label: '无法连接服务', detail: humanizeHealthError(e.message), ...none };
    }
    return {
      level: 'slow',
      label: '健康检查未完成',
      detail: e.body?.error ?? e.message ?? `HTTP ${e.status}`,
      ...none,
    };
  }
  const report = data?.report;
  const items = report?.items ?? [];
  const issues = toHealthIssues(items);
  const counts = report
    && typeof report.pass === 'number' && typeof report.warn === 'number' && typeof report.fail === 'number'
    ? { pass: report.pass, warn: report.warn, fail: report.fail }
    : undefined;
  const failCount = issues.filter((i) => i.status === 'fail').length;
  if (failCount > 0) {
    return {
      level: 'fail',
      label: `${failCount} 项异常 · ${issues[0].name}`,
      detail: issues[0].detail,
      issues,
      counts,
      hasReport: items.length > 0,
    };
  }
  if (issues.length > 0) {
    return {
      level: 'warn',
      label: `${issues.length} 项告警 · ${issues[0].name}`,
      detail: issues[0].detail,
      issues,
      counts,
      hasReport: items.length > 0,
    };
  }
  return { level: 'ok', label: '服务健康', detail: '', issues, counts, hasReport: items.length > 0 };
}
