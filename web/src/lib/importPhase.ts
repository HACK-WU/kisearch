/**
 * importPhase.ts —— 导入任务「阶段 → UI 呈现」的纯函数映射。
 *
 * 为什么要单独抽：2026-10-19 修的两处缺陷都出在 `ImportPage.tsx` 的 JSX 内联表达式里，
 * 而该组件没有任何自动化测试（`web/test` 只覆盖 `src/lib` 纯函数，仓库也没有 CI 会去跑
 * `temp/verify-*.cjs` 里的人工走查脚本）。收敛到这里后 `web/test/import-phase.test.mjs`
 * 才能锁住语义，不必依赖"下次还记得重跑走查"。
 *
 * 三条被记住的判据：
 *   1) `awaiting-confirm`（上传完成、等用户拍板是否继续导入）与 `uploading` **必须分开**：
 *      前者不是进行中——不该转圈，也不该出「取消导入」（那是 job 建立后的入口）。
 *   2) 用户主动取消**不是失败**：本地取消（`phase='cancelled'`）与服务端 `state='cancelled'`
 *      （落到 `failed` + `failureStage='cancelled'`）都必须呈现「已取消」灰态，而非红色「导入失败」。
 *   3) 等待确认时上传已 100%，进度条要沿用上传百分比；若落到 `importPercent`（`job` 尚不存在，
 *      为 `null`）会变成无限滚动条。
 */

/** 导入页的阶段（`idle` 是页面初始态，其余与 `ImportTaskSummary['phase']` 同源） */
export type ImportPhase =
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'awaiting-confirm'
  | 'importing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'unknown';

/** 失败细分：`cancelled` 表示用户主动取消（语义上不是失败） */
export type ImportFailureStage = 'scan' | 'upload' | 'import' | 'cancelled' | 'unknown' | null;

/** 右轨状态徽标的色调（对应 `.ki-task-state--{tone}`） */
export type ImportTaskTone = 'cancelled' | 'partial' | 'running' | 'succeeded' | 'unknown' | 'failed';

/**
 * 「忙」= 本次任务未结束、不得再发新任务。
 * `awaiting-confirm` 同属忙：上传已完成但用户还没拍板，此时换文件/再点开始都会让
 * 预检结论与真实上传内容脱节。
 */
export function isBusyPhase(phase: ImportPhase): boolean {
  return phase === 'scanning'
    || phase === 'uploading'
    || phase === 'awaiting-confirm'
    || phase === 'importing';
}

/** 是否处于「用户主动取消」语义（本地取消 或 服务端确认的取消） */
export function isCancelledTrack(phase: ImportPhase, failureStage: ImportFailureStage = null): boolean {
  return phase === 'cancelled' || (phase === 'failed' && failureStage === 'cancelled');
}

/** 右轨阶段徽标文案 */
export function trackLabelOf(phase: ImportPhase, failureStage: ImportFailureStage = null): string {
  if (isCancelledTrack(phase, failureStage)) return '已取消';
  switch (phase) {
    case 'idle': return '等待开始';
    case 'scanning': return '读取目录中';
    case 'uploading': return '上传中';
    case 'awaiting-confirm': return '等待确认';
    case 'importing': return '导入中';
    case 'done': return '导入完成';
    case 'unknown': return '待确认';
    default: return '导入失败';
  }
}

/**
 * 右轨阶段徽标色调。
 * 等待确认是"需要用户动作"而非进行中（不给 running 的转圈观感）；已取消沿用 idle 的灰态。
 */
export function trackToneOf(phase: ImportPhase, failureStage: ImportFailureStage = null): ImportTaskTone {
  if (phase === 'idle' || isCancelledTrack(phase, failureStage)) return 'cancelled';
  switch (phase) {
    case 'scanning':
    case 'awaiting-confirm': return 'partial';
    case 'uploading':
    case 'importing': return 'running';
    case 'done': return 'succeeded';
    case 'unknown': return 'unknown';
    default: return 'failed';
  }
}

/** 进度条百分比：等待确认沿用上传百分比（见文件头判据 3） */
export function activePercentOf(
  phase: ImportPhase,
  uploadPercent: number | null,
  importPercent: number | null,
): number | null {
  return phase === 'uploading' || phase === 'awaiting-confirm' ? uploadPercent : importPercent;
}

/** 阻塞/失败提示的标题（`failureStage` 为空 = 表单校验类输入错误） */
export function errorStatusOf(failureStage: ImportFailureStage): string {
  switch (failureStage) {
    case 'scan': return '读取失败';
    case 'upload': return '上传失败';
    case 'cancelled': return '导入已取消';
    case 'unknown': return '任务状态待确认';
    case 'import': return '导入失败';
    default: return '输入有误';
  }
}
