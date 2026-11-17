import type { CodeLocRowProps } from './types';

/**
 * 已确认代码位置行（2026-11-17 改版 · 批 4）。
 *
 * 检查点：I-22~I-30。
 * · 热区**只有路径**（hover 出下划线），why 与空白区不触发展开（L-05）；
 * · 有 `snippet` 才可展开，展开区标注「分析时的代码快照 · commit xxxxxxx」+ 一句"不代表当前 HEAD"；
 * · 无 `snippet`（早期确认或手工录入）→ 不可点 + `title` 说明，不报错（I-27）；
 * · 可多行同时展开，展开状态由父级数组控制（I-28）。
 *
 * 注：快照按**纯文本**渲染（不做语法高亮）。高亮需要 `dangerouslySetInnerHTML`，
 * 在"分析时读取的片段"这种半可信内容上不值得冒注入风险；等 codeHighlight 提供
 * 纯节点渲染再补（已记入 S04 §3.4 的落地修正）。
 */
export function CodeLocRow(props: CodeLocRowProps): JSX.Element {
  const { loc, open, onToggle, canRemove, onRemove } = props;
  const expandId = `codeloc-${loc.id}`;
  const hasSnippet = Boolean(loc.snippet && loc.snippet.trim());
  const path = `${loc.file}:${loc.line}${loc.endLine ? `-${loc.endLine}` : ''}`;

  return (
    <div className={`gov-codeloc${open ? ' is-open' : ''}`}>
      <span className="gov-codeloc__icon" aria-hidden="true">{'</>'}</span>
      <div className="gov-codeloc__main">
        <div className="gov-codeloc__head">
          {hasSnippet ? (
            <button
              type="button"
              className="gov-codeloc__pathbtn"
              aria-expanded={open}
              aria-controls={expandId}
              onClick={onToggle}
            >
              <span className="gov-codeloc__path">{path}</span>
              {loc.commit ? <span className="gov-badge gov-badge--kb">{loc.commit}</span> : null}
              <span className="gov-codeloc__chev" aria-hidden="true">▾</span>
            </button>
          ) : (
            <span
              className="gov-codeloc__path"
              title="该位置没有保存代码快照（早期确认或手工录入），无法展开"
            >
              {path}
            </span>
          )}
          {!hasSnippet && loc.commit ? <span className="gov-badge gov-badge--kb">{loc.commit}</span> : null}
        </div>
        <div className="gov-codeloc__why">{loc.why}</div>
        {open && hasSnippet ? (
          <div className="gov-codeloc__expand" id={expandId}>
            <div className="gov-codeloc__expand-head">
              分析时的代码快照{loc.commit ? ` · commit ${loc.commit}` : ''}
            </div>
            <div className="gov-codeloc__expand-note">来自本次分析读取的片段，不代表仓库当前 HEAD</div>
            <pre className="gov-codeloc__snip">{loc.snippet}</pre>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="gov-btn gov-btn--ghost gov-btn--sm gov-docline__x"
        disabled={!canRemove}
        title={canRemove ? '移除该代码位置' : '只读账号无法移除'}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
