/**
 * DetailParts —— 详情抽屉的内容块（数据源 / 任务共用）
 *
 * 与 `DetailDrawer`（外壳）`DetailSection`（分区）配套：
 *   - DetailHero   执行结果顶部：完成数 + 分段条 + 图例
 *   - DetailMetrics 指标网格（3 列）
 *   - DetailParams  键值行（key：value 横排，支持 hint / 链接 / 层级树 / 独占整行）
 *
 * 数据源详情是视觉基线（2026-10-22 定稿）；任务详情自 2026-10-26 起直接复用这些块，
 * 不再各自维护一套结果/参数排版。
 */
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buildGroupTreeLines, type DetailRow } from '@/lib/taskDetailModel';

export interface DetailHeroProps {
  completed: number;
  total: number;
  skipped?: number;
  failed?: number;
  /** 完成数中内容未变的子集（来源文档未变、未重算） */
  unchanged?: number;
  /** 量词（默认「篇」） */
  unit?: string;
  /** 「失败」一档的文案（任务详情用「未完成」，数据源用「失败」） */
  failedLabel?: string;
}

export function DetailHero({ completed, total, skipped = 0, failed = 0, unchanged = 0, unit = '篇', failedLabel = '失败' }: DetailHeroProps): JSX.Element {
  const totalSafe = Math.max(1, total);
  const percent = Math.round((completed / totalSafe) * 1000) / 10;
  const segments = [
    { cls: 'done', count: completed },
    { cls: 'skipped', count: skipped },
    { cls: 'failed', count: failed },
  ].filter((segment) => segment.count > 0);

  return (
    <div className="ki-detail-hero">
      <div>
        <div className="ki-detail-hero__num">{completed}</div>
        <div className="ki-detail-hero__label">完成</div>
      </div>
      <div>
        <div className="ki-detail-hero__barrow">
          <span
            className="ki-detail-bar"
            role="img"
            aria-label={`完成 ${percent}%，共 ${total} ${unit}`}
          >
            {segments.map((segment) => (
              <span
                key={segment.cls}
                className={`ki-detail-bar__seg ki-detail-bar__seg--${segment.cls}`}
                style={{ width: `${(segment.count / totalSafe) * 100}%` }}
              />
            ))}
          </span>
          <span className="ki-detail-hero__pct">{percent}%</span>
        </div>
        <div className="ki-detail-legend">
          <span className="ki-detail-legend__item ki-detail-legend__item--done">
            完成 {completed}
            {unchanged > 0 ? <span className="ki-detail-legend__sub">（未变 {unchanged}）</span> : null}
          </span>
          <span className="ki-detail-legend__dot" aria-hidden>·</span>
          <span className="ki-detail-legend__item">跳过 {skipped}</span>
          <span className="ki-detail-legend__dot" aria-hidden>·</span>
          {failed > 0 ? (
            <span className="ki-detail-legend__item ki-detail-legend__item--failed">{failedLabel} {failed}</span>
          ) : (
            <span className="ki-detail-legend__item">{failedLabel} 0</span>
          )}
        </div>
      </div>
    </div>
  );
}

export interface DetailMetric {
  label: string;
  value: number | string;
  tone?: 'normal' | 'danger';
}

export function DetailMetrics({ metrics }: { metrics: DetailMetric[] }): JSX.Element {
  return (
    <dl className="ki-detail-metrics">
      {metrics.map((metric) => {
        const zero = metric.value === 0;
        const danger = metric.tone === 'danger' && typeof metric.value === 'number' && metric.value > 0;
        return (
          <div key={metric.label} className="ki-detail-metric">
            <dt className="ki-detail-metric__label">{metric.label}</dt>
            <dd className={`ki-detail-metric__value${zero ? ' ki-detail-metric__value--zero' : ''}${danger ? ' ki-detail-metric__value--danger' : ''}`}>
              {metric.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** 这些标签的值是路径/标识，用等宽字体（与数据源参数一致） */
const MONO_LABEL = /仓库|分支|提交|Group|知识库/;

export function DetailParams({ rows }: { rows: DetailRow[] }): JSX.Element {
  return (
    <dl className="ki-detail-params">
      {rows.map((row) => (
        <DetailParamCell key={row.label} row={row} />
      ))}
    </dl>
  );
}

function DetailParamCell({ row }: { row: DetailRow }): JSX.Element {
  const mono = MONO_LABEL.test(row.label);
  let value: ReactNode;
  if (row.tree && row.tree.items.length > 0) {
    const tree = <pre className="ki-task-tree" tabIndex={0} aria-label={`${row.label} 层级树，共 ${row.tree.items.length} 个`}>{buildGroupTreeLines(row.tree.items).join('\n')}</pre>;
    value = row.tree.summary ? (
      <details className="ki-task-detail__details">
        <summary>{row.tree.summary}</summary>
        {tree}
      </details>
    ) : tree;
  } else {
    value = (
      <>
        {row.href ? <Link to={row.href}>{row.value}</Link> : <span>{row.value}</span>}
        {row.hint ? <small className="ki-detail-params__hint">{row.hint}</small> : null}
      </>
    );
  }
  return (
    <div className={`ki-detail-params__cell${row.full ? ' ki-detail-params__cell--full' : ''}`}>
      <dt>{row.label}</dt>
      <dd className={mono ? 'is-mono' : undefined}>{value}</dd>
    </div>
  );
}
