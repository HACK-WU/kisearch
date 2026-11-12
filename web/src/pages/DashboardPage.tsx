/**
 * DashboardPage.tsx —— 总览（对齐 demo：服务横幅 + 统计卡 + scope 表格 + 健康列表）
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { summarizeHealth, useHealth, useScopeList, useDocList, useVectorDimensionStatus, useDataSourceList, useIsViewName, type HealthSummary, type ScopeEntry } from '@/lib/hooks';
import { scopeOverviewCounts } from '@/lib/scopeCounts';
import { dimensionBadge, embeddingIdentityTitle } from '@/lib/vectorDimensionCopy';
import { describeWikiSync } from '@/lib/resourcesPage';
import { layerColumns, readModeCard, wikiWritebackCard, currentScopeHeading, viewCountCard } from '@/lib/dashboardScopeCards';
import { scopeReadonlyTitle } from '@/lib/scopeReadonly';
import {
  DEFAULT_SORT,
  HEAT_TEXT,
  USAGE_FULL_WINDOW_DAYS,
  buildScopeRows,
  daysSinceLocalDate,
  formatCount,
  nextSort,
  type ScopeRow,
  type SortDir,
  type SortKey,
  type WindowDays,
} from '@/lib/scopeUsageTable';
import { useAuth } from '@/lib/authContext';
import { scheduleSummaryView, summarizeSchedules } from '@/lib/datasourceSchedule';
import {
  normalizeScopeMode,
  registeredScopesOf,
} from '@/lib/registeredScopes';
import { getLastRttMs } from '@/api/httpApi';
import { getTasks } from '@/api/tasksApi';
import { useScopeValue } from '@/lib/scopeContext';
import { normalizeDocData } from '@/lib/viewBuckets';
import { HealthBanner } from '@/components/HealthBanner';
import { Icon } from '@/components/icons';
import type { HealthReport, HealthItem } from '@/api/httpApi';

/**
 * 运行概览已覆盖的 doctor 检查项名（REQ-20261016-003 R4）：
 * 「数据目录可写 / MCP HTTP 服务 / 嵌入服务维度 / FTS 索引 / 后台任务队列」5 行只映射到这几项，
 * doctor 的其余非 pass 项原本在概览区完全不可见 —— 需补一行「另有 N 项」摘要，避免"卡片全绿"错觉。
 */
const RUNTIME_COVERED_DOCTOR_NAMES = new Set(['dataDir', '维度匹配', '密钥有效性']);

const HEALTH_ICON: Record<string, { name: string; tone: string }> = {
  pass: { name: 'check', tone: 'ok' },
  warn: { name: 'warn', tone: 'warn' },
  fail: { name: 'x', tone: 'fail' },
};

/** 只读徽标（REQ-20261029-001）：仅只读 scope 显示；可写时不渲染，避免噪声 */
function readonlyBadge(scope: string, readonly: boolean | undefined): JSX.Element | null {
  if (readonly !== true) return null;
  return (
    <span className="ki-badge ki-badge--readonly" title={scopeReadonlyTitle(scope)}>只读</span>
  );
}

function badgeCell(ok: boolean | undefined, label: string, cls: string): JSX.Element {
  return (
    <span className={`ki-badge ${ok ? cls : 'ki-badge--off'}`}>
      {ok ? label : '—'}
    </span>
  );
}

// ─── scope 用量列（REQ-20261112-001 S-03）───────────────────────────────

/**
 * 冷热徽标。
 *
 * ★ `row.heat === null` = **统计不可用** ⇒ 渲染 `—`，不渲染「无调用」：
 *   两者含义完全不同（没在统计 vs 统计正常但窗口内 0 次）。
 * ★ 零调用档文案是「无调用」而非「未使用」——判据是「本窗口内 0 次」，
 *   162 行里 100+ 行会命中该档，用「未使用」会诱导批量误删。
 */
function HeatBadge({ row, windowDays }: { row: ScopeRow; windowDays: WindowDays }) {
  if (!row.heat) {
    return <span className="ki-cell-sub" title="统计不可用（尚未产生统计数据）">—</span>;
  }
  const title = row.heat === 'unused'
    ? `近 ${windowDays} 天内无检索 / 写入调用`
    : `近 ${windowDays} 天：检索 ${formatCount(row.usage?.read ?? 0)} 次、写入 ${formatCount(row.usage?.write ?? 0)} 次`;
  return (
    <span className={`ki-scope-heat ki-scope-heat--${row.heat}`} title={title}>
      <span className="ki-scope-heat__dot" />
      <span>{HEAT_TEXT[row.heat]}</span>
    </span>
  );
}

