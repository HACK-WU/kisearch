/**
 * ScopeMultiPicker.tsx —— 知识库多选下拉（搜索过滤 + 候选面板 + 已选 chips）
 *
 * 单一来源：知识视图页「包含哪些知识库」（新建 / 编辑视图）与个人中心
 * 「创建 MCP Token → 访问范围 · 指定」共用这一份交互实现。
 * 原先该交互内嵌在 ViewsPage，Token 表单另有一套扁平 chips —— 两套并存会漂移
 * （键盘处理、点外收起、空态文案都得改两遍），故抽成组件。
 *
 * 组件**不发请求**：数据源由调用方决定。视图页的「维度不一致」来自 /api/views 的
 * memberMeta，Token 表单只能拿到 ki_scope_list 的字段，口径不可混。
 * 差异点通过 chipLabel / chipClassName / chipTitle / optionMeta / optionTitle 注入。
 *
 * 三条踩过的坑（原实现注释原样保留，改之前先读）：
 *   1. 点外部收起**不能在 pointerdown 当场执行**：面板走常规流，收起会让下方按钮上移，
 *      本次点击的 mouseup 落到按钮外，click 不触发（表现为"点保存没反应"）。
 *   2. 不能用 click + contains 判断：候选项是重新渲染的，target 可能已脱离文档。
 *      所以 pointerdown 只记录 inside，click 阶段才决定收起。
 *   3. ArrowUp / ArrowDown / Enter 必须 preventDefault：否则光标会在输入框里跳到首尾、
 *      或触发表单默认提交。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '@/components/icons';
import type { ScopeInfo } from '@/api/mcpClient';

export interface ScopeMultiPickerProps {
  /** 全部可选库（调用方给数据源，组件不请求） */
  scopes: ScopeInfo[];
  /** 已选 scope 名（受控） */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** 已选为空时的占位文案 */
  emptyHint?: string;
  /** 已选 chip 文案（默认就是 scope 名） */
  chipLabel?: (scope: string) => string;
  /** 已选 chip 追加的修饰类（不含基础类，需自带前导空格） */
  chipClassName?: (scope: string) => string;
  chipTitle?: (scope: string) => string | undefined;
  /** 候选项右侧徽标 */
  optionMeta?: (info: ScopeInfo) => ReactNode;
  optionTitle?: (info: ScopeInfo) => string | undefined;
  /** 容器最大宽度，默认 340（视图页表单的原始宽度） */
  maxWidth?: number | string;
  /** 面板页脚的快捷键提示，默认开启 */
  showShortcutHint?: boolean;
}

