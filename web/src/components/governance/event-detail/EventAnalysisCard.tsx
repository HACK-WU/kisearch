import { useEffect, useState } from 'react';
import type { ConfirmedCodeLocation, EventAnalysis, EventView } from '@/api/governanceApi';
import { AiAnalyzePanel } from '@/components/governance/AiAnalyzePanel';
import { AnalysisEditor } from './AnalysisEditor';
import { CodeLocRow } from './CodeLocRow';
import { ConclusionChain } from './ConclusionChain';
import { DataFlowBlock } from './DataFlowBlock';
import { AskBlock } from './AskBlock';
import { inferAnalysisView } from '@/lib/analysisView';

/**
 * AI 分析卡（2026-11-17 改版 · 批 2；2026-11-23 新增人工校正编辑态）。
 *
 * 检查点：D-01~D-06（卡头与 chip）、E-01（无遮罩）、G-03（确认后整卡保留）、F-15（运行中不出现候选）。
 * · 卡片**默认不渲染**：无草稿且无已确认位置时不出现（D-02），有历史结果时也渲染（D-03）；
 * · 人工校正（REQ-20261123-001）：卡头「编辑」进编辑态；`editedAt` 存在则显示「已人工修订」；
 *   三块都空且有 `editedAt` 时是**「已人工清空」**，不能回退成「AI 未定位到」（R-11/R-14）。
 */
export interface EventAnalysisCardProps {
  scope: string;
  event: EventView;
  analysis: EventAnalysis | null;
  canWrite: boolean;
  /** 追问提问权限（knowledge.ask）：与写权限分开，viewer 也有 */
  canAsk: boolean;
  busy: boolean;
  readOnlyHint?: string;
  /** 递增触发一次分析（由概要卡「AI 分析」按钮驱动） */
  startSignal: number;
  onUpdated: (next: EventAnalysis) => void;
  onOpenSettings: () => void;
  onRemoveLocation: (loc: ConfirmedCodeLocation) => void;
  /**
   * 整份重置（2026-11-23 用户要求）：清空结论 + 已确认的代码位置，不可恢复。
   *
   * 卡片只负责入口与二次确认；实际请求、错误提示、成功后**把 `startSignal` 归零**都由父级做
   * —— 卡片"清空即消失"依赖那条渲染条件（见下方 D-02/D-03），信号不归零就会剩一张空壳卡。
   */
  onReset: () => void;
  /**
   * 编辑态是否有未保存修改（2026-11-23 · 人工校正 Q2）。
   * 父级据此在**切换事件前**拦一次，避免"改了半天点别的事件就没了"。
   */
  onDirtyChange?: (dirty: boolean) => void;
}

type ChipTone = 'idle' | 'run' | 'ok' | 'warn' | 'err' | 'ext';

/**
 * ms 时间戳 → `2026-11-23 14:02`。
 *
 * 不复用 `lib/usersPageModel.formatTime`：它吃字符串（用户页 ISO 字段），
 * 传 ms 数字会得到 `Invalid Date`；来源行只需要到分钟，自带 6 行比改公共函数安全。
 */
