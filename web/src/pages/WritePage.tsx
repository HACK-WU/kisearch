/**
 * WritePage.tsx —— 知识写入（关系写入 sync-relation）
 *
 * scope 必选（default 兜底，顶栏全局选择）
 * 关系写入：ki_sync_relation（group + relation + module_info + vector）
 *   → 写 relations-cache（Group 树）+ local KB + 可选向量层（ki-relation / ki-search）
 */

import { useEffect, useRef, useState } from 'react';
import { useScopeValue } from '@/lib/scopeContext';
import { useDocList } from '@/lib/hooks';
import { kiSyncRelation } from '@/api/mcpClient';
import { MarkdownPreview } from '@/components/MarkdownPreview';

/** Group 树节点（从 doc list 的 group 路径构建） */
interface GTreeNode {
  name: string;
  path: string;
  children: GTreeNode[];
  open: boolean;
}

/** 从 docs 的 group 路径构建递归树（全路径节点，唯一顶层折叠） */
function buildGroupTree(docs: { group: string }[]): GTreeNode[] {
  const roots: GTreeNode[] = [];
  const map = new Map<string, GTreeNode>();
  const getNode = (path: string): GTreeNode => {
    let n = map.get(path);
    if (!n) {
      n = { name: path.split('/').pop() || path, path, children: [], open: false };
      map.set(path, n);
    }
    return n;
  };
  for (const d of docs) {
    const segs = d.group.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let prev: GTreeNode | null = null;
    for (let i = 0; i < segs.length; i++) {
      const node = getNode(segs.slice(0, i + 1).join('/'));
      if (prev) {
        if (!prev.children.some((c) => c.path === node.path)) prev.children.push(node);
      } else if (!roots.some((r) => r.path === node.path)) {
        roots.push(node);
      }
      prev = node;
    }
  }
  if (roots.length === 1 && roots[0].children.length > 0) return roots[0].children;
  return roots;
}

/** 默认展开一层 */
function setDefaultOpen(nodes: GTreeNode[], depth = 0): void {
  for (const n of nodes) {
    n.open = depth === 0;
    setDefaultOpen(n.children, depth + 1);
  }
}

const ICON_FOLDER_SM = (
  <svg className="ki-gtree-icon" viewBox="0 0 16 16" fill="none">
    <path
      d="M1.5 3.2c0-.5.4-.9.9-.9h3.2l1.5 1.6h6c.5 0 .9.4.9.9v7.1c0 .5-.4.9-.9.9H2.4c-.5 0-.9-.4-.9-.9V3.2z"
      fill="#7db3ef"
      stroke="#5f97d6"
      strokeWidth="0.6"
    />
  </svg>
);

