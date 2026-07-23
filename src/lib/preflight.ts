/**
 * preflight.ts —— 写操作前置预检（NEG-07）
 *
 * 在 backup / restore / export 等写盘操作前，预检目标目录：
 *   - 可写性（试写探针，避免 EACCES 到写入中途才暴露）
 *   - 可用磁盘空间（估算需求 vs statfs，避免 ENOSPC 产生半截产物）
 *
 * 预检失败抛出带 code 的 Error，由调用方统一转成 JSON 错误输出。
 */

import fs from 'fs';
import path from 'path';

/** 预检失败错误码 */
export type PreflightCode = 'DIR_NOT_WRITABLE' | 'DISK_INSUFFICIENT';

export class PreflightError extends Error {
  code: PreflightCode;
  constructor(code: PreflightCode, message: string) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}

/**
 * 向上查找第一个已存在的祖先目录（目标目录可能尚未创建）。
 */
function firstExistingAncestor(dir: string): string {
  let cur = path.resolve(dir);
  // 最多上溯到根，避免死循环
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * 校验目标目录可写：对第一个已存在的祖先目录做试写探针。
 * @throws PreflightError('DIR_NOT_WRITABLE')
 */
export function checkWritable(dir: string): void {
  const base = firstExistingAncestor(dir);
  const probe = path.join(base, `.ki-write-probe.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new PreflightError(
      'DIR_NOT_WRITABLE',
      `目标目录无写权限：${base}\n` +
        `  系统错误：${(err as Error).message}\n` +
        `  请检查目录权限或改用有写权限的路径`
    );
  }
}

/**
 * 校验可用磁盘空间是否满足需求。
 * @param dir 目标路径（取其已存在祖先所在文件系统）
 * @param requiredBytes 预计需要的字节数
 * @throws PreflightError('DISK_INSUFFICIENT')
 */
export function checkDiskSpace(dir: string, requiredBytes: number): void {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return;
  const base = firstExistingAncestor(dir);
  // statfsSync：Node 18.15+ 稳定；不可用时跳过（尽力而为，不阻断）
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync;
  if (typeof statfs !== 'function') return;
  let available: number;
  try {
    const st = statfs(base);
    available = st.bavail * st.bsize;
  } catch {
    return; // 无法探测则不阻断
  }
  // 预留 10% 安全余量
  const needed = Math.ceil(requiredBytes * 1.1);
  if (available < needed) {
    throw new PreflightError(
      'DISK_INSUFFICIENT',
      `磁盘空间不足：${base}\n` +
        `  预计需要约 ${formatBytes(needed)}，当前可用 ${formatBytes(available)}\n` +
        `  请清理磁盘空间后重试`
    );
  }
}

/**
 * 估算目录占用字节数（递归，用于备份 tar 前的空间预检）。
 * 出错时返回 0（表示无法估算，调用方跳过空间检查）。
 */
export function estimateDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += estimateDirSize(full);
      } else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 单文件失败忽略 */
        }
      }
    }
  } catch {
    return 0;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
