// REQ-20260904-001 取证探针：cleanMarkdownText 对 Markdown 图片语法的真实端到端行为
//
// 为什么用 jiti 调真实函数而非复制正则：
//   clean.ts 的规则有执行顺序耦合（代码块先剥离 → 路径剥离仅代码块外 → 整行仅剩符号则删行），
//   单独复现 :94 那一行正则无法反映最终落盘到向量的文本形态。
//
// 运行（本机 node 不在默认 PATH，须按项目环境约束）：
//   export PATH="/root/.nvm/versions/node/v22.22.2/bin:$PATH"
//   unset NODE_OPTIONS BASH_ENV
//   ./node_modules/.bin/jiti .requirements/2026-09-04-外部Wiki图片附件导入与显示/demo/probe-clean-image.mjs
//
// 2026-09-04 实测结论（7 用例 → 4 种不同结果）：
//   1 相对路径+alt      ![架构图](images/arch.png)      → !架构图        （感叹号残留、路径丢弃）
//   2 相对路径+无alt    ![](images/no-alt.png)          → !             （只剩孤立感叹号，纯噪音）
//   3 http 外链+alt     ![截图](https://.../a.png)      → !截图         （外链图片同样被破坏）
//   4 HTML img 写法     <img src=... alt="拓扑">        → 原样保留       （HTML 噪音进向量；前端又渲染为空白）
//   5 图片独占一行      ![架构图](images/arch.png)      → !架构图        （未被"整行仅剩符号→删行"清理）
//   6 链接与图片混排    见 [文档](docs/x.md) 与 ![图](…) → 见 文档 与 !图 …（同 1）
//   7 路径含空格        ![图](images/with space.png)    → 原样保留       （[^)\s]* 排除空格 → 不匹配）

import { cleanMarkdownText } from '../../../src/lib/clean.ts';

const cases = [
  ['1 相对路径 + alt', '# 标题\n\n正文一段说明。\n\n![架构图](images/arch.png)\n\n正文二段说明。\n'],
  ['2 相对路径 + 无 alt', '# 标题\n\n正文一段说明。\n\n![](images/no-alt.png)\n\n正文二段说明。\n'],
  ['3 http 外链 + alt', '# 标题\n\n正文一段说明。\n\n![截图](https://cdn.example.com/a.png)\n\n正文二段说明。\n'],
  ['4 HTML img 写法', '# 标题\n\n正文一段说明。\n\n<img src="images/a.png" alt="拓扑">\n\n正文二段说明。\n'],
  ['5 图片独占一行（无正文包裹）', '![架构图](images/arch.png)\n'],
  ['6 链接与图片混排', '见 [设计文档](docs/x.md) 与 ![图](img/a.png) 混排在一行。\n'],
  ['7 路径含空格', '![图](images/with space.png)\n'],
];

for (const [name, md] of cases) {
  const out = cleanMarkdownText(md);
  console.log('=== ' + name);
  console.log('  IN : ' + JSON.stringify(md));
  console.log('  OUT: ' + JSON.stringify(out));
}
