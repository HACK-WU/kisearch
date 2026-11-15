/**
 * 事件页（REQ-20261113-004 · S-07）
 *
 * 界面以 demo 的事件页为基线：**左侧事件列表 + 右侧详情**，详情含
 * 事件头（编号 / 类型 / 当前阶段 / 关联与参考篇数 / 操作）、阶段线（可点）、
 * 可见性提示条、关联文档、参考文档（AI 查找 / 添加）、AI 同源操作代码块。
 *
 * 与 demo 的三处差异：
 *   · 「AI 分析」是独立的仓库代码定位入口（`AiAnalyzeModal`），与知识库检索无关；
 *   · 参考文档的「AI 查找」走**确定性检索**（不调 LLM），候选带分数与原因，由人勾选确认；
 *   · 点文档名开的是全站阅读器 `ModuleDrawer`（70vw 抽屉，带大纲/文档内查找/全屏），
 *     不是 demo 里 560px + 遮罩的只读弹窗 —— 这是 S-07 §3.3「直接复用 ModuleDrawer」的结果。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '@/styles/governance.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import { aiSettingsHref } from '@/lib/aiSettingsUrl';
import { FindRefModal } from '@/components/governance/FindRefModal';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { getDocContent } from '@/api/httpApi';
import {
  addRefs, createEvent, deleteEvent, getEventDetail, getGovernanceCounts, listEventTypes, listEvents, listRefs, removeRef,
  reopenEvent, searchRefDocs, setEventStage, updateEventType,
  GovernanceApiError,
  type EventDetail, type EventTypeView, type EventView, type RefItem, type StagePatch,
  type Visibility,
} from '@/api/governanceApi';

type Status = 'open' | 'closed' | 'all';
type Tab = 'list' | 'types';

const VIS_TEXT: Record<string, string> = {
  full: '语义+全文',
  'fts-only': '仅全文',
  hidden: '不可检索',
};

/** 可见性档位 → demo 的圆点形状（实心 / 半环 / 空心） */
const VIS_CLASS: Record<Visibility, string> = { full: 'full', 'fts-only': 'fts', hidden: 'hidden' };


/** 类型徽标配色（demo：bug 墨绿 / 性能 蓝 / 需求 紫） */
function typeBadgeClass(name: string): string {
  if (name.includes('bug')) return 'gov-badge gov-badge--bug';
  if (name.includes('性能')) return 'gov-badge gov-badge--perf';
  if (name.includes('需求')) return 'gov-badge gov-badge--req';
  return 'gov-badge gov-badge--kb';
}

