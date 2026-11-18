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
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { AnalysisConfig, FindConfig, PromptConfig, PromptSkill } from '@/api/chatContract';
import type { ScopeInfo } from '@/api/mcpClient';
import { PromptConfigModal, type PromptEditDraft } from '@/chat/PromptConfigModal';
import { clonePromptConfig } from '@/chat/promptConfigClone';
import { usePromptConfig } from '@/chat/usePromptConfig';
import { ScopeMultiPicker } from '@/components/ScopeMultiPicker';
import { useScopeList } from '@/lib/hooks';
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
  /** 主按钮文案（缺省「确认」）。非破坏性指引用动词更好读，如「去启用」 */
  yesLabel?: string;
  /** 主按钮是否用危险色（缺省 true —— 既有调用都是危险动作） */
  yesDanger?: boolean;
}

/**
 * skill ↔ MCP 工具的前置依赖（2026-11-11）。
 *
 * ⚠️ 与后端 `prompt-config.ts::SKILL_REQUIRED_TOOLS` **手工同源**（服务端仍是最终闸门，400 兜底）；
 *   回归由 `web/test/skill-name-english.test.mjs` 守着。前端这份只负责「不让人白点」：
 *   工具没开时点 skill 开关 → 指路；关工具时 → 拦一次并把依赖它的 skill 一起停用。
 */
const SKILL_REQUIRED_TOOLS: Readonly<Record<string, string>> = {
  'builtin-doc-editing': 'ki_edit_relation',
};

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
/**
 * 确认卡最小宽度。
 *
 * ★ 硬兜底，别删（2026-11-12 真机事故）：宽度原先直接取「锚行宽度」，而 skill 的开关在
 *   `.ki-chat-cfg__item` 卡片里、不在 `.ki-chat-cfg__tool` 行里 ⇒ 锚行退化成了 36px 的开关
 *   按钮本身，卡片被算成 36px 宽、正文可用宽度只剩 2px，中文逐字竖排成 892px 高的长条。
 *   现在锚行已扩到卡片（见 placeConfirm），这条下限继续兜住"以后新增锚点又是窄元素"的情况。
 */
const CONFIRM_MIN_WIDTH = 240;

type ModalState =
  | { kind: 'prompt' }
  | { kind: 'new-skill' }
  | { kind: 'skill'; id: string }
  /** AI 分析独立配置域（REQ-20261113-003 · S-01） */
  | { kind: 'analysis' }
  | { kind: 'new-analysis-skill' }
  | { kind: 'analysis-skill'; id: string }
  | { kind: 'find' }
  /** AI 查找专属 skill 的正文编辑（二期补齐：一期只做了启停） */
  | { kind: 'find-skill'; id: string };

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

// 白名单式深拷贝已抽到 `promptConfigClone.ts`（纯函数，有单测机械锁字段搬运）
const cloneConfig = clonePromptConfig;

/** 新增 skill 的 id：符合服务端 `SKILL_ID_RE`（小写字母/数字开头，允许连字符） */
const newSkillId = () => `skill-${Date.now().toString(36)}`;

/** AI 分析 skill ↔ 只读工具前置依赖（与后端 `ANALYSIS_SKILL_REQUIRED_TOOLS` 手工同源） */
const ANALYSIS_SKILL_REQUIRED_TOOLS: Readonly<Record<string, string>> = {
  'builtin-code-locate': 'fs_read',
};

const EMPTY_ANALYSIS_CONFIG: AnalysisConfig = {
  targetDirs: { byScope: {} },
  prompt: { content: '', at: '' },
  skills: [],
  tools: {},
};

/** `find` 缺失时的兜底（旧后端不返回 find 域时，界面不能崩） */
const EMPTY_FIND_CONFIG: FindConfig = {
  ranges: { extraScopes: [] },
  prompt: { content: '', at: '' },
  skills: [],
  tools: {},
};

function isAbsPathInvalid(value: string): boolean {
  const v = value.trim();
  return v !== '' && !v.startsWith('/');
}

/** 系统路径黑名单（与后端 `prompt-config.ts` 的 `FORBIDDEN_TARGET_ROOTS` 同口径） */
const FORBIDDEN_DIR_ROOTS = ['/proc', '/sys', '/dev'];

/**
 * 分析目标目录的本地校验：返回错误文案，`null` = 通过。
 *
 * 与后端 `validateTargetDirString` 对齐（绝对路径 / 空字符 / 系统路径），
 * 目的只是让用户点「保存」时当场看到原因（后端 400 的文案不落在这一行，
 * 用户很难对上号）；真正的强约束仍在后端。
 */
function dirPathIssue(raw: string): string | null {
  const v = raw.trim();
  if (!v) return '目录路径不能为空';
  if (v.includes('\0')) return '目录路径不能包含空字符';
  if (!v.startsWith('/')) return '目录路径必须是绝对路径（以 / 开头）';
  const norm = v.length > 1 ? v.replace(/\/+$/, '') : v;
  if (norm === '/' || FORBIDDEN_DIR_ROOTS.some((r) => norm === r || norm.startsWith(`${r}/`))) {
    return `不允许使用系统路径（${norm}）`;
  }
  return null;
}

/** 设置页的能力分组（与 `/settings/ai` 左栏一一对应） */
export type CapabilitySection = 'chat' | 'analysis' | 'find';

export interface PromptConfigLayerProps {
  onClose: () => void;
  /**
   * 保存成功后通知外层重拉 `GET /api/chat/config` —— 让上下文面板的分母 / 占比 / 预警档位
   * 立即跟着变（不刷新页面）。
   */
  onSaved: () => void;
  /**
   * 只渲染某一个能力区块（2026-11-15 设置页），缺省 `'chat'` = 对话配置（面板既有行为不变）。
   *
   * 为什么不是三份组件：三条能力的**存储、草稿、落盘队列、只读门禁完全同一份**，
   * 拆成三个组件等于把 `commit / drain / cloneConfig` 抄三遍 —— 抄一份就漂一份。
   */
  capability?: CapabilitySection;
  /** 隐藏自带头部（设置页已有 H1 + 返回，重复标题只会挤占高度） */
  hideHeader?: boolean;
  /** 只读账号：可查看全部配置，写控件禁用（后端 PUT 仍按 `knowledge.write` 403 兜底） */
  readOnly?: boolean;
}

