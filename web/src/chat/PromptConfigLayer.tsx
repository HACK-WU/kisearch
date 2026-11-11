/**
 * 对话配置层（提示词 / Skill / 工具开关）—— 对话配置层 · 批次 1
 *
 * 定位：**面板内层**（`position:absolute; inset:0` 覆盖对话面板），不是 app 级抽屉 ——
 * 常驻面板宽 380px，任何"比面板还宽"的抽屉都装不下（见 docs/ui-design §7-7）。
 * 编辑动作则**跳出面板**：走 `PromptConfigModal`（portal 到 body），与 demo 的最终口径一致。
 *
 * 数据流：`usePromptConfig` 拉配置 → 层内持有**草稿** → 底栏「保存」整体替换提交。
 * 因此「取消」= 直接关闭并丢弃草稿，天然是回滚（无需快照对比）。
 *
 * ⚠️ 工具开关**批次 2 起真实生效**：保存后下一次提问即按开关暴露工具给 AI；
 *   写入/删除组开启需二次确认（开启 = 授权 AI 直接执行该类操作）。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import type { PromptConfig, PromptSkill } from '@/api/chatContract';
import { PromptConfigModal, type PromptEditDraft } from '@/chat/PromptConfigModal';
import { usePromptConfig } from '@/chat/usePromptConfig';
import {
  CONTEXT_LIMIT_K_MAX,
  DEFAULT_CONTEXT_CHARS,
  contextLimitHint,
  contextLimitToKText,
  formatKUnit,
  parseContextLimitK,
} from '@/lib/contextUsage';
import {
  budgetComboWarn,
  isHitsInputInvalid,
  isResponseCharsInputInvalid,
  parseKChars,
  parseStrictInt,
} from '@/lib/toolBudget';
import { EFFORT_FOLLOW_DEFAULT, buildEffortOptions, resolveEffortView } from '@/lib/reasoningEffort';

/**
 * 危险开关的二次确认。
 *
 * ★ 2026-11-11（用户拍板 A 方案）：**不再用遮罩 / 页面级模态** —— 它只是某一个开关的
 *   一次询问，没必要压暗整页。改为锚定被点开关所在那一行的**行内浮层**（无 scrim、不挤压后续行）。
 *   旧实现把遮罩就地渲染在 `.ki-chat-cfg`（`position:absolute; z-index:20`）里，被这个层叠
 *   上下文困住 ⇒ 全屏 / 浮动阅读器（`.ki-drawer` z-index:1000）把卡片整块盖住，
 *   用户只看到"整屏变黑、确认框不弹"（`.debug/chat-cfg-danger-confirm-blank-20261111`）。
 */
interface ConfirmState {
  title: string;
  text: string;
  onYes: () => void;
  /**
   * 触发它的开关按钮：浮层以它所在的 `.ki-chat-cfg__tool` 行为定位锚点，关闭时焦点也还给它。
   * 缺省（如「删除 skill」从编辑模态里发起、模态已关闭）⇒ 落在配置层头部下方。
   */
  anchor?: HTMLElement;
}

/**
 * 确认浮层的落点，坐标相对 `.ki-chat-cfg`（它的定位父级）。
 *
 * ★ 刻意用 `absolute`（不是 `fixed`）+ 相对定位父级的坐标：窄屏浮层 `.ki-chat-panel--overlay`
 *   带 `animation ... both`，动画停下后 `transform: translateX(0)` **仍在**，会让 `fixed`
 *   的参照系变成那块面板、坐标全体错位。相对定位父级计算对 transform 免疫。
 */
interface ConfirmRect {
  left: number;
  width: number;
  /** 行下方空间足够时用 top；不足则翻到行上方，用 bottom */
  top?: number;
  bottom?: number;
}

/** 行下方至少留这么多高度才往下弹，否则翻到行上方（≈ 卡片高度 + 间距） */
const CONFIRM_SPACE_BELOW = 170;

type ModalState =
  | { kind: 'prompt' }
  | { kind: 'new-skill' }
  | { kind: 'skill'; id: string };

/** 条目类型图标（与 demo 同一套，纯装饰） */
const ITEM_IC: Record<'prompt' | 'skill', ReactElement> = {
  prompt: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3" />
    </svg>
  ),
  skill: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 2.2l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.6l-3.3 1.8.7-3.7L2.7 6.1l3.7-.5z" />
    </svg>
  ),
};

const cloneConfig = (c: PromptConfig): PromptConfig => ({
  version: c.version,
  prompt: { ...c.prompt },
  skills: c.skills.map((s) => ({ ...s })),
  tools: { ...c.tools },
  // ★ 可选字段必须**显式搬运**：这是白名单式拷贝，漏掉它会让草稿静默丢掉用户覆盖值
  //   （表现为"改了 skill 保存一下，上下文上限就被清回默认了"）
  ...(c.contextChars !== undefined ? { contextChars: c.contextChars } : {}),
  // REQ-20261015-001：工具预算的两个覆盖值同样必须显式搬运（同一个白名单拷贝坑）
  ...(c.toolResponseChars !== undefined ? { toolResponseChars: c.toolResponseChars } : {}),
  ...(c.searchHitsPerCall !== undefined ? { searchHitsPerCall: c.searchHitsPerCall } : {}),
  // REQ-20261016-001：思考级别覆盖值——**第三个踩同一个坑的字段**，漏了就是"保存别的配置后档位被静默清空"
  ...(c.reasoningEffort !== undefined ? { reasoningEffort: c.reasoningEffort } : {}),
});

/** 新增 skill 的 id：符合服务端 `SKILL_ID_RE`（小写字母/数字开头，允许连字符） */
const newSkillId = () => `skill-${Date.now().toString(36)}`;

