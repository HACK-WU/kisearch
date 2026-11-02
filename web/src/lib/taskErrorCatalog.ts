/**
 * taskErrorCatalog.ts —— 任务失败原因的单源映射（S-01 前端部分）
 *
 * 背景：`result.errorCode` 一直存在，但详情页只特判过 `ALL_FILES_DUPLICATES` /
 * `IMPORT_CANCELLED` 两个码，其余一律落到「未记录可判别原因」——「未记录」与事实不符。
 *
 * ★ 单源约定：本表 `reason` 必须与后端 `safeErrorSummary`（`src/lib/task-registry.ts`）
 *   产出的类别串**逐字一致**。否则同一失败在 CLI（读后端文案）与 Web（读本表）会给出两套说法。
 *   改后端分类时**必须同步本表**，由 `web/test/task-error-catalog.test.mjs` 锁定。
 *
 * ★ 未知码必须回退原文（`describeTaskError` 返回 undefined），不得显示成「未知错误」——
 *   那与被修复的「未记录可判别原因」是同一类吞信息问题。
 */

export interface TaskErrorDescription {
  /** 错误码原样回显，便于贴给支持方 */
  code: string;
  /** 一句话原因，不含错误码，句尾不带标点 */
  reason: string;
  /** 下一步可执行动作；无需动作时缺省 */
  next?: string;
  tone: 'danger' | 'warn';
}

/** 码 → 描述。键为后端 `result.errorCode` 原值。 */
export const TASK_ERROR_CATALOG: Record<string, TaskErrorDescription> = {
  // ─── Git 数据源 ───
  GIT_CLONE_TIMEOUT: {
    code: 'GIT_CLONE_TIMEOUT',
    reason: 'Git 克隆超时',
    next: '仓库过大时可改用浅克隆，或换用镜像地址',
    tone: 'danger',
  },
  GIT_NETWORK_FAILED: {
    code: 'GIT_NETWORK_FAILED',
    reason: '无法连接远端仓库',
    next: '检查网络 / DNS / 代理后再试',
    tone: 'danger',
  },
  GIT_AUTH_FAILED: {
    code: 'GIT_AUTH_FAILED',
    reason: 'Git 仓库认证失败',
    next: '在运行后台服务的环境配置 SSH agent 或 credential helper 后重新导入',
    tone: 'danger',
  },
  GIT_BRANCH_NOT_FOUND: {
    code: 'GIT_BRANCH_NOT_FOUND',
    reason: '远端分支不存在',
    next: '改为远端实际存在的分支后重新导入',
    tone: 'danger',
  },
  GIT_REPO_NOT_FOUND: {
    code: 'GIT_REPO_NOT_FOUND',
    reason: '仓库不存在或无权访问',
    next: '核对 Git 地址与访问权限',
    tone: 'danger',
  },
  CLONE_TARGET_EXISTS: {
    code: 'CLONE_TARGET_EXISTS',
    reason: '托管目录已存在',
    next: '执行 ki datasource remove --scope <scope> --purge --yes 清理后重试',
    tone: 'danger',
  },
  SOURCE_EMPTY: {
    code: 'SOURCE_EMPTY',
    reason: '没有可导入的文档',
    next: '核对子目录与扩展名白名单设置',
    tone: 'warn',
  },
  GIT_SCHEME_UNSUPPORTED: {
    code: 'GIT_SCHEME_UNSUPPORTED',
    reason: 'Git 地址或协议不受支持',
    next: '改用 https / ssh 地址；本地目录请用 --source 登记',
    tone: 'danger',
  },
  INVALID_BRANCH: {
    code: 'INVALID_BRANCH',
    reason: 'Git 分支不可用',
    next: '--branch 只接受远端分支（tag / commit 会得到 detached HEAD）',
    tone: 'danger',
  },
  CLONE_FAILED: {
    code: 'CLONE_FAILED',
    reason: 'Git 克隆失败',
    next: '展开「原因与日志」查看 git 原始输出',
    tone: 'danger',
  },
  CLONE_CANCELLED: {
    code: 'CLONE_CANCELLED',
    reason: '任务已取消',
    next: '需要时重新导入',
    tone: 'warn',
  },
  INVALID_SUBDIR: {
    code: 'INVALID_SUBDIR',
    reason: '仓库子目录不存在或不可用',
    next: '改为仓库内实际存在的路径',
    tone: 'danger',
  },
  INVALID_GIT_URL: {
    code: 'INVALID_GIT_URL',
    reason: 'Git 地址格式非法',
    next: '支持 https / ssh / scp-like（user@host:path）',
    tone: 'danger',
  },
  GIT_URL_CREDENTIALS: {
    code: 'GIT_URL_CREDENTIALS',
    reason: 'Git 地址不能包含密码',
    next: '改用 SSH key 或 credential helper',
    tone: 'danger',
  },
  CLONE_DIR_INSIDE_DATA_DIR: {
    code: 'CLONE_DIR_INSIDE_DATA_DIR',
    reason: '托管目录不能位于数据目录内',
    next: '调整数据源配置后重试',
    tone: 'danger',
  },
  INVALID_SCOPE: {
    code: 'INVALID_SCOPE',
    reason: '知识库标识非法',
    next: '检查 scope 命名后重试',
    tone: 'danger',
  },
  // ─── 任务 / 导入 / 向量 ───
  SCOPE_OPERATION_BUSY: {
    code: 'SCOPE_OPERATION_BUSY',
    reason: '同一知识库已有写入任务',
    next: '等待当前任务结束后再试',
    tone: 'warn',
  },
  ADD_REMOTE_FAILED: {
    code: 'ADD_REMOTE_FAILED',
    reason: '添加数据源失败',
    next: '展开「原因与日志」定位',
    tone: 'danger',
  },
  SYNC_ENQUEUE_FAILED: {
    code: 'SYNC_ENQUEUE_FAILED',
    reason: '登记成功但首次同步入队失败',
    next: '执行 ki datasource sync --scope <scope>',
    tone: 'warn',
  },
  VECTOR_DIMENSION_MISMATCH: {
    code: 'VECTOR_DIMENSION_MISMATCH',
    reason: '向量维度与当前 embedding 不匹配',
    next: '先重建向量（ki restore <scope> --rebuild-vector --yes）',
    tone: 'danger',
  },
  IMPORT_CANCELLED: {
    code: 'IMPORT_CANCELLED',
    reason: '导入已取消，已完成部分已保留',
    tone: 'warn',
  },
  ALL_FILES_DUPLICATES: {
    code: 'ALL_FILES_DUPLICATES',
    reason: '本批全部为疑似重复，未写入任何文件',
    next: '重新导入并选择「仍然导入」',
    tone: 'warn',
  },
};

