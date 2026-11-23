import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisDraft, ConfirmedCodeLocation } from '@/api/governanceApi';
import { saveEventAnalysisEdits } from '@/api/governanceApi';

/**
 * 人工校正编辑器（2026-11-23 · REQ-20261123-001 · S02）
 *
 * **v5（H12）起只管两块**：未确认点、已确认位置。
 * 结论（summary + chain）**不可人工编辑** —— 它只能由「追问补丁 + 用户确认」覆盖（S03），
 * 因此这里既没有总结输入框，也没有因果链编辑；顶部只是原样展示只读结论（由卡片渲染传入）。
 *
 * 保存仍是**整块提交**：只发 `unconfirmed` + `confirmed`，`expectedRunId` 取当前 runId。
 * 失败一律停在编辑态并保留输入 —— 用户写了半天不该因为一次 409 就白写。
 */

interface AddRow {
  key: string;
  file: string;
  line: string;
  why: string;
}

export interface AnalysisEditorProps {
  scope: string;
  eventId: string;
  /** 只读：用于取并发基准 `runId` 与「未确认点」的初值 */
  draft: AnalysisDraft | null;
  confirmed: ConfirmedCodeLocation[];
  /** 只读结论块（卡片渲染，含引导语） */
  conclusionBlock: ReactNode;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onCancel: () => void;
  onSaved: (next: { draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }) => void;
  /** dirty 上抛（切事件 / 关页拦截用） */
  onDirtyChange?: (dirty: boolean) => void;
}

/** 与后端 `analysis-edit.ts` 同口径（超限由后端报错定位） */
const UNCONFIRMED_ITEM_MAX = 300;
const UNCONFIRMED_MAX_ITEMS = 20;
const MANUAL_LOCATION_WHY_MAX = 200;

let seq = 0;
const nextKey = (): string => `k${++seq}`;

