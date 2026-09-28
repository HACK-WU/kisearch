import { encodeKiLink, type KiLinkTarget } from '@/lib/kiLinks';

/** 阅读页的可见文字必须在 Markdown 源码中恰好出现一次，才允许直接改写。 */
export function insertReaderLink(content: string, selectedText: string, target: KiLinkTarget): string {
  const label = selectedText.trim();
  if (!label || /[\r\n]/.test(label)) throw new Error('请在同一个文本块中选中要添加链接的文字');
  const start = content.indexOf(label);
  if (start < 0 || content.indexOf(label, start + label.length) >= 0) {
    throw new Error('所选文字在 Markdown 源码中无法唯一定位，请使用“编辑文档”手动添加');
  }
  const escaped = label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  const link = `[${escaped}](${encodeKiLink(target)})`;
  return content.slice(0, start) + link + content.slice(start + label.length);
}

/** 只有带点号域名（或 localhost / IPv4）的 HTTP(S) 地址才算有效外链。 */
export function externalTarget(input: string): KiLinkTarget {
  const raw = input.trim();
  if (!raw) throw new Error('请输入外部网址');
  if (/\s/.test(raw)) throw new Error('网址中不能有空格');
  const value = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(value);
    const host = url.hostname;
    const routable = host === 'localhost'
      || /^\d+(\.\d+){3}$/.test(host)
      || /^([\w-]+\.)+[\w-]{2,}$/.test(host);
    if (!['http:', 'https:'].includes(url.protocol) || !routable) throw new Error();
    return { v: 1, type: 'external', url: url.href };
  } catch {
    throw new Error('请输入有效网址，例如 https://example.com/docs');
  }
}
