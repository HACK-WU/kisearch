/**
 * 附件（图片）的引用统计与孤儿判定（事件 #102）。
 *
 * ═══ 为什么是「即时算差集」而不是持久化引用计数表 ═══
 * 计数表要在 import 新建/覆盖、doc-edit 改正文、move、delete、restore、prune、trash purge
 * 七处维护；漏一处就是「计数归零但仍有引用」，后果是**静默误删图片且不可逆**。而删除文档时
 * 整组 `index.json` 本来就已经读进内存（`delete-relation.ts` 的元数据删除窗口），扫一遍
 * 引用是毫秒级 —— 用 7 个维护点换这点性能不划算。判据只有一份真源：本组所有文档的正文。
 *
 * ═══ 为什么只需扫本 group（跨 group 引用不成立）═══
 * 导入侧落点要求 `dst` 落在 `assetsDir` 内（越界即 warning 跳过），读侧
 * `normalizeImageRef` 也把 `..` 判成 traversal —— 图片物理上只能属于某一个 group。
 *
 * ═══ 归一化口径必须与落盘一致 ═══
 * 落盘时 `collectAndCopyAssets` 用的是 `decodeURIComponent(ref)` 后的 posix 相对路径
 * （`./images/x.svg` → `images/x.svg`；`./assets/x.svg` → `assets/assets/x.svg` 双层）。
 * 所以比对 key 统一走 {@link assetRelOfRef}，不要用裸 ref 或 basename。
 */

import fs from 'node:fs';
import path from 'node:path';

import { extractKbBody } from './content-vector-match.js';
import { extractImageRefs, isCollectibleRelativeAsset } from './markdown-image-refs.js';
import { getAssetsDir, getKbDir, getLocalKbDir } from './scope.js';
import { readJson } from './store.js';

/**
 * 把正文里的引用归一化成「assets 目录下的相对路径」。
 *
 * 返回 `null` 表示与任何本地附件无关：外链 / `data:` / 绝对路径 / 越界 `..` / 空。
 */
export function assetRelOfRef(ref: string): string | null {
  if (!isCollectibleRelativeAsset(ref)) return null;
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    // 裸 % 保持原样：不让一个非法编码让整张图永远算不进引用集合
  }
  const rel = path.posix.normalize(decoded.replace(/\\/g, '/'));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/** 一个 group 的「assets 相对路径 → 引用它的文档名集合」 */
export function collectGroupAssetRefs(kb: Record<string, unknown> | null | undefined): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const [relation, raw] of Object.entries(kb ?? {})) {
    const body = extractKbBody(raw);
    if (!body) continue;
    for (const ref of extractImageRefs(body)) {
      const rel = assetRelOfRef(ref);
      if (!rel) continue;
      const owners = refs.get(rel) ?? new Set<string>();
      owners.add(relation);
      refs.set(rel, owners);
    }
  }
  return refs;
}

export interface AssetFile {
  /** 相对 group 的 assets 目录（posix 分隔） */
  rel: string;
  bytes: number;
  mtimeMs: number;
}

