/**
 * echarts.ts —— ECharts 图表渲染（纯前端：无服务端、不出网）
 *
 * 输入是写在 ```echarts 围栏里的 **option JSON**（不是代码），所以没有"语法解析"这一层，
 * 渲染路径比 PlantUML 简单：JSON.parse → 清洗 → init(svg) → setOption → 取静态 SVG → dispose。
 *
 * 三个刻意的取舍（2026-11-12 实测后定）：
 * ① **静态 SVG 快照，不保留活实例**：文档场景要的是"能看、能打印、能随主题重绘"，
 *    活实例要管生命周期（切面板 / 换主题 / resize 都要 dispose 重建），且 tooltip 的
 *    `formatter` / `extraCssText` 是把字符串塞进 innerHTML 与 style —— 静态快照下这些
 *    代码路径根本不执行，注入面归零。代价：**没有 hover tooltip**（数值看 label 与「代码」面板）。
 * ② **animation 强制关闭**：否则截到的是动画中间帧（实测 400ms 时标签还叠在一起），
 *    而且同一份 option 每次渲染结果不同 —— 静态产物必须确定。
 * ③ **容器尺寸显式传入**：ECharts 在 0 宽高容器里会画出一张空白图；我们用离屏 div +
 *    `init(el, theme, {width, height})` 固定按调用方给的尺寸渲染，SVG 再按容器宽等比缩放。
 */

/** 识别为 ECharts 的围栏语言 */
const ECHARTS_LANGUAGES = new Set(['echarts']);

export function isEchartsLanguage(language?: string): boolean {
  const raw = (language ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return ECHARTS_LANGUAGES.has(raw);
}

/** 渲染超时：首次要下载 1.1MB 引擎（gzip 360KB），给足 15s；超时按失败处理（保留源码块） */
export const ECHARTS_TIMEOUT_MS = 15_000;

/** 静态快照的渲染画布尺寸（SVG 最后按容器宽等比缩放，故取常见文档宽度即可） */
export const ECHARTS_RENDER_WIDTH = 720;
export const ECHARTS_RENDER_HEIGHT = 420;

interface EchartsInstance {
  setOption(option: unknown, opts?: { notMerge?: boolean; lazyUpdate?: boolean }): void;
  dispose(): void;
}

interface EchartsNamespace {
  init(
    dom: HTMLElement,
    theme?: string | Record<string, unknown> | null,
    opts?: { renderer?: 'canvas' | 'svg'; width?: number | string; height?: number | string },
  ): EchartsInstance;
}

/**
 * 产物走 Vite `?url`（与 PlantUML 同策略）：1.1MB 引擎不进主包，
 * 且 `echarts.min.js` 是 UMD，只能当 classic script 加载。
 */
import echartsUrl from 'echarts/dist/echarts.min.js?url';
import { isSafeDiagramSvg } from './svgGuard.js';

let enginePromise: Promise<EchartsNamespace> | null = null;

/**
 * 插入 classic script 并等它执行完。
 *
 * **失败必须把 `<script>` 摘掉**：留着失败节点会让"复用已有节点"的分支挂在一个永远不会再触发
 * load/error 的元素上 —— 重试就此永久挂起（比失败更糟，用户只能刷新）。
 */
function loadScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    // 相对资源路径按**模块**解析（与动态 import 同口径），避免深层地址下解析到错误目录
    script.src = new URL(echartsUrl, import.meta.url).href;
    script.async = true;
    script.dataset.kiEcharts = '1';
    script.addEventListener('load', () => {
      script.dataset.kiLoaded = '1';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('ECharts 资源加载失败'));
    }, { once: true });
    document.head.appendChild(script);
  });
}

