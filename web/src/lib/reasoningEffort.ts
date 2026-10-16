/**
 * 思考级别（REQ-20261016-001）的 UI 派生逻辑 —— **纯函数**，便于单测（不依赖 React）。
 *
 * 口径速查（与 `design/DESIGN.md` §2 / §4.5 / §5 决策 3 一致）：
 *   · 档位取值集合**一律来自 `config.yaml` 的清单**（`reasoningEffortOptions`），本地不内置任何取值表；
 *   · 面板的「跟随配置默认（不覆盖）」= **删除 `prompt-config.json` 的 `reasoningEffort` 字段**，
 *     哨兵 `__follow_default__` 只存在于内存，**不落盘、不下发**（服务端把它当保留值 → 400）；
 *   · 清单未配置（字段缺失）与显式空清单 `[]` **语义不同**：都不可调，但文案不同。
 */

/** 哨兵：面板用它表示"不覆盖"。**不得**写入配置文件（服务端拒绝）。 */
export const EFFORT_FOLLOW_DEFAULT = '__follow_default__';

export interface EffortOption {
  value: string;
  label: string;
}

/**
 * 下拉选项 = 「跟随配置默认」+ 清单；
 * 若当前生效值**脱离清单**（运维事后改小了清单），额外把它插进选项 ——
 * 否则 `<select>` 无法显示真实值，UI 会撒谎成"跟随配置默认"。
 */
export function buildEffortOptions(options?: readonly string[], current?: string): EffortOption[] {
  const list = options ?? [];
  // 标签刻意**短**：下拉与上方输入框同列宽（84px），收起态放不下长文案；
  // 不覆盖的语义由分组 hint + select 的 title 说明
  const out: EffortOption[] = [{ value: EFFORT_FOLLOW_DEFAULT, label: '跟随默认' }];
  for (const v of list) {
    // 清单里若出现保留字（服务端会拦配置），前端不重复渲染
    if (v !== EFFORT_FOLLOW_DEFAULT) out.push({ value: v, label: v });
  }
  const cur = current?.trim();
  if (cur && cur !== EFFORT_FOLLOW_DEFAULT && !list.includes(cur)) {
    out.push({ value: cur, label: `${cur}（不在清单内）` });
  }
  return out;
}

export interface EffortViewInput {
  /** 清单；`undefined` = 运维未配置 */
  options?: readonly string[];
  /** 部署默认档 */
  def?: string;
  /** 当前生效值（覆盖值 ?? 部署默认档） */
  current?: string;
  /** 是否用了用户覆盖值 */
  overridden: boolean;
}

export interface EffortView {
  /** 下拉是否可操作（清单为空 / 未配置 ⇒ false） */
  editable: boolean;
  /** 下拉当前取值（保留字或真实档位） */
  selectValue: string;
  /** 徽标文案 */
  badge: string;
  /** 需要展示的提示/警告行（null = 无需展示） */
  warn: string | null;
}

/** 三态派生：未配置 / 脱离清单 / 正常（自定义 or 默认）。 */
export function resolveEffortView(input: EffortViewInput): EffortView {
  const { options, def, current, overridden } = input;
  const list = options ?? [];
  const cur = current?.trim();
  const selectValue = cur ? cur : EFFORT_FOLLOW_DEFAULT;

  if (options === undefined) {
    return {
      editable: false,
      selectValue,
      badge: '未配置',
      warn: '未配置可选档位：请在 config.yaml 的 llm.reasoningEfforts 中列出可选值，本项暂不可调。',
    };
  }
  if (options.length === 0) {
    return {
      editable: false,
      selectValue,
      badge: '未配置',
      warn: '可选档位清单为空：请在 config.yaml 的 llm.reasoningEfforts 中补充档位。',
    };
  }
  if (cur && !list.includes(cur)) {
    return {
      editable: true,
      selectValue,
      badge: '自定义',
      warn: `当前值「${cur}」不在可选清单内（清单已变更）；仍会按此值发送，可点「恢复默认」回到默认档。`,
    };
  }
  const defText = def?.trim();
  return {
    editable: true,
    selectValue,
    badge: overridden ? '自定义' : (defText ? `默认 ${defText}` : '跟随默认'),
    warn: null,
  };
}
