/**
 * DashboardPage.tsx —— 总览（对齐 demo：服务横幅 + 统计卡 + scope 表格 + 健康列表）
 */

import { useHealth, useScopeList, useDocList } from '@/lib/hooks';
import { useScopeValue } from '@/lib/scopeContext';
import { HealthBanner } from '@/components/HealthBanner';
import type { HealthReport, HealthItem } from '@/api/httpApi';

const HEALTH_ICON: Record<string, string> = { pass: '✅', warn: '⚠️', fail: '❌' };

function badgeCell(ok: boolean | undefined, label: string, cls: string): JSX.Element {
  return (
    <span className={`ki-badge ${ok ? cls : 'ki-badge--off'}`}>
      {ok ? label : '—'}
    </span>
  );
}

function HealthList({ report }: { report?: HealthReport }): JSX.Element {
  const items = report?.items ?? [];
  const pass = items.filter((i) => i.status === 'pass').length;
  const warn = items.filter((i) => i.status === 'warn').length;
  const fail = items.filter((i) => i.status === 'fail').length;
  return (
    <div className="ki-card">
      <div className="ki-card__head">
        <span className="ki-card__title">健康状态</span>
        <span className="ki-health-summary">
          <span>
            <b style={{ color: 'var(--ki-color-success)' }}>{pass}</b> 通过
          </span>
          {warn > 0 && (
            <span>
              <b style={{ color: 'var(--ki-color-warning)' }}>{warn}</b> 警告
            </span>
          )}
          {fail > 0 && (
            <span>
              <b style={{ color: 'var(--ki-color-danger)' }}>{fail}</b> 失败
            </span>
          )}
        </span>
      </div>
      <div className="ki-card__body" style={{ paddingTop: 8 }}>
        {items.length === 0 ? (
          <div className="ki-empty" style={{ padding: 24 }}>
            <div>
              <h3>暂无健康数据</h3>
              <p>服务健康检查未返回结果。</p>
            </div>
          </div>
        ) : (
          items.map((item) => (
            <div key={item.name} className="ki-health-item">
              <span className="ki-health-item__icon">{HEALTH_ICON[item.status] ?? '❔'}</span>
              <span className="ki-health-item__name">{item.name}</span>
              <span className="ki-health-item__detail">{item.detail ?? item.message ?? ''}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const { data: scopes, isLoading } = useScopeList();
  const { data: health } = useHealth();
  const scope = useScopeValue();

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
          <h1>总览</h1>
          <p>知识库全貌 · 服务状态 · 健康度</p>
        </div>
      </div>

      <HealthBanner />

      {/* 统计卡 */}
      <section>
        <div className="ki-stats">
          <div className="ki-stat-card">
            <div className="ki-stat-label">Scopes</div>
            <div className="ki-stat-value ki-stat-value--primary">{list.length}</div>
            <div className="ki-stat-sub" style={{ marginTop: 6 }}>
              KB {kbCount} · 向量 {vecCount}
            </div>
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
        </div>
      </section>

      {/* 当前 scope 概览 */}
      <section>
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-card__title">当前知识库</span>
            <span className="ki-card__sub">
              顶栏切换 scope 即时刷新 · 当前：{scope}
            </span>
          </div>
          <div className="ki-card__body">
            <div className="ki-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              <div className="ki-stat-card">
                <div className="ki-stat-label">文档数</div>
                <div className="ki-stat-value">{curDocs.length}</div>
              </div>
              <div className="ki-stat-card">
                <div className="ki-stat-label">Groups</div>
                <div className="ki-stat-value">{curGroups}</div>
              </div>
              <div className="ki-stat-card">
                <div className="ki-stat-label">KB 层</div>
                <div className="ki-stat-value">
                  {currentMeta ? (currentMeta.kb ? '✓' : '✗') : '—'}
                </div>
              </div>
              <div className="ki-stat-card">
                <div className="ki-stat-label">向量层</div>
                <div className="ki-stat-value">
                  {currentMeta ? (currentMeta.vector ? '✓' : '✗') : '—'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Scope 列表 */}
      <section>
        <div className="ki-card">
          <div className="ki-card__head">
            <span className="ki-card__title">知识库（Scopes）</span>
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

      {/* 健康状态 */}
      <HealthList report={health?.report} />
    </>
  );
}

export type { HealthItem };
