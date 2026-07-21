/**
 * markdown-gen.ts — 共享 Markdown 生成工具
 *
 * 供 export.ts 和 wiki-sync.ts 共同使用，
 * 确保 KB 导出与 wiki 写回的 frontmatter 格式始终一致。
 */

/**
 * YAML 安全字符串：用 JSON.stringify 包裹，生成合法 YAML 双引号字符串
 * 防止特殊字符（: [] {} # "）破坏 frontmatter
 */
export function yamlSafe(input: string): string {
  // 仅当值包含 YAML 特殊字符时才包裹双引号
  if (/[:#\[\]{}",&*?|>!%@`]/.test(input) || input.startsWith('-') || input.startsWith(' ')) {
    return JSON.stringify(input);
  }
  return input;
}

/**
 * 生成带 YAML frontmatter 的 Markdown 文件内容
 */
export function generateMarkdown(
  groupPath: string,
  relation: string,
  keywords: string[],
  content: string | null,
  exportedAt: string
): string {
  const kwStr = keywords.map((k) => yamlSafe(k)).join(', ');
  const frontmatter = [
    '---',
    `groupPath: ${yamlSafe(groupPath)}`,
    `relation: ${yamlSafe(relation)}`,
    `keywords: [${kwStr}]`,
    `exportedAt: ${yamlSafe(exportedAt)}`,
    '---',
    '',
  ].join('\n');

  return content ? frontmatter + content : frontmatter;
}
