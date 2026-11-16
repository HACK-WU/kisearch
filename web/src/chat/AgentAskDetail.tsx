/**
 * AgentAskDetail —— `ki_ask` 问答的**只读**详情（REQ-20261116-003 · B0.5）
 *
 * ═══ 只读契约（与主会话的差别）═══
 * · 没有输入框、没有编辑 / 重发 / 反馈 / 续聊 —— `ka-*` 的写入方只有 MCP 通道；
 * · 没有改名 / 归档 / 删除 —— `ka-*` 里没有这些字段，渲染出来就是"点了没反应"；
 * · 消息比主会话少 `progress`（检索步骤）与 `reasoning`：落盘时就没有（S-01）。
 *
 * ═══ 为什么正文复用 MarkdownPreview 而不是 ChatPanel 里的 Message ═══
 * 后者是 ChatPanel 内的私有函数，承载 10+ 个交互 props（编辑/重发/复制/反馈/推理折叠），
 * 只读场景一个都用不上；而 markdown / 代码块 / mermaid / echarts 的渲染核心已在
 * `components/MarkdownPreview`，直接复用即可（见 S-04 §4.5.1 的决策记录）。
 *
 * ═══ 提问背景（ki_ask 的 background 入参）═══
 * 贴在**问题气泡内、问题之上**，引用样式（左竖线 + 小字）。只有传了背景的那一轮才有。
 *
 * @see design/S03_详情与只读回放_DESIGN.md、design/S04_前端分组与详情_DESIGN.md §3.2
 */

import type { AgentAskDetail as AgentAskDetailData, AgentAskMessage, SourceRef } from '@/api/chatContract';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { SourcesList } from './SourcesList';
import { formatConvTime } from './format';

export interface AgentAskDetailProps {
  detail: AgentAskDetailData;
  /** 打开来源原文（复用主会话的抽屉定位能力）；缺省时 chip 不可点 */
  onOpenSource?: (ref: SourceRef) => void;
}

const LocalIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M8 2.4 13 6v7.2H3V6l5-3.6Z" />
  </svg>
);
const TokenIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="5.4" cy="8" r="2.4" />
    <path d="M7.8 8h6M11.8 8v2.2M10 8v1.5" />
  </svg>
);
const InfoIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v3.4M8 5.4v.6" />
  </svg>
);

/** 提问背景块：只在 `message.background` 存在时渲染 */
function BackgroundBlock({ text }: { text: string }): JSX.Element {
  return (
    <div className="ki-ask-bg">
      <p className="ki-ask-bg__label">
        <InfoIcon />
        <span>提问前提 · {text.length} 字</span>
      </p>
      <p className="ki-ask-bg__text">{text}</p>
    </div>
  );
}

function UserMessage({ message }: { message: AgentAskMessage }): JSX.Element {
  return (
    <div className="ki-chat-msg ki-chat-msg--user">
      <div className="ki-chat-msg__meta">
        <span className="ki-chat-msg__at">{formatConvTime(message.at)}</span>
        <span className="ki-chat-msg__badge">Agent 代问</span>
      </div>
      <div className="ki-chat-msg__body">
        {message.background ? <BackgroundBlock text={message.background} /> : null}
        <p className="ki-chat-msg__text">{message.content}</p>
      </div>
    </div>
  );
}

function AssistantMessage(props: {
  message: AgentAskMessage;
  onOpenSource?: (ref: SourceRef) => void;
}): JSX.Element {
  const { message, onOpenSource } = props;
  return (
    <div className="ki-chat-msg ki-chat-msg--assistant">
      <div className="ki-chat-msg__meta">
        <span className="ki-chat-avatar" aria-hidden="true">k</span>
        <span className="ki-chat-msg__role">kisearch</span>
        <span className="ki-chat-msg__at">{formatConvTime(message.at)}</span>
      </div>
      <div className="ki-chat-msg__body">
        <MarkdownPreview text={message.content} />
      </div>
      <SourcesList sources={message.sources ?? []} onOpen={onOpenSource} />
    </div>
  );
}

export function AgentAskDetail({ detail, onOpenSource }: AgentAskDetailProps): JSX.Element {
  const { origin } = detail;
  const isLocal = origin.kind === 'local';
  const sourceText = origin.tokenDeleted
    ? '该 Token 已删除 · 问答仍可回看'
    : isLocal
      ? '本机 MCP 连接'
      : '通过 MCP 调用';
  return (
    <div className="ki-ask-detail">
      <div className="ki-ask-detail__from">
        <span className={`ki-ask-detail__chip ki-ask-detail__chip--${isLocal ? 'local' : 'token'}`}>
          {isLocal ? <LocalIcon /> : <TokenIcon />}
          <span>{origin.label}</span>
        </span>
        <span className="ki-ask-detail__meta">{sourceText} · scope {detail.scope}</span>
        <span className="ki-ask-detail__ro">只读</span>
      </div>

      {detail.messages.map((m, i) => (
        m.role === 'user'
          ? <UserMessage key={`u-${i}`} message={m} />
          : <AssistantMessage key={`a-${i}`} message={m} onOpenSource={onOpenSource} />
      ))}
    </div>
  );
}
