/**
 * `ki-client doc get` —— 把一篇文档还原成「本地可直接打开的 md + 附件」。
 *
 * 与 `asset get` 的分工：那条是「我已知 ref，把字节拿来」；这条是「我知道是哪篇，
 * 把整篇连同它的图一起搬下来」。后者依赖 `GET /open/v1/doc` 返回的 `images[].ref`，
 * 客户端不做任何映射（服务端保证 ref 可直接作为 asset 的 path）。
 *
 * ═══ 三个刻意的取舍 ═══
 * 1. **正文原样落盘**：`content` 就是服务端 `displayedContent` 的来源，不做 md 美化/重排——
 *    一旦客户端改写正文，「本地看到的」与「Web 看到的」就是两套事实。
 * 2. **附件串行取**：并发会打乱失败原因与顺序，而单篇附件通常个位数，串行足够快。
 * 3. **附件失败不中断正文**：正文拿到就该落盘，图缺几张是次要问题，最后统一报告。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ClientError } from '../errors.js';
import { assertCapability, getBinary, getJson, pingRemote } from '../http.js';
import type { ParsedArgs } from '../args.js';
import type { ResolvedRemote } from '../remote.js';

interface DocResponse {
  ok?: boolean;
  content?: string;
  revision?: number;
  lifecycle?: string;
  images?: Array<{ ref?: string; mime?: string; bytes?: number; supported?: boolean }>;
}

interface SavedAsset {
  ref: string;
  file: string;
  bytes: number;
}

/** 把 relation 变成安全的文件名：去掉路径分隔与 Windows 非法字符，避免落盘失败或逃逸 */
export function safeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return cleaned || 'untitled';
}

export async function runDoc(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const [sub] = args.positionals;
  if (sub !== 'get') {
    throw new ClientError(
      'USAGE',
      '用法：ki-client doc get --scope <库> --group <组> --relation <文档> --out <目录> [--no-assets] [--overwrite] [--json]',
      '取单张图请用：ki-client asset get --refs <ref>',
    );
  }

  const scope = args.string('scope')?.trim();
  const group = args.string('group')?.trim();
  const relation = args.string('relation')?.trim();
  const outDir = args.string('out')?.trim();
  const missing = [
    !scope ? 'scope' : '',
    !group ? 'group' : '',
    !relation ? 'relation' : '',
    !outDir ? 'out' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ClientError(
      'USAGE',
      `缺参数：${missing.join(' / ')}`,
      '用法：ki-client doc get --scope <库> --group <组> --relation <文档> --out <目录>',
    );
  }

  const absoluteOut = path.resolve(outDir!);
  const overwrite = args.bool('overwrite');
  const skipAssets = args.bool('no-assets');

  const info = await pingRemote(remote, scope!);
  assertCapability(info, 'doc', remote.name);

  const doc = await getJson<DocResponse>(remote, '/open/v1/doc', {
    scope: scope!,
    group: group!,
    relation: relation!,
  });

  if (doc.ok !== true || typeof doc.content !== 'string') {
    throw new ClientError(
      'SERVER_ERROR',
      `${remote.name}：文档不存在或返回体缺少 content（group + relation 需与库内落点完全一致）`,
      '先用 MCP ki_get_module_info 核对 group 与 relation，或检查文档是否已删除',
    );
  }

  const mdPath = path.join(absoluteOut, `${safeFileName(relation!)}.md`);
  if (fs.existsSync(mdPath) && !overwrite) {
    throw new ClientError(
      'FILE_EXISTS',
      `目标已存在：${mdPath}`,
      '确认要覆盖就加 --overwrite（默认不覆盖，避免冲掉本地改动）',
    );
  }
  fs.mkdirSync(absoluteOut, { recursive: true });
  fs.writeFileSync(mdPath, doc.content, 'utf-8');

  const savedAssets: SavedAsset[] = [];
  const failedAssets: Array<{ ref: string; reason: string }> = [];

  if (!skipAssets) {
    for (const image of doc.images ?? []) {
      const ref = image.ref?.trim();
      if (!ref) continue;
      // 外链与非受支持项：服务端已标 supported=false，这里跳过并记原因
      if (image.supported === false || /^[a-z][a-z0-9+.-]*:/i.test(ref)) {
        failedAssets.push({ ref, reason: image.supported === false ? '服务端标记不可取（外链/缺失/超限）' : '外链图片，非库内附件' });
        continue;
      }
      try {
        const clean = ref.replace(/^\.\/+/, '');
        const target = path.resolve(absoluteOut, clean);
        if (target !== absoluteOut && !target.startsWith(absoluteOut + path.sep)) {
          failedAssets.push({ ref, reason: 'ref 越出输出目录' });
          continue;
        }
        if (fs.existsSync(target) && !overwrite) {
          failedAssets.push({ ref, reason: '本地已存在（加 --overwrite 覆盖）' });
          continue;
        }
        const { bytes } = await getBinary(remote, '/open/v1/asset', { scope: scope!, group: group!, path: clean });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        savedAssets.push({ ref: clean, file: target, bytes: bytes.length });
      } catch (err) {
        failedAssets.push({ ref, reason: err instanceof ClientError ? `${err.code}: ${err.message}` : String((err as Error).message) });
      }
    }
  }

  const mdBytes = Buffer.byteLength(doc.content, 'utf-8');
  const mdSha = crypto.createHash('sha256').update(doc.content, 'utf-8').digest('hex');

  if (args.bool('json')) {
    console.log(JSON.stringify({
      ok: failedAssets.length === 0,
      remote: remote.name,
      document: { scope: scope!, group: group!, relation: relation!, revision: doc.revision, lifecycle: doc.lifecycle },
      markdown: { file: mdPath, bytes: mdBytes, sha256: mdSha },
      assets: savedAssets,
      failed: failedAssets,
    }, null, 2));
    return failedAssets.length === 0 ? 0 : 1;
  }

  console.log(`正文已保存 ${mdPath}`);
  console.log(`  ${mdBytes} 字节  ${mdBytes > 0 ? `${doc.content.split('\n').length} 行` : '（空文档）'}  sha256=${mdSha}`);
  if (doc.lifecycle === 'temp') console.log('  注意：这是临时文档（temp），到期会被清理');
  if (skipAssets) {
    console.log('已按 --no-assets 跳过附件');
  } else if (savedAssets.length > 0) {
    console.log(`附件 ${savedAssets.length} 个：`);
    for (const item of savedAssets) console.log(`  ${item.file}  (${item.bytes} 字节)`);
  }
  if (failedAssets.length > 0) {
    console.log(`\n附件 ${failedAssets.length} 个未取到：`);
    for (const item of failedAssets) console.log(`  - ${item.ref}：${item.reason}`);
  }
  return failedAssets.length === 0 ? 0 : 1;
}