/** 按错误码查；未知码返回 undefined（调用方必须回退原文，不得吞） */
export function describeTaskError(code: string | undefined): TaskErrorDescription | undefined {
  if (!code) return undefined;
  return TASK_ERROR_CATALOG[code];
}

/**
 * 旧记录（无 errorCode）按 `error` 文本反查同一条目。
 *
 * ★ 顺序不可调换：`clone 超时` 必须先于 `clone 失败`（后者是后端 `mapCloneFailure`
 *   的兜底文案，放前面会把超时吞成通用失败）；`远端分支不存在` 必须先于「只支持远端分支」。
 */
const TEXT_RULES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /认证失败：请在运行 daemon|configure SSH agent/i, code: 'GIT_AUTH_FAILED' },
  { pattern: /远端分支不存在|remote branch .* not found/i, code: 'GIT_BRANCH_NOT_FOUND' },
  { pattern: /仓库不存在或当前凭据无权访问|repository .* not found/i, code: 'GIT_REPO_NOT_FOUND' },
  { pattern: /无法连接远端|could not resolve host|network is unreachable/i, code: 'GIT_NETWORK_FAILED' },
  { pattern: /clone 超时|Git 克隆超时/, code: 'GIT_CLONE_TIMEOUT' },
  { pattern: /托管目录已存在/, code: 'CLONE_TARGET_EXISTS' },
  { pattern: /没有可导入文件/, code: 'SOURCE_EMPTY' },
  { pattern: /不支持明文 http|不支持该 Git 传输协议|本地目录请使用 --source/, code: 'GIT_SCHEME_UNSUPPORTED' },
  { pattern: /分支名非法|只支持远端分支/, code: 'INVALID_BRANCH' },
  { pattern: /clone 失败|Git 克隆失败/, code: 'CLONE_FAILED' },
  { pattern: /clone 已取消|任务已取消/, code: 'CLONE_CANCELLED' },
  { pattern: /子目录不存在/, code: 'INVALID_SUBDIR' },
  { pattern: /同一知识库已有写入任务/, code: 'SCOPE_OPERATION_BUSY' },
  { pattern: /维度不匹配|VECTOR_DIMENSION_MISMATCH/, code: 'VECTOR_DIMENSION_MISMATCH' },
];

export function describeErrorText(text: string | undefined): TaskErrorDescription | undefined {
  if (!text) return undefined;
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return TASK_ERROR_CATALOG[rule.code];
  }
  return undefined;
}

/** 渲染用：`原因（CODE）；下一步`（next 缺省时省略） */
export function formatTaskError(description: TaskErrorDescription): string {
  const suffix = description.next ? `；${description.next}` : '';
  return `${description.reason}（${description.code}）${suffix}`;
}
