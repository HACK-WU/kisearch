import assert from 'node:assert/strict';
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
  classifyPlantumlSvg,
  isPlantumlLanguage,
  isSafePlantumlSvg,
  plantumlErrorDetail,
  plantumlFallbackNotice,
} = await vite.ssrLoadModule('/src/lib/plantuml.ts');
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

const SRC = '@startuml\nactor 用户\n用户 -> R : POST /x\n@enduml';

describe('PlantUML 围栏 → 图表/代码双面板', () => {
  it('渲染成带两个 tab 与两个面板的块，源码完整落在代码面板', () => {
    const html = renderMarkdownHtml('```plantuml\n' + SRC + '\n```');
    assert.ok(html.includes('data-ki-plantuml'), '应标记为 PlantUML 块');
    assert.ok(html.includes('data-ki-code-tab="0"') && html.includes('data-ki-code-tab="1"'), '应有图表/代码两个 tab');
    assert.ok(html.includes('>图表</button>') && html.includes('>代码</button>'), 'tab 文案应为图表/代码');
    assert.ok(html.includes('aria-selected="true"') && html.includes('aria-selected="false"'), '默认选中图表');
    assert.ok(html.includes('data-ki-code-panel="1" hidden'), '代码面板初始隐藏（图表态）');
    assert.ok(html.includes('data-ki-plantuml-pending'), '图表面板先给加载占位');
    assert.equal(codeText(html), SRC, '代码面板必须是逐字节原文（复制来源）');
  });

  it('三种围栏别名与大小写都识别，且不再产出 mermaid 目标', () => {
    for (const lang of ['plantuml', 'puml', 'uml', 'PlantUML']) {
      const html = renderMarkdownHtml('```' + lang + '\n' + SRC + '\n```');
      assert.ok(html.includes('data-ki-plantuml'), `${lang} 应识别为 PlantUML`);
      assert.equal(html.includes('language-mermaid'), false, `${lang} 不应进入 mermaid 链路`);
    }
  });

  it('mermaid 与普通代码块维持原样（本次不改其渲染路径）', () => {
    const mermaid = renderMarkdownHtml('```mermaid\nsequenceDiagram\n  A->>B: hi\n```');
    assert.ok(mermaid.includes('language-mermaid'));
    assert.equal(mermaid.includes('data-ki-plantuml'), false, 'mermaid 不应带图表/代码切换');

    const plain = renderMarkdownHtml('```python\nprint(1)\n```');
    assert.ok(plain.includes('class="ki-code-lang">python<'));
    assert.equal(plain.includes('data-ki-plantuml'), false);
  });

  it('空围栏不产出容器（与既有空块口径一致）', () => {
    assert.equal(renderMarkdownHtml('```plantuml\n\n```'), '');
  });

  it('源码内的 HTML 被转义（不引入新的注入通路）', () => {
    const html = renderMarkdownHtml('```plantuml\n@startuml\nA -> B : <img src=x onerror=alert(1)>\n@enduml\n```');
    assert.equal(html.includes('<img'), false, '源码中的标签必须被转义');
    assert.ok(html.includes('&lt;img'));
  });
});

describe('PlantUML 工具函数（纯函数）', () => {
  it('isPlantumlLanguage：只认 plantuml/puml/uml，忽略大小写与 meta', () => {
    for (const lang of ['plantuml', 'PUML', 'uml', 'plantuml {data-x}']) assert.equal(isPlantumlLanguage(lang), true, lang);
    for (const lang of ['mermaid', 'python', '', undefined, 'plantumlx']) assert.equal(isPlantumlLanguage(lang), false, String(lang));
  });

  it('isSafePlantumlSvg：放行正常产物，拦脚本/事件属性/危险 scheme', () => {
    assert.equal(isSafePlantumlSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><text>hi</text></g></svg>'), true);
    assert.equal(isSafePlantumlSvg(''), false, '空产物不可注入');
    assert.equal(isSafePlantumlSvg('<div>没有 svg 根</div>'), false);
    assert.equal(isSafePlantumlSvg('<svg><script>alert(1)</script></svg>'), false, '脚本标签');
    assert.equal(isSafePlantumlSvg('<svg><svg:script>1</svg:script></svg>'), false, '命名空间前缀不能绕过');
    assert.equal(isSafePlantumlSvg('<svg><image onload="alert(1)"/></svg>'), false, '事件属性');
    assert.equal(isSafePlantumlSvg('<svg><foreignObject><body/></foreignObject></svg>'), false, 'foreignObject');
    assert.equal(isSafePlantumlSvg('<svg><a href="javascript:alert(1)">x</a></svg>'), false, 'javascript scheme');
    assert.equal(isSafePlantumlSvg('<svg><a href="java\tscript:alert(1)">x</a></svg>'), false, '空白混淆的 scheme');
    // 裸值属性（无引号）是最容易被漏掉的形态：只认带引号的写法会放过它
    assert.equal(isSafePlantumlSvg('<svg><a href=javascript:alert(1)>x</a></svg>'), false, '裸值 javascript scheme');
    assert.equal(isSafePlantumlSvg('<svg><image onload=alert(1) /></svg>'), false, '裸值事件属性');
    assert.equal(isSafePlantumlSvg('<svg><image href="data:image/png;base64,AAA"/></svg>'), true, 'data:image 放行');
  });

  it('只扫标签片段：正文里出现 onclick 字样不应被误判', () => {
    assert.equal(isSafePlantumlSvg('<svg><text>handler onclick=alert(1)</text></svg>'), true);
  });

  it('classifyPlantumlSvg：识别引擎画出来的三种错误图', () => {
    // 实测文案（2026-11-12，浏览器内跑 @plantuml/core 得到）
    assert.equal(classifyPlantumlSvg('<svg><text>Syntax Error?</text></svg>'), 'syntax');
    assert.equal(classifyPlantumlSvg('<svg><text>Empty description</text></svg>'), 'empty');
    assert.equal(classifyPlantumlSvg('<svg><text>cannot include http</text></svg>'), 'include');
    assert.equal(classifyPlantumlSvg('<svg><text>POST /fta/alert/</text></svg>'), 'ok');
  });

  it('plantumlFallbackNotice：六种成因都有标记、原因与去路', () => {
    const kinds = ['syntax', 'empty', 'include', 'unavailable', 'insecure', 'failed'];
    for (const kind of kinds) {
      const notice = plantumlFallbackNotice(kind);
      assert.ok(notice.label.startsWith('⚠ PlantUML'), `${kind} 标记应带前缀`);
      assert.ok(notice.reason.length > 0 && notice.hint.length > 0, `${kind} 原因与去路都要有`);
      assert.equal(notice.title, `${notice.reason}。${notice.hint}`);
    }
  });

  it('plantumlErrorDetail：取首个非空行并限长', () => {
    assert.equal(plantumlErrorDetail(new Error('\n\n  Diagram too large  \nstack')), 'Diagram too large');
    const long = plantumlErrorDetail(new Error('x'.repeat(300)));
    assert.equal(long.length, 158);
    assert.ok(long.endsWith('…'));
  });
});
