/**
 * `ki-client asset get` —— 把文档里的附件（图片）落到本地。
 *
 * ═══ 为什么输出**绝对路径 + sha256** ═══
 * 这个命令的第一用途是"给 AI 看得到图"：图落到本地后要交给 IDE 的读图能力，
 * 而那个能力按绝对路径取文件；sha256 则是「拿到的确实是库里的那份」的唯一凭据
 * （只比字节数会被同名覆盖骗过）。
 *
 * ═══ 落盘必须保留 ref 的相对子路径 ═══
 * `shots/a.png` 要落成 `<out>/shots/a.png`，不能拍平成 `<out>/a.png`：
 * 文档正文里的引用依赖这个相对结构，拍平后整篇 md 的图全断。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ClientError } from '../errors.js';
import { assertCapability, getBinary, pingRemote } from '../http.js';
import type { ParsedArgs } from '../args.js';
import type { ResolvedRemote } from '../remote.js';

/** 单次取图张数上限（与服务端 `MAX_IMAGES_PER_CALL` 对齐） */
const MAX_REFS = 3;

interface SavedItem {
  ref: string;
  file: string;
  bytes: number;
  sha256: string;
  mime: string;
}

interface FailedItem {
  ref: string;
  reason: string;
}

export async function runAsset(args: ParsedArgs, remote: ResolvedRemote): Promise<number> {
  const [sub] = args.positionals;
  if (sub !== 'get') {
    throw new ClientError(
      'USAGE',
      '用法：ki-client asset get --scope <库> --group <组> --refs <ref[,ref...]> --out <目录> [--overwrite] [--json]',
      'ref 用 ki_get_module_info 或 doc get 返回的 images[].ref 原样传',
    );
  }

  const scope = args.string('scope')?.trim();
  const group = args.string('group')?.trim();
  const refsRaw = args.string('refs')?.trim();
  const outDir = args.string('out')?.trim();
  const missing = [
    !scope ? 'scope' : '',
    !group ? 'group' : '',
    !refsRaw ? 'refs' : '',
    !outDir ? 'out' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ClientError('USAGE', `缺参数：${missing.join(' / ')}`, '用法：ki-client asset get --scope <库> --group <组> --refs <ref> --out <目录>');
  }

  const refs = refsRaw!.split(',').map((r) => r.trim()).filter(Boolean);
  if (refs.length === 0) throw new ClientError('USAGE', 'refs 为空', '至少给 1 个 ref');
  if (refs.length > MAX_REFS) {
    throw new ClientError('USAGE', `一次最多 ${MAX_REFS} 张（当前 ${refs.length} 张）`, '分几次调用，或先按需挑出真正要看的');
  }

  const absoluteOut = path.resolve(outDir!);
  const overwrite = args.bool('overwrite');

  // 取件前先确认服务端开了读出口：否则要等第一张 404 才知道
  const info = await pingRemote(remote, scope!);
  assertCapability(info, 'asset', remote.name);

  const saved: SavedItem[] = [];
  const failed: FailedItem[] = [];

  for (const ref of refs) {
    try {
      const item = await fetchOne(remote, scope!, group!, ref, absoluteOut, overwrite);
      saved.push(item);
    } catch (err) {
      // 单张失败不中断其余：最后统一报告，退出码非 0（设计 N4）
      failed.push({ ref, reason: err instanceof ClientError ? `${err.code}: ${err.message}` : String((err as Error).message) });
    }
  }

  if (args.bool('json')) {
    console.log(JSON.stringify({ ok: failed.length === 0, remote: remote.name, saved, failed }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }

  for (const item of saved) {
    console.log(`已保存 ${item.file}`);
    console.log(`  ref=${item.ref}  ${item.bytes} 字节  ${item.mime}`);
    console.log(`  sha256=${item.sha256}`);
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} 张没取到：`);
    for (const item of failed) console.log(`  - ${item.ref}：${item.reason}`);
  }
  return failed.length === 0 ? 0 : 1;
}

async function fetchOne(
  remote: ResolvedRemote,
  scope: string,
  group: string,
  rawRef: string,
  outDir: string,
  overwrite: boolean,
): Promise<SavedItem> {
  // 归一：剥 `./` 前缀（服务端也会归一，这里保证本地落点与 ref 一致）
  const ref = rawRef.replace(/^\.\/+/, '');
  if (!ref) throw new ClientError('USAGE', 'ref 为空');

  const target = path.resolve(outDir, ref);
  // 本地也要挡越界：ref 可能被手工写成 `../../etc/passwd`
  if (target !== outDir && !target.startsWith(outDir + path.sep)) {
    throw new ClientError('USAGE', `ref 越出输出目录：${rawRef}`, 'ref 应为文档里的相对路径');
  }

  if (fs.existsSync(target) && !overwrite) {
    throw new ClientError(
      'FILE_EXISTS',
      `目标已存在：${target}`,
      '确认要覆盖就加 --overwrite（默认不覆盖，避免冲掉本地已有文件）',
    );
  }

  const { bytes, contentType } = await getBinary(remote, '/open/v1/asset', { scope, group, path: ref });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);

  return {
    ref,
    file: target,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mime: contentType.split(';')[0]?.trim() ?? '',
  };
}
