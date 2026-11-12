import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
const {
  echartsErrorDetail,
  echartsFallbackNotice,
  echartsOptionError,
  isBlankEchartsSvg,
  isEchartsLanguage,
  isSafeEchartsSvg,
  normalizeEchartsSvg,
  sanitizeEchartsOption,
} = await vite.ssrLoadModule('/src/lib/echarts.ts');
after(async () => vite.close());

/** 第 n 个 `<pre><code>` 的文本（去标签 + 解实体） */
const codeText = (html, index = 0) => {
  const inner = [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)][index]?.[1] ?? '';
  return inner
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
};

const SRC = JSON.stringify({
  title: { text: '耗时构成（ms）', left: 'center' },
  series: [{ type: 'pie', data: [{ name: 'A', value: 1 }, { name: 'B', value: 2 }] }],
}, null, 2);

describe('ECharts 围栏 → 图表/代码双面板', () => {
  it('渲染成带两个 tab 与两个面板的块，JSON 原文落在代码面板', () => {
    const html = renderMarkdownHtml('```echarts\n' + SRC + '\n```');
    assert.ok(html.includes('data-ki-diagram="echarts"'), '应标记为 echarts 图表块');
    assert.ok(html.includes('data-ki-code-tab="0"') && html.includes('data-ki-code-tab="1"'));
    assert.ok(html.includes('>图表</button>') && html.includes('>代码</button>'));
    assert.ok(html.includes('data-ki-code-panel="1" hidden'), '代码面板初始隐藏');
    assert.ok(html.includes('data-ki-diagram-pending'), '图表面板先给加载占位');
    assert.equal(codeText(html), SRC, '代码面板必须是逐字节原文（复制来源）');
  });

  it('大小写与 PlantUML 互不干扰，普通 json 代码块照旧', () => {
    assert.ok(renderMarkdownHtml('```ECharts\n' + SRC + '\n```').includes('data-ki-diagram="echarts"'));
    const plantuml = renderMarkdownHtml('```plantuml\n@startuml\nA -> B\n@enduml\n```');
    assert.ok(plantuml.includes('data-ki-diagram="plantuml"'));
    const plainJson = renderMarkdownHtml('```json\n{"a":1}\n```');
    assert.ok(plainJson.includes('class="ki-code-lang">json<'));
    assert.equal(plainJson.includes('data-ki-diagram'), false, 'json 代码块不应变成图表');
  });

  it('空围栏不产出容器', () => {
    assert.equal(renderMarkdownHtml('```echarts\n\n```'), '');
  });

  it('JSON 里的 HTML 被转义（不引入注入通路）', () => {
    const html = renderMarkdownHtml('```echarts\n{"title":{"text":"<img src=x onerror=alert(1)>"}}\n```');
    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('&lt;img'));
  });
});

