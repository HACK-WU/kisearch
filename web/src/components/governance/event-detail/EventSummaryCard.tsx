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
 */
export function EventSummaryCard(props: EventSummaryCardProps) {
  const {
    event, typeName, stageName, memberCount, refCount, closed, pinned, canWrite, busy, delConfirm,
    descEdit, stageSlot, showAnalyzeGuide,
    onAnalyze, onTogglePin, onReopen, onDelete, onTransition,
    onDescEdit, onDescChange, onDescSave, onDescCancel,
  } = props;

  const readOnlyTitle = canWrite ? undefined : '只读账号无法修改事件';

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
                className="gov-textarea"
                rows={4}
                maxLength={4000}
                placeholder="补充事件现象、报错原文、复现条件等…"
                value={descEdit.draft}
                autoFocus
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
