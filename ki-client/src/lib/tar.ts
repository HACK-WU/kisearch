/**
 * 最小 ustar 打包（零依赖）。
 *
 * 为什么自己写而不 spawn 系统 `tar`：
 * 客户端要在 Windows / 精简容器里也能跑，`tar` 不一定存在；而 ustar 头是 512 字节的
 * 定长结构，写对几个字段就够用，比多一个外部命令依赖更省心。
 *
 * 服务端用系统 tar 解包（`tar-compat.ts`），所以这里生成的必须是**标准 ustar**：
 * 路径 >100 字节时用 `prefix` 字段切分（总长可到 256）、`ustar\0` + `00` magic/version。
 *
 * 不做的事：目录条目、软链接、长路径（GNU 的 `././@LongLink`）—— 上传场景只有普通文件，
 * 遇到超长路径直接报错，让用户改名，而不是悄悄生成一个解不开的包。
 */

import zlib from 'node:zlib';

export interface TarEntry {
  /** 包内相对路径，用 `/` 分隔 */
  path: string;
  content: Buffer;
  /** 修改时间（毫秒），缺省用当前时间 */
  mtime?: number;
}

const BLOCK = 512;
/** ustar 头里 name / prefix 的字节上限 */
const NAME_MAX = 100;
const PREFIX_MAX = 155;

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, 'utf8').copy(buf, offset, 0, Math.min(length, Buffer.byteLength(value, 'utf8')));
}

/** 八进制字段：`length - 1` 位数字 + NUL */
function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const digits = length - 1;
  // 超出字段位宽时必须报错，不能靠 slice 取低位静默截断：size 字段 11 位八进制 ≈ 8GB，
  // 一个 >8GB 的归档若被截断，服务端解包会得到长度错乱的条目（比直接失败更难排查）
  if (!Number.isFinite(value) || value < 0 || value >= 8 ** digits) {
    throw new Error(`数值 ${value} 超出 tar 头的 ${digits} 位八进制字段上限（${8 ** digits - 1}）`);
  }
  buf.write(value.toString(8).padStart(digits, '0'), offset, 'ascii');
  buf.writeUInt8(0, offset + length - 1);
}

/** 长路径切成 prefix + name（ustar 的既有机制，不是 GNU 扩展） */
export function splitTarPath(relPath: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(relPath, 'utf8');
  if (bytes <= NAME_MAX) return { name: relPath, prefix: '' };

  let idx = relPath.length;
  while (idx > 0) {
    const slash = relPath.lastIndexOf('/', idx - 1);
    if (slash <= 0) break;
    const prefix = relPath.slice(0, slash);
    const name = relPath.slice(slash + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= PREFIX_MAX && Buffer.byteLength(name, 'utf8') <= NAME_MAX) {
      return { name, prefix };
    }
    idx = slash;
  }
  throw new Error(`路径过长，ustar 装不下（单段 >100 或整体 >256 字节）：${relPath}`);
}

function buildHeader(entry: TarEntry): Buffer {
  const { name, prefix } = splitTarPath(entry.path);
  const header = Buffer.alloc(BLOCK, 0);

  writeString(header, 0, NAME_MAX, name);
  writeOctal(header, 100, 8, 0o644);          // mode
  writeOctal(header, 108, 8, 0);              // uid
  writeOctal(header, 116, 8, 0);              // gid
  writeOctal(header, 124, 12, entry.content.length);
  writeOctal(header, 136, 12, Math.floor((entry.mtime ?? Date.now()) / 1000));
  // 先填空格再算校验和（标准要求：计算时 checksum 字段视为 8 个空格）
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');            // typeflag：普通文件
  header.write('ustar\0', 257, 'ascii');      // magic（6 字节，含 NUL）
  header.write('00', 263, 'ascii');           // version
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeOctal(header, 329, 8, 0);              // devmajor
  writeOctal(header, 337, 8, 0);              // devminor
  writeString(header, 345, PREFIX_MAX, prefix);

  let sum = 0;
  for (const byte of header) sum += byte;
  // checksum：6 位八进制 + NUL + 空格
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  return header;
}

/** 打一个未压缩的 tar */
export function createTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(buildHeader(entry));
    parts.push(entry.content);
    const pad = entry.content.length % BLOCK;
    if (pad !== 0) parts.push(Buffer.alloc(BLOCK - pad, 0));
  }
  // 结尾两个全零块
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** 打 tar.gz（服务端 `receiveTar` 认 `application/gzip`） */
export function createTarGz(entries: TarEntry[], level = 6): Buffer {
  return zlib.gzipSync(createTar(entries), { level });
}
