/**
 * docFind.ts —— 文档内查找（Ctrl+F）的纯逻辑。
 *
 * 与 ModuleDrawer 的分工：DOM 遍历/包裹留在组件内，本文件只承载**可单测**的判定与文案。
 *
 * 约定（REQ-20261014-002）：
 * - 查询长度上限 `DOC_FIND_QUERY_MAX = 200`：超出按字符截断并返回 `truncated`（调用方给可见提示），不报错；
 * - 命中上限 `DOC_FIND_MARK_LIMIT = 2000`：达到即停止包裹，计数文案以 `+` 后缀表达「还有更多未显示」；
 * - 环形导航：上一个 / 下一个在 `[0, count)` 内循环；`count <= 0` 一律返回 0
 *   （避免 -1 / NaN 被当作下标去 `marks[index]`，那会让「上一个」在 0 命中时静默失效）。
 */

/** 查询长度上限（字符）：R8 验收项之一 */
export const DOC_FIND_QUERY_MAX = 200;

/** 单次查找最多包裹的命中数：R8 验收项之一 */
export const DOC_FIND_MARK_LIMIT = 2000;

/** 输入防抖：避免逐键全量重算（R8），同时保持「输入即搜」的观感 */
export const DOC_FIND_DEBOUNCE_MS = 200;

/**
 * 「展开文档内查找栏」的跨组件事件名。
 *
 * AppShell 的 Ctrl+F 判定链①要在文档查看器可见时展开其查找栏，但 AppShell 不持有查看器内部状态；
 * 约定用 window 事件解耦——查看器只监听事件，页面只在判定链命中 ① 时派发。
 *
 * payload（2026-10-15 起）：可选携带 `{ query }` —— 用户在文档里**选中文本后按 Ctrl+F** 时，
 * AppShell 把 `pickFindSeed` 的产物带过来，查看器直接写入并立即查找（查找栏是受控 input，
 * 无法从外部赋值，只能走事件通道）。**不带 query 时行为不变**：查看器展开后按既有逻辑
 * 预填当前生效词（外部 `highlightQuery`）。
 */
export const DOC_FIND_OPEN_EVENT = 'ki:drawer-find-open';

/** `DOC_FIND_OPEN_EVENT` 的事件载荷 */
export interface DocFindOpenDetail {
  /** 由 `pickFindSeed` 归一化的查找种子；空串 / 缺省 = 未携带（走既有预填逻辑） */
  query?: string;
}

export interface ClampedFindQuery {
  value: string;
  /** 是否因超长被截断（调用方据此给出可见提示） */
  truncated: boolean;
}

/** 中文块滑窗子词的数量上限：避免超长中文查询构造出庞大的正则 */
export const DOC_FIND_SLIDE_TERM_LIMIT = 60;

/**
 * 文档内查找的词表 —— 与检索场景的 `selectHighlightTerms` **刻意不同**。
 *
 * 检索场景要剔除「本文高频的 2 字泛词」，否则自然语言问句（「什么需要注册中心」）会把正文铺满高亮；
 * 文档内查找对齐的却是浏览器 Ctrl+F 的心智：用户输 `ku` 就该看到**所有** `ku`。
 *
 * 实测缺陷（2026-10-14 用户反馈）：`ku` 在 k8s 文档里出现远超 6 次 ⇒ 被当泛词整词剔除 ⇒ 0 命中并显示
 * 「未找到」，而同页 `kub`（长度 3，不受频次限制）有结果 —— 表现为「输得越短越搜不到」。
 *
 * 规则：
 * - 按空白 / 标点切块，**每块整体原样保留**（字面匹配；不做泛词剔除、不剔停用词）；
 * - 块含中文且长度 > 4 时，额外补 2~4 字滑窗子词兜底（中文无空格，整串常常匹配不到）；
 * - 滑窗词数封顶 `DOC_FIND_SLIDE_TERM_LIMIT`。
 */
