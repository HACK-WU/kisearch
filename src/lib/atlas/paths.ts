/**
 * 图集的磁盘路径约定。
 *
 * 布局（与 .relations / .trash 同口径用点号前缀，避免被文档扫描当成知识内容）：
 *   <kbDir>/<scope>/.atlas/
 *   ├── atlas.html          当前生效的 entry（下发用）
 *   ├── package.zip         原始压缩包（留档/审计/回滚）
 *   ├── meta.json           元信息
 *   ├── archive/<ts>.zip    上一版压缩包（保留 1 版）
 *   └── .upload/<uploadId>/ 分片暂存（二期页面上传用）
 *
 * 根路径一律复用 getKbDir（含 config.scopes[x].kbDir 覆盖逻辑），本模块不自己推导根。
 */
import path from 'node:path';
import { getKbDir } from '../scope.js';
import { AtlasError } from './errors.js';

/** 图集目录名（点号前缀：与 .relations / .trash 一致，不属于知识内容） */
export const ATLAS_DIR_NAME = '.atlas';

export function atlasDir(scope: string): string {
  return path.join(getKbDir(scope), ATLAS_DIR_NAME);
}

export function entryPath(scope: string): string {
  return path.join(atlasDir(scope), 'atlas.html');
}

export function packageZipPath(scope: string): string {
  return path.join(atlasDir(scope), 'package.zip');
}

export function metaPath(scope: string): string {
  return path.join(atlasDir(scope), 'meta.json');
}

export function archiveDir(scope: string): string {
  return path.join(atlasDir(scope), 'archive');
}

export function uploadDir(scope: string, uploadId: string): string {
  return path.join(atlasDir(scope), '.upload', safeSegment(uploadId, 'uploadId'));
}

/** 归档文件名：`atlas-<ISO时间戳去分隔符>.zip`，按名排序即时间序 */
export function archiveFilePath(scope: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return path.join(archiveDir(scope), `atlas-${stamp}.zip`);
}

/**
 * 校验一个「单段名」（uploadId 之类）：只允许字母数字与 -_。
 * 与 validateScope 同款白名单，防止 `../` 混进路径。
 */
export function safeSegment(raw: string, label: string): string {
  if (!raw || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new AtlasError('UNSAFE_ENTRY', `${label} 不合法：${JSON.stringify(raw)}`, '仅允许字母、数字、连字符与下划线');
  }
  return raw;
}

/**
 * 把包内条目相对路径安全地拼到 root 下。
 *
 * 三重校验（对应设计 S01 §3.3 第 4 步）：
 * 1. 非空、不含 NUL
 * 2. 不是绝对路径、不以 `/` 或 `\` 开头
 * 3. 逐段检查没有 `..` / `.` / 空段；拼完再确认仍在 root 内（防 Windows 盘符与符号链接式绕过）
 *
 * 说明：本函数只做「路径合法性」判断，不负责磁盘符号链接检测（解包只写一个新目录，
 * 且 zip 里的 symlink 条目已在 zip-read 阶段按外部属性位拒绝）。
 */
export function safeJoin(root: string, relPath: string): string {
  if (!relPath || relPath.includes('\0')) {
    throw new AtlasError('UNSAFE_ENTRY', '条目名含非法字符（空或 NUL）');
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new AtlasError('UNSAFE_ENTRY', `条目名为绝对路径：${relPath}`, '重新打包：不要带盘符或根目录前缀');
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new AtlasError('UNSAFE_ENTRY', `条目名含越界段：${relPath}`, '重新打包：包内路径必须相对且不含 ..');
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...segments);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new AtlasError('UNSAFE_ENTRY', `条目解析后越出目标目录：${relPath}`);
  }
  return target;
}
