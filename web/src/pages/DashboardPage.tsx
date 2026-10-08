/**
 * DashboardPage.tsx —— 总览（对齐 demo：服务横幅 + 统计卡 + scope 表格 + 健康列表）
 */

import { useQuery } from '@tanstack/react-query';
import { summarizeHealth, useHealth, useScopeList, useDocList, type HealthSummary, type ScopeEntry } from '@/lib/hooks';
import { getLastRttMs } from '@/api/httpApi';
import { getTasks } from '@/api/tasksApi';
import { useScopeValue } from '@/lib/scopeContext';
import { HealthBanner } from '@/components/HealthBanner';
import { Icon } from '@/components/icons';
import type { HealthReport, HealthItem } from '@/api/httpApi';

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
  const dimConfig = /config=(\d+)/.exec(dim?.detail ?? '')?.[1];

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
      name: '向量集合维度',
      detail: dim
        ? dim.status === 'pass'
          ? `当前 embedding ${dimConfig ?? '—'} 维，集合维度一致`
          : `${dim.detail ?? ''}；需执行 ki restore <scope> --rebuild-vector --yes`
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
  rttMs,
  taskState,
  scopes,
}: {
  report?: HealthReport;
  failure: HealthSummary;
  rttMs: number | null;
  taskState: { ready: boolean; running: number; queued: number };
  scopes: ScopeEntry[];
}): JSX.Element {
  const doctorItems = report?.items ?? [];
  const runtime = buildRuntimeItems(report, rttMs, taskState, scopes);
  const pass = runtime.filter((i) => i.tone === 'ok').length;
  const alerts = runtime.filter((i) => i.tone === 'warn' || i.tone === 'fail').length;
  return (
    <div className="ki-card">
      <div className="ki-card__head">
        <span className="ki-panel-heading">
          <span className="ki-panel-kicker">HEALTH</span>
          <span className="ki-card__title">健康检查</span>
        </span>
        <span className={`ki-badge${alerts > 0 ? ' ki-badge--warn' : ''}`}>
          {pass} 通过{alerts > 0 ? ` · ${alerts} 告警` : ''}
        </span>
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
          </div>
          <details className="ki-health-config">
            <summary>配置自检（ki doctor · {doctorItems.length} 项）</summary>
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
            </div>
          </div>
        </div>
        <HealthList
          report={health?.report}
          failure={healthSummary}
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
