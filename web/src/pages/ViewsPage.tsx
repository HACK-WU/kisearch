/**
 * ViewsPage.tsx —— 知识视图（REQ-20261104-004 / R-03、R-11、R-13）
 *
 * 页面职责：列视图（归属 / 创建时间 / 我的标识 / 行内影响面）→ 新建 / 编辑成员 / 改名 / 删除。
 *
 * 三条硬约束：
 *   1. `canEdit` / `mine` / `createdByName` / `impactCount` **一律用后端返回值**（§1.6），
 *      页面不比 userId、不自己算影响面、不自己翻显示名。
 *   2. 影响面在选成员时**实时**算（R-05 口径），保存前不弹二次确认（Q3 未采纳）。
 *   3. 删除确认框的遮罩**不关闭**，只能走「取消 / 删除」（对齐 2026-11-04 既有口径）。
 *
 * ★ 图标别传 `className` 覆盖 `ki-icon`：那样会丢掉 `fill:none; stroke:currentColor`
 *   等描边属性，图标会渲染成实心黑块（真机对比 demo 时发现）。尺寸/颜色在容器 CSS 里调。
 */

import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icons';
import { ScopeMultiPicker } from '@/components/ScopeMultiPicker';
import { kiScopeList } from '@/api/mcpClient';
import '@/styles/views.css';
import {
  createView,
  fetchImpact,
  fetchViews,
  patchView,
  removeView,
  type ViewEntry,
} from '@/api/viewsApi';

/** 列表只到「天」，完整时刻放 title（与后端 §4.1 口径一致） */
function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 归属行文案（对齐 demo）：
 *   自己的视图 → 只给日期（「我的」徽标已说明是谁建的）
 *   他人的视图 → 「由 X 创建 · 日期」；没有创建时间就只写创建者，**不显示 `· —`**
 *   旧视图无 createdBy → 「由 早期账号 创建」（不暴露 userId，也不假装知道是谁）
 */
function attributionOf(v: ViewEntry): string {
  const date = v.createdAt ? formatDate(v.createdAt) : '';
  if (v.mine) return date || '—';
  const owner = v.createdByName ?? '早期账号';
  return date ? `由 ${owner} 创建 · ${date}` : `由 ${owner} 创建`;
}

interface Draft {
  id: string | null;
  name: string;
  members: string[];
  baseRevision: number;
}

