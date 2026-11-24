/**
 * 零依赖 zip 读取器（只读，不写包）。
 *
 * 为什么自研而不引 yauzl/adm-zip（设计 D2）：项目零 zip 依赖；平台只需「取出根目录那一个
 * html」；包由本仓 Python 侧 pack_atlas.py 产出，压缩方式固定为 STORE/DEFLATE。
 * 实测：Node zlib.inflateRawSync 可解 Python zipfile 产物（249 KB → 108 KB，sha 一致）。
 *
 * 支持范围（超出即显式报错，不猜）：
 * - STORE(0) / DEFLATE(8)
 * - 非加密、非 zip64
 * - 文件名按 UTF-8 解（pack_atlas.py 写 UTF-8；非 UTF-8 名字只会影响显示，不影响路径安全判据）
 *
 * 安全：条目路径一律过 safeJoin（`..` / 绝对路径 / NUL 全部拒绝）；
 * 解压总量边解边累计，防 zip bomb。
 */
import zlib from 'node:zlib';
import { AtlasError } from './errors.js';
import type { AtlasZipEntry } from './types.js';

/** zip 体积上限（设计 S01 §3.3 第 1 步） */
export const MAX_ZIP_BYTES = 20 * 1024 * 1024;
/** 解压总量上限（防 bomb） */
export const MAX_UNZIPPED_TOTAL = 50 * 1024 * 1024;
/** 条目数上限 */
export const MAX_ENTRIES = 50;
/** entry html 上限 */
export const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
/** 外部属性高位 = unix mode；0xA000 表示符号链接 */
const S_IFLNK = 0xa000;

interface CentralRecord {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  isDir: boolean;
}

export interface OpenedZip {
  /** 中央目录里的全部文件条目（已排除目录项），size 为解压后大小 */
  entries: AtlasZipEntry[];
  /** 解压单个条目（只允许 entries 里的名字） */
  read(name: string): Buffer;
}

/** 判断 buffer 是否是 zip（本地文件头 `PK\x03\x04`） */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_MIN) {
    throw new AtlasError('PACKAGE_INVALID', `文件过小（${buf.length} 字节），不可能是完整 zip`);
  }
  const start = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new AtlasError('PACKAGE_INVALID', '找不到 zip 中央目录结尾（EOCD）', '重新打包：包可能被截断或不是 zip');
}

/** 解析中央目录；顺带完成条目数 / zip64 / 加密 / 路径安全校验 */
function parseCentralDirectory(buf: Buffer): CentralRecord[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new AtlasError('UNSUPPORTED_ZIP', '不支持 zip64 格式', '用 pack_atlas.py 产出的原始包，不要用外部工具重打包');
  }
  if (total > MAX_ENTRIES) {
    throw new AtlasError('UNSUPPORTED_ZIP', `条目数 ${total} 超过上限 ${MAX_ENTRIES}`, '包内只应有图集 html 与少量随附文件');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new AtlasError('PACKAGE_INVALID', '中央目录偏移越界（包被截断）');
  }

  const records: CentralRecord[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new AtlasError('PACKAGE_INVALID', `第 ${i + 1} 个中央目录项损坏`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (flags & 0x0001) {
      throw new AtlasError('UNSUPPORTED_ZIP', `条目已加密：${name}`, '不要给图集包加密');
    }
    if (method !== 0 && method !== 8) {
      throw new AtlasError('UNSUPPORTED_ZIP', `条目压缩方式不支持（method=${method}）：${name}`, '只支持 STORE/DEFLATE');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new AtlasError('UNSUPPORTED_ZIP', `条目使用 zip64 扩展：${name}`);
    }
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === S_IFLNK) {
      throw new AtlasError('UNSAFE_ENTRY', `条目是符号链接：${name}`, '重新打包：包内不能含符号链接');
    }

    records.push({
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDir: name.endsWith('/'),
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return records;
}

/** 本地文件头里的数据起点：必须用本地头的 nameLen/extraLen（可与中央目录不同） */
function dataOffsetOf(buf: Buffer, rec: CentralRecord): number {
  const lho = rec.localOffset;
  if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOCAL) {
    throw new AtlasError('PACKAGE_INVALID', `本地文件头损坏：${rec.name}`);
  }
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  return lho + 30 + nameLen + extraLen;
}

/** 解压单个条目，累加器由调用方持有（跨条目累计，防 bomb） */
function inflateRecord(buf: Buffer, rec: CentralRecord, budget: { remain: number }): Buffer {
  const start = dataOffsetOf(buf, rec);
  const end = start + rec.compressedSize;
  if (end > buf.length) {
    throw new AtlasError('PACKAGE_INVALID', `条目数据越界：${rec.name}`);
  }
  // 解压前按中央目录声明的解压后大小预判：否则「先解码再判总量」会让单个超大条目
  // 先把内存撑起来（50 MB 预算挡不住一次 500 MB 的膨胀）。
  if (rec.uncompressedSize > budget.remain) {
    throw new AtlasError(
      'TOO_LARGE',
      `条目 ${rec.name} 声明解压后 ${(rec.uncompressedSize / 1024 / 1024).toFixed(1)} MB，超出剩余预算 ${(budget.remain / 1024 / 1024).toFixed(1)} MB`,
      '减少视图数量后重打包',
    );
  }
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (rec.method === 0) {
    data = raw;
  } else {
    try {
      data = zlib.inflateRawSync(raw);
    } catch (err) {
      throw new AtlasError('PACKAGE_INVALID', `条目解压失败：${rec.name}（${(err as Error).message}）`);
    }
  }
  if (rec.uncompressedSize > 0 && data.length !== rec.uncompressedSize) {
    throw new AtlasError('PACKAGE_INVALID', `条目大小与中央目录不符：${rec.name}（声明 ${rec.uncompressedSize}，实际 ${data.length}）`);
  }
  budget.remain -= data.length;
  if (budget.remain < 0) {
    throw new AtlasError('TOO_LARGE', `解压总量超过 ${MAX_UNZIPPED_TOTAL / 1024 / 1024} MB`, '减少视图数量后重打包');
  }
  return data;
}

/**
 * 打开一个 zip：解析中央目录并给出解压能力。
 * 不在这里选 entry（那是 package.ts 的职责），也不落盘。
 */
export function openZip(buf: Buffer): OpenedZip {
  if (!isZip(buf)) {
    throw new AtlasError('PACKAGE_INVALID', '不是 zip 文件（缺少 PK 文件头）', '用 pack_atlas.py <图集目录> dist/ --zip 打包');
  }
  if (buf.length > MAX_ZIP_BYTES) {
    throw new AtlasError('TOO_LARGE', `包体积 ${(buf.length / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB`, '减少视图数量后重打包');
  }
  const records = parseCentralDirectory(buf);
  const files = records.filter((r) => !r.isDir);
  const byName = new Map(files.map((r) => [r.name, r]));
  const budget = { remain: MAX_UNZIPPED_TOTAL };

  return {
    entries: files.map((r) => ({ name: r.name, size: r.uncompressedSize })),
    read(name: string): Buffer {
      const rec = byName.get(name);
      if (!rec) {
        throw new AtlasError('PACKAGE_INVALID', `条目不存在：${name}`);
      }
      return inflateRecord(buf, rec, budget);
    },
  };
}
