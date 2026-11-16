/**
 * WriteTabs.tsx —— 合并页的页级 tab 条（REQ-20261116-002）。
 *
 * 形态复用全站既有的 `.ki-segmented`（与「资源」页 `.res-tabs` 同一套选中态口径），
 * 不新增视觉语言；区别只有两处：页面级尺寸（高 34 / 字号 14）与导入进度徽标。
 *
 * 三个刻意设计：
 *  1) **tab 由 URL 驱动**：点击即 `navigate()`，不在本地存 state —— 刷新、深链、浏览器
 *     前后退都能回到正确的 tab（在途导入刷新后仍能看到进度，见 REQ 负向需求 N1）。
 *  2) **不写 `aria-controls`**：两个 tab 的内容分属两个页面组件（`ImportPage` / `WritePage`），
 *     非当前 tab 的面板不存在于 DOM，硬编一个指向不存在 id 的 `aria-controls` 只会误导读屏。
 *  3) **徽标只在导入 tab 未激活时出现**（判据见 `lib/writeTabs.ts` 的 `tabBadgeVisible`）：
 *     激活时右轨已有完整进度，重复一份是噪音。
 */

import type { KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useImportProgress } from '@/lib/importProgress';
import {
  WRITE_TAB_LABEL,
  WRITE_TAB_PATH,
  WRITE_TABS,
  tabBadgePercentText,
  tabBadgeVisible,
  writeTabFromPath,
  type WriteTab,
} from '@/lib/writeTabs';

const TAB_ID_PREFIX = 'ki-write-tab-';

export function WriteTabs(): JSX.Element | null {
  const location = useLocation();
  const navigate = useNavigate();
  const progress = useImportProgress();
  const activeTab = writeTabFromPath(location.pathname);
  // 非合并路径不渲染（理论上不会出现：本组件只被两个合并页引用）
  if (!activeTab) return null;

  const showBadge = tabBadgeVisible(activeTab, progress.phase);
  const percentText = tabBadgePercentText(progress.percent);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % WRITE_TABS.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + WRITE_TABS.length) % WRITE_TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = WRITE_TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = WRITE_TABS[next];
    if (nextTab !== activeTab) navigate(WRITE_TAB_PATH[nextTab]);
    document.getElementById(`${TAB_ID_PREFIX}${nextTab}`)?.focus();
  };

  return (
    <div className="ki-segmented ki-page-tabs" role="tablist" aria-label="写入方式">
      {WRITE_TABS.map((tab: WriteTab, index) => {
        const selected = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${TAB_ID_PREFIX}${tab}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) navigate(WRITE_TAB_PATH[tab]);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {WRITE_TAB_LABEL[tab]}
            {tab === 'import' && showBadge ? (
              /**
               * `aria-hidden`：让 tab 的**可访问名保持恒为「上传导入」**。徽标会从无到有、
               * 百分比还会 9% → 100% 地变，若参与可访问名，读屏会反复重播、
               * `getByRole('tab', { name: '上传导入' })` 这类自动化也会时灵时不灵。
               * 进度本身的读屏用户切回导入 tab 即可在右轨看到完整信息。
               */
              <span
                className="ki-page-tabs__badge"
                aria-hidden="true"
                title={`导入进行中${progress.scope ? `（${progress.scope}）` : ''}${percentText ? `：${percentText}` : ''}`}
              >
                <span className="ki-page-tabs__dot" aria-hidden="true" />
                {percentText ? <span className="ki-page-tabs__pct">{percentText}</span> : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
