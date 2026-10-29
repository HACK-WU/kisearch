/**
 * taskActions.ts —— 任务详情动作区模型（纯函数，可单测）
 *
 * ═══ 为什么需要它（2026-10-13）═══
 * 任务详情此前只有**恒定一个**「前往导入页处理 →」，与任务状态无关：失败 / 取消 / 中断
 * 任务点过去大概率是空跑——导入页的「重试未完成」依赖浏览器凭据（localStorage 里的
 * uploadId）与内存 job 结果，凭据在 failed / cancelled 时已被清（ImportPage），
 * 且刷新恢复路径同样清理；CLI 来源的任务更是完全无从恢复。
 *
 * 本模块按 `state × source × 服务端清单可重试性` 生成动作：
 *   - 清单可重试 → 「重试未完成 N 篇」（服务端按清单执行，**不依赖浏览器凭据**）；
 *   - 不可重试 → 明说原因 + 替代动作（整批重导 / CLI 命令）；
 *   - `unknown`（心跳丢失）→ 只给「重新检查」，**刻意不给重试**（进程可能仍在跑，
 *     重试会与其重复导入）；
 *   - 成功任务 → 无动作（不再显示「前往导入页处理」）。
 *
 * 动作的**执行**在视图层（`TasksPage`），本模块只产出可判定的模型，便于单测覆盖分支。
 */

/** 参与动作判定的最小任务字段集（`TaskRecord` 的结构子集） */
export interface TaskActionSubject {
  id: string;
  scope: string;
  operation: string;
  state: string;
  source: string;
}

/** 未完成清单摘要的结构子集（`GET /api/import/incomplete` 响应） */
export interface ImportIncompleteShape {
  canRetry: boolean;
  itemCount: number;
  legacy?: boolean;
  taskId?: string;
  reason?: string;
  sourceKind?: 'upload' | 'external';
  sourceExists?: boolean;
  corrupted?: boolean;
  hasRecord?: boolean;
}

export type TaskActionKind =
  /** 服务端按清单重试未完成文件（主入口） */
  | 'retry-incomplete'
  /** 去导入页（整批重新导入；该页需用户重新确认 Scope，故不预填参数） */
  | 'goto-import'
  /** CLI 命令式出路（Web 端无执行入口时给出可复制命令） */
  | 'cli-command'
  /** 重新检查（unknown 先判定再行动） */
  | 'recheck'
  /** 停止页面导入的任务（2026-10-13 用户要求：任务中心对 web 来源的 queued/running 导入给停止入口） */
  | 'stop-import';

export interface TaskAction {
  kind: TaskActionKind;
  label: string;
  /** 次级说明（按钮下方展示） */
  hint?: string;
  /** CLI 命令原文（kind='cli-command'） */
  command?: string;
  primary?: boolean;
}

export interface TaskActionsResult {
  actions: TaskAction[];
  /** 提示条（原因 / 警告 / 进行中），无则缺省 */
  note?: string;
  noteTone?: 'info' | 'warn' | 'error';
}

/** 有恢复价值的非成功终态 */
const RECOVERABLE_STATES = new Set(['partial', 'failed', 'cancelled']);

/**
 * 各操作的 CLI 出路（Web 端刻意不提供执行入口的操作用它给可复制命令）。
 * ★ 不带任何真实路径：`--retry-incomplete` 会从清单读源目录；整批重导的占位符由用户替换。
 */
export function cliCommandFor(operation: string, scope: string): string | undefined {
  if (operation === 'import') return `ki import -s ${scope} --retry-incomplete`;
  if (operation === 'rebuild-vector') return `ki restore ${scope} --rebuild-vector --yes`;
  if (operation === 'restore-snapshot') return `ki restore ${scope} --from-snapshot --yes`;
  return undefined;
}

/** 可重试时的次级说明：把"依据哪份清单、会不会重复已完成文件"说清楚 */
function retryHint(incomplete: ImportIncompleteShape): string {
  const suffix = '只处理未完成文件，已完成部分不重算';
  // 归属冲突（incomplete.taskId !== task.id）不走这里：那条路径已改为不给重试按钮
  if (incomplete.legacy) return `清单由旧版本写入、无法确认归属：将按当前最新清单重试（${suffix}）`;
  if (incomplete.sourceKind === 'external') return `沿用上次导入的源目录与原批次参数（${suffix}）`;
  return `沿用上次上传的暂存文件与原批次参数（${suffix}）`;
}

/**
 * 生成任务详情的动作区模型。
 * @param input.incomplete 仅 import 任务查询；查询失败传 `incompleteError: true`（与"无清单"区分）
 */