/** 列表第二行时间（demo 是「2 小时前 / 1 天前」） */
function relTime(ms?: number | null): string {
  if (!ms) return '—';
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

export function EventsPage(): JSX.Element {
  // 跟顶部 scope 选择器走：治理数据本身按 scope 隔离，写死 'default' 会让页头徽标撒谎、
  // 也让「添加参考文档」去错库里搜（同一台机器上事件与文档可能不在同一 scope）
  const scope = useScopeValue();
  const [tab, setTab] = useState<Tab>('list');
  const [status, setStatus] = useState<Status>('open');
  const [keyword, setKeyword] = useState('');
  const [events, setEvents] = useState<EventView[]>([]);
  const [types, setTypes] = useState<EventTypeView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  /** 页头计数（与侧栏同源 `/governance/counts`）：列表被 status 过滤后自带数量会失真 */
  const [counts, setCounts] = useState<{ open: number; closed: number } | null>(null);
  const [addStageOpen, setAddStageOpen] = useState(false);
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [newTypeOpen, setNewTypeOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [transOpen, setTransOpen] = useState(false);
  /** 「删除事件」两步确认（会清空阶段日志，不可恢复） */
  const [delConfirm, setDelConfirm] = useState(false);
  const [addRefOpen, setAddRefOpen] = useState(false);
  /** 「AI 查找」弹窗：打开即请求候选，不再一点就自动加入（R28/R29） */
  const [findRefOpen, setFindRefOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  /**
   * 点开正文的文档（关联文档 / 参考文档）。null = 未打开。
   * 复用浏览页的 `ModuleDrawer`（抽屉态，S-07 §3.3「文档抽屉直接复用 ModuleDrawer」），
   * 不新造一个只读弹窗 —— 用户在这里看到的阅读器与浏览页一致（大纲 / 文档内查找 / 全屏）。
   */
  const [docTarget, setDocTarget] = useState<{ group: string; name: string } | null>(null);

  /**
   * 切 scope / 换事件时收起正文抽屉：`ModuleDrawer` 一旦载入正文就不再重取
   * （`if (content !== null) return`），留着会把上一个库 / 上一个事件的正文继续挂着，
   * 而抽屉头部已换成新 scope —— 静默串库比直接收起更糟。
   */
  useEffect(() => { setDocTarget(null); }, [scope, activeId]);

  // 页面只判 capability，不判 role（authContext 的约定）
  const { can, status: authStatus } = useAuth();
  const canWrite = can('knowledge.write');

  /**
   * 就近深链（2026-11-15）：从「AI 分析 / AI 查找」弹窗直达 AI 设置的对应分组。
   * 任务现场调提示词不必再绕到顶栏 —— 这是本需求的 R7。
   */
  const navigate = useNavigate();
  const openAiSettings = useCallback((cap: 'analysis' | 'find'): void => {
    // 路径与 `from` 口径统一在 lib/aiSettingsUrl（与顶栏 toggle 共用同一份白名单）
    navigate(aiSettingsHref({ cap, from: `${window.location.pathname}${window.location.search}` }));
  }, [navigate]);
  /**
   * R34 / S-07 §3.4：只读账号可进页面、可看全部信息，写入口统一禁用并在 title 说明原因。
   * 前端禁用只是体验层，后端 `knowledge.write` 仍会 403 兜底。
   * 「AI 查找」不在此列 —— 检索是读，只有弹窗里的「加入」需要写（由弹窗自己门禁）。
   */
  const readOnlyHint = canWrite ? undefined : '需要写权限';
  // 鉴权加载中（permissions 暂空）只禁用、不弹"只读"横幅，避免进页闪一下
  const showReadOnlyHint = !canWrite && authStatus !== 'loading';

  const loadList = useCallback(async () => {
    try {
      const [list, typeList, govCounts] = await Promise.all([
        listEvents(scope, { status, ...(typeFilter ? { type: typeFilter } : {}), ...(keyword ? { q: keyword } : {}), limit: 100 }),
        listEventTypes(scope),
        getGovernanceCounts(scope).catch(() => null),
      ]);
      setEvents(list.events);
      setTypes(typeList.types);
      if (govCounts) setCounts({ open: govCounts.eventsOpen, closed: govCounts.eventsClosed });
      setActiveId((prev) => prev ?? list.events[0]?.id ?? null);
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, status, keyword, typeFilter]);

  useEffect(() => { void loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [d, r] = await Promise.all([getEventDetail(scope, id), listRefs(scope, id)]);
      setDetail(d);
      setRefs(r.refs);
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope]);

  useEffect(() => {
    setDelConfirm(false);
    if (activeId) void loadDetail(activeId);
    else { setDetail(null); setRefs([]); }
  }, [activeId, loadDetail]);

  const active = useMemo(() => events.find((e) => e.id === activeId) ?? detail?.event ?? null, [events, activeId, detail]);
  const type = useMemo(
    () => types.find((t) => t.id === (active?.typeId ?? '')) ?? null,
    [types, active],
  );

  const selectedType = useMemo(
    () => types.find((t) => t.id === selectedTypeId) ?? types[0] ?? null,
    [types, selectedTypeId],
  );

  /**
   * 行内保存：demo 里点一下即生效，没有「保存」按钮。
   * 每次都用**最新 revision**发 PATCH（同一类型连点两次也要成立，否则第二次 409）。
   */
  const patchType = async (mutate: (stages: StagePatch[], type: EventTypeView) => {
    stages?: StagePatch[];
    terminalAction?: 'keep' | 'trash';
  }): Promise<void> => {
    if (!selectedType) return;
    const latest = types.find((t) => t.id === selectedType.id) ?? selectedType;
    const base: StagePatch[] = latest.stages.map((st) => ({
      key: st.key,
      name: st.name,
      visibility: st.visibility,
      ...(st.disabled ? { disabled: true } : {}),
    }));
    const patch = mutate(base, latest);
    await run(async () => {
      const res = await updateEventType(scope, latest.id, {
        revision: latest.revision,
        ...(patch.stages ? { stages: patch.stages } : {}),
        ...(patch.terminalAction ? { terminalAction: patch.terminalAction } : {}),
      });
      return `「${res.type.name}」已更新`;
    });
  };

  /** 删除类型：内置不可删；仍有事件在用时服务端返回 TYPE_IN_USE */
  const removeType = async (): Promise<void> => {
    if (!selectedType) return;
    const target = selectedType;
    await run(async () => {
      const res = await fetch(
        `/api/governance/event-types/${encodeURIComponent(target.id)}?scope=${encodeURIComponent(scope)}`,
        { method: 'DELETE' },
      );
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${res.status}`);
      setSelectedTypeId(null);
      return `已删除类型「${target.name}」`;
    });
  };

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
      await loadList();
      if (activeId) await loadDetail(activeId);
    } catch (err) {
      const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
      setMessage({ tone: 'err', text: `${code}${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const closed = active?.closedAt !== null && active?.closedAt !== undefined;
  const stageIdx = type && active ? type.stages.findIndex((s) => s.key === active.stageKey) : -1;
  const stageVis = stageIdx >= 0 ? type!.stages[stageIdx].visibility : 'full';
  const memberCount = detail?.members.length ?? active?.memberTotal ?? 0;

  return (
    <div className="gov-page">
      <header className="gov-head">
        <p className="gov-head__path">
          <span className="gov-badge gov-badge--kb">{scope}</span>
          {/* 计数读取失败时整段不渲染：留空 span 会让 flex gap 多出一段空白，也会让人以为"0 个" */}
          {counts ? (
            <span className="gov-cell-muted">未收口 {counts.open} · 已收口 {counts.closed}</span>
          ) : null}
        </p>
        <div className="gov-head__actions">
          <button
            className="gov-btn gov-btn--sm"
            disabled={!canWrite}
            title={readOnlyHint}
            onClick={() => setNewEventOpen(true)}
          >
            ＋ 新建事件
          </button>
        </div>
      </header>

      <div className="gov-toolbar">
        <div className="gov-seg">
          <button aria-pressed={tab === 'list'} onClick={() => setTab('list')}>事件列表</button>
          <button aria-pressed={tab === 'types'} onClick={() => setTab('types')}>事件类型</button>
        </div>
        <span className="gov-toolbar__spacer" />
        <>
          <DropdownFilter
            label="类型"
            value={typeFilter}
            options={[{ value: '', label: '全部类型' }, ...types.map((t) => ({ value: t.id, label: t.name }))]}
            onChange={setTypeFilter}
          />
          <DropdownFilter
            label={status === 'open' ? '未收口' : status === 'closed' ? '已收口' : '全部'}
            value={status}
            options={[
              { value: 'open', label: '未收口' },
              { value: 'closed', label: '已收口' },
              { value: 'all', label: '全部' },
            ]}
            onChange={(v) => setStatus(v as Status)}
          />
          </>
      </div>

      {message ? <p className={message.tone === 'err' ? 'gov-error' : 'gov-hint'}>{message.text}</p> : null}
      {showReadOnlyHint ? (
        <p className="gov-hint">
          当前账号为只读：可以查看事件、阶段与可见性；新建 / 流转 / 删除 / 编辑类型需要写权限。
          「AI 查找」可照常用，只有「加入参考文档」需要写权限。
        </p>
      ) : null}

      {tab === 'types' ? (
        <>
          <div className="gov-card">
          <div className="gov-typebar">
            <div className="gov-seg" role="group" aria-label="事件类型">
              {types.map((t) => (
                <button key={t.id} aria-pressed={selectedType?.id === t.id} onClick={() => setSelectedTypeId(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
            <span className="gov-toolbar__spacer" />
            <span className="gov-cell-muted">
              {selectedType?.builtin ? '内置类型，不可删除' : '自定义类型'}
            </span>
            <button
              className="gov-btn gov-btn--sm"
              disabled={busy || !canWrite}
              title={readOnlyHint}
              onClick={() => setNewTypeOpen(true)}
            >
              ＋ 新建类型
            </button>
            <button
              className="gov-btn gov-btn--sm gov-btn--danger-ghost"
              disabled={busy || !selectedType || selectedType.builtin || !canWrite}
              title={!canWrite ? readOnlyHint : selectedType?.builtin ? '内置类型不可删除' : '删除该类型（仍有事件在用时会被拒绝）'}
              onClick={() => void removeType()}
            >
              删除类型
            </button>
          </div>

          {selectedType ? (
            <>
                <table className="gov-tbl">
                  <colgroup>
                    <col style={{ width: 160 }} />
                    <col style={{ width: 290 }} />
                    <col />
                    <col style={{ width: 90 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>阶段（有序）</th>
                      <th>检索可见性</th>
                      <th>进入时动作</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedType.stages.map((stage, i) => {
                      // 序号徽标跟随左侧选中事件的当前阶段；没选事件就不标（此前硬编码 i===2 是假数据）
                      const isCurrent = active?.stageKey === stage.key && active?.typeId === selectedType.id;
                      return (
                        <tr key={stage.key} data-current={isCurrent ? '' : undefined}>
                          <td>
                            <span className="gov-stage-row__idx">{i + 1}</span>
                            {stage.name}
                          </td>
                          <td>
                            <div className="gov-seg gov-seg--vis" role="group" aria-label={`${stage.name} 检索可见性`}>
                              {(['full', 'fts-only', 'hidden'] as Visibility[]).map((value) => (
                                <button
                                  key={value}
                                  type="button"
                                  aria-pressed={stage.visibility === value}
                                  disabled={busy || !canWrite}
                                  title={readOnlyHint}
                                  onClick={() => void patchType((stages) => {
                                    const next = [...stages];
                                    next[i] = { ...next[i], visibility: value };
                                    return { stages: next };
                                  })}
                                >
                                  {VIS_TEXT[value]}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td>
                            <span className="gov-cell-muted">
                              {i === selectedType.stages.length - 1 && selectedType.terminalAction === 'trash'
                                ? '移入回收站'
                                : '保留'}
                            </span>
                          </td>
                          <td>
                            <button
                              className="gov-btn gov-btn--ghost gov-btn--sm"
                              disabled={busy || i === selectedType.stages.length - 1 || !canWrite}
                              title={!canWrite ? readOnlyHint : i === selectedType.stages.length - 1 ? '末位是终态，不能停用' : '停用后不能再流转到该阶段'}
                              onClick={() => void patchType((stages) => {
                                const next = [...stages];
                                next[i] = { ...next[i], disabled: !next[i].disabled };
                                return { stages: next };
                              })}
                            >
                              {stage.disabled ? '启用' : '停用'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="gov-card__foot">
                  <button
                    className="gov-btn gov-btn--sm"
                    disabled={busy || !canWrite}
                    title={readOnlyHint}
                    onClick={() => setAddStageOpen(true)}
                  >
                    ＋ 追加阶段
                  </button>
                  <p className="gov-hint">
                    <b>阶段只能追加、不能删除</b>：已有事件停在某阶段后，删除定义会留下悬空状态；
                    要废弃某个阶段请用「停用」—— 新事件不再进入、老事件可停留，并提供「迁移到 X」的引导。
                  </p>
                </div>
              </>
            ) : (
              <div className="gov-cell-muted" style={{ padding: 24 }}>暂无事件类型</div>
            )}
          </div>

          {selectedType ? (
            <p className="gov-notice">
              <strong>为什么是三档而不是开关：</strong>
              <code>ki_search</code> 默认 hybrid（语义+全文），只关语义（dense）全文仍会命中并召回给 AI ——
              「不召回」不等于「搜不到」。三档对应：
              <strong>语义+全文</strong>（完整）/
              <strong>仅全文</strong>（关键词能搜到、不主动语义推送）/
              <strong>不可检索</strong>（两者都断，但按浏览可见，人工可读）。
              第三档还要清 <code>ki-relation</code> / <code>ki-path</code> 两类辅助向量 —— 否则语义会绕回。
            </p>
          ) : null}
        </>
      ) : (
        <div className="gov-split">
          {/* 左：事件列表 */}
          <div className="gov-pane">
            <div className="gov-pane__search">
              <input className="gov-input" style={{ width: '100%' }} placeholder="搜索事件名或编号…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            </div>
            <div className="gov-pane__list">
              {events.map((event) => {
                const t = types.find((x) => x.id === event.typeId);
                const idx = t ? t.stages.findIndex((s) => s.key === event.stageKey) : -1;
                const vis = idx >= 0 ? t!.stages[idx].visibility : 'full';
                const members = event.memberTotal ?? 0;
                return (
                  <div
                    key={event.id}
                    className={`gov-ev${event.id === activeId ? ' gov-ev--active' : ''}`}
                    onClick={() => setActiveId(event.id)}
                  >
                    <div className="gov-ev__title">
                      <span className="gov-ev__name">#{event.shortId} {event.title}</span>
                      {t ? <span className={typeBadgeClass(t.name)}>{t.name}</span> : null}
                    </div>
                    <div className="gov-ev__meta">
                      <span>{members} 篇</span>
                      <span>· {relTime(event.updatedAt)}</span>
                      {vis === 'full' ? null : (
                        <span className="gov-ev__vis">
                          · <i className={`gov-dot${vis === 'hidden' ? ' gov-dot--hollow' : ' gov-dot--solid'}`} />
                          {members} 篇{vis === 'hidden' ? '不可检索' : '仅全文'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {events.length === 0 ? <div className="gov-cell-muted" style={{ padding: 16 }}>暂无事件</div> : null}
            </div>
          </div>

          {/* 右：详情 */}
          <div className="gov-pane">
            {!active ? (
              <div className="gov-cell-muted" style={{ padding: 24 }}>左侧选择一个事件查看详情</div>
            ) : (
              <div className="gov-detail">
                <div className="gov-detail__head">
                  <div>
                    <div className="gov-detail__title">#{active.shortId} {active.title}</div>
                    <div className="gov-ev__meta" style={{ marginTop: 4 }}>
                      <span>{type?.name ?? active.typeId}</span>
                      <span>· 当前「{type?.stages[stageIdx]?.name ?? '未知'}」</span>
                      <span>· 关联 {memberCount} 篇</span>
                      <span>· 参考 {refs.length} 篇</span>
                    </div>
                  </div>
                  <div className="gov-detail__actions">
                    <button
                      className="gov-btn gov-btn--sm gov-btn--ai"
                      title="基于事件与关联文档，在已配置的 Git 仓库里定位相关代码"
                      onClick={() => setAiOpen(true)}
                    >
                      <svg className="gov-btn--ai__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M6.4 1.6c.28 2.4 1.72 3.84 4.12 4.12-2.4.28-3.84 1.72-4.12 4.12C6.12 7.44 4.68 6 2.28 5.72 4.68 5.44 6.12 4 6.4 1.6Z" />
                        <path d="M11.9 9.2c.17 1.45 1.05 2.33 2.5 2.5-1.45.17-2.33 1.05-2.5 2.5-.17-1.45-1.05-2.33-2.5-2.5 1.45-.17 2.33-1.05 2.5-2.5Z" opacity=".62" />
                      </svg>
                      AI 分析
                    </button>
                    {closed ? (
                      <button
                        className="gov-btn gov-btn--sm"
                        disabled={busy || !canWrite}
                        title={readOnlyHint}
                        onClick={() => void run(async () => {
                          const r = await reopenEvent(scope, active.id);
                          return r.hint;
                        })}
                      >
                        重新打开
                      </button>
                    ) : null}
                    <button
                      className="gov-btn gov-btn--sm gov-btn--danger-ghost"
                      disabled={busy || !closed || !canWrite}
                      title={!canWrite ? readOnlyHint : closed ? '删除事件：关联文档改为长期保留' : '事件未收口不能删除，先流转到末位阶段'}
                      onClick={() => {
                        // 不可逆（事件与阶段日志一并删除）：第一次点击只进入确认态
                        if (!delConfirm) { setDelConfirm(true); return; }
                        setDelConfirm(false);
                        void run(async () => {
                          const r = await deleteEvent(scope, active.id, 'wiki');
                          setActiveId(null);
                          return `已删除事件；${r.affected.docs} 篇文档改为长期保留`;
                        });
                      }}
                    >
                      {delConfirm ? '确认删除事件（不可恢复）' : '删除事件'}
                    </button>
                    {closed ? null : (
                      <button
                        className="gov-btn gov-btn--sm gov-btn--primary"
                        disabled={busy || !canWrite}
                        title={readOnlyHint}
                        onClick={() => setTransOpen(true)}
                      >
                        流转
                      </button>
                    )}
                  </div>
                </div>

                {/* 阶段线 */}
                <div className="gov-stage">
                  {(type?.stages ?? []).map((s, i) => (
                    <div
                      key={s.key}
                      className={`gov-stage__node${i < stageIdx ? ' gov-stage__node--done' : ''}${i === stageIdx ? ' gov-stage__node--current' : ''}`}
                    >
                      <span className="gov-stage__dot" />
                      <span className="gov-stage__name">{s.name}</span>
                      <span className="gov-stage__cap">{VIS_TEXT[s.visibility]}</span>
                    </div>
                  ))}
                </div>

                <div className="gov-infobar">
                  当前阶段「{type?.stages[stageIdx]?.name ?? '未知'}」：{memberCount} 篇文档的可见性为
                  <strong>{VIS_TEXT[stageVis]}</strong>
                  {stageVis === 'hidden' ? '（语义与全文都搜不到，这是阶段设计的预期行为）' : ''}
                </div>

                {/* 关联文档 */}
                <div className="gov-sect">
                  <div className="gov-sect__head">
                    <span className="gov-sect__title">关联文档</span>
                    <span className="gov-sect__hint">可见性随事件阶段变化</span>
                  </div>
                  {(detail?.members ?? []).map((m) => (
                    <div className="gov-docline" key={`${m.group}/${m.name}`}>
                      {/*
                        文档名是按钮（demo `.docline` 的语义）：点开右侧阅读抽屉看正文。
                        此前这行是纯 <div>，点了没有任何反应 —— 事件页里最要紧的动作（看证据原文）缺失。
                      */}
                      <button
                        type="button"
                        className="gov-docline__main"
                        title={`查看「${m.name}」正文`}
                        onClick={() => setDocTarget({ group: m.group, name: m.name })}
                      >
                        <span className="gov-docline__name">{m.name}</span>
                        <span className="gov-docline__meta">{m.group}</span>
                      </button>
                      <div className="gov-docline__right">
                        <span className={`gov-vis gov-vis--${VIS_CLASS[stageVis as Visibility] ?? 'hidden'}`}>
                          <span className="gov-vis__dot" />
                          {VIS_TEXT[stageVis]}
                        </span>
                      </div>
                    </div>
                  ))}
                  {memberCount === 0 ? <div className="gov-cell-muted">暂无关联文档（用 ki_sync_relation 的 event 参数绑定）</div> : null}
                </div>

                {/* 参考文档 */}
                <div className="gov-sect">
                  <div className="gov-sect__head">
                    <span className="gov-sect__title">参考文档</span>
                    <span className="gov-sect__hint">外部引用，不随事件阶段变化</span>
                    <span className="gov-sect__actions">
                      {/*
                        打开弹窗即请求候选：不再"点一下自动加前 3 篇"。
                        旧实现把事件标题当手动搜索词发出去，命中就静默加入 —— 既不是 AI 查找，
                        也违反 R29（低分与未确认的项不该被默认采纳）。
                      */}
                      <button
                        className="gov-btn gov-btn--sm"
                        disabled={busy}
                        onClick={() => setFindRefOpen(true)}
                      >
                        AI 查找
                      </button>
                      <button
                        className="gov-btn gov-btn--ghost gov-btn--sm"
                        disabled={busy || !canWrite}
                        title={readOnlyHint}
                        onClick={() => setAddRefOpen(true)}
                      >
                        ＋ 添加
                      </button>
                    </span>
                  </div>
                  {refs.map((ref) => (
                    <div className="gov-docline" key={`${ref.group}/${ref.name}`}>
                      {/* stale = 引用指向的文档已被删除/移走：仍允许点，由阅读器给出「未找到 + 路径」的失败态，
                          比禁用按钮更容易让人查清到底哪一篇没了 */}
                      <button
                        type="button"
                        className="gov-docline__main"
                        title={ref.stale ? `查看「${ref.name}」（文档已不存在）` : `查看「${ref.name}」正文`}
                        onClick={() => setDocTarget({ group: ref.group, name: ref.name })}
                      >
                        <span className="gov-docline__name">{ref.name}</span>
                        <span className="gov-docline__meta">
                          {ref.group}
                          {ref.stale ? <span className="gov-error"> · 文档已不存在</span> : null}
                        </span>
                      </button>
                      <div className="gov-docline__right">
                        <span className={`gov-vis gov-vis--${VIS_CLASS[ref.visibility] ?? 'hidden'}`}>
                          <span className="gov-vis__dot" />
                          {VIS_TEXT[ref.visibility]}
                        </span>
                        <button
                          className="gov-btn gov-btn--ghost gov-btn--sm"
                          disabled={busy || !canWrite}
                          title={readOnlyHint ?? '移除该参考文档'}
                          onClick={() => void run(async () => {
                            await removeRef(scope, active.id, ref.group, ref.name);
                            return `已移除参考文档「${ref.name}」`;
                          })}
                        >×</button>
                      </div>
                    </div>
                  ))}
                  {refs.length === 0 ? <div className="gov-cell-muted">暂无参考文档</div> : null}
                </div>

                {/* AI 同源操作 */}
                <div className="gov-sect">
                  <div className="gov-sect__head">
                    <span className="gov-sect__title">AI 同源操作（MCP）</span>
                    <span className="gov-sect__hint">页面按钮只是这条命令的外壳</span>
                  </div>
                  <pre className="gov-code">{`ki_event_set_stage({ scope: "${scope}", event: "#${active.shortId}", stage: "${type?.stages[Math.min(stageIdx + 1, (type?.stages.length ?? 1) - 1)]?.name ?? ''}" })
// → { ok: true, closed: ${String(closed)}, affected: { docs: ${memberCount}, failed: 0 } }`}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {addStageOpen && selectedType ? (
        <AddStageModal
          type={selectedType}
          busy={busy}
          onClose={() => setAddStageOpen(false)}
          onSubmit={(name, visibility, action) => {
            setAddStageOpen(false);
            void patchType((stages, latest) => ({
              stages: [...stages, { name, visibility }],
              // 「进入时动作」是**类型级**字段：只有新阶段位居末位时才会生效
              ...(action ? { terminalAction: action } : {}),
              ...(latest ? {} : {}),
            }));
          }}
        />
      ) : null}
      {newTypeOpen ? (
        <NewTypeModal
          types={types}
          onClose={() => setNewTypeOpen(false)}
          onCreate={(payload) => {
            setNewTypeOpen(false);
            void run(async () => {
              const res = await fetch('/api/governance/event-types', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope, ...payload }),
              });
              const body = await res.json() as { ok?: boolean; type?: EventTypeView; error?: string };
              if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
              if (body.type) setSelectedTypeId(body.type.id);
              return `已创建类型「${body.type?.name}」（${body.type?.stages.length} 个阶段）`;
            });
          }}
        />
      ) : null}

      {aiOpen ? (
        <AiAnalyzeModal
          onClose={() => setAiOpen(false)}
          onOpenSettings={() => { setAiOpen(false); openAiSettings('analysis'); }}
        />
      ) : null}

      {/*
        关联文档 / 参考文档 → 右侧阅读抽屉（S-07 §3.3：复用 `ModuleDrawer`，不改组件本身）。
        key 含 group+name：切到另一篇会整块重挂载，正文、大纲、滚动位置不会串台。
        正文走 `/api/doc/get`（read 通道），导入/向量化期间不会被 MCP 写队列排队。
      */}
      {docTarget ? (
        <ModuleDrawer
          key={`${docTarget.group}/${docTarget.name}`}
          scope={scope}
          module={docTarget.name}
          group={docTarget.group}
          fetcher={getDocContent}
          onClose={() => setDocTarget(null)}
        />
      ) : null}

      {transOpen && active ? (
        <TransitionModal
          event={active}
          stages={type?.stages ?? []}
          currentKey={active.stageKey}
          busy={busy}
          onClose={() => setTransOpen(false)}
          onConfirm={(stage) => void run(async () => {
            const r = await setEventStage(scope, active.id, stage);
            const pending = r.pending.length > 0 ? `；索引重建中（${r.pending.join('/')}）` : '';
            return `已流转到「${r.to.name}」${r.closed ? '（已收口）' : ''}${pending}`;
          })}
        />
      ) : null}

      {findRefOpen && active ? (
        <FindRefModal
          scope={scope}
          eventId={active.id}
          canWrite={canWrite}
          context={{
            title: active.title,
            shortId: active.shortId,
            ...(type?.name ? { typeName: type.name } : {}),
            stageName: type?.stages.find((s) => s.key === active.stageKey)?.name ?? '—',
            assocCount: memberCount,
            scope,
          }}
          onClose={() => setFindRefOpen(false)}
          onAdded={(added, skipped) => {
            // 局部刷新参考文档区：搜索本身没写数据，不该触发整页重载与列表重排
            setMessage({
              tone: 'ok',
              text: `已加入 ${added} 篇参考文档${skipped > 0 ? `，跳过 ${skipped} 篇（已存在）` : ''}`,
            });
            void loadDetail(active.id);
          }}
          onSwitchToManual={() => {
            setFindRefOpen(false);
            setAddRefOpen(true);
          }}
          onOpenSettings={() => { setFindRefOpen(false); openAiSettings('find'); }}
        />
      ) : null}

      {addRefOpen && active ? (
        <AddRefModal
          scope={scope}
          eventId={active.id}
          existing={refs}
          busy={busy}
          onClose={() => setAddRefOpen(false)}
          onAdd={(docs) => void run(async () => {
            const r = await addRefs(scope, active.id, docs);
            const skipped = r.skipped.length > 0 ? `，跳过 ${r.skipped.length} 篇（已存在或不可用）` : '';
            return `已加入 ${r.added} 篇参考文档${skipped}`;
          })}
        />
      ) : null}

      {newEventOpen ? (
        <NewEventModal
          types={types}
          busy={busy}
          onClose={() => setNewEventOpen(false)}
          onCreate={(title, typeId, stageKey) => {
            setNewEventOpen(false);
            void run(async () => {
              // 起始阶段必须一并提交：后端缺省落首阶段，UI 的选择会被静默丢弃
              const res = await createEvent(scope, { title, typeId, ...(stageKey ? { stageKey } : {}) });
              if (res.event) setActiveId(res.event.id);
              return `已创建 #${res.event?.shortId} ${res.event?.title}`;
            });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 追加阶段（demo 弹窗）
 *
 * 与 demo 的一处必要偏差：「进入时动作」在 demo 里挂在阶段行上，本实现是**类型级**字段
 * （DESIGN 缺口②：挂在阶段上时，追加一个阶段会让原终态动作静默失效）。
 * 因此这里只在「新阶段成为末位」时把它写进类型，并在弹窗里说明。
 */
function AddStageModal(args: {
  type: EventTypeView;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, visibility: Visibility, action: 'keep' | 'trash' | undefined) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('fts-only');
  const [action, setAction] = useState<'keep' | 'trash'>(args.type.terminalAction);
  const becomesTerminal = true; // 追加阶段总在末尾

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>追加阶段</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>
            类型「{args.type.name}」现有 {args.type.stages.length} 个阶段，新阶段将排在末尾
          </div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>阶段名称</span>
            <input
              className="gov-input"
              value={name}
              placeholder="如「已验证」"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>检索可见性</span>
            <div className="gov-seg" role="group" aria-label="检索可见性">
              {([
                ['full', '语义+全文'],
                ['fts-only', '仅全文'],
                ['hidden', '不可检索'],
              ] as Array<[Visibility, string]>).map(([value, label]) => (
                <button key={value} aria-pressed={visibility === value} onClick={() => setVisibility(value)}>{label}</button>
              ))}
            </div>
            <span className="gov-hint">决定这个阶段下的关联文档能否被 ki_search 召回。</span>
          </div>

          {becomesTerminal ? (
            <div className="gov-field">
              <span>进入时动作</span>
              <div className="gov-seg" role="group" aria-label="进入时动作">
                {([['keep', '保留在库'], ['trash', '移入回收站']] as Array<['keep' | 'trash', string]>).map(([value, label]) => (
                  <button key={value} aria-pressed={action === value} onClick={() => setAction(value)}>{label}</button>
                ))}
              </div>
              <span className="gov-hint">
                选「移入回收站」= 事件走到末位阶段时，关联文档自动进回收站（{7} 天内可恢复）。
                本实现把该动作记在**类型**上，避免以后追加阶段时把原动作覆盖掉。
              </span>
            </div>
          ) : null}

          <div className="gov-rowbox">
            <span className="gov-hint">
              阶段只能追加、不能删除：已有事件停在该阶段后，删除定义会留下悬空状态。要废弃请用「停用」。
            </span>
          </div>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || !name.trim()}
            onClick={() => args.onSubmit(name.trim(), visibility, becomesTerminal ? action : undefined)}
          >
            追加阶段
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 流转（demo 的二次确认弹窗）：默认选中下一阶段，也可手选（含回退）。
 * 当前阶段不可选；停用阶段不可作为目标；选回已走过的阶段 = 回退，可见性一并回退。
 */
function TransitionModal(args: {
  event: EventView;
  stages: EventTypeView['stages'];
  currentKey: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (key: string) => void;
}): JSX.Element {
  const curIdx = Math.max(0, args.stages.findIndex((s) => s.key === args.currentKey));
  const defaultTarget = (): string => {
    for (let i = curIdx + 1; i < args.stages.length; i += 1) {
      if (!args.stages[i].disabled) return args.stages[i].key;
    }
    return args.currentKey;
  };
  const [target, setTarget] = useState(defaultTarget);
  const same = target === args.currentKey;

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>流转事件</div>
          <div className="gov-hint">#{args.event.shortId} {args.event.title} · 当前「{args.stages[curIdx]?.name ?? '未知'}」</div>
        </div>
        <div className="gov-modal__body">
          <div className="gov-field">
            <span>流转到</span>
            <div className="gov-stage-picker" role="group" aria-label="选择目标阶段">
              {args.stages.map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  className="gov-stage-option"
                  aria-pressed={target === s.key}
                  disabled={s.key === args.currentKey || s.disabled}
                  onClick={() => setTarget(s.key)}
                >
                  <span className="gov-stage-option__dot" />
                  <span>{s.name}</span>
                  <span className="gov-stage-option__tag">
                    {s.key === args.currentKey ? '当前' : s.disabled ? '停用' : i === curIdx + 1 ? '下一步' : i < curIdx ? '回退' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <span className="gov-hint">
            默认选中下一个阶段。选已走过的阶段等于<b>回退</b>，关联文档的检索可见性会一并回退。
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || same}
            onClick={() => { args.onClose(); args.onConfirm(target); }}
          >
            {same ? '已在当前阶段' : '确认流转'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 添加参考文档（demo 的「＋ 添加」弹窗）：按名字 / Group 搜全库，勾选后只建立引用。
 * 后端只给确定性检索（refs/search），所以这里给一个输入即搜的候选列表。
 */
function AddRefModal(args: {
  scope: string;
  eventId: string;
  existing: RefItem[];
  busy: boolean;
  onClose: () => void;
  onAdd: (docs: Array<{ group: string; name: string }>) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ group: string; name: string; visibility: Visibility }>>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keyOf = (h: { group: string; name: string }): string => `${h.group}/${h.name}`;
  const addedKeys = useMemo(() => new Set(args.existing.map(keyOf)), [args.existing]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setSearching(true);
    // 空查询也发一次：后端 q 为空时返回"可加入的前 N 篇"（对齐 demo —— 打开弹窗就能看到有哪些可加，
    // 此前空查询直接短路成空数组，弹窗里一片空白且没有任何提示）
    const delay = q.trim() ? 250 : 0;
    const timer = window.setTimeout(() => {
      // 手动搜索与 AI 候选是两个语义：走 docs/search，并把 eventId 带上让后端排除已关联/已加入（R31）
      void searchRefDocs(args.scope, q.trim(), args.eventId)
        .then((r) => {
          if (!alive) return;
          setHits(r.hits);
          setErr(null);
          // 结果换了一批就剪掉"看不见的选中"：否则按钮说"加入所选 1 篇"，
          // 用户却在当前列表里找不到那一篇（demo 每轮重渲染会丢弃勾选，等价于这个剪枝）
          setPicked((prev) => {
            const visible = new Set(r.hits.map(keyOf));
            const next = prev.filter((k) => visible.has(k));
            return next.length === prev.length ? prev : next;
          });
        })
        .catch((e: Error) => { if (alive) { setHits([]); setErr(e.message); } })
        .finally(() => { if (alive) setSearching(false); });
    }, delay);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [q, args.scope, args.eventId]);

  // 结果换了一批就回到顶部：否则上一批的 scrollTop 会让首行被裁掉半截（走查截图里就是这样）
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [hits]);

  const toggle = (key: string): void => setPicked((prev) => (
    prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
  ));
  const pickedDocs = hits.filter((h) => picked.includes(keyOf(h))).map((h) => ({ group: h.group, name: h.name }));

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>添加参考文档</div>
          <div className="gov-hint">按文档名或 Group 路径搜索知识库</div>
        </div>
        <div className="gov-modal__body">
          <input
            className="gov-input"
            type="search"
            autoFocus
            placeholder="搜索文档名 / Group 路径…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="gov-cand-list" ref={listRef}>
            {hits.map((h) => {
              const key = keyOf(h);
              const already = addedKeys.has(key);
              return (
                <label key={key} className="gov-cand" data-added={already ? '' : undefined}>
                  <input
                    type="checkbox"
                    disabled={already}
                    checked={already || picked.includes(key)}
                    onChange={() => toggle(key)}
                  />
                  <span>
                    <span className="gov-cand__name">{h.name}</span>
                    {/* 与 demo 同构：一行小字 `group · 可见性`，已加入的（竞态）额外标注 */}
                    <span className="gov-cand__meta">
                      {h.group} · {VIS_TEXT[h.visibility]}{already ? ' · 已加入' : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {err ? <span className="gov-error">{err}</span> : null}
          {!err && searching ? <span className="gov-hint">搜索中…</span> : null}
          {!err && !searching && hits.length === 0 ? (
            <span className="gov-hint">
              {q.trim()
                ? '没有匹配的文档（已排除关联文档与已加入的参考文档）。若确信库里有，确认顶部 scope —— 事件与知识文档可能不在同一个库。'
                : `scope「${args.scope}」里没有可加入的文档：可能都已关联 / 已加入，或这个库本身没有文档。`}
            </span>
          ) : null}
          <span className="gov-hint">只建立引用，不修改文档本身的分类与可见性。</span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || pickedDocs.length === 0}
            onClick={() => { args.onClose(); args.onAdd(pickedDocs); }}
          >
            {pickedDocs.length === 0 ? '未选择' : `加入所选 ${pickedDocs.length} 篇`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * AI 分析（demo 的占位入口）：demo 里也只弹说明，不做成死按钮。
 * 代码定位尚未接入，这里如实写清方案与前置条件，避免点了没反应。
 */
function AiAnalyzeModal(args: { onClose: () => void; onOpenSettings: () => void }): JSX.Element {
  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>AI 分析</div>
          <div className="gov-hint">基于事件描述与关联文档，在 Git 仓库里定位相关代码</div>
        </div>
        <div className="gov-modal__body">
          <span className="gov-hint">
            四步：提取事件线索 → 在仓库里 <code>grep</code> / <code>find</code> 定位 →
            读关键片段 → 汇总成<strong>待确认</strong>的候选代码位置。
          </span>
          <div className="gov-field">
            <span>前置条件</span>
            <ul className="gov-prereq">
              <li data-ok>事件实体与关联文档</li>
              <li data-ok>Git 数据源</li>
              <li>只读文件工具 grep / find / read / ls（待开发）</li>
            </ul>
          </div>
          <div className="gov-infobar">
            <span><b>i</b>&nbsp;&nbsp;只会<b>读</b>代码，不会修改文件，也不会执行命令。</span>
          </div>
          <span className="gov-hint">当前版本只说明方案与前置条件，代码定位尚未接入。</span>
        </div>
        <div className="gov-modal__foot">
          {/* 就近入口：直达 AI 设置的「分析」分组（提示词已可预设，但当前不生效） */}
          <button className="gov-btn gov-btn--sm gov-btn--ghost" onClick={args.onOpenSettings}>⚙ 提示词设置</button>
          <span style={{ flex: 1 }} />
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}

/** 筛选下拉（demo 的「类型 ▾」「未收口 ▾」）：按钮 + 浮层，不用原生 select */
function DropdownFilter(args: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 点空白处收起（否则只能靠选中项关掉）
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <span className="gov-dd">
      <button
        className="gov-btn gov-btn--sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {args.label} ▾
      </button>
      {open ? (
        <span className="gov-dd__menu" onClick={(e) => e.stopPropagation()}>
          {args.options.map((o) => (
            <button
              key={o.value || 'all'}
              className={`gov-dd__item${o.value === args.value ? ' gov-dd__item--on' : ''}`}
              aria-selected={o.value === args.value}
              onClick={() => { args.onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 新建事件（demo 弹窗：标题 + 类型 chips + 起始阶段 + 两段说明） */
function NewEventModal(args: {
  types: EventTypeView[];
  busy: boolean;
  onClose: () => void;
  onCreate: (title: string, typeId: string, stageKey?: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [typeId, setTypeId] = useState(args.types[0]?.id ?? '');
  const current = args.types.find((t) => t.id === typeId) ?? args.types[0] ?? null;
  const [stageKey, setStageKey] = useState(current?.stages[0]?.key ?? '');
  const stage = current?.stages.find((st) => st.key === stageKey) ?? current?.stages[0] ?? null;
  const VIS_TEXT: Record<Visibility, string> = { full: '语义+全文', 'fts-only': '仅全文', hidden: '不可检索' };

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>新建事件</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>
            事件把一批文档绑在一条处理链上，阶段决定它们能不能被检索到
          </div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>事件标题</span>
            <input className="gov-input" value={title} placeholder="如「登录页白屏」" onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="gov-field">
            <span>事件类型</span>
            <div className="gov-seg" role="group" aria-label="事件类型">
              {args.types.map((t) => (
                <button
                  key={t.id}
                  aria-pressed={t.id === typeId}
                  onClick={() => {
                    setTypeId(t.id);
                    setStageKey(t.stages[0]?.key ?? '');
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <span className="gov-hint">类型决定阶段列表与每阶段的检索可见性。</span>
          </div>

          <div className="gov-field">
            <span>起始阶段</span>
            <div className="gov-rowbox">
              <select
                className="gov-select gov-inline-select"
                value={stageKey}
                onChange={(e) => setStageKey(e.target.value)}
              >
                {(current?.stages ?? []).map((st) => (
                  <option key={st.key} value={st.key} disabled={st.disabled}>
                    {st.name}{st.disabled ? '（停用）' : ''}
                  </option>
                ))}
              </select>
              <span className={`gov-vis gov-vis--${stage ? VIS_CLASS[stage.visibility] : 'hidden'}`}>
                <span className="gov-vis__dot" />
                {stage ? VIS_TEXT[stage.visibility] : '—'}
              </span>
              <span className="gov-rowbox__hint">
                {stage?.visibility === 'full' ? '新挂的文档可被语义检索' : '新挂的文档默认不参与语义检索'}
              </span>
            </div>
          </div>

          <span className="gov-hint">
            创建后到详情里「关联文档」挂上要跟踪的文档；事件收口时按终态动作决定保留还是移入回收站。
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || !title.trim() || !typeId}
            onClick={() => args.onCreate(title.trim(), typeId, stageKey || undefined)}
          >
            创建事件
          </button>
        </div>
      </div>
    </div>
  );
}


/** 新建事件类型（demo 弹窗：名称 + 回车加阶段 + 复用已有 + 终态动作） */
function NewTypeModal(args: {
  types: EventTypeView[];
  onClose: () => void;
  onCreate: (payload: { name: string; stages: Array<{ name: string; visibility: Visibility }>; terminalAction: 'keep' | 'trash' }) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [stages, setStages] = useState<Array<{ name: string; visibility: Visibility }>>([
    { name: '进行中', visibility: 'hidden' },
  ]);
  const [draft, setDraft] = useState('');
  const [reuseFrom, setReuseFrom] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // 拖拽源用 ref：dragstart 与 drop 同 tick 触发，state 尚未刷新会读到 null
  const dragFrom = useRef<number | null>(null);
  const [action, setAction] = useState<'keep' | 'trash'>('keep');

  const VIS_TEXT: Record<Visibility, string> = { full: '语义+全文', 'fts-only': '仅全文', hidden: '不可检索' };
  const CYCLE: Visibility[] = ['hidden', 'fts-only', 'full'];

  const addStage = (): void => {
    const v = draft.trim();
    if (!v) return;
    setStages((prev) => [...prev, { name: v, visibility: 'hidden' }]);
    setDraft('');
  };

  const applyReuse = (id: string): void => {
    setReuseFrom(id);
    if (!id) return;
    const src = args.types.find((t) => t.id === id);
    if (!src) return;
    setStages(src.stages.map((st) => ({ name: st.name, visibility: st.visibility, })));
    setAction(src.terminalAction);
  };

  const moveStage = (from: number, to: number): void => {
    if (to < 0 || to >= stages.length) return;
    setStages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const canSubmit = name.trim().length > 0 && stages.length >= 2;

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>新建事件类型</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>先建两条骨架阶段，创建后可逐个追加</div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>类型名称</span>
            <input
              className="gov-input"
              value={name}
              placeholder="如「线上事故」「技术调研」"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>阶段（按回车逐个添加，可拖动排序）</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {stages.map((st, i) => (
                <span
                  key={`${st.name}-${i}`}
                  className="gov-badge gov-badge--kb"
                  draggable
                  onDragStart={() => { dragFrom.current = i; setDragIndex(i); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const from = dragFrom.current;
                    if (from === null || from === i) return;
                    moveStage(from, i);
                    dragFrom.current = null;
                    setDragIndex(null);
                  }}
                  onDragEnd={() => { dragFrom.current = null; setDragIndex(null); }}
                  style={{ gap: 6, cursor: 'grab', opacity: dragIndex === i ? 0.45 : 1 }}
                  title="按住拖动可调整阶段顺序"
                >
                  {i + 1} {st.name}
                  {i === stages.length - 1 ? <span style={{ fontSize: 10 }}>终态</span> : null}
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    title={`点击循环切换可见性（当前：${VIS_TEXT[st.visibility]}）`}
                    onClick={() => setStages((prev) => prev.map((item, idx) => idx === i
                      ? { ...item, visibility: CYCLE[(CYCLE.indexOf(item.visibility) + 1) % CYCLE.length] }
                      : item))}
                  >
                    ●
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={i === 0}
                    title="前移"
                    onClick={() => moveStage(i, i - 1)}
                  >
                    ←
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={i === stages.length - 1}
                    title="后移"
                    onClick={() => moveStage(i, i + 1)}
                  >
                    →
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={stages.length <= 1}
                    onClick={() => setStages((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className="gov-input"
              value={draft}
              placeholder="输入阶段名后按回车，如「排查中」"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addStage();
                }
              }}
            />
            <span className="gov-hint">
              先输入的排最前，最后一条自动为「终态」。点圆点按下面三档循环切换：
              &nbsp;● 语义+全文　○ 仅全文　○ 不可检索
            </span>
            <span className="gov-hint">决定这个阶段下的文档能否被 ki_search 召回。</span>
          </div>

          <label className="gov-field">
            <span>复用已有类型的阶段</span>
            <select className="gov-select" value={reuseFrom} onChange={(e) => applyReuse(e.target.value)}>
              <option value="">不复用，自己录入</option>
              {args.types.map((t) => <option key={t.id} value={t.id}>复制「{t.name}」的 {t.stages.length} 个阶段</option>)}
            </select>
            <span className="gov-hint">复用是复制一份副本，此后两边各改各的；源类型后续调整阶段，不会影响这个新类型。</span>
          </label>

          <div className="gov-field">
            <span>终态动作（最后一阶段）</span>
            <div className="gov-seg" role="group" aria-label="终态动作">
              {([['keep', '保留在库'], ['trash', '移入回收站']] as Array<['keep' | 'trash', string]>).map(([v, label]) => (
                <button key={v} aria-pressed={action === v} onClick={() => setAction(v)}>{label}</button>
              ))}
            </div>
            <span className="gov-hint">
              选「移入回收站」= 事件走到终态时，关联文档自动进回收站（7 天内可恢复）。
            </span>
          </div>

          <span className="gov-hint">
            新建类型后，它会出现在事件列表的「类型」筛选里；事件可随时切换类型，已有相关文档不受影响。
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={!canSubmit}
            onClick={() => args.onCreate({ name: name.trim(), stages, terminalAction: action })}
          >
            创建类型
          </button>
        </div>
      </div>
    </div>
  );
}
