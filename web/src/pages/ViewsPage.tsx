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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icons';
import { kiScopeList, type ScopeInfo } from '@/api/mcpClient';
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

  /* ── 成员选择器状态 ── */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  /*
   * 点外部收起候选（对齐 demo 踩过的两个坑）：
   *   · 不能在 pointerdown 当场收起 —— 面板走常规流，收起会让下方「保存」上移，
   *     本次点击的 mouseup 落到按钮外，click 不触发（"点保存没反应"）。
   *   · 不能在 click 里用 contains 判断 —— 候选项是重新渲染的，target 可能已脱离文档。
   * 所以 pointerdown 只记录 inside，click 阶段才决定收起。
   */
  useEffect(() => {
    let inside = true;
    const onDown = (e: PointerEvent): void => {
      inside = Boolean(pickerRef.current?.contains(e.target as Node));
    };
    const onClick = (): void => {
      if (!inside) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

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
    setPickerFilter('');
    setPickerOpen(false);
  };
  const openEdit = (v: ViewEntry): void => {
    setDraft({ id: v.id, name: v.view, members: [...v.members], baseRevision: v.revision });
    setPickerFilter('');
    setPickerOpen(false);
  };

  const scopeMeta = useMemo(() => new Map(scopes.map((s) => [s.scope, s])), [scopes]);
  /** 候选 = 未选中的库，按输入过滤 */
  const candidates = useMemo(() => {
    const kw = pickerFilter.trim().toLowerCase();
    return scopes
      .filter((s) => !(draft?.members ?? []).includes(s.scope))
      .filter((s) => !kw || s.scope.toLowerCase().includes(kw))
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }, [scopes, draft?.members, pickerFilter]);

  const addMember = (name: string): void => {
    if (!draft || draft.members.includes(name)) return;
    setDraft({ ...draft, members: [...draft.members, name] });
    setPickerFilter('');
    setActiveIndex(0);
    setPickerOpen(true);
    pickerInputRef.current?.focus();
  };
  const removeMember = (name: string): void => {
    if (!draft) return;
    setDraft({ ...draft, members: draft.members.filter((m) => m !== name) });
    setActiveIndex(0);
  };

  const onPickerKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // 否则光标会在输入框里跳到首/尾
      if (!pickerOpen) {
        setPickerOpen(true);
        return;
      }
      if (candidates.length === 0) return;
      setActiveIndex((i) => (e.key === 'ArrowDown'
        ? (i + 1) % candidates.length
        : (i - 1 + candidates.length) % candidates.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = candidates[activeIndex] ?? candidates[0];
      if (target) addMember(target.scope);
      return;
    }
    if (e.key === 'Escape' && pickerOpen) {
      e.stopPropagation();
      setPickerOpen(false);
    }
  };

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

            <div className="views-picker" ref={pickerRef} style={{ maxWidth: 340 }}>
              <div className="views-picker__selected">
                {draft.members.length === 0 && <span className="views-hint">还没有选择知识库</span>}
                {draft.members.map((m) => {
                  const meta = scopeMeta.get(m);
                  const tip = meta?.readonly
                    ? '只读库：可作为检索成员，但不可写入'
                    : (meta && !meta.kb && !meta.vector ? '尚未导入文档，检索时会跳过' : `点击移除 ${m}`);
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`views-chip views-chip--pick${meta?.readonly ? ' views-chip--ro' : ''}`}
                      title={tip}
                      onClick={() => removeMember(m)}
                    >
                      {m}{meta?.readonly ? ' · 只读' : ''}
                      <span className="views-chip__x" aria-hidden="true">×</span>
                    </button>
                  );
                })}
              </div>

              <div className="views-picker__field">
                <Icon name="search" />
                <input
                  ref={pickerInputRef}
                  className="views-picker__input"
                  value={pickerFilter}
                  placeholder="搜索并添加知识库…"
                  aria-expanded={pickerOpen}
                  onFocus={() => setPickerOpen(true)}
                  onClick={() => { if (!pickerOpen) setPickerOpen(true); }}
                  onChange={(e) => {
                    setPickerFilter(e.target.value);
                    setPickerOpen(true);
                    setActiveIndex(0);
                  }}
                  onKeyDown={onPickerKeyDown}
                />
                <button
                  className="views-picker__toggle"
                  type="button"
                  aria-label={pickerOpen ? '收起候选' : '展开候选'}
                  tabIndex={-1}
                  onClick={() => {
                    // 收起时不要再 focus 输入框：focus 的语义是"展开"，会立刻弹回来
                    if (pickerOpen) {
                      setPickerOpen(false);
                      return;
                    }
                    setPickerOpen(true);
                    pickerInputRef.current?.focus();
                  }}
                >
                  ▾
                </button>
              </div>

              {pickerOpen && (
                <div className="views-picker__panel">
                  {/*
                   * 候选区与提示行**分开两层**：提示行固定在面板底部、不参与滚动。
                   * 之前把提示行放在滚动区里用 `position: sticky; bottom: 0` ——
                   * sticky 贴的是滚动容器的 padding edge，面板还有 5px padding，
                   * 滚动内容会从那 5px 里透出来（表现为"提示行下方漏出半行字"）。
                   */}
                  <div className="views-picker__scroll">
                    {candidates.length === 0 ? (
                      <div className="views-picker__note">
                        {draft.members.length === scopes.length
                          ? `已添加全部 ${scopes.length} 个知识库`
                          : `没有匹配「${pickerFilter}」的知识库`}
                      </div>
                    ) : (
                      candidates.map((s: ScopeInfo, i) => (
                        <button
                          key={s.scope}
                          type="button"
                          className={`views-picker__opt${i === activeIndex ? ' views-picker__opt--active' : ''}`}
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => addMember(s.scope)}
                        >
                          <span className="views-picker__opt-name">{s.scope}</span>
                          <span className="views-picker__opt-meta">
                            {!s.vector && <span className="views-tag views-tag--kbonly">仅全文</span>}
                            {s.readonly && <span className="views-tag views-tag--ro">只读</span>}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  {candidates.length > 0 && (
                    <div className="views-picker__hint">↑↓ 选择 · 回车添加 · Esc 收起 · 点已选项可移除</div>
                  )}
                </div>
              )}
            </div>

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
                    const tags: string[] = [];
                    const tips: string[] = [];
                    if (missing) {
                      tags.push('缺失');
                      tips.push('KB 与向量层都没有数据（库不可用），检索时会跳过');
                    } else {
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
                    const stateClass = missing
                      ? ' views-chip--missing'
                      : (empty ? ' views-chip--empty' : (meta?.readonly ? ' views-chip--ro' : ''));
                    /* 定时失败只在没有主状态色时叠加（否则会盖掉缺失/空/只读的语义） */
                    const failClass = stateClass === '' && meta?.scheduledFailed
                      ? ' views-chip--sched-failed'
                      : '';
                    return (
                      <span key={m} title={tips.join('；')} className={`views-chip${stateClass}${failClass}`}>
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