describe('ECharts 工具函数（纯函数）', () => {
  it('isEchartsLanguage：只认 echarts，忽略大小写与 meta', () => {
    assert.equal(isEchartsLanguage('echarts'), true);
    assert.equal(isEchartsLanguage('ECharts'), true);
    assert.equal(isEchartsLanguage('echarts {x}'), true);
    for (const lang of ['plantuml', 'json', '', undefined]) assert.equal(isEchartsLanguage(lang), false, String(lang));
  });

  it('echartsOptionError：分别指出空 / 非法 JSON / 非对象', () => {
    assert.match(echartsOptionError('  '), /为空/);
    assert.match(echartsOptionError('{a:1}'), /不是合法 JSON/);
    assert.match(echartsOptionError('[1,2]'), /必须是 JSON 对象/);
    assert.match(echartsOptionError('"x"'), /必须是 JSON 对象/);
    assert.equal(echartsOptionError('{"series":[]}'), null);
  });

  it('sanitizeEchartsOption：关动画、剥 extraCssText 与 HTML 形态的 formatter', () => {
    const option = sanitizeEchartsOption({
      tooltip: { trigger: 'item', extraCssText: 'background:url(javascript:1)', formatter: '<b>{b}</b>' },
      series: [],
    });
    const tooltip = option.tooltip;
    assert.equal(option.animation, false, '静态快照必须关动画');
    assert.equal('extraCssText' in tooltip, false, 'extraCssText 属于 HTML/CSS 通道，必须剥掉');
    assert.equal('formatter' in tooltip, false, '含标签的 formatter 必须剥掉');
    // 合法字符串模板要保留（这是文档里最常用的写法）
    const kept = sanitizeEchartsOption({ tooltip: { formatter: '{b}: {c}ms ({d}%)' } });
    assert.equal(kept.tooltip.formatter, '{b}: {c}ms ({d}%)');
    // 原对象不被修改（深拷贝语义，调用方可能复用同一份 option）
    const original = { tooltip: { extraCssText: 'x' }, series: [{ animation: true }] };
    sanitizeEchartsOption(original);
    assert.equal(original.tooltip.extraCssText, 'x');
    assert.equal(original.series[0].animation, true);
  });

  it('sanitizeEchartsOption：逐层关动画（series[].animation 会覆盖顶层，实测会截到中间帧）', () => {
    const out = sanitizeEchartsOption({
      animation: false,
      series: [{ type: 'pie', animation: true, animationDuration: 1200, animationDelay: 300 }],
      tooltip: [{ extraCssText: 'x' }],
    });
    assert.equal(out.animation, false);
    assert.equal(out.series[0].animation, false, 'series 级动画必须一起关');
    assert.equal(out.series[0].animationDuration, 0);
    assert.equal(out.series[0].animationDelay, 0);
    assert.equal('extraCssText' in out.tooltip[0], false, '数组形态的 tooltip 同样要剥');
  });

  it('安全守卫只有一份实现（echarts 与 plantuml 都必须委托 svgGuard）', () => {
    const echartsSrc = fs.readFileSync(path.join(webRoot, 'src/lib/echarts.ts'), 'utf8');
    const plantumlSrc = fs.readFileSync(path.join(webRoot, 'src/lib/plantuml.ts'), 'utf8');
    assert.ok(echartsSrc.includes("from './svgGuard.js'"), 'echarts 应复用共享守卫');
    assert.ok(plantumlSrc.includes("from './svgGuard.js'"), 'plantuml 应复用共享守卫');
    assert.equal(echartsSrc.includes('FORBIDDEN'), false, '不应再自带一份标签黑名单');
    assert.equal(plantumlSrc.includes('FORBIDDEN'), false, '不应再自带一份标签黑名单');
  });

  it('normalizeEchartsSvg：剥绝对定位 style / 固定宽高，补 viewBox（否则盖住工具条且不能缩放）', () => {
    const raw = '<svg width="720" height="420" xmlns="http://www.w3.org/2000/svg" style="position: absolute; left: 0px; user-select: none;"><path d="M0 0"/></svg>';
    const out = normalizeEchartsSvg(raw, 720, 420);
    assert.equal(out.includes('position: absolute'), false, '绝对定位必须剥掉');
    assert.equal(/\swidth="/.test(out), false, '固定 width 必须去掉（交给 CSS 缩放）');
    assert.equal(/\sheight="/.test(out), false, '固定 height 必须去掉');
    assert.ok(out.includes('viewBox="0 0 720 420"'), '必须补 viewBox');
    assert.ok(out.includes('<path d="M0 0"/>'), '内部图元不能动');
    assert.ok(out.includes('xmlns='), '命名空间必须保留');

    // 已带 viewBox 的产物不得被覆盖
    const withBox = normalizeEchartsSvg('<svg viewBox="0 0 100 50"><rect/></svg>', 720, 420);
    assert.ok(withBox.includes('viewBox="0 0 100 50"'));
  });

  it('isBlankEchartsSvg：只有样式/装饰容器算空白', () => {
    assert.equal(isBlankEchartsSvg('<svg><style>.a{}</style><defs><clipPath/></defs></svg>'), true);
    assert.equal(isBlankEchartsSvg('<svg><path d="M0 0"/></svg>'), false);
    assert.equal(isBlankEchartsSvg('<svg><text>x</text><rect/></svg>'), false);
  });

  it('isSafeEchartsSvg：拦脚本/事件属性/危险 scheme，放行正常产物', () => {
    assert.equal(isSafeEchartsSvg('<svg><path d="M0 0"/><text>耗时</text></svg>'), true);
    assert.equal(isSafeEchartsSvg(''), false);
    assert.equal(isSafeEchartsSvg('<svg><script>alert(1)</script></svg>'), false);
    assert.equal(isSafeEchartsSvg('<svg><image onload=alert(1) /></svg>'), false, '裸值事件属性');
    assert.equal(isSafeEchartsSvg('<svg><a href=javascript:alert(1)>x</a></svg>'), false, '裸值危险 scheme');
    assert.equal(isSafeEchartsSvg('<svg><text>onclick= 只是文本</text></svg>'), true, '正文里的字样不误判');
  });

  it('echartsFallbackNotice：五档成因都有标记、原因与去路', () => {
    for (const kind of ['json', 'blank', 'unavailable', 'insecure', 'failed']) {
      const notice = echartsFallbackNotice(kind);
      assert.ok(notice.label.startsWith('⚠ '), `${kind} 应有标记`);
      assert.ok(notice.reason.length > 0 && notice.hint.length > 0, `${kind} 原因与去路都要有`);
      assert.equal(notice.title, `${notice.reason}。${notice.hint}`);
    }
    assert.match(echartsFallbackNotice('json', 'option 不是合法 JSON：x').reason, /不是合法 JSON/);
  });

  it('echartsErrorDetail：取首个非空行并限长', () => {
    assert.equal(echartsErrorDetail(new Error('\n boom \nstack')), 'boom');
    assert.equal(echartsErrorDetail(new Error('y'.repeat(300))).length, 158);
  });
});