export interface PromptConfigLayerProps {
  onClose: () => void;
  /**
   * 保存成功后通知外层重拉 `GET /api/chat/config` —— 让上下文面板的分母 / 占比 / 预警档位
   * 立即跟着变（不刷新页面）。
   */
  onSaved: () => void;
}

export function PromptConfigLayer({ onClose, onSaved }: PromptConfigLayerProps) {
  const { loading, loadError, data, saving, saveError, fieldErrors, savedAt, reload, save } =
    usePromptConfig(true);

  const [draft, setDraft] = useState<PromptConfig | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [showSavedBar, setShowSavedBar] = useState(false);
  /** 确认浮层落点；null = 还没量到（首帧先藏起来，避免闪一下在左上角） */
  const [confirmRect, setConfirmRect] = useState<ConfirmRect | null>(null);
  const cfgRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);

  /**
   * ═══ 即时生效（2026-11-11 用户拍板 B 方案）═══
   * 底栏不再有「取消 / 保存」：工具开关、skill 增删改启停、上下文上限、工具预算、思考级别，
   * **改完即落盘**（用户原话「取消保存的按钮根本不需要，直接实施生效」）。
   * 为此维护一个"最新草稿 → 串行落盘"的小队列：
   *  · 串行：`PUT` 是整份替换，并发会让先发的旧快照盖掉后发的新改动
   *  · 合并：保存期间又改了几次，只补存最后一次（中间态对用户没有意义）
   *  · 文本输入走防抖（350ms）+ 失焦/关闭前 flush —— 边打字边发请求没有意义
   */
  const draftRef = useRef<PromptConfig | null>(null);
  const queuedRef = useRef<PromptConfig | null>(null);
  const inflightRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainRef = useRef<() => void>(() => {});

  const drain = useCallback(async (): Promise<void> => {
    if (inflightRef.current) return;
    const next = queuedRef.current;
    if (!next) return;
    queuedRef.current = null;
    inflightRef.current = true;
    let ok = false;
    try {
      ok = await save(next);
    } finally {
      // 即使 save 将来改成会抛，也不能把队列钉死在"在途"状态（否则后续改动永远不落盘）
      inflightRef.current = false;
    }
    if (ok) onSaved();
    // 保存期间又攒了新改动 → 接着存
    if (queuedRef.current) void drain();
  }, [save, onSaved]);
  useEffect(() => {
    drainRef.current = () => { void drain(); };
  }, [drain]);

  /** 提交一次改动：改草稿 + 立刻排队落盘 */
  const commit = useCallback((mutate: (d: PromptConfig) => PromptConfig): void => {
    const cur = draftRef.current;
    if (!cur) return;
    const next = mutate(cur);
    draftRef.current = next;
    setDraft(next);
    queuedRef.current = next;
    drainRef.current();
  }, []);

  /** 文本类输入：草稿即时跟随（不打断打字），落盘防抖 350ms */
  const commitDebounced = useCallback((mutate: (d: PromptConfig) => PromptConfig): void => {
    const cur = draftRef.current;
    if (!cur) return;
    const next = mutate(cur);
    draftRef.current = next;
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const latest = draftRef.current;
      if (!latest) return;
      queuedRef.current = latest;
      drainRef.current();
    }, 350);
  }, []);

  /** 把还在防抖窗口里的改动立刻写下去（失焦 / 关闭层之前） */
  const flushPending = useCallback((): void => {
    if (!debounceRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const latest = draftRef.current;
    if (!latest) return;
    queuedRef.current = latest;
    drainRef.current();
  }, []);

  /** 关闭配置层：先把防抖里的改动落地，否则「改完立刻关」会丢掉最后一次输入 */
  const handleClose = useCallback((): void => {
    flushPending();
    onClose();
  }, [flushPending, onClose]);

  /**
   * 卸载兜底：不是所有退出都走 `handleClose`（关整个 AI 面板、切路由、切会话都会直接卸载），
   * 那条路径上防抖窗口里的输入不能丢 —— 卸载时补一次 flush。
   * （flush 里的 `save` 在卸载后仍会发出 PUT；hook 侧的 setState 有 aliveRef 兜着）
   */
  useEffect(() => () => {
    if (!debounceRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const latest = draftRef.current;
    if (!latest) return;
    queuedRef.current = latest;
    drainRef.current();
  }, []);

  // ── 上下文窗口（REQ-20261014-001）：与其余项同属一份配置、同一个落盘动作 ──
  //    用户裁决（2026-10-14）：`config.yaml` 的 `llm.contextChars` 只作**部署默认**，
  //    界面上改的值单独存在 `prompt-config.json` 的 `contextChars`（**缺省 = 未覆盖**）。
  //    因此它与 skill / 工具开关同文件同一次 PUT —— 不会出现"跨文件写入无法原子"的问题。
  //    ★ 2026-11-11 起没有底部「保存」按钮：合法输入防抖 350ms 后自动落盘（见上方 commit*）。
  //    输入单位是 **K**（与面板显示同口径），落盘前换算为字符数。
  const [ctxText, setCtxText] = useState('');
  // ── 工具预算（REQ-20261015-001）：与上下文窗口同层、同一份配置 ──
  //    输入单位：返回上限用 **K 字符**（与上面同口径）；条数用 **条**。
  const [toolRespText, setToolRespText] = useState('');
  const [hitsText, setHitsText] = useState('');

  /** 「恢复默认」的目标值 = 部署默认（config.yaml 的 llm.contextChars，缺省 1000K） */
  const ctxDefaultChars = data?.contextCharsDefault ?? DEFAULT_CONTEXT_CHARS;
  const ctxTextInvalid = ctxText.trim() !== '' && parseContextLimitK(ctxText) === null;
  /** 是否用了用户覆盖值（决定徽标显示"自定义"还是"默认"） */
  const ctxOverridden = draft?.contextChars !== undefined;
  /** 合法但会显著影响读数体验的值（过小 → 长期预警区；过大 → 预警失效）：只提示、不拦截（R6） */
  const ctxSizeHint = useMemo(() => {
    const parsed = parseContextLimitK(ctxText);
    return parsed === null ? null : contextLimitHint(parsed);
  }, [ctxText]);

  /** 输入 → 草稿：合法才写；**空串视为"未覆盖"**（与「恢复默认」等价，不报错） */
  const handleCtxInput = (v: string): void => {
    setCtxText(v);
    const parsed = parseContextLimitK(v);
    if (parsed !== null) {
      commitDebounced((d) => ({ ...d, contextChars: parsed }));
    } else if (v.trim() === '') {
      commitDebounced((d) => {
        const { contextChars: _drop, ...rest } = d;
        return rest;
      });
    }
    // 非法（如 "abc"）：不落盘，草稿保持上一次的合法值（输入框旁已有提示）
  };

  /** 恢复默认 = **删掉覆盖值**（回到部署默认），不是写死 1000K */
  const handleCtxReset = (): void => {
    setCtxText(contextLimitToKText(ctxDefaultChars));
    commit((d) => {
      const { contextChars: _drop, ...rest } = d;
      return rest;
    });
  };

  // ── 工具预算（REQ-20261015-001）的解析、校验与草稿写入 ──
  //    边界一律读服务端 limits（前端不硬编码数字）；旧 daemon 缺字段时逐项容忍（不拦保存）。
  const trMin = data?.limits.toolResponseCharsMin;
  const trMax = data?.limits.toolResponseCharsMax;
  const trDefault = data?.limits.toolResponseCharsDefault ?? 10000;
  const hitsMin = data?.limits.searchHitsMin ?? 1;
  const hitsMax = data?.limits.searchHitsMax ?? 50;
  const hitsDefault = data?.limits.searchHitsDefault ?? 5;

  /** K 字符文本 → 字符数；空串或非法返回 null（调用方再区分"空 = 未覆盖"） */
  const trParsed = parseKChars(toolRespText);
  const hitsParsed = parseStrictInt(hitsText);
  const trInvalid = isResponseCharsInputInvalid(toolRespText, trMin, trMax);
  const hitsInvalid = isHitsInputInvalid(hitsText, hitsMin, hitsMax);
  const trOverridden = draft?.toolResponseChars !== undefined;
  const hitsOverridden = draft?.searchHitsPerCall !== undefined;
  /** 组合提示（场景推演发现）：条数 × 典型单条 ≈1.2K 字符 > 返回上限 ⇒ 多数返回会被截断 */
  const comboWarn = budgetComboWarn(hitsParsed, trParsed);

  // ── 思考级别（REQ-20261016-001）：选项**一律来自 config.yaml 的清单**（本地不内置取值表）──
  //    「跟随配置默认（不覆盖）」= **删除覆盖值**（哨兵只存在内存里，不落盘、不下发）
  const effortOverridden = draft?.reasoningEffort !== undefined;
  /** 生效值 = 草稿覆盖值 ?? 部署默认档（与后端三级链同口径） */
  const effortCurrent = draft?.reasoningEffort ?? data?.reasoningEffortDefault;
  const effortOptions = useMemo(
    () => buildEffortOptions(data?.reasoningEffortOptions, effortCurrent),
    [data?.reasoningEffortOptions, effortCurrent],
  );
  const effortView = resolveEffortView({
    options: data?.reasoningEffortOptions,
    def: data?.reasoningEffortDefault,
    current: effortCurrent,
    overridden: effortOverridden,
  });

  /** 选择档位：选「跟随配置默认」= 删字段；其余原样写入草稿（合法性最终由服务端按清单强校验） */
  const handleEffortChange = (v: string): void => {
    commit((d) => {
      if (v === EFFORT_FOLLOW_DEFAULT) {
        const { reasoningEffort: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, reasoningEffort: v };
    });
  };
  /** 恢复默认 = 删掉覆盖值（回到部署默认档；两者都无 ⇒ 不下发该参数） */
  const handleEffortReset = (): void => {
    commit((d) => {
      const { reasoningEffort: _drop, ...rest } = d;
      return rest;
    });
  };

  /** 工具返回上限：输入 → 草稿（合法才写；**空串 = 未覆盖**，与「恢复默认」等价） */
  const handleToolRespInput = (v: string): void => {
    setToolRespText(v);
    const parsed = parseKChars(v);
    const inRange = parsed !== null && (trMin === undefined || parsed >= trMin) && (trMax === undefined || parsed <= trMax);
    if (inRange) {
      commitDebounced((d) => ({ ...d, toolResponseChars: parsed }));
    } else if (v.trim() === '') {
      commitDebounced((d) => {
        const { toolResponseChars: _drop, ...rest } = d;
        return rest;
      });
    }
  };
  const handleToolRespReset = (): void => {
    setToolRespText(String(trDefault / 1000));
    commit((d) => {
      const { toolResponseChars: _drop, ...rest } = d;
      return rest;
    });
  };
  /** 检索条数默认值：输入 → 草稿 */
  const handleHitsInput = (v: string): void => {
    setHitsText(v);
    const parsed = parseStrictInt(v);
    if (parsed !== null && parsed >= hitsMin && parsed <= hitsMax) {
      commitDebounced((d) => ({ ...d, searchHitsPerCall: parsed }));
    } else if (v.trim() === '') {
      commitDebounced((d) => {
        const { searchHitsPerCall: _drop, ...rest } = d;
        return rest;
      });
    }
  };
  const handleHitsReset = (): void => {
    setHitsText(String(hitsDefault));
    commit((d) => {
      const { searchHitsPerCall: _drop, ...rest } = d;
      return rest;
    });
  };

  // 载入 / 保存成功后（服务端回传了新基线）都重置草稿，保证"内容 = 磁盘"；
  // 输入框文本只在此刻（基线变化）跟随，**不**随草稿逐字符同步 —— 否则用户输入
  // "5000" 的过程中会被归一化成 "500" 而打断输入。
  //
  // ⚠️ 即时生效改造（B 方案）后必须防「回写盖掉在途改动」：保存期间用户又改了东西，
  //    此时服务端回传的是**上一次**的快照，直接铺回本地会让那次改动凭空消失。
  //    · `queuedRef` 非空 = 还有更新的一版没落盘
  //    · `debounceRef` 非空 = 用户正在输入（防抖窗口内，草稿已新于基线）
  //    两者任一成立都跳过本次同步；否则会打断用户正在敲的输入框。
  useEffect(() => {
    if (!data || queuedRef.current || debounceRef.current) return;
    const next = cloneConfig(data.config);
    draftRef.current = next;
    setDraft(next);
    setCtxText(contextLimitToKText(next.contextChars ?? (data.contextCharsDefault ?? DEFAULT_CONTEXT_CHARS)));
    // 工具预算两个输入同样只在「基线变化」时同步（不随草稿逐字符刷新，避免打断输入）
    setToolRespText(String((next.toolResponseChars ?? (data.limits.toolResponseCharsDefault ?? 10000)) / 1000));
    setHitsText(String(next.searchHitsPerCall ?? data.limits.searchHitsDefault ?? 5));
  }, [data]);

  // "已保存"顶部细条：1.2s 自隐
  useEffect(() => {
    if (savedAt == null) return;
    setShowSavedBar(true);
    const t = setTimeout(() => setShowSavedBar(false), 1200);
    return () => clearTimeout(t);
  }, [savedAt]);

  // ── 危险开关确认浮层：关闭 / 定位 / 点外部收起 ──
  /** 关闭浮层（= 取消），焦点还给触发它的开关 */
  const closeConfirm = useCallback((): void => {
    const anchor = confirm?.anchor;
    setConfirm(null);
    setConfirmRect(null);
    if (anchor?.isConnected) anchor.focus({ preventScroll: true });
  }, [confirm]);

  /**
   * 现算落点：以「被点开关所在的那一行」为锚，优先落在行下方 6px；
   * 下方不足 `CONFIRM_SPACE_BELOW` 则翻到行上方。太靠边的行会做左右夹取，保证不出面板。
   */
  const placeConfirm = useCallback((): void => {
    const host = cfgRef.current;
    if (!confirm || !host) return;
    const h = host.getBoundingClientRect();
    const anchor = confirm.anchor;
    if (!anchor) {
      // 无锚点（删除 skill 这类从模态发起的确认）：落在层头部下方，横向撑满内容区
      const head = host.querySelector('.ki-chat-cfg__head');
      const top = head ? head.getBoundingClientRect().bottom - h.top + 8 : 56;
      setConfirmRect({ left: 12, width: Math.max(0, h.width - 24), top });
      return;
    }
    if (!anchor.isConnected) return;
    const body = host.querySelector('.ki-chat-cfg__body');
    const row = (anchor.closest('.ki-chat-cfg__tool') as HTMLElement | null) ?? anchor;
    const a = row.getBoundingClientRect();
    const b = body?.getBoundingClientRect();
    // 锚行被滚出可视区（或面板已收起）⇒ 直接收起浮层，不让它悬在别的内容上
    if (a.width === 0 || (b && (a.bottom < b.top + 4 || a.top > b.bottom - 4))) {
      closeConfirm();
      return;
    }
    const width = Math.min(a.width, h.width - 8);
    const left = Math.max(4, Math.min(a.left - h.left, h.width - width - 4));
    setConfirmRect(
      h.bottom - a.bottom >= CONFIRM_SPACE_BELOW
        ? { left, width, top: a.bottom - h.top + 6 }
        : { left, width, bottom: h.bottom - a.top + 6 },
    );
  }, [confirm, closeConfirm]);

  // 首帧在 paint 前定位（不用 effect + 一次可见的重排），滚动 / 缩放跟随
  useLayoutEffect(() => {
    if (!confirm) return;
    placeConfirm();
    const onMove = (): void => placeConfirm();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [confirm, placeConfirm]);

  // 点浮层之外一律视为取消（点开关本身除外 —— 它自己的 click 会重新走一遍确认）
  useEffect(() => {
    if (!confirm) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (confirmRef.current?.contains(t)) return;
      if (confirm.anchor?.contains(t)) return;
      closeConfirm();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [confirm, closeConfirm]);

  /**
   * 打开即把焦点放到「取消」（Enter 不该误开危险工具）。
   *
   * ⚠️ 依赖 `placed`：首帧卡片还是 `visibility: hidden`（落点没量到），对隐藏元素
   *    focus() 是**静默无效**的 —— 实测焦点会留在开关上，这里等落点就位后补一次。
   */
  const placed = confirmRect !== null;
  useEffect(() => {
    if (!confirm || !placed) return;
    confirmCancelRef.current?.focus({ preventScroll: true });
  }, [confirm, placed]);

  // Esc 分层退出：确认卡 → 模态（模态自带未保存确认）→ 配置层
  // ⚠️ 真机走查修正：原实现遇到 confirm 直接 return 且**没人在关卡**，
  //    导致"危险确认卡打开时 Esc 完全无效"（demo 有分层，落地时漏了）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modal) return; // 模态框自己处理（它还有一层未保存确认）
      if (confirm) {
        closeConfirm();
        return;
      }
      handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, confirm, closeConfirm, handleClose]);

  const groups = data?.toolGroups ?? [];
  /** 只读组默认开，危险组默认关 —— 但以配置里的实际值为准 */
  const toolEntries = useMemo(
    () => groups.map((g) => ({ ...g, rows: g.names.map((n) => ({ name: n, on: draft?.tools[n] === true })) })),
    [groups, draft],
  );

  /**
   * "默认 / 已修改"判定。
   *
   * ★ 2026-10-13：skill 的**描述也是配置的一部分** —— 只比 content 会让"改了描述"显示成"默认"，
   *   用户以为没保存上（描述现在决定 AI 要不要加载它，改它比改正文更常见）。
   */
  const isDefaultSkill = (s: PromptSkill): boolean => {
    const def = data?.defaults.skills.find((d) => d.id === s.id);
    if (!def) return false;
    return def.content === s.content && (def.description ?? '') === (s.description ?? '');
  };
  const isDefaultPrompt = (content: string): boolean => data?.defaults.prompt.content === content;

  /** 启用/停用：即时生效（B 方案 —— 不再等底部「保存」） */
  const toggleSkill = (id: string): void => {
    commit((d) => ({ ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) }));
  };

  const patchSkill = (id: string, patch: Partial<PromptSkill>): void => {
    commit((d) => ({ ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  };

  /** 落盘失败后的「重试」：把当前草稿重新排进队列（不丢用户改动，也不静默吞错） */
  const retrySave = (): void => {
    const latest = draftRef.current;
    if (!latest) return;
    queuedRef.current = latest;
    drainRef.current();
  };

  const modalItem: PromptEditDraft | null = (() => {
    if (!modal || !draft) return null;
    if (modal.kind === 'prompt') {
      // 基础提示词没有描述（它不是"可被调用的能力"，而是恒定注入的规则）
      return { id: 'prompt', name: '基础提示词', description: '', content: draft.prompt.content, builtin: true };
    }
    if (modal.kind === 'new-skill') {
      return { id: newSkillId(), name: '', description: '', content: '', builtin: false };
    }
    const s = draft.skills.find((x) => x.id === modal.id);
    return s ? { id: s.id, name: s.name, description: s.description, content: s.content, builtin: s.builtin } : null;
  })();

  return (
    <section ref={cfgRef} className="ki-chat-cfg" data-open="true" role="dialog" aria-modal="true" aria-label="对话配置">
      <div className="ki-chat-cfg__savedbar" data-open={showSavedBar} />

      <header className="ki-chat-cfg__head">
        <span className="ki-chat-cfg__title">对话配置</span>
        <span className="ki-chat-cfg__spacer" />
        <button type="button" className="ki-chat-iconbtn" aria-label="关闭配置" onClick={handleClose}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </header>

      <div className="ki-chat-cfg__body">
        {loading && <p className="ki-chat-cfg__hint">读取配置…</p>}
        {loadError && (
          <p className="ki-chat-cfg__warn">
            {loadError}
            <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={reload}>重试</button>
          </p>
        )}
        {/* 配置源损坏已回退默认：必须可见（fail-loud），否则用户会以为"我的改动没保存上" */}
        {data?.issue && <p className="ki-chat-cfg__warn">配置文件有问题，已回退默认：{data.issue}</p>}

        {draft && data && (
          <>
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                基础提示词
                <em className="ki-chat-cfg__badge">恒定生效</em>
              </span>
              <p className="ki-chat-cfg__hint">新建会话时注入一次并成为该会话的固定规则；此后改这里只对之后新建的会话生效。</p>
              <div className="ki-chat-cfg__list">
                <ItemCard
                  group="prompt"
                  name="基础提示词"
                  content={draft.prompt.content}
                  isDefault={isDefaultPrompt(draft.prompt.content)}
                  onClick={() => setModal({ kind: 'prompt' })}
                />
              </div>
            </div>

            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                Skill
                <em className="ki-chat-cfg__badge">{draft.skills.filter((s) => s.enabled).length} / {data.limits.maxSkills} 可调用</em>
              </span>
              <p className="ki-chat-cfg__hint">
                启用的 skill 只把「名称 + 描述」列给 AI（正文不常驻），由 AI 判断需要时加载；
                停用的不会出现在清单里，AI 也调不到。
              </p>
              <div className="ki-chat-cfg__list">
                {draft.skills.map((s) => (
                  <ItemCard
                    key={s.id}
                    group="skill"
                    name={s.name}
                    description={s.description}
                    content={s.content}
                    isDefault={isDefaultSkill(s)}
                    disabled={!s.enabled}
                    onToggleEnabled={() => toggleSkill(s.id)}
                    onClick={() => setModal({ kind: 'skill', id: s.id })}
                  />
                ))}
              </div>
              <button
                type="button"
                className="ki-chat-cfg__add"
                disabled={draft.skills.length >= data.limits.maxSkills}
                onClick={() => setModal({ kind: 'new-skill' })}
              >
                ＋ 新增 skill
              </button>
            </div>

            {/* ── 上下文窗口（REQ-20261014-001）：与其余项同属对话配置，随下方「保存」提交 ──
                用户裁决：`config.yaml` 的 `llm.contextChars` 只作**部署默认**，界面改的值单独存
                （`prompt-config.json` 的 `contextChars`），**不写配置文件** */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                上下文窗口
                <em className="ki-chat-cfg__badge">
                  {ctxOverridden ? '自定义' : `默认 ${formatKUnit(ctxDefaultChars)}`}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                上下文占比与预警的字符口径上限（K = 1000 字符），不是模型 token 窗口 ——
                调整它只改变读数与预警时机，不改变 AI 实际能承载的内容量。
                配置文件（config.yaml）里的值是默认值，这里填的值单独保存、不修改该文件。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <input
                  type="text"
                  inputMode="decimal"
                  className="ki-chat-cfg__ctxinput"
                  aria-label="上下文上限（K）"
                  aria-invalid={ctxTextInvalid || undefined}
                  value={ctxText}
                  onChange={(e) => handleCtxInput(e.target.value)}
                  onBlur={flushPending}
                />
                <span className="ki-chat-cfg__ctxunit">K</span>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={!ctxOverridden}
                  onClick={handleCtxReset}
                >
                  恢复默认
                </button>
              </div>
              <p className="ki-chat-cfg__hint">
                {ctxOverridden ? '当前：自定义 ' : '当前：默认 '}
                {formatKUnit(draft.contextChars ?? ctxDefaultChars)}
                （{(draft.contextChars ?? ctxDefaultChars).toLocaleString('en-US')} 字符）
                {ctxOverridden ? ` · 默认 ${formatKUnit(ctxDefaultChars)}` : ''}
              </p>
              {/**
                * 降级 fail-loud：旧版服务端不认识 `contextChars`，会**静默丢弃**（仍返回 200），
                * 表现为"保存成功但值没变"。这里前置告知，而不是等用户困惑 ——
                * 判据是响应里有没有 `contextCharsDefault`（新版本必有）。
                */}
              {data.contextCharsDefault === undefined && (
                <p className="ki-chat-cfg__warn">
                  服务端未返回上限的默认值：通常是后端尚未重启，本项的保存可能不会生效。
                </p>
              )}
              {ctxTextInvalid && (
                <p className="ki-chat-cfg__warn">
                  请输入正数（K）：如 500、1000；上限 {CONTEXT_LIMIT_K_MAX}K。
                </p>
              )}
              {/* R6：极小 / 极大但**合法**的值 —— 不拦截保存，只把"会发生什么"说清楚 */}
              {ctxSizeHint === 'small' && (
                <p className="ki-chat-cfg__warn">
                  值偏小：系统提示与检索规则本身约占 3~4K 字符，过小会让占比长期落在预警区
                  —— 只影响读数与预警，不影响 AI 实际能力。
                </p>
              )}
              {ctxSizeHint === 'large' && (
                <p className="ki-chat-cfg__warn">
                  值偏大：占比会长期接近 0，预警将失去意义（硬上界 {CONTEXT_LIMIT_K_MAX}K）。
                </p>
              )}
            </div>

            {/* ── 工具预算（REQ-20261015-001）：与上下文窗口同层、同一「保存」提交；
                   两个旋钮在同一分组里天然会被一起调 ⇒ 组合不合理时给提示（场景推演发现） ── */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                工具预算
                <em className="ki-chat-cfg__badge">
                  {trOverridden || hitsOverridden ? '自定义' : `默认 ${formatKUnit(trDefault)} / ${hitsDefault} 条`}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                仅作用于 AI 对话内的工具调用：返回上限是单次工具返回被截断的阈值；
                条数默认值是 AI 未指定时一次检索取回的条数（AI 可在 1–{hitsMax} 内自主指定）。
                与上面的「上下文窗口」不同 —— 这两项是真实行为预算，会改变 AI 实际看到的内容量。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <input
                  type="text"
                  inputMode="decimal"
                  className="ki-chat-cfg__ctxinput"
                  aria-label="工具返回上限（K 字符）"
                  aria-invalid={trInvalid || undefined}
                  value={toolRespText}
                  onChange={(e) => handleToolRespInput(e.target.value)}
                  onBlur={flushPending}
                />
                <span className="ki-chat-cfg__ctxunit">K 字符</span>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={!trOverridden}
                  onClick={handleToolRespReset}
                >
                  恢复默认
                </button>
              </div>
              <div className="ki-chat-cfg__ctxrow">
                <input
                  type="text"
                  inputMode="numeric"
                  className="ki-chat-cfg__ctxinput"
                  aria-label="检索条数默认值（条）"
                  aria-invalid={hitsInvalid || undefined}
                  value={hitsText}
                  onChange={(e) => handleHitsInput(e.target.value)}
                  onBlur={flushPending}
                />
                <span className="ki-chat-cfg__ctxunit">条</span>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={!hitsOverridden}
                  onClick={handleHitsReset}
                >
                  恢复默认
                </button>
              </div>
              {trInvalid && (
                <p className="ki-chat-cfg__warn">
                  返回上限请输入 {trMin !== undefined ? trMin / 1000 : '?'}–{trMax !== undefined ? trMax / 1000 : '?'} K 之间的数字。
                </p>
              )}
              {hitsInvalid && (
                <p className="ki-chat-cfg__warn">
                  检索条数请输入 {hitsMin}–{hitsMax} 之间的整数。
                </p>
              )}
              {/* 组合提示（场景推演 🟡）：两个旋钮一起调时的坑 —— 条数调大反而答得更差 */}
              {comboWarn && !trInvalid && !hitsInvalid && (
                <p className="ki-chat-cfg__warn">
                  按当前组合（{hitsParsed} 条 × 每条约 1.2K 字符）多数检索返回会被截断 —— 建议同时调大返回上限。
                </p>
              )}
              {data.limits.toolResponseCharsMax === undefined && (
                <p className="ki-chat-cfg__warn">
                  服务端未返回工具预算的上限：通常是后端尚未重启，本项的保存可能不会生效。
                </p>
              )}
            </div>

            {/* ── 思考级别（REQ-20261016-001）：选项**只能**来自 config.yaml 的清单（本地不内置取值表）── */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                思考级别
                <em className="ki-chat-cfg__badge">{effortView.badge}</em>
              </span>
              <p className="ki-chat-cfg__hint">
                档位由 config.yaml 的 llm.reasoningEfforts 提供，仅作用于 AI 对话请求。「跟随默认」=
                不使用覆盖值（回到部署默认档；都没有则不下发该参数）。档位是上游软约束：同一档位单次
                思考量波动很大（实测可达 10 倍），更高档通常更慢、更贵；多轮检索场景会叠加。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <select
                  className="ki-chat-cfg__select"
                  aria-label="思考级别"
                  // 收起态受列宽限制会省略（ellipsis）—— hover 显示完整名
                  title={effortOptions.find((o) => o.value === effortView.selectValue)?.label ?? ''}
                  disabled={!effortView.editable}
                  value={effortView.selectValue}
                  onChange={(e) => handleEffortChange(e.target.value)}
                >
                  {effortOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={!effortOverridden}
                  onClick={handleEffortReset}
                >
                  恢复默认
                </button>
              </div>
              {effortView.warn !== null && <p className="ki-chat-cfg__warn">{effortView.warn}</p>}
              {/**
                * 降级 fail-loud：旧版服务端不返回 `reasoningEffortOverridden`（新版恒有该字段）——
                * 表现为"选了档位、保存成功但值没变"，这里前置告知（与上下文窗口 / 工具预算同款范式）。
                */}
              {data.reasoningEffortOverridden === undefined && (
                <p className="ki-chat-cfg__warn">
                  服务端未返回思考级别的配置信息：通常是后端尚未重启，本项的保存可能不会生效。
                </p>
              )}
            </div>

            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                工具与权限
              </span>
              <p className="ki-chat-cfg__hint">开关即时生效（下一次提问即按新开关暴露工具）。默认只开只读工具；写入 / 删除开启即授权 AI 执行，请谨慎。</p>
              {toolEntries.map((g) => (
                <div key={g.key}>
                  <p className={`ki-chat-cfg__group${g.danger ? ' ki-chat-cfg__group--danger' : ''}`}>
                    <span className="ki-chat-cfg__group-dot" aria-hidden="true" />
                    {g.label}
                    <span className="ki-chat-cfg__group-n">
                      {g.rows.length} 个{g.danger ? ' · 危险 · 默认关' : ' · 默认开'}
                    </span>
                  </p>
                  {g.rows.map((r) => (
                    <div className="ki-chat-cfg__tool" key={r.name}>
                      <span className="ki-chat-cfg__tool-main">
                        <span className="ki-chat-cfg__tool-name" title={r.name}>{r.name}</span>
                        {g.descs?.[r.name] ? <span className="ki-chat-cfg__tool-desc">{g.descs[r.name]}</span> : null}
                      </span>
                      <span className="ki-chat-cfg__tool-sp" />
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.on}
                        aria-label={r.name}
                        className={`ki-chat-cfg__sw${g.danger ? ' ki-chat-cfg__sw--danger' : ''}`}
                        onClick={(e) => {
                          const next = !r.on;
                          // 即时生效（B 方案）：确认后立刻落盘，不再等底部「保存」
                          const apply = () => commit((d) => ({ ...d, tools: { ...d.tools, [r.name]: next } }));
                          if (next && g.danger) {
                            // anchor = 这个开关：确认浮层贴着它那一行弹出（无遮罩，见 ConfirmState 注释）
                            setConfirm({
                              title: '开启危险工具',
                              text: `${r.name} 会改动当前 scope 的知识库内容。开启后 AI 可在对话中直接执行该操作，请谨慎。`,
                              onYes: apply,
                              anchor: e.currentTarget,
                            });
                            return;
                          }
                          apply();
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 底栏只作状态说明（2026-11-11 用户拍板）：**没有「取消 / 保存」按钮** ——
          改动即时落盘，关掉层就等于"改完了"。保存失败必须可见（fail-loud）+ 可重试。 */}
      <footer className="ki-chat-cfg__bar">
        {/* 生效范围**分开说**（2026-10-13）：提示词/skill 随会话快照冻结，只影响新建会话；
            工具开关是即时读取的，下一次提问即生效 —— 混成一句会让"改了 skill 没反应"看起来像坏了 */}
        <span className="ki-chat-cfg__scope">作用域：全局 · 改动即时生效；提示词与 skill 对之后新建的会话生效</span>
        <span className="ki-chat-cfg__spacer" />
        {saveError ? (
          <>
            <span className="ki-chat-cfg__err">保存失败：{saveError}</span>
            <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={retrySave}>重试</button>
          </>
        ) : (
          // 打开时还没存过任何东西：说「改动即时保存」而不是「已自动保存」（后者是谎报状态）
          <span className="ki-chat-cfg__status" data-busy={saving}>
            {saving ? '保存中…' : savedAt != null ? '已自动保存' : '改动即时保存'}
          </span>
        )}
      </footer>

      {fieldErrors.length > 0 && (
        <div className="ki-chat-cfg__toast" data-open="true" role="status">
          {fieldErrors.map((f) => `${f.field}：${f.message}`).join('；')}
        </div>
      )}

      {modalItem && modal && (
        <PromptConfigModal
          mode={modal.kind === 'new-skill' ? 'new' : 'edit'}
          group={modal.kind === 'prompt' ? 'prompt' : 'skill'}
          item={modalItem}
          maxChars={modal.kind === 'prompt' ? data!.limits.promptMaxChars : data!.limits.skillMaxChars}
          nameMaxChars={data!.limits.skillNameMaxChars}
          descMaxChars={data!.limits.skillDescMaxChars}
          descSuggestedChars={data!.limits.skillDescSuggestedChars}
          canRename={modal.kind !== 'prompt' && !modalItem.builtin}
          canReset={modal.kind !== 'new-skill' && modalItem.builtin}
          canDelete={modal.kind !== 'new-skill' && !modalItem.builtin}
          checkName={(name) =>
            draft && draft.skills.some((s) => s.id !== modalItem.id && s.name === name)
              ? '已有同名 skill，请换一个名字'
              : null
          }
          onCancel={() => setModal(null)}
          onSubmit={({ name, content, description }) => {
            // 模态里的「保存」= 该条目的提交动作：提交即落盘（层底栏不再有整体保存）
            commit((d) => {
              if (modal.kind === 'prompt') return { ...d, prompt: { ...d.prompt, content } };
              if (modal.kind === 'new-skill') {
                return {
                  ...d,
                  skills: [...d.skills, { id: modalItem.id, name, description, content, builtin: false, enabled: true, at: new Date().toISOString() }],
                };
              }
              return { ...d, skills: d.skills.map((s) => (s.id === modal.id ? { ...s, name, content, description } : s)) };
            });
            setModal(null);
          }}
          onReset={() => {
            if (modal.kind === 'prompt') {
              commit((d) => ({ ...d, prompt: { ...d.prompt, content: data!.defaults.prompt.content } }));
              setModal(null);
              return;
            }
            if (modal.kind === 'skill') {
              // ★ 恢复默认必须**一并恢复描述**：只回正文会让"描述已改"与"正文是默认"混在一起，
              //   用户看不出到底恢复没恢复（描述是 AI 选不选它的唯一依据）。
              const def = data!.defaults.skills.find((s) => s.id === modal.id);
              patchSkill(modal.id, { content: def?.content ?? '', description: def?.description ?? '' });
              setModal(null);
            }
          }}
          onDelete={() => {
            if (modal.kind !== 'skill') return;
            const id = modal.id;
            setConfirm({
              title: '删除 skill',
              text: '该 skill 将被移除，确认后立即生效、不可撤销。',
              onYes: () => commit((d) => ({ ...d, skills: d.skills.filter((s) => s.id !== id) })),
            });
            setModal(null);
          }}
        />
      )}

      {/* 危险开关 / 删除 skill 的二次确认：**行内浮层、无遮罩**（2026-11-11 用户拍板 A 方案）。
          不再有 `.ki-chat-cfg__mask` —— 遮罩是被层叠上下文困住、全屏阅读器下整块看不见的元凶。
          定位在 useLayoutEffect 里现算（贴着触发它的那一行），未量到前先藏起来避免闪一下。 */}
      {confirm && (
        <div
          ref={confirmRef}
          className="ki-chat-cfg__card ki-chat-cfg__confirm"
          role="dialog"
          aria-label={confirm.title}
          style={confirmRect ? ({
            left: `${confirmRect.left}px`,
            width: `${confirmRect.width}px`,
            ...(confirmRect.top !== undefined ? { top: `${confirmRect.top}px` } : { bottom: `${confirmRect.bottom ?? 0}px` }),
          } as CSSProperties) : { visibility: 'hidden' }}
        >
          <h4>{confirm.title}</h4>
          <p>{confirm.text}</p>
          <div className="ki-chat-cfg__card-acts">
            <button ref={confirmCancelRef} type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={closeConfirm}>取消</button>
            <button
              type="button"
              className="ki-chat-btn ki-chat-btn--danger"
              onClick={() => { confirm.onYes(); closeConfirm(); }}
            >
              确认
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 条目卡片（提示词 / skill 共用） */
function ItemCard(props: {
  group: 'prompt' | 'skill';
  name: string;
  /** skill 描述（恒注入目录里给 AI 看的"何时用"）；基础提示词没有 */
  description?: string;
  content: string;
  isDefault: boolean;
  disabled?: boolean;
  /** 提供即渲染启用开关（skill 专用：基础提示词是恒定规则，不可停用） */
  onToggleEnabled?: () => void;
  onClick: () => void;
}) {
  const { group, name, description, content, isDefault, disabled, onToggleEnabled, onClick } = props;
  const mod = !isDefault;
  const desc = (description ?? '').trim();
  return (
    // ★ 开关在**卡片内部**（用户裁决：不要单独漏在外面）—— 卡片本身是 div，
    //   内部两枚按钮并列（点击区 + 开关）；按钮不能嵌按钮，故不再让卡片整体是一个 button。
    <div className="ki-chat-cfg__item" data-disabled={disabled}>
      <button type="button" className="ki-chat-cfg__item-hit" onClick={onClick}>
        <span className={`ki-chat-cfg__item-ic ki-chat-cfg__item-ic--${group}`}>{ITEM_IC[group]}</span>
        <span className="ki-chat-cfg__item-main">
          <span className="ki-chat-cfg__item-name">{name}</span>
          {/* skill 的第二行显示**描述**（AI 的选择依据）而不是正文摘要：正文不进上下文，摘要无意义 */}
          <span className="ki-chat-cfg__item-prev">
            {group === 'skill'
              ? (desc || '未填写描述 —— AI 只能凭名称判断要不要加载它')
              : (content.slice(0, 42) || '（空）')}
          </span>
        </span>
        <span className={`ki-chat-cfg__item-meta${mod ? ' ki-chat-cfg__item-meta--mod' : ''}`}>
          {content.length} 字 · {mod ? '已修改' : '默认'}
        </span>
        <svg className="ki-chat-cfg__chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6.5 4 10.5 8 6.5 12" />
        </svg>
      </button>
      {onToggleEnabled ? (
        <button
          type="button"
          role="switch"
          aria-checked={!disabled}
          aria-label={`${disabled ? '启用' : '停用'} skill ${name}`}
          title={disabled ? '已停用：AI 的可用清单里没有它，也调不到' : '可被 AI 调用（清单里只有名称与描述，正文按需加载）'}
          // ★ 复用工具开关的既有类（`__sw`）：同一层里两个开关必须是同一种外观语言
          //   （auto-review 一致性问题，原先新造 `__switch` 会有两套样式）
          className="ki-chat-cfg__sw"
          onClick={onToggleEnabled}
        />
      ) : null}
    </div>
  );
}
