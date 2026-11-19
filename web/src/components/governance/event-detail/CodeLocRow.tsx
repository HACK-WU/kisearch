import type { CodeLocRowProps } from './types';
import { highlightCodeHtml, resolveFileLanguage } from '@/lib/codeHighlight';

/**
 * 已确认代码位置行（2026-11-17 改版 · 批 4，真机走查后补：图标 + 语法高亮）。
 *
 * 检查点：I-22~I-30。
 * · 行首是 **SVG 尖括号图标**（与 demo 一致；早期版本误用了 `</>` 文本）；
 * · 热区**只有路径**；有 `snippet` 才可展开，展开区标注「分析时的代码快照」+ 不代表 HEAD；
 * · 无 `snippet` → 不可点 + `title` 说明（I-27）；可多行同时展开（I-28）；
 * · 高亮复用 `codeHighlight`（highlight.js 同步、按需语言）：未知语言/超阈值返回 null 时
 *   退回**转义纯文本**，绝不因为高亮失败而丢内容。
 */

const ICON_CODE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.8 4.2 2.4 8l3.4 3.8" />
    <path d="M10.2 4.2 13.6 8l-3.4 3.8" />
  </svg>
);

export function CodeLocRow(props: CodeLocRowProps): JSX.Element {
  const { loc, open, onToggle, canRemove, onRemove } = props;
  const expandId = `codeloc-${loc.id}`;
  const hasSnippet = Boolean(loc.snippet && loc.snippet.trim());
  const path = `${loc.file}:${loc.line}${loc.endLine ? `-${loc.endLine}` : ''}`;
  const html = open && loc.snippet ? highlightCodeHtml(loc.snippet, resolveFileLanguage(loc.file) ?? undefined) : null;
  /**
   * 历史位置可能**没有** `confidence`（早期确认 / 手工录入 / 旧版草稿）。
   * 类型上是必填，但读盘不做逐字段校验 —— 直接 `.toFixed(2)` 会让整张卡片崩掉，
   * 所以这里按"不确定就不显示"处理。
   */
  const conf = typeof loc.confidence === 'number' ? loc.confidence : null;

  return (
    <div className={`gov-codeloc${open ? ' is-open' : ''}`}>
      <span className="gov-codeloc__icon">{ICON_CODE}</span>
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
              {/* 置信度只说人话：数字留在 title 里给排查用，界面不出现 0.85 这种值 */}
              {conf !== null ? (
                <span
                  className={`gov-conf gov-conf--${conf >= 0.8 ? 'ok' : conf >= 0.5 ? 'warn' : 'muted'}`}
                  title={`分析时的置信度 ${conf.toFixed(2)}：高 = 读到具体分支与触发条件；中 = 读到调用链但缺最后一环；低 = 只确认了位置`}
                >
                  {conf >= 0.8 ? '已证实' : conf >= 0.5 ? '疑似' : '线索'}
                </span>
              ) : null}
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
            <div className="gov-codeloc__codewrap">
              {/* 行号用真实文件行号（快照从 loc.line 开始），让用户能直接跳过去核对 */}
              <div className="gov-codeloc__ln" aria-hidden="true">
                {loc.snippet!.split('\n').map((_, i) => (
                  <span key={i}>{loc.line + i}</span>
                ))}
              </div>
              {html ? (
                <pre className="gov-codeloc__snip" dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <pre className="gov-codeloc__snip">{loc.snippet}</pre>
              )}
            </div>
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
