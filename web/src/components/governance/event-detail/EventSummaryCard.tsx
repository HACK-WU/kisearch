import { useCallback, useLayoutEffect, useRef } from 'react';
import type { EventSummaryCardProps } from './types';

/**
 * 事件概要卡（含事件描述内联编辑）。
 *
 * 检查点：A-05/B-01~B-09/C-01~C-15。
 * - 动作区顺序固定：`[置顶｜取消置顶] [AI 分析] [重新打开｜流转] [删除事件]`（C-05，
 *   2026-11-19 在最左追加置顶开关：它是「列表偏好」，比其它动作优先级低、破坏性也低，
 *   放最左既不打乱主操作的位置，也不会让「删除事件」离「流转」更远）。
 * - 描述并入本卡（C-06），编辑态由父级 `descEdit` 承载（C-12：输入不丢焦点）。
 * - 未分析时给一行入口引导（C-15）——现状那句引导在「代码位置」空态里，改版后该段并入分析卡会消失。
 * - 描述编辑框高度随内容自适应（2026-11-24 用户反馈：读态整段展开，点「编辑」后塌成 4 行看不全）。
 */
export function EventSummaryCard(props: EventSummaryCardProps) {
  const {
    event, typeName, stageName, memberCount, refCount, closed, pinned, canWrite, busy, delConfirm,
    descEdit, stageSlot, showAnalyzeGuide,
    onAnalyze, onTogglePin, onReopen, onDelete, onTransition,
    onDescEdit, onDescChange, onDescSave, onDescCancel,
  } = props;

  const readOnlyTitle = canWrite ? undefined : '只读账号无法修改事件';

  /**
   * 「事件描述」编辑框高度跟随内容（2026-11-24 用户反馈：读态整段展开，点「编辑」后塌成 4 行）。
   *
   * · 先归零再按 `scrollHeight` 设高：高度随内容**可增可减**（不归零则删掉几行后收不回去）。
   *   下限由 `rows={4}` 的内在高度决定，不是 CSS 的 `min-height:76px` —— textarea 的
   *   `scrollHeight` 不会小于自身内容盒高度，所以短描述停在 4 行（chromium 实测 95px，
   *   该值低于 76px 以下的场景才轮到 min-height 兜）。长描述则完全由内容撑开，无内部滚动。
   * · 补边框差：全局 `box-sizing: border-box` 下 `scrollHeight` 不含上下边框，直接赋值会少 2px
   *   让最后一行被裁 —— 用此刻的 `offsetHeight - clientHeight`（只剩边框）补齐。
   *   实测（chromium，960px 宽）：1179 字读态 246px / 编辑态 248px，4000 字 805px，溢出恒 0。
   * · 挂载即校准：编辑态是条件渲染，textarea 每次重新挂到 DOM 时 `rows={4}` 先生效，
   *   ref 回调里立刻补一次，才不会闪一下再撑开。
   * · 宽度变化（窗口缩放、侧栏收展）会改变折行数 → ResizeObserver 兜底；回调里只比较宽度，
   *   否则改高度同样会触发回调、自激循环（与 ChatPanel 输入区同一口径）。
   */
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const descRoRef = useRef<ResizeObserver | null>(null);
  const syncDescHeight = useCallback(() => {
    const ta = descRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + (ta.offsetHeight - ta.clientHeight)}px`;
  }, []);
  const bindDesc = useCallback((el: HTMLTextAreaElement | null) => {
    // 重挂载 / 卸载：先断旧观察器，避免观察已移除的节点
    descRoRef.current?.disconnect();
    descRoRef.current = null;
    descRef.current = el;
    if (!el) return;
    syncDescHeight();
    if (typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      syncDescHeight();
    });
    ro.observe(el);
    descRoRef.current = ro;
  }, [syncDescHeight]);
  // 内容驱动（含输入、取消后再进编辑的初值回填、切事件后描述变化）
  useLayoutEffect(() => {
    if (descEdit.open) syncDescHeight();
  }, [descEdit.open, descEdit.draft, syncDescHeight]);

  return (
    <section className="gov-dcard gov-dcard--summary">
      <div className="gov-dcard__head">
        <span className="gov-dcard__icon" aria-hidden="true">◈</span>
        <span className="gov-dcard__title">事件概要</span>
        <span className="gov-dcard__hint">阶段与可见性决定这些文档能被谁搜到</span>
        <span className="gov-dcard__actions">
          {/*
            置顶开关（2026-11-19）。`aria-pressed` 而不是两套按钮：
            它是一个状态开关，屏幕阅读器要能读出「当前已置顶」，而不是听到两个不同动作。
            文案在置顶后变「取消置顶」—— 只说「已置顶」会让人不知道点了会怎样。
          */}
          <button
            type="button"
            className={`gov-btn gov-btn--sm${pinned ? ' gov-btn--pinned' : ''}`}
            aria-pressed={pinned}
            disabled={busy || !canWrite}
            title={readOnlyTitle ?? (pinned
              ? '取消置顶：恢复为跟随筛选与排序'
              : '置顶：无论列表选哪种筛选 / 排序，它都排在列表最前')}
            onClick={onTogglePin}
          >
            <svg className="gov-btn__pin" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
            </svg>
            {pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--ai"
            disabled={busy || !canWrite}
            title={readOnlyTitle ?? '基于事件描述与类型，分析并定位相关代码位置'}
            onClick={onAnalyze}
          >
            <svg className="gov-btn--ai__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M6.4 1.6c.28 2.4 1.72 3.84 4.12 4.12-2.4.28-3.84 1.72-4.12 4.12C6.12 7.44 4.68 6 2.28 5.72 4.68 5.44 6.12 4 6.4 1.6Z" />
              <path d="M11.9 9.2c.17 1.45 1.05 2.33 2.5 2.5-1.45.17-2.33 1.05-2.5 2.5-.17-1.45-1.05-2.33-2.5-2.5 1.45-.17 2.33-1.05 2.5-2.5Z" opacity=".62" />
            </svg>
            AI 分析
          </button>
          {closed ? (
            <button type="button" className="gov-btn gov-btn--sm" disabled={busy || !canWrite} title={readOnlyTitle ?? '重新打开事件：成员需重新绑定'} onClick={onReopen}>
              重新打开
            </button>
          ) : (
            <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" disabled={busy || !canWrite} title={readOnlyTitle} onClick={onTransition}>
              流转
            </button>
          )}
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--danger-ghost"
            disabled={busy || !closed || !canWrite}
            title={!canWrite ? readOnlyTitle : closed ? '删除事件：关联文档改为长期保留' : '事件未收口不能删除，先流转到末位阶段'}
            onClick={onDelete}
          >
            {delConfirm ? '确认删除事件（不可恢复）' : '删除事件'}
          </button>
        </span>
      </div>

      <div className="gov-dcard__body">
        <div className="gov-summary__head">
          {/* 编号与标题分离：UI 里只显示裸数字，`#` 退到 title / aria-label，
              纯文本流仍用 `#38` 以便 AI 与人共同指代同一条事件 */}
          <span
            className="gov-summary__id"
            title={`事件 #${event.shortId}`}
            aria-label={`事件 #${event.shortId}`}
          >
            {event.shortId}
          </span>
          <div className="gov-summary__title">{event.title}</div>
        </div>
        <div className="gov-summary__meta">
          <span>{typeName}</span>
          <span className="gov-summary__dot">·</span>
          <span>当前「{stageName}」</span>
          <span className="gov-summary__dot">·</span>
          <span>关联 {memberCount} 篇</span>
          <span className="gov-summary__dot">·</span>
          <span>参考 {refCount} 篇</span>
        </div>

        {stageSlot}

        <div className="gov-summary__desc">
          <div className="gov-summary__desc-head">
            <span className="gov-summary__desc-title">事件描述</span>
            <span className="gov-dcard__hint">会进入 AI 分析上下文</span>
            <span style={{ flex: 1 }} />
            {descEdit.open ? null : (
              <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" disabled={busy || !canWrite} title={readOnlyTitle} onClick={onDescEdit}>
                编辑
              </button>
            )}
          </div>
          {descEdit.open ? (
            <div className="gov-desc-edit">
              <textarea
                className="gov-textarea gov-textarea--fit"
                rows={4}
                maxLength={4000}
                placeholder="补充事件现象、报错原文、复现条件等…"
                value={descEdit.draft}
                autoFocus
                ref={bindDesc}
                onChange={(e) => onDescChange(e.target.value)}
              />
              <div className="gov-desc-edit__foot">
                <span className="gov-hint">{descEdit.draft.trim().length} / 4000</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="gov-btn gov-btn--sm" onClick={onDescCancel}>取消</button>
                <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" disabled={busy || descEdit.saving} onClick={onDescSave}>保存</button>
              </div>
            </div>
          ) : event.description?.trim() ? (
            <p className="gov-desc-text">{event.description}</p>
          ) : (
            <div className="gov-cell-muted">暂无描述 —— 补充现象与报错原文能明显提升 AI 分析的准确度</div>
          )}
        </div>

        {showAnalyzeGuide ? (
          <p className="gov-inline-tip">想让 AI 定位相关代码？点右上「AI 分析」，会读取配置的目标目录并给出候选位置。</p>
        ) : null}
      </div>
    </section>
  );
}