export function AnalysisEditor(props: AnalysisEditorProps): JSX.Element {
  const {
    scope, eventId, draft, confirmed, conclusionBlock,
    saving, onSavingChange, onCancel, onSaved, onDirtyChange,
  } = props;

  const [unconfirmed, setUnconfirmed] = useState<string[]>(() => [...(draft?.unconfirmed ?? [])]);
  const [adds, setAdds] = useState<AddRow[]>([]);
  const [whyEdits, setWhyEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  /** 基线：只比未确认点；不改就不发请求 */
  const baseline = useRef(JSON.stringify(draft?.unconfirmed ?? []));

  const addRows = adds.filter((r) => r.file.trim() !== '' || r.why.trim() !== '');
  const whyUpdates = Object.entries(whyEdits).filter(([id, why]) => {
    const base = confirmed.find((c) => c.id === id);
    return base && base.why !== why;
  });

  const changedBlocks = useMemo(() => {
    let count = 0;
    if (JSON.stringify(JSON.parse(baseline.current)) !== JSON.stringify(unconfirmed)) count += 1;
    return count + addRows.length + whyUpdates.length;
  }, [unconfirmed, addRows.length, whyUpdates.length]);

  const dirty = changedBlocks > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const onSave = async (): Promise<void> => {
    if (saving) return;
    setError('');
    /*
     * 只发这两块：结论与因果链**不传**（D3「未提供的块保持原值」）。
     * 这样即便接口仍接受 `conclusion`，前端也不会有第二条改结论的路径。
     */
    const payload = {
      expectedRunId: draft?.runId ?? null,
      unconfirmed: unconfirmed.map((t) => t.trim()).filter(Boolean),
      ...(addRows.length > 0 || whyUpdates.length > 0
        ? {
          confirmed: {
            ...(addRows.length > 0
              ? {
                add: addRows.map((r) => ({
                  file: r.file.trim(),
                  line: Number(r.line),
                  why: r.why.trim(),
                })),
              }
              : {}),
            ...(whyUpdates.length > 0 ? { update: whyUpdates.map(([id, why]) => ({ id, why })) } : {}),
          },
        }
        : {}),
    };
    onSavingChange(true);
    try {
      const res = await saveEventAnalysisEdits(scope, eventId, payload);
      onSaved({ draft: res.draft, confirmed: res.confirmed });
    } catch (err) {
      // 停在编辑态、保留全部输入（N3 / N8 / N12）
      setError((err as Error).message);
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <div className="gov-dedit">
      {conclusionBlock}

      {error ? <div className="gov-ai-error"><span>{error}</span></div> : null}

      <div className="gov-dedit__block">
        <div className="gov-dedit__head">
          <span>未确认点 · {unconfirmed.length}/{UNCONFIRMED_MAX_ITEMS} 项</span>
          <button
            type="button"
            className="gov-btn gov-btn--ghost gov-btn--sm"
            disabled={saving || unconfirmed.length >= UNCONFIRMED_MAX_ITEMS}
            onClick={() => setUnconfirmed((prev) => [...prev, ''])}
          >
            + 添加一条
          </button>
        </div>
        {unconfirmed.length === 0 ? <p className="gov-dedit__empty">暂无未确认点（留空保存即清空）</p> : null}
        {unconfirmed.map((item, index) => (
          <div className="gov-dedit__node" key={`u-${index}`}>
            <input
              className="gov-dedit__input"
              value={item}
              maxLength={UNCONFIRMED_ITEM_MAX}
              disabled={saving}
              placeholder="还没查清的点"
              onChange={(e) => {
                const text = e.target.value;
                setUnconfirmed((prev) => prev.map((v, i) => (i === index ? text : v)));
              }}
            />
            <span className="gov-dedit__ops">
              <button
                type="button"
                className="gov-btn gov-btn--ghost gov-btn--sm"
                disabled={saving}
                title="删除该条"
                onClick={() => setUnconfirmed((prev) => prev.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="gov-dedit__block">
        <div className="gov-dedit__head">
          <span>已确认位置 · {confirmed.length} 处</span>
          <button
            type="button"
            className="gov-btn gov-btn--ghost gov-btn--sm"
            disabled={saving}
            onClick={() => setAdds((prev) => [...prev, { key: nextKey(), file: '', line: '', why: '' }])}
          >
            + 手工添加
          </button>
        </div>
        {confirmed.map((loc) => (
          <div className="gov-dedit__node" key={loc.id}>
            <span className="gov-codeloc__path">{loc.file}:{loc.line}{loc.endLine ? `-${loc.endLine}` : ''}</span>
            <input
              className="gov-dedit__input"
              value={whyEdits[loc.id] ?? loc.why}
              maxLength={MANUAL_LOCATION_WHY_MAX}
              disabled={saving}
              placeholder="这个位置为什么相关"
              onChange={(e) => setWhyEdits((prev) => ({ ...prev, [loc.id]: e.target.value }))}
            />
          </div>
        ))}
        {adds.map((row) => (
          <div className="gov-dedit__node" key={row.key}>
            <input
              className="gov-dedit__input gov-dedit__input--path"
              value={row.file}
              disabled={saving}
              placeholder="路径（相对代码根，如 src/a.ts）"
              onChange={(e) => setAdds((prev) => prev.map((r) => (r.key === row.key ? { ...r, file: e.target.value } : r)))}
            />
            <input
              className="gov-dedit__input gov-dedit__input--line"
              value={row.line}
              disabled={saving}
              placeholder="行号"
              onChange={(e) => setAdds((prev) => prev.map((r) => (r.key === row.key ? { ...r, line: e.target.value.replace(/[^\d]/g, '') } : r)))}
            />
            <input
              className="gov-dedit__input"
              value={row.why}
              maxLength={MANUAL_LOCATION_WHY_MAX}
              disabled={saving}
              placeholder="为什么相关"
              onChange={(e) => setAdds((prev) => prev.map((r) => (r.key === row.key ? { ...r, why: e.target.value } : r)))}
            />
            <span className="gov-dedit__ops">
              <button
                type="button"
                className="gov-btn gov-btn--ghost gov-btn--sm"
                disabled={saving}
                title="移除这一行"
                onClick={() => setAdds((prev) => prev.filter((r) => r.key !== row.key))}
              >
                ×
              </button>
            </span>
          </div>
        ))}
        <p className="gov-dedit__note">手工添加的位置会在保存时读真实文件验真（路径不存在或行号越界会被拒绝）。</p>
      </div>

      <div className="gov-dedit__foot">
        <span className="gov-dedit__dirty">
          {dirty ? `已修改 ${changedBlocks} 处 · 保存后追问与 MCP 读到的都是新值` : '未修改'}
        </span>
        <span className="gov-dedit__actions">
          <button type="button" className="gov-btn gov-btn--sm" disabled={saving} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" disabled={saving || !dirty} onClick={() => void onSave()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </div>
    </div>
  );
}
