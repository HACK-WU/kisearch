/**
 * 文档选择弹窗（关联文档 / 参考文档共用）
 *
 * 从 `EventsPage.AddRefModal` 抽出后参数化，两种模式只差文案与禁用口径：
 *   · `member`：挂到事件链路上，可见性随阶段变化（改 `lifecycle=event`）
 *   · `ref`：只建立引用，不改变文档分类与可见性
 *
 * 三条行为口径（走查踩过的坑，勿回退）：
 *   1. **空查询也发一次请求**：打开弹窗就列出可加入的前 N 篇，否则一片空白且无提示；
 *   2. **换一批结果 scrollTop 归零**：否则上一批的滚动位置会把首行裁半截；
 *   3. **已属其他未收口事件的候选禁用并标注**：后端仍兜底拒绝（409 语义），
 *      前端禁用只是让人提前看懂为什么不能选。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { searchRefDocs, type Visibility } from '../../api/governanceApi';

const VIS_TEXT: Record<Visibility, string> = {
  full: '语义+全文',
  'fts-only': '仅全文',
  hidden: '不可检索',
};

export type DocPickerMode = 'member' | 'ref';

export interface DocPickerRef {
  group: string;
  name: string;
}

export function DocPickerModal(args: {
  scope: string;
  mode: DocPickerMode;
  /** 该事件已有的（member → 关联文档；ref → 参考文档）；新建事件时传已选清单 */
  existing: DocPickerRef[];
  /** 已有事件时传：后端排除「已关联 + 已加入」 */
  eventId?: string;
  /** 另一侧已选的文档（前端剪枝：同一篇不能既是关联又是参考） */
  alsoPicked?: DocPickerRef[];
  busy?: boolean;
  onClose: () => void;
  onAdd: (docs: DocPickerRef[]) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{
    group: string;
    name: string;
    visibility: Visibility;
    event?: { id: string; shortId: number; title: string };
  }>>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keyOf = (h: { group: string; name: string }): string => `${h.group}/${h.name}`;
  const takenKeys = useMemo(
    () => new Set([...args.existing, ...(args.alsoPicked ?? [])].map(keyOf)),
    [args.existing, args.alsoPicked],
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  const isMember = args.mode === 'member';
  const title = isMember ? '添加关联文档' : '添加参考文档';
  const subtitle = isMember
    ? '按文档名或 Group 路径搜索知识库；加入后可见性随事件阶段变化'
    : '按文档名或 Group 路径搜索知识库';

  useEffect(() => {
    let alive = true;
    setSearching(true);
    const delay = q.trim() ? 250 : 0;
    const timer = window.setTimeout(() => {
      void searchRefDocs(args.scope, q.trim(), args.eventId)
        .then((r) => {
          if (!alive) return;
          setHits(r.hits);
          setErr(null);
          // 结果换了一批就剪掉"看不见的选中"，避免按钮说"加入 1 篇"却在列表里找不到
          setPicked((prev) => {
            const visible = new Set(r.hits.map(keyOf));
            const next = prev.filter((k) => visible.has(k));
            return next.length === prev.length ? prev : next;
          });
        })
        .catch((e: Error) => {
          if (!alive) return;
          setHits([]);
          setErr(e.message);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q, args.scope, args.eventId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [hits]);

  const toggle = (key: string): void => setPicked((prev) => (
    prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
  ));
  const pickedDocs: DocPickerRef[] = hits
    .filter((h) => picked.includes(keyOf(h)))
    .map((h) => ({ group: h.group, name: h.name }));

  return (
    <div className="gov-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) args.onClose(); }}>
      <div className="gov-modal">
        <div className="gov-modal__head gov-modal__head--stack">
          <div>{title}</div>
          <div className="gov-hint">{subtitle}</div>
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
              const already = takenKeys.has(key);
              const boundElsewhere = h.event !== undefined && h.event.id !== args.eventId;
              const disabled = already || boundElsewhere;
              return (
                <label key={key} className="gov-cand" data-added={disabled ? '' : undefined}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={already || picked.includes(key)}
                    onChange={() => toggle(key)}
                  />
                  <span>
                    <span className="gov-cand__name">{h.name}</span>
                    <span className="gov-cand__meta">
                      {h.group} · {VIS_TEXT[h.visibility]}
                      {already ? (isMember ? ' · 已关联' : ' · 已加入') : ''}
                      {!already && boundElsewhere && h.event ? ` · 已属 #${h.event.shortId}「${h.event.title}」` : ''}
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
                ? '没有匹配的文档（已排除已关联与已加入的参考文档）。若确信库里有，确认顶部 scope —— 事件与知识文档可能不在同一个库。'
                : `scope「${args.scope}」里没有可加入的文档：可能都已关联 / 已加入，或这个库本身没有文档。`}
            </span>
          ) : null}
          <span className="gov-hint">
            {isMember
              ? '加入后文档分类变为「事件」，可见性由当前阶段决定；移除即解绑（文档回到长期保留，不会被删除）。'
              : '只建立引用，不修改文档本身的分类与可见性。'}
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || pickedDocs.length === 0}
            onClick={() => {
              args.onClose();
              args.onAdd(pickedDocs);
            }}
          >
            {pickedDocs.length === 0 ? '未选择' : `加入所选 ${pickedDocs.length} 篇`}
          </button>
        </div>
      </div>
    </div>
  );
}