function fmtStamp(ts: number | undefined | null): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `title` 只在需要解释文案歧义时给（如「已修订」可能是追问补丁） */
function chipOf(analysis: EventAnalysis | null): { tone: ChipTone; text: string; title?: string } {
  const draft = analysis?.draft ?? null;
  const confirmed = analysis?.confirmed ?? [];
  const cands = draft?.candidates ?? [];
  if (draft?.status === 'running') return { tone: 'run', text: '分析中 ◐' };
  /*
   * 外部上传（2026-11-23 · REQ-20261123-009）：来源必须**前置**——
   * 否则外部草稿会落到下面的「未定位到 / 草稿 N 处」，与"已有结论"自相矛盾。
   * 但 `failed` 时不掩盖失败（异常数据也要看得见）。
   */
  if (draft?.source === 'external' && draft.status !== 'failed') {
    /*
     * 确认反馈（走查 #4）：来源前置后 chip 一直停在「外部上传」，用户确认完看不到生效。
     * 只数**本版**结论确认的位置（`confirmedAt >= startedAt`）—— 上一版留下的已确认位置
     * 与当前结论无关，算进来会给出一个误导性的数字。
     *
     * 优化（第二轮走查）：外部 + 已修订时把「已修订」**并进 chip**，卡头不再单挂一个
     * 「已修订」小标 —— 两个标签并排既挤又重复。修订是比"确认了几处"更强的信号，优先显示。
     */
    if (draft.editedAt !== undefined) {
      return {
        tone: 'ext',
        text: '外部上传 · 已修订',
        // 徽标并入 chip 后 title 只能挂在这里：说清"修订"可能是追问补丁而非人手改
        title: '外部结论被修订过（人工校正或追问补丁），结论本身仍来自上传',
      };
    }
    const fresh = confirmed.filter((c) => c.confirmedAt >= draft.startedAt).length;
    return { tone: 'ext', text: fresh > 0 ? `外部上传 · 已确认 ${fresh} 处` : '外部上传' };
  }
  /*
   * 人工定稿（R-17 / S02 D3）：AI 没给出可用结论、但人补上了 ——
   * 此时继续显示「失败 / 未定位到」会让人以为还得再跑一次。
   * 必须排在下面的 `failed` / `未定位到` 分支之前。
   */
  if (draft?.editedAt !== undefined && (draft.status === 'failed' || draft.status === 'partial')) {
    return { tone: 'ok', text: '已人工定稿' };
  }
  if (draft && cands.length > 0 && cands.every(
    (c) => confirmed.some((x) => x.file === c.file && x.line === c.line),
  )) return { tone: 'ok', text: `已确认 ${confirmed.length} 处` };
  if (draft?.errorCode === 'ANALYSIS_CANCELED') return { tone: 'warn', text: '已停止' };
  if (draft?.status === 'failed') return { tone: 'err', text: '失败' };
  if (cands.length > 0) return { tone: 'warn', text: `草稿 ${cands.length} 处` };
  if (confirmed.length > 0) return { tone: 'ok', text: `已确认 ${confirmed.length} 处` };
  // 跑完但一条候选都没有：说「未定位到」，别让它显示成「未开始」（会让人以为没跑过）。
  if (draft) return { tone: 'idle', text: '未定位到' };
  return { tone: 'idle', text: '未开始' };
}