/**
 * 调用量单元格：千分位，覆盖不足只在 `title` 里说明。
 *
 * ★ 刻意**不**在数字旁加 `*` 角标：统计刚上线时 `coveredDays` 对每一行都小于窗口，
 *   172 行全带星 ⇒ 星号信息量为零、只剩噪声。而「统计从哪天开始」是**全局**事实，
 *   由卡头统一提示一次即可（`.ki-scope-since`），不必逐行重复。
 */
function CountCell({ value, coveredDays, windowDays }: { value: number | null; coveredDays: number | null; windowDays: WindowDays }) {
  if (value === null) {
    return <span className="ki-cell-sub" title="统计不可用（尚未产生统计数据）">—</span>;
  }
  const partial = coveredDays !== null && coveredDays > 0 && coveredDays < windowDays;
  const text = formatCount(value);
  /*
   * 列宽固定在 9%：7 位以上的数字会被省略号截断（CSS 见 `.ki-scope-table .ki-num`），
   * 这里只在**可能被截断**时把完整值放进 title；短数字不加 title，否则满屏 tooltip。
   */
  const title = [
    partial ? `仅覆盖 ${coveredDays} 天（该库首次被统计较晚）` : '',
    text.length >= 7 ? text : '',
  ].filter(Boolean).join(' · ') || undefined;
  return (
    <span className="ki-num" title={title}>
      {text}
    </span>
  );
}

/**
 * 可排序表头：同列切换升降序，换列重置为降序。
 *
 * ★ 不写内联 `textAlign` / `paddingLeft`：列的对齐与内缩一律交给 CSS
 *   （`.ki-scope-table` 的 nth-child 规则 —— 查询 / 写入 / 文档数三列左对齐，内缩 32px，
 *   是常规列 16px 的两倍）。
 *   内联样式优先级高于样式表，这里写死 left 会让那条规则永远失效。
 */
function SortTh({ label, sortKey, sort, onToggle }: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onToggle: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className={`ki-th-sort${active ? ' ki-th-sort--active' : ''}`}
        onClick={() => onToggle(sortKey)}
      >
        {label}
        {/* 未激活也显示双向箭头图标：可排序的列应始终可见可排，而不是"点过才知道能点" */}
        <span className="ki-th-sort__icon" aria-hidden="true">
          <Icon
            name={active ? (sort.dir === 'desc' ? 'sort-desc' : 'sort-asc') : 'sort'}
            className="ki-icon ki-th-sort__svg"
          />
        </span>
      </button>
    </th>
  );
}

/**
 * 运行态健康 5 项（对齐 demo）：数据目录 / MCP HTTP 服务 / 向量集合维度 / FTS 索引 / 后台任务队列。
 * 数据源：doctor 报告（数据目录、维度匹配）+ 前端实测 RTT + 任务接口。
 * 后端暂无数据源的项显式标「不可用」（横线 + 说明），不用示例数据顶替；
 * doctor 其余配置项收进下方折叠区，信息不丢。
 */
interface RuntimeItem {
  name: string;
  detail: string;
  tone: 'ok' | 'warn' | 'fail' | 'off';
}

function toneOfDoctor(status: string | undefined): RuntimeItem['tone'] {
  return status === 'pass' ? 'ok' : status === 'warn' ? 'warn' : status === 'fail' ? 'fail' : 'off';
}