export function PromptConfigLayer({ onClose, onSaved, capability = 'chat', hideHeader = false, readOnly = false }: PromptConfigLayerProps) {
  const { loading, loadError, data, saving, saveError, fieldErrors, savedAt, reload, save } =
    usePromptConfig(true);
  const { data: scopeListData } = useScopeList();

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

  /**
   * 提交一次改动：改草稿 + 立刻排队落盘。
   *
   * ★ 只读门禁的**最后一道前端闸门**（2026-11-15）：无写权限时任何改动都不入队。
   *   界面上已禁用控件，这里再兜一次是为了覆盖键盘 / 程序化触发的路径；
   *   真正的强约束仍在后端（`PUT` 按 `knowledge.write` 403）。
   */
  const commit = useCallback((mutate: (d: PromptConfig) => PromptConfig): void => {
    if (readOnly) return;
    const cur = draftRef.current;
    if (!cur) return;
    const next = mutate(cur);
    draftRef.current = next;
    setDraft(next);
    queuedRef.current = next;
    drainRef.current();
  }, [readOnly]);

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

  /** 「分析目标目录」是否有未保存草稿（handleClose 与数据回填 effect 都要读，故走 ref） */
  const analysisDirtyRef = useRef(false);
  /**
   * 目录块的显式保存动作由下方 `saveAnalysisDirs` 定义后注入 —— 这里只存引用：
   * `handleClose` 的依赖数组会在**渲染期**求值，直接引用后声明的 const 会撞 TDZ。
   */
  const saveAnalysisDirsRef = useRef<() => boolean>(() => true);

  /**
   * 关闭配置层：先把防抖里的改动落地，否则「改完立刻关」会丢掉最后一次输入。
   *
   * ★ 「分析目标目录」是**显式保存**块，草稿不进 `draftRef` —— 它的未保存改动不在这里
   *   拦一下就静默蒸发了（同层的其它字段都是即时落盘，唯独它可能丢）。所以脏的时候先问。
   */
  const handleClose = useCallback((): void => {
    flushPending();
    if (analysisDirtyRef.current) {
      setConfirm({
        title: '分析目标目录有未保存的改动',
        text: '这些目录配置还没保存，直接关闭会丢失。',
        yesLabel: '保存并关闭',
        yesDanger: false,
        onYes: () => {
          // 校验不通过就留在页面上看逐行原因，不能"关掉就算存了"
          if (saveAnalysisDirsRef.current()) onClose();
        },
      });
      return;
    }
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
  // ── AI 分析独立配置（REQ-20261113-003 · S-01）──
  const [analysisDefaultDirText, setAnalysisDefaultDirText] = useState('');
  const [analysisByScopeRows, setAnalysisByScopeRows] = useState<Array<{ scope: string; dir: string }>>([]);
  const [newScopePick, setNewScopePick] = useState('');
  const [newScopeDir, setNewScopeDir] = useState('');
  /** 「保存目录配置」被拦下的原因（逐行文案，空 = 无错） */
  const [analysisDirErrors, setAnalysisDirErrors] = useState<string[]>([]);
  /**
   * 上一次基线里的 `targetDirs` 签名。
   * 目录块是显式保存，而本层**其他字段**仍是即时保存 —— 它们每次 PUT 成功都会回传新基线，
   * 若无条件把基线铺回输入框，用户填了一半的目录就会被冲掉。只有「基线里的目录真的变了」
   * （= 自己点了保存 / 别的端改了配置）才覆盖草稿。
   */
  const lastSavedTargetDirsRef = useRef<string>('');

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

  // ── AI 分析配置与思考级别（REQ-20261113-003 · S-01）──
  const analysisCfg: AnalysisConfig = draft?.analysis ?? data?.defaults.analysis ?? EMPTY_ANALYSIS_CONFIG;
  const analysisDirsConfigured = Boolean(analysisCfg.targetDirs.defaultDir)
    || Object.keys(analysisCfg.targetDirs.byScope).length > 0;
  /**
   * 目录块是否有未保存改动。
   * 连「半截行」（scope 或路径为空、路径非法）也算脏 —— 否则用户正在打字时
   * 「保存」按钮一直是禁用态，看不出还有没落盘的东西。
   *
   * ★ 按 scope **排序后**比对，不按下标：删掉中间一行再补回来、或先保存再加行，
   *   行序与 `byScope` 的键序会不同 —— 按下标比会把"顺序不同"误判成"有改动"。
   */
  const analysisDirsDirty = useMemo(() => {
    if (analysisDefaultDirText.trim() !== (analysisCfg.targetDirs.defaultDir ?? '')) return true;
    const saved = Object.entries(analysisCfg.targetDirs.byScope)
      .map(([scope, dir]) => `${scope}\u0000${dir}`)
      .sort();
    const local = analysisByScopeRows
      .filter((r) => r.scope.trim() && r.dir.trim())
      .map((r) => `${r.scope.trim()}\u0000${r.dir.trim()}`)
      .sort();
    if (saved.length !== local.length) return true;
    return saved.some((v, i) => v !== local[i]);
  }, [analysisByScopeRows, analysisDefaultDirText, analysisCfg.targetDirs]);
  /**
   * 把脏状态同步给 ref：数据回填 effect 只依赖 `[data]`，读不到最新的 `analysisDirsDirty`。
   * 本 effect 定义在回填 effect **之前**，同一渲染内先执行，后者读到的是新值。
   */
  useEffect(() => {
    analysisDirtyRef.current = analysisDirsDirty;
  }, [analysisDirsDirty]);
  /**
   * 目录块的角标。`saveError` 时显示「保存失败」—— 这一块是**乐观更新**（先改草稿再 PUT），
   * 落盘失败时 `analysisDirsDirty` 已是 false、按钮又被禁用，光看这一块会以为存上了。
   */
  const analysisDirsBadge = analysisDirsDirty
    ? { text: '有未保存改动', cls: '' }
    : saveError
      ? { text: '保存失败', cls: ' ki-chat-cfg__badge--err' }
      : analysisDirsConfigured
        ? { text: '已配置', cls: ' ki-chat-cfg__badge--ok' }
        : { text: '未配置', cls: '' };
  // 2026-11-18：轮次 / 文件数上限整体取消，相关派生值一并移除

  const analysisEffortOverridden = analysisCfg.reasoningEffort !== undefined;
  const analysisEffortCurrent = analysisCfg.reasoningEffort ?? data?.reasoningEffortDefault;
  const analysisEffortOptions = useMemo(
    () => buildEffortOptions(data?.reasoningEffortOptions, analysisEffortCurrent),
    [data?.reasoningEffortOptions, analysisEffortCurrent],
  );
  const analysisEffortView = resolveEffortView({
    options: data?.reasoningEffortOptions,
    def: data?.reasoningEffortDefault,
    current: analysisEffortCurrent,
    overridden: analysisEffortOverridden,
  });

  const mutateAnalysis = (mutate: (a: AnalysisConfig, root: PromptConfig) => AnalysisConfig, debounced = false): void => {
    const fn = debounced ? commitDebounced : commit;
    fn((d) => {
      const base = d.analysis ?? data?.defaults.analysis ?? EMPTY_ANALYSIS_CONFIG;
      const nextAnalysis = mutate(base, d);
      return {
        ...d,
        analysis: nextAnalysis,
        analysisPrompt: nextAnalysis.prompt,
      };
    });
  };

  // ── AI 查找范围 / 工具（REQ-20261116-005 · S-01）──
  const findCfg: FindConfig = draft?.find ?? data?.defaults.find ?? EMPTY_FIND_CONFIG;
  const findMaxTargets = data?.limits.findMaxTargets ?? 5;
  /**
   * 可选库 = 库 + 视图。
   *
   * 视图不是物理库，`ScopeMultiPicker` 只认 `ScopeInfo`，这里补一份最小载体：
   * 仅用于选择与展示（`optionMeta` 会标出「视图 · N 成员」），不参与任何计数逻辑。
   */
  const findViewMap = useMemo(
    () => new Map((scopeListData?.views ?? []).map((v) => [v.view, v])),
    [scopeListData?.views],
  );
  const findScopeOptions: ScopeInfo[] = useMemo(() => [
    ...(scopeListData?.scopes ?? []),
    ...(scopeListData?.views ?? []).map((v) => ({
      scope: v.view,
      kb: true,
      vector: true,
      registered: true,
      wikiCount: v.members.length,
      ftsOnlyDocCount: 0,
    })),
  ], [scopeListData]);
  const findScopeMeta = (info: ScopeInfo): ReactNode => {
    const view = findViewMap.get(info.scope);
    return view ? `视图 · ${view.members.length} 成员` : undefined;
  };

  const mutateFind = (mutate: (f: FindConfig, root: PromptConfig) => FindConfig, debounced = false): void => {
    const fn = debounced ? commitDebounced : commit;
    fn((d) => {
      const base = d.find ?? data?.defaults.find ?? EMPTY_FIND_CONFIG;
      const nextFind = mutate(base, d);
      return { ...d, find: nextFind, findPrompt: nextFind.prompt };
    });
  };

  // ── AI 查找思考级别 ──（2026-11-18：轮次 / 候选数 / 超时上限整体取消，只留思考级别）
  const findEffortCurrent = findCfg.reasoningEffort ?? data?.reasoningEffortDefault;
  const findEffortOptions = useMemo(
    () => buildEffortOptions(data?.reasoningEffortOptions, findEffortCurrent),
    [data?.reasoningEffortOptions, findEffortCurrent],
  );
  const findEffortView = resolveEffortView({
    options: data?.reasoningEffortOptions,
    def: data?.reasoningEffortDefault,
    current: findEffortCurrent,
    overridden: findCfg.reasoningEffort !== undefined,
  });

  /**
   * 启停查找 skill：依赖工具没开时**不放行**，改为指路（与对话 / 分析同一守卫）。
   * 停用方向永远放行（关掉不需要任何前置条件）。
   */
  const toggleFindSkill = (id: string, anchor?: HTMLElement): void => {
    const target = findCfg.skills.find((s) => s.id === id);
    const need = data?.findSkillRequiredTools?.[id];
    if (target && !target.enabled && need && findCfg.tools[need] !== true) {
      setConfirm({
        title: `需先启用 ${need} 工具`,
        text: '请先开启这个只读工具，再回来启用该 skill。',
        yesLabel: '去启用',
        yesDanger: false,
        onYes: () => revealTool(need),
        ...(anchor ? { anchor } : {}),
      });
      return;
    }
    mutateFind((f) => ({
      ...f,
      skills: f.skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    }));
  };

  const handleAnalysisEffortChange = (v: string): void => {
    mutateAnalysis((a) => {
      if (v === EFFORT_FOLLOW_DEFAULT) {
        const { reasoningEffort: _drop, ...rest } = a;
        return rest;
      }
      return { ...a, reasoningEffort: v };
    });
  };
  const handleAnalysisEffortReset = (): void => {
    mutateAnalysis((a) => {
      const { reasoningEffort: _drop, ...rest } = a;
      return rest;
    });
  };

  // ── 分析目标目录：**块级草稿 + 显式保存**（2026-11-16 用户拍板「输入框旁边要有保存按钮」）──
  //    不像本层其它字段那样即时落盘，原因有三个：
  //      1. 逐字符保存会把半截路径写成配置（路径很长，通常靠粘贴）；
  //      2. 编辑中途把某行清空会被"整份重建 byScope"当成删除，静默丢映射；
  //      3. 目录是否需要可读，只有触发分析时才知道 —— 保存动作给用户一个明确的确认点。
  //    未保存的草稿**不会被别的字段的保存回传基线冲掉**：见下方 lastSavedTargetDirsRef。
  const setAnalysisRow = (idx: number, patch: Partial<{ scope: string; dir: string }>): void => {
    setAnalysisByScopeRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setAnalysisDirErrors([]);
  };
  const removeAnalysisRow = (idx: number): void => {
    const nextRows = analysisByScopeRows.filter((_, i) => i !== idx);
    setAnalysisByScopeRows(nextRows);
    setAnalysisDirErrors([]);
    // 删除同样是明确动作：立即落盘（否则用户点完 × 还以为删掉了）
    saveAnalysisDirs(nextRows);
  };
  const clearAnalysisDefaultDir = (): void => {
    setAnalysisDefaultDirText('');
    setAnalysisDirErrors([]);
  };
  /** 「确认」= 加入映射并**立即落盘**（新增行不留在草稿里等全局保存） */
  const addAnalysisRow = (): void => {
    const sc = newScopePick.trim();
    const dir = newScopeDir.trim();
    if (!sc || !dir) return;
    const nextRows = [...analysisByScopeRows.filter((r) => r.scope !== sc), { scope: sc, dir }];
    setAnalysisByScopeRows(nextRows);
    setNewScopePick('');
    setNewScopeDir('');
    setAnalysisDirErrors([]);
    saveAnalysisDirs(nextRows);
  };
  /**
   * 保存整块（默认目录 + 全部映射）：先本地校验，全部通过才一次性写入草稿并立即落盘。
   * 校验口径与后端 `validateTargetDirString` 对齐（绝对路径 + 禁系统路径），
   * 避免"前端放行、后端 400"这种来回。
   *
   * @param overrideRows 刚算出来、还没进 state 的行（选 scope / 新增行时同步落盘用）——
   *   直接读 state 会拿到上一帧的旧值
   * @returns 是否通过校验并已提交（`handleClose` 的「保存并关闭」要据此决定关不关）
   */
  const saveAnalysisDirs = (overrideRows?: Array<{ scope: string; dir: string }>): boolean => {
    if (readOnly) return false;
    const rows = overrideRows ?? analysisByScopeRows;
    const errors: string[] = [];
    const defaultDir = analysisDefaultDirText.trim();
    if (defaultDir) {
      const issue = dirPathIssue(defaultDir);
      if (issue) errors.push(`默认目录：${issue}`);
    }
    const byScope: Record<string, string> = {};
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const sc = row.scope.trim();
      const dir = row.dir.trim();
      const at = sc || `第 ${i + 1} 行`;
      if (!sc) {
        errors.push(`${at}：请选择 scope`);
        return;
      }
      if (seen.has(sc)) {
        errors.push(`${at}：scope 重复映射（同一 scope 只能有一条）`);
        return;
      }
      seen.add(sc);
      const issue = dirPathIssue(dir);
      if (issue) {
        errors.push(`${at}：${issue}`);
        return;
      }
      byScope[sc] = dir;
    });
    if (errors.length > 0) {
      setAnalysisDirErrors(errors);
      return false;
    }
    setAnalysisDirErrors([]);
    mutateAnalysis((a) => ({
      ...a,
      targetDirs: defaultDir ? { defaultDir, byScope } : { byScope },
    }));
    return true;
  };
  // 注入给 `handleClose`（它声明在更上方，依赖数组不能直接引用这个后声明的 const）
  useEffect(() => {
    saveAnalysisDirsRef.current = saveAnalysisDirs;
  });

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
    // AI 分析独立配置域同步
    const a = next.analysis ?? data.defaults.analysis ?? EMPTY_ANALYSIS_CONFIG;
    /*
     * 目录块是**显式保存**，其余字段仍是即时保存 —— 后者每次 PUT 成功都会回传新基线。
     * 无条件铺回输入框会把用户填了一半的目录冲掉，所以只在「磁盘上的 targetDirs 真的变了」
     * （= 自己点了保存，或别的端改了配置）时才覆盖草稿。
     */
    const targetSig = JSON.stringify({
      d: a.targetDirs.defaultDir ?? '',
      b: Object.entries(a.targetDirs.byScope),
    });
    if (targetSig !== lastSavedTargetDirsRef.current) {
      lastSavedTargetDirsRef.current = targetSig;
      /*
       * 本地还有未保存的目录改动时**不覆盖**：典型序列是「点保存 → PUT 在途 → 又改了下一行」，
       * 响应回来时若直接铺服务端值，刚改的东西会静默消失（目录行不进 draftRef，
       * queuedRef 拦不住这种情况）。
       */
      if (!analysisDirtyRef.current) {
        setAnalysisDefaultDirText(a.targetDirs.defaultDir ?? '');
        setAnalysisByScopeRows(Object.entries(a.targetDirs.byScope).map(([scope, dir]) => ({ scope, dir })));
        setAnalysisDirErrors([]);
      }
    }
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
    // 锚行 = 开关所在的那一整行：工具走 `.ki-chat-cfg__tool`，skill 走 `.ki-chat-cfg__item`
    //   （卡片）。只认 `__tool` 时 skill 会退化成 36px 的开关按钮，卡片随之被压成一条竖线
    //   （2026-11-12 真机事故，见 CONFIRM_MIN_WIDTH）。
    const row =
      (anchor.closest('.ki-chat-cfg__tool, .ki-chat-cfg__item') as HTMLElement | null) ?? anchor;
    const a = row.getBoundingClientRect();
    const b = body?.getBoundingClientRect();
    // 锚行被滚出可视区（或面板已收起）⇒ 直接收起浮层，不让它悬在别的内容上
    if (a.width === 0 || (b && (a.bottom < b.top + 4 || a.top > b.bottom - 4))) {
      closeConfirm();
      return;
    }
    const width = Math.min(Math.max(a.width, CONFIRM_MIN_WIDTH), h.width - 8);
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
      /**
       * 页面模式（`hideHeader`）不把 Esc 绑成「退出本页」：
       * 设置页是文档流页面，Esc 是用户随手按的取消键，把它变成一次路由跳转很突兀
       * （「我只想取消一下，怎么被踢回事件页了」）。这层语义只属于面板覆盖层。
       */
      if (hideHeader) return;
      handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, confirm, closeConfirm, handleClose, hideHeader]);

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

  /**
   * 「去启用」：把依赖工具那一行滚到视野中间并短暂高亮。
   *
   * 刻意**不代替用户打开工具** —— 用户明确要求「必须手动先启用 ki_edit_relation」，
   * 这里只负责让他一眼看到该点哪一行（危险工具本身还要走一次二次确认）。
   */
  const revealTool = (name: string): void => {
    const el = cfgRef.current?.querySelector(`[data-tool="${name}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('ki-chat-cfg__tool--hint');
    setTimeout(() => el.classList.remove('ki-chat-cfg__tool--hint'), 1600);
  };

  /**
   * 启用/停用：即时生效（B 方案 —— 不再等底部「保存」）。
   *
   * ★ 前置依赖（2026-11-11）：skill 依赖的工具没开时**不放行启用**，改为指路浮层。
   *   停用方向永远放行（关掉不需要任何前置条件）。
   */
  const toggleSkill = (id: string, anchor?: HTMLElement): void => {
    const target = draft?.skills.find((s) => s.id === id);
    const need = SKILL_REQUIRED_TOOLS[id];
    if (target && !target.enabled && need && draft?.tools[need] !== true) {
      setConfirm({
        title: `需先启用 ${need} 工具`,
        // 文案刻意一句话：具体在哪个分组、开启后会不会再确认一次，都由「去启用」按钮
        // 直接跳到那一行呈现，不在这里铺开（用户 2026-11-12 反馈"提示内容太多"）。
        text: `请先开启这个 MCP 工具，再回来启用该 skill。`,
        yesLabel: '去启用',
        yesDanger: false,
        onYes: () => revealTool(need),
        ...(anchor ? { anchor } : {}),
      });
      return;
    }
    commit((d) => ({ ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) }));
  };

  const patchSkill = (id: string, patch: Partial<PromptSkill>): void => {
    commit((d) => ({ ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  };

  const isDefaultAnalysisSkill = (s: PromptSkill): boolean => {
    const def = data?.defaults.analysis?.skills.find((d) => d.id === s.id);
    if (!def) return false;
    return def.content === s.content && (def.description ?? '') === (s.description ?? '');
  };
  const isDefaultAnalysisPrompt = (content: string): boolean =>
    (data?.defaults.analysis?.prompt.content ?? data?.defaults.analysisPrompt?.content) === content;

  const toggleAnalysisSkill = (id: string, anchor?: HTMLElement): void => {
    const target = analysisCfg.skills.find((s) => s.id === id);
    const need = ANALYSIS_SKILL_REQUIRED_TOOLS[id];
    if (target && !target.enabled && need && analysisCfg.tools[need] !== true) {
      setConfirm({
        title: `需先启用 ${need} 工具`,
        text: '请先开启这个只读工具，再回来启用该 skill。',
        yesLabel: '去启用',
        yesDanger: false,
        onYes: () => revealTool(need),
        ...(anchor ? { anchor } : {}),
      });
      return;
    }
    mutateAnalysis((a) => ({
      ...a,
      skills: a.skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    }));
  };

  const analysisGroups = data?.analysisToolGroups ?? [];
  const analysisToolEntries = useMemo(
    () => analysisGroups.map((g) => ({ ...g, rows: g.names.map((n) => ({ name: n, on: analysisCfg.tools[n] !== false })) })),
    [analysisGroups, analysisCfg.tools],
  );
  /**
   * scope 候选的右侧徽标：**只标注与「能不能读到代码」相关的信息**。
   * 「维度不一致 / 仅全文」是知识库检索状态，与目标代码目录无关，不在这里显示（视图页才有）。
   * 只标与「能不能读到代码」有关的信息（只读库）。数据源目录不在这里出现。
   */
  /**
   * 候选只标「只读」。
   *
   * ★ 不再标「Git 仓库 / 本地目录」，也**不**把数据源的目录填进来（2026-11-16 用户纠正）：
   *   数据源是"知识要到哪去取"，分析目标目录是"代码在哪"，两者是不同的概念 ——
   *   一旦允许一键填入，用户会误以为它们绑在一起。数据源登记信息仍由后端
   *   `datasourceDirs` 下发（设置页其它地方可能用），但这里不消费。
   */
  const analysisScopeMeta = (info: { scope: string; readonly?: boolean }): ReactElement => (
    <>{info.readonly ? <span className="sp-tag sp-tag--ro">只读</span> : null}</>
  );
  const analysisScopeOptionTitle = (info: { scope: string; readonly?: boolean }): string | undefined => (
    info.readonly ? '只读库：AI 分析只能读取它的文档' : undefined
  );

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
    if (modal.kind === 'analysis') {
      return {
        id: 'analysis-prompt',
        name: '代码定位提示词',
        description: '',
        content: analysisCfg.prompt.content || data?.defaults.analysis?.prompt.content || data?.defaults.analysisPrompt?.content || '',
        builtin: true,
      };
    }
    if (modal.kind === 'new-analysis-skill') {
      return { id: newSkillId(), name: '', description: '', content: '', builtin: false };
    }
    if (modal.kind === 'analysis-skill') {
      const s = analysisCfg.skills.find((x) => x.id === modal.id);
      return s ? { id: s.id, name: s.name, description: s.description, content: s.content, builtin: s.builtin } : null;
    }
    if (modal.kind === 'find') {
      // 2026-11-16 起唯一权威是 `find.prompt`；`findPrompt` 只是镜像（老配置读取兼容）
      return {
        id: 'find-prompt',
        name: '检索定位提示词',
        description: '',
        content: draft.find?.prompt.content ?? draft.findPrompt?.content ?? data?.defaults.find?.prompt.content ?? '',
        builtin: true,
      };
    }
    if (modal.kind === 'find-skill') {
      const s = findCfg.skills.find((x) => x.id === modal.id);
      return s ? { id: s.id, name: s.name, description: s.description, content: s.content, builtin: s.builtin } : null;
    }
    const s = draft.skills.find((x) => x.id === modal.id);
    return s ? { id: s.id, name: s.name, description: s.description, content: s.content, builtin: s.builtin } : null;
  })();

  return (
    <section
      ref={cfgRef}
      className="ki-chat-cfg"
      data-open="true"
      data-capability={capability}
      data-readonly={readOnly ? 'true' : 'false'}
      role={hideHeader ? 'region' : 'dialog'}
      aria-modal={hideHeader ? undefined : true}
      aria-label={capability === 'chat' ? '对话配置' : 'AI 能力配置'}
    >
      <div className="ki-chat-cfg__savedbar" data-open={showSavedBar} />

      {!hideHeader && (
        <header className="ki-chat-cfg__head">
          <span className="ki-chat-cfg__title">对话配置</span>
          <span className="ki-chat-cfg__spacer" />
          <button type="button" className="ki-chat-iconbtn" aria-label="关闭配置" onClick={handleClose}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        </header>
      )}

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

        {capability === 'chat' && draft && data && (
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
                {draft.skills.map((s) => {
                  const need = SKILL_REQUIRED_TOOLS[s.id];
                  return (
                    <ItemCard
                      key={s.id}
                      group="skill"
                      name={s.name}
                      description={s.description}
                      content={s.content}
                      isDefault={isDefaultSkill(s)}
                      disabled={!s.enabled}
                      // 依赖工具没开时点明「为什么开不了」，并顺手指路（点它直接滚到那行工具）。
                      // 文案刻意短：卡片剩余宽度只有 ~210px，写全「工具与权限 → 写入」会被省略号吃掉，
                      // 那段路径说明放 title（hover 可见），点击本来就能直达。
                      {...(need && draft.tools[need] !== true ? { note: `需先启用 ${need} 工具` } : {})}
                      {...(need ? { onNoteClick: () => revealTool(need) } : {})}
                      onToggleEnabled={(e) => toggleSkill(s.id, e.currentTarget)}
                      onClick={() => setModal({ kind: 'skill', id: s.id })}
                    />
                  );
                })}
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
                    // data-tool：依赖它的 skill 点「去启用」时，靠它 scrollIntoView + 高亮（见 revealTool）
                    <div className="ki-chat-cfg__tool" key={r.name} data-tool={r.name}>
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
                          /**
                           * ★ 反向联动（2026-11-11）：关掉被 skill 依赖的工具时一并停用该 skill。
                           *   否则会出现"AI 看到 doc-editing 却调不到 ki_edit_relation"——比不让开更糟。
                           */
                          const dependents = draft?.skills.filter((s) => s.enabled && SKILL_REQUIRED_TOOLS[s.id] === r.name) ?? [];
                          if (!next && dependents.length > 0) {
                            setConfirm({
                              title: `关闭 ${r.name} 将同时停用 skill`,
                              text: `${dependents.map((s) => s.name).join('、')} 依赖该工具；关闭后它会一并停用（否则 AI 会看到一个调不到工具的 skill）。`,
                              onYes: () => commit((d) => ({
                                ...d,
                                tools: { ...d.tools, [r.name]: false },
                                skills: d.skills.map((s) => (SKILL_REQUIRED_TOOLS[s.id] === r.name ? { ...s, enabled: false } : s)),
                              })),
                              anchor: e.currentTarget,
                            });
                            return;
                          }
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

        {capability === 'analysis' && draft && data && (
          <>
            {/* 后端未重启的 fail-loud：判据用 `analysisPromptMaxChars`（与 analysis 域同批下发）。
                2026-11-18 前这里判的是 `analysisMaxRoundsMax`，随预算取消失去了该字段。 */}
            {data.limits.analysisPromptMaxChars === undefined && (
              <p className="ki-chat-cfg__warn">
                服务端未返回 AI 分析扩展配置：通常是后端尚未重启，目录与工具配置保存可能不会生效。
              </p>
            )}

            {/* 1. 分析目标目录（按 scope 映射 + 默认目录；块级草稿 + 显式保存） */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                分析目标目录
                <em className={`ki-chat-cfg__badge${analysisDirsBadge.cls}`}>
                  {analysisDirsBadge.text}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                配置「AI 分析」允许只读访问的本地代码目录或 Git 仓库根目录（不限必须是 Git 仓库）；
                按 scope 映射优先，未单独映射的 scope 使用默认目录。
                映射行改动<b>即时保存</b>（选 scope / 路径失焦 / 点「确认」），默认目录点「保存」生效。
              </p>

              <span className="ki-chat-cfg__sublabel">默认目录（兜底）</span>
              <div className="ki-chat-cfg__dirrow">
                <input
                  type="text"
                  className="ki-chat-cfg__dirinput"
                  aria-label="默认分析目标目录"
                  placeholder="例如 /root/workspace（绝对路径，可留空）"
                  disabled={readOnly}
                  aria-invalid={isAbsPathInvalid(analysisDefaultDirText) || undefined}
                  value={analysisDefaultDirText}
                  onChange={(e) => {
                    setAnalysisDefaultDirText(e.target.value);
                    setAnalysisDirErrors([]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveAnalysisDirs();
                  }}
                />
                <button
                  type="button"
                  className="ki-chat-btn"
                  disabled={readOnly || !analysisDirsDirty}
                  title={analysisDirsDirty ? '保存默认目录与全部 scope 映射' : '没有未保存的改动'}
                  onClick={() => saveAnalysisDirs()}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={readOnly || !analysisDefaultDirText.trim()}
                  title="清空默认目录（仍需点「保存」才生效）"
                  onClick={clearAnalysisDefaultDir}
                >
                  清除
                </button>
              </div>

              <span className="ki-chat-cfg__sublabel">按 scope 映射</span>
              {analysisByScopeRows.map((row, idx) => {
                const rowInvalid = !row.scope.trim() || isAbsPathInvalid(row.dir) || !row.dir.trim();
                const label = row.scope || `第 ${idx + 1} 行`;
                return (
                  <div className="ki-chat-cfg__dirrow ki-chat-cfg__dirrow--picker" key={`${row.scope}-${idx}`}>
                    <ScopeMultiPicker
                      single
                      scopes={scopeListData?.scopes ?? []}
                      value={row.scope ? [row.scope] : []}
                      // 选 scope 是明确动作：整行合法就**立即落盘**，不必再点一次「保存」
                      onChange={(next) => {
                        const nextRows = analysisByScopeRows.map((r, i) => (
                          i === idx ? { ...r, scope: next[0] ?? '' } : r
                        ));
                        setAnalysisDirErrors([]);
                        setAnalysisByScopeRows(nextRows);
                        const target = nextRows[idx];
                        if (target && target.scope.trim() && target.dir.trim()) {
                          saveAnalysisDirs(nextRows);
                        }
                      }}
                      maxWidth={280}
                      placeholder="搜索并选择 scope…"
                      emptyHint="未选择 scope"
                      optionMeta={analysisScopeMeta}
                      optionTitle={analysisScopeOptionTitle}
                    />
                    <input
                      type="text"
                      className="ki-chat-cfg__dirinput"
                      aria-label={`${label} 目标目录`}
                      placeholder="例如 /root/knowledge-indexer（绝对路径）"
                      disabled={readOnly}
                      aria-invalid={rowInvalid || undefined}
                      value={row.dir}
                      onChange={(e) => setAnalysisRow(idx, { dir: e.target.value })}
                      // 路径是"打字"类输入：失焦才落盘，免得把半截路径写成配置
                      onBlur={() => saveAnalysisDirs()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveAnalysisDirs();
                      }}
                    />
                    <button
                      type="button"
                      className="ki-chat-btn ki-chat-btn--ghost"
                      disabled={readOnly}
                      aria-label={`移除 ${label} 映射`}
                      onClick={() => removeAnalysisRow(idx)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}

              {/* 新增映射行：填完点「确认」= 加入并立即落盘 */}
              <div className="ki-chat-cfg__dirrow ki-chat-cfg__dirrow--picker">
                <ScopeMultiPicker
                  single
                  scopes={(scopeListData?.scopes ?? []).filter((s) => !analysisByScopeRows.some((r) => r.scope === s.scope))}
                  value={newScopePick ? [newScopePick] : []}
                  onChange={(next) => setNewScopePick(next[0] ?? '')}
                  maxWidth={280}
                  placeholder="搜索并选择 scope…"
                  emptyHint="未选择 scope"
                  optionMeta={analysisScopeMeta}
                  optionTitle={analysisScopeOptionTitle}
                />
                <input
                  type="text"
                  className="ki-chat-cfg__dirinput"
                  aria-label="新增映射目标目录"
                  placeholder="例如 /root/knowledge-indexer（绝对路径）"
                  disabled={readOnly}
                  aria-invalid={isAbsPathInvalid(newScopeDir) || undefined}
                  value={newScopeDir}
                  onChange={(e) => setNewScopeDir(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addAnalysisRow();
                  }}
                />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={readOnly || !newScopePick.trim() || !newScopeDir.trim()}
                  title="确认并加入映射（立即生效）"
                  onClick={addAnalysisRow}
                >
                  确认
                </button>
              </div>
              {analysisDirErrors.length > 0 ? (
                <ul className="ki-chat-cfg__warnlist">
                  {/* key 用序号：两行可能报同一句（如都是「目录路径不能为空」），用文案做 key 会重复 */}
                  {analysisDirErrors.map((msg, i) => <li key={`${i}-${msg}`}>{msg}</li>)}
                </ul>
              ) : null}
            </div>

            {/* 2. 基础提示词 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                基础提示词
                <em className="ki-chat-cfg__badge">恒定生效</em>
              </span>
              <p className="ki-chat-cfg__hint">
                触发「AI 分析」时注入（与事件标题、描述、阶段进度及文档路径清单组合下发；文档正文由 AI 按需调用只读工具读取）。
              </p>
              <div className="ki-chat-cfg__list">
                <ItemCard
                  group="prompt"
                  name="代码定位提示词"
                  content={analysisCfg.prompt.content}
                  isDefault={isDefaultAnalysisPrompt(analysisCfg.prompt.content)}
                  onClick={() => setModal({ kind: 'analysis' })}
                />
              </div>
            </div>

            {/* 3. Skill（AI 分析专属） */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                Skill
                <em className="ki-chat-cfg__badge">{analysisCfg.skills.filter((s) => s.enabled).length} / {data.limits.maxSkills} 可调用</em>
              </span>
              <p className="ki-chat-cfg__hint">
                仅作用于「AI 分析」，与「AI 对话」的 Skill 互相独立；启用的 skill 由 AI 按需加载正文。
              </p>
              <div className="ki-chat-cfg__list">
                {analysisCfg.skills.map((s) => {
                  const need = ANALYSIS_SKILL_REQUIRED_TOOLS[s.id];
                  return (
                    <ItemCard
                      key={s.id}
                      group="skill"
                      name={s.name}
                      description={s.description}
                      content={s.content}
                      isDefault={isDefaultAnalysisSkill(s)}
                      disabled={!s.enabled}
                      {...(need && analysisCfg.tools[need] !== true ? { note: `需先启用 ${need} 工具` } : {})}
                      {...(need ? { onNoteClick: () => revealTool(need) } : {})}
                      onToggleEnabled={(e) => toggleAnalysisSkill(s.id, e.currentTarget)}
                      onClick={() => setModal({ kind: 'analysis-skill', id: s.id })}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                className="ki-chat-cfg__add"
                disabled={readOnly || analysisCfg.skills.length >= data.limits.maxSkills}
                onClick={() => setModal({ kind: 'new-analysis-skill' })}
              >
                ＋ 新增 skill
              </button>
            </div>

            {/* 4. 思考级别 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                思考级别
                <em className="ki-chat-cfg__badge">{analysisEffortView.badge}</em>
              </span>
              <p className="ki-chat-cfg__hint">
                档位由 config.yaml 的 llm.reasoningEfforts 提供，仅作用于「AI 分析」请求。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <select
                  className="ki-chat-cfg__select"
                  aria-label="AI 分析思考级别"
                  title={analysisEffortOptions.find((o) => o.value === analysisEffortView.selectValue)?.label ?? ''}
                  disabled={readOnly || !analysisEffortView.editable}
                  value={analysisEffortView.selectValue}
                  onChange={(e) => handleAnalysisEffortChange(e.target.value)}
                >
                  {analysisEffortOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={readOnly || !analysisEffortOverridden}
                  onClick={handleAnalysisEffortReset}
                >
                  恢复默认
                </button>
              </div>
              {analysisEffortView.warn !== null && <p className="ki-chat-cfg__warn">{analysisEffortView.warn}</p>}
            </div>

            {/* 5. 工具与权限（全部只读 · 默认全开） */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">工具与权限</span>
              <p className="ki-chat-cfg__hint">
                全部为只读工具且默认全开；源码只读工具（fs_*）仅限事件「AI 分析」使用，其他场景不可见。
              </p>
              {analysisToolEntries.map((g) => (
                <div key={g.key}>
                  <p className="ki-chat-cfg__group">
                    <span className="ki-chat-cfg__group-dot" aria-hidden="true" />
                    {g.label}
                    <span className="ki-chat-cfg__group-n">{g.rows.length} 个 · 默认开</span>
                  </p>
                  {g.rows.map((r) => (
                    <div className="ki-chat-cfg__tool" key={r.name} data-tool={r.name}>
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
                        disabled={readOnly}
                        className="ki-chat-cfg__sw"
                        onClick={(e) => {
                          const next = !r.on;
                          const dependents = analysisCfg.skills.filter(
                            (s) => s.enabled && ANALYSIS_SKILL_REQUIRED_TOOLS[s.id] === r.name,
                          );
                          if (!next && dependents.length > 0) {
                            setConfirm({
                              title: `关闭 ${r.name} 将同时停用 skill`,
                              text: `${dependents.map((s) => s.name).join('、')} 依赖该工具；关闭后它会一并停用。`,
                              onYes: () => mutateAnalysis((a) => ({
                                ...a,
                                tools: { ...a.tools, [r.name]: false },
                                skills: a.skills.map((s) => (
                                  ANALYSIS_SKILL_REQUIRED_TOOLS[s.id] === r.name ? { ...s, enabled: false } : s
                                )),
                              })),
                              anchor: e.currentTarget,
                            });
                            return;
                          }
                          mutateAnalysis((a) => ({ ...a, tools: { ...a.tools, [r.name]: next } }));
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {capability === 'find' && draft && data && (
          <>
            {/* 一期（无深度通道）：四块配置暂不生效，必须如实说 —— 不能把"改了没反应"换个位置 */}
            {data.capabilities?.findDeep !== true && (
              <p className="ki-chat-cfg__warn">
                深度查找上线后生效：当前「AI 查找」走确定性快速检索，不使用提示词 / Skill / 预算；
                <b>检索范围对快速查找立即生效</b>。
              </p>
            )}

            {/* 1. 检索范围 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                检索范围
                <em className="ki-chat-cfg__badge">
                  {findCfg.ranges.extraScopes.length > 0
                    ? `当前库 + ${findCfg.ranges.extraScopes.length} 个额外库`
                    : '仅当前库'}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                当前事件所在库<b>恒定在范围内</b>，无需添加；这里只配额外要查的库（最多 {findMaxTargets} 个）。
                只能选你有权访问的库；视图需其全部成员都已授权。
              </p>
              {findCfg.ranges.extraScopes.length > 0 && (
                <div className="ki-chat-cfg__list">
                  {findCfg.ranges.extraScopes.map((name) => (
                    <div className="ki-chat-cfg__dirrow" key={name}>
                      <span className="ki-chat-cfg__tool-name" title={name}>{name}</span>
                      {findViewMap.has(name) ? <span className="ki-chat-cfg__tool-desc">视图</span> : null}
                      <span className="ki-chat-cfg__tool-sp" />
                      <button
                        type="button"
                        className="ki-chat-btn ki-chat-btn--ghost"
                        disabled={readOnly}
                        aria-label={`移除 ${name}`}
                        onClick={() => mutateFind((f) => ({
                          ...f,
                          ranges: { ...f.ranges, extraScopes: f.ranges.extraScopes.filter((x) => x !== name) },
                        }))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {readOnly ? null : (
                <div className="ki-chat-cfg__dirrow ki-chat-cfg__dirrow--picker">
                  <ScopeMultiPicker
                    scopes={findScopeOptions.filter((s) => !findCfg.ranges.extraScopes.includes(s.scope))}
                    value={[]}
                    maxWidth={320}
                    placeholder="搜索并添加额外检索库…"
                    emptyHint="当前只查事件所在库"
                    optionMeta={findScopeMeta}
                    onChange={(next) => {
                      const name = next[0];
                      if (!name) return;
                      if (findCfg.ranges.extraScopes.includes(name)) return;
                      if (findCfg.ranges.extraScopes.length >= findMaxTargets) return;
                      mutateFind((f) => ({
                        ...f,
                        ranges: { ...f.ranges, extraScopes: [...f.ranges.extraScopes, name] },
                      }));
                    }}
                  />
                </div>
              )}
              {findCfg.ranges.extraScopes.length >= findMaxTargets ? (
                <p className="ki-chat-cfg__warn">已达上限 {findMaxTargets} 个；如需更多请先移除。</p>
              ) : null}
            </div>

            {/* 2. 基础提示词 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                基础提示词
                <em className="ki-chat-cfg__badge">
                  {data.capabilities?.findDeep === true ? '恒定生效' : '深度查找生效'}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                深度查找时注入（与事件标题、描述、阶段进度及文档路径清单组合下发；正文由 AI 按需读取）。
              </p>
              <div className="ki-chat-cfg__list">
                <ItemCard
                  group="prompt"
                  name="检索定位提示词"
                  content={findCfg.prompt.content}
                  isDefault={findCfg.prompt.content === (data.defaults.find?.prompt.content ?? '')}
                  onClick={() => { if (!readOnly) setModal({ kind: 'find' }); }}
                />
              </div>
            </div>

            {/* 3. Skill（AI 查找专属） */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                Skill
                <em className="ki-chat-cfg__badge">
                  {findCfg.skills.filter((s) => s.enabled).length} / {data.limits.maxSkills} 可调用
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                仅作用于「AI 查找」，与「AI 对话」「AI 分析」的 Skill 互相独立；正文由 AI 按需加载，
                点卡片可查看与编辑（内置条目可恢复默认）。
              </p>
              <div className="ki-chat-cfg__list">
                {findCfg.skills.map((s) => {
                  const need = data.findSkillRequiredTools?.[s.id];
                  const defContent = data.defaults.find?.skills.find((d) => d.id === s.id)?.content ?? '';
                  return (
                    <ItemCard
                      key={s.id}
                      group="skill"
                      name={s.name}
                      description={s.description}
                      content={s.content}
                      isDefault={s.content === defContent}
                      disabled={!s.enabled}
                      {...(need && findCfg.tools[need] !== true ? { note: `需先启用 ${need} 工具` } : {})}
                      {...(need ? { onNoteClick: () => revealTool(need!) } : {})}
                      onClick={() => { if (!readOnly) setModal({ kind: 'find-skill', id: s.id }); }}
                      onToggleEnabled={(e) => toggleFindSkill(s.id, e.currentTarget)}
                    />
                  );
                })}
              </div>
            </div>

            {/* 4. 思考级别 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                思考级别
                <em className="ki-chat-cfg__badge">{findEffortView.badge}</em>
              </span>
              <p className="ki-chat-cfg__hint">
                档位由 config.yaml 的 llm.reasoningEfforts 提供，仅作用于「AI 查找」请求。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <select
                  className="ki-chat-cfg__select"
                  aria-label="AI 查找思考级别"
                  disabled={readOnly || !findEffortView.editable}
                  value={findEffortView.selectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    mutateFind((f) => {
                      const n = { ...f };
                      if (v) n.reasoningEffort = v;
                      else delete n.reasoningEffort;
                      return n;
                    });
                  }}
                >
                  {findEffortOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={readOnly || findCfg.reasoningEffort === undefined}
                  onClick={() => mutateFind((f) => {
                    const n = { ...f };
                    delete n.reasoningEffort;
                    return n;
                  })}
                >
                  恢复默认
                </button>
              </div>
              {findEffortView.warn !== null && <p className="ki-chat-cfg__warn">{findEffortView.warn}</p>}
            </div>

            {/* 5. 工具与权限 */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                工具与权限
                <em className="ki-chat-cfg__badge">
                  {Object.values(findCfg.tools).filter(Boolean).length} / {Object.keys(findCfg.tools).length} 已开
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                全部为只读工具；文件工具（fs_*）属「AI 分析」专属，不在此提供。
              </p>
              {(data.findToolGroups ?? []).map((g) => (
                <div key={g.key}>
                  <p className="ki-chat-cfg__group">
                    <span className="ki-chat-cfg__group-dot" aria-hidden="true" />
                    {g.label}
                    <span className="ki-chat-cfg__group-n">{g.names.length} 个 · 默认开</span>
                  </p>
                  {g.names.map((name) => (
                    <div className="ki-chat-cfg__tool" key={name} data-tool={name}>
                      <span className="ki-chat-cfg__tool-main">
                        <span className="ki-chat-cfg__tool-name" title={name}>{name}</span>
                        {g.descs?.[name] ? <span className="ki-chat-cfg__tool-desc">{g.descs[name]}</span> : null}
                      </span>
                      <span className="ki-chat-cfg__tool-sp" />
                      <button
                        type="button"
                        role="switch"
                        aria-checked={findCfg.tools[name] === true}
                        aria-label={name}
                        disabled={readOnly}
                        className="ki-chat-cfg__sw"
                        onClick={() => mutateFind((f) => ({ ...f, tools: { ...f.tools, [name]: f.tools[name] !== true } }))}
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
          mode={modal.kind === 'new-skill' || modal.kind === 'new-analysis-skill' ? 'new' : 'edit'}
          readOnly={readOnly}
          // 能力级提示词与「基础提示词」同档：不是可调用的 skill，没有描述字段
          group={
            modal.kind === 'skill' || modal.kind === 'new-skill' || modal.kind === 'analysis-skill'
              || modal.kind === 'new-analysis-skill' || modal.kind === 'find-skill'
              ? 'skill'
              : 'prompt'
          }
          item={modalItem}
          maxChars={
            modal.kind === 'analysis'
              ? data!.limits.analysisPromptMaxChars ?? 4000
              : modal.kind === 'find'
                ? data!.limits.findPromptMaxChars ?? 4000
                : modal.kind === 'prompt'
                  ? data!.limits.promptMaxChars
                  : data!.limits.skillMaxChars
          }
          nameMaxChars={data!.limits.skillNameMaxChars}
          descMaxChars={data!.limits.skillDescMaxChars}
          descSuggestedChars={data!.limits.skillDescSuggestedChars}
          // 内置条目不改名；能力级提示词同理（名称由界面固定，避免两处文案漂移）
          canRename={(modal.kind === 'skill' || modal.kind === 'analysis-skill' || modal.kind === 'new-analysis-skill' || modal.kind === 'find-skill') && !modalItem.builtin}
          canReset={modal.kind !== 'new-skill' && modal.kind !== 'new-analysis-skill' && modalItem.builtin}
          canDelete={(modal.kind === 'skill' || modal.kind === 'analysis-skill') && !modalItem.builtin}
          checkName={(name) => {
            const list = modal.kind === 'analysis-skill' || modal.kind === 'new-analysis-skill'
              ? analysisCfg.skills
              : modal.kind === 'find-skill'
                ? findCfg.skills
                : draft?.skills ?? [];
            // ★ 名称必须英文（2026-11-11 用户拍板）：与后端 `SKILL_NAME_RE` **手工同源**
            //   （服务端仍是最终闸门；这里只为省一次 400 往返，改动需两侧同步）
            return !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
              ? '名称须为英文：以字母开头，只能含字母、数字、下划线、连字符（不能有空格），例：knowledge-retrieval'
              : list.some((s) => s.id !== modalItem.id && s.name.toLowerCase() === name.toLowerCase())
                ? '已有同名 skill，请换一个名字'
                : null;
          }}
          onCancel={() => setModal(null)}
          onSubmit={({ name, content, description }) => {
            if (!modal.kind.includes('analysis')) {
              commit((d) => {
                if (modal.kind === 'prompt') return { ...d, prompt: { ...d.prompt, content } };
                if (modal.kind === 'find') {
                  return { ...d, findPrompt: { content, at: new Date().toISOString() } };
                }
                if (modal.kind === 'find-skill') {
                  // 查找 skill 独立于对话 / 分析：只改 `find.skills`，不碰其它域的 skill 列表
                  const next = {
                    ...(d.find ?? data?.defaults.find ?? EMPTY_FIND_CONFIG),
                  };
                  return {
                    ...d,
                    find: {
                      ...next,
                      skills: next.skills.map((sk) => (
                        sk.id === modalItem.id ? { ...sk, name, content, description } : sk
                      )),
                    },
                  };
                }
                if (modal.kind === 'new-skill') {
                  return {
                    ...d,
                    skills: [...d.skills, { id: modalItem.id, name, description, content, builtin: false, enabled: true, at: new Date().toISOString() }],
                  };
                }
                return { ...d, skills: d.skills.map((s) => (s.id === modalItem.id ? { ...s, name, content, description } : s)) };
              });
              setModal(null);
              return;
            }
            if (modal.kind === 'analysis') {
              mutateAnalysis((a) => ({ ...a, prompt: { content, at: new Date().toISOString() } }));
            } else if (modal.kind === 'new-analysis-skill') {
              mutateAnalysis((a) => ({
                ...a,
                skills: [...a.skills, { id: modalItem.id, name, description, content, builtin: false, enabled: true, at: new Date().toISOString() }],
              }));
            } else if (modal.kind === 'analysis-skill') {
              mutateAnalysis((a) => ({
                ...a,
                skills: a.skills.map((s) => (s.id === modal.id ? { ...s, name, content, description } : s)),
              }));
            }
            setModal(null);
          }}
          onReset={() => {
            if (modal.kind === 'prompt') {
              commit((d) => ({ ...d, prompt: { ...d.prompt, content: data!.defaults.prompt.content } }));
              setModal(null);
              return;
            }
            if (modal.kind === 'analysis') {
              const def = data!.defaults.analysis?.prompt ?? data!.defaults.analysisPrompt;
              mutateAnalysis((a) => ({ ...a, prompt: { content: def?.content ?? '', at: new Date().toISOString() } }));
              setModal(null);
              return;
            }
            if (modal.kind === 'analysis-skill') {
              const def = data!.defaults.analysis?.skills.find((s) => s.id === modal.id);
              mutateAnalysis((a) => ({
                ...a,
                skills: a.skills.map((s) => (
                  s.id === modal.id ? { ...s, content: def?.content ?? '', description: def?.description ?? '' } : s
                )),
              }));
              setModal(null);
              return;
            }
            if (modal.kind === 'find') {
              const def = data!.defaults.findPrompt;
              commit((d) => ({ ...d, findPrompt: { content: def?.content ?? '', at: new Date().toISOString() } }));
              setModal(null);
              return;
            }
            if (modal.kind === 'find-skill') {
              // 与对话 / 分析的 skill 同口径：正文与描述一起恢复（描述决定 AI 选不选它）
              const def = data!.defaults.find?.skills.find((s) => s.id === modal.id);
              mutateFind((f) => ({
                ...f,
                skills: f.skills.map((s) => (
                  s.id === modal.id ? { ...s, content: def?.content ?? '', description: def?.description ?? '' } : s
                )),
              }));
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
            if (modal.kind !== 'skill' && modal.kind !== 'analysis-skill') return;
            const id = modal.id;
            const isAnalysis = modal.kind === 'analysis-skill';
            setConfirm({
              title: '删除 skill',
              text: '该 skill 将被移除，确认后立即生效、不可撤销。',
              onYes: () => (!isAnalysis
                ? commit((d) => ({ ...d, skills: d.skills.filter((s) => s.id !== id) }))
                : mutateAnalysis((a) => ({ ...a, skills: a.skills.filter((s) => s.id !== id) }))),
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
              // 破坏性动作（删除 / 开启危险工具）用危险色；「去启用」这类指路动作是普通按钮
              className={`ki-chat-btn${confirm.yesDanger === false ? '' : ' ki-chat-btn--danger'}`}
              onClick={() => { confirm.onYes(); closeConfirm(); }}
            >
              {confirm.yesLabel ?? '确认'}
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
  /** 依赖提示（如「需先启用 ki_edit_relation 工具」）：有则渲染在描述下一行 */
  note?: string;
  /** 提供即渲染启用开关（skill 专用：基础提示词是恒定规则，不可停用）；带 event 供浮层锚点定位 */
  onToggleEnabled?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  /** note 的点击动作（依赖未满足时直接跳到目标工具行 —— 只写一句话不给路，等于没写） */
  onNoteClick?: () => void;
  /**
   * 点卡片进入编辑。
   *
   * 可选：2026-11-16 起「AI 查找」的 skill 卡片只做启停（正文编辑随深度通道上线），
   * 不传即**不可点** —— 不给一个点了没反应的入口。
   */
  onClick?: () => void;
}) {
  const { group, name, description, content, isDefault, disabled, note, onToggleEnabled, onNoteClick, onClick } = props;
  const mod = !isDefault;
  const desc = (description ?? '').trim();
  return (
    // ★ 开关在**卡片内部**（用户裁决：不要单独漏在外面）—— 卡片本身是 div，
    //   内部两枚按钮并列（点击区 + 开关）；按钮不能嵌按钮，故不再让卡片整体是一个 button。
    //
    // ★★ 2026-11-12 修正：依赖提示 `note` **必须留在 `__item-main` 里**，不能再拆成卡片第二行的
    //   独立按钮。原因是它一拆就得靠新样式类 `.ki-chat-cfg__item-row` 撑布局，而线上出现
    //   "新 DOM + 旧样式表"的混搭 ⇒ 该 div 被当成普通弹性项压到最小内容宽度，
    //   中文逐字竖排（真机截图：一条 1 字宽的竖线）。现在改成 span[role=button]：
    //   既不嵌套 button（HTML 合法），又不依赖任何新结构类，旧样式表下也照常横排。
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
          {/* 前置依赖没满足时点明原因并**给出去处**：点一下直接滚到那行工具并高亮。
              用 span 而不是 button：它嵌在卡片点击区里，嵌套 button 是非法 HTML。
              ★ 箭头用字符 `→` 而不是 <svg>：SVG 没有 CSS 规则时默认 300×150，
              会把这个 span 挤成一条 1 字宽的竖线（2026-11-12 真机事故的直接原因之一）。 */}
          {note ? (
            <span
              className="ki-chat-cfg__item-note"
              role="button"
              tabIndex={0}
              // 卡片里放不下的完整说明（在哪个分组）放 title，不占布局
              title={`${note}（工具与权限 → 写入），点击前往`}
              onClick={(e) => { e.stopPropagation(); onNoteClick?.(); }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                onNoteClick?.();
              }}
            >
              <span className="ki-chat-cfg__item-note-txt">{note}</span>
              <span className="ki-chat-cfg__item-note-arw" aria-hidden="true">→</span>
            </span>
          ) : null}
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

/**
 * 能力级提示词区块（AI 分析 / AI 查找，2026-11-15）。
 *
 * 两块刻意共用同一个组件：它们的**共同点**才是本需求的重点 ——
 * 「当前都没有生效点，但允许提前设计」。因此「未接入」徽标与说明是组件内置的，
 * 不允许调用方传个开关把它关掉（检查点 F1/F2：不得让配置看起来已生效）。
 */
export function CapabilityPromptPanel(props: {
  title: string;
  /** 条目名（弹窗标题与卡片名共用） */
  name: string;
  /** 顶部说明（说清"为什么改了不生效"） */
  intro: string;
  /** 字段说明（这条提示词决定什么） */
  hint: string;
  prompt: { content: string; at: string } | undefined;
  defaultContent: string;
  /** 服务端下发上限；缺失 = 旧 daemon（下面会 fail-loud 提示） */
  maxChars?: number;
  readOnly: boolean;
  onEdit: () => void;
}) {
  const { title, name, intro, hint, prompt, defaultContent, maxChars, readOnly, onEdit } = props;
  return (
    <>
      <div className="ki-chat-cfg__notice">{intro}</div>
      <div className="ki-chat-cfg__field">
        <span className="ki-chat-cfg__label">
          {title}
          <em className="ki-chat-cfg__badge ki-chat-cfg__badge--warn">未接入 · 改动暂不生效</em>
        </span>
        <p className="ki-chat-cfg__hint">{hint}</p>
        <div className="ki-chat-cfg__list">
          <ItemCard
            group="prompt"
            name={name}
            content={prompt?.content ?? ''}
            isDefault={(prompt?.content ?? '') === defaultContent}
            onClick={onEdit}
          />
        </div>
        {/* 旧 daemon 不返回上限 = 新字段会被它静默丢弃：必须前置告知，否则"保存成功但值没变" */
        }
        {maxChars === undefined && (
          <p className="ki-chat-cfg__warn">
            服务端未返回本项的字符上限：通常是后端尚未重启，本项的保存可能不会生效。
          </p>
        )}
        {readOnly && <p className="ki-chat-cfg__hint">当前账号为只读：可以查看内容，修改需要写权限。</p>}
      </div>
    </>
  );
}
