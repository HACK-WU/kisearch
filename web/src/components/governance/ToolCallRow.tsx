import { useState } from 'react';

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

/** 单轮思考片段（默认收起，避免过程区被大段文字淹掉） */
export function ThinkingBlock(props: { text: string }): JSX.Element {
  return (
    <details className="gov-think">
      <summary>模型思考</summary>
      <pre className="gov-think__body">{props.text}</pre>
    </details>
  );
}