function buildRuntimeItems(
  report: HealthReport | undefined,
  rttMs: number | null,
  taskState: { ready: boolean; running: number; queued: number },
  scopes: ScopeEntry[],
): RuntimeItem[] {
  const items = report?.items ?? [];
  const pick = (name: string): HealthItem | undefined => items.find((i) => i.name === name);

  const dataDir = pick('dataDir');
  const dim = pick('维度匹配');
  const key = pick('密钥有效性');

  return [
    {
      name: '数据目录可写',
      detail: dataDir?.detail ?? '后端未返回数据目录信息',
      tone: toneOfDoctor(dataDir?.status),
    },
    {
      name: 'MCP HTTP 服务',
      detail: rttMs != null ? `最近一次响应 ${rttMs} ms` : '尚未取得响应',
      tone: rttMs != null ? 'ok' : 'off',
    },
    {
      // REQ-20261016-002/D3：本项数据源是 doctor 三合一 probe —— 它比的是**上游 embedding API
      // 返回向量的长度 vs 配置维度**，从不打开集合。集合侧一致性由「当前知识库」卡片的
      // 「向量维度」角标承担（/api/vector/status 快照）。故此处只报结论、不再重复打印配置维度；
      // 也不再给 rebuild-vector 建议（上游维度不符时重建修不了这个因）。
      name: '嵌入服务维度',
      detail: dim
        ? dim.status === 'pass'
          ? '上游返回维度与当前配置一致'
          : `${dim.detail ?? ''}；请核对 embedding.model / embedding.dimension 是否匹配`
        : key?.detail ?? '后端未返回维度信息',
      tone: toneOfDoctor(dim?.status ?? key?.status),
    },
    ...(() => {
      // FTS 索引（scope 级）：ftsDocCount = 有 FTS 索引的文档数（含 dense+FTS 混合）；
      // 只看有文档的 scope（跳过测试残留的空 scope），名字超过 4 个折叠为「等 N 个」
      const active = scopes.filter((s) => (s.wikiCount ?? 0) > 0);
      const withFts = active.filter((s) => (s.ftsDocCount ?? 0) > 0).map((s) => s.scope);
      const without = active.filter((s) => (s.ftsDocCount ?? 0) === 0).map((s) => s.scope);
      const names = (list: string[]): string =>
        list.length <= 4 ? list.join('、') : `${list.slice(0, 4).join('、')} 等 ${list.length} 个`;
      const detail =
        active.length === 0
          ? '暂无有文档的 scope'
          : withFts.length > 0
            ? `${names(withFts)} 已建立 FTS 索引${without.length > 0 ? `；${names(without)} 未检测到` : ''}`
            : `${names(without)} 未检测到 FTS 索引`;
      return [{ name: 'FTS 索引', detail, tone: (withFts.length > 0 ? 'ok' : 'off') as RuntimeItem['tone'] }];
    })(),
    {
      name: '后台任务队列',
      detail: taskState.ready
        ? `${taskState.running} 个任务运行中，${taskState.queued > 0 ? `${taskState.queued} 个排队` : '无排队任务'}`
        : '任务接口未就绪（daemon 需升级）',
      tone: taskState.ready ? 'ok' : 'off',
    },
  ];
}

const RUNTIME_ICON: Record<RuntimeItem['tone'], string> = { ok: 'check', warn: 'warn', fail: 'x', off: 'dash' };

function RuntimeRow({ item }: { item: RuntimeItem }): JSX.Element {
  return (
    <div className="ki-health-item">
      <span className={`ki-health-item__icon ki-health-item__icon--${item.tone}`} aria-hidden="true">
        <Icon name={RUNTIME_ICON[item.tone]} className="ki-icon ki-icon--sm" />
      </span>
      <span>
        <span className="ki-health-item__name">{item.name}</span>
        <span className="ki-health-item__detail">{item.detail}</span>
      </span>
    </div>
  );
}

