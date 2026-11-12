/**
 * plantuml.ts —— PlantUML 图表渲染（纯前端：无 Java、无外部服务、不出网）
 *
 * 为什么不用「本地 jar」或「远端 kroki」（2026-11-12 实测后决定）：
 * - 本地 jar：需要 JRE（本机 `java: command not found`），每次渲染起进程，分发给用户等于加一个硬依赖；
 * - 远端服务：文档源码要发到第三方（或内网服务），知识库里有内网架构图与故障细节，不该外发。
 * - `@plantuml/core` 是官方 PlantUML 经 TeaVM 编译的 JS 版本，浏览器内直接出 SVG。
 *
 * 实测口径（Playwright + chromium headless，见 `.debug/md-fence-plantuml-not-rendered-20261112`）：
 * - 时序图首次 240ms、暗色重绘 24ms；产物与 PlantUML 官方渲染一致（参与者底部镜像、note 还原）；
 * - `!include http(s)://…` 被引擎拒绝，**外部请求 0 个**（引擎没有网络能力）；
 * - 标签里的 `<script>` 被转义，注入面为零。
 *
 * 三条落地约束：
 * ① **懒加载**：两个资源各 3.1MB / 1.4MB，只有文档真的出现 plantuml 围栏时才加载；
 *    直接 `import` 会把它们打进主 bundle（首屏 +4.5MB），故用 `?url` 取原始资源 URL，
 *    运行时先插 classic `<script>`（viz-global 是 UMD，需要挂到 globalThis.Viz）再动态 `import()`。
 * ② **失败不静默**：引擎对语法错误**不抛异常**，而是返回一张红字错误图；必须按图内文字识别出来，
 *    否则用户只会看到一张写着 Syntax Error 的图，不知道是源码错还是产品坏（与 mermaid 的
 *    「失败被静默吞掉」同一类坑，见错误库）。
 * ③ **输出守卫**：SVG 最终进 `innerHTML`，先用 `isSafePlantumlSvg` 剔掉脚本类标签 / 事件属性 /
 *    危险 scheme，再按标签名与属性判定（不扫文本，避免正文里出现 `onclick=` 字样被误伤）。
 */

/** 识别为 PlantUML 的围栏语言（官方示例常见三种写法） */
const PLANTUML_LANGUAGES = new Set(['plantuml', 'puml', 'uml']);

/** 围栏 info string 可能带 meta（```plantuml {data-x}），只取第一段 */
export function isPlantumlLanguage(language?: string): boolean {
  const raw = (language ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return PLANTUML_LANGUAGES.has(raw);
}

/** 渲染超时：首次要下载 4.5MB 资源 + 交引擎编译，给足 15s；超时按失败处理（保留源码块） */
export const PLANTUML_TIMEOUT_MS = 15_000;

/** 引擎渲染结果过大时由引擎自己报错（默认 8192px），这里显式传值以便与文档口径一致 */
export const PLANTUML_MAX_SVG_SIZE = 8192;

interface PlantumlRenderOptions {
  dark?: boolean;
  maxSvgSize?: number;
}

interface PlantumlModule {
  renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: PlantumlRenderOptions,
  ): void;
}

/**
 * 资源 URL 走 Vite `?url`：构建时按原始文件拷贝（不参与打包解析），
 * 这样 3.1MB 的引擎不会进入主 chunk，也不会被 terser 反复处理。
 */
import vizGlobalUrl from '@plantuml/core/viz-global.js?url';
import plantumlEngineUrl from '@plantuml/core/plantuml.js?url';

let enginePromise: Promise<PlantumlModule> | null = null;
let vizPromise: Promise<void> | null = null;

