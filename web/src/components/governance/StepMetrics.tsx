/**
 * 步骤的「展开明细」（2026-11-18）。
 *
 * 此前直接把 `metrics` 的英文 key 铺成 `<dt>/<dd>`（`members 0`、`refs 9`、
 * `hasDescription no`、`verified 7`、`dropped 0`）—— 用户反馈"看不懂是啥意思"。
 * 这里做两件事：① key 翻成人话；② 布尔/枚举值翻成中文，其余原样。
 *
 * 未知 key 不隐藏（可能是新加的指标），退化为「把 key 里的 _ / - 换成空格」。
 */
const LABELS: Record<string, string> = {
  // 分析
  members: '关联文档',
  refs: '参考文档',
  hasDescription: '事件描述',
  calls: '工具调用',
  filesRead: '已读文件',
  newReads: '本轮新读',
  verified: '保留候选',
  dropped: '剔除候选',
  // 查找
  understand: '理解',
  extract: '提取',
  search: '检索',
  exclude: '排除',
  rank: '排序',
  hits: '命中',
  scanned: '扫描',
  candidates: '候选',
  excluded: '已排除',
  added: '新加入',
  associated: '已关联',
  durationMs: '耗时(ms)',
};

const VALUE_TEXT: Record<string, Record<string, string>> = {
  hasDescription: { yes: '有', no: '无' },
};

function valueText(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  const mapped = VALUE_TEXT[key]?.[String(value)];
  if (mapped) return mapped;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' · ');
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 100);
  return String(value);
}

export interface StepMetricsProps {
  data: Record<string, number | string> | Record<string, unknown> | undefined | null;
}

export function StepMetrics(props: StepMetricsProps): JSX.Element | null {
  // `round` 不展示（2026-11-19 用户要求）：展开明细里的「轮次 0」会被读成出错
  const entries = Object.entries(props.data ?? {}).filter(([key]) => key !== 'round');
  if (entries.length === 0) return null;
  return (
    <div className="gov-step-metrics">
      {entries.map(([key, value]) => (
        <span key={key} className="gov-step-metric">
          <b>{LABELS[key] ?? key.replace(/[_-]/g, ' ')}</b>
          {valueText(key, value)}
        </span>
      ))}
    </div>
  );
}