export function EventAnalysisCard(props: EventAnalysisCardProps): JSX.Element | null {
  const {
    scope, event, analysis, canWrite, canAsk, busy, readOnlyHint, startSignal,
    onUpdated, onOpenSettings, onRemoveLocation, onReset, onDirtyChange,
  } = props;
  const draft = analysis?.draft ?? null;
  const confirmed = analysis?.confirmed ?? [];
  /** 结论按事件类型换视角（2026-11-20）：bug / 性能 / 需求 / 自建各有自己的骨架与词表 */
  const analysisView = inferAnalysisView(event.typeId);
  /*
   * 结论链：空数组表示"这版没分层"（旧事件 / 模型没给），此时回退纯文本结论。
   * `?? []` 不能省 —— 老接口返回的旧 draft 里没有这个字段。
   */
  const chain = draft?.chain ?? [];
  /** 可多行同时展开（I-28） */
  const [openLocs, setOpenLocs] = useState<string[]>([]);
  /**
   * 重置的二次确认（2026-11-23）：弹框里先列清会失去哪几条。
   * 切事件时本组件随 `key={active.id}` 重挂，自动收起。
   */
  const [resetConfirm, setResetConfirm] = useState(false);
  /** 危险动作的默认出口必须安全：Esc = 取消，不执行重置 */
  useEffect(() => {
    if (!resetConfirm) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setResetConfirm(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [resetConfirm]);
  /** 编辑态（2026-11-23 · 人工校正） */
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editSession, setEditSession] = useState(0);

  /** dirty 上抛：只在本组件内保真，父级拿它做切事件拦截 */
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // 部分浏览器要求设置 returnValue 才弹确认
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /*
   * D-02 / D-03：无草稿且无已确认位置 → 整卡不渲染。
   * 例外：用户刚点了「AI 分析」（startSignal > 0）时必须渲染 —— 否则信号没有接收者，
   * 点了没反应，连"启动失败"的报错都没地方显示（真机 2026-11-17）。
   */
  if (!draft && confirmed.length === 0 && startSignal === 0) return null;

  const chip = chipOf(analysis);
  const running = draft?.status === 'running';
  const edited = draft?.editedAt !== undefined;
  /** 结论来源（2026-11-23 · REQ-20261123-009）：缺省 = AI 在线分析 */
  const isExternal = draft?.source === 'external';
  /** 兜底：外部产物理论上必带三个集合，但缺字段不能让整卡崩（S-03 §7） */
  const unconfirmed = draft?.unconfirmed ?? [];
  /** 已确认位置里属于**上一版结论**的条数（外部重传会保留 confirmed，不提示会被误读） */
  const staleConfirmed = draft ? confirmed.filter((c) => c.confirmedAt < draft.startedAt).length : 0;
  /** 有东西可清才出「重置分析」（运行中也算"有"，但按钮禁用） */
  const hasResettable = Boolean(draft) || confirmed.length > 0;
  const canEdit = canWrite && !busy && !running;
  /**
   * 确认条里的清点**必须在发请求前算好** —— 请求成功回来这里已经什么都没有了。
   * 老数据可能只有纯文本结论（没有 `chain`），按"1 段文本"计，不要显示"结论 0 个节点"。
   */
  const unconfirmedCount = unconfirmed.length;
  const resetItems = [
    chain.length > 0 ? `结论 ${chain.length} 个节点` : draft?.conclusion ? '结论 1 段文本' : '',
    unconfirmedCount > 0 ? `未确认点 ${unconfirmedCount} 项` : '',
    confirmed.length > 0 ? `已确认代码位置 ${confirmed.length} 处` : '',
  ].filter((item) => item !== '');

  return (
    <section className={`gov-dcard gov-dcard--analysis${running ? ' gov-dcard--live' : ''}${editing ? ' gov-dcard--editing' : ''}`}>
      <div className="gov-dcard__head">
        <span className="gov-dcard__icon" aria-hidden="true">✦</span>
        <span className="gov-dcard__title">AI 分析</span>
        <span className="gov-dcard__hint">基于事件描述与类型，分析原因与结论</span>
        <span className="gov-dcard__actions">
          {editing ? (
            <span className="gov-dchip gov-dchip--warn">编辑中</span>
          ) : (
            <>
              {/* 编辑入口（2026-11-23）：放最左，与「先动作后状态」一致 */}
              {draft ? (
                <button
                  type="button"
                  className="gov-btn gov-btn--sm"
                  disabled={!canEdit}
                  title={!canWrite ? readOnlyHint : running ? '分析进行中：先「停止」或等完成再编辑' : '人工校正结论 / 未确认点 / 已确认位置'}
                  onClick={() => { setEditSession((n) => n + 1); setEditing(true); }}
                >
                  编辑
                </button>
              ) : null}
              {/*
               * 重置入口（2026-11-23）：运行中只禁用不隐藏 —— 隐藏会让人以为功能没了；
               * 禁用时用 title 指向该怎么做（先停止）。只读 / 视图 scope 同样禁用。
               */}
              {hasResettable ? (
                <button
                  type="button"
                  className="gov-btn gov-btn--sm gov-btn--danger-ghost"
                  disabled={busy || !canWrite || running}
                  title={!canWrite
                    ? readOnlyHint
                    : running
                      ? '分析进行中：先「停止」或等完成再重置'
                      : '清空本次 AI 分析的结论与已确认的代码位置（不可恢复）'}
                  onClick={() => setResetConfirm(true)}
                >
                  重置分析
                </button>
              ) : null}
              {/*
                走查 #5：追问补丁与人工校正都写 `editedAt`，外部来源时标「已人工修订」会让人
                以为"是某个人手改的"。第二轮优化后「已修订」已并入来源 chip（见 `chipOf`），
                这里只在 **AI 来源**渲染独立徽标，避免两个标签并排。
              */}
              {edited && !isExternal ? (
                <span className="gov-dchip gov-dchip--ok" title="这三块由人工改过（不是 AI 原文）">
                  已人工修订
                </span>
              ) : null}
              <span className={`gov-dchip gov-dchip--${chip.tone}`} title={chip.title}>{chip.text}</span>
            </>
          )}
        </span>
      </div>

      {/* 来源行（2026-11-23 · REQ-20261123-009）：标题已固定「AI 分析」，据此说明结论是谁产出的 */}
      {draft ? (
        <div className="gov-dcard__source">
          {isExternal
            ? `来源 ${draft.sourceClient && draft.sourceClient !== 'mcp' ? draft.sourceClient : 'MCP'} · 上传于 ${fmtStamp(draft.importedAt)}`
              /*
               * 走查 #3：外部结论被人改过 / 追问补丁改过后，只写「上传于」会让人以为
               * 最近一次改动就是上传；追加修订时间，保留两个事实。
               */
              + (draft.editedAt !== undefined ? ` · 修订于 ${fmtStamp(draft.editedAt)}` : '')
            /*
             * 第二轮优化：人工修订会把 `updatedAt` 一起推到修订时间，原「完成于 updatedAt」
             * 会变成"完成时间 == 修订时间"的假信息。所以有 `editedAt` 时只说「修订于」，
             * 不假装那还是完成时间。
             */
            : draft.editedAt !== undefined
              ? `来源 AI 在线分析 · 修订于 ${fmtStamp(draft.editedAt)}`
              : `来源 AI 在线分析 · 完成于 ${fmtStamp(draft.updatedAt)}`}
        </div>
      ) : null}

      <div className="gov-dcard__body">
        {editing ? (
          <AnalysisEditor
            key={editSession}
            scope={scope}
            eventId={event.id}
            draft={draft}
            confirmed={confirmed}
            /*
             * 结论只读（H12）：人不能改结论，改结论只能去追问、由 AI 给新结论再确认。
             * 这里保留只读展示，是为了编辑时还能对照"AI 说了什么"，否则改位置只能靠记忆。
             */
            conclusionBlock={(
              <div className="gov-dedit__block">
                <div className="gov-dedit__head"><span>分析结论（只读）</span></div>
                <p className="gov-dedit__note">结论由 AI 生成；如需修改请追问，AI 会给出新结论由你确认。</p>
                {chain.length > 0 ? (
                  <ConclusionChain
                    summary={draft?.conclusion ?? null}
                    chain={chain}
                    confirmed={confirmed}
                    view={analysisView}
                  />
                ) : draft?.conclusion ? (
                  <p className="gov-conclusion__text">{draft.conclusion}</p>
                ) : (
                  <p className="gov-conclusion__text gov-conclusion__text--empty">当前没有结论。</p>
                )}
                {/* 数据链路（2026-11-24）：编辑态也照常只读展示 —— 它和结论一样不可手改，
                    改成输入框就得配校验与后端写入，不在本次范围（H12 只放开未确认点与位置）。 */}
                <DataFlowBlock dataFlow={draft?.dataFlow} source={draft?.source} />
              </div>
            )}
            saving={saving}
            onSavingChange={setSaving}
            onDirtyChange={setDirty}
            onCancel={() => { setDirty(false); setEditing(false); }}
            onSaved={(next) => {
              setDirty(false);
              setEditing(false);
              /*
               * 只覆盖 draft / confirmed —— `resumeAvailable` 必须从原 analysis 带过来。
               * 直接 `next as EventAnalysis` 会把它丢掉，导致"保存一次人工修改后
               * 「继续分析」入口凭空消失"，要刷新才回来。
               */
              onUpdated({
                ...(analysis ?? { draft: null, confirmed: [] }),
                draft: next.draft,
                confirmed: next.confirmed,
              });
            }}
          />
        ) : (
          <>
            {/*
             * 结论区三态（R-11 / R-14）：从未分析（整卡不渲染）/ AI 没找到 / 已人工清空。
             * 「已人工清空」必须显式说明，否则用户看到「未定位到可证实的代码位置」会以为
             * 自己的修改没保存上。
             */}
            {chain.length > 0 ? (
              <ConclusionChain
                summary={draft?.conclusion ?? null}
                chain={chain}
                confirmed={confirmed}
                view={analysisView}
              />
            ) : draft?.conclusion ? (
              <div className="gov-conclusion">
                <div className="gov-conclusion__head">分析结论</div>
                <p className="gov-conclusion__text">{draft.conclusion}</p>
              </div>
            ) : draft && !running && draft.status !== 'failed' ? (
              <div className="gov-conclusion">
                <div className="gov-conclusion__head">分析结论</div>
                <p className="gov-conclusion__text gov-conclusion__text--empty">
                  {edited
                    ? '已人工清空结论。可重新分析生成，或用「重置分析」彻底清掉本次记录。'
                    : '未定位到可证实的代码位置。已排查的方向与缺的证据记在下方「未确认点」里。'}
                </p>
              </div>
            ) : null}

            {/*
             * 数据链路（2026-11-24 · REQ-20261124-001）：与「分析结论」「未确认点」**三者并列**，
             * 不嵌在紫色结论壳里 —— 结论是 AI 的判断，链路是客观路径，混在一个壳里会读成同一件事。
             * 无值时由组件自己决定：外部上传给占位块，老数据（AI 来源）整块不渲染。
             */}
            <DataFlowBlock dataFlow={draft?.dataFlow} source={draft?.source} />

            {/*
             * 未确认点：独立区块，**不随过程区折叠、也不随已确认消失**（2026-11-18 用户反馈）。
             * 人工清空后给占位说明（有 editedAt 才说"已清空"，否则沿用"整块不渲染"）。
             */}
            {draft && draft.status !== 'running' && (unconfirmed.length > 0 || (edited && unconfirmed.length === 0)) ? (
              <div className="gov-unconfirmed">
                <div className="gov-unconfirmed__head">
                  未确认点 · {unconfirmed.length} 项
                </div>
                {unconfirmed.length > 0 ? (
                  <ul className="gov-unconfirmed__list">
                    {unconfirmed.map((item, i) => (
                      <li key={`unconfirmed-${i}`}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="gov-unconfirmed__empty">已人工清空未确认点</p>
                )}
              </div>
            ) : null}

            {confirmed.length > 0 ? (
              <div className="gov-confirmed">
                <div className="gov-confirmed__head">
                  已确认的相关位置 · {confirmed.length} 处
                  {staleConfirmed > 0 ? (
                    <span className="gov-confirmed__note">
                      {/*
                        第二轮优化：「含 N 处」在**全部**都来自上一版时会读成"还有本版的"，
                        那种情况直接说「均为」，语义不留歧义。
                      */}
                      {staleConfirmed === confirmed.length
                        ? '（均为上一版结论确认的位置）'
                        : `（含 ${staleConfirmed} 处来自上一版结论）`}
                    </span>
                  ) : null}
                </div>
                <div className="gov-codelist">
                  {confirmed.map((loc) => (
                    <CodeLocRow
                      key={loc.id}
                      loc={loc}
                      open={openLocs.includes(loc.id)}
                      onToggle={() => setOpenLocs((prev) => (prev.includes(loc.id) ? prev.filter((x) => x !== loc.id) : [...prev, loc.id]))}
                      canRemove={!busy && canWrite}
                      onRemove={() => onRemoveLocation(loc)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* 无草稿但刚点了「AI 分析」：也要挂载面板，由它发起并在失败时显示原因 */}
            {draft || startSignal > 0 ? (
              <AiAnalyzePanel
                scope={scope}
                event={event}
                analysis={analysis}
                canWrite={canWrite}
                startSignal={startSignal}
                onUpdated={onUpdated}
                onOpenSettings={onOpenSettings}
              />
            ) : null}

            {/* 追问区：运行中不渲染；无历史且非终态时父级本就不会挂载卡片（Q10 / H-11） */}
            {draft && (draft.status === 'ready' || draft.status === 'partial') ? (
              <AskBlock
                scope={scope}
                eventId={event.id}
                canAsk={canAsk}
                canWrite={canWrite}
                activeRunId={draft.runId}
                /* 补丁覆盖成功后刷新卡面；`resumeAvailable` 从原 analysis 带过来（见 onSaved 的注释） */
                onAnalysisUpdated={(next) => onUpdated({
                  ...(analysis ?? { draft: null, confirmed: [] }),
                  draft: next.draft,
                  confirmed: next.confirmed,
                })}
              />
            ) : null}
          </>
        )}
      </div>

      {/*
       * 重置的二次确认弹框（2026-11-23，用户指定用弹框）：沿用治理页既有的
       * `.gov-modal-mask` / `.gov-modal`（与上传、选文档同款），不引入新样式域。
       */}
      {resetConfirm ? (
        <div className="gov-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setResetConfirm(false); }}>
          <div className="gov-modal">
            <div className="gov-modal__head">重置 AI 分析</div>
            <div className="gov-modal__body">
              <p className="gov-error">
                重置会清空本次分析的全部产物
                {resetItems.length > 0 ? `：${resetItems.join(' · ')}` : ''}
                ，且不可恢复。
              </p>
              <p className="gov-hint">分析断点与这次的追问记录也会一并清空。</p>
            </div>
            <div className="gov-modal__foot">
              <button type="button" className="gov-btn gov-btn--sm" onClick={() => setResetConfirm(false)}>
                取消
              </button>
              <button
                type="button"
                className="gov-btn gov-btn--sm gov-btn--danger"
                disabled={busy}
                onClick={() => {
                  // 先关弹框：请求失败时由父级 run() 给错误提示，不该留一个"已点过"的弹框
                  setResetConfirm(false);
                  onReset();
                }}
              >
                确认重置
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
