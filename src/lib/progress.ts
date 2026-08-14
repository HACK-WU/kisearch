/**
 * progress.ts —— 导入进度管理
 *
 * 功能：
 *   - apt install 风格的控制台进度展示（输出到 stderr）
 *
 * 设计约束：
 *   - 控制台进度走 stderr，不污染 stdout 的 JSON 结果
 *
 * 注：进度文件读写（断点续跑，含 rootName 字段）已随增量直连废弃一并移除，
 *     本文件仅保留控制台进度展示函数。
 */

// ─── 控制台进度展示 ─────────────────────────────────────

const PROGRESS_BAR_WIDTH = 30;

function formatProgressBar(current: number, total: number): string {
  if (total === 0) return `[${' '.repeat(PROGRESS_BAR_WIDTH)}] 0/0 (—)`;
  const pct = Math.min(current / total, 1);
  const filled = Math.round(PROGRESS_BAR_WIDTH * pct);
  // head 占 1 字符（>），filled=0 时无 head
  const head = filled > 0 ? '='.repeat(filled - 1) + '>' : '';
  const tail = ' '.repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
  return `[${head}${tail}] ${current}/${total} (${Math.round(pct * 100)}%)`;
}

export function logPhaseStart(phase: number, totalPhases: number, message: string): void {
  process.stderr.write(`\n[Phase ${phase}/${totalPhases}] ${message}\n`);
}

export function logPhaseDone(phase: number, _totalPhases: number, message: string): void {
  process.stderr.write(`  ✓ ${message}\n`);
}

/** 覆写当前行展示进度条（apt install 风格）；非 TTY 时逐行输出（REQ-05 O-05） */
export function logProgress(current: number, total: number, detail?: string): void {
  const bar = formatProgressBar(current, total);
  const line = detail ? `${bar} ${detail}` : bar;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r  ${line}`);
    if (current >= total) {
      process.stderr.write('\n');
    }
  } else {
    // 非 TTY（stderr 重定向到文件/管道）：逐行输出，进度仍可读
    process.stderr.write(`  ${line}\n`);
  }
}

export function logInfo(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

export function logWarn(message: string): void {
  process.stderr.write(`  ⚠ ${message}\n`);
}

export function logSummary(message: string): void {
  process.stderr.write(`\n${message}\n`);
}
