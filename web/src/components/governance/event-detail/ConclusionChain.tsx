import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ConclusionNode, ConfirmedCodeLocation } from '@/api/governanceApi';
import { highlightCodeHtml, resolveFileLanguage } from '@/lib/codeHighlight';
import { countSiblingsInFile, matchConfirmedLocation } from '@/lib/codeRef';
import { kindLabel, viewRender, type AnalysisView } from '@/lib/analysisView';

/**
 * 分析结论的因果链（2026-11-19）。
 *
 * 取代「一段最长 300 字、根因/影响/建议揉在一起」的纯文本：每个节点一行、
 * 带类型标签（现象 / 直接原因 / 根本原因 / 影响面 / 建议），竖轨 + 流向箭头表达顺序，
 * 根因用菱形 + 紫色轨道强调（整块只此一个强调色）。
 *
 * 两个关键交互：
 * · 节点正文里的 `符号` 渲染成 code 胶囊；
 * · 正文里凡是**能对上已确认位置**的 `` `path` `` / `` `path:line` `` 直接变成可点胶囊
 *   （不依赖模型填 `ref` —— 实测模型更愿意在正文里写路径）。点开是**悬浮代码块**，
 *   空间不足自动翻到上方，Esc / 点空白关闭。
 *
 * 兼容：`chain` 为空时由调用方回退渲染 `conclusion` 纯文本 —— 本组件不处理历史数据。
 */

/*
 * 词表与强调/轨道形态来自 `@/lib/analysisView`（2026-11-20）：
 * 同一份结论对不同事件类型要换词与换形态，词表不再写在本组件里。
 */


function basename(file: string): string {
  const idx = file.lastIndexOf('/');
  return idx >= 0 ? file.slice(idx + 1) : file;
}

/**
 * 能不能点开：必须有快照。
 * 故意不用类型守卫（`loc is …`）—— 在外面已经判过非空的地方，守卫的 false 分支会把类型收窄成
 * `never`，读 `loc.file` 直接报错；这里的契约是"值层面是否可用"，不承担收窄职责。
 */
function hasSnippet(loc: ConfirmedCodeLocation | null | undefined): boolean {
  return Boolean(loc && loc.snippet && loc.snippet.trim());
}

export interface ConclusionChainProps {
  /** 一句话总结（`draft.conclusion`）；为空只渲染链 */
  summary: string | null;
  chain: ConclusionNode[];
  /** 用于把正文里的路径匹配成带快照的已确认位置；匹配不上则保持普通 code */
  confirmed: ConfirmedCodeLocation[];
  /** 标题文案：卡片用「分析结论」，面板内用「最终结论」 */
  title?: string;
  /** 是否套紫色结论壳（卡片 true；面板已有自己的容器时 false） */
  boxed?: boolean;
  /**
   * 分析视角（2026-11-20）：由调用方按 `event.typeId` 推断后传入。
   * 缺省 `fault` —— 旧调用点不传时行为与改动前完全一致。
   */
  view?: AnalysisView;
}