export function buildFindTerms(query: string): string[] {
  const chunks = query
    .trim()
    .split(/[\s_.,，。:：;；!?！？()[\]{}<>\-_/\\|"'`~@#$%^&*+=]+/)
    .filter(Boolean);
  const terms = new Set<string>();
  const sliding: string[] = [];
  for (const chunk of chunks) {
    terms.add(chunk);
    if (!/[\u4e00-\u9fff]/.test(chunk) || chunk.length <= 4) continue;
    for (let n = 4; n >= 2 && sliding.length < DOC_FIND_SLIDE_TERM_LIMIT; n -= 1) {
      for (let i = 0; i + n <= chunk.length && sliding.length < DOC_FIND_SLIDE_TERM_LIMIT; i += 1) {
        sliding.push(chunk.slice(i, i + n));
      }
    }
  }
  for (const term of sliding) terms.add(term);
  return [...terms];
}

/** 归一化查找词：trim 首尾空白；超长按字符截断并标记（不抛错） */
export function clampFindQuery(raw: string): ClampedFindQuery {
  const value = raw.trim();
  if (value.length <= DOC_FIND_QUERY_MAX) return { value, truncated: false };
  return { value: value.slice(0, DOC_FIND_QUERY_MAX), truncated: true };
}

/**
 * 环形步进：delta=1 下一个 / -1 上一个；count<=0 时返回 0。
 *
 * `current` 先夹取到 `[0, count)` 再步进——它来自上一次渲染的 state，可能落在区间外
 * （例如命中数变小后 index 还是旧值），夹取保证返回值一定是合法下标。
 */
export function stepFindIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  const base = Number.isFinite(current) ? Math.min(Math.max(Math.trunc(current), 0), count - 1) : 0;
  return (base + delta + count) % count;
}

/** 计数文案：`3/120`，命中被上限截断时补 `+`（表示还有未显示/未包裹的命中）；0 命中返回空串 */
export function formatFindCount(index: number, count: number, truncated: boolean): string {
  if (count <= 0) return '';
  const safeIndex = Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : 0, 0), count - 1);
  return `${safeIndex + 1}/${count}${truncated ? '+' : ''}`;
}

/**
 * 0 命中文案：把用户输入原样回显，过长只取前 40 字符——
 * 查找栏是一行 flex，未截断的长查询会把计数与按钮挤出可视区。
 */
export function describeFindMiss(query: string, labelMax = 40): string {
  const label = query.length > labelMax ? `${query.slice(0, labelMax)}…` : query;
  return `未找到「${label}」`;
}

/** 命中被上限截断时的提示文案 */
export function describeFindLimit(count: number): string {
  return `命中过多，仅显示前 ${count} 处`;
}

/** 「选中文本 → 查找种子」的字符上限（按**码点**计） */
export const DOC_FIND_SEED_MAX = 40;

/**
 * 从选区文本提取查找种子（Ctrl+F 带入选区，2026-10-15 需求裁决 D3：「只取首个词」）。
 *
 * 为什么不能整段塞进来：文档内查找是**字面匹配 + 多词 OR**（`buildFindTerms`），整段文本
 * 会命中一大片、计数失去定位意义；跨行选区更是几乎必然搜不到。口径：
 *   1) 取首行（多行选区只取第一行）；
 *   2) 取首个空白分隔块（`kubectl get pods` → `kubectl`）；
 *   3) 去掉**首尾**标点（`kubectl,` → `kubectl`；`config.yaml` 内部的点号保留）；
 *   4) 按码点截断到 `DOC_FIND_SEED_MAX`（emoji 等代理对安全）。
 * 空 / 纯空白 / 只剩标点 → 返回空串（调用方据此走「无选区」分支，不替换查找词）。
 */
export function pickFindSeed(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0] ?? '';
  const firstChunk = firstLine.trim().split(/\s+/, 1)[0] ?? '';
  const stripped = firstChunk
    .replace(/^[^\p{L}\p{N}_]+/u, '')
    .replace(/[^\p{L}\p{N}_]+$/u, '');
  return [...stripped].slice(0, DOC_FIND_SEED_MAX).join('');
}