export function taskDetailActions(input: {
  task: TaskActionSubject;
  incomplete?: ImportIncompleteShape | null;
  incompleteLoading?: boolean;
  incompleteError?: boolean;
  /**
   * 同 scope 正在跑的导入任务数（`queued` / `running`，与后端闸门同口径）。
   * ★ 2026-10-13 用户反馈：连点两次重试各起一个 job（第一次 running、第二次 queued）。
   * 根因是"能不能重试"此前只看清单——而重试 job 结束前清单不会变（`taskId` 仍是旧任务），
   * 按钮因此恒有效。正确判据是**该知识库此刻有没有导入在跑**（服务端状态，跨刷新/跨标签页成立）。
   */
  runningImports?: number;
}): TaskActionsResult {
  const { task } = input;

  // 成功任务：没有待办，不给任何"处理"动作（旧实现恒定显示跳转，与状态不符）
  if (task.state === 'succeeded') return { actions: [] };

  if (task.state === 'queued' || task.state === 'running') {
    // 页面导入（source='web'）可从任务中心停止：`/api/import/cancel` 只认 HTTP 入口启动的
    // job（2026-10-13 用户要求）。CLI / daemon 发起的任务在另一条通道，取消要在终端中断——这里
    // 如实指路而不是给一个点了没用的按钮。
    if (task.operation === 'import' && task.source === 'web') {
      return {
        actions: [{ kind: 'stop-import', label: '停止任务' }],
        note: '停止 = 当前 embedding / 向量批次完成后停止写入；已完成文档保留，未完成部分进入未完成清单（可再重试）。',
        noteTone: 'info',
      };
    }
    if (task.operation === 'import') {
      return {
        actions: [],
        note: '任务进行中（由 CLI / 后台服务发起）：如需停止，请在启动它的终端中断。',
        noteTone: 'info',
      };
    }
    return { actions: [], note: '任务进行中：结束后再决定是否需要重试。', noteTone: 'info' };
  }

  if (task.operation === 'import') {
    // 心跳丢失：先判定再行动（重试可能与仍在运行的任务重复导入）
    if (task.state === 'unknown') {
      return {
        actions: [
          { kind: 'recheck', label: '重新检查任务状态' },
          // ★ challenger 质疑修订：unknown 若确已中断（进程被杀），原先只有"重新检查"一条路，
          //   用户会被卡在"既不能重试、也无法推进"。补整批重导出口（非主按钮，文案先确认）。
          { kind: 'goto-import', label: '确认已中断后重新导入' },
        ],
        note: '任务来源已失去心跳：它可能仍在运行，也可能已中断。请先确认结果（或查看启动它的终端）；确认已中断后再重新导入，避免与仍在运行的任务叠加。',
        noteTone: 'warn',
      };
    }

    if (RECOVERABLE_STATES.has(task.state)) {
      if (input.incompleteError) {
        return {
          actions: [{ kind: 'goto-import', label: '前往导入页重新导入' }],
          note: '未完成清单查询失败：暂时无法确认哪些文件可重试。',
          noteTone: 'error',
        };
      }
      if (input.incompleteLoading) {
        return { actions: [], note: '正在检查未完成清单…', noteTone: 'info' };
      }
      // ★ 已有导入在跑 → 不接受重复重试（与服务端 409 闸门同口径；判据来自任务列表，
      //   跨刷新 / 跨标签页成立——用户反馈的"连点两次各起一个 job"正是缺了这道判据）。
      if ((input.runningImports ?? 0) > 0) {
        return {
          actions: [{ kind: 'recheck', label: '刷新任务状态' }],
          note: `该知识库已有导入任务在跑（${input.runningImports} 个排队 / 进行中）：等它完成后可按清单重试，避免重复处理同一批文件。`,
          noteTone: 'info',
        };
      }
      const incomplete = input.incomplete;
      /**
       * ★ 归属冲突（2026-10-13 评审 P1）：清单已属于**另一个任务**（被后续导入覆盖）时，
       * 后端按 `taskId` 必然 409 —— 此处再渲染主按钮就是"点了必然失败"的死按钮。
       * 改为说清「去哪重试」：最新任务在一览里可直接选中（列表就是按需重试的入口）。
       */
      const ownedByOther = Boolean(incomplete?.taskId && incomplete.taskId !== task.id);
      if (ownedByOther) {
        const cliActions: TaskAction[] = task.source === 'cli'
          ? [{
            kind: 'cli-command',
            label: '或在终端按当前清单重试',
            command: `ki import -s ${task.scope} --retry-incomplete`,
          }]
          : [];
        return {
          actions: [{ kind: 'goto-import', label: '前往导入页重新导入', primary: true }, ...cliActions],
          note: `未完成清单已属于任务 ${incomplete?.taskId?.slice(0, 8)}…（本任务的结果已被后续导入覆盖）：请在任务列表中选中**最新的导入任务**重试，或整批重新导入。`,
          noteTone: 'warn',
        };
      }
      if (incomplete?.canRetry && incomplete.itemCount > 0) {
        const actions: TaskAction[] = [{
          kind: 'retry-incomplete',
          label: `重试未完成 ${incomplete.itemCount} 篇`,
          primary: true,
          hint: retryHint(incomplete),
        }];
        // CLI 来源：额外给命令式出路（终端可能就在手边）
        if (task.source === 'cli') {
          actions.push({
            kind: 'cli-command',
            label: '或在终端重试',
            command: `ki import -s ${task.scope} --retry-incomplete`,
          });
        }
        return { actions };
      }

      const reason = incomplete?.reason ?? '没有可重试的未完成清单';
      const actions: TaskAction[] = [{ kind: 'goto-import', label: '前往导入页重新导入', primary: true }];
      if (task.source === 'cli') {
        actions.push({
          kind: 'cli-command',
          label: '或在终端重新导入',
          command: `ki import -s ${task.scope} --source <目录>`,
        });
      }
      return {
        actions,
        note: `${reason}。整批重新导入不会重复已完成文档（同名文档按当前策略处理）。`,
        noteTone: 'warn',
      };
    }

    // 理论不可达（queued/running/succeeded/unknown 已在前分支返回）：保守给整批入口
    return { actions: [{ kind: 'goto-import', label: '前往导入页' }] };
  }

  // 向量重建 / 快照还原：Web 端不提供执行入口（范围裁剪），只给可复制命令
  const command = cliCommandFor(task.operation, task.scope);
  return {
    actions: command ? [{ kind: 'cli-command', label: '复制恢复命令', command }] : [],
    note: 'Web 端暂不提供该操作的执行入口：请在终端执行对应命令后回到本页确认。',
    noteTone: 'info',
  };
}