export function ConclusionChain(props: ConclusionChainProps): JSX.Element {
  const { summary, chain, confirmed, title = '分析结论', boxed = true, view = 'fault' } = props;
  const render = viewRender(view);
  const [peek, setPeek] = useState<{
    loc: ConfirmedCodeLocation;
    anchor: HTMLElement;
    /** 同一文件里还有几处已确认位置（正文只提了文件名时，浮层要交代"还有别的"） */
    siblings: number;
  } | null>(null);

  useEffect(() => {
    if (!peek) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPeek(null);
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // 点浮层内部不关；点另一个胶囊交给它的 onClick 接管（避免先关后开闪一下）
      if (target.closest('.gov-peek') || target.closest('.gov-chain__ref')) return;
      setPeek(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [peek]);

  const openPeek = (loc: ConfirmedCodeLocation, anchor: HTMLElement) => {
    setPeek((cur) => (cur && cur.loc.id === loc.id ? null : { loc, anchor, siblings: countSiblingsInFile(loc, confirmed) }));
  };

  /** 可点胶囊：`aria-expanded` 反映"当前展开的就是我" */
  const renderChip = (
    loc: ConfirmedCodeLocation,
    label: string,
    anchorEl: (el: HTMLElement) => void,
    key?: string,
  ): JSX.Element => (
    <button
      key={key}
      type="button"
      className="gov-chain__ref"
      aria-haspopup="dialog"
      aria-expanded={peek?.loc.id === loc.id}
      title={`${loc.file}:${loc.line}${loc.endLine ? `-${loc.endLine}` : ''}｜点击查看分析时的代码快照`}
      onClick={(e) => {
        e.stopPropagation();
        anchorEl(e.currentTarget);
      }}
    >
      {label}
    </button>
  );

  /**
   * 渲染正文：反引号片段 → 能唯一对上已确认位置就做成胶囊，否则普通 code。
   * `used` 用于同一节点内去重（正文里写过路径，就不再在行尾重复挂一个）。
   */
  const renderText = (text: string, used?: Set<string>): ReactNode => {
    if (!text.includes('`')) return text;
    return text.split(/(`[^`]+`)/g).map((part, index) => {
      if (!(part.length > 2 && part.startsWith('`') && part.endsWith('`'))) {
        return <Fragment key={index}>{part}</Fragment>;
      }
      const inner = part.slice(1, -1);
      const loc = matchConfirmedLocation(inner, confirmed);
      if (!loc || !hasSnippet(loc)) return <code key={index}>{inner}</code>;
      used?.add(loc.id);
      return renderChip(loc, inner, (el) => openPeek(loc, el), String(index));
    });
  };

  /* 引用计数 = 真正能点开的位置数（正文内联 + ref），不是"模型填了几个 ref" */
  const linkedCount = (() => {
    const ids = new Set<string>();
    const scan = (text: string | null | undefined) => {
      if (!text || !text.includes('`')) return;
      for (const matched of text.matchAll(/`([^`]+)`/g)) {
        const loc = matchConfirmedLocation(matched[1] ?? '', confirmed);
        if (loc && hasSnippet(loc)) ids.add(loc.id);
      }
    };
    scan(summary);
    for (const node of chain) {
      scan(node.text);
      (node.branches ?? []).forEach(scan);
      const refLoc = node.ref ? matchConfirmedLocation(node.ref, confirmed) : null;
      if (refLoc && hasSnippet(refLoc)) ids.add(refLoc.id);
    }
    return ids.size;
  })();

  const body = (
    <>
      <div className="gov-chain__head">
        <span className="gov-chain__head-title">{title}</span>
        <span className="gov-chain__head-meta">
          {chain.length} 个节点{linkedCount > 0 ? ` · 引用 ${linkedCount} 处` : ''}
        </span>
      </div>

      {summary ? <p className="gov-chain__sum">{renderText(summary)}</p> : null}

      <ol className={`gov-chain${render.rail ? '' : ' is-flat'}${render.wide ? ' is-wide' : ''}`}>
        {chain.map((node, index) => {
          const used = new Set<string>();
          const refLoc = node.ref ? matchConfirmedLocation(node.ref, confirmed) : null;
          const isEmph = render.emphasize === node.kind;

          return (
            <li
              key={`${node.kind}-${index}`}
              className={`gov-chain__node gov-chain__node--${node.kind}${isEmph ? ' is-emph' : ''}`}
            >
              <span className="gov-chain__track">
                <span className="gov-chain__dot" aria-hidden="true" />
              </span>
              <span className="gov-chain__kind">{kindLabel(view, node.kind)}</span>
              <div className="gov-chain__body">
                <p className="gov-chain__text">
                  {renderText(node.text, used)}
                  {/* 行尾显式位置：模型填了 ref 但正文没写路径时靠它兜底 */}
                  {refLoc && !used.has(refLoc.id) ? (
                    hasSnippet(refLoc) ? (
                      renderChip(refLoc, `${basename(refLoc.file)}:${refLoc.line}`, (el) => openPeek(refLoc, el))
                    ) : (
                      <span
                        className="gov-chain__ref gov-chain__ref--plain"
                        title="该位置没有保存代码快照（早期确认或手工录入），无法预览"
                      >
                        {basename(refLoc.file)}:{refLoc.line}
                      </span>
                    )
                  ) : null}
                  {isEmph && render.flag ? <span className="gov-chain__flag">← {render.flag}</span> : null}
                </p>
                {node.branches?.length ? (
                  <ul className="gov-chain__branches">
                    {node.branches.map((branch, bi) => (
                      <li key={bi}>{renderText(branch)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );

  return (
    <>
      {boxed ? <div className="gov-conclusion gov-conclusion--chain">{body}</div> : <div className="gov-chain-wrap">{body}</div>}
      {peek ? (
        <CodePeek loc={peek.loc} anchor={peek.anchor} siblings={peek.siblings} onClose={() => setPeek(null)} />
      ) : null}
    </>
  );
}

/**
 * 悬浮代码块（`position: fixed` + portal）。
 *
 * 为什么用 portal：卡片外壳是 `overflow: hidden`，浮层贴在结论块内部会被裁掉。
 * 定位策略与阅读顺序一致 —— 优先出现在胶囊下方，下方空间不够就翻到上方，
 * 箭头始终指着胶囊中心；水平方向夹在视口内（窄屏不会溢出）。
 */
function CodePeek(props: {
  loc: ConfirmedCodeLocation;
  anchor: HTMLElement;
  siblings: number;
  onClose: () => void;
}): JSX.Element {
  const { loc, anchor, siblings, onClose } = props;
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return undefined;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      let top = rect.bottom + 10;
      let above = false;
      if (top + height > window.innerHeight - 12 && rect.top - 10 - height > 12) {
        top = rect.top - 10 - height;
        above = true;
      }
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
      el.dataset.above = above ? '1' : '0';
      const arrow = el.querySelector<HTMLElement>('.gov-peek__arrow');
      if (arrow) {
        const center = Math.min(Math.max(rect.left + rect.width / 2 - left, 16), width - 16);
        arrow.style.left = `${center - 5}px`;
      }
    };
    place();
    // capture：结论区所在容器若自己滚动，也要跟着重新定位
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, loc]);

  const snippet = loc.snippet ?? '';
  const lines = snippet.split('\n');
  const html = snippet ? highlightCodeHtml(snippet, resolveFileLanguage(loc.file) ?? undefined) : null;
  const hitFrom = loc.line;
  const hitTo = loc.endLine ?? loc.line;

  return createPortal(
    <div
      className="gov-peek"
      ref={popRef}
      role="dialog"
      aria-label={`代码位置预览 ${loc.file}:${loc.line}`}
    >
      <span className="gov-peek__arrow" aria-hidden="true" />
      <div className="gov-peek__head">
        <span className="gov-peek__path" title={loc.file}>{loc.file}</span>
        <span className="gov-peek__line">:{loc.line}{loc.endLine ? `-${loc.endLine}` : ''}</span>
        <button type="button" className="gov-peek__close" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className="gov-codeloc__codewrap gov-peek__codewrap">
        <div className="gov-codeloc__ln" aria-hidden="true">
          {lines.map((_, i) => {
            const no = loc.line + i;
            return (
              <span key={i} className={no >= hitFrom && no <= hitTo ? 'is-hit' : undefined}>{no}</span>
            );
          })}
        </div>
        {html ? (
          <pre className="gov-codeloc__snip" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="gov-codeloc__snip">{snippet}</pre>
        )}
      </div>
      <div className="gov-peek__foot">
        {/* why 是模型原话，常带反引号；页脚只有一行且不做富文本，剥掉符号避免显示成 `` `x` `` */}
        <span className="gov-peek__why">{loc.why.replace(/`/g, '')}</span>
        {siblings > 0 ? (
          <span className="gov-peek__siblings" title="点开的是同文件里行号最小的一处，下方「已确认的相关位置」可看全部">
            该文件另有 {siblings} 处
          </span>
        ) : null}
        {loc.commit ? (
          <span className="gov-peek__commit" title="来自本次分析读取的片段，不代表仓库当前 HEAD">
            {loc.commit}
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