/** 懒加载引擎（模块级单例）；失败不缓存，刷新后可重试 */
export function loadEcharts(): Promise<EchartsNamespace> {
  enginePromise ??= (async () => {
    await loadScript();
    const ns = (globalThis as { echarts?: EchartsNamespace }).echarts;
    if (!ns) throw new Error('ECharts 未挂载到 window（资源加载异常）');
    return ns;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

// ─── option 清洗 ─────────────────────────────────────

/** 会被 ECharts 当 HTML / CSS 写进 DOM 的字段（静态快照下不生效，仍按不可信输入剥掉） */
const HTML_ISH_FORMATTER = /<|javascript:|&#/i;

/**
 * 清洗 option：只做**减法**，不改变图表语义；返回**深拷贝**，不改调用方对象。
 *
 * 三件事，缺一都会出真问题（2026-11-12 实测）：
 * ① **逐层关动画** —— 只写顶层 `animation:false` 不够：`series[].animation:true` 会覆盖它，
 *    实测同一份 option 两次快照字节不同（首读 1038 / 700ms 后 1260），即截到动画中间帧；
 * ② **剥 `extraCssText`（任意层级）** —— 它是直接写进 style 的字符串，属于 HTML/CSS 通道；
 * ③ **剥含标签的 formatter** —— tooltip 的 formatter 结果进 innerHTML（静态快照虽不渲染
 *    tooltip，但这层要在将来切活实例时仍然成立）。
 *
 * 遍历有节点预算（防超大 data 数组拖慢首屏）；超预算的部分原样保留 —— 宁可少清洗也不要卡住。
 */
const SANITIZE_NODE_BUDGET = 50_000;

function cleanOptionNode(node: unknown, budget: { left: number }): unknown {
  if (budget.left <= 0) return node;
  budget.left -= 1;
  if (Array.isArray(node)) return node.map((item) => cleanOptionNode(item, budget));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/^animation/i.test(key)) {
      // 时长/延迟给 0，其余开关给 false
      out[key] = /duration|delay/i.test(key) ? 0 : false;
      continue;
    }
    if (key === 'extraCssText') continue;
    if ((key === 'formatter' || key === 'valueFormatter')
      && typeof value === 'string' && HTML_ISH_FORMATTER.test(value)) continue;
    out[key] = cleanOptionNode(value, budget);
  }
  return out;
}

export function sanitizeEchartsOption(option: Record<string, unknown>): Record<string, unknown> {
  const cleaned = cleanOptionNode(option, { left: SANITIZE_NODE_BUDGET });
  const out = (cleaned && typeof cleaned === 'object' ? cleaned : {}) as Record<string, unknown>;
  // 顶层必须**显式**声明关闭：源码里通常压根没写 animation，默认是开的（只改已有键不够）。
  // series 级显式写 true 的情况由上面的逐层遍历压掉。
  out.animation = false;
  out.animationDuration = 0;
  return out;
}

// ─── 渲染 ───────────────────────────────────────────

/** option 不是合法 JSON / 不是对象时的诊断文案（fail-loud，不静默画空白） */
export function echartsOptionError(text: string): string | null {
  const raw = text.trim();
  if (!raw) return '图表内容为空（```echarts 块里没有 JSON）';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `option 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'option 必须是 JSON 对象（`{ ... }`），不能是数组或标量';
  }
  return null;
}

/** 去掉装饰容器后判断有没有图元（纯字符串，便于单测） */
export function isBlankEchartsSvg(svg: string): boolean {
  const withoutDecor = svg
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<defs\b[\s\S]*?<\/defs>/gi, '');
  return !/<(?:path|rect|circle|ellipse|line|polyline|polygon|image)\b/i.test(withoutDecor);
}

/**
 * 渲染结果是否可以安全注入（判据见 `lib/svgGuard.ts`，与 PlantUML 共用同一份实现）。
 * 保留本名导出是为了让调用方按"我要注入 ECharts 产物"来读。
 */
export function isSafeEchartsSvg(svg: string): boolean {
  return isSafeDiagramSvg(svg);
}

export type EchartsFallbackKind = 'json' | 'failed' | 'unavailable' | 'blank' | 'insecure';

export interface EchartsFallbackNotice {
  label: string;
  title: string;
  reason: string;
  hint: string;
}

/**
 * 兜底文案（纯函数便于单测；口径与 mermaid / PlantUML 一致：保留源码块 + 说明原因 + 给去路）。
 * 比另外两种图多一档 `json` —— 这里的失败常是"JSON 写错了"（多逗号、注释、中文引号），
 * 分开讲才不会让用户去怀疑渲染器。
 */
export function echartsFallbackNotice(kind: EchartsFallbackKind, detail?: string): EchartsFallbackNotice {
  const build = (label: string, reason: string, hint: string): EchartsFallbackNotice => ({
    label, reason, hint, title: `${reason}。${hint}`,
  });
  if (kind === 'json') {
    return build(
      '⚠ 配置不是合法 JSON',
      `${detail ?? 'option 解析失败'}`,
      '已保留源码块；修正 JSON（多余逗号 / 注释 / 中文引号是常见原因）后重新打开即可',
    );
  }
  if (kind === 'blank') {
    return build(
      '⚠ 图表没有可绘制内容',
      'option 是合法 JSON，但没有产生任何图形（series 为空、图表类型不受支持或数据全为空）',
      '已保留源码块；检查 series[].type 与 data 后重新打开',
    );
  }
  if (kind === 'unavailable') {
    return build(
      '⚠ 图表渲染不可用',
      'ECharts 资源加载失败（引擎未能加载）',
      '已保留源码块；刷新页面可重试',
    );
  }
  if (kind === 'insecure') {
    return build(
      '⚠ 图表输出被拦截',
      '渲染产物含活动内容（脚本标签 / 事件属性 / 危险链接），已按安全策略拦下',
      '已保留源码块；请检查 option 里是否嵌入了 HTML 片段',
    );
  }
  return build(
    '⚠ 图表渲染失败',
    `渲染过程出错${detail ? `：${detail}` : ''}`,
    '已保留源码块；刷新页面重试，或检查 option 结构',
  );
}

export function echartsErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '未知错误';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

/**
 * 把 ECharts 产出的根 `<svg>` 改造成"可嵌入文档"的形态。
 *
 * 两个必须做的改造（2026-11-12 真机踩到）：
 * ① **剥掉 `style="position:absolute;left:0;top:0"`** —— 这是 zrender 给根 svg 加的定位，
 *    原样注入会脱离文档流：图会盖住工具条（实测点不到「代码」标签），且容器高度塌成 0；
 * ② **补 `viewBox` 并去掉固定 `width`/`height`** —— ECharts 只输出 720×420 的绝对尺寸，
 *    没有 viewBox，`max-width:100%` 只会裁切而不会等比缩放。
 */
export function normalizeEchartsSvg(svg: string, width: number, height: number): string {
  return svg.replace(/^<svg\b[^>]*>/i, (tag) => {
    const existingViewBox = /\sviewBox="([^"]*)"/i.exec(tag)?.[1];
    const stripped = tag
      .replace(/\sstyle="[^"]*"/i, '')
      .replace(/\swidth="[^"]*"/i, '')
      .replace(/\sheight="[^"]*"/i, '')
      .replace(/\sviewBox="[^"]*"/i, '');
    return stripped.replace(/^<svg\b/i, `<svg viewBox="${existingViewBox ?? `0 0 ${width} ${height}`}"`);
  });
}

/** init → setOption → 取 svg → dispose（离屏容器，固定尺寸） */
async function renderOnce(optionText: string, dark: boolean): Promise<string> {
  const echarts = await loadEcharts();
  const option = sanitizeEchartsOption(JSON.parse(optionText) as Record<string, unknown>);
  const host = document.createElement('div');
  host.style.cssText = `width:${ECHARTS_RENDER_WIDTH}px;height:${ECHARTS_RENDER_HEIGHT}px;position:absolute;left:-99999px;top:0`;
  document.body.appendChild(host);
  let chart: EchartsInstance | null = null;
  try {
    chart = echarts.init(host, dark ? 'dark' : null, {
      renderer: 'svg',
      width: ECHARTS_RENDER_WIDTH,
      height: ECHARTS_RENDER_HEIGHT,
    });
    chart.setOption(option, { notMerge: true, lazyUpdate: false });
    let svg = host.querySelector('svg');
    if (!svg) {
      // SVG 渲染器通常在 setOption 内同步建 DOM；万一走的是下一帧，等一帧再取
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      svg = host.querySelector('svg');
    }
    if (!svg) throw new Error('未产出 SVG（渲染器未初始化）');
    // 必须规范化：zrender 的绝对定位 style 会让图脱流并盖住工具条（真机踩过）
    return normalizeEchartsSvg(svg.outerHTML, ECHARTS_RENDER_WIDTH, ECHARTS_RENDER_HEIGHT);
  } finally {
    chart?.dispose();
    host.remove();
  }
}

/** 渲染一张 ECharts 图，返回静态 SVG 字符串（超时覆盖加载 + 渲染） */
export async function renderEchartsSvg(
  optionText: string,
  options: { dark?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? ECHARTS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`渲染超时（${timeoutMs}ms 未返回）`)), timeoutMs);
  });
  try {
    return await Promise.race([renderOnce(optionText, options.dark === true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