function HealthList({
  report,
  failure,
  wantSelfCheck,
  rttMs,
  taskState,
  scopes,
}: {
  report?: HealthReport;
  failure: HealthSummary;
  /** 由「服务健康明细」面板的「查看完整自检」跳转带入（URL `?selfcheck=1`） */
  wantSelfCheck: boolean;
  rttMs: number | null;
  taskState: { ready: boolean; running: number; queued: number };
  scopes: ScopeEntry[];
}): JSX.Element {
  const doctorItems = report?.items ?? [];
  const runtime = buildRuntimeItems(report, rttMs, taskState, scopes);
  const pass = runtime.filter((i) => i.tone === 'ok').length;
  const alerts = runtime.filter((i) => i.tone === 'warn' || i.tone === 'fail').length;
  // ★ R2（REQ-20261016-003）：角标口径对齐 doctor —— 取 /api/health 报告的 pass/warn/fail 原值。
  //   旧口径数的是「运行概览 5 行」，会出现「顶栏说有告警、卡片说 5 通过」的自相矛盾（已实测）。
  //   旧 daemon 不返回计数时回退既有口径（运行概览计数），不编造数字。
  const counts = failure.counts;
  const badgeText = counts
    ? `${counts.pass} 通过${counts.warn > 0 ? ` · ${counts.warn} 告警` : ''}${counts.fail > 0 ? ` · ${counts.fail} 失败` : ''}`
    : `${pass} 通过${alerts > 0 ? ` · ${alerts} 告警` : ''}`;
  const badgeTone = counts
    ? (counts.fail > 0 ? ' ki-badge--fail' : (counts.warn > 0 ? ' ki-badge--warn' : ''))
    : (alerts > 0 ? ' ki-badge--warn' : '');
  // ★ R4：doctor 中未被运行概览覆盖的异常项（概览区需给摘要入口，避免"卡片全绿"错觉）
  const uncovered = failure.issues.filter((i) => !RUNTIME_COVERED_DOCTOR_NAMES.has(i.name));
  // ★ R3：折叠区异常计数；有 fail（或从明细面板跳来）时默认展开，用户不必自己发现"里面有问题"
  const doctorIssues = doctorItems.filter((i) => i.status !== 'pass').length;
  const hasFail = doctorItems.some((i) => i.status === 'fail');
  const [selfCheckOpen, setSelfCheckOpen] = useState(wantSelfCheck);
  // ⚠️ `location.key` 必须在依赖里（challenger 2026-10-16 质疑 #3）：从明细面板**第二次**
  //    点「查看完整自检 →」时 URL 已是 `?selfcheck=1`（值未变）⇒ `wantSelfCheck` 不变 ⇒
  //    若用户此前手动关过折叠区，再点链接会"点了没反应"（死链感）。location.key 每次导航
  //    都会变，可稳定承载"这次点击的意图"。
  const locationKey = useLocation().key;
  useEffect(() => {
    // 只在"出现 fail / 带 selfcheck 跳转"时展开；用户手动关闭后不因无关重渲染强制重开
    if (wantSelfCheck || hasFail) setSelfCheckOpen(true);
  }, [wantSelfCheck, hasFail, locationKey]);
  return (
    <div className="ki-card">
      <div className="ki-card__head">
        <span className="ki-panel-heading">
          <span className="ki-panel-kicker">HEALTH</span>
          <span className="ki-card__title">健康检查</span>
        </span>
        <span className={`ki-badge${badgeTone}`}>{badgeText}</span>
      </div>
      {doctorItems.length === 0 ? (
        <div className="ki-card__body ki-card__body--flush">
          <div className="ki-empty" style={{ padding: 24 }}>
            <div>
              <h3>{failure.level === 'ok' ? '暂无健康数据' : failure.label}</h3>
              <p>{failure.detail || '服务健康检查未返回结果。'}</p>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="ki-card__body ki-card__body--flush">
            {runtime.map((item) => (
              <RuntimeRow key={item.name} item={item} />
            ))}
            {/* R4：概览 5 行未覆盖的 doctor 异常项，用一行摘要把人引到下方完整清单 */}
            {uncovered.length > 0 && (
              <RuntimeRow
                item={{
                  name: `另有 ${uncovered.length} 项配置自检异常`,
                  detail: `${uncovered.map((i) => i.name).join('、')} —— 原因见下方「配置自检」`,
                  tone: uncovered.some((i) => i.status === 'fail') ? 'fail' : 'warn',
                }}
              />
            )}
          </div>
          <details
            className="ki-health-config"
            open={selfCheckOpen}
            onToggle={(event) => setSelfCheckOpen((event.target as HTMLDetailsElement).open)}
          >
            <summary>
              配置自检（ki doctor · {doctorItems.length} 项
              {doctorIssues > 0 ? ` · ${doctorIssues} 项异常` : ''}）
            </summary>
            <div className="ki-card__body ki-card__body--flush">
              {doctorItems.map((item) => {
                const tone = HEALTH_ICON[item.status];
                return (
                  <div key={item.name} className="ki-health-item">
                    <span
                      className={`ki-health-item__icon ki-health-item__icon--${tone?.tone ?? 'fail'}`}
                      aria-hidden="true"
                    >
                      <Icon name={tone?.name ?? 'x'} className="ki-icon ki-icon--sm" />
                    </span>
                    <span>
                      <span className="ki-health-item__name">{item.name}</span>
                      <span className="ki-health-item__detail">{item.detail ?? item.message ?? ''}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const { can } = useAuth();
  const { data: scopes, isLoading, isError, error, refetch } = useScopeList();
  // 数据源（REQ-20261020-001 Q4）：总览第 4 卡由「注册」改为「数据源」数
  // viewer 没有 datasource.read：不请求（否则总览会稳定出现 403），卡片显示 —
  const { data: dsList, error: dsError } = useDataSourceList(can('datasource.read'));
  const { data: health, error: healthError, isPending: healthPending } = useHealth();
  const healthSummary = summarizeHealth(health, healthError, healthPending);
  const scope = useScopeValue();
  // 「服务健康明细」面板的「查看完整自检」以 `?selfcheck=1` 跳来（REQ-20261016-003 R1）
  const [searchParams] = useSearchParams();
  // 最近一次成功请求耗时（MCP HTTP 服务健康项）；任务接口未就绪时该行显示不可用
  const rttMs = getLastRttMs();
  const { data: tasks } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(20),
    retry: false,
    staleTime: 30_000,
  });
  const taskState = {
    ready: !!tasks,
    running: tasks?.tasks.filter((t) => t.state === 'running').length ?? 0,
    queued: tasks?.tasks.filter((t) => t.state === 'queued').length ?? 0,
  };

  const list = scopes?.scopes ?? [];

  /*
   * scope 表的排序 / 搜索 / 窗口（REQ-20261112-001 S-03）。
   *
   * 全部是前端状态：`ki_scope_list` 一次返回 d7/d30/d90 三档，切窗口不产生请求，
   * 也不会分裂 queryKey（全局 ScopeSelect 与总览共用 `['scopeList']` 缓存）。
   */
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(DEFAULT_SORT);

  const totalDocs = list.reduce((s, x) => s + (x.wikiCount ?? 0), 0);
  const kbCount = list.filter((x) => x.kb).length;
  const vecCount = list.filter((x) => x.vector).length;
  // 「视图」卡（2026-11-04）：视图数量，复用同一份 scopeList（0 新增请求）
  const viewCard = viewCountCard(scopes);
  // 定时同步（M1 2026-10-30）：已开启定时的数据源数，复用数据源列表、不新增请求
  const scheduleCard = scheduleSummaryView(
    summarizeSchedules(dsList, { error: dsError ? (dsError as Error).message : undefined }),
  );

  // 当前 scope 概览（切换 scope 时实时更新）
  const { data: scopeDocs } = useDocList(scope);
  const currentMeta = list.find((s) => s.scope === scope);
  // 计数取 `total`：doc/list 无 group 时上限 500，列表长度是截断值（`groups` 同理，
  // 但 2026-10-30 起总览不再展示分组数，该字段已无消费方）
  // 视图模式下 `/api/doc/list` 返回 buckets，`docs`/`total` 都在桶里 ——
  // 不归一的话概览会显示 0 篇（静默错数，比报错更难发现）
  const { docTotal: curDocTotal } = scopeOverviewCounts(normalizeDocData(scopeDocs));

  // 「显示注册 scope」卡片：数据全部来自同一份 scopeList（0 新增请求、0 后端改动）
  const scopeMode = normalizeScopeMode(scopes?.scopeMode);
  const registeredScopes = registeredScopesOf(list);

  // 主表行（搜索 + 排序 + 窗口都在纯函数里，便于单测）
  const scopeRows = useMemo(
    () => buildScopeRows(list, { keyword, windowDays, sortKey: sort.key, sortDir: sort.dir }),
    [list, keyword, windowDays, sort.key, sort.dir],
  );
  /*
   * 第二张表「显示注册 scope」：同一套列、同一排序与窗口，但**不跟随搜索**
   * （在主表搜 `bkmontest` 时不该把「已注册」表搜空 —— 它回答的是另一个问题）。
   * 注册 scope 通常只有几行，不缓存。
   */
  const registeredRows = buildScopeRows(registeredScopes, {
    keyword: '', windowDays, sortKey: sort.key, sortDir: sort.dir,
  });
  const toggleSort = (key: SortKey) => setSort((prev) => nextSort(prev, key));

  /*
   * 统计起始日提示（全局一次，不逐行标角标）。
   * 覆盖未满 90 天时，每个数字的「分母」都比窗口短 —— 这是全局事实，写在卡头最省噪。
   */
  const usageSince = list.find((s) => s.usage)?.usage?.since ?? null;
  const usageDays = usageSince ? daysSinceLocalDate(usageSince) : null;
  const sinceHint = usageDays !== null && usageDays < USAGE_FULL_WINDOW_DAYS
    ? ` · 统计自 ${usageSince} 起`
    : '';
  const vectorDegraded = scopes?.vectorAvailable === false;

  /**
   * 当前 scope 的向量维度状态（REQ-20261016-002）：与顶栏共用同一 queryKey ⇒ 复用缓存、
   * 不新增请求。面板里的模型名 / 维度都是**当前配置**的活读值（后端读路径从 config 取）。
   */
  const { data: dimensionData, error: dimensionError } = useVectorDimensionStatus(scope);
  const embeddingStatus = dimensionData?.status;
  const dimensionReady = Boolean(dimensionData) || Boolean(dimensionError);
  const dimBadge = dimensionBadge({
    state: embeddingStatus?.state,
    persisted: embeddingStatus?.persisted,
    hasError: Boolean(dimensionError),
    scope,
  });
  const modelTitle = embeddingIdentityTitle(embeddingStatus);

  // 六宫格「状态类」三格（2026-10-30）：判定与文案统一收在 lib/dashboardScopeCards.ts，
  // 页面只负责渲染 —— 读写/Wiki 的三态与四态判定不允许在这里就地拼装。
  /**
   * 视图是只读聚合，不是知识库 —— `currentMeta` 查不到（scope 列表已剔除视图），
   * 不特判会显示成「可写」，与事实相反。
   *
   * 判据用 `useIsViewName`（读 `ki_scope_list` 的 `views[]`）而不是嗅探
   * doc/list 响应的 `view` 字段：后者在接口未返回时是 undefined，会把视图误判成可写；
   * 且该响应可能来自缓存，与顶栏当前值不同步。
   */
  const isViewScope = useIsViewName(scope);
  /** 视图模式下卡头换口径（当前视图 / CURRENT VIEW），见 lib/dashboardScopeCards.ts */
  const heading = currentScopeHeading(isViewScope, scope);
  const readMode = readModeCard(scope, isViewScope ? true : currentMeta?.readonly, {
    isView: isViewScope,
  });
  const layers = layerColumns(currentMeta, vectorDegraded);
  const wikiCard = wikiWritebackCard(scope, currentMeta?.readonly, currentMeta?.wikiSync);

  return (
    <>
      <div className="ki-page-head">
        <div>
          <p>知识库全貌 · 服务状态 · 健康度</p>
        </div>
        <div className="ki-page-head__summary">
          <span>
            <strong>{list.length}</strong> 个知识库
          </span>
          <span>
            <strong>{totalDocs}</strong> 篇文档
          </span>
        </div>
      </div>

      <HealthBanner />

      {/* 统计条 */}
      <section className="ki-stats ki-stats--overview">
        <div className="ki-stat-card">
          <div className="ki-stat-label">Scopes</div>
          <div className="ki-stat-value ki-stat-value--primary">{list.length}</div>
          <div className="ki-stat-sub">KB {kbCount} · 向量 {vecCount}</div>
        </div>
        <div className="ki-stat-card">
          <div className="ki-stat-label">KB 文档</div>
          <div className="ki-stat-value">{totalDocs}</div>
        </div>
        <div className="ki-stat-card">
          <div className="ki-stat-label">向量层</div>
          <div className="ki-stat-value">{vecCount}</div>
        </div>
        <div className="ki-stat-card">
          <div className="ki-stat-label">数据源</div>
          <div className="ki-stat-value">{dsList ? dsList.total : '—'}</div>
        </div>
        <div className="ki-stat-card" title={scheduleCard.title}>
          <div className="ki-stat-label">定时同步</div>
          <div className="ki-stat-value">{scheduleCard.value}</div>
          {scheduleCard.sub !== '' && (
            <div className={`ki-stat-sub${scheduleCard.tone === 'warn' ? ' ki-stat-sub--warn' : ''}`}>
              {scheduleCard.sub}
            </div>
          )}
        </div>
        {/* 视图（2026-11-04，用户定稿：排在「定时同步」右边）：已定义的只读聚合个数；
            列表未就绪时显示 —，不冒充 0 */}
        <div className="ki-stat-card" title={viewCard.title}>
          <div className="ki-stat-label">视图</div>
          <div className="ki-stat-value">{viewCard.value}</div>
        </div>
      </section>

      {/* 双卡：当前知识库 ｜ 健康状态 */}
      <section className="ki-dash-grid">
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">{heading.kicker}</span>
              {/* scope 名与标题同一基线并排（用户 2026-10-30：「要和标题左右对齐，
                  不要在它的斜下方」）。不放 chip 底框 —— 底框会被读成另一个独立元素。 */}
              <span className="ki-card__title ki-card__title--scope">
                {heading.title}
                <span className="ki-scope-current" title={heading.scopeTitle}>
                  {scope}
                </span>
              </span>
            </span>
            {/* scope 名已上移到标题行，此处只留操作说明，不再重复一遍名字 */}
            <span className="ki-card__sub">{heading.switchHint}</span>
          </div>
          <div className="ki-card__body">
            <div className="ki-stats ki-stats--pair">
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">文档</div>
                <div className="ki-stat-value">{curDocTotal}</div>
              </div>
              {/* KB / RAG 合并为一格（2026-10-30 用户定稿）：原来两格各一个 ✓ 信息密度太低。
                  两列**必须各自可读**，不能压成一个总 ✓ —— `KB ✓ / RAG ✗` 是最需要被看见的坏状态。 */}
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-layers">
                  <div className={`ki-layers__item ki-layers__item--${layers.kb.tone}`} title={layers.kb.title}>
                    <span className="ki-layers__head">
                      <span className={`ki-layers__dot ki-layers__dot--${layers.kb.tone}`} aria-hidden="true" />
                      <span className="ki-layers__label">KB</span>
                    </span>
                    <span className="ki-layers__state">{layers.kb.label}</span>
                  </div>
                  <div className={`ki-layers__item ki-layers__item--${layers.rag.tone}`} title={layers.rag.title}>
                    <span className="ki-layers__head">
                      <span className={`ki-layers__dot ki-layers__dot--${layers.rag.tone}`} aria-hidden="true" />
                      <span className="ki-layers__label">RAG</span>
                    </span>
                    <span className="ki-layers__state">{layers.rag.label}</span>
                  </div>
                </div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">读写权限</div>
                <div
                  className={`ki-stat-value ki-stat-value--state${readMode.tone === 'warn' ? ' ki-stat-value--warn' : ''}${readMode.tone === 'muted' ? ' ki-stat-value--muted' : ''}`}
                  title={readMode.title}
                >
                  {readMode.label}
                </div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">Wiki 回写</div>
                <div
                  className={`ki-stat-value ki-stat-value--state${wikiCard.tone === 'warn' ? ' ki-stat-value--warn' : ''}${wikiCard.tone === 'muted' ? ' ki-stat-value--muted' : ''}`}
                  title={wikiCard.title}
                >
                  {wikiCard.label}
                </div>
              </div>
              {/* REQ-20261016-002：嵌入模型 / 向量维度（值来自 /api/vector/status，与顶栏同一份缓存） */}
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">嵌入模型</div>
                <div className="ki-stat-value ki-stat-value--text" title={modelTitle}>
                  {embeddingStatus?.model || '—'}
                </div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">向量维度</div>
                <div className="ki-stat-value">
                  {embeddingStatus?.configured ?? '—'}
                  {dimensionReady && (
                    <span className={`ki-badge ki-badge--${dimBadge.tone}`} title={dimBadge.title}>
                      {dimBadge.text}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <HealthList
          report={health?.report}
          failure={healthSummary}
          wantSelfCheck={searchParams.get('selfcheck') === '1'}
          rttMs={rttMs}
          taskState={taskState}
          scopes={list}
        />
      </section>

      {/* 显示注册 scope（全宽，与下方「知识库」列表同形态） */}
      <section>
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">REGISTERED SCOPES</span>
              <span className="ki-card__title">显示注册 scope</span>
            </span>
            <span className="ki-card__sub ki-reg-scope__meta">
              {vectorDegraded && (
                <span className="ki-reg-scope__degraded" title={scopes?.vectorReason || '向量层未枚举'}>
                  向量层未枚举
                </span>
              )}
              <span
                className={`ki-badge${scopeMode === 'strict' ? ' ki-badge--ok' : ''}`}
                title={
                  scopeMode === 'strict'
                    ? 'scopeMode: strict —— 只认配置中注册的 scope，未注册会直接报错'
                    : 'scopeMode: default —— 未注册的 scope 也能正常使用'
                }
              >
                {/* 数据未到时显示「—」：先显示 default / 0 会被读成"确实是这个值" */}
                scopeMode: {scopes ? scopeMode : '—'}
              </span>
              <span>{scopes ? `${registeredScopes.length} 个已注册` : '已注册数 —'}</span>
            </span>
          </div>
          {isError ? (
            // 失败必须显式报错：降级成"0 个注册"会被读成"没配过"
            <div className="ki-reg-scope__state" role="alert">
              <span>注册 scope 读取失败：{(error as Error)?.message || '未知错误'}</span>
              <button type="button" className="ki-btn ki-btn--small" onClick={() => void refetch()}>
                重试
              </button>
            </div>
          ) : isLoading ? (
            <div className="ki-card__body">
              <div className="ki-skeleton" style={{ width: '100%', height: 40, marginBottom: 8 }} />
              <div className="ki-skeleton" style={{ width: '90%', height: 40 }} />
            </div>
          ) : (
            <>
              {registeredScopes.length === 0 ? (
                <div className="ki-empty" style={{ border: 'none' }}>
                  <div>
                    <h3>配置里还没有注册任何 scope</h3>
                    <p>注册后可获得白名单护栏、独立 KB 目录与 Wiki 回写配置位。</p>
                  </div>
                </div>
              ) : (
                <table className="ki-table ki-reg-scope__table ki-scope-table ki-scope-table--reg">
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>层状态</th>
                      <th>冷热</th>
                      <th>查询</th>
                      <th>写入</th>
                      <th>文档数</th>
                      <th>Wiki 回写</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registeredRows.map((row) => {
                      // 文案唯一来源：与资源页同一函数（enabled ≠ 可回写）
                      const wiki = describeWikiSync(row.wikiSync ?? undefined);
                      return (
                        <tr key={row.scope}>
                          <td>
                            <div className="ki-scope-name">
                              <span className="ki-scope-name__dot ki-dot--blue" />
                              <span className="ki-reg-scope__name">
                                <span className="ki-scope-name__text">{row.scope}</span>
                                {row.scope === scope && <span className="ki-badge">当前</span>}
                                <span
                                  className={`ki-reg-scope__wiki-inline ki-reg-scope__wiki--${wiki.tone}`}
                                  title={wiki.title}
                                >
                                  Wiki 回写：{wiki.label}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="ki-badge-group">
                              {badgeCell(row.kb, 'KB', 'ki-badge--kb')}
                              {badgeCell(row.vector, 'RAG', 'ki-badge--vec')}
                              {readonlyBadge(row.scope, row.readonly)}
                            </div>
                          </td>
                          <td>
                            <HeatBadge row={row} windowDays={windowDays} />
                          </td>
                          <td>
                            <CountCell
                              value={row.usage ? row.usage.read : null}
                              coveredDays={row.coveredDays}
                              windowDays={windowDays}
                            />
                          </td>
                          <td>
                            <CountCell
                              value={row.usage ? row.usage.write : null}
                              coveredDays={row.coveredDays}
                              windowDays={windowDays}
                            />
                          </td>
                          <td>
                            <span className="ki-num">{formatCount(row.wikiCount)}</span>
                          </td>
                          <td>
                            <span
                              className={`ki-reg-scope__wiki ki-reg-scope__wiki--${wiki.tone}`}
                              title={wiki.title}
                            >
                              {wiki.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="ki-reg-scope__foot">
                <span>配置方式：</span>
                <Link to="/resources/scope">资源 › Wiki 回写 ↗</Link>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Scope 列表 */}
      <section>
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">SCOPES</span>
              <span className="ki-card__title">知识库</span>
            </span>
            <span className="ki-scope-tools">
              <input
                type="search"
                className="ki-scope-search"
                placeholder="搜索 scope"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                aria-label="搜索 scope"
              />
              <span className="ki-scope-seg" role="group" aria-label="统计窗口">
                {([7, 30, 90] as WindowDays[]).map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={`ki-scope-seg__btn${windowDays === days ? ' is-active' : ''}`}
                    aria-pressed={windowDays === days}
                    onClick={() => setWindowDays(days)}
                  >
                    近 {days} 天
                  </button>
                ))}
              </span>
              <span className="ki-card__sub" id="scopeMeta">
                {isLoading
                  ? '检测中…'
                  : `${scopeRows.length}/${list.length} 个 scope${sinceHint}`}
              </span>
            </span>
          </div>
          <div id="scopeList">
            {isLoading ? (
              <div className="ki-card__body">
                <div className="ki-skeleton" style={{ width: '100%', height: 40, marginBottom: 8 }} />
                <div className="ki-skeleton" style={{ width: '90%', height: 40 }} />
              </div>
            ) : list.length === 0 ? (
              <div className="ki-empty" style={{ border: 'none' }}>
                <div>
                  <h3>暂无知识库</h3>
                  <p>导入第一个知识库，开始沉淀你的文档。</p>
                  <div className="ki-empty__actions">
                    <a className="ki-btn ki-btn--primary ki-btn--small" href="#/import">
                      上传文档
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <table className="ki-table ki-scope-table ki-scope-table--main">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>层状态</th>
                    <SortTh label="冷热" sortKey="heat" sort={sort} onToggle={toggleSort} />
                    <SortTh label="查询" sortKey="query" sort={sort} onToggle={toggleSort} />
                    <SortTh label="写入" sortKey="write" sort={sort} onToggle={toggleSort} />
                    <SortTh label="文档数" sortKey="docs" sort={sort} onToggle={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {scopeRows.map((row) => (
                    <tr key={row.scope}>
                      <td>
                        <div className="ki-scope-name" title={row.scope}>
                          <span className="ki-scope-name__dot ki-dot--blue" />
                          <span>
                            <span className="ki-scope-name__text">{row.scope}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="ki-badge-group">
                          {badgeCell(row.kb, 'KB', 'ki-badge--kb')}
                          {badgeCell(row.vector, 'RAG', 'ki-badge--vec')}
                          {row.ftsOnlyDocCount > 0 && (
                            <span
                              className="ki-badge ki-badge--fts"
                              title="完整建立 FTS-only 索引的文档数（按文档计）"
                            >
                              FTS {row.ftsOnlyDocCount}
                            </span>
                          )}
                          {readonlyBadge(row.scope, row.readonly)}
                        </div>
                      </td>
                      <td>
                        <HeatBadge row={row} windowDays={windowDays} />
                      </td>
                      <td>
                        <CountCell
                          value={row.usage ? row.usage.read : null}
                          coveredDays={row.coveredDays}
                          windowDays={windowDays}
                        />
                      </td>
                      <td>
                        <CountCell
                          value={row.usage ? row.usage.write : null}
                          coveredDays={row.coveredDays}
                          windowDays={windowDays}
                        />
                      </td>
                      <td>
                        <span className="ki-num">{formatCount(row.wikiCount)}</span>
                      </td>
                    </tr>
                  ))}
                  {scopeRows.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        <span className="ki-cell-sub">没有匹配的 scope</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

export type { HealthItem };