export function WritePage(): JSX.Element {
  const scope = useScopeValue();
  const [preview, setPreview] = useState(false);
  const [vector, setVector] = useState(true);

  // relation 表单
  const [group, setGroup] = useState('');
  const [relation, setRelation] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [tags, setTags] = useState('');

  // combobox 状态
  const [groupOpen, setGroupOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Group 树数据（当前 scope 的 doc list → group 路径聚合）
  const { data: docData } = useDocList(scope);
  const [groupTree, setGroupTree] = useState<GTreeNode[]>([]);
  useEffect(() => {
    const t = buildGroupTree(docData?.docs ?? []);
    setDefaultOpen(t);
    setGroupTree(t);
  }, [docData]);

  // 点击外部关闭 combobox
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (groupRef.current && !groupRef.current.contains(e.target as Node)) setGroupOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const toggleGroup = (node: GTreeNode): void => {
    setGroup(node.path);
    setGroupOpen(false);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setResult(null);
    if (!group.trim() || !relation.trim() || !markdown.trim()) {
      setError('Group、Relation、Module Info 均不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await kiSyncRelation({ scope, group: group.trim(), relation: relation.trim(), content: markdown, vector, tags: tagList });
      setResult(`写入成功${vector ? '' : '（未向量化）'}${tagList.length > 0 ? `（标签：${tagList.join(', ')}）` : ''}`);
      setGroup('');
      setRelation('');
      setMarkdown('');
      setTags('');
      setPreview(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = (): void => {
    setGroup('');
    setRelation('');
    setMarkdown('');
    setTags('');
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
                <div className="ki-combobox" ref={groupRef}>
                  <div className="ki-combobox__input-wrap">
                    <input
                      className="ki-form-input"
                      placeholder="选择或输入 Group 路径，如：告警系统/告警收敛"
                      value={group}
                      onChange={(e) => setGroup(e.target.value)}
                      onFocus={() => setGroupOpen(true)}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className={`ki-combobox__toggle${groupOpen ? ' ki-combobox__toggle--open' : ''}`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setGroupOpen((v) => !v);
                      }}
                    >
                      {groupOpen ? '▴' : '▾'}
                    </button>
                  </div>
                  <div className={`ki-combobox__panel${groupOpen ? ' ki-combobox__panel--open' : ''}`}>
                    <div className="ki-combobox__tree">
                      {groupTree.length === 0 ? (
                        <div className="ki-cell-sub" style={{ padding: 6 }}>
                          当前 scope 暂无 Group，可直接输入新建
                        </div>
                      ) : (
                        <GroupTreeView nodes={groupTree} onPick={toggleGroup} />
                      )}
                    </div>
                    <div className="ki-combobox__footer">
                      <span className="ki-cell-sub">
                        {group && !isPathInTree(groupTree, group) ? (
                          <span style={{ color: 'var(--ki-color-success)' }}>✚ 将新建 Group：{group}</span>
                        ) : group ? (
                          <span style={{ color: 'var(--ki-color-primary)' }}>✓ 已有 Group</span>
                        ) : (
                          '输入新路径可新建 Group'
                        )}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="ki-form-hint">斜杠分隔层级，下拉选择已有 Group 或直接输入新建。</div>
              </div>
              <div className="ki-form-group">
                <label className="ki-form-label">文档名称（Relation）</label>
                <input
                  className="ki-form-input"
                  placeholder="如：告警收敛策略"
                  value={relation}
                  onChange={(e) => setRelation(e.target.value)}
                />
                <div className="ki-form-hint">同 Group 内唯一；浏览页按此名显示文档。</div>
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
              <label className="ki-form-label">自定义标签（可选）</label>
              <input
                className="ki-form-input"
                placeholder="逗号分隔多个，如：api, auth（叠加在默认 ki-search 之上）"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <div className="ki-form-hint">
                为空时仅写 ki-search；指定后内容额外按各标签写入向量，可用语义搜索按标签过滤召回。
              </div>
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
              <button className="ki-btn ki-btn--primary" onClick={() => void submit()} disabled={submitting}>
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

/** 判断路径是否已在树中（供 footer 提示） */
function isPathInTree(nodes: GTreeNode[], path: string): boolean {
  for (const n of nodes) {
    if (n.path === path) return true;
    if (isPathInTree(n.children, path)) return true;
  }
  return false;
}

/** 递归 Group 树（点击节点选中并关闭） */
function GroupTreeView({ nodes, onPick }: { nodes: GTreeNode[]; onPick: (n: GTreeNode) => void }): JSX.Element {
  const [tree, setTree] = useState<GTreeNode[]>(nodes);
  useEffect(() => setTree(nodes), [nodes]);

  const toggleOpen = (path: string): void => {
    setTree((prev) => {
      const walk = (items: GTreeNode[]): boolean => {
        for (const n of items) {
          if (n.path === path) {
            n.open = !n.open;
            return true;
          }
          if (walk(n.children)) return true;
        }
        return false;
      };
      walk(prev);
      return [...prev];
    });
  };

  const render = (n: GTreeNode): JSX.Element => {
    const hasSub = n.children.length > 0;
    return (
      <div key={n.path}>
        <div
          className="ki-gtree-dir"
          onClick={(e) => {
            e.stopPropagation();
            if (hasSub) toggleOpen(n.path);
            onPick(n);
          }}
        >
          <span className="ki-gtree-arrow">{hasSub ? (n.open ? '▾' : '▸') : ''}</span>
          {ICON_FOLDER_SM}
          <span className="ki-gtree-label">{n.name}</span>
        </div>
        {hasSub && n.open && <div className="ki-gtree-group">{n.children.map(render)}</div>}
      </div>
    );
  };

  return <>{tree.map(render)}</>;
}
