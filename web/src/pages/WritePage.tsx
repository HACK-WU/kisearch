/**
 * WritePage.tsx —— 知识写入（关系写入 sync-relation）
 *
 * scope 必选（default 兜底，顶栏全局选择）
 * 关系写入：ki_sync_relation（group + relation + module_info + vector）
 *   → 写 relations-cache（Group 树）+ local KB + 可选向量层（ki-relation / ki-search）
 */

import { useEffect, useRef, useState } from 'react';
import { useScopeValue } from '@/lib/scopeContext';
import { kiSyncRelation } from '@/api/mcpClient';
import { fetchTags } from '@/api/httpApi';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { groupError, relationError, tagError, isInvalidTag } from '@/lib/validators';

export function WritePage(): JSX.Element {
  const scope = useScopeValue();
  const [preview, setPreview] = useState(false);
  const [vector, setVector] = useState(true);

  // relation 表单
  const [group, setGroup] = useState('');
  const [relation, setRelation] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // tag 选择器状态
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagInputErr, setTagInputErr] = useState<string | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const tagRef = useRef<HTMLDivElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 实时校验 group / relation（空字符串时不报错，避免初次进入显示错误）
  const groupErr = group.trim() ? groupError(group) : null;
  const relationErr = relation.trim() ? relationError(relation) : null;
  const hasFormError = !!groupErr || !!relationErr;

  // 点击外部关闭 tag combobox
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (tagRef.current && !tagRef.current.contains(e.target as Node)) setTagOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // 加载可用 tag 列表
  useEffect(() => {
    let cancelled = false;
    fetchTags(scope).then((res) => {
      if (!cancelled && res.ok) setAvailableTags(res.tags.map((t) => t.tag));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [scope]);

  const submit = async (): Promise<void> => {
    setError(null);
    setResult(null);
    if (!group.trim() || !relation.trim() || !markdown.trim()) {
      setError('Group、Relation、Module Info 均不能为空');
      return;
    }
    // 字符格式校验（与后端 isUnsafeRelationName / resolveGroupPath 对齐）
    const gErr = groupError(group);
    const rErr = relationError(relation);
    if (gErr || rErr) {
      setError(gErr || rErr);
      return;
    }
    setSubmitting(true);
    try {
      await kiSyncRelation({ scope, group: group.trim(), relation: relation.trim(), content: markdown, vector, tags: selectedTags });
      setResult(`写入成功${vector ? '' : '（未向量化）'}${selectedTags.length > 0 ? `（标签：${selectedTags.join(', ')}）` : ''}`);
      setGroup('');
      setRelation('');
      setMarkdown('');
      setSelectedTags([]);
      setTagInput('');
      setTagInputErr(null);
      setPreview(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTag = (tag: string): void => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  };

  const addTagFromInput = (): void => {
    const t = tagInput.trim().toLowerCase();
    if (!t) { setTagInputErr('Tag 不能为空'); return; }
    const err = tagError(t);
    if (err) { setTagInputErr(err); return; }
    if (selectedTags.includes(t)) { setTagInput(''); setTagInputErr(null); return; }
    setSelectedTags((prev) => [...prev, t]);
    setTagInput('');
    setTagInputErr(null);
    setTagOpen(false);
  };

  const removeTag = (tag: string): void => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  };

  const reset = (): void => {
    setGroup('');
    setRelation('');
    setMarkdown('');
    setSelectedTags([]);
    setTagInput('');
    setTagInputErr(null);
    setPreview(false);
    setResult(null);
    setError(null);
  };

  return (
    <>
      <div className="ki-page-head">
        <div>
          <h1>知识写入</h1>
          <p>sync-relation · 目标 scope：{scope}</p>
        </div>
      </div>

      <div className="ki-content-inner ki-write-layout">
        <div className="ki-card">
          <div className="ki-card__body" style={{ padding: 28 }}>
            <div className="ki-form-row">
              <div className="ki-form-group">
                <label className="ki-form-label">Group（文档分组）</label>
                <GroupPathSelect
                  scope={scope}
                  value={group}
                  onChange={setGroup}
                  placeholder="选择或输入 Group 路径，如：告警系统/告警收敛"
                  hint="斜杠分隔层级，下拉选择已有 Group 或直接输入新建。禁止包含 \\ 和 .."
                  error={groupErr}
                />
              </div>
              <div className="ki-form-group">
                <label className="ki-form-label">文档名称（Relation）</label>
                <input
                  className={`ki-form-input${relationErr ? ' ki-form-input--error' : ''}`}
                  placeholder="如：告警收敛策略"
                  value={relation}
                  onChange={(e) => setRelation(e.target.value)}
                  aria-invalid={relationErr ? true : undefined}
                />
                {relationErr ? (
                  <div className="ki-form-error">{relationErr}</div>
                ) : (
                  <div className="ki-form-hint">同 Group 内唯一；浏览页按此名显示文档。禁止包含 / / \ 和 ..</div>
                )}
              </div>
            </div>
            <div className="ki-form-group">
              <div className="ki-label-row">
                <label className="ki-form-label" style={{ marginBottom: 0 }}>
                  Module Info（Markdown 正文）
                </label>
                <button
                  type="button"
                  className={`ki-preview-btn${preview ? ' ki-preview-btn--active' : ''}`}
                  onClick={() => setPreview((v) => !v)}
                >
                  {preview ? '编辑' : '预览'}
                </button>
              </div>
              <div className="ki-md-editor">
                {preview ? (
                  <div className="ki-md-preview" style={{ height: 320 }}>
                    <div className="ki-markdown">
                      <MarkdownPreview text={markdown || '（空）'} />
                    </div>
                  </div>
                ) : (
                  <textarea
                    className="ki-form-textarea"
                    style={{ height: 320 }}
                    placeholder="## 标题&#10;&#10;正文…"
                    value={markdown}
                    onChange={(e) => setMarkdown(e.target.value)}
                  />
                )}
              </div>
            </div>

            {/* 自定义标签（可选） */}
            <div className="ki-form-group" style={{ marginTop: 14 }}>
              <label className="ki-form-label">Tags</label>
              {/* combobox：输入框 + 下拉 */}
              <div className="ki-combobox" ref={tagRef} style={{ width: '100%' }}>
                <div className="ki-combobox__input-wrap">
                  <input
                    className={`ki-form-input${tagInputErr ? ' ki-form-input--error' : ''}`}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    placeholder="选择已有 tag 或输入新建，回车确认"
                    value={tagInput}
                    onChange={(e) => { setTagInput(e.target.value); if (tagInputErr) setTagInputErr(null); }}
                    onFocus={() => setTagOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
                    }}
                    autoComplete="off"
                    aria-invalid={tagInputErr ? true : undefined}
                  />
                  <button
                    type="button"
                    className={`ki-combobox__toggle${tagOpen ? ' ki-combobox__toggle--open' : ''}`}
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); setTagOpen((v) => !v); }}
                  >
                    {tagOpen ? '▴' : '▾'}
                  </button>
                </div>
                {tagOpen && (
                  <div className="ki-combobox__panel ki-combobox__panel--open">
                    <div className="ki-combobox__tree" style={{ padding: '6px 8px', maxHeight: 180, overflowY: 'auto' }}>
                      {availableTags.length === 0 && !tagInput ? (
                        <div className="ki-cell-sub" style={{ padding: 6 }}>暂无已有 tag</div>
                      ) : (
                        <>
                          {availableTags
                            .filter((t) => !tagInput || t.includes(tagInput.toLowerCase()))
                            .map((t) => (
                              <span
                                key={t}
                                className={`ki-tag-option${selectedTags.includes(t) ? ' ki-tag-option--selected' : ''}`}
                                onClick={() => toggleTag(t)}
                              >
                                {selectedTags.includes(t) ? '✓ ' : '+ '}{t}
                              </span>
                            ))
                          }
                          {tagInput && !availableTags.some((t) => t === tagInput.toLowerCase()) && !selectedTags.includes(tagInput.toLowerCase()) && (
                            <span className="ki-tag-option" onClick={addTagFromInput} style={{ color: 'var(--ki-color-primary)' }}>
                              ✚ 新建：{tagInput.trim()}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <div className="ki-combobox__footer">
                      <span className="ki-cell-sub">输入后按回车确认；新建 tag 将自动加入</span>
                    </div>
                  </div>
                )}
              </div>
              {/* 已选 tag pills（独立行） */}
              {selectedTags.length > 0 && (
                <div className="ki-tag-pills" style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {selectedTags.map((t) => (
                    <span key={t} className="ki-tag-pill">
                      {t}
                      <span className="ki-tag-pill__x" onClick={() => removeTag(t)}>✕</span>
                    </span>
                  ))}
                </div>
              )}
              {tagInputErr ? (
                <div className="ki-form-error">{tagInputErr}</div>
              ) : (
                <div className="ki-form-hint">点击选择已有 tag，或输入新 tag 后回车创建。禁止包含 , / \ 和 ..</div>
              )}
            </div>

            {/* 是否向量化 */}
            <div className="ki-vec-switch" style={{ marginTop: 12 }}>
              <div className="ki-vec-switch__label">
                <span className="ki-vec-switch__title">向量化</span>
                <span className="ki-vec-switch__desc">写入向量库，可被语义搜索；关闭则仅写入 KB 文本</span>
              </div>
              <div
                className={`ki-switch${vector ? ' ki-switch--on' : ''}`}
                role="switch"
                aria-checked={vector}
                onClick={() => setVector((v) => !v)}
              >
                <div className="ki-switch__knob" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 20 }}>
              <button
                className="ki-btn ki-btn--primary"
                onClick={() => void submit()}
                disabled={submitting || hasFormError}
              >
                {submitting ? '保存中…' : '保存'}
              </button>
              <button className="ki-btn ki-btn--secondary" onClick={reset}>
                清空
              </button>
              {result && (
                <span className="ki-cell-sub" style={{ color: 'var(--ki-color-success)' }}>
                  ✅ {result}
                </span>
              )}
            </div>

            {error && (
              <div className="ki-empty" style={{ marginTop: 16 }}>
                <div>
                  <h3>写入失败</h3>
                  <p>{error}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
