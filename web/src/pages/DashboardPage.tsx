/**
 * DashboardPage.tsx —— 总览（对齐 demo：服务横幅 + 统计卡 + scope 表格 + 健康列表）
 */

import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { summarizeHealth, useHealth, useScopeList, useDocList, useVectorDimensionStatus, type HealthSummary, type ScopeEntry } from '@/lib/hooks';
import { dimensionBadge, embeddingIdentityTitle } from '@/lib/vectorDimensionCopy';
import { getLastRttMs } from '@/api/httpApi';
import { getTasks } from '@/api/tasksApi';
import { useScopeValue } from '@/lib/scopeContext';
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

function badgeCell(ok: boolean | undefined, label: string, cls: string): JSX.Element {
  return (
    <span className={`ki-badge ${ok ? cls : 'ki-badge--off'}`}>
      {ok ? label : '—'}
    </span>
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
  const { data: scopes, isLoading } = useScopeList();
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
  const totalDocs = list.reduce((s, x) => s + (x.wikiCount ?? 0), 0);
  const kbCount = list.filter((x) => x.kb).length;
  const vecCount = list.filter((x) => x.vector).length;

  // 当前 scope 概览（切换 scope 时实时更新）
  const { data: scopeDocs } = useDocList(scope);
  const currentMeta = list.find((s) => s.scope === scope);
  const curDocs = scopeDocs?.docs ?? [];
  const curGroups = new Set(curDocs.map((d) => d.group)).size;

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
      <section className="ki-stats">
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
          <div className="ki-stat-label">注册</div>
          <div className="ki-stat-value">{list.filter((x) => x.registered).length}</div>
        </div>
      </section>

      {/* 双卡：当前知识库 ｜ 健康状态 */}
      <section className="ki-dash-grid">
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">CURRENT SCOPE</span>
              <span className="ki-card__title">当前知识库</span>
            </span>
            <span className="ki-card__sub">
              顶栏切换 scope 即时刷新 · 当前：{scope}
            </span>
          </div>
          <div className="ki-card__body">
            <div className="ki-stats ki-stats--pair">
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">文档</div>
                <div className="ki-stat-value">{curDocs.length}</div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">分组</div>
                <div className="ki-stat-value">{curGroups}</div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">KB 层</div>
                <div className="ki-stat-value">
                  {currentMeta ? (currentMeta.kb ? '✓' : '✗') : '—'}
                </div>
              </div>
              <div className="ki-stat-card ki-stat-card--soft">
                <div className="ki-stat-label">向量层</div>
                <div className="ki-stat-value">
                  {currentMeta ? (currentMeta.vector ? '✓' : '✗') : '—'}
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

      {/* Scope 列表 */}
      <section>
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">SCOPES</span>
              <span className="ki-card__title">知识库</span>
            </span>
            <span className="ki-card__sub" id="scopeMeta">
              {isLoading ? '检测中…' : `${list.length} 个 scope`}
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
              <table className="ki-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>层状态</th>
                    <th style={{ textAlign: 'right' }}>文档数</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.scope}>
                      <td>
                        <div className="ki-scope-name">
                          <span className="ki-scope-name__dot ki-dot--blue" />
                          <span>
                            <span className="ki-scope-name__text">{s.scope}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="ki-badge-group">
                          {badgeCell(s.kb, 'KB', 'ki-badge--kb')}
                          {badgeCell(s.vector, 'RAG', 'ki-badge--vec')}
                          {s.ftsOnlyDocCount > 0 && (
                            <span
                              className="ki-badge ki-badge--fts"
                              title="完整建立 FTS-only 索引的文档数（按文档计）"
                            >
                              FTS {s.ftsOnlyDocCount}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="ki-num">{s.wikiCount ?? 0}</span>
                      </td>
                    </tr>
                  ))}
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
