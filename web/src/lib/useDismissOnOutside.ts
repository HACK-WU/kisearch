/**
 * useDismissOnOutside.ts —— 浮层「点外部 / 窗口失焦」收起（顶栏所有下拉共用）
 *
 * 三个坑，都是实测踩出来的，改实现前先读：
 *
 * 1. **必须 mousedown，不能用 click**
 *    收起态的展示层被点后会立刻换成 `<input>`，原节点脱离 DOM；同一个 click 冒泡到
 *    document 时 `contains(已脱离节点)` 为 false ⇒ 误判成「点了外部」⇒ 刚打开就被关掉
 *    （ScopeSelect 早期「根本选不了」就是这么来的，2026-10）。
 *
 * 2. **必须捕获阶段**
 *    祖先组件用 `stopPropagation` 拦冒泡时（gov-modal 家族、编辑器外壳），冒泡监听在
 *    `#root` 之后不会再被调用 —— 事件上传弹窗里的 GroupPathSelect 曾整片失效（2026-11-23）。
 *    document 是传播链顶端，捕获阶段拦不住。
 *
 * 3. **还要听 window 的 blur**
 *    内容在 iframe 里时（`/atlas` 知识地图），点击由**子文档**派发，父 document 连捕获
 *    阶段都收不到（实测 mousedown 捕获=0、冒泡=0）；焦点进入 iframe 会让父窗口失焦
 *    （实测 blur=1），这是唯一可观测的信号。缺了这条，图集页点哪都关不掉下拉。
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * @param ref    浮层根节点（触发按钮 + 面板的共同祖先，否则点触发按钮会被当成「外部」）
 * @param open   只在展开时挂监听，收起态不占用 document / window
 * @param onDismiss 判定为外部点击或窗口失焦时调用（只需收起，不必重置其它状态）
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  /**
   * 回调存进 ref：调用方普遍传内联箭头函数，直接进依赖数组会让每次渲染都重挂监听
   * （ScopeSelect 的过滤器每敲一个字都重渲染一次）。
   */
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      /*
       * `isConnected` 兜底：目标已脱离文档时 `contains` 必然 false，但那说明是组件自己
       * 重建了 DOM，不是用户点了外部 —— 不加这条会误关。
       */
      if (!target || !target.isConnected) return;
      if (ref.current && !ref.current.contains(target)) dismissRef.current();
    };

    /** iframe 内部的点击只能从这里观察到（见文件头第 3 条） */
    const onWindowBlur = (): void => dismissRef.current();

    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [ref, open]);
}