/** 递归列出某 group 的 assets 文件（软链不跟：与服务端拒绝链接条目的口径一致） */
export function listAssetFiles(scope: string, group: string): AssetFile[] {
  const root = getAssetsDir(scope, group);
  const out: AssetFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // assets 目录不存在（从未带图）或读不到
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        out.push({ rel, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // 单个文件 stat 失败不该让整个扫描失败
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 列出某篇文档引用了、且磁盘上确实存在的附件（含字节数）。
 *
 * 与 {@link collectGroupAssetRefs} 的分工：那里回答「这张图被谁引用」，这里回答「这篇引用了哪些图」。
 * 各算所需的一半 —— 移动文档时不需要 owners，删除时不需要「某篇的清单」以外的信息。
 */
export function listDocAssetFiles(
  scope: string,
  group: string,
  relation: string,
  kbInput?: Record<string, unknown> | null,
): AssetFile[] {
  const kb = kbInput === undefined ? readGroupKb(scope, group) : kbInput;
  const refs = collectGroupAssetRefs(kb);
  const wanted = new Set<string>();
  for (const [rel, owners] of refs) {
    if (owners.has(relation)) wanted.add(rel);
  }
  if (wanted.size === 0) return [];
  return listAssetFiles(scope, group).filter((file) => wanted.has(file.rel));
}

/**
 * 把附件从源 group 复制到目标 group（移动文档用，**不删源**）。
 *
 * 目标已存在同名文件时**不覆盖**：
 *   - 内容相同 → 记 `skipped`（幂等，本来就共用同一张图）
 *   - 内容不同 → 记 `conflicts` 并由调用方给 warning，仍然**保留目标那份**
 *
 * 为什么内容冲突不直接报错挡下：`images/logo.png` 这类同名模板图在两个 group 各有一份
 * 是很常见的，挡死会让移动彻底不可用；而「显示成目标组那张图」是可见、可自查的，
 * 静默覆盖才是不可逆的破坏（目标组其它文档的图会被换掉）。
 */
export function copyAssetFiles(
  scope: string,
  fromGroup: string,
  toGroup: string,
  rels: string[],
): { created: string[]; skipped: string[]; conflicts: string[]; failed: string[]; bytes: number } {
  const created: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const failed: string[] = [];
  let bytes = 0;
  if (rels.length === 0) return { created, skipped, conflicts, failed, bytes };
  const fromRoot = path.resolve(getAssetsDir(scope, fromGroup));
  const toRoot = path.resolve(getAssetsDir(scope, toGroup));
  for (const rel of rels) {
    const src = path.resolve(fromRoot, rel);
    if (src !== fromRoot && !src.startsWith(fromRoot + path.sep)) continue;
    if (!fs.existsSync(src)) continue;
    const dst = path.resolve(toRoot, rel);
    if (dst !== toRoot && !dst.startsWith(toRoot + path.sep)) continue;
    if (fs.existsSync(dst)) {
      try {
        const same = fs.readFileSync(src).equals(fs.readFileSync(dst));
        (same ? skipped : conflicts).push(rel);
      } catch {
        conflicts.push(rel);
      }
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      bytes += fs.statSync(src).size;
      created.push(rel);
    } catch {
      // 单个文件复制失败不该让整次移动崩；由调用方按 created 回滚，未能复制的记 failed
      failed.push(rel);
    }
  }
  return { created, skipped, conflicts, failed, bytes };
}

/** 读某 group 的 local KB（`{ [relation]: string | {moduleInfo|content} }`） */
export function readGroupKb(scope: string, group: string): Record<string, unknown> | null {
  try {
    return readJson<Record<string, unknown>>(getLocalKbDir(scope, group));
  } catch {
    return null;
  }
}

export interface OrphanReport {
  group: string;
  /** assets 文件总数 */
  files: number;
  totalBytes: number;
  /** 没有任何文档引用的文件 */
  orphans: AssetFile[];
  orphanBytes: number;
  /** 正文引用了但磁盘上不存在（破图 / 历史遗留），用于诊断，不参与删除 */
  danglingRefs: string[];
}

/** 判定单个 group 的孤儿附件 */
export function findOrphansInGroup(
  scope: string,
  group: string,
  kbInput?: Record<string, unknown> | null,
): OrphanReport {
  const kb = kbInput === undefined ? readGroupKb(scope, group) : kbInput;
  const refs = collectGroupAssetRefs(kb);
  const files = listAssetFiles(scope, group);
  const onDisk = new Set(files.map((file) => file.rel));
  const orphans = files.filter((file) => !refs.has(file.rel));
  return {
    group,
    files: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    orphans,
    orphanBytes: orphans.reduce((sum, file) => sum + file.bytes, 0),
    danglingRefs: [...refs.keys()].filter((rel) => !onDisk.has(rel)),
  };
}

/**
 * 列出 scope 下所有「有 local KB」的 group 路径。
 *
 * 用目录遍历而不是 relations 分片：分片与 KB 可能不一致（历史上出现过只有 KB 没有分片的组），
 * 而孤儿扫描只关心正文引用，以 index.json 为准更稳。跳过 `.` 开头的目录（`.trash` / `.relations`）。
 */
export function listGroupsWithKb(scope: string): string[] {
  const root = getKbDir(scope);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(abs, 'index.json'))) out.push(rel);
      walk(abs, rel);
    }
  };
  walk(root, '');
  return out.sort();
}

