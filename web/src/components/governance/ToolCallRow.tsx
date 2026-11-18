import { useEffect, useRef, useState } from 'react';

/**
 * 过程面板里的一行工具调用（2026-11-18 · 分析/查找共用）。
 *
 * 背景：原来只显示「工具名 + 耗时」，用户看不出 Agent 用**什么参数**查了**什么**、
 * 返回里有没有东西 —— 排查时最需要判断的恰恰是这两点（真机反馈）。
 *
 * 契约：`args` 截 300 字、`response` 截 2000 字、`responseChars` 记原文长度；
 * 有截断就在底部标「已截断（原文 N 字）」，并提示全文去文档抽屉看（Q5 不做"查看完整"）。
 *
 * 来源标签：`ki_*` 是 **MCP 知识库工具**，`fs_*` 是**本地只读工具**，
 * skill 调用归本地；否则用户分不清"这一步读的是知识库还是仓库文件"。
 */
export interface ToolCallLike {
  kind: 'tool' | 'skill';
  name: string;
  label: string;
  ms: number;
  note?: string;
  args?: string;
  response?: string;
  responseChars?: number;
}

export interface ToolCallRowProps {
  call: ToolCallLike;
}

function msText(ms: number): string {
  return ms <= 0 ? '<1ms' : `${Math.round(ms)}ms`;
}

export function ToolCallRow(props: ToolCallRowProps): JSX.Element {
  const { call } = props;
  const [open, setOpen] = useState(false);
  const isMcp = call.name.startsWith('ki_');
  const hasDetail = Boolean(call.args || call.response || call.note);
  const truncated = (call.responseChars ?? 0) > (call.response?.length ?? 0);

  return (
    <div className={`gov-trace${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="gov-trace__head"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`gov-trace__src gov-trace__src--${isMcp ? 'mcp' : 'local'}`}>
          {isMcp ? 'MCP' : '本地'}
        </span>
        <span className="gov-trace__label">{call.label}</span>
        <span className="gov-trace__name">{call.name}</span>
        <span className="gov-trace__ms">{msText(call.ms)}</span>
        {hasDetail ? <span className="gov-trace__chev" aria-hidden="true">▾</span> : null}
      </button>

      {open && hasDetail ? (
        <div className="gov-trace__body">
          {call.args ? (
            <>
              <div className="gov-trace__sub">入参</div>
              <pre className="gov-trace__pre">{call.args}</pre>
            </>
          ) : null}
          {call.response ? (
            <>
              <div className="gov-trace__sub">返回</div>
              <pre className="gov-trace__pre">{call.response}</pre>
              {truncated ? (
                <div className="gov-trace__cut">
                  已截断（原文约 {call.responseChars} 字）· 全文请点文档名开抽屉查看
                </div>
              ) : null}
            </>
          ) : null}
          {call.note ? <div className="gov-trace__note">{call.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 单轮思考片段（默认收起，避免过程区被大段文字淹掉）。
 *
 * 2026-11-18：**直接复用 AI 对话的思考块**（`.ki-chat-reason*`，ChatPanel 的 `ReasoningBlock`），
 * 不再自造 `<details className="gov-think">` —— 治理侧此前只给工具行复用了对话样式
 * （见 AiProcessPanel 里那段注释），思考块仍是原生折叠，视觉与对话页割裂且没有加载动画。
 *
 * · 文案与对话一致：`展开思考过程` / `收起思考中 ◐`（`live` = 这一轮仍在生成）；
 * · 展开态由组件自持：轮询追加 text 时不会把用户已展开的块收起；
 * · 类名照搬而非复制取值：对话侧调样式，这里自动跟随（与工具行 `.ki-chat-tl__*` 同思路）。
 */
export function ThinkingBlock(props: { text: string; live?: boolean; truncated?: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 用户是否还贴着底部（回看时不让流式追加把视图拽回去） */
  const stickRef = useRef(true);
  const isTruncated = (props.truncated ?? 0) > props.text.length;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !props.live) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [props.text, props.live]);

  return (
    <div className="ki-chat-reason">
      <button
        type="button"
        className="ki-chat-reason__toggle"
        aria-expanded={open}
        title="模型本轮的思考片段，仅本次分析可见"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '收起' : '展开'}{props.live ? '思考中' : '思考过程'}
        {props.live ? <span className="ki-chat-reason__spin" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          className="ki-chat-reason__body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
          }}
        >
          {props.text}
          {isTruncated ? (
            <p className="ki-chat-reason__truncated">
              思考内容过长，仅显示前 {props.text.length} 字（原文约 {props.truncated} 字）
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
