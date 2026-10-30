/**
 * vectorAvailability.ts —— 向量能力可用性的**纯逻辑判据**（不依赖 React / react-query）。
 *
 * ★ 来源：windows 分支 4e9d624 `fix(web): degrade gracefully when vector service is unavailable` 的
 *   `useVectorAvailability`。2026-10-29 合并 66c3c19（windows ← master）按「以 master 为准」解决
 *   hooks.ts 冲突后该能力整体丢失，此处以「纯函数 + hook 薄封装」形式接回
 *   （台账 `.debug/windows-merge-readiness-20261029/`）。
 *
 * ★ 为什么拆成纯函数：判据有 5 个输入（health / scopeList 两路 query 各自的 data / error / pending）
 *   与 4 个输出态，写在 hook 里无法单测；master 既有约定是把判据独立成 `lib/*.ts`
 *   （见 `healthSummary.ts` 头注释），hooks.ts 只做 query 封装。
 *
 * ★ 判定顺序**不可调换**（逐条都有理由）：
 *   1. unavailable 先于 unknown —— 已确诊不可用（scope 枚举降级 / 向量探测项 fail）时不该被
 *      另一路请求失败盖成「未知」：前者动作是去修 embedding，后者动作是重试页面，给错指引更糟；
 *   2. 错误判定先于 available —— 拿到了 `ok:false` 的应答不能当可用；
 *   3. available 要求探测项**齐且全 pass** —— 缺项说明后端没跑完探测，保守按未知处理（宁可多禁一次）。
 */
import type { HealthResponse } from '@/api/httpApi';
import type { ScopeListResponse } from '@/api/mcpClient';
import {
  VECTOR_HEALTH_CHECK_NAMES,
  humanizeHealthError,
  isVectorHealthCheck,
  vectorOnlyFailureLabel,
  type HealthSummary,
} from './healthSummary';

export type VectorAvailabilityStatus = 'checking' | 'available' | 'unavailable' | 'unknown';

export interface VectorAvailability {
  status: VectorAvailabilityStatus;
  /** 面向用户的原因（后端 detail 自带修复指引，原样透出）；无需说明时为 undefined */
  reason?: string;
}

/** 一路 query 的最小投影：只取判据用得到的三个字段 */
export interface QuerySlice<T> {
  data?: T;
  error?: unknown;
  isPending: boolean;
}

export interface VectorAvailabilityInput {
  health: QuerySlice<HealthResponse>;
  scopeList: QuerySlice<ScopeListResponse>;
}

/**
 * 错误文案统一走 `humanizeHealthError`：`Failed to fetch` 这类浏览器黑话会被换成可行动人话
 * （与徽标 / 横幅同一口径，避免同一故障在两处说两种话）。
 */
function queryErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  return humanizeHealthError(raw);
}

/**
 * 三页面与顶栏徽标共用的可用性判据。
 *
 * `available` 是**唯一**放开向量读写的状态 —— 其余三态（checking / unavailable / unknown）一律按
 * 不可用处理（`checking` 期间短暂禁用，避免用户在探测完成前提交一次注定失败的写入）。
 */
export function resolveVectorAvailability(input: VectorAvailabilityInput): VectorAvailability {
  const { health, scopeList } = input;
  const items = health.data?.report?.items ?? [];
  const vectorItems = items.filter((item) => isVectorHealthCheck(item.name));
  const failedVectorItem = vectorItems.find((item) => item.status !== 'pass');
  const unavailableByScope = scopeList.data?.vectorAvailable === false;

  if (unavailableByScope || failedVectorItem) {
    return {
      status: 'unavailable',
      reason: scopeList.data?.vectorReason ?? failedVectorItem?.detail ?? failedVectorItem?.message,
    };
  }

  if (health.error || scopeList.error || health.data?.ok === false || scopeList.data?.ok === false) {
    return {
      status: 'unknown',
      reason: queryErrorMessage(scopeList.error) ?? queryErrorMessage(health.error),
    };
  }

  const allChecksPassed = vectorItems.length === VECTOR_HEALTH_CHECK_NAMES.size
    && vectorItems.every((item) => item.status === 'pass');
  if (allChecksPassed && scopeList.data?.vectorAvailable === true) {
    return { status: 'available' };
  }

  if (health.isPending || scopeList.isPending) return { status: 'checking' };

  /**
   * 报告里一条向量探测项都没有 —— 极可能是 **daemon 版本较旧**（前端 dist 已换、常驻
   * `ki mcp --http` 未重启）。此时给可行动原因，否则用户只看到「无法确认」不知从哪下手。
   */
  if (vectorItems.length === 0) {
    return {
      status: 'unknown',
      reason: '后端未返回向量探测项（daemon 版本可能较旧），请重启 ki mcp --http 后重试',
    };
  }

  return {
    status: 'unknown',
    reason: queryErrorMessage(scopeList.error) ?? queryErrorMessage(health.error),
  };
}

/**
 * 就地说明文案（三个写入/检索页面的 hint 统一口径）。
 *
 * ★ 不用「未知」而用「无法确认」：用户能理解的话，且指向可行动作（重试 / 稍后）；
 *   `unavailable` 透出后端原因，因为它通常带 `ki restore …` 之类的修复指引。
 */
export function vectorAvailabilityHint(availability: VectorAvailability): string {
  const suffix = availability.reason ? `：${availability.reason}` : '';
  switch (availability.status) {
    case 'available':
      // 可用时没有提示可给（调用方也只在 `!vectorAvailable` 时渲染）；返回空串而非兜底文案，
      // 避免将来误用时在"一切正常"的界面上挂一句"无法确认向量可用性"。
      return '';
    case 'unavailable':
      return `向量服务不可用，已自动降级为全文检索${suffix}`;
    case 'checking':
      return '正在检查向量可用性，检查完成前暂按全文检索处理';
    default:
      // ★ 给出动作：三页面没有独立的"重新检查"入口，而 `useHealth` 有 60s staleTime，
      //   不提示的话用户只能猜（典型场景：/api/health 探测超时 → unknown）。
      return `无法确认向量可用性，暂按全文检索处理${suffix}（刷新页面可重试）`;
  }
}

/**
 * 顶栏服务徽标的向量降级文案：非 null 时替换 `summarizeHealth` 的 label，并把点色降为 warn。
 *
 * 覆盖两条来源（windows 4e9d624 的 onlyVectorFailures + scope 层降级）：
 *   1. doctor 报告的 fail 项**全是**向量探测项 → 「向量不可用 · {项名}」；
 *   2. 报告没有 fail，但 scope 枚举已降级（`vectorAvailable === false`，如向量库被导入进程持锁）
 *      → 「向量不可用」。
 *
 * ★ 不降级的情形：`checking` / `unreachable` / `slow` —— 服务本身是否活着比"向量能不能用"
 *   更需要用户注意，用向量文案盖掉会让用户漏掉真正的连不上问题（同 healthSummary 的核心区分）。
 */
export function vectorBadgeLabel(summary: HealthSummary, availability: VectorAvailability): string | null {
  if (summary.level === 'checking' || summary.level === 'unreachable' || summary.level === 'slow') return null;
  const vectorOnly = vectorOnlyFailureLabel(summary);
  if (vectorOnly !== null) return vectorOnly;
  const failCount = summary.issues.filter((i) => i.status === 'fail').length;
  if (failCount === 0 && availability.status === 'unavailable') return '向量不可用';
  return null;
}
