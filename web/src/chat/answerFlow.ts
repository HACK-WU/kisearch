import type { ChatToolResponse } from '@/api/chatContract';
import type { MarkdownBlock } from '@/components/MarkdownPreview';
import type { ProgressStep, ReasoningSegment } from './chatStore';

export type InterleaveItem = TimelineNode | { key: string; kind: 'reason'; afterChars?: number; order?: number; text: string; closed: boolean };

/** Preserve event order when several tool/reasoning events share the same text offset. */
export function mergeInterleaveItems(nodes: TimelineNode[], segs: ReasoningSegment[]): InterleaveItem[] {
  const items: InterleaveItem[] = [
    ...nodes, ...segs.map((seg, i) => ({ key: `rs${i}`, kind: 'reason' as const, ...seg })),
  ];
  return items.sort((a, b) => (a.afterChars ?? 0) - (b.afterChars ?? 0) ||
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

export type AnswerPart = { kind: 'markdown'; block: MarkdownBlock } | { kind: 'trace'; key: string; items: InterleaveItem[] };

/** Snap a trace to a top-level block boundary, preserving fenced code/lists/tables/quotes. */
export function layoutAnswerFlow(blocks: MarkdownBlock[], items: InterleaveItem[]): AnswerPart[] {
  const grouped = new Map<number, InterleaveItem[]>();
  const end = blocks.at(-1)?.end ?? 0;
  for (const item of items) {
    const anchor = Math.max(0, Math.min(item.afterChars ?? 0, end));
    const containing = blocks.find((block) => block.start < anchor && anchor <= block.end);
    const boundary = containing?.end ?? anchor;
    const group = grouped.get(boundary) ?? [];
    group.push(item);
    grouped.set(boundary, group);
  }
  const parts: AnswerPart[] = [];
  const pushTrace = (boundary: number) => {
    const group = grouped.get(boundary);
    if (group) { parts.push({ kind: 'trace', key: `trace-${group[0]!.key}`, items: group }); grouped.delete(boundary); }
  };
  for (const block of blocks) {
    pushTrace(block.start);
    if (block.html) parts.push({ kind: 'markdown', block });
    pushTrace(block.end);
  }
  for (const [boundary] of grouped) pushTrace(boundary);
  return parts;
}

/** 时间线节点（demo D9 行结构）：tool 的 start/end 合并为一行，end 未到时保持 running */
export interface TimelineNode {
  key: string;
  kind: 'tool' | 'think' | 'answer';
  running: boolean;
  label: string;
  name?: string;
  mode?: string;
  query?: string;
  /** 批次 2：非检索类工具的参数摘要（生成中可见；落盘不含，刷新后无） */
  args?: string;
  hits?: number;
  response?: ChatToolResponse;
  durationMs?: number;
  error?: string;
  /** interleave 锚点：本行发生在已发出正文的第几个字符后（缺省 = 0，即正文之前） */
  afterChars?: number;
  order?: number;
}

export function buildTimeline(steps: ProgressStep[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'tool') {
      if (s.phase === 'start') {
        const startIndex = i;
        const next = steps[i + 1];
        const end = next && next.kind === 'tool' && next.phase === 'end' ? next : undefined;
        if (end) i += 1;
        out.push({
          key: `t${startIndex}`, kind: 'tool', running: !end, label: s.label,
          name: s.name ?? end?.name, mode: s.mode ?? end?.mode, query: s.query,
          args: s.args ?? end?.args,
          hits: end?.hits, response: end?.response, durationMs: end?.durationMs, error: end?.error,
          // 行位置以 start 时刻为准（"说完哪句去查的"）
          afterChars: s.afterChars ?? end?.afterChars, order: s.order,
        });
      } else {
        // 质疑 C2：end 若与 start 之间被插入了非 tool 步骤（事件乱序），前向配对会失败 →
        // start 行永久停在"检索中…"。兜底：回看最近一个未完成的 tool 行并入。
        const prev = out[out.length - 1];
        if (prev && prev.kind === 'tool' && prev.running && prev.hits === undefined && !prev.error) {
          prev.running = false;
          prev.name = prev.name ?? s.name;
          prev.mode = prev.mode ?? s.mode;
          prev.args = prev.args ?? s.args;
          prev.hits = s.hits;
          prev.response = s.response;
          prev.durationMs = s.durationMs;
          prev.error = s.error;
        } else {
          out.push({ key: `t${i}`, kind: 'tool', running: false, label: s.label, name: s.name, mode: s.mode, args: s.args, hits: s.hits, response: s.response, durationMs: s.durationMs, error: s.error, afterChars: s.afterChars });
        }
      }
    } else if (s.kind === 'reasoning') {
      out.push({ key: `r${i}`, kind: 'think', running: true, label: '思考中…' });
    } else {
      out.push({ key: `a${i}`, kind: 'answer', running: true, label: '正在回答…' });
    }
  }
  return out;
}