export interface ScopeOrphanScan {
  scope: string;
  groups: OrphanReport[];
  files: number;
  totalBytes: number;
  orphanCount: number;
  orphanBytes: number;
  danglingRefs: number;
}

/**
 * 扫一个 scope 的所有 group（dry-run 用，只读）。
 *
 * `minAgeMs`：只把「mtime 早于 now - minAgeMs」的孤儿算进来 —— 给「保留 N 天」留出口，
 * 避免把刚导入还没写正文引用的中间态判成孤儿。
 */
export function scanScopeOrphans(
  scope: string,
  opts: { minAgeMs?: number; now?: number; group?: string } = {},
): ScopeOrphanScan {
  const now = opts.now ?? Date.now();
  const minAgeMs = Math.max(0, opts.minAgeMs ?? 0);
  const reports: OrphanReport[] = [];
  for (const group of opts.group ? [opts.group] : listGroupsWithKb(scope)) {
    const report = findOrphansInGroup(scope, group);
    if (minAgeMs > 0) {
      const kept = report.orphans.filter((file) => now - file.mtimeMs >= minAgeMs);
      report.orphans = kept;
      report.orphanBytes = kept.reduce((sum, file) => sum + file.bytes, 0);
    }
    reports.push(report);
  }
  return {
    scope,
    groups: reports.filter((report) => report.orphans.length > 0 || report.danglingRefs.length > 0),
    files: reports.reduce((sum, report) => sum + report.files, 0),
    totalBytes: reports.reduce((sum, report) => sum + report.totalBytes, 0),
    orphanCount: reports.reduce((sum, report) => sum + report.orphans.length, 0),
    orphanBytes: reports.reduce((sum, report) => sum + report.orphanBytes, 0),
    danglingRefs: reports.reduce((sum, report) => sum + report.danglingRefs.length, 0),
  };
}

/**
 * 删除孤儿文件（**调用方必须先做过 dry-run 并获得用户确认**）。
 *
 * 每个目标都做一次「仍在 assets 根内」的校验：`rel` 来自磁盘扫描，理论上安全，但
 * Windows 路径分隔与大小写可能让 `path.resolve` 产生意外，误删的代价不可逆。
 */
export function deleteOrphans(
  scope: string,
  items: Array<{ group: string; rel: string }>,
): { deleted: number; bytes: number; errors: string[] } {
  const errors: string[] = [];
  let deleted = 0;
  let bytes = 0;
  const touchedDirs = new Set<string>();
  for (const item of items) {
    const assetsRoot = path.resolve(getAssetsDir(scope, item.group));
    const abs = path.resolve(assetsRoot, item.rel);
    if (abs !== assetsRoot && !abs.startsWith(assetsRoot + path.sep)) {
      errors.push(`路径越界已跳过：${item.group}/${item.rel}`);
      continue;
    }
    try {
      const st = fs.statSync(abs);
      fs.rmSync(abs, { force: true });
      deleted += 1;
      bytes += st.size;
      touchedDirs.add(path.dirname(abs));
    } catch (err) {
      errors.push(`删除失败 ${item.group}/${item.rel}：${(err as Error).message}`);
    }
  }
  /**
   * 顺手清掉变空的**子目录**，但**不删 assets 根本身**。
   *
   * 检查必须在 rmdir 之前：写在之后会让「恰好被清空的 assets 根」先被删掉再 break
   * —— 功能上无碍（下次导入会重建），但 export / 备份与人工排查会看到
   * 「这个组从来没有过附件」，与事实不符。
   */
  for (const dir of touchedDirs) {
    let current = dir;
    while (true) {
      if (path.basename(current) === 'assets') break;
      try {
        if (fs.readdirSync(current).length > 0) break;
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
  return { deleted, bytes, errors };
}
