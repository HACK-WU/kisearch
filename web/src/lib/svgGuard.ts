/**
 * svgGuard.ts —— 图表产物（SVG 字符串）注入前的统一守卫
 *
 * 为什么单独成模块：PlantUML 与 ECharts 各有一份"能不能安全 innerHTML"的判断，逻辑逐字相同。
 * 安全判据出现两份实现是典型的"改一处忘一处"陷阱（漏改那份就等于没修），故收敛为 SSOT。
 *
 * 判据只扫**标签片段**（`<tag attr="v">`），不扫文本节点：知识文档正文里出现 `onclick=`、
 * `<script>` 这类字样完全正常，扫全文会把正常图判成攻击。属性值里的危险 scheme 一并拦，
 * `data:image/*` 放行（内联图标是合法输出形态）。
 */

/** 会被浏览器当作活动内容的标签：正常图表产物里没有，出现即判不可信 */
const FORBIDDEN_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);

/**
 * SVG 是否可以安全注入。
 *
 * 归属：产物来自本地引擎（PlantUML / ECharts），但输入是导入的外部 wiki，故按不可信处理。
 */
export function isSafeDiagramSvg(svg: string): boolean {
  if (!svg.trim()) return false;
  // 必须是真的 SVG 根（防把一段 HTML 片段当图注入）
  if (!/<svg[\s>]/i.test(svg)) return false;
  for (const tagMatch of svg.matchAll(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const name = tagMatch[1].toLowerCase();
    // 命名空间前缀（svg:script）按本地名判，别被前缀绕过
    const local = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (FORBIDDEN_TAGS.has(local)) return false;
    const attrs = tagMatch[2];
    // 三个分支缺一不可：双引号 / 单引号 / **裸值**（`href=javascript:alert(1)` 没有引号）
    for (const attrMatch of attrs.matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
      const attrName = attrMatch[1].toLowerCase();
      const value = attrMatch[2].replace(/^["']|["']$/g, '').replace(/[\u0000-\u0020]/g, '');
      if (attrName.startsWith('on')) return false;
      if (/^(?:javascript|vbscript|data:text\/html)/i.test(value)) return false;
    }
  }
  return true;
}
