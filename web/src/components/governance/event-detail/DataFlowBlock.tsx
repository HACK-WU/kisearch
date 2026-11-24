import { useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';

/**
 * 数据链路块（2026-11-24 · REQ-20261124-001 · SR-04a）。
 *
 * 事件 AI 分析结论里新增的一跳一跳的**数据/调用路径**（模型产出的纯文本树）。
 * 与「分析结论」「未确认点」三者**并列、独立成块** —— 不再嵌在紫色结论壳内：
 *   · 分析结论（紫）  = AI 的判断；
 *   · 数据链路（中性） = 客观路径，同样是 AI 产出但比结论轻一档，不抢主结论；
 *   · 未确认点（琥珀） = 证据缺口。
 *
 * 三个刻意为之的实现细节：
 * 1. **文本一律作为 React 文本节点渲染**（`<pre>{dataFlow}</pre>`），绝不 `dangerouslySetInnerHTML` ——
 *    这段是模型输出，模型可以吐任意字符，拼 HTML 等于把注入面打开。
 * 2. **树不折行**（CSS `white-space: pre`）：折行会把树读成散文。窄了就横滑，
 *    但横滑必须显式说出来，否则用户以为内容就这么多 → `ResizeObserver` 探测溢出并给根节点打标。
 * 3. **三态**：有值正常渲染；外部上传（MCP）没给链路时占位说明"未提供"，别让区块凭空消失；
 *    老数据（AI 来源但没有该字段）**整块不渲染** —— 那是一次没产出链路的旧分析，凭空冒出空块没有意义。
 */

export interface DataFlowBlockProps {
  /** `draft.dataFlow`：多行文本，LF 分隔；键缺 / 空串都算"没有链路" */
  dataFlow?: string | null;
  /** `draft.source`：缺省 = AI 在线分析；`external` = MCP 上传 */
  source?: 'ai' | 'external';
  /**
   * 嵌在**已有纵向滚动容器**里时传 true（AI 分析面板的过程区就是）。
   *
   * 不传的话面板里会出现两层纵向滚动条：外层 `gov-ai-embed__scroll`（240~360px）
   * 与块内 520px 上限叠在一起，鼠标停在树上滚的是内层、滚到底还得再滚外层。
   */
  nested?: boolean;
}

/** 复制按钮的 1.6s 临时态 */
type CopyState = 'idle' | 'ok' | 'fail';

const COPY_LABEL: Record<CopyState, string> = {
  idle: '复制',
  ok: '已复制',
  fail: '复制失败',
};

const COPY_RESET_MS = 1600;

/**
 * 只由树形符号构成的行（竖轨 / 箭头 / 分叉线）。
 *
 * 为什么单列：`8 步` 的"步"是**逻辑跳数**，不是物理行数 —— 每一步下面还有一行 `▼`，
 * 按非空行数算会把 8 步数成 22 步。这些符号行不承载信息，不计入步数。
 */
const RAIL_ONLY = /^[\s│┃|┌┐└┘├┤┬┴┼─━▼▽▲△→↓↑>v-]*$/;

export function DataFlowBlock(props: DataFlowBlockProps): JSX.Element | null {
  const { dataFlow, source, nested = false } = props;
  /*
   * 只去掉首尾空行，**不用 `trim()`**：`trim` 会连首行的行首缩进一起吃掉，
   * 而缩进就是树的结构（第一行若是带缩进的节点，去掉后会顶格，与下面几行错位）。
   * 判空仍按 `trim()` —— 模型偶尔吐 `"\n\n"` 或纯空格，那种必须按"没有链路"处理。
   */
  const text = useMemo(
    () => (typeof dataFlow === 'string' ? dataFlow.replace(/^\n+/, '').replace(/\n+$/, '') : ''),
    [dataFlow],
  );
  const hasText = text.trim() !== '';

  const scrollRef = useRef<HTMLDivElement>(null);
  /** 横向是否溢出（决定要不要提示「↔ 可横滑」） */
  const [overflow, setOverflow] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimerRef = useRef<number | null>(null);

  /** `8 步 · 236 字`：步数 = 承载内容的行数（排除纯箭头 / 竖轨行），字数 = 整段字符数 */
  const { steps, chars } = useMemo(() => {
    if (!hasText) return { steps: 0, chars: 0 };
    const lines = text
      .split('\n')
      .filter((line) => line.trim() !== '' && !RAIL_ONLY.test(line));
    return { steps: lines.length, chars: text.length };
    // text 已由上面的 useMemo 归一，依赖它即可
  }, [hasText, text]);

  /*
   * 溢出探测：观察滚动容器本身的尺寸变化（窗口缩放、右栏折叠、卡片换宽都会变）。
   * `+ 1` 是给亚像素取整留余量 —— 差 0.4px 也判溢出会让人看到"可横滑"却滑不动。
   */
  useEffect(() => {
    if (!hasText) {
      setOverflow(false);
      return undefined;
    }
    const box = scrollRef.current;
    if (!box) return undefined;
    const sync = (): void => {
      setOverflow(box.scrollWidth > box.clientWidth + 1);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') {
      // 老环境退化为"只在内容变化时算一次"（上面的 sync 已执行）
      return undefined;
    }
    const ro = new ResizeObserver(sync);
    ro.observe(box);
    return () => ro.disconnect();
  }, [hasText, text]);

  // 卸载时清掉复位定时器：切事件会让本组件重挂，留着定时器会 setState 到已卸载的树
  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  /**
   * 复制链路文本。
   *
   * 复用 `@/lib/clipboard`（Clipboard API → textarea + execCommand 回退），
   * 与健康详情 / 文档预览等处同一口径；失败必须显示出来（点了没反应等于功能坏）。
   */
  const handleCopy = (): void => {
    copyText(text).then(
      () => setCopyState('ok'),
      () => setCopyState('fail'),
    ).finally(() => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setCopyState('idle');
      }, COPY_RESET_MS);
    });
  };

  /*
   * 三态②：无值且外部上传 → 占位块。
   * 外部产物是"别人上传的结论"，区块消失会被读成前端丢了数据；说清"上传时没给"才对。
   */
  if (!hasText) {
    if (source !== 'external') return null;
    return (
      <section className="gov-datalink is-empty" aria-label="数据链路">
        <div className="gov-datalink__head">
          <span className="gov-datalink__title">数据链路</span>
          <span className="gov-datalink__meta">未取到</span>
        </div>
        <p className="gov-datalink__empty">
          <strong>外部上传未提供链路</strong>：这份结论由 MCP 上传，未附带数据链路。
          可「重新分析」由 AI 补齐，或在上传时一并提供。
        </p>
      </section>
    );
  }

  return (
    <section
      className={`gov-datalink${nested ? ' gov-datalink--nested' : ''}`}
      aria-label="数据链路"
      /* CSS 只认 `[data-overflow]` 存在与否，值写 1 便于在 DOM 里看出是前端探测打的 */
      data-overflow={overflow ? '1' : undefined}
    >
      <div className="gov-datalink__head">
        <span className="gov-datalink__title">数据链路</span>
        <span className="gov-datalink__meta">{`${steps} 步 · ${chars} 字`}</span>
        <button
          type="button"
          className="gov-datalink__copy"
          data-state={copyState === 'ok' ? 'success' : undefined}
          title="复制整段链路（纯文本）"
          onClick={handleCopy}
        >
          {COPY_LABEL[copyState]}
        </button>
      </div>
      <div className="gov-datalink__scroll" ref={scrollRef}>
        {/* 模型输出，只能是文本节点：不解析 HTML、不解析 Markdown */}
        <pre className="gov-datalink__tree">{text}</pre>
      </div>
    </section>
  );
}