/** 插入 classic script 并等它执行完（viz-global 是 UMD，必须当普通脚本加载才能挂到 globalThis） */
function loadViz(): Promise<void> {
  vizPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-ki-plantuml-viz]');
    if (existing) {
      if (existing.dataset.kiLoaded === '1') resolve();
      else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Graphviz 布局资源加载失败')), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    // 相对资源路径按**模块**解析（与动态 import 同口径），否则深层文档地址下会按文档 URL 解析到错误目录
    script.src = new URL(vizGlobalUrl, import.meta.url).href;
    script.async = true;
    script.dataset.kiPlantumlViz = '1';
    script.addEventListener('load', () => {
      script.dataset.kiLoaded = '1';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('Graphviz 布局资源加载失败')), { once: true });
    document.head.appendChild(script);
  });
  // 失败后允许下次重试：chunk 可能因网络抖动失败（与 mermaid 的 loadMermaid 同口径）
  vizPromise.catch(() => { vizPromise = null; });
  return vizPromise;
}

/** 懒加载引擎（模块级单例）；加载失败不缓存失败结果，刷新页面/下次渲染可重试 */
export function loadPlantuml(): Promise<PlantumlModule> {
  enginePromise ??= (async () => {
    await loadViz();
    // `@vite-ignore`：URL 是构建产物路径，不需要（也不能）被静态分析
    const mod = (await import(/* @vite-ignore */ plantumlEngineUrl)) as PlantumlModule;
    return mod;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

/** 加载引擎 + 渲染（不含超时；超时由 renderPlantuml 统一兜住） */
async function renderOnce(source: string, dark: boolean): Promise<string> {
  const engine = await loadPlantuml();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      engine.renderToString(
        source.split('\n'),
        (svg) => done(() => resolve(svg)),
        (message) => done(() => reject(new Error(message))),
        { dark, maxSvgSize: PLANTUML_MAX_SVG_SIZE },
      );
    } catch (error) {
      done(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

/**
 * 渲染一张图。
 *
 * 超时必须罩住**加载 + 渲染**两段：引擎资源 4.5MB，`<script>` 卡住（弱网 / 被中间层挂起）时
 * 加载 Promise 永不 settle，若只在 renderToString 之后计时，块会永远停在「图表加载中…」。
 * 超时后迟到的回调由 settled 标志与 Promise.race 双重丢弃，不会二次 resolve。
 */
export async function renderPlantuml(
  source: string,
  options: { dark?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? PLANTUML_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`渲染超时（${timeoutMs}ms 未返回）`)), timeoutMs);
  });
  try {
    return await Promise.race([renderOnce(source, options.dark === true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── 输出守卫 ─────────────────────────────────────────

/** 会被浏览器当作活动内容的标签：PlantUML 正常产物里没有，出现即判不可信 */
const FORBIDDEN_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);

/**
 * SVG 是否可以安全注入。
 *
 * 只扫**标签片段**（`<tag attr="v">`），不扫文本节点：正文里出现 `onclick=` 这类字样是知识文档的
 * 正常内容，扫全文会把它误判成攻击。属性值里的危险 scheme 也一并拦（`javascript:` / `vbscript:` /
 * `data:text/html`）；`data:image/*` 放行（内联图标是 PlantUML 的合法输出形态）。
 */
export function isSafePlantumlSvg(svg: string): boolean {
  if (!svg.trim()) return false;
  if (!/<svg[\s>]/i.test(svg)) return false;
  for (const tagMatch of svg.matchAll(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const name = tagMatch[1].toLowerCase();
    // 命名空间前缀（svg:script）也要按本地名判，别被前缀绕过
    const local = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (FORBIDDEN_TAGS.has(local)) return false;
    const attrs = tagMatch[2];
    // 三个分支缺一不可：双引号 / 单引号 / **裸值**（`href=javascript:alert(1)` 没有引号，
    // 只认带引号的写法会把这条最容易被忽略的形态漏掉）
    for (const attrMatch of attrs.matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
      const attrName = attrMatch[1].toLowerCase();
      const value = attrMatch[2].replace(/^["']|["']$/g, '').replace(/[\u0000-\u0020]/g, '');
      if (attrName.startsWith('on')) return false;
      if (/^(?:javascript|vbscript|data:text\/html)/i.test(value)) return false;
    }
  }
  return true;
}

/** 引擎把错误画进图里时的成因（都是 onSuccess 返回，不抛异常） */
export type PlantumlSvgVerdict = 'ok' | 'syntax' | 'empty' | 'include';

/**
 * 判定引擎产物是"真图"还是"错误图"。
 *
 * 实测（2026-11-12，三种输入）：语法错 → 图内文字含 `Syntax Error?`；空图 → `Empty description`；
 * `!include http…` → `cannot include http`。三者都由引擎以正常 SVG 返回，不判就会把红字图当成结果。
 */
export function classifyPlantumlSvg(svg: string): PlantumlSvgVerdict {
  const text = svg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (/Syntax Error\?/i.test(text)) return 'syntax';
  if (/Empty description/i.test(text)) return 'empty';
  if (/cannot include/i.test(text)) return 'include';
  return 'ok';
}

/** 兜底成因（对外文案用；`insecure` = 产物被守卫拦下，理论不可达但必须给去路） */
export type PlantumlFallbackKind = 'failed' | 'unavailable' | 'insecure' | PlantumlSvgVerdict;

export interface PlantumlFallbackNotice {
  /** 工具条上的短标记 */
  label: string;
  /** 悬浮 / 读屏用的完整说明 */
  title: string;
  /** 展开面板：出了什么问题 */
  reason: string;
  /** 展开面板：怎么办 */
  hint: string;
}

/**
 * 兜底提示文案（纯函数便于单测）。
 *
 * 口径与 mermaid 的 `mermaidFallbackNotice` 完全一致：保留源码块 + 明说原因 + 给出去路，
 * 只是把主语换成 PlantUML（两种图的失败原因不一样，不能共用一套话术）。
 */
export function plantumlFallbackNotice(kind: PlantumlFallbackKind, detail?: string): PlantumlFallbackNotice {
  const build = (label: string, reason: string, hint: string): PlantumlFallbackNotice => ({
    label, reason, hint, title: `${reason}。${hint}`,
  });
  if (kind === 'syntax') {
    return build(
      '⚠ PlantUML 语法错误',
      '图源码有语法错误，PlantUML 只能画出一张错误图',
      '已保留源码块；点「代码」按报错行修正后重新打开即可正常渲染',
    );
  }
  if (kind === 'empty') {
    return build(
      '⚠ PlantUML 无内容',
      '图源码里没有可渲染的内容（引擎报 Empty description）',
      '已保留源码块；补上图表内容后重新打开即可正常渲染',
    );
  }
  if (kind === 'include') {
    return build(
      '⚠ PlantUML 外链被拒',
      '源码里的 !include 指向网络地址，浏览器内渲染不具备网络能力',
      '已保留源码块；把被 include 的内容直接内联进文档，或改用本地片段',
    );
  }
  if (kind === 'unavailable') {
    return build(
      '⚠ PlantUML 渲染不可用',
      '图引擎资源加载失败（模块未能加载）',
      '已保留源码块；刷新页面可重试',
    );
  }
  if (kind === 'insecure') {
    return build(
      '⚠ PlantUML 输出被拦截',
      '图产物里含活动内容（脚本标签 / 事件属性 / 危险链接），已按安全策略拦下',
      '已保留源码块；请检查源码里是否嵌入了 HTML 片段',
    );
  }
  return build(
    '⚠ PlantUML 渲染失败',
    `图渲染过程出错${detail ? `：${detail}` : ''}`,
    '已保留源码块；刷新页面重试，或改用其它图表语法',
  );
}

/** 错误摘要：取首个非空行并限长（引擎报错常带 Java 栈，塞进 title 没有信息量） */
export function plantumlErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '未知错误';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}
