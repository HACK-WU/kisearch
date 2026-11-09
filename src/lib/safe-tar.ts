import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tarPathArgs, tarPath } from './tar-compat.js';

/**
 * 将 scope 快照解压到 staging 目录并原子搬入目标目录。
 *
 * 快照路径可以由调用方显式指定，不能假设一定由本程序生成：先校验 tar
 * 条目只能位于目标 scope 目录下，再在目标父目录内解压，最后复检符号链接。
 * 这样可同时阻断 `../`、绝对路径和指向 scope 外部的 symlink，避免 restore
 * 借 tar 覆盖任意用户文件。
 */
export function extractScopeSnapshot(snapshotPath: string, scopeDataDir: string): void {
  const parent = path.dirname(scopeDataDir);
  const expectedRoot = path.basename(scopeDataDir);
  validateTarEntries(snapshotPath, expectedRoot);

  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${expectedRoot}.restore-`));
  try {
    execFileSync('tar', [...tarPathArgs(), '-xzf', tarPath(snapshotPath), '-C', tarPath(staging)], { stdio: 'ignore', windowsHide: true });
    const extractedRoot = path.join(staging, expectedRoot);
    if (!fs.existsSync(extractedRoot) || !fs.statSync(extractedRoot).isDirectory()) {
      throw new Error(`快照缺少目标 scope 目录：${expectedRoot}`);
    }
    const stagingReal = fs.realpathSync(extractedRoot);
    validateTree(extractedRoot, stagingReal);
    const roots = fs.readdirSync(staging);
    if (roots.length !== 1 || roots[0] !== expectedRoot) {
      throw new Error(`快照包含 scope 外部条目：期望仅有 ${expectedRoot}/`);
    }
    fs.renameSync(extractedRoot, scopeDataDir);
  } finally {
    // staging 是本次 restore 的临时目录，目标路径明确且不触碰用户其它目录。
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 保留现场供人工排查 */ }
  }
}

/** tar 的两份清单（`-tzf` 条目名 + `-tvzf` 详细行），一次读出供多组校验复用 */
export interface TarListing {
  entries: string[];
  verboseLines: string[];
}

/**
 * 读清单；tar 不存在/包损坏时抛错（调用方据此区分「包坏了」与「包不安全」）。
 *
 * 导出是为了让「既要校验又要统计体积」的调用方（第三方上传的 zip-bomb 闸门）
 * **只解一遍包**：512MB 的包每多跑一次 `tar -tzf` 就多解压一次整个流。
 */
export function readTarListing(tarFile: string): TarListing {
  let listing: string;
  let verboseListing: string;
  try {
    listing = execFileSync('tar', [...tarPathArgs(), '-tzf', tarPath(tarFile)], { encoding: 'utf8', windowsHide: true });
    // 在解压前拒绝链接条目。仅在 staging 解压后检查 symlink 太晚：恶意
    // archive 可能先创建外链，再让后续条目沿链接写到 staging 外部。
    verboseListing = execFileSync('tar', [...tarPathArgs(), '-tvzf', tarPath(tarFile)], { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    throw new Error(`无法读取快照目录清单：${(err as Error).message}`);
  }
  return {
    entries: listing.split('\n').map((entry) => entry.trim()).filter(Boolean),
    verboseLines: verboseListing.split('\n'),
  };
}

/**
 * 通用越界校验：只拒**绝对路径 / `..` / 链接条目**，不限定顶层目录。
 *
 * 为什么需要「不限定顶层」的版本：第三方上传的 tar 由 agent 现场打包
 * （`tar czf - -C ./docs .`），条目是 `./`、`a.md`、`sub/b.md`，本来就没有统一顶层；
 * 复用 restore 那条「所有条目必须在 <scope>/ 下」的规则会把合法包全拒掉。
 *
 * 被拒即整包拒收（调用方不得「跳过坏条目继续解包」）：tar 的条目顺序会影响后续条目
 * 的解析基准，跳过一条无法保证剩下的仍安全。
 */
export function validateTarEntriesGeneric(tarFile: string): void {
  assertSafeTarListing(readTarListing(tarFile));
}

/** 对已读出的清单做通用校验（供需要复用同一份清单的调用方使用） */
export function assertSafeTarListing(listing: TarListing): void {
  assertSafeListing(listing);
}

/** 通用规则本体：绝对路径 / `..` / 链接条目一律拒收（不限定顶层目录） */
function assertSafeListing({ entries, verboseLines }: TarListing): void {
  for (const raw of entries) {
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
      throw new Error(`快照包含越界条目：${raw}`);
    }
  }
  if (verboseLines.some((line) => /^[lh]/.test(line))) {
    throw new Error('快照包含符号链接或硬链接条目，拒绝还原');
  }
}

function validateTarEntries(snapshotPath: string, expectedRoot: string): void {
  // 清单只读一次：restore 的大包可能上万条目，重复跑 tar -tzf 是白白多一倍 IO。
  const listing = readTarListing(snapshotPath);
  if (listing.entries.length === 0) throw new Error('快照为空');
  // 先过通用规则（越界 / 链接），再加 restore 专属的「必须在 expectedRoot 下」——两级分开，
  // 上传路径只复用第一级，避免把两套语义绑死在同一函数里。
  assertSafeListing(listing);
  for (const raw of listing.entries) {
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
    if (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`)) {
      throw new Error(`快照包含越界条目：${raw}`);
    }
  }
}

/**
 * 解包后复检目录树：符号链接不得指向 root 之外。
 * 供 restore 与第三方上传共用（条目级校验挡不住「先建链接、再沿链接写」的手法，
 * 解包后必须再走一遍真实路径校验）。
 */
export function validateTree(root: string, rootReal: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try { target = fs.realpathSync(absolute); } catch { throw new Error(`快照包含无效符号链接：${absolute}`); }
      if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error(`快照符号链接越界：${absolute}`);
      }
    } else if (entry.isDirectory()) {
      validateTree(absolute, rootReal);
    }
  }
}