export function ViewsPage(): JSX.Element {
  const qc = useQueryClient();
  const { data: views = [], isLoading, error } = useQuery({ queryKey: ['views'], queryFn: fetchViews });
  const { data: scopes = [] } = useQuery({
    queryKey: ['views-scopes'],
    queryFn: async () => (await kiScopeList()).scopes ?? [],
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ViewEntry | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);


  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  const impact = useQuery({
    queryKey: ['views-impact', draft?.members ?? [], draft?.id ?? ''],
    queryFn: () => fetchImpact(draft?.members ?? [], draft?.id ?? undefined),
    enabled: Boolean(draft) && (draft?.members.length ?? 0) > 0,
  });

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) => {
      const name = d.name.trim();
      if (d.id === null) return createView(name, d.members);
      return patchView(d.id, { name, members: d.members, baseRevision: d.baseRevision });
    },
    onSuccess: (view) => {
      setDraft(null);
      setToast({ text: `已保存「${view.view}」`, kind: 'ok' });
      void qc.invalidateQueries({ queryKey: ['views'] });
    },
    onError: (err: Error) => setToast({ text: err.message, kind: 'err' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (view: ViewEntry) => removeView(view.id),
    onSuccess: () => {
      setDeleteTarget(null);
      setToast({ text: '已删除', kind: 'ok' });
      void qc.invalidateQueries({ queryKey: ['views'] });
    },
    onError: (err: Error) => setToast({ text: err.message, kind: 'err' }),
  });

  const openNew = (): void => {
    setDraft({ id: null, name: '', members: [], baseRevision: 0 });
  };
  const openEdit = (v: ViewEntry): void => {
    setDraft({ id: v.id, name: v.view, members: [...v.members], baseRevision: v.revision });
  };

  const scopeMeta = useMemo(() => new Map(scopes.map((s) => [s.scope, s])), [scopes]);
  /*
   * 维度状态按 scope 聚合：编辑表单已选 chip 与候选面板都要能看到
   * 「这个库会被语义检索跳过」，否则列表页看得到、选人时看不到。
   * 数据源只取 /api/views 的 memberMeta（与列表同一个后端口径），不再扩展
   * ki_scope_list 的 scopes[] —— 避免同一事实两处产出。
   * ★ 同一 scope 出现在多个视图时以 mismatch 为准（宁可多提示，不可漏）。
   * ⚠ 没出现在任何视图里的库没有状态：按「未确认」处理，不标、也不当成正常。
   */
  const dimensionByScope = useMemo(() => {
    const map = new Map<string, 'ok' | 'mismatch' | 'unknown'>();
    for (const v of views) {
      for (const meta of v.memberMeta) {
        if (meta.dimensionState === 'mismatch') map.set(meta.scope, 'mismatch');
        else if (meta.dimensionState && !map.has(meta.scope)) map.set(meta.scope, meta.dimensionState);
      }
    }
    return map;
  }, [views]);
  const readonlySelected = draft
    ? draft.members.filter((m) => scopeMeta.get(m)?.readonly).length
    : 0;

  return (
    <div className="views-page">
      <div className="views-head">
        <p className="views-head__sub">团队共享 · 一个名字检索多个知识库；成员库里的文档不会被复制</p>
        <button className="views-btn views-btn--primary" type="button" onClick={openNew}>+ 新建视图</button>
      </div>

      {draft && (
        <div className="views-card views-form">
          <div className="views-form__head">
            <span className="views-form__title">{draft.id ? '编辑视图' : '新建视图'}</span>
            <span className="views-form__sub">
              {draft.id ? '改名不会影响已授权的 Token' : '保存后团队成员即可在顶栏选到它'}
            </span>
          </div>

          <div className="views-form__row">
            <label className="views-label" htmlFor="views-name">名称</label>
            <input
              id="views-name"
              className="views-input"
              value={draft.name}
              maxLength={40}
              placeholder="例如：团队研发"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <p className="views-hint">支持中文与英文；不能含空格、逗号、斜杠；不能与已有知识库重名</p>
          </div>

          <div className="views-form__row">
            <span className="views-label">
              包含哪些知识库<span className="views-label__sub">只列出你可访问的</span>
            </span>

            <ScopeMultiPicker
              scopes={scopes}
              value={draft.members}
              /* 函数式更新：连点两个候选时不会用渲染时的旧 draft 覆盖前一次添加 */
              onChange={(next) => setDraft((prev) => (prev ? { ...prev, members: next } : prev))}
              emptyHint="还没有选择知识库"
              placeholder="搜索并添加知识库…"
              chipLabel={(m) => {
                const meta = scopeMeta.get(m);
                const dimMismatch = dimensionByScope.get(m) === 'mismatch';
                const dimUnknown = dimensionByScope.get(m) === 'unknown';
                return `${m}${dimMismatch ? ' · 维度不一致' : ''}${dimUnknown ? ' · 维度未确认' : ''}${meta?.readonly ? ' · 只读' : ''}`;
              }}
              /* 配色优先级：维度不一致 > 只读（与列表行 chips 同口径） */
              chipClassName={(m) => (dimensionByScope.get(m) === 'mismatch'
                ? ' sp-chip--dim-mismatch'
                : (scopeMeta.get(m)?.readonly ? ' sp-chip--ro' : ''))}
              chipTitle={(m) => {
                const meta = scopeMeta.get(m);
                const dimMismatch = dimensionByScope.get(m) === 'mismatch';
                const dimUnknown = dimensionByScope.get(m) === 'unknown';
                return dimMismatch
                  ? `语义检索会直接跳过该库（向量集合维度与当前配置不一致）；修复：ki restore ${m} --rebuild-vector --yes。依据上次维度检查，若已重建请重新检查`
                  : (dimUnknown
                    ? '没有可用的维度检查快照，不能断定该库维度正常；导入 / 重建或刷新维度检查后可确认'
                    : (meta?.readonly
                      ? '只读库：可作为检索成员，但不可写入'
                      : (meta && !meta.kb && !meta.vector ? '尚未导入文档，检索时会跳过' : `点击移除 ${m}`)));
              }}
              optionMeta={(s) => (
                <>
                  {dimensionByScope.get(s.scope) === 'mismatch' && (
                    <span
                      className="sp-tag sp-tag--dim-mismatch"
                      title="语义检索会直接跳过该库：向量集合维度与当前配置不一致（依据上次维度检查，若已重建请重新检查）"
                    >维度不一致</span>
                  )}
                  {!s.vector && <span className="sp-tag">仅全文</span>}
                  {s.readonly && <span className="sp-tag sp-tag--ro">只读</span>}
                </>
              )}
            />

            <p className="views-hint">至少要选择一个知识库</p>
          </div>

          {impact.data && impact.data.length > 0 && (
            <div className="views-impact">
              <div className="views-impact__head">⚠ 保存后 {impact.data.length} 个 Token 将看不到这个视图</div>
              <ul className="views-impact__list">
                {impact.data.map((t) => (
                  <li key={t.id}>{t.label ?? '(未命名)'} <span className="views-mono">{t.id}</span></li>
                ))}
              </ul>
            </div>
          )}

          <div className="views-form__foot">
            <span className="views-form__note">
              {draft.members.length} 个库 · 已选 {readonlySelected} 个只读库
            </span>
            <button className="views-btn" type="button" onClick={() => setDraft(null)}>取消</button>
            <button
              className="views-btn views-btn--primary"
              type="button"
              disabled={!draft.name.trim() || draft.members.length === 0 || saveMutation.isPending}
              onClick={() => saveMutation.mutate(draft)}
            >
              {draft.id ? '保存' : '创建视图'}
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="views-empty">正在加载…</div>}
      {error && <div className="views-empty">加载失败：{(error as Error).message}</div>}

      {!isLoading && !error && views.length === 0 && !draft && (
        <div className="views-card views-empty">
          <Icon name="layers" />
          <div className="views-empty__title">还没有知识视图</div>
          <p className="views-empty__desc">把常用的几个知识库组合成一个视图，<br />检索时用这一个名字就够了。</p>
          <button className="views-btn views-btn--primary" type="button" onClick={openNew}>+ 新建视图</button>
          <p className="views-empty__note">视图是团队共享的：同事的 Token 拥有全部成员权限即可使用</p>
        </div>
      )}

      {views.length > 0 && (
        <div className="views-card">
          {views.map((v) => (
            <div className="views-row" key={v.id}>
              <div className="views-row__main">
                <div className="views-row__title">
                  <Icon name="layers" />
                  <span className="views-row__name">{v.view}</span>
                  <span className="views-badge">{v.members.length} 个库</span>
                  {v.mine && <span className="views-badge views-badge--mine">我的</span>}
                  <span className="views-row__meta" title={`创建于 ${formatDateTime(v.createdAt) || '未知'}`}>
                    {attributionOf(v)}
                  </span>
                </div>
                <div className="views-chips">
                  {v.members.map((m) => {
                    const meta = v.memberMeta.find((x) => x.scope === m);
                    const missing = v.missing.includes(m);
                    /*
                     * 三种成员状态必须分开标（优先级：缺失 > 空 > 只读）：
                     *  · 缺失 = KB 与向量层都没有数据（库不可用）
                     *  · 空   = 库在、但 0 篇文档（还没导入）—— 与"缺失"长得一样时
                     *           用户根本分不清是"还没导入"还是"库没了"
                     *  · 只读 = 只读库（可作为检索成员，但不可写入）
                     */
                    /*
                     * 标记分两类：
                     *  · 状态（互斥）：缺失（库不可用）/ 空（0 篇）—— 有其一就不再标属性
                     *  · 属性（可叠加）：只读 / 只全文 / 定时
                     * 「只全文」在空库上不标（空库连检索方式都谈不上）。
                     */
                    const empty = !missing && meta?.docCount === 0;
                    const onlyFullText = !missing && !empty && meta?.kb === true && meta?.vector === false;
                    /*
                     * 维度不一致（已确认）：默认 hybrid 检索里该库会被整库跳过
                     * （onScopeError → return []），其余成员照常出结果。
                     * 只在「已确认」时标；unknown 不标、也不当成正常，由行内
                     * 「N 个库维度状态未确认」另行兜底（方案 A 的诚实性要求）。
                     */
                    const dimMismatch = !missing && meta?.dimensionState === 'mismatch';
                    const dimUnknown = !missing && meta?.dimensionState === 'unknown';
                    const tags: string[] = [];
                    const tips: string[] = [];
                    if (missing) {
                      tags.push('缺失');
                      tips.push('KB 与向量层都没有数据（库不可用），检索时会跳过');
                    } else {
                      if (dimMismatch) {
                        tags.push('维度不一致');
                        tips.push(`语义检索会直接跳过该库（向量集合维度与当前配置不一致），其余可用的库照常出结果；修复：ki restore ${m} --rebuild-vector --yes。依据上次维度检查，若已重建请重新检查`);
                      }
                      if (dimUnknown) {
                        /*
                         * 三态必须逐个可见：只给行级「N 个未确认」时用户看不出是哪个库。
                         * `ok` 的库保持无标记，避免 12 个 chip 全部变长。
                         */
                        tags.push('维度未确认');
                        tips.push('没有可用的维度检查快照，不能断定该库维度正常；导入 / 重建或刷新维度检查后可确认');
                      }
                      if (empty) {
                        tags.push('空');
                        tips.push('该库还没有任何文档，检索时会跳过');
                      }
                      if (meta?.readonly) {
                        tags.push('只读');
                        tips.push('只读库：可作为检索成员，但不可写入');
                      }
                      if (onlyFullText) {
                        tags.push('只全文');
                        tips.push('仅有全文索引（无向量）：语义检索不覆盖该库，关键词检索仍可用');
                      }
                      if (meta?.scheduled) {
                        /*
                         * 失败态必须写出来：只显示「定时」会让一直跑挂的源看起来仍是最新的，
                         * 用户不会去查。
                         */
                        tags.push(meta.scheduledFailed ? '定时（上次失败）' : '定时');
                        tips.push(meta.scheduledFailed
                          ? '定时同步已开启，但最近一次自动执行失败：该库可能不是最新'
                          : '配了定时同步：会按计划自动更新');
                      }
                    }
                    const suffix = tags.length > 0 ? ` · ${tags.join(' · ')}` : '';
                    /* 配色优先级：缺失 > 维度不一致 > 空 > 只读（维度不一致要压过只读/空） */
                    const stateClass = missing
                      ? ' views-chip--missing'
                      : (dimMismatch ? ' views-chip--dim-mismatch'
                        : (empty ? ' views-chip--empty' : (meta?.readonly ? ' views-chip--ro' : '')));
                    /* 定时失败只在没有主状态色时叠加（否则会盖掉缺失/空/只读的语义） */
                    const failClass = stateClass === '' && meta?.scheduledFailed
                      ? ' views-chip--sched-failed'
                      : '';
                    /*
                     * 维度未确认是**最低优先级**的中性虚线：只在既无主状态色、
                     * 也无定时失败虚线时叠加，避免两套虚线打架。文字后缀不受此限，
                     * 即使 chip 已有「空」「只读」的底色也照样显示。
                     */
                    const unknownClass = stateClass === '' && failClass === '' && dimUnknown
                      ? ' views-chip--dim-unknown'
                      : '';
                    return (
                      <span key={m} title={tips.join('；')} className={`views-chip${stateClass}${failClass}${unknownClass}`}>
                        {m}{suffix}
                      </span>
                    );
                  })}
                </div>
                {(v.impactCount ?? 0) > 0 ? (
                  <div className="views-row__warn">
                    <span aria-hidden="true">⚠</span>
                    <span>{v.impactCount} 个 Token 缺少部分成员授权，看不到此视图</span>
                  </div>
                ) : (
                  <div className="views-row__warn views-row__warn--ok">
                    <span aria-hidden="true">✓</span>
                    <span>全部已授权 Token 都能看到此视图</span>
                  </div>
                )}
                {/*
                 * 方案 A 的诚实性兜底：三态都要可见。
                 * chip 上的「· 维度未确认」负责逐个定位；这里再给汇总 + 名单
                 * （正文只列前 3 个，hover 看全量），避免只有一个数字时用户仍
                 * 不知道是哪几个库没检查过。
                 */}
                {(() => {
                  const names = v.memberMeta
                    .filter((x) => x.dimensionState === 'unknown')
                    .map((x) => x.scope);
                  if (names.length === 0) return null;
                  return (
                    <div
                      className="views-row__warn views-row__warn--dim"
                      title={`维度未确认的库：${names.join('、')}`}
                    >
                      <span aria-hidden="true">?</span>
                      <span>
                        {names.length} 个库维度未确认：{names.slice(0, 3).join('、')}
                        {names.length > 3 ? ` 等 ${names.length} 个` : ''}
                        （hover 看全部；chip 上标「· 维度未确认」）
                      </span>
                    </div>
                  );
                })()}
              </div>
              <div className="views-row__side">
                <button
                  className="views-btn"
                  type="button"
                  disabled={!v.canEdit}
                  title={v.canEdit ? '' : '仅创建者或管理员可修改该视图'}
                  onClick={() => openEdit(v)}
                >
                  编辑
                </button>
                <button
                  className="views-btn views-btn--danger"
                  type="button"
                  disabled={!v.canEdit}
                  title={v.canEdit ? '' : '仅创建者或管理员可修改该视图'}
                  onClick={() => setDeleteTarget(v)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <div className="views-modal-backdrop">
          <div className="views-modal" role="dialog" aria-modal="true" aria-labelledby="views-del-title">
            <div className="views-modal__title" id="views-del-title">删除视图「{deleteTarget.view}」？</div>
            <p className="views-modal__body">只删除这个组合，<b>不会删除任何知识库及其文档</b>。</p>
            <div className="views-modal__foot">
              <button className="views-btn" type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                className="views-btn views-btn--primary views-btn--danger-solid"
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deleteTarget)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`views-toast${toast.kind === 'err' ? ' views-toast--err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
