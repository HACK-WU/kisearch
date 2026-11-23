import { useEffect } from 'react';
import type { AskProposalEvent } from '@/api/governanceApi';

/**
 * 「AI 建议更新分析结论」弹框（2026-11-23 · S03 批 5）。
 *
 * 三条不可退让的规则：
 * 1. **不自动覆盖**：结论只能由用户点「确认覆盖」才变（需求 §2.2-10）；
 * 2. **不合规不给确认**：`valid:false` 时只读展示原因（N14），避免把不合规内容写进草稿；
 * 3. **失败不关框**：409 / 网络错误时差异必须留在屏幕上（N15），用户可复制后再决定。
 */
export interface AnalysisProposalModalProps {
  proposal: AskProposalEvent;
  /** 只有写权限才能确认覆盖；viewer 只能看差异（N18） */
  canWrite: boolean;
  saving: boolean;
  /** 覆盖失败的错误（409 冲突 / 网络），弹框不关、差异不丢 */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AnalysisProposalModal(props: AnalysisProposalModalProps): JSX.Element {
  const { proposal, canWrite, saving, error, onConfirm, onCancel } = props;

  // 危险动作的默认出口必须安全：Esc = 保留当前
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, saving]);

  const blocks = proposal.diff?.blocks ?? [];
  const canConfirm = proposal.valid && canWrite && !saving;

  return (
    <div className="gov-modal-mask" onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
      <div className="gov-modal">
        <div className="gov-modal__head">AI 建议更新分析结论</div>
        <div className="gov-modal__body">
          {proposal.valid ? (
            <>
              <p className="gov-hint">这轮追问的结论与当前不一致，AI 建议改为：</p>
              <div className="gov-pdiff">
                {blocks.map((b, i) => (
                  <div className="gov-pdiff__row" key={`${b.block}-${b.kind}-${i}`}>
                    <span className={`gov-pdiff__kind gov-pdiff__kind--${b.kind === '改' ? 'edit' : b.kind === '增' ? 'add' : 'del'}`}>
                      {b.block === 'conclusion' ? '总结' : '节点'}·{b.kind}
                    </span>
                    <span className="gov-pdiff__text">
                      {b.before ? <del>{b.before}</del> : null}
                      {b.after ? <ins>{b.after}</ins> : null}
                    </span>
                  </div>
                ))}
              </div>
              {proposal.patch?.reason ? (
                <p className="gov-hint">AI 的理由：{proposal.patch.reason}</p>
              ) : null}
              <p className="gov-hint">校验：✅ 符合该事件类型的结论模板</p>
            </>
          ) : (
            <>
              <p className="gov-error">
                AI 给了结论建议，但**不符合该事件类型的模板**，不会写入：
              </p>
              <ul className="gov-pdiff__reasons">
                {(proposal.reasons ?? [proposal.reason ?? '原因未知']).map((r) => <li key={r}>{r}</li>)}
              </ul>
              <p className="gov-hint">可以按上面的提示手动调整，或再追问一次让它自己修正。</p>
            </>
          )}

          {proposal.valid ? (
            <p className="gov-hint">覆盖后这条结论会标记为「已人工修订」；已确认的代码位置不受影响。</p>
          ) : null}

          {!canWrite && proposal.valid ? (
            <p className="gov-hint">当前账号没有写权限（knowledge.write），只能查看建议。</p>
          ) : null}
          {error ? <p className="gov-error">{error}</p> : null}
        </div>
        <div className="gov-modal__foot">
          <button type="button" className="gov-btn gov-btn--sm" disabled={saving} onClick={onCancel}>
            保留当前
          </button>
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={!canConfirm}
            title={!canWrite ? '需要写权限' : !proposal.valid ? '建议不合规，不能覆盖' : undefined}
            onClick={onConfirm}
          >
            {saving ? '覆盖中…' : '确认覆盖'}
          </button>
        </div>
      </div>
    </div>
  );
}
