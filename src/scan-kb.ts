#!/usr/bin/env node
/**
 * scan-kb.ts - 外部知识库扫描与导入
 *
 * 子命令:
 *   scan      （兼容存量流程）输出待 AI 处理的文件列表，或合并 AI 返回结果
 *   import    （S-04）一条命令完成 AI 结果 → 向量化 → Group 树 → 元数据写入
 *   import --mode incremental（S-06）增量导入：add / modify / delete
 *   diff      （S-05）对比 source.commit..HEAD 输出变更文件列表
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ensureScopeDir, readJson, writeJson } from './lib/store.js';
import { getKbDir, getScanIndexPath, validateScope } from './lib/scope.js';
import { walWrite } from './lib/wal.js';
import { CURRENT_DATA_VERSION } from './lib/constants.js';

import { handleImport } from './lib/import.js';
import { handleIncremental } from './lib/incremental.js';
import { handleDiff } from './lib/diff.js';
import { loadConfig } from './lib/config.js';
import { autoBackup } from './lib/backup.js';
import { closeEngine } from './lib/vector-client.js';

const MAX_SCAN_FILE_SIZE = 10 * 1024 * 1024;

interface ScanIndexEntry {
  path: string;
  fullPath: string;
  summary: string;
  keywords: string[];
  enriched: boolean;
  vectorized: boolean;
  memoryId: string | null;
}

interface ScanIndex {
  version: number;
  scope: string;
  rootName: string;
  sourceDir: string;
  lastScannedCommit: string | null;
  scannedAt: string;
  entries: ScanIndexEntry[];
  stats: {
    total: number;
    scanned: number;
    enriched: number;
    vectorized: number;
  };
  updatedAt?: string | null;
}

interface PendingFile {
  path: string;
  filename: string;
  dir: string;
  changeType: 'A' | 'M';
  needsEnrichment: boolean;
  content: string | null;
  previousMemoryId?: string | null;
}

interface PendingDeleted {
  path: string;
  memoryId: string | null;
  fullPath: string;
}

interface ScanPending {
  scope: string;
  rootName: string;
  sourceDir: string;
  mode: 'full' | 'incremental';
  lastScannedCommit: string | null;
  currentCommit: string | null;
  files: PendingFile[];
  deleted: PendingDeleted[];
}

interface ScanResultEntry {
  path: string;
  summary: string;
  keywords: string[];
  enriched?: boolean;
  replaces?: string;
}

interface ScanResults {
  entries: ScanResultEntry[];
}

interface VectorizeCompleteEntry {
  path: string;
  memoryId: string;
}

interface VectorizeCompletePayload {
  entries: VectorizeCompleteEntry[];
}

interface FileEntry {
  absPath: string;
  relativePath: string;
  size: number;
}

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(result: Record<string, unknown>): never {
  output({ ok: false, ...result });
  process.exit(1);
}

function buildSourceDirError(sourceDir: string): Record<string, unknown> {
  return {
    error: `source 目录不存在或不是目录：${sourceDir}`,
    hint: '`--source` 需要传外部 Markdown 知识库的根目录，而不是 `knowledge-index/kb/{scope}` 这样的运行时数据目录。',
    next_step: [
      '1. 检查传入路径是否真实存在，并确认它是一个目录',
      '2. 确认该目录下包含待扫描的 `.md` 文件',
      '3. 重新执行：npx jiti scripts/scan-kb.ts scan --scope <scope> --source <dir> --root-name <name>',
    ],
    possible_causes: [
      '路径写错，或目录尚未创建',
      '把 `kb/{scope}` 误当成 `--source` 传入',
      '传入的是单个文件路径而不是目录路径',
    ],
  };
}

function buildMissingPendingError(scope: string, pendingPath: string): Record<string, unknown> {
  return {
    error: `scan-pending.json 不存在：${pendingPath}`,
    hint: '`scan --results` 只能合并已经准备好的待处理列表。请先执行一次不带 `--results` 的 `scan`，生成 `scan-pending.json` 后再重试。',
    next_step: [
      `1. 先执行：npx jiti scripts/scan-kb.ts scan --scope ${scope} --source <dir> --root-name <name>`,
      `2. 再执行：npx jiti scripts/scan-kb.ts scan --scope ${scope} --source <dir> --root-name <name> --results <ai-results.json>`,
    ],
    possible_causes: [
      '还没有执行第一步扫描准备，只直接执行了 `scan --results`',
      '之前生成的 `scan-pending.json` 已被删除或清理',
      '这次使用的 `--scope` 与上一次扫描准备时不一致',
    ],
  };
}

function buildMissingResultsFileError(resultsFile: string): Record<string, unknown> {
  return {
    error: `results 文件不存在：${resultsFile}`,
    hint: '`--results` 需要传 AI 生成的结果 JSON 文件路径。该文件至少应包含 `entries` 数组，每一项含 `path`、`summary`、`keywords`。',
    example: {
      entries: [
        {
          path: 'docs/api.md',
          summary: 'API 文档摘要',
          keywords: ['API', '接口', '认证'],
          enriched: false,
        },
      ],
    },
    next_step: [
      '1. 确认 AI 结果文件已经生成到本地',
      '2. 检查 `--results` 传入的是正确的 JSON 文件路径',
      '3. 修正后重新执行 `scan --results`',
    ],
  };
}

function buildMissingScanIndexError(scope: string, target: string, currentCommand: string): Record<string, unknown> {
  const defaultPath = getScanIndexPath(scope);
  const possibleCauses = [
    '只执行了 `scan` 生成 `scan-pending.json`，但还没有执行 `scan --results` 合并摘要结果',
    '`scan-index.json` 被删除，或者当前 `--scope` 与之前生成索引时不一致',
  ];

  if (target !== defaultPath) {
    possibleCauses.push('你在扫描阶段可能使用了自定义输出路径，因此这里也需要通过 `--scan-index` 指向同一个文件');
  }

  return {
    error: `scan-index.json 不存在：${target}`,
    hint: `${currentCommand} 只能读取已有的 \`scan-index.json\`。请先执行 \`scan --results\` 合并 AI 摘要结果，生成扫描索引后再重试。`,
    next_step: [
      `1. 先执行：npx jiti scripts/scan-kb.ts scan --scope ${scope} --source <dir> --root-name <name>`,
      `2. 再执行：npx jiti scripts/scan-kb.ts scan --scope ${scope} --source <dir> --root-name <name> --results <ai-results.json>`,
      `3. 最后执行：${currentCommand}`,
    ],
    possible_causes: possibleCauses,
  };
}

function buildMissingCompleteFileError(completeFile: string): Record<string, unknown> {
  return {
    error: `complete 文件不存在：${completeFile}`,
    hint: '`--complete` 需要传入向量化完成结果文件，用来回写每个条目的 `memoryId` 与完成状态。',
    example: {
      entries: [
        {
          path: 'docs/api.md',
          memoryId: 'mem_xxx',
        },
      ],
    },
    next_step: [
      '1. 先完成摘要向量化，并整理出结果 JSON',
      '2. 确认 `--complete` 指向正确的文件路径',
      '3. 重新执行 `vectorize --complete` 完成回写',
    ],
  };
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function buildFullPath(rootName: string, relativePath: string): string {
  const dirName = path.posix.dirname(relativePath);
  const relationName = stripMarkdownExtension(path.posix.basename(relativePath));
  return dirName === '.' ? `${rootName}/${relationName}` : `${rootName}/${dirName}/${relationName}`;
}

function getPendingPath(scope: string): string {
  return path.join(getKbDir(scope), 'scan-pending.json');
}

function normalizeScanIndex(
  scope: string,
  rootName: string,
  sourceDir: string,
  data?: ScanIndex | null
): ScanIndex {
  if (data) {
    return {
      ...data,
      scope,
      rootName: data.rootName || rootName,
      sourceDir: data.sourceDir || sourceDir,
      entries: Array.isArray(data.entries) ? data.entries : [],
      stats: data.stats || { total: 0, scanned: 0, enriched: 0, vectorized: 0 },
      lastScannedCommit: data.lastScannedCommit ?? null,
      scannedAt: data.scannedAt || new Date().toISOString(),
    };
  }

  return {
    version: CURRENT_DATA_VERSION,
    scope,
    rootName,
    sourceDir,
    lastScannedCommit: null,
    scannedAt: new Date().toISOString(),
    entries: [],
    stats: {
      total: 0,
      scanned: 0,
      enriched: 0,
      vectorized: 0,
    },
  };
}

function walkMarkdownFiles(dir: string, rootDir: string = dir): FileEntry[] {
  const results: FileEntry[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // 防御软链接造成的潜在环路与逻辑不一致
    if (entry.isSymbolicLink()) continue;

    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(absPath, rootDir));
      continue;
    }

    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;

    const stat = fs.statSync(absPath);
    if (stat.size > MAX_SCAN_FILE_SIZE) continue;
    // 跳过空 .md 文件
    if (stat.size === 0) continue;

    results.push({
      absPath,
      relativePath: toPosix(path.relative(rootDir, absPath)),
      size: stat.size,
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function getGitInfo(sourceDir: string): { repoRoot: string; head: string } | null {
  try {
    const repoRoot = execFileSync('git', ['-C', sourceDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const head = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { repoRoot, head };
  } catch {
    return null;
  }
}

function buildFullScanPending(
  scope: string,
  sourceDir: string,
  rootName: string,
  currentCommit: string | null
): { pending: ScanPending; changes: Record<string, number>; totalFiles: number } {
  const files = walkMarkdownFiles(sourceDir);
  const pendingFiles: PendingFile[] = files.map((file) => ({
    path: file.relativePath,
    filename: stripMarkdownExtension(path.posix.basename(file.relativePath)),
    dir: path.posix.dirname(file.relativePath) === '.' ? '' : path.posix.dirname(file.relativePath),
    changeType: 'A',
    needsEnrichment: false,
    content: null,
  }));

  return {
    pending: {
      scope,
      rootName,
      sourceDir,
      mode: 'full',
      lastScannedCommit: null,
      currentCommit,
      files: pendingFiles,
      deleted: [],
    },
    changes: {
      added: pendingFiles.length,
      modified: 0,
      deleted: 0,
      unchanged: 0,
    },
    totalFiles: pendingFiles.length,
  };
}

function buildIncrementalPending(
  sourceDir: string,
  rootName: string,
  existing: ScanIndex,
  gitInfo: { repoRoot: string; head: string }
): { pending: ScanPending; changes: Record<string, number>; totalFiles: number } | null {
  if (!existing.lastScannedCommit) return null;

  try {
    const relativeSource = toPosix(path.relative(gitInfo.repoRoot, fs.realpathSync(sourceDir))) || '.';
    const raw = execFileSync(
      'git',
      ['-C', gitInfo.repoRoot, 'diff', '--name-status', existing.lastScannedCommit, gitInfo.head, '--', relativeSource],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    const currentFiles = walkMarkdownFiles(sourceDir);
    const currentFileSet = new Set(currentFiles.map((file) => file.relativePath));
    const existingEntryMap = new Map(existing.entries.map((entry) => [entry.path, entry]));
    const pendingFiles: PendingFile[] = [];
    const deletedFiles: PendingDeleted[] = [];
    let added = 0;
    let modified = 0;
    let deleted = 0;

    // 把 repo 内绝对/相对路径转换为相对 sourceDir 的 posix 路径，越界返回 null
    // 使用 realpathSync 解决 macOS /var vs /private/var 符号链接导致 path.relative 失败的问题
    const resolvedSource = fs.realpathSync(sourceDir);
    const toSourceRel = (changedPath: string): string | null => {
      const rel = toPosix(path.relative(resolvedSource, path.join(gitInfo.repoRoot, changedPath)));
      if (rel.startsWith('..')) return null;
      return rel;
    };

    const lines = raw ? raw.split(/\r?\n/) : [];
    for (const line of lines) {
      if (!line) continue;
      const cols = line.split(/\t+/);
      const statusRaw = cols[0];
      if (!statusRaw) continue;

      const statusChar = statusRaw.charAt(0);

      // R/C：重命名/复制，三列：R<score>\t<old>\t<new>
      if (statusChar === 'R' || statusChar === 'C') {
        const oldChanged = cols[1];
        const newChanged = cols[2];
        if (!oldChanged || !newChanged) continue;

        const oldRel = toSourceRel(oldChanged);
        const newRel = toSourceRel(newChanged);

        // 旧文件如果在 source 范围内且是 .md，则视为删除（但仅 R 才删除，C 是复制不删除）
        if (statusChar === 'R' && oldRel && /\.md$/i.test(oldRel)) {
          const existingEntry = existingEntryMap.get(oldRel);
          deletedFiles.push({
            path: oldRel,
            memoryId: existingEntry?.memoryId ?? null,
            fullPath: existingEntry?.fullPath ?? buildFullPath(rootName, oldRel),
          });
          deleted++;
        }

        // 新文件作为新增加入 pending（前提是仍在 source 中且仍是 md）
        if (newRel && /\.md$/i.test(newRel) && currentFileSet.has(newRel)) {
          const existingEntry = existingEntryMap.get(newRel);
          pendingFiles.push({
            path: newRel,
            filename: stripMarkdownExtension(path.posix.basename(newRel)),
            dir: path.posix.dirname(newRel) === '.' ? '' : path.posix.dirname(newRel),
            changeType: 'A',
            needsEnrichment: false,
            content: null,
            // 重命名时尝试沿用旧 memoryId，避免向量索引漂移
            previousMemoryId:
              existingEntry?.memoryId ??
              (statusChar === 'R' && oldRel ? existingEntryMap.get(oldRel)?.memoryId ?? null : null),
          });
          added++;
        }
        continue;
      }

      // T（类型变更）当作 M 处理；U（未合并）跳过
      if (statusChar === 'U') continue;

      const changedPathRaw = cols[1];
      if (!changedPathRaw) continue;

      const status = (statusChar === 'A' || statusChar === 'D' ? statusChar : 'M') as 'A' | 'M' | 'D';
      const relativePath = toSourceRel(changedPathRaw);
      if (!relativePath) continue;
      if (!/\.md$/i.test(relativePath)) continue;

      if (status === 'D') {
        const existingEntry = existingEntryMap.get(relativePath);
        deletedFiles.push({
          path: relativePath,
          memoryId: existingEntry?.memoryId ?? null,
          fullPath: existingEntry?.fullPath ?? buildFullPath(rootName, relativePath),
        });
        deleted++;
        continue;
      }

      if (!currentFileSet.has(relativePath)) continue;
      const existingEntry = existingEntryMap.get(relativePath);
      pendingFiles.push({
        path: relativePath,
        filename: stripMarkdownExtension(path.posix.basename(relativePath)),
        dir: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
        changeType: status === 'A' ? 'A' : 'M',
        needsEnrichment: false,
        content: null,
        previousMemoryId: existingEntry?.memoryId ?? null,
      });

      if (status === 'A') added++;
      if (status === 'M') modified++;
    }

    return {
      pending: {
        scope: existing.scope,
        rootName,
        sourceDir,
        mode: 'incremental',
        lastScannedCommit: existing.lastScannedCommit,
        currentCommit: gitInfo.head,
        files: pendingFiles,
        deleted: deletedFiles,
      },
      changes: {
        added,
        modified,
        deleted,
        unchanged: Math.max(0, currentFiles.length - added - modified),
      },
      totalFiles: currentFiles.length,
    };
  } catch {
    return null;
  }
}

function refreshStats(index: ScanIndex): void {
  index.stats = {
    total: index.entries.length,
    scanned: index.entries.length,
    enriched: index.entries.filter((entry) => entry.enriched).length,
    vectorized: index.entries.filter((entry) => entry.vectorized).length,
  };
}

function handleScanPrepare(scope: string, sourceDir: string, rootName: string, outputFile?: string): void {
  const gitInfo = getGitInfo(sourceDir);
  const scanIndexPath = outputFile ? path.resolve(outputFile) : getScanIndexPath(scope);
  const existing = readJson<ScanIndex>(scanIndexPath);
  const normalized = normalizeScanIndex(scope, rootName, sourceDir, existing);

  let prepared = gitInfo && normalized.lastScannedCommit
    ? buildIncrementalPending(sourceDir, rootName, normalized, gitInfo)
    : null;

  if (!prepared) {
    if (!gitInfo) {
      console.warn('警告：无法获取 Git 信息，退化为全量扫描');
    } else if (existing && !normalized.lastScannedCommit) {
      console.warn('警告：lastScannedCommit 不存在（可能为 rebase 后），退化为全量扫描');
    } else if (!existing) {
      // 首次扫描，正常行为
    } else {
      console.warn('警告：增量扫描失败，退化为全量扫描');
    }
    prepared = buildFullScanPending(scope, sourceDir, rootName, gitInfo?.head ?? null);
  }

  const pendingPath = getPendingPath(scope);
  walWrite(pendingPath, prepared.pending);

  output({
    ok: true,
    action: 'scan_files',
    root_name: rootName,
    mode: prepared.pending.mode,
    changes: prepared.changes,
    total_files: prepared.totalFiles,
    pending_file: pendingPath,
    output: scanIndexPath,
  });
}

function handleScanMerge(scope: string, sourceDir: string, rootName: string, resultsFile: string, outputFile?: string): void {
  const pendingPath = getPendingPath(scope);
  if (!fs.existsSync(pendingPath)) {
    fail(buildMissingPendingError(scope, pendingPath));
  }

  if (!fs.existsSync(resultsFile)) {
    fail(buildMissingResultsFileError(resultsFile));
  }

  const scanIndexPath = outputFile ? path.resolve(outputFile) : getScanIndexPath(scope);
  const existing = readJson<ScanIndex>(scanIndexPath);
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as ScanPending;
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8')) as ScanResults;
  const nextIndex = normalizeScanIndex(scope, pending.rootName || rootName, sourceDir, existing);
  const entryMap = new Map(nextIndex.entries.map((entry) => [entry.path, entry]));
  const pendingMap = new Map(pending.files.map((file) => [file.path, file]));

  for (const deletedItem of pending.deleted || []) {
    entryMap.delete(deletedItem.path);
  }

  for (const result of results.entries || []) {
    const pendingFile = pendingMap.get(result.path);
    const previous = entryMap.get(result.path);
    const memoryId = previous?.memoryId ?? pendingFile?.previousMemoryId ?? result.replaces ?? null;

    entryMap.set(result.path, {
      path: result.path,
      fullPath: previous?.fullPath || buildFullPath(nextIndex.rootName, result.path),
      summary: result.summary,
      keywords: [...new Set((result.keywords || []).map((item) => item.trim()).filter(Boolean))],
      enriched: Boolean(result.enriched),
      vectorized: false,
      memoryId,
    });
  }

  nextIndex.entries = [...entryMap.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  nextIndex.lastScannedCommit = pending.currentCommit ?? nextIndex.lastScannedCommit ?? null;
  nextIndex.scannedAt = new Date().toISOString();
  nextIndex.rootName = pending.rootName || nextIndex.rootName;
  nextIndex.sourceDir = pending.sourceDir || nextIndex.sourceDir;
  refreshStats(nextIndex);
  writeJson(scanIndexPath, nextIndex as unknown as Record<string, unknown>);

  output({
    ok: true,
    action: 'merge_results',
    merged: (results.entries || []).length,
    deleted: (pending.deleted || []).length,
    total_entries: nextIndex.entries.length,
    output: scanIndexPath,
  });
}

function formatVectorizeContent(entry: ScanIndexEntry): string {
  return `[摘要] ${entry.summary}\n[路径] ${entry.path}\n[关键词] ${(entry.keywords || []).join(', ')}`;
}

function handleVectorizeList(scope: string, scanIndexFile?: string): void {
  const target = scanIndexFile ? path.resolve(scanIndexFile) : getScanIndexPath(scope);
  const scanIndex = readJson<ScanIndex>(target);
  if (!scanIndex) {
    const command = scanIndexFile
      ? `npx jiti scripts/scan-kb.ts vectorize --scope ${scope} --scan-index ${path.resolve(scanIndexFile)}`
      : `npx jiti scripts/scan-kb.ts vectorize --scope ${scope}`;
    fail(buildMissingScanIndexError(scope, target, command));
  }

  const entries = scanIndex.entries
    .filter((entry) => !entry.vectorized)
    .map((entry) => ({
      path: entry.path,
      summary: entry.summary,
      keywords: entry.keywords,
      memoryId: entry.memoryId,
      content: formatVectorizeContent(entry),
    }));

  output({
    ok: true,
    action: 'list_pending',
    pending: entries.length,
    entries,
  });
}

function handleVectorizeComplete(scope: string, completeFile: string, scanIndexFile?: string): void {
  if (!fs.existsSync(completeFile)) {
    fail(buildMissingCompleteFileError(completeFile));
  }

  const target = scanIndexFile ? path.resolve(scanIndexFile) : getScanIndexPath(scope);
  const scanIndex = readJson<ScanIndex>(target);
  if (!scanIndex) {
    const command = scanIndexFile
      ? `npx jiti scripts/scan-kb.ts vectorize --scope ${scope} --scan-index ${path.resolve(scanIndexFile)} --complete ${completeFile}`
      : `npx jiti scripts/scan-kb.ts vectorize --scope ${scope} --complete ${completeFile}`;
    fail(buildMissingScanIndexError(scope, target, command));
  }

  const payload = JSON.parse(fs.readFileSync(completeFile, 'utf-8')) as VectorizeCompletePayload;
  const errors: string[] = [];
  let vectorized = 0;
  let updated = 0;

  for (const item of payload.entries || []) {
    const entry = scanIndex.entries.find((candidate) => candidate.path === item.path);
    if (!entry) {
      errors.push(`未找到条目：${item.path}`);
      continue;
    }
    if (!item.memoryId?.trim()) {
      errors.push(`memoryId 不能为空：${item.path}`);
      continue;
    }

    if (entry.memoryId) {
      updated++;
    } else {
      vectorized++;
    }

    entry.memoryId = item.memoryId.trim();
    entry.vectorized = true;
  }

  scanIndex.scannedAt = new Date().toISOString();
  refreshStats(scanIndex);
  writeJson(target, scanIndex as unknown as Record<string, unknown>);

  output({
    ok: true,
    action: 'mark_complete',
    vectorized,
    updated,
    errors,
  });
}

const program = new Command();

program
  .name('scan-kb')
  .description('外部知识库扫描与导入：scan / import / diff');

program
  .command('scan')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--source <sourceDir>', '外部知识库根目录路径')
  .requiredOption('--root-name <rootName>', '导入根节点名称')
  .option('--output <outputFile>', 'scan-index.json 输出路径')
  .option('--results <resultsFile>', 'AI 返回结果 JSON 文件路径')
  .action((opts) => {
    try {
      const scope = String(opts.scope);
      const sourceDir = path.resolve(String(opts.source));
      const rootName = String(opts.rootName).trim();
      const outputFile = opts.output ? String(opts.output) : undefined;
      const resultsFile = opts.results ? path.resolve(String(opts.results)) : undefined;

      validateScope(scope);
      ensureScopeDir(scope);

      if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        fail(buildSourceDirError(sourceDir));
      }

      if (!rootName) {
        output({ ok: false, error: 'root-name 不能为空' });
        process.exit(1);
      }

      if (resultsFile) {
        handleScanMerge(scope, sourceDir, rootName, resultsFile, outputFile);
        return;
      }

      handleScanPrepare(scope, sourceDir, rootName, outputFile);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program
  .command('vectorize')
  .description('[DEPRECATED] 已被 `scan-kb import` 取代，保留仅为兼容存量流程，将在后续版本删除。')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .option('--scan-index <scanIndexFile>', '扫描索引文件路径')
  .option('--complete <completeFile>', '完成向量化结果文件')
  .action((opts) => {
    try {
      const scope = String(opts.scope);
      const scanIndexFile = opts.scanIndex ? String(opts.scanIndex) : undefined;
      const completeFile = opts.complete ? path.resolve(String(opts.complete)) : undefined;

      validateScope(scope);
      ensureScopeDir(scope);

      console.warn('[deprecated] `scan-kb vectorize` 已废弃，建议使用 `scan-kb import --results <ai-results.json>` 一步完成。');

      if (completeFile) {
        handleVectorizeComplete(scope, completeFile, scanIndexFile);
        return;
      }

      handleVectorizeList(scope, scanIndexFile);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

// ─── S-04 / S-06：统一导入命令 ────────────────────────────────────────

program
  .command('import')
  .description('一条命令完成：AI 结果校验 → 批量向量化 → Group 树创建 → 元数据写入 → source 块记录')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--results <resultsFile>', 'AI 输出的 ai-results.json 路径（含 meta + entries）')
  .option('--mode <mode>', '导入模式：full | incremental（默认 full）', 'full')
  .option('--source-dir <sourceDir>', '强制覆盖 ai-results.meta.sourceDir（一般无需传）')
  .option('--root-name <rootName>', '强制覆盖 ai-results.meta.rootName（一般无需传）')
  .option('--mapping <mappingFile>', 'mapping 配置文件路径（覆盖 groupPath / relation）')
  .action(async (opts) => {
    try {
      const scope = String(opts.scope);
      const resultsFile = path.resolve(String(opts.results));
      const mode = String(opts.mode || 'full');
      const sourceDirOverride = opts.sourceDir ? path.resolve(String(opts.sourceDir)) : undefined;
      const rootNameOverride = opts.rootName ? String(opts.rootName).trim() : undefined;
      const mappingFile = opts.mapping ? path.resolve(String(opts.mapping)) : undefined;

      validateScope(scope);

      if (mode !== 'full' && mode !== 'incremental') {
        output({ ok: false, error: `未知 --mode: ${mode}（应为 full | incremental）` });
        process.exit(1);
      }

      const result = mode === 'full'
        ? await handleImport({
            scope,
            resultsFile,
            sourceDirOverride,
            rootNameOverride,
            mappingFile,
          })
        : await handleIncremental({
            scope,
            resultsFile,
            sourceDirOverride,
            rootNameOverride,
            mappingFile,
          });

      // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则 worker 线程持引用导致进程无法退出
      await closeEngine();

      output(result as unknown as Record<string, unknown>);
      // 自动备份（失败不阻断）
      try {
        const config = loadConfig();
        const backupResult = autoBackup(config, scope, resultsFile, mode as 'full' | 'incremental');
        if (backupResult.ok) {
          process.stderr.write(`自动备份完成：${backupResult.snapshotBackup ?? ''}\n`);
        }
      } catch (backupErr) {
        process.stderr.write(`警告：自动备份失败 — ${(backupErr as Error).message}\n`);
      }
    } catch (err) {
      await closeEngine();
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

// ─── S-05：增量 diff ──────────────────────────────────────────────────

program
  .command('diff')
  .description('对比 group-index.source.commit 与 HEAD，输出变更文件列表（含 memoryId 关联）')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .option('--output <outputFile>', '将结果写入指定文件（默认仅 stdout）')
  .action((opts) => {
    try {
      const scope = String(opts.scope);
      const outputFile = opts.output ? path.resolve(String(opts.output)) : undefined;
      validateScope(scope);

      const result = handleDiff({ scope, outputFile });
      const json = JSON.stringify(result, null, 2);
      if (outputFile) {
        fs.writeFileSync(outputFile, json + '\n', 'utf-8');
      }
      console.log(json);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();