export function ScopeMultiPicker({
  scopes,
  value,
  onChange,
  placeholder = '搜索并添加知识库…',
  emptyHint = '还没有选择知识库',
  chipLabel,
  chipClassName,
  chipTitle,
  optionMeta,
  optionTitle,
  maxWidth = 340,
  showShortcutHint = true,
}: ScopeMultiPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  /*
   * 候选面板**浮层展开**（2026-11-10 用户两次拍板：Token 弹窗、新建/编辑视图都要，
   * 不要向下挤压其他组件）。这里按输入框的视口位置现算坐标。
   *
   * 为什么必须 fixed 而不是 absolute：
   *   · Token 弹窗那条链路上有四层 overflow（.u2-inline-panel: hidden /
   *     .u2-dialog__body: auto / .u2-dialog: hidden / .ki-dialog: auto），
   *     注入 absolute 实测面板从 200px 被裁到 83px；
   *   · 视图页同样被 .views-card: hidden 裁掉 101px。
   * fixed 脱离这些裁剪容器；.ki-overlay 只是 position:fixed 且无 transform，
   * 所以参照系仍是视口。
   */
  const reposition = useCallback((): void => {
    const trigger = inputRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const GAP = 6;
    const MARGIN = 8;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
    const next = {
      top: rect.bottom + GAP,
      left: rect.left,
      width: rect.width,
      /* 下限 80 保证矮屏至少露出 2 项；上限 200 与设计的 max-height 一致 */
      maxHeight: Math.min(200, Math.max(80, spaceBelow)),
    };
    // 滚动事件很密集，位置没变就不 setState（面板跟随输入框，多数滚动帧位置不变）
    setBox((prev) => (prev
      && Math.abs(prev.top - next.top) < 0.5
      && Math.abs(prev.left - next.left) < 0.5
      && Math.abs(prev.width - next.width) < 0.5
      && Math.abs(prev.maxHeight - next.maxHeight) < 0.5
      ? prev
      : next));
  }, []);

  // 滚动（含弹窗 body 内部滚动，故用 capture）与缩放都要重算，否则浮层与输入框脱位
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  // 打开瞬间与「已选项增减导致输入框换行移位」时重算；放 layout effect 里，避免首帧闪一下在流内
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, value.length, reposition]);

  useEffect(() => {
    let inside = true;
    const onDown = (e: PointerEvent): void => {
      inside = Boolean(rootRef.current?.contains(e.target as Node));
    };
    const onClick = (): void => {
      if (!inside) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  /*
   * ARIA 关联：候选项已移出 Tab 序（tabIndex=-1），键盘靠 ↑↓ 移动 activeIndex。
   * 若不把「当前高亮项」通过 aria-activedescendant 指出去，屏幕阅读器就完全
   * 感知不到选中了哪个 —— 那是拿掉 Tab 可达性换来的净损失。
   * useId 保证同页多个 picker（视图页 + Token 弹窗）的 id 不撞。
   */
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-opt-${index}`;

  /** 候选 = 未选中的库，按输入过滤后按名字排序 */
  const candidates = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const chosen = new Set(value);
    return scopes
      .filter((s) => !chosen.has(s.scope))
      .filter((s) => !kw || s.scope.toLowerCase().includes(kw))
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }, [scopes, value, filter]);

  /* 当前高亮项：过滤后候选变少时 activeIndex 可能越界，取末项兜底 */
  const activeOptionId = open && candidates.length > 0
    ? optionId(Math.min(activeIndex, candidates.length - 1))
    : undefined;

  const add = (name: string): void => {
    if (value.includes(name)) return;
    onChange([...value, name]);
    setFilter('');
    setActiveIndex(0);
    setOpen(true);
    inputRef.current?.focus();
  };

  const remove = (name: string): void => {
    onChange(value.filter((m) => m !== name));
    setActiveIndex(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // 否则光标会在输入框里跳到首/尾
      if (!open) {
        setOpen(true);
        return;
      }
      if (candidates.length === 0) return;
      setActiveIndex((i) => (e.key === 'ArrowDown'
        ? (i + 1) % candidates.length
        : (i - 1 + candidates.length) % candidates.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = candidates[activeIndex] ?? candidates[0];
      if (target) add(target.scope);
      return;
    }
    if (e.key === 'Escape' && open) {
      /*
       * 只收起候选，不能让它继续冒泡：Token 创建表单外面是 .u2-dialog，
       * 其外壳在 window 上监听 Esc 关闭弹窗 —— 不拦住会「收候选 + 关弹窗」
       * 一起发生，用户填好的名称和权限当场丢失。
       * （React 合成事件的 stopPropagation 会调用原生 stopPropagation，
       *   React 根容器早于 window，足以拦住。）
       */
      e.stopPropagation();
      setOpen(false);
    }
  };

  const emptyText = scopes.length === 0
    ? '暂无可选知识库'
    : (value.length === scopes.length
      ? `已添加全部 ${scopes.length} 个知识库`
      : `没有匹配「${filter}」的知识库`);

  return (
    <div className="sp-picker" ref={rootRef} style={{ maxWidth }}>
      <div className="sp-picker__selected">
        {value.length === 0 ? <span className="sp-picker__empty">{emptyHint}</span> : null}
        {value.map((m) => (
          <button
            key={m}
            type="button"
            className={`sp-chip sp-chip--pick${chipClassName?.(m) ?? ''}`}
            title={chipTitle?.(m)}
            onClick={() => remove(m)}
          >
            {chipLabel ? chipLabel(m) : m}
            <span className="sp-chip__x" aria-hidden="true">×</span>
          </button>
        ))}
      </div>

      <div className="sp-picker__field">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="sp-picker__input"
          value={filter}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          onFocus={() => setOpen(true)}
          onClick={() => {
            if (!open) setOpen(true);
          }}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          className="sp-picker__toggle"
          type="button"
          aria-label={open ? '收起候选' : '展开候选'}
          tabIndex={-1}
          onClick={() => {
            // 收起时不要再 focus 输入框：focus 的语义是"展开"，会立刻弹回来
            if (open) {
              setOpen(false);
              return;
            }
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          ▾
        </button>
      </div>

      {open && box ? (
        <div
          className="sp-picker__panel"
          /* 浮层坐标走内联样式：随输入框位置变化，写不进静态 CSS */
          style={{ top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }}
        >
          {/* 候选区与提示行分两层：提示行固定在面板底部、不参与滚动 */}
          <div className="sp-picker__scroll" role="listbox" id={listboxId} aria-label="可选知识库">
            {candidates.length === 0 ? (
              <div className="sp-picker__note" role="presentation">{emptyText}</div>
            ) : (
              candidates.map((s, i) => (
                <button
                  key={s.scope}
                  type="button"
                  /*
                   * 候选项**不进 Tab 序**（标准 combobox 行为）：键盘用 ↑↓ + 回车选择，
                   * 页脚也是这么写的。库多时（实测 153 个）若排进 Tab 序，用户在
                   * Token 弹窗里要按 154 次 Tab 才能到「取消」，而弹窗有焦点陷阱、
                   * 绕不出去 —— 等于键盘用户被候选列表困住。
                   *
                   * role=option 覆盖 button 语义：输入框的 aria-activedescendant 指向这里，
                   * 屏幕阅读器才知道 ↑↓ 当前停在哪一项（不然拿掉 Tab 可达性就是净损失）。
                   */
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  tabIndex={-1}
                  className={`sp-picker__opt${i === activeIndex ? ' sp-picker__opt--active' : ''}`}
                  title={optionTitle?.(s)}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => add(s.scope)}
                >
                  <span className="sp-picker__opt-name">{s.scope}</span>
                  <span className="sp-picker__opt-meta">{optionMeta?.(s)}</span>
                </button>
              ))
            )}
          </div>
          {showShortcutHint && candidates.length > 0 ? (
            <div className="sp-picker__hint">↑↓ 选择 · 回车添加 · Esc 收起 · 点已选项可移除</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
