import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
    execFileSync('tar', ['-xzf', snapshotPath, '-C', staging], { stdio: 'ignore' });
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

function validateTarEntries(snapshotPath: string, expectedRoot: string): void {
  let listing: string;
  let verboseListing: string;
  try {
    listing = execFileSync('tar', ['-tzf', snapshotPath], { encoding: 'utf8' });
    // 在解压前拒绝链接条目。仅在 staging 解压后检查 symlink 太晚：恶意
    // archive 可能先创建外链，再让后续条目沿链接写到 staging 外部。
    verboseListing = execFileSync('tar', ['-tvzf', snapshotPath], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`无法读取快照目录清单：${(err as Error).message}`);
  }
  const entries = listing.split('\n').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('快照为空');
  for (const raw of entries) {
    const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
    if (
      normalized === '..'
      || normalized.startsWith('../')
      || normalized.startsWith('/')
      || (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`))
    ) {
      throw new Error(`快照包含越界条目：${raw}`);
    }
  }
  if (verboseListing.split('\n').some((line) => /^[lh]/.test(line))) {
    throw new Error('快照包含符号链接或硬链接条目，拒绝还原');
  }
}

function validateTree(root: string, rootReal: string): void {
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
