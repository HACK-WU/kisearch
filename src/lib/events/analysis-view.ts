/**
 * 分析视角（`AnalysisView`）—— 2026-11-20（REQ-20261120-002）。
 *
 * 为什么需要：结论链原先只有一套「故障因果」骨架（现象 → 直接原因 → 根本原因 →
 * 影响面 → 建议）。对性能优化还勉强能套，对「需求实现」与用户自建类型（技术债 /
 * 文档过期）则没有「现象」「根本原因」这两个对象 —— 模型为了凑满骨架会**编造**一个
 * 不存在的故障。这个文件把「骨架该怎么读」从代码里抽成可切换的视角。
 *
 * 两条硬口径：
 *   1. **节点类型（kind）不变**：仍是 symptom / cause / root / impact / fix 五个语义槽，
 *      只换套在槽上的词与呈现方式。数据契约、历史文件、前端 DTO 一律不动。
 *   2. **按 `typeId` 推断，不落盘**：结论文件里不存视角 —— 存了就要迁移历史数据，
 *      而且事件类型改名/改映射后旧结论会与新类型不一致。
 *
 * 视角表的前端副本在 `web/src/lib/analysisView.ts`（web 端不复用 src 下的模块），
 * 两者的 `VIEW_LABELS` 块由 `test/governance-contract.test.ts` 逐字比对，改一处必须改两处。
 */
import type { ConclusionNodeKind } from './types.js';

/** 结论的阅读骨架；新增视角须同时补 `VIEW_LABELS` 与前端副本 */
export type AnalysisView = 'fault' | 'perf' | 'change' | 'generic';

/** 全部视角（顺序即文档/测试里的列举顺序） */
export const ANALYSIS_VIEWS: readonly AnalysisView[] = ['fault', 'perf', 'change', 'generic'];

/** 五个语义槽的「中性」叫法（也是 fault 视角的词表） */
export const BASE_KIND_LABELS: Record<ConclusionNodeKind, string> = {
  symptom: '现象',
  cause: '直接原因',
  root: '根本原因',
  impact: '影响面',
  fix: '建议',
};

/**
 * 各视角的词表（**部分映射**）。
 *
 * 为什么不写全量：change / generic 的骨架里没有 root，模型偶尔仍会给出 root ——
 * 全量映射会让这种节点显示成「根本原因」，等于把错配又放回来；缺项由
 * `resolveKindLabel` 回退到 `BASE_KIND_LABELS` 的中性词。
 */
export const VIEW_LABELS: Record<AnalysisView, Partial<Record<ConclusionNodeKind, string>>> = {
  fault: { symptom: '现象', cause: '直接原因', root: '根本原因', impact: '影响面', fix: '建议' },
  perf: { symptom: '现状表现', cause: '瓶颈点', root: '深层原因', impact: '优化收益', fix: '优化方案' },
  change: { symptom: '现状与目标差距', cause: '差距与成因', impact: '改动影响面', fix: '实施建议' },
  generic: { symptom: '现状', cause: '关键发现', impact: '影响面', fix: '建议' },
};

export interface ViewProfile {
  /** 视角的给人看的名字（提示词里用于声明本次视角） */
  name: string;
  /** 词表（部分；缺项回退 `BASE_KIND_LABELS`） */
  labels: Partial<Record<ConclusionNodeKind, string>>;
  /** 建议的节点顺序；只是顺序建议，缺哪层就跳过（不硬造） */
  skeleton: readonly ConclusionNodeKind[];
  /** 全块唯一强调点；null = 不强调 */
  emphasize: ConclusionNodeKind | null;
  /** 强调节点的清标文案；'' = 不清标 */
  flag: string;
  /** 是否画竖轨与流向箭头（因果链）。false = 并列要点，不暗示因果 */
  rail: boolean;
  /** 类型列是否需要加宽（长标签如「现状与目标差距」58px 放不下） */
  wide: boolean;
  /** `conclusion` 一句话的撰写口径 */
  summaryGuide: string;
  /** 喂给模型的定位语（替代用户提示词里那句「软件问题」） */
  locateGuide: string;
}

/**
 * 内置类型 → 视角。
 *
 * **按 id 不按名字**：类型名允许用户改（`updateType` 可 patch name），按名字匹配会在
 * 改名后静默退回 generic。自建类型（无内置 id）一律 generic。
 */
const BUILTIN_TYPE_VIEW: Readonly<Record<string, AnalysisView>> = {
  et_1: 'fault', // bug 排查
  et_2: 'perf', // 性能优化
  et_3: 'change', // 需求实现
};

const PROFILES: Readonly<Record<AnalysisView, ViewProfile>> = {
  fault: {
    name: '故障排查',
    labels: VIEW_LABELS.fault,
    skeleton: ['symptom', 'cause', 'root', 'impact', 'fix'],
    emphasize: 'root',
    flag: '根因',
    rail: true,
    wide: false,
    summaryGuide: '根因是什么、影响多大、往哪修',
    locateGuide: '为一条已登记的软件问题找出可被证实的代码位置与成因',
  },
  perf: {
    name: '性能优化',
    labels: VIEW_LABELS.perf,
    skeleton: ['symptom', 'cause', 'root', 'impact', 'fix'],
    emphasize: 'cause',
    flag: '瓶颈',
    rail: true,
    wide: false,
    summaryGuide: '现状多差、瓶颈在哪、优化后能回到什么量级',
    locateGuide: '为一条性能优化事件找出可被证实的瓶颈点与成因（瓶颈点比「为什么会写成这样」更重要）',
  },
  change: {
    name: '需求实现',
    labels: VIEW_LABELS.change,
    skeleton: ['symptom', 'cause', 'impact', 'fix'],
    emphasize: null,
    flag: '',
    rail: false,
    wide: true,
    summaryGuide: '目标是什么、落在哪几处、需要连带改什么',
    locateGuide: '为一条需求实现事件找出改动落点与波及面（不是找故障成因）',
  },
  generic: {
    name: '通用',
    labels: VIEW_LABELS.generic,
    skeleton: ['symptom', 'cause', 'impact', 'fix'],
    emphasize: null,
    flag: '',
    rail: false,
    wide: true,
    summaryGuide: '查到了什么、影响什么、建议往哪走',
    locateGuide: '为一条已登记的事件找出相关的代码依据与影响（不必强求因果）',
  },
};

/**
 * 推断视角。两种「不知道」要分开处理：
 *   · **没有 typeId**（历史片段 / 调用方未传）→ 回退 `fault`，即改动前的原模板，不改变既有行为；
 *   · **有 typeId 但不在内置表**（自建类型 / 类型已删）→ `generic`，不假装知道它的语义。
 */
export function inferAnalysisView(typeId: string | null | undefined): AnalysisView {
  if (!typeId) return 'fault';
  return BUILTIN_TYPE_VIEW[typeId] ?? 'generic';
}

export function viewProfile(view: AnalysisView): ViewProfile {
  return PROFILES[view] ?? PROFILES.generic;
}

/** 取某个节点的显示词：视角词表 → 中性兜底（模型给出骨架之外的 kind 时仍可读） */
export function resolveKindLabel(view: AnalysisView, kind: ConclusionNodeKind): string {
  return viewProfile(view).labels[kind] ?? BASE_KIND_LABELS[kind];
}
