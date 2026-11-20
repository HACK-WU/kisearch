/**
 * 分析视角的**渲染侧**副本（2026-11-20 · REQ-20261120-002）。
 *
 * 为什么有一份副本：web 端不复用 `src/lib/**`（构建边界），契约层也是这个做法
 * （`web/src/api/governanceContract.ts` 是后端契约的副本）。因此：
 *   · `VIEW_LABELS` 与后端 `src/lib/events/analysis-view.ts` **必须逐字相同**；
 *   · 由 `test/governance-contract.test.ts` 直接比对两个文件的该代码块，改一处必须改两处。
 *
 * 本文件只管「怎么显示」，不管提示词（定位语 / 一句话口径在后端 profile 里）。
 */
import type { ConclusionNode } from '@/api/governanceApi';

type Kind = ConclusionNode['kind'];

export type AnalysisView = 'fault' | 'perf' | 'change' | 'generic';

/** 五个语义槽的中性词（= fault 视角的词表），作缺项兜底 */
export const BASE_KIND_LABELS: Record<Kind, string> = {
  symptom: '现象',
  cause: '直接原因',
  root: '根本原因',
  impact: '影响面',
  fix: '建议',
};

export const VIEW_LABELS: Record<AnalysisView, Partial<Record<Kind, string>>> = {
  fault: { symptom: '现象', cause: '直接原因', root: '根本原因', impact: '影响面', fix: '建议' },
  perf: { symptom: '现状表现', cause: '瓶颈点', root: '深层原因', impact: '优化收益', fix: '优化方案' },
  change: { symptom: '现状与目标差距', cause: '差距与成因', impact: '改动影响面', fix: '实施建议' },
  generic: { symptom: '现状', cause: '关键发现', impact: '影响面', fix: '建议' },
};

/** 内置类型 → 视角（按 id 不按名字：类型名允许用户改） */
const BUILTIN_TYPE_VIEW: Readonly<Record<string, AnalysisView>> = {
  et_1: 'fault',
  et_2: 'perf',
  et_3: 'change',
};

/** 与后端同口径：缺 typeId 回退 fault（不改变历史行为），未知类型落 generic */
export function inferAnalysisView(typeId: string | null | undefined): AnalysisView {
  if (!typeId) return 'fault';
  return BUILTIN_TYPE_VIEW[typeId] ?? 'generic';
}

export interface ViewRender {
  /** 全块唯一强调点；null = 不强调 */
  emphasize: Kind | null;
  /** 强调节点的清标文案；'' = 不清标 */
  flag: string;
  /** 是否画竖轨与箭头（因果链）；false = 并列要点 */
  rail: boolean;
  /** 类型列是否需要加宽（长标签放不下 58px） */
  wide: boolean;
}

const RENDER: Readonly<Record<AnalysisView, ViewRender>> = {
  fault: { emphasize: 'root', flag: '根因', rail: true, wide: false },
  perf: { emphasize: 'cause', flag: '瓶颈', rail: true, wide: false },
  change: { emphasize: null, flag: '', rail: false, wide: true },
  generic: { emphasize: null, flag: '', rail: false, wide: true },
};

export function viewRender(view: AnalysisView): ViewRender {
  return RENDER[view] ?? RENDER.generic;
}

/** 取节点显示词：视角词表 → 中性兜底（模型给出骨架之外的 kind 时仍可读） */
export function kindLabel(view: AnalysisView, kind: Kind): string {
  return VIEW_LABELS[view]?.[kind] ?? BASE_KIND_LABELS[kind];
}
