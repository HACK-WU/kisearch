// clean.mjs —— demo 验证用：cleanMarkdownText 最小实现（对齐 code-survey.md §5 伪代码）
// 验证目的：R-04 清洗规则可执行性（BOM/frontmatter/mermaid/路径/代码块/空行剥离）

export function cleanMarkdownText(text, rules = {}) {
  const {
    bom = true,
    frontmatter = true,
    htmlComment = true,
    mermaid = true,
    codePath = true,
    codeBlock = true,
    keepShortSamples = true,
  } = rules;

  let t = text;

  // ① BOM
  if (bom) t = t.replace(/^\uFEFF/, '');

  // ② 控制字符/替换符/零宽
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u200B-\u200F]/g, '');
  t = t.normalize('NFC');

  // ③ frontmatter 整块删除（含闭合边界校验）
  if (frontmatter && t.startsWith('---')) {
    const end = t.indexOf('\n---', 3);
    if (end !== -1 && /^[A-Za-z_-]+:\s*\S/m.test(t.slice(3, end))) {
      const after = t.slice(end + 4);
      if (after === '' || /^[\r\n]/.test(after)) {
        t = after;
      }
    }
  }

  // ③ HTML 注释
  if (htmlComment) t = t.replace(/<!--[\s\S]*?-->/g, '');

  // ③ mermaid 块
  if (mermaid) t = t.replace(/```mermaid[\s\S]*?```/g, '');

  // ⑦ 代码块剥离（保留短示例）—— 先于路径剥离执行，保留的短示例整体原样（不被路径正则破坏）
  if (codeBlock) {
    const CODE_FENCE = /```[a-zA-Z0-9_-]*\n[\s\S]*?```/g;
    t = keepShortSamples
      ? t.replace(CODE_FENCE, (m) => (m.split('\n').length <= 17 ? m : ''))
      : t.replace(CODE_FENCE, '');
    // 清理剥离后残留的孤立语言标记（```python 剥成 `python` 或 python 单独成行）
    t = t.replace(/^\s*`?(python|bash|sh|ts|js|json|yaml|yml|go|java|rust|sql|text)\s*`?\s*$/gm, '');
  }

  // ⑤ 文件路径剥离（前置排除 URL；仅作用于代码块外文本）
  if (codePath) {
    // 先整块剥 markdown 链接目标，保留文字
    t = t.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1');
    // 排除 URL 后的裸路径剥离（demo 简化：先剥 file:// 再剥含目录层级的代码路径）
    t = t.replace(/file:\/\/[^\s\)\]>]+/g, '');
    // 先剥行号引用（支持 #L490、#L490-L510、#L490-L510 及 :490 范围；-L510 后缀兜底）
    t = t.replace(/(?:#L\d+(?:-\d+|-L\d+)?|:\d+(?:-\d+)?|#L\d+)/g, '');
    t = t.replace(/-L\d+/g, '');
    // 再剥含目录层级的代码路径：路径不得包含 #（行号已剥）、-L 后缀
    t = t.replace(/\b[\w./]+\/[\w./-]+\.(?:py|ts|js|tsx|go|java|rs|sh|md|json|yaml|yml)(?![\w-])/g, '');
    // 清理剥离后残留的空 inline code / 空引用（`  `、- `  `）
    t = t.replace(/`\s*`/g, '');
    // 剥离后整行仅剩空白/符号（含反引号、`-`、`|` 表格残壳） → 删行
    t = t
      .split('\n')
      .filter((l) => l.trim().length > 0 && !/^[\s\-*•·>|`]+$/.test(l))
      .join('\n');
    // 清理"引用清单"残壳：标题行（**xxx** 或 # 标题）后紧邻的是空清单（已删空），
    // 此时标题行成为孤儿声明 → 若标题行自身不含正文内容则删除
    // 用户决策：引用清单（"本文引用的文件"类）整体删除，标题一并清理
    const lines = t.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // 孤儿的"引用的文件"类标题：**xxx** 冒号结尾 + 无后续内容
      if (/^\*\*[^*]+\*\*[:：]?$/.test(line) && /引用|参考|文件/.test(line)) {
        // 仅当下一行不是实际内容（空行或已到 EOF 或下一行也是标题）才删
        const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
        if (next === '' || /^(#|\*\*)/.test(next)) continue; // 跳过（删除该孤儿标题）
      }
      kept.push(lines[i]);
    }
    t = kept.join('\n');
  }

  // ③ 折叠空行
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
