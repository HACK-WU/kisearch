/**
 * import-budget.ts —— 导入整批预算与预检（S0-3，REQ-20260930-002 阶段 0）
 *
 * 目标：在扫描阶段（读取文件内容、写入 local KB / 向量之前）对整批导入做
 * 文件数 / 总字节 / 预计 chunk 数三项预检，超限在写入前明确拒绝（fail-loud），
 * 防止超大误操作把 daemon 内存与磁盘一次性打穿。
 *
 * 预算来源（优先级）：CLI 参数 `--max-batch-files/--max-batch-bytes/--max-batch-chunks`
 * > scope 配置 `import.maxBatchFiles/maxBatchBytes/maxBatchChunks` > 默认值。
 *
 * 默认值校准（护栏：不得挡住既有成功路径）：
 *   - 文件数 20,000：已验证成功样本 = ai-docs 1,866 文件；10 万文档目标规模下
 *     常规分批（≤2 万/批）不应被拦，明显异常的目录级误导（如误选系统目录）才会触顶。
 *   - 总字节 4 GiB：1,866 文件 ≈ 30 MB 的两个数量级以上；单文件已受
 *     maxFileSize（默认 1 MiB）约束，正常批次总字节受文件数 × 上限约束。
 *   - chunk 数 300,000：13,680 chunk 样本的 ~22 倍；chunk 由切分产生
 *     （chunkSize=1000 默认），300k chunk ≈ 60 万 KiB 原文，覆盖目标规模分批导入。
 *
 * chunk 预估口径：`ceil(清洗后字节 / chunkSize)` 的**上界**近似——用原始文件字节数
 * 除以 chunkSize 向上取整再 +1（清洗只删不增），逐文件累加。预估只用于预检闸门，
 * 真实 chunk 数在扫描阶段产出，超限的单文件仍由既有 MAX_CHUNKS_PER_FILE 跳过。
 *
 * 跳过可见性（验收的另一半）：预检通过后，逐文件跳过（过大/冲突/hook 失败）已有
 * logWarn + stats.skipped；本模块把"整批被预算拒绝"也做成带明细的显式结果。
 */

/** 整批预算（三项均可选；undefined = 不限制该项） */
export interface ImportBudget {
  /** 单批最大文件数 */
  maxBatchFiles?: number;
  /** 单批最大总字节数 */
  maxBatchBytes?: number;
  /** 单批最大预计 chunk 数 */
  maxBatchChunks?: number;
}

export const DEFAULT_MAX_BATCH_FILES = 20_000;
export const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_BATCH_CHUNKS = 300_000;

/** 三项默认值映射（resolveImportBudget 内部用） */
const DEFAULTS: Required<ImportBudget> = {
  maxBatchFiles: DEFAULT_MAX_BATCH_FILES,
  maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
  maxBatchChunks: DEFAULT_MAX_BATCH_CHUNKS,
};

/** pick 三态哨兵：显式关闭（区别于"未提供来源"） */
const DISABLED = -1;

/** 预检违反项（每项含当前值、上限、人类可读明细） */
export interface BudgetViolation {
  kind: 'files' | 'bytes' | 'chunks';
  current: number;
  limit: number;
}

export interface BudgetPreflightResult {
  ok: boolean;
  violations: BudgetViolation[];
  /** 预检统计（无论是否超限均返回，供展示） */
  stats: { fileCount: number; totalBytes: number; estimatedChunks: number };
}

/** 错误码：调用方（CLI/Web）据此给终端用户一致的失败提示 */
export const IMPORT_BUDGET_EXCEEDED = 'IMPORT_BUDGET_EXCEEDED';

/**
 * 解析生效预算：显式参数 > scope 配置 > 默认值。
 * 配置值为 0 或负数视为"显式关闭该项限制"（fail-loud 反向逃生口）。
 */
export function resolveImportBudget(
  cliBudget: ImportBudget | undefined,
  configBudget: ImportBudget | undefined,
): ImportBudget {
  // 三态：>0 用之；≤0 显式关闭（吞掉低优先级来源，最终 undefined=不限制）；
  // 缺省 → 看低优先级来源；均缺省 → 默认值。
  const pick = (key: keyof ImportBudget): number | DISABLED | undefined => {
    const cliVal = cliBudget?.[key];
    if (cliVal !== undefined && cliVal !== null) {
      return cliVal > 0 ? cliVal : DISABLED; // CLI ≤0 = 显式关闭，不回落配置
    }
    const cfgVal = configBudget?.[key];
    if (cfgVal !== undefined && cfgVal !== null) {
      return cfgVal > 0 ? cfgVal : DISABLED; // 配置 ≤0 = 显式关闭
    }
    return undefined; // 两级来源均缺省
  };
  const resolve = (key: keyof ImportBudget): number | undefined =>
    pick(key) === DISABLED ? undefined : (pick(key) ?? DEFAULTS[key]);
  return {
    maxBatchFiles: resolve('maxBatchFiles'),
    maxBatchBytes: resolve('maxBatchBytes'),
    maxBatchChunks: resolve('maxBatchChunks'),
  };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

function describe(kind: BudgetViolation['kind'], v: BudgetViolation): string {
  switch (kind) {
    case 'files': return `文件数 ${v.current} 超过上限 ${v.limit}`;
    case 'bytes': return `总字节 ${formatBytes(v.current)} 超过上限 ${formatBytes(v.limit)}`;
    case 'chunks': return `预计 chunk 数 ${v.current} 超过上限 ${v.limit}`;
  }
}

/**
 * 整批预检：在读取任何文件内容之前，仅凭 collectMarkdownFiles 的文件清单
 * 与 stat 信息完成三项预算检查。超限返回 ok:false + violations（fail-loud，
 * 调用方须在写入前抛错终止）；未超限返回统计值供导入摘要展示。
 */
export function preflightImportBudget(params: {
  files: string[];
  totalBytes: number;
  estimatedChunks: number;
  budget: ImportBudget;
}): BudgetPreflightResult {
  const { files, totalBytes, estimatedChunks, budget } = params;
  const violations: BudgetViolation[] = [];
  if (budget.maxBatchFiles !== undefined && files.length > budget.maxBatchFiles) {
    violations.push({ kind: 'files', current: files.length, limit: budget.maxBatchFiles });
  }
  if (budget.maxBatchBytes !== undefined && totalBytes > budget.maxBatchBytes) {
    violations.push({ kind: 'bytes', current: totalBytes, limit: budget.maxBatchBytes });
  }
  if (budget.maxBatchChunks !== undefined && estimatedChunks > budget.maxBatchChunks) {
    violations.push({ kind: 'chunks', current: estimatedChunks, limit: budget.maxBatchChunks });
  }
  return {
    ok: violations.length === 0,
    violations,
    stats: { fileCount: files.length, totalBytes, estimatedChunks },
  };
}

/** 生成人类可读的超限错误信息（CLI/Web 共用同一文案口径） */
export function budgetViolationMessage(result: BudgetPreflightResult): string {
  const lines = result.violations.map((v) => `  - ${describe(v.kind, v)}`);
  return [
    '导入整批预算超限，已在写入前拒绝：',
    ...lines,
    '处理建议：',
    '  1. 拆分目录分批导入（推荐，单批文件数/字节数随之下降）',
    '  2. 或在 config scopes.<scope>.import 中调大 maxBatchFiles/maxBatchBytes/maxBatchChunks',
    '  3. 或 CLI 显式传 --max-batch-files/--max-batch-bytes/--max-batch-chunks 覆盖',
  ].join('\n');
}
