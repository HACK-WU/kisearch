/**
 * HealthDetailPanel.tsx —— 服务健康明细面板（REQ-20261016-003 R1 / D1）
 *
 * 解决的问题：异常时徽标只能显示「N 项异常 · 首项名」，完整原因与修复指引原先只躺在
 * 原生 `title` 里 —— 触屏没有 hover、键盘用户拿不到 title、长项名还会被固定宽度徽标
 * 截断（实测 scrollWidth 481 / clientWidth 134）。本面板是同一判据
 * （`lib/healthSummary.ts`）的可交互呈现：列出**全部**非 pass 项（fail 在前）。
 *
 * 边界（不可越）：
 *   · 只读：展示 + 复制 + 触发一次重新检查；**不提供任何启动 / 停止 / 重启服务的入口**
 *     （项目硬约束：前端只检测与指引，见 `HealthBanner.tsx` 头注释）；
 *   · 非模态：不阻塞页面操作，点面板外 / ESC 关闭（关闭逻辑在 AppShell，含焦点归还）。
 *
 * 无障碍：弹层本体 `role="dialog"`；触发按钮的 `aria-expanded` / `aria-haspopup` 在 AppShell。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { copyText } from '@/lib/clipboard';
import { healthIssueCopyText, type HealthIssue, type HealthSummary } from '@/lib/healthSummary';
import { Icon } from '@/components/icons';

const TONE: Record<HealthIssue['status'], string> = { fail: 'x', warn: 'warn' };

/** 复制反馈的保留时长（成功短、失败长——失败文案需要被读到） */
const COPY_HOLD_MS = { ok: 1500, fail: 4000 };

function formatCheckedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `检查于 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface HealthDetailPanelProps {
  summary: HealthSummary;
  /** 最近一次成功取数时间（TanStack Query 的 dataUpdatedAt），用于显示检查时刻 */
  updatedAt?: number;
  /** 正在重新检查（按钮禁用 + 文案切换，防连点） */
  checking: boolean;
  onRetry: () => void;
  /** 关闭面板（「查看完整自检」跳转后调用，避免浮层残留在顶栏上） */
  onClose?: () => void;
}

export function HealthDetailPanel({ summary, updatedAt, checking, onRetry, onClose }: HealthDetailPanelProps): JSX.Element {
  const [copyState, setCopyState] = useState<{ key: string; ok: boolean } | null>(null);
  const { issues, counts, hasReport, level } = summary;
  const failCount = issues.filter((i) => i.status === 'fail').length;
  const warnCount = issues.length - failCount;

  // 标题按 level 分派：**不可达 / 检查未完成 / 加载中都不是"无异常"**，也不该说成"后端未返回明细"
  const headTitle = level === 'fail' || level === 'warn'
    ? [failCount > 0 ? `${failCount} 项异常` : '', warnCount > 0 ? `${warnCount} 项告警` : '']
      .filter(Boolean).join(' · ')
    : level === 'checking' ? '正在检查服务健康'
      : level === 'unreachable' ? '无法连接服务'
        : level === 'slow' ? '健康检查未完成'
          : '服务健康';

  // 空态文案分派（code-review 2026-10-16 修复）：原实现把所有"无 items"都归为
  // "后端未返回健康明细（可能是旧版 daemon），请升级后重试" —— 在**加载中**与
  // **不可达 / 检查超时**三态下都是误导（会让用户去升级/重启一个正常的 daemon，
  // 与 hooks.ts 头注释里记载的历史踩坑同型）。
  const emptyCopy = ((): string => {
    if (level === 'checking') return '正在检查服务健康…';
    if (level === 'unreachable' || level === 'slow') {
      return summary.detail || '未能取得健康报告，请稍后重试。';
    }
    return hasReport
      ? '当前没有异常项，全部检查通过。'
      : '后端未返回健康明细（可能是旧版 daemon），请升级后重试。';
  })();

  const onCopy = (issue: HealthIssue): void => {
    const key = issue.name;
    const settle = (ok: boolean): void => {
      setCopyState({ key, ok });
      window.setTimeout(
        () => setCopyState((cur) => (cur?.key === key ? null : cur)),
        ok ? COPY_HOLD_MS.ok : COPY_HOLD_MS.fail,
      );
    };
    // 失败也要给可见反馈（剪贴板不可用 / 权限拒绝）——正文本身可手动选中
    void copyText(healthIssueCopyText(issue)).then(() => settle(true), () => settle(false));
  };

  return (
    <div className="ki-health-panel" role="dialog" aria-label="服务健康明细">
      <div className="ki-health-panel__head">
        <span className="ki-health-panel__title">{headTitle}</span>
        <span className="ki-health-panel__meta">
          {checking
            ? '检查中…'
            : [counts ? `${counts.pass} 项通过` : null, updatedAt ? formatCheckedAt(updatedAt) : null]
              .filter(Boolean).join(' · ')}
        </span>
      </div>

      <div className="ki-health-panel__body">
        {issues.length === 0 ? (
          <p className="ki-health-panel__empty">{emptyCopy}</p>
        ) : (
          <ul className="ki-health-panel__list">
            {issues.map((issue) => (
              <li className={`ki-health-issue ki-health-issue--${issue.status}`} key={issue.name}>
                <span className={`ki-health-issue__icon ki-health-issue__icon--${issue.status}`} aria-hidden="true">
                  <Icon name={TONE[issue.status]} className="ki-icon ki-icon--sm" />
                </span>
                <div className="ki-health-issue__main">
                  <div className="ki-health-issue__name">{issue.name}</div>
                  <div className="ki-health-issue__detail">{issue.detail || '后端未提供具体原因'}</div>
                  <button
                    type="button"
                    className={`ki-health-issue__copy${copyState?.key === issue.name && !copyState.ok ? ' ki-health-issue__copy--fail' : ''}`}
                    onClick={() => onCopy(issue)}
                  >
                    {copyState?.key === issue.name
                      ? (copyState.ok ? '已复制' : '复制失败，请手动选中文本')
                      : '复制处理建议'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ki-health-panel__foot">
        <button
          type="button"
          className="ki-btn ki-btn--secondary ki-btn--small"
          onClick={onRetry}
          disabled={checking}
        >
          {checking ? '检查中…' : '重新检查'}
        </button>
        {/* 完整自检清单在总览页；`selfcheck=1` 让折叠区直接展开（见 DashboardPage） */}
        <Link className="ki-health-panel__more" to="/?selfcheck=1" onClick={() => onClose?.()}>
          查看完整自检 →
        </Link>
      </div>
    </div>
  );
}
