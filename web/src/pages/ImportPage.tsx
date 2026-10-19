/**
 * ImportPage.tsx —— 上传导入（对齐 v2 demo P3：双栏——主表单 ｜ 当前任务轨 380px）
 *
 * 明确选择本次目标 Scope → 选文件/目录 → 分批 upload（最后一批启动导入）→ 轮询 status → 进度/结果
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useScopeValue } from '@/lib/scopeContext';
import { getTasks, activeImportCount } from '@/api/tasksApi';
import { getImportConfig, getImportStatus, getImportUploadStatus, uploadFiles, fetchTags, cancelImport, runImport, preflightImport, type ImportConfigResponse, type ImportJob, type ImportConflictMode, type ImportPreflightDuplicate } from '@/api/httpApi';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { ScopePathSelect } from '@/components/ScopePathSelect';
import { Icon } from '@/components/icons';
import { groupError, scopeError, tagError } from '@/lib/validators';
import {
  activePercentOf,
  busyPhaseLabelOf,
  errorStatusOf,
  isBusyPhase,
  isCancelledTrack,
  trackLabelOf,
  trackToneOf,
  type ImportFailureStage,
  type ImportPhase,
} from '@/lib/importPhase';

/**
 * 「同名文档处理」的默认策略。
 *
 * 需求来源：`REQ-2026-10-10-导入路径口径对齐与增量导入` R3 ——「增量导入」
 * 要「列为下拉第一项**且为默认值**」。后端/CLI 早已是这个默认
 * （`src/lib/import-conflict.ts` 的 `DEFAULT_IMPORT_CONFLICT_MODE`、`docs/import.md`），
 * 但前端初始 `useState` 自 2026-09-20（c80c64c）起一直是 `'suffix'` 没跟着改 ——
 * 于是出现「终态复位回到 incremental、刷新又变回 suffix」的不一致。
 * 抽成常量：初始值与终态复位共用一处，避免再次各自演化。
 */
const DEFAULT_CONFLICT_MODE: ImportConflictMode = 'incremental';

interface PendingFile {
  name: string;
  size: number;
  /** File 引用缓存（上传时读取内容） */
  file: File;
  kind: 'document' | 'asset';
}

interface RawPendingFile {
  name: string;
  size: number;
  file: File;
}

interface PendingSelection {
  id: string;
  kind: 'file' | 'directory';
  name: string;
  files: PendingFile[];
  scannedFiles: number;
  skippedFiles: number;
  skippedBytes: number;
}

interface UploadPlan {
  scope: string;
  finalize: {
    group?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    vector: boolean;
    tags?: string;
    conflictMode: ImportConflictMode;
    conflictSuffix?: string;
  };
  selectionSnapshot: PendingSelection[];
  batches: PendingFile[][];
  nextBatch: number;
  currentBatch: number;
  uploadId: string;
  uploadedFiles: number;
  totalFiles: number;
  totalBytes: number;
}

interface UploadStats {
  batch: number;
  totalBatches: number;
  filesDone: number;
  totalFiles: number;
  bytesDone: number;
  totalBytes: number;
}

const FALLBACK_IMPORT_CONFIG: ImportConfigResponse = {
  ok: true,
  scope: '',
  extensions: ['.md'],
  maxFileSize: 1024 * 1024,
  assets: true,
  assetExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif'],
  maxAssetSize: 5 * 1024 * 1024,
  maxRequestBody: 16 * 1024 * 1024,
};

const MAX_UPLOAD_BATCH_FILES = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function conflictSuffixError(value: string): string | null {
  const count = value.split('{n}').length - 1;
  if (!value.trim() || count !== 1) return '后缀模板必须包含且只能包含一个 {n}';
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return '后缀模板不能包含 /、\\ 或 ..';
  return null;
}

/**
 * R1（REQ-20261010-001）：剥离被选目录的顶层段，让 Web 与 CLI 的 `sourcePath` / 组落点口径一致。
 *
 * 目录导入（拖拽 / 目录选择器 / webkitdirectory 回退）的相对路径形如 `<目录名>/a/b.md`，
 * 而 CLI `ki import --source <目录>` 是相对该目录内部（`a/b.md`）——不剥离会让"同一目录
 * 二次导入"被当成全新文档（实测：scope ai-docs 文档从 1859 翻倍到 3741）。
 * 「选择文件」的 name 只有文件名（无 `/`），原样返回。
 *
 * 剥离点在上传载荷构造处（见 continueUpload）：扫描分组、附件相对引用解析仍用带目录名的
 * 原始 name，只有发给后端的 rel 变扁平。
 */
function stripTopSegment(name: string): string {
  const normalized = name.replaceAll('\\', '/');
  const slash = normalized.indexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

function normalizeRelativePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function normalizeAssetReference(raw: string): string | null {
  let value = raw.trim().replace(/\s+["'][^"']*["']\s*$/, '');
  const angled = /^<([\s\S]*)>$/.exec(value);
  if (angled) value = angled[1].trim();
  value = value.replace(/#.*$/, '');
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('#')) return null;
  try { value = decodeURIComponent(value); } catch { /* 使用原始路径 */ }
  return value;
}

function extractLocalAssetRefs(markdown: string): string[] {
  const refs: string[] = [];
  const collect = (text: string): void => {
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const ref = normalizeAssetReference(match[1]);
      if (ref) refs.push(ref);
    }
    for (const match of text.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)["']?/gi)) {
      const ref = normalizeAssetReference(match[1]);
      if (ref) refs.push(ref);
    }
  };
  let inFence = false;
  let segment: string[] = [];
  const flush = (): void => {
    if (segment.length > 0) collect(segment.join('\n'));
    segment = [];
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
    } else if (!inFence) {
      segment.push(line);
    }
  }
  flush();
  return refs;
}

function toUploadBatches(files: PendingFile[], maxRequestBody: number): PendingFile[][] {
  // JSON + Base64 会放大体积；保留后端 16MB 上限的一半作为安全余量。
  const targetBytes = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Math.floor(maxRequestBody * 0.5)));
  const batches: PendingFile[][] = [];
  let current: PendingFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const estimatedBytes = Math.ceil(file.size / 3) * 4 + file.name.length + 128;
    if (current.length > 0 && (current.length >= MAX_UPLOAD_BATCH_FILES || currentBytes + estimatedBytes > targetBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += estimatedBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function classifyPendingFiles(
  candidates: RawPendingFile[],
  policy: ImportConfigResponse,
  onProgress: (message: string) => void,
  yieldToBrowser: () => Promise<void>,
): Promise<{
  included: PendingFile[];
  stats: Map<string, { scannedFiles: number; skippedFiles: number; skippedBytes: number }>;
}> {
  const allowedDocs = new Set(policy.extensions.map((extension) => extension.toLowerCase()));
  const allowedAssets = new Set(policy.assetExtensions.map((extension) => extension.toLowerCase()));
  const docCandidates = candidates.filter((candidate) => allowedDocs.has(fileExtension(candidate.name)));
  const assetCandidates = candidates.filter((candidate) => allowedAssets.has(fileExtension(candidate.name)));
  const assetPaths = new Map<string, RawPendingFile>();
  for (const candidate of assetCandidates) assetPaths.set(normalizeRelativePath(candidate.name), candidate);

  const referencedAssets = new Set<RawPendingFile>();
  if (policy.assets && assetCandidates.length > 0) {
    for (const [index, document] of docCandidates.entries()) {
      const markdown = await document.file.text();
      const documentDir = document.name.includes('/') ? document.name.slice(0, document.name.lastIndexOf('/')) : '';
      for (const ref of extractLocalAssetRefs(markdown)) {
        const asset = assetPaths.get(normalizeRelativePath(`${documentDir}/${ref}`));
        if (asset && allowedAssets.has(fileExtension(asset.name))) referencedAssets.add(asset);
      }
      if ((index + 1) % 20 === 0) {
        onProgress(`正在分析 Markdown 引用 ${index + 1}/${docCandidates.length}…`);
        await yieldToBrowser();
      }
    }
  }

  const stats = new Map<string, { scannedFiles: number; skippedFiles: number; skippedBytes: number }>();
  const included: PendingFile[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const topDirectory = candidate.name.split('/').filter(Boolean)[0];
    const statKey = topDirectory || '__standalone__';
    const current = stats.get(statKey) ?? { scannedFiles: 0, skippedFiles: 0, skippedBytes: 0 };
    current.scannedFiles += 1;
    const kind = allowedDocs.has(fileExtension(candidate.name))
      ? 'document'
      : (policy.assets && referencedAssets.has(candidate) ? 'asset' : null);
    if (kind) {
      included.push({ ...candidate, kind });
    } else {
      current.skippedFiles += 1;
      current.skippedBytes += candidate.size;
    }
    stats.set(statKey, current);
    if ((index + 1) % 100 === 0) {
      onProgress(`正在筛选文件 ${index + 1}/${candidates.length}…`);
      await yieldToBrowser();
    }
  }
  return { included, stats };
}

function buildSelections(
  included: PendingFile[],
  stats: Map<string, { scannedFiles: number; skippedFiles: number; skippedBytes: number }>,
): Omit<PendingSelection, 'id'>[] {
  const directories = new Map<string, PendingFile[]>();
  const standalone: PendingFile[] = [];
  for (const file of included) {
    const topDirectory = file.name.split('/').filter(Boolean)[0];
    if (topDirectory && file.name.includes('/')) {
      const group = directories.get(topDirectory) ?? [];
      group.push(file);
      directories.set(topDirectory, group);
    } else {
      standalone.push(file);
    }
  }
  return [
    ...[...directories.entries()].map(([name, files]) => ({
      kind: 'directory' as const,
      name,
      files,
      ...(stats.get(name) ?? { scannedFiles: files.length, skippedFiles: 0, skippedBytes: 0 }),
    })),
    ...standalone.map((file) => ({
      kind: 'file' as const,
      name: file.name,
      files: [file],
      scannedFiles: 1,
      skippedFiles: 0,
      skippedBytes: 0,
    })),
  ];
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
  createReader?: () => FileSystemDirectoryReaderLike;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (error: DOMException) => void,
  ) => void;
}

interface FileSystemHandleLike {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterableIterator<FileSystemHandleLike>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: () => Promise<FileSystemHandleLike>;
}

interface DataTransferItemWithEntry {
  getAsFile: DataTransferItem['getAsFile'];
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

export interface ImportTaskSummary {
  /** 阶段与呈现口径见 `lib/importPhase.ts`（那里是唯一权威，本页只消费） */
  phase: ImportPhase;
  scope: string;
  text: string;
}

const LAST_IMPORT_JOB_KEY = 'ki-last-import-job';

interface ImportCredential {
  uploadId?: string;
  jobId?: string;
  scope?: string;
}

function readImportCredential(): ImportCredential | null {
  try {
    const saved = localStorage.getItem(LAST_IMPORT_JOB_KEY);
    // 浏览器拒绝本地存储或内容不是 JSON 时，按"无待恢复任务"处理。
    return saved ? (JSON.parse(saved) as ImportCredential) : null;
  } catch {
    return null;
  }
}

/** 只清除仍属于本次任务的凭据：迟到的恢复流程不得误删用户新发起任务的凭据。 */
function clearImportCredentialIf(owner: { uploadId?: string; jobId?: string }): void {
  const current = readImportCredential();
  if (!current) return;
  /**
   * 两个 owner 都为空 = 无法判定归属（典型：终态清理时 `uploadPlanRef` 与 `job` 都已被置空）。
   * 此时**不能**无条件删除 —— localStorage 是单槽共享的，另一标签页可能在跑自己的任务。
   */
  if (owner.uploadId === undefined && owner.jobId === undefined) return;
  if (owner.uploadId !== undefined && current.uploadId !== owner.uploadId) return;
  if (owner.jobId !== undefined && current.jobId !== owner.jobId) return;
  try {
    localStorage.removeItem(LAST_IMPORT_JOB_KEY);
  } catch {
    /* ignore */
  }
}

export function ImportPage({ onTaskChange }: { onTaskChange?: (task: ImportTaskSummary | null) => void }): JSX.Element {
  const currentScope = useScopeValue();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState('');
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 「开始导入」被阻塞时的引导目标：未确认 Scope → Scope 区；未选文件 → 拖拽区 */
  const scopeFieldRef = useRef<HTMLDivElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState<'scope' | 'files' | null>(null);
  /** 「新建 Scope」模式下未回车确认的草稿；非空且与已确认 scope 不同 → 禁止静默按旧 scope 导入 */
  const [scopeDraft, setScopeDraft] = useState('');
  /**
   * 表单代际：离开导入页再回来时自增，作为 `ScopePathSelect` 的 key 强制重建。
   * 该组件输入框显示的是内部 `scopeFilter`（非 value），只清父组件的 scope 状态会留下
   * 上一次的 Scope 文本 —— 正是"框里有值但未确认"的误导态来源（Q4，2026-10-10）。
   */
  const [formEpoch, setFormEpoch] = useState(0);
  /**
   * R6：重复导入预检的待确认项（非空 = 上传已完成、导入**尚未开始**，等用户拍板）。
   * 取消即回到 idle，不产生任何写入。
   */
  const [preflightConfirm, setPreflightConfirm] = useState<{ matched: number; scanned: number; duplicates: ImportPreflightDuplicate[]; truncated: boolean } | null>(null);
  /**
   * REQ-20261019-002：面板快照。`launchImport` 进入即清空面板，而
   * `ALL_FILES_DUPLICATES` / 409 参数不一致是**异步**才知道的 —— 没有快照就无法恢复面板，
   * 用户只能重新上传整批（AC15）。
   */
  const preflightSnapshotRef = useRef<{ matched: number; scanned: number; duplicates: ImportPreflightDuplicate[]; truncated: boolean } | null>(null);
  /** 预检明细展开/收起（明细 >5 条时提供入口） */
  const [showAllPreflight, setShowAllPreflight] = useState(false);
  const preflightRef = useRef<HTMLDivElement>(null);
  /** 「结果摘要」卡（完成后「查看结果」入口的滚动目标） */
  const resultCardRef = useRef<HTMLDivElement>(null);

  const [importConfig, setImportConfig] = useState<ImportConfigResponse | null>(null);
  const importConfigOrFallback = importConfig ?? FALLBACK_IMPORT_CONFIG;
  const [selections, setSelections] = useState<PendingSelection[]>([]);
  const selectionSeq = useRef(0);
  const files = selections.flatMap((selection) => selection.files);
  const selectedDocuments = files.filter((file) => file.kind === 'document');
  const selectedAssets = files.filter((file) => file.kind === 'asset');
  /**
   * REQ-20261019-002：「跳过重复文档」的可用性。
   *
   * 判定由**服务端重算**（`run(skipDuplicates=true)`），因此不受预检明细 50 条上限约束——
   * 旧实现用明细反算 `onlyRelPaths`，>50 条重复时整条路不可用；现在 `truncated` 只影响面板展示
   * （meta 会写「另有 N 篇未回传明细」）。
   * 唯一条件是「剔除后仍有文件可导入」——全部重复时禁用按钮并给出**可见**原因。
   */
  const canSkipDuplicates = preflightConfirm !== null && preflightConfirm.scanned > preflightConfirm.matched;
  /** 跳过之后预计导入的文件数（仅展示用；实际以 run 时刻服务端判定为准） */
  const newFileCount = preflightConfirm ? Math.max(0, preflightConfirm.scanned - preflightConfirm.matched) : 0;
  const skippedFiles = selections.reduce((sum, selection) => sum + selection.skippedFiles, 0);
  const skippedBytes = selections.reduce((sum, selection) => sum + selection.skippedBytes, 0);
  const totalSelectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const importPolicy = importConfigOrFallback;
  const [advOpen, setAdvOpen] = useState(false);
  const [chunkSize, setChunkSize] = useState('1000');
  const [chunkOverlap, setChunkOverlap] = useState('150');
  const [vector, setVector] = useState(true);
  const [group, setGroup] = useState('');
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>(DEFAULT_CONFLICT_MODE);
  const [conflictSuffix, setConflictSuffix] = useState('_{n}');
  const [dragOver, setDragOver] = useState(false);

  // tag 选择器状态（复用 WritePage 实现：combobox 选择已有 / 输入新建）
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagInputErr, setTagInputErr] = useState<string | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  // 取消导入（POST /api/import/cancel）的请求状态
  const [cancelState, setCancelState] = useState<'idle' | 'pending' | 'requested' | 'failed'>('idle');
  const [cancelError, setCancelError] = useState('');
  const tagRef = useRef<HTMLDivElement>(null);

  // 实时校验 group（空字符串不报错，避免初次进入显示错误）
  const groupErr = group.trim() ? groupError(group) : null;
  const scopeErr = scopeConfirmed && scope.trim() ? scopeError(scope) : null;
  // 后缀模板只在「自动添加后缀」模式生效：增量导入对同名（含不同来源）**一律覆盖**
  // （用户 2026-10-10 拍板），覆盖/跳过也都不使用后缀
  const suffixInUse = conflictMode === 'suffix';
  const conflictSuffixErr = suffixInUse ? conflictSuffixError(conflictSuffix) : null;

  // 加载可用 tag 列表（当前 scope）
  useEffect(() => {
    let cancelled = false;
    if (!scope) {
      setAvailableTags([]);
      return () => { cancelled = true; };
    }
    fetchTags(scope).then((res) => {
      if (!cancelled && res.ok) setAvailableTags(res.tags.map((t) => t.tag));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    setImportConfig(null);
    if (!scope) return () => { cancelled = true; };
    getImportConfig(scope).then((config) => {
      if (!cancelled) setImportConfig(config);
    }).catch(() => {
      // 配置接口不可用时保留默认 .md 策略，后端仍会做最终校验。
    });
    return () => { cancelled = true; };
  }, [scope]);

  // 点击 tag combobox 外部关闭下拉
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (tagRef.current && !tagRef.current.contains(e.target as Node)) setTagOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const toggleTag = (tag: string): void => {
    // 点击已有 tag：加入选中并关闭下拉（会话级一次性选择，无需反选）
    if (selectedTags.includes(tag)) return;
    setSelectedTags((prev) => [...prev, tag]);
    setTagOpen(false);
  };

  const addTagFromInput = (): void => {
    const t = tagInput.trim().toLowerCase();
    if (!t) { setTagInputErr('Tag 不能为空'); return; }
    const err = tagError(t);
    if (err) { setTagInputErr(err); return; }
    if (selectedTags.includes(t)) { setTagInput(''); setTagInputErr(null); return; }
    setSelectedTags((prev) => [...prev, t]);
    setTagInput('');
    setTagInputErr(null);
    setTagOpen(false);
  };

  const removeTag = (tag: string): void => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  };

  const [phase, setPhase] = useState<ImportPhase>('idle');
  /** 「忙」= 本次任务未结束、不得再发新任务（口径见 `isBusyPhase`） */
  const busyPhase = isBusyPhase(phase);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failureStage, setFailureStage] = useState<ImportFailureStage>(null);
  const [uploadErrors, setUploadErrors] = useState<{ name: string; error: string }[]>([]);
  const [progressText, setProgressText] = useState('');
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
  const [failedUploadBatch, setFailedUploadBatch] = useState<number | null>(null);
  const uploadPlanRef = useRef<UploadPlan | null>(null);
  const startingRef = useRef(false);
  /** 任务代际：用户发起新任务时自增，使在途的恢复流程作废，避免旧任务迟到覆盖新任务状态 */
  const taskGenRef = useRef(0);

  /**
   * R3（REQ-20261009-001）：离开导入页再回来时清空「本批暂存」。
   *
   * 本页在 AppShell 常驻（`display:none` 隐藏而非卸载），此前切走再切回会保留上一批的
   * 文件选择 / 上传统计 / 错误卡 / 进度文案（用户反馈"上传导入中的数据没有清空"）。
   * 边界（已与用户确认）：**在途任务不打断**——scanning / uploading / awaiting-confirm /
   * importing / unknown 原样保留（进度继续、可继续查看）；只有回到 idle / done / failed /
   * cancelled 这类终态时才清空。
   * Q4（2026-10-10 用户拍板）：Scope / Group / 同名策略 / tags / 切分参数**一并清空**
   * （此前当"偏好"保留，会造成"输入框已填好上次的 Scope 与同名策略、却没确认"的误导态）。
   */
  const location = useLocation();
  const onImportRoute = location.pathname === '/import';
  const wasOnImportRoute = useRef(onImportRoute);
  useEffect(() => {
    const wasOn = wasOnImportRoute.current;
    wasOnImportRoute.current = onImportRoute;
    if (!onImportRoute || wasOn) return;
    if (phase !== 'idle' && phase !== 'done' && phase !== 'failed' && phase !== 'cancelled') return;
    /**
     * R2（REQ-20261009-001）与 R3 的边界：**部分成功不是「本批暂存」，而是「待处置结果」**。
     * `partial`（或结果里仍有未完成清单）时保留 `job`、localStorage 凭据（uploadId）与
     * `uploadPlanRef`（原批次参数），并保持 `phase` 不变——否则切页回来时「重试未完成 N 篇」
     * 与结果摘要一并消失（任务中心只承载任务台账，没有该清单与重试入口），用户只能重新
     * 上传整批。
     * `uploadErrors` 同样保留：这些文件**从未到达服务端**，不在 incomplete 清单里，
     * 「重试未完成」不会覆盖它们，清掉就再没有任何提示。
     * 其余与本批文件选择/上传进度相关的暂存照 R3 清空。
     */
    const jobResult = job?.result as { partial?: boolean; incomplete?: unknown[] } | undefined;
    const keepPartialResult = Boolean(jobResult?.partial)
      || (Array.isArray(jobResult?.incomplete) && jobResult.incomplete.length > 0);
    if (keepPartialResult) {
      // `phase === 'done'` 的结果区以 `!error` 为渲染条件：清掉可能残留的上传错误文案，
      // 别让它把「部分成功」结果卡顶掉；失败态（phase === 'failed'）则保留错误原文。
      if (phase !== 'failed') {
        setError(null);
        setFailureStage(null);
      }
      // 释放本批文件引用：重试只需要 uploadId / scope / finalize 与清单本身；批次级
      // 「重试上传」入口已随 failedUploadBatch 一并清空，故 batches/selectionSnapshot 不再需要。
      const keptPlan = uploadPlanRef.current;
      if (keptPlan) {
        uploadPlanRef.current = { ...keptPlan, selectionSnapshot: [], batches: [] };
      }
      setSelections([]);
      setUploadStats(null);
      setFailedUploadBatch(null);
      setProgressText('');
      setScopeDraft('');
      return;
    }
    // 凭据要先按「当前任务的 uploadId/jobId」清（清空 plan/job 后就取不到了）
    clearImportCredentialIf({ uploadId: uploadPlanRef.current?.uploadId, jobId: job?.id });
    uploadPlanRef.current = null;
    // 本批结束：预检快照一并释放，避免下一个批次误用上一批的面板数据
    preflightSnapshotRef.current = null;
    setSelections([]);
    setUploadStats(null);
    setUploadErrors([]);
    setFailedUploadBatch(null);
    setError(null);
    setFailureStage(null);
    setProgressText('');
    setJob(null);
    setPhase('idle');
    /**
     * Q4（2026-10-10 用户拍板）：Scope / Group / 同名策略 / tags / 切分参数**不再是「偏好」保留项**。
     * 此前只清「本批暂存」，这些输入跨页保留，导致「每次导入前重新确认 Scope」的提示与
     * 「输入框已填好上次的 Scope + 同名策略」并存——用户会把上一批的目标当成本批目标。
     * 清空动作只在此终态分支执行：部分成功分支（见上）必须保留 scope/uploadId 供「重试未完成」。
     */
    setScope('');
    setScopeConfirmed(false);
    setFormEpoch((epoch) => epoch + 1);
    setGroup('');
    setConflictMode(DEFAULT_CONFLICT_MODE);
    setConflictSuffix('_{n}');
    setSelectedTags([]);
    setTagInput('');
    setTagInputErr(null);
    setChunkSize('1000');
    setChunkOverlap('150');
    setVector(true);
    setScopeDraft('');
  }, [onImportRoute, phase, job?.id, job?.result]);

  /**
   * P2（review）：任务进入终态后复位「取消请求」状态——否则顶部会同时出现
   * 「已请求取消：当前批次完成后停止后续写入」与结果区的「已完成 / 部分成功」，
   * 用户无法判断任务到底结束了没有。
   */
  useEffect(() => {
    if (phase !== 'done' && phase !== 'failed' && phase !== 'cancelled') return;
    setCancelState((prev) => (prev === 'idle' ? prev : 'idle'));
    setCancelError('');
  }, [phase]);

  /**
   * 预检命中后把用户带到面板前。
   *
   * 面板挂在表单底部：23 个文件的清单之后实测 `top ≈ 2341px`（视口 1000），**根本不在视野里**。
   * 不主动滚过去，用户只会看到右轨「等待确认」却不知道要确认什么（2026-10-19 M4 走查）。
   * 同时把焦点交给面板（`alertdialog` + `tabIndex=-1`），键盘/读屏用户不必从头 Tab。
   */
  useEffect(() => {
    if (!preflightConfirm) return;
    setShowAllPreflight(false);
    const panel = preflightRef.current;
    if (!panel) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    panel.focus({ preventScroll: true });
  }, [preflightConfirm]);

  useEffect(() => {
    // S-02/S-03（REQ-20261009-003）：两级完成口径下的轨道文案 ——「已完成 · 可用」与
    // 「已优化」分开表述；整理未完成（失败/超时降级）时给出可重试线索，**不谎报失败**。
    const doneIndexSuffix = job?.indexState === 'indexing' ? ' · 索引整理中…'
      : job?.indexState === 'optimized' ? ' · 索引已优化'
        : job?.indexState === 'available' ? ' · 索引整理未完成（可重试）'
          : '';
    onTaskChange?.(phase === 'idle' ? null : {
      phase,
      scope: job?.scope ?? uploadPlanRef.current?.scope ?? scope,
      text: phase === 'done'
        ? (uploadErrors.length > 0 || (Array.isArray(job?.result?.errors) && job.result.errors.length > 0)
          ? `导入完成，部分文件失败${doneIndexSuffix}` : `导入完成${doneIndexSuffix}`)
        : phase === 'failed' ? (failureStage === 'cancelled' ? '导入已取消' : failureStage === 'upload' ? '上传失败' : failureStage === 'scan' ? '读取失败' : '导入失败')
          : phase === 'cancelled' ? '导入已取消'
            : phase === 'unknown' ? '任务状态待确认'
              : phase === 'awaiting-confirm' ? '等待确认是否继续导入'
                : phase === 'importing' && job?.progress?.total
                  ? `导入中 ${job.progress.done}/${job.progress.total}`
                  : progressText || (phase === 'importing' ? '导入中…' : '上传中…'),
    });
  }, [phase, failureStage, progressText, uploadErrors, job?.scope, job?.progress?.done, job?.progress?.total, job?.result, job?.indexState, scope, onTaskChange]);

  useEffect(() => {
    let active = true;
    const credential = readImportCredential();
    if (!credential) return;
    const { uploadId, jobId, scope: savedScope } = credential;
    if (!savedScope || (!uploadId && !jobId)) return;
    const generation = taskGenRef.current;
    /** 恢复流程的每一步落地前都要过这道闸：标签页卸载、或用户已发起新任务 → 立即作废。 */
    const isStale = (): boolean => !active || taskGenRef.current !== generation;
    const pause = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });
    /** 任务确认未被后端接受时把 UI 交还用户：停在 idle 态，不得留在"上传中"锁死整页。 */
    const releaseToIdle = (): void => {
      setPhase('idle');
      setProgressText('');
      setUploadErrors([]);
    };
    let recoveredJobId = jobId;
    const recover = async (): Promise<void> => {
      if (uploadId) {
        let status: Awaited<ReturnType<typeof getImportUploadStatus>> | null = null;
        for (let attempt = 0; !isStale(); attempt += 1) {
          try {
            status = await getImportUploadStatus(savedScope, uploadId);
            break;
          } catch (statusError) {
            if ((statusError as { status?: number }).status !== 404 || jobId || attempt >= 8) throw statusError;
            // 最后一批可能已完整抵达，但后端还在解析请求体；给它短暂时间写入会话与 jobId。
            await pause(250);
          }
        }
        if (isStale()) return;
        // 服务端仍在接收该 uploadId 的请求：等它落定，最多 30s，避免无界自旋。
        let tick = 0;
        while (!isStale() && status?.active && !status.jobId && tick < 60) {
          tick += 1;
          setScope(savedScope);
          setProgressText('确认上传状态…');
          setPhase('uploading');
          await pause(500);
          if (isStale()) return;
          status = await getImportUploadStatus(savedScope, uploadId);
          setUploadErrors(status.errors);
        }
        recoveredJobId = status?.jobId ?? jobId;
        if (!recoveredJobId) {
          if (isStale()) return;
          if (status?.active) {
            // 到上限仍未落定：真实状态未知，保留凭据供下次进入时再认，且不得停在"上传中"。
            setPhase('unknown');
            setFailureStage('unknown');
            setError('上传状态确认超时，请稍后重新进入本页确认导入是否已启动');
            return;
          }
          clearImportCredentialIf({ uploadId });
          releaseToIdle();
          return;
        }
        if (!jobId) {
          // 回写找回的 jobId：后续终态清理与再次重开都以它为准。
          if (isStale()) return;
          try { localStorage.setItem(LAST_IMPORT_JOB_KEY, JSON.stringify({ uploadId, jobId: recoveredJobId, scope: savedScope })); } catch { /* ignore */ }
        }
      }
      if (!recoveredJobId) return;
      if (isStale()) return;
      const result = await getImportStatus(recoveredJobId);
      if (isStale() || !result.job) return;
      // R2（REQ-20261009-001）：部分成功的 done 任务**保留凭据**——「重试未完成 N 篇」
      // 需要同一 uploadId（暂存目录仍在服务端）；否则刷新页面后重试入口就失效了。
      const recoveredPartial = Boolean((result.job.result as { partial?: boolean } | undefined)?.partial);
      if ((result.job.state === 'done' && !recoveredPartial)
        || result.job.state === 'failed' || result.job.state === 'cancelled') {
        clearImportCredentialIf({ jobId: recoveredJobId });
      }
      setJob(result.job);
      setScope(savedScope);
      // REQ-20261019-002：刷新/重进页面时面板快照（内存态）已丢失，无法恢复「跳过/仍然导入」选择；
      // 但「全部重复」是输入问题不是系统故障，不得渲染成红色失败——回 idle 并给出下一步指引。
      const recoveredAllDuplicates = result.job.errorCode === 'ALL_FILES_DUPLICATES';
      setPhase(recoveredAllDuplicates
        ? 'idle'
        : result.job.state === 'done' ? 'done' : result.job.state === 'running' ? 'importing' : 'failed');
      if (recoveredAllDuplicates) {
        setFailureStage(null);
        setError(null);
        setProgressText('上次「跳过重复文档」未导入任何文件（本批全部为疑似重复）；如需建副本请重新选择文件并点「仍然导入」');
      } else if (result.job.state === 'failed') {
        setFailureStage('import');
        setError(result.job.error ?? '导入失败');
      } else if (result.job.state === 'cancelled') {
        setFailureStage('cancelled');
        setError('导入已取消');
      }
    };
    void recover().catch((recoverError) => {
      if (isStale()) return;
      // 只有"从未被后端接受"的任务才静默清凭据并交还 UI；一旦拿到过 jobId，
      // 查不到结果必须呈现"状态待确认"——不得把未知说成失败，也不得装作什么都没发生。
      if ((recoverError as { status?: number }).status === 404 && !recoveredJobId) {
        clearImportCredentialIf({ uploadId });
        releaseToIdle();
        return;
      }
      setPhase('unknown');
      setFailureStage('unknown');
      setError('无法确认上次导入结果，请检查知识库后再决定是否重新上传');
    });
    return () => { active = false; };
  }, []);
  const canRetryUpload = (): boolean => {
    const plan = uploadPlanRef.current;
    return !!plan && plan.scope === scope && plan.selectionSnapshot === selections;
  };

  // 进度轮询（导入中每 2s；**索引整理期间继续轮询**）
  useEffect(() => {
    // S-02（REQ-20261009-003）：`state` 已是 'done' 但 `indexState === 'indexing'` 时仍需轮询
    // ——「已完成 · 可用」与「索引已优化」分两级呈现（刷新/重进页面后也能继续跟进）。
    const indexingAfterDone = phase === 'done' && job?.indexState === 'indexing';
    if ((phase !== 'importing' && !indexingAfterDone) || !job) return;
    let active = true;
    let checking = false;
    const invalidateImportQueries = (targetScope: string): void => {
      void queryClient.invalidateQueries({ queryKey: ['scopeList'] });
      void queryClient.invalidateQueries({ queryKey: ['docList', targetScope] });
      void queryClient.invalidateQueries({ queryKey: ['fullTextSearch', targetScope] });
    };
    const timer = setInterval(async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const res = await getImportStatus(job.id);
        if (!active) return;
        if (!res.ok || !res.job) {
          active = false;
          clearInterval(timer);
          invalidateImportQueries(scope);
          setPhase('failed');
          setScopeConfirmed(false);
          setFailureStage('import');
          setError(res.error ?? '任务已失效，请重新导入');
          return;
        }
        setJob(res.job);
        const targetScope = res.job.scope || scope;
        if (res.job.state === 'done') {
          // S-02/S-03（REQ-20261009-003）：**两级完成口径**。
          // ★ 第一级「可用」必须在**这一刻**完成（不是等整理结束）：元数据已提交，
          //   结果区要立刻渲染、缓存要失效、事件要广播——否则用户会一直看到"导入中…"，
          //   正是本需求要消除的"把可用推迟"。
          // ★ 第二级：`indexState === 'indexing'` 期间**继续轮询**（不 clearInterval）；
          //   落到 `optimized` / `available`（失败/超时降级）才收尾。
          // ★ 一次性副作用只做一次：靠 `wasDone`（来自 effect 依赖里的 phase）判定，
          //   因为 setPhase('done') 会重跑本 effect（重新建 interval）——若不加这道闸，
          //   每次 tick 都会重复失效缓存 + 重复广播事件。
          const indexing = res.job.indexState === 'indexing';
          const wasDone = phase === 'done';
          setProgressText('');
          if (!wasDone) {
            invalidateImportQueries(targetScope);
            // R2（REQ-20261009-001）：部分成功时**保留凭据**——「重试未完成」需要同一
            // uploadId（暂存目录仍在服务端），刷新/重进页面也能恢复该入口；全量成功才清理
            const donePartial = Boolean((res.job.result as { partial?: boolean } | undefined)?.partial);
            if (!donePartial) clearImportCredentialIf({ jobId: job.id });
            void fetchTags(targetScope).then((tags) => {
              if (tags.ok) setAvailableTags(tags.tags.map((tag) => tag.tag));
            }).catch(() => {});
            window.dispatchEvent(new CustomEvent('ki-import-completed', { detail: { scope: targetScope } }));
          }
          setPhase('done');
          setScopeConfirmed(false);
          if (!indexing) {
            active = false;
            clearInterval(timer);
          }
        } else if (res.job.state === 'failed') {
          active = false;
          clearInterval(timer);
          invalidateImportQueries(targetScope);
          // REQ-20261019-002：全部重复是「可纠正的输入问题」，不是失败——
          // 恢复预检面板（快照）并保留 plan/凭据，用户可直接改选「仍然导入」。
          // 若落成 failed 红态，用户会以为系统故障，且面板已清空只能重传整批（AC15）。
          if (res.job.errorCode === 'ALL_FILES_DUPLICATES' && preflightSnapshotRef.current) {
            const snapshot = preflightSnapshotRef.current;
            preflightSnapshotRef.current = null; // 已消费，避免下次误用上一次批次的快照
            setJob(null);
            setPreflightConfirm(snapshot);
            setPhase('awaiting-confirm');
            setScopeConfirmed(false);
            setFailureStage(null);
            setError(null);
            setProgressText('本批全部为疑似重复，未导入任何文件；如需建副本请点「仍然导入」');
            return;
          }
          clearImportCredentialIf({ jobId: job.id });
          setPhase('failed');
          setScopeConfirmed(false);
          setFailureStage('import');
          setError(res.job.error ?? '导入失败');
        } else if (res.job.state === 'cancelled') {
          active = false;
          clearInterval(timer);
          invalidateImportQueries(targetScope);
          clearImportCredentialIf({ jobId: job.id });
          setPhase('failed');
          setScopeConfirmed(false);
          setFailureStage('cancelled');
          // 取消不是失败：不写 error（否则主区会弹一张红色"出错"卡，标题与正文都是
          // 「导入已取消」重复两遍）。状态由右轨「已取消」+ 主按钮旁「导入已取消」承载。
          setError(null);
        }
      } catch (e) {
        if (!active) return;
        active = false;
        clearInterval(timer);
        invalidateImportQueries(scope);
        setPhase('unknown');
        setFailureStage('unknown');
        setError(`无法确认导入状态：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        checking = false;
      }
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase, job?.id, queryClient, scope]);

  const nextSelectionId = (): string => `selection-${Date.now()}-${selectionSeq.current++}`;

  const addSelections = (incoming: Omit<PendingSelection, 'id'>[]): void => {
    const valid = incoming.filter((selection) => selection.files.length > 0);
    if (valid.length === 0) return;
    setSelections((prev) => [
      ...prev,
      ...valid.map((selection) => ({ ...selection, id: nextSelectionId() })),
    ]);
  };

  /**
   * 将原生目录选择器返回的 FileList 按顶层目录聚合。
   * webkitRelativePath 用于：① 本页选择项分组展示；② 附件相对引用解析。
   * 发给后端的 rel 另经 `stripTopSegment` 剥离顶层目录段（R1：与 CLI 口径一致）。
   */
  const yieldToBrowser = (): Promise<void> => new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

  const collectSelectedFiles = async (list: FileList): Promise<void> => {
    // 先让 React 绘制 scanning 状态，再处理 FileList；大目录每 100 个文件让出一次主线程。
    const selectedFiles: RawPendingFile[] = Array.from(list).map((file) => ({
      name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      size: file.size,
      file,
    }));
    await collectRawFiles(selectedFiles);
  };

  const collectRawFiles = async (selectedFiles: RawPendingFile[]): Promise<void> => {
    await yieldToBrowser();
    const classified = await classifyPendingFiles(
      selectedFiles,
      importPolicy,
      setProgressText,
      yieldToBrowser,
    );
    const nextSelections = buildSelections(classified.included, classified.stats);
    addSelections(nextSelections);
    if (nextSelections.length === 0) {
      setFailureStage('scan');
      setError(`未发现可导入文件：请检查 Markdown 扩展名（${importPolicy.extensions.join(', ')}）以及 Markdown 中是否引用了有效附件`);
    }
  };

  const scanSelectedFiles = (list: FileList, message: string): void => {
    if (busyPhase) return;
    setError(null);
    setFailureStage(null);
    setUploadErrors([]);
    setProgressText(message);
    setPhase('scanning');
    void collectSelectedFiles(list).then(() => {
      setProgressText('');
      setPhase('idle');
    }).catch((error) => {
      setProgressText('');
      setPhase('idle');
      setFailureStage('scan');
      setError(`读取文件列表失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) scanSelectedFiles(e.target.files, '正在读取文件列表…');
    e.target.value = '';
  };

  const readPickedDirectory = async (handle: FileSystemHandleLike, parentPath = ''): Promise<RawPendingFile[]> => {
    const currentPath = parentPath ? `${parentPath}/${handle.name}` : handle.name;
    if (handle.kind === 'file' && handle.getFile) {
      const file = await handle.getFile();
      return [{ name: currentPath, size: file.size, file }];
    }
    if (handle.kind !== 'directory' || !handle.values) return [];

    const files: RawPendingFile[] = [];
    for await (const child of handle.values()) {
      files.push(...await readPickedDirectory(child, currentPath));
      if (files.length > 0 && files.length % 100 === 0) await yieldToBrowser();
    }
    return files;
  };

  /**
   * 打开目录选择器：优先使用 File System Access API，避免 Chromium 对
   * input[webkitdirectory] 触发“是否将 N 个文件上传到此站点”的原生确认。
   * 不支持该 API 的浏览器回退到 webkitdirectory input。
   */
  const openDirPicker = async (): Promise<void> => {
    if (busyPhase) return;
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      let directory: FileSystemHandleLike;
      try {
        // 选择器打开期间不改变页面 loading；用户取消时页面保持原状态。
        directory = await picker.call(window);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailureStage('scan');
        setError(`读取目录失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      setError(null);
      setFailureStage(null);
      setUploadErrors([]);
      setProgressText('正在读取目录…');
      setPhase('scanning');
      try {
        await collectRawFiles(await readPickedDirectory(directory));
        setProgressText('');
        setPhase('idle');
      } catch (error) {
        setProgressText('');
        setPhase('idle');
        setFailureStage('scan');
        setError(`读取目录失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // 兼容不支持 File System Access API 的浏览器。
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files) scanSelectedFiles(input.files, '正在读取目录…');
      input.remove();
    });
    // 取择也清理 DOM
    input.addEventListener('cancel', () => { input.remove(); });
    document.body.appendChild(input);
    input.click();
  };

  const readDirectoryEntries = async (reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> => {
    const entries: FileSystemEntryLike[] = [];
    while (true) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) return entries;
      entries.push(...batch);
    }
  };

  const readDroppedEntry = async (entry: FileSystemEntryLike, parentPath = ''): Promise<RawPendingFile[]> => {
    const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => {
        entry.file!(resolve, reject);
      });
      return [{ name: currentPath, size: file.size, file }];
    }
    if (!entry.isDirectory || !entry.createReader) return [];

    const children = await readDirectoryEntries(entry.createReader());
    const nested = await Promise.all(children.map((child) => readDroppedEntry(child, currentPath)));
    return nested.flat();
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    if (busyPhase) return;
    setError(null);
    setFailureStage(null);
    setUploadErrors([]);
    setProgressText('正在读取拖拽目录…');
    setPhase('scanning');
    // DataTransferItem/FileList 在 drop 事件返回后可能被浏览器清空，先同步取出句柄。
    const droppedItems = (Array.from(e.dataTransfer.items) as DataTransferItemWithEntry[]).map((item) => ({
      entry: item.webkitGetAsEntry?.(),
      file: item.getAsFile(),
    }));
    const fallbackFiles = Array.from(e.dataTransfer.files);
    void (async () => {
      try {
        const candidates: RawPendingFile[] = [];
        for (const { entry, file } of droppedItems) {
          if (entry) {
            const droppedFiles = await readDroppedEntry(entry);
            candidates.push(...droppedFiles);
            continue;
          }
          if (file) {
            candidates.push({ name: file.name, size: file.size, file });
          }
        }
        if (candidates.length === 0) candidates.push(...fallbackFiles.map((file) => ({ name: file.name, size: file.size, file })));
        const classified = await classifyPendingFiles(candidates, importPolicy, setProgressText, yieldToBrowser);
        const selectionsToAdd = buildSelections(classified.included, classified.stats);
        addSelections(selectionsToAdd);
        if (selectionsToAdd.length === 0) {
          setFailureStage('scan');
          setError(`未发现可导入文件：请检查 Markdown 扩展名（${importPolicy.extensions.join(', ')}）以及 Markdown 中是否引用了有效附件`);
        }
        setProgressText('');
        setPhase('idle');
      } catch (error) {
        setProgressText('');
        setPhase('idle');
        setFailureStage('scan');
        setError(`读取拖拽目录失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  const removeSelection = (id: string): void => {
    setSelections((prev) => prev.filter((selection) => selection.id !== id));
  };

  const getErrorDetails = (error: unknown): string => {
    const apiError = error as Error & { body?: { errors?: { name?: string; error?: string }[] } };
    const details = apiError.body?.errors
      ?.map((item) => `${item.name ?? '文件'}：${item.error ?? '未知错误'}`)
      .join('\n');
    return details ? `${apiError.message}\n${details}` : apiError.message;
  };

  const trackImport = (jobId: string, targetScope: string, uploadId: string): void => {
    setJob({ id: jobId, scope: targetScope, state: 'running', startedAt: Date.now() });
    try { localStorage.setItem(LAST_IMPORT_JOB_KEY, JSON.stringify({ uploadId, jobId, scope: targetScope })); } catch { /* ignore */ }
    setProgressText('导入中…');
    setFailureStage(null);
    setPhase('importing');
  };

  const continueUpload = async (fromBatch: number): Promise<string | null> => {
    const plan = uploadPlanRef.current;
    if (!plan) return null;
    setError(null);
    setPhase('uploading');
    setFailedUploadBatch(null);
    try {
      for (let index = fromBatch; index < plan.batches.length; index += 1) {
        plan.currentBatch = index;
        const batch = plan.batches[index];
        const encoded: { name: string; content: string }[] = [];
        for (const [fileIndex, file] of batch.entries()) {
          setProgressText(`准备第 ${index + 1}/${plan.batches.length} 批：${fileIndex + 1}/${batch.length} 个文件…`);
          // R1：rel 剥离被选目录顶层段（与 CLI 同口径），否则同一目录二次导入会产生副本
          encoded.push({ name: stripTopSegment(file.name), content: await fileToBase64(file.file) });
        }
        const response = await uploadFiles(
          plan.scope,
          encoded,
          plan.uploadId,
          index,
          plan.batches.length,
          // R6（REQ-20261010-001）：上传一律不带 finalize —— 导入改由「预检 → 确认 → run」显式启动，
          // 这样用户取消时是真正的零写入（finalize 会在最后一批上传时就起导入，取消已无意义）
          undefined,
        );
        if (!response.ok || !response.uploadId) throw new Error(response.error ?? '上传失败');
        plan.nextBatch = index + 1;
        plan.uploadedFiles += response.total ?? batch.length;
        if (response.errors && response.errors.length > 0) {
          setUploadErrors((previous) => {
            const known = new Set(previous.map((item) => `${item.name}\0${item.error}`));
            return [...previous, ...response.errors!.filter((item) => !known.has(`${item.name}\0${item.error}`))];
          });
        }
        setUploadStats({
          batch: index + 1,
          totalBatches: plan.batches.length,
          filesDone: plan.uploadedFiles,
          totalFiles: plan.totalFiles,
          bytesDone: Math.min(plan.totalBytes, plan.batches.slice(0, index + 1).flat().reduce((sum, item) => sum + item.size, 0)),
          totalBytes: plan.totalBytes,
        });
        setProgressText(`已上传第 ${index + 1}/${plan.batches.length} 批（${plan.uploadedFiles}/${plan.totalFiles} 个文件）`);
      }
      return null;
    } catch (error) {
      setFailedUploadBatch(plan.currentBatch);
      setFailureStage('upload');
      setPhase('failed');
      // Retry remains tied to this immutable upload plan, but a new start requires a fresh target confirmation.
      setScopeConfirmed(false);
      setError(`上传第 ${plan.currentBatch + 1}/${plan.batches.length} 批失败：${getErrorDetails(error)}`);
      return null;
    }
  };

  /**
   * 把**当前**表单值冻结成一次 run 的 finalize。
   *
   * 为什么不在 `start()` 里只算一次：预检命中后「等待确认」期间表单仍可编辑（同名策略 /
   * Group / 切分参数 / tags / 向量开关），而预检卡片明确写着"确认后按**当前**「同名文档处理」
   * 策略继续"。若确认时仍用上传开始时的快照，用户恰好在"决定是否接受副本"的时刻改策略却
   * 不生效（2026-10-19 code review P1）。
   */
  const currentFinalize = (): UploadPlan['finalize'] => ({
    group: group.trim() || undefined,
    chunkSize: chunkSize ? Number(chunkSize) : undefined,
    chunkOverlap: chunkOverlap ? Number(chunkOverlap) : undefined,
    vector,
    tags: selectedTags.length > 0 ? selectedTags.join(',') : undefined,
    conflictMode,
    conflictSuffix: suffixInUse ? conflictSuffix : undefined,
  });

  /**
   * R6（REQ-20261010-001）：上传完成后的收口——先做重复导入预检，命中则停下来等用户确认，
   * 确认后才显式调 `/api/import/run`（`runImport` 已是「重试未完成」在用的成熟路径）。
   */
  const afterUploadsComplete = async (plan: UploadPlan): Promise<void> => {
    setProgressText('正在预检重复导入…');
    let preflight: Awaited<ReturnType<typeof preflightImport>> | null = null;
    try {
      preflight = await preflightImport({
        scope: plan.scope,
        uploadId: plan.uploadId,
        // 用**当前**表单的 Group（与 `currentFinalize` 同源）：预检要按真实落点判断"是否同一篇文档"，
        // 否则 group 吸收路径前缀时（上次父目录 / 本次 group 子目录）整批幂等更新会被误报成重复
        ...(group.trim() ? { group: group.trim() } : {}),
      });
    } catch (failure) {
      // 预检是"提示"能力：失败不阻断导入（真问题在 run 阶段 fail-loud），但要如实告知
      const message = failure instanceof Error ? failure.message : String(failure);
      setUploadErrors((previous) => [...previous, { name: '<重复导入预检>', error: `预检失败，已直接开始导入：${message}` }]);
    }
    const matched = preflight?.files?.matched ?? 0;
    if (matched > 0) {
      setPreflightConfirm({
        matched,
        // 预检扫描到的 Markdown 数（「本批共 N 篇」的口径，Q5）；旧 daemon 缺失时退回 matched
        scanned: preflight?.files?.scanned ?? matched,
        duplicates: preflight?.duplicates ?? [],
        truncated: Boolean(preflight?.truncated),
      });
      // 上传已完成、导入未开始：迁出 uploading，否则右轨会一直说「上传中…」（2026-10-19 报障）
      setPhase('awaiting-confirm');
      // 「重试上传」链路进来时 failureStage 可能仍是上一轮的 'upload'，等待期不能再背着它
      setFailureStage(null);
      setProgressText(`检测到 ${matched} 篇疑似重复，等待你确认`);
      return;
    }
    await launchImport(plan);
  };

  /**
   * 调 /api/import/run 真正启动导入（预检通过或用户确认后）——策略取**当前**表单值。
   *
   * @param onlyRelPaths 只导入这批 rel（「仅导入不重复」子集）；不传 = 整批。
   *   服务端语义见 `src/lib/import.ts:813-851`：清单外文件完全不处理（不读原文、不复制附件、
   *   不写 KB），附件跟随其所属文档一起生效。**空数组不可传** —— 服务端会当成"未指定"退化为
   *   全量导入（`import.ts:827`），恰好与用户意图相反，故调用方需先判空。
   */
  const launchImport = async (
    plan: UploadPlan,
    onlyRelPaths?: string[],
    options?: { skipDuplicates?: boolean },
  ): Promise<void> => {
    setPreflightConfirm(null);
    setProgressText(options?.skipDuplicates ? '正在比对库内文档并跳过疑似重复…' : '正在启动导入…');
    const finalize = currentFinalize();
    try {
      const response = await runImport({
        scope: plan.scope,
        uploadId: plan.uploadId,
        ...finalize,
        ...(onlyRelPaths && onlyRelPaths.length > 0 ? { onlyRelPaths } : {}),
        ...(options?.skipDuplicates ? { skipDuplicates: true } : {}),
      });
      if (!response.ok || !response.jobId) {
        throw Object.assign(new Error(response.error ?? '导入启动失败'), { code: response.code });
      }
      // 回写「本次实际使用的参数」：`startRetry` 的「重试未完成」必须沿用上一次 run 的
      // finalize（而不是上传时的快照），否则"改成 overwrite 跑一半失败后重试"会退回 incremental
      plan.finalize = finalize;
      trackImport(response.jobId, plan.scope, plan.uploadId);
    } catch (failure) {
      // REQ-20261019-002：同一 uploadId 已在跑且「跳过重复」设置不同 → 可纠正提示，不落失败红态
      const code = (failure as { code?: string }).code;
      if (code === 'IMPORT_JOB_PARAMS_MISMATCH' && preflightSnapshotRef.current) {
        const snapshot = preflightSnapshotRef.current;
        preflightSnapshotRef.current = null;
        setPreflightConfirm(snapshot);
        setPhase('awaiting-confirm');
        setFailureStage(null);
        setError(null);
        setProgressText('该批次已在导入中，请等待完成或到任务中心查看');
        return;
      }
      setFailureStage('import');
      setPhase('failed');
      setScopeConfirmed(false);
      setError(`导入启动失败：${failure instanceof Error ? failure.message : String(failure)}`);
    }
  };

  /** 用户确认「仍然导入」（承认会新建副本） */
  const confirmDuplicateImport = (): void => {
    const plan = uploadPlanRef.current;
    if (!plan) {
      // 兜底：上传会话已不在内存（理论上不可达）。不能静默 —— 卡片是唯一出口，
      // 点「仍然导入」没反应就会让用户同时失去「导入」与「退出」两个动作。
      setPreflightConfirm(null);
      setPhase('idle');
      setFailureStage('upload');
      setError('上传会话已失效，请重新选择文件后再导入');
      return;
    }
    void launchImport(plan);
  };

  /**
   * 「跳过重复文档」（REQ-20261019-002）：把「跳过疑似重复」交给服务端判定。
   *
   * 与旧实现（前端用预检明细反算 `onlyRelPaths`）的差别：
   *   ① 不再受明细 50 条上限约束（服务端按同一判据重算，任意条数都能跳过）；
   *   ② 判定口径 = run 时刻的库状态（预检只作提示），不会把"预检后新出现的重复"当新文件导入；
   *   ③ 全部重复时由服务端 fail-loud，前端渲染可纠正提示（而不是一个灰按钮 + hover 说明）。
   */
  const skipDuplicateImport = (): void => {
    const plan = uploadPlanRef.current;
    if (!plan || !preflightConfirm || !canSkipDuplicates) return;
    preflightSnapshotRef.current = preflightConfirm;
    void launchImport(plan, undefined, { skipDuplicates: true });
  };

  /**
   * 用户取消：导入尚未开始 → 零写入；保留文件选择，允许改策略后重来。
   *
   * ⚠️ 必须把 `phase` 迁出等待态（2026-10-19 用户报障）：此前只清 `preflightConfirm`
   * 与改一行文案，`phase` 仍停在 `awaiting-confirm` 的上游 `uploading` 分支 ——
   * 右轨恒显示「上传中…」+ 100% 进度条 + 一个禁用的「取消导入」，主按钮也一直是
   * 「上传中…」且禁用，选文件/开始导入的守卫全按"忙"拦下，页面被锁死到只能刷新。
   */
  const cancelDuplicateImport = (): void => {
    // 只允许从等待确认态取消：否则会把「已在跑的任务」标成已取消并停掉轮询（防御性）
    if (phase !== 'awaiting-confirm') return;
    const plan = uploadPlanRef.current;
    setPreflightConfirm(null);
    setPhase('cancelled');
    setFailureStage('cancelled');
    // 上传已结束、这批不会导入：清掉 100% 的进度条，别让"已取消"与"上传完成"并存
    setUploadStats(null);
    setProgressText('已取消：本次未写入任何内容；可调整「同名文档处理」后重新开始');
    // 服务端暂存目录不再被引用：不清凭据的话，刷新页面会先走一遍「确认上传状态…」才回 idle
    if (plan) clearImportCredentialIf({ uploadId: plan.uploadId });
  };

  const start = async (): Promise<void> => {
    if (startingRef.current || busyPhase) return;
    startingRef.current = true;
    try {
    setFailureStage(null);
    if (!scopeConfirmed) {
      setError('请先明确选择本次导入目标 Scope');
      return;
    }
    if (scopeErr) {
      setError(scopeErr);
      return;
    }
    const checkedConfig = vector && importConfig?.scope !== scope
      ? await getImportConfig(scope).catch(() => null)
      : importConfig;
    if (vector) {
      const dimension = checkedConfig?.vectorDimension;
      if (!dimension) {
        setError('无法确认当前向量集合维度，请刷新页面后重试；也可关闭向量化，仅导入全文索引。');
        return;
      }
      if (dimension.compatible !== true) {
        setError(dimension.compatible === false
          ? `当前 embedding 为 ${dimension.configured} 维，scope "${scope}" 的旧向量集合为 ${dimension.persisted} 维。请先执行 ki restore ${scope} --rebuild-vector --yes，完成后刷新页面再导入。`
          : `暂无法读取 scope "${scope}" 的向量集合维度：${dimension.error ?? '未知原因'}。请稍后重试。`);
        return;
      }
    }
    if (files.length === 0) {
      setError('请先选择文件或目录');
      return;
    }
    // group 字符格式校验（与后端 resolveGroupPath 对齐）
    if (groupErr) {
      setError(groupErr);
      return;
    }
    if (conflictSuffixErr) {
      setError(conflictSuffixErr);
      return;
    }
    if (selectedDocuments.length === 0) {
      setFailureStage('scan');
      setError('没有可导入的 Markdown 文件');
      return;
    }
    setError(null);
    setFailureStage(null);
    setUploadErrors([]);
    setJob(null);
    // 新任务接管 UI：作废仍在途的恢复流程，防止旧任务的迟到写入覆盖本次任务状态。
    taskGenRef.current += 1;
    try { localStorage.removeItem(LAST_IMPORT_JOB_KEY); } catch { /* ignore */ }
    const batches = toUploadBatches(files, (checkedConfig ?? importPolicy).maxRequestBody);
    const plan: UploadPlan = {
      scope,
      uploadId: crypto.randomUUID(),
      // 只作「上传时口径」留档：真正 run 时用 currentFinalize()（等待确认期间可改策略）
      finalize: currentFinalize(),
      selectionSnapshot: selections,
      batches,
      nextBatch: 0,
      currentBatch: 0,
      uploadedFiles: 0,
      totalFiles: files.length,
      totalBytes: totalSelectedBytes,
    };
    uploadPlanRef.current = plan;
    try { localStorage.setItem(LAST_IMPORT_JOB_KEY, JSON.stringify({ uploadId: plan.uploadId, scope: plan.scope })); } catch { /* ignore */ }
    setUploadStats({ batch: 0, totalBatches: batches.length, filesDone: 0, totalFiles: files.length, bytesDone: 0, totalBytes: totalSelectedBytes });
    await continueUpload(0);
    await afterUploadsComplete(plan);
    } finally {
      startingRef.current = false;
    }
  };

  const retryUpload = async (): Promise<void> => {
    if (startingRef.current || failureStage !== 'upload' || failedUploadBatch === null || !canRetryUpload()) return;
    startingRef.current = true;
    try {
      await continueUpload(failedUploadBatch);
      await afterUploadsComplete(uploadPlanRef.current!);
    } finally {
      startingRef.current = false;
    }
  };

  const result = job?.result as
    | {
        stats?: {
          total?: number; vectorized?: number; errors?: number; conflicts?: number;
          /** R2：文件级完成度（CLI/Web 同源口径） */
          files?: {
            total?: number; completed?: number; incomplete?: number;
            scanned?: number; skipped?: number; unchanged?: number;
            /** REQ-20261019-002：因疑似重复被跳过的文件数（skipped 的子集） */
            duplicatesSkipped?: number;
          };
        };
        /** REQ-20261019-002：跳过明细（最多 500 条） */
        duplicatesSkipped?: { path: string; existingGroup: string; existingRelation: string }[];
        duplicatesSkippedTruncated?: boolean;
        errors?: { path?: string; error?: string }[];
        conflicts?: {
          path?: string; originalRelation?: string; relation?: string;
          action?: string; skipReason?: string;
          /** 判定为覆盖但实际被「内容未变」跳过（不能显示成"已覆盖"） */
          unchanged?: boolean;
        }[];
        /** R1/R2：部分成功语义（REQ-20261009-001） */
        partial?: boolean;
        incomplete?: { path?: string; group?: string; relation?: string; reason?: string }[];
        stopReason?: { kind?: string; code?: string; phase?: string; reason?: string };
        cancelled?: boolean;
        /** R2：本次是「只重试子集」时的过滤账目（missing=已找不到，invalid=非法路径被忽略） */
        retryFilter?: { requested?: number; matched?: number; missing?: string[]; invalid?: string[] };
      }
    | undefined;
  const importErrors = result?.errors ?? [];
  /** REQ-20261019-002：本次跳过重复的计数与明细（旧 daemon 无字段 → 0 / 空） */
  const duplicatesSkippedCount = result?.stats?.files?.duplicatesSkipped ?? 0;
  const duplicatesSkippedList = result?.duplicatesSkipped ?? [];
  /**
   * R4（2026-10-10）：「同名处理」摘要要区分 skip 的两种成因——
   * ① `already-imported`：本文件此前已导入（同 sourcePath），跳过 = 不重算；
   * ② 其他：同 Group 内同名但来源不同，才是真正的"同名冲突"。
   * 旧文案把两者都写成「同名冲突 N 个」，会让"重导同一目录"的正常跳过看起来像撞名。
   */
  const conflictSummary = (() => {
    const items = result?.conflicts ?? [];
    if (items.length === 0) return '';
    const count = (predicate: (item: { action?: string; skipReason?: string; unchanged?: boolean }) => boolean): number =>
      items.filter(predicate).length;
    const alreadyImported = count((item) => item.action === 'skip' && item.skipReason === 'already-imported');
    const sameNameSkipped = count((item) => item.action === 'skip' && item.skipReason !== 'already-imported');
    // `unchanged` 的条目虽然判定为 overwrite，实际被「内容未变」跳过 ⇒ 不能算进「同名覆盖」
    const overwritten = count((item) => item.action === 'overwrite' && !item.unchanged);
    const unchanged = count((item) => item.unchanged === true);
    const suffixed = count((item) => item.action === 'suffix');
    const parts = [
      alreadyImported > 0 ? `已存在跳过 ${alreadyImported} 个` : '',
      sameNameSkipped > 0 ? `同名跳过 ${sameNameSkipped} 个` : '',
      overwritten > 0 ? `同名覆盖 ${overwritten} 个` : '',
      suffixed > 0 ? `另存后缀 ${suffixed} 个` : '',
      // 明确「这是同名冲突里的一部分」：否则会和文件级的「其中未变跳过重算 N」形成两个"未变"数字
      unchanged > 0 ? `同名冲突 ${unchanged} 个（内容未变，未覆盖）` : '',
    ].filter(Boolean);
    return parts.length > 0 ? `，${parts.join('，')}` : '';
  })();
  const importPercent = job?.progress && job.progress.total > 0
    ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
    : null;
  const uploadPercent = uploadStats && uploadStats.totalFiles > 0
    ? Math.min(100, Math.round((uploadStats.filesDone / uploadStats.totalFiles) * 100))
    : null;
  // 等待确认时上传已 100% 完成：沿用上传百分比（不落到 importPercent 的 null → 无限滚动条）
  const activePercent = activePercentOf(phase, uploadPercent, importPercent);
  const errorStatus = errorStatusOf(failureStage);
  const retryUploadPlan = uploadPlanRef.current;
  const completedScope = job?.scope || uploadPlanRef.current?.scope || scope;
  /**
   * 该 scope 是否已有导入在跑 —— 「重试未完成」的并发闸门判据（2026-10-13 用户反馈：
   * 连点两次各起一个 job，重复处理同一批文件）。与任务页共用 `['tasks']` 缓存；
   * 判据函数 `activeImportCount` 与服务端 409 同口径（只算 `queued` / `running`）。
   */
  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(200),
    staleTime: 5_000,
    // 定期刷新：该判据决定「重试未完成」按钮是否可点，快照过期会让禁用态与后端 409 脱节
    // （2026-10-13 评审 P2）。只在有 job 结果时轮询（无 job 就没有重试按钮，判据无用）；
    // 后台标签页不轮询（react-query 默认）。
    refetchInterval: job ? 5_000 : false,
    retry: 1,
  });
  const scopeBusyImports = activeImportCount(tasksQuery.data?.tasks, completedScope || scope);

  /**
   * R2（REQ-20261009-001）：「重试未完成 N 篇」。
   * 部分成功后，未完成清单随任务结果下发（`job.result.incomplete`）；重试**复用同一 uploadId**
   * 直接调 /api/import/run + `onlyRelPaths`——不必重新上传，已完成文件不重算 embedding
   * （守 #3：无 `_1` 副本、已完成 `memoryId` 不变）。
   */
  const incompleteItems = result?.incomplete ?? [];
  const partialFiles = result?.stats?.files;
  const showPartial = Boolean(result?.partial) && incompleteItems.length > 0;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // 同帧双击必须靠 ref 挡（state 更新是异步的，两次点击都会通过 state 判定）
  const retryRef = useRef(false);
  const startRetry = async (): Promise<void> => {
    if (retryRef.current || retrying || busyPhase) return;
    // 并发闸门（与服务端 409 同口径）：该 scope 已有导入在跑时不再排一个重复 job
    if (scopeBusyImports > 0) {
      setRetryError(`该知识库已有导入任务在跑（${scopeBusyImports} 个）：请等它完成后再重试未完成`);
      return;
    }
    const plan = uploadPlanRef.current;
    // 刷新/重进页面后 plan 已不在内存，但凭据仍指向同一 uploadId（R2 部分成功时特意保留）
    const uploadId = plan?.uploadId ?? readImportCredential()?.uploadId;
    if (!uploadId) {
      setRetryError('重试入口已失效：请重新选择文件后再导入');
      return;
    }
    const paths = incompleteItems.map((item) => item.path).filter((p): p is string => Boolean(p));
    if (paths.length === 0) {
      setRetryError('没有可重试的未完成文件');
      return;
    }
    const retryScope = plan?.scope ?? completedScope ?? scope;
    const retryFinalize = plan?.finalize ?? {
      group: group.trim() || undefined,
      chunkSize: chunkSize ? Number(chunkSize) : undefined,
      chunkOverlap: chunkOverlap ? Number(chunkOverlap) : undefined,
      vector,
      tags: selectedTags.length > 0 ? selectedTags.join(',') : undefined,
      conflictMode,
      conflictSuffix: suffixInUse ? conflictSuffix : undefined,
    };
    // 校验段无 await，故在此处置位即可挡住同帧双击（后面的早退分支不会污染置位）
    retryRef.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await runImport({
        scope: retryScope,
        uploadId,
        ...retryFinalize,
        onlyRelPaths: paths,
      });
      if (!response.ok || !response.jobId) throw new Error(response.error ?? '重试启动失败');
      trackImport(response.jobId, retryScope, uploadId);
      // 立即让并发判据看到这个新任务（否则按钮的禁用态要等到下一次轮询才更新）
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (retryFailure) {
      setRetryError(`重试未完成失败：${retryFailure instanceof Error ? retryFailure.message : String(retryFailure)}`);
    } finally {
      retryRef.current = false;
      setRetrying(false);
    }
  };
  /**
   * 「开始导入」被阻塞的原因。不靠「按钮灰掉」表达——按钮保持可点，
   * 点了会把原因说出来并滚动定位到对应字段（否则用户只看到一片灰，无从下手）。
   */
  /** 「新建 Scope」输入框里有未确认草稿（且与已确认目标不同）——必须先回车，否则会导入到旧 scope */
  const pendingScope = scopeDraft.trim();
  const scopeDraftDirty = pendingScope.length > 0 && pendingScope !== scope;
  const runBlockedReason = scopeDraftDirty
    ? `「${pendingScope}」还没确认，请按回车确认新建的 Scope`
    : !scopeConfirmed
      ? '请先在上方确认目标 Scope，再开始导入'
      : files.length === 0
        ? '请先选择要导入的 Markdown 文件或目录'
        : null;
  /** 点击「开始导入」：被阻塞则引导定位，否则真正开跑 */
  const runClick = (): void => {
    // R6：预检待确认时不允许再点（否则会以新 uploadId 重新上传整批）。
    // 按钮此时 `disabled={busyPhase}`（awaiting-confirm 属 busy），这里只是防御性兜底。
    if (preflightConfirm) return;
    const target = scopeDraftDirty || !scopeConfirmed ? 'scope' : files.length === 0 ? 'files' : null;
    if (target) {
      (target === 'scope' ? scopeFieldRef : dropzoneRef).current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      setAttention(target);
      window.setTimeout(() => setAttention(null), 1300);
      return;
    }
    void start();
  };
  const buttonStatus = error
    ? errorStatus
    : phase === 'done'
      ? '导入完成'
      : phase === 'failed'
        ? errorStatus
        : runBlockedReason ?? (progressText || '直导无需 AI · 无第三方依赖');

  // 右轨常显（对齐 demo：打开即双栏）；阶段徽标复用任务状态色。
  // 文案/色调/取消判据统一由 `lib/importPhase.ts` 给出（那里有单测锁语义）
  const trackLabel = trackLabelOf(phase, failureStage);
  const trackTone = trackToneOf(phase, failureStage);
  /**
   * 「查看结果」入口（2026-10-19）：完成态的结果摘要位于右轨第二张卡。
   * 双栏靠 sticky 能看见进度卡，但结果卡在下方/视口外——用户只看到按钮旁
   * 「导入完成」却不知道去哪看数字，故给一个显式入口（不自动滚动，避免打断「再导一次」）。
   * 与页内既有 `preflightRef` / `runClick` 同口径：尊重 prefers-reduced-motion + 移交焦点。
   *
   * ⚠️ 不用 `scrollIntoView({ block: 'start' })` 的原因与「为什么这里不需要 sticky 偏移」：
   * 该入口只在 `phase === 'done'` 渲染，而 `.ki-import-track[data-phase='done']` 已让进度卡
   * 退出 sticky（见 ki.css）。若只做 `block:'start'`，历史版本里结果卡会被常驻的进度卡压住；
   * 现在终态常驻已取消，直接对齐容器顶部即可——一旦有人改回终态 sticky，
   * `verify-import-progress-visibility.cjs` 的 D2b/D3 会立刻失败提醒。
   * 偏移统一换算到**滚动容器坐标系**（减去容器自身 top），这样将来壳层加固定头也不会多滚。
   */
  const showResultCard = (): void => {
    const card = resultCardRef.current;
    if (!card) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const scrollerEl = card.closest('.ki-content');
    const scroller = scrollerEl instanceof HTMLElement ? scrollerEl : null;
    // 只有真正可滚动的容器才走偏移算法：`.ki-content` 若挂 `--noscroll`（overflow:hidden）则
    // scrollTo 不生效、会变成"点了没反应"，此时退回 scrollIntoView。
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const delta = card.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top
        - 8;
      scroller.scrollTo({
        top: scroller.scrollTop + delta,
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    } else {
      card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
    card.focus({ preventScroll: true });
  };
  /** 主区按钮行的就地进度（复用右轨同一份百分比与阶段文案，不另算） */
  const busyPhaseLabel = busyPhaseLabelOf(phase);
  // 「忙」与「有文案」由 Record + 单测锁成同集合，这里只判文案，避免两处判据各自漂移
  const showInlineProgress = busyPhaseLabel.length > 0;
  /** 就地进度右侧的数量细节：只搬运已有统计（上传按篇 / 导入按处理单元），不新增口径 */
  const inlineDetail = phase === 'uploading' && uploadStats
    ? `${uploadStats.filesDone}/${uploadStats.totalFiles} 篇`
    : phase === 'awaiting-confirm'
      ? '等待确认'
      : phase === 'importing' && job?.progress?.total
        ? `${job.progress.done}/${job.progress.total} 个处理单元`
        /**
         * 数量未知时退回阶段说明：`progressText` 在导入起步阶段承载真实信息
         * （「正在比对库内文档并跳过疑似重复…」等，见 launchImport / runImport 前），
         * 改前这句显示在主区按钮旁，改成就地进度后不能把它弄丢（单列布局时右轨在视口外）。
         * 过滤掉与按钮 / 阶段标签重复的三句，避免又出现「导入中…」刷屏。
         */
        : (phase === 'importing' || phase === 'uploading') && progressText
          && progressText !== busyPhaseLabel
          && progressText !== '导入中…'
          && progressText !== '上传中…'
          ? progressText
          : '';
  const doneClean = phase === 'done' && !error;
  // 取消导入（POST /api/import/cancel）：服务端在当前批次完成后停止后续写入
  const requestCancel = async (): Promise<void> => {
    const jobId = job?.id;
    if (!jobId) {
      setCancelState('failed');
      setCancelError('任务尚未建立：上传完成后、进入导入阶段即可取消');
      return;
    }
    setCancelState('pending');
    setCancelError('');
    try {
      await cancelImport(jobId);
      setCancelState('requested');
    } catch (err) {
      setCancelState('failed');
      setCancelError(err instanceof Error ? err.message : '取消请求失败');
    }
  };

  return (
    <>
      <div className="ki-page-head">
        <div>
          <p>目标：{scopeConfirmed ? scope : '请选择并确认本次导入的 Scope'} · 直导无需 AI · 无第三方依赖 · 幂等追加（重复导入即增量）</p>
        </div>
      </div>

      <div className="ki-import-layout">
      <div className="ki-card">
        <div className="ki-card__head">
          <span className="ki-card__title">
            <span className="ki-track-kicker">UPLOAD</span>
            <span style={{ display: 'block', marginTop: 2 }}>导入设置</span>
          </span>
          <span className="ki-card__sub">
            {scopeConfirmed ? `${scope}${group ? ` / ${group}` : ''}` : '目标待确认'}
          </span>
        </div>
        <div className="ki-card__body" style={{ padding: 20 }}>
          {/* 拖拽区 */}
          <div
            ref={dropzoneRef}
            className={`ki-dropzone${dragOver ? ' ki-dropzone--over' : ''}${attention === 'files' ? ' ki-attention' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="ki-dropzone__icon">
              <Icon name="upload" />
            </div>
            <div className="ki-dropzone__title">拖拽 Markdown 文件或目录到此处，或点击选择</div>
            <div className="ki-dropzone__hint">
              文档：{importPolicy.extensions.join(', ')}；Markdown 引用的图片附件会一并处理，其他文件自动跳过
            </div>
            <div className="ki-dropzone__actions">
              <button
                className="ki-btn ki-btn--secondary ki-btn--small"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (fileInput.current) {
                    fileInput.current.value = '';
                    fileInput.current.click();
                  }
                }}
              >
                选择文件
              </button>
              <button
                className="ki-btn ki-btn--secondary ki-btn--small"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openDirPicker();
                }}
              >
                选择目录
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={[...importPolicy.extensions, ...(importPolicy.assets ? importPolicy.assetExtensions : [])].join(',')}
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
          {/* Scope 与 Group 竖排（各占整行），不走左右两列 */}
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div ref={scopeFieldRef} className={attention === 'scope' ? 'ki-attention' : undefined}>
              <ScopePathSelect
                key={formEpoch}
                value={scope}
                confirmed={scopeConfirmed}
                currentScope={currentScope}
                onChange={(value, confirmed) => {
                  if (value !== scope) {
                    setGroup('');
                    setAvailableTags([]);
                    setSelectedTags([]);
                  }
                  setScope(value.trim());
                  setScopeConfirmed(confirmed);
                }}
                placeholder="按名称筛选已有 Scope，如：kafka"
                onDraftChange={setScopeDraft}
                hint="每次开始导入前都要重新确认目标；选择新建后提交时会自动创建 Scope。"
                error={scopeErr}
                disabled={busyPhase}
              />
            </div>
            <div>
              <label className="ki-form-label">Group 路径（可选，导入根目录）</label>
              <GroupPathSelect
                scope={scope || currentScope}
                value={group}
                onChange={setGroup}
                placeholder="选择或输入 Group 路径，如：wiki/我的文档"
                hint={scopeConfirmed ? "留空则按文件所在子目录各建根节点（根目录下的散文件归 scope 名称）；选择后文件写入该路径下并保留相对目录结构。禁止包含 \\ 和 .." : '下拉来自当前 Scope；开始导入前需确认上方目标 Scope。'}
                error={groupErr}
              />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="ki-form-label">同名文档处理</label>
            <div className="ki-form-row">
              <div className="ki-form-group">
                <select
                  className="ki-form-input"
                  value={conflictMode}
                  onChange={(e) => setConflictMode(e.target.value as ImportConflictMode)}
                >
                  <option value="incremental">增量导入（推荐：内容未变的文件不重算）</option>
                  <option value="suffix">自动添加后缀</option>
                  <option value="overwrite">覆盖已有文档</option>
                  <option value="skip">跳过同名文件（已存在的一律不动，只导入新文件）</option>
                </select>
              </div>
              <div className="ki-form-group">
                <input
                  className={`ki-form-input${conflictSuffixErr ? ' ki-form-input--error' : ''}`}
                  value={conflictSuffix}
                  disabled={conflictMode !== 'suffix'}
                  onChange={(e) => setConflictSuffix(e.target.value)}
                  placeholder="_{n}"
                  aria-label="自动后缀模板"
                  title={conflictMode === 'suffix'
                    ? '自动后缀模板：{n} 会替换为递增序号（如 _{n} → foo_1、foo_2）'
                    : '仅「自动添加后缀」策略生效；当前策略不会使用后缀'}
                />
                {conflictSuffixErr && <div className="ki-form-error">{conflictSuffixErr}</div>}
              </div>
            </div>
            {/* 策略说明随所选策略切换：`skip` 的代价（改过的正文也不会更新）必须就地可见——
                「跳过」的字面语义容易让用户以为"内容变了会同步"，实际只按 sourcePath 判定。
                另：此前的固定文案里混入了 Markdown 粗体 `**`，在 JSX 文本里会原样显示成星号。 */}
            <div className="ki-form-hint">
              {conflictMode === 'skip'
                ? '跳过同名：库中已存在的文档一律不处理（不改正文、不重算向量、不复制附件），只导入新文件。⚠️ 正文改过的也不会更新——需要同步修改请改用「增量导入」或「覆盖已有文档」。'
                : conflictMode === 'incremental'
                  ? '增量导入：同一文件内容未变则跳过重算（不重切分、不重算向量），内容变了照常更新；同名不同来源直接覆盖。'
                  : conflictMode === 'overwrite'
                    ? '覆盖已有文档：同名的已有文档一律用本次内容覆盖（不比对内容，全部重新切分与向量化）。'
                    : `自动添加后缀：同名的已有文档保留不动，本次文件另存为 foo_1、foo_2…（后缀中的 {'{n}'} 从 1 递增）。`}
            </div>
          </div>

          {/* Tags（可选）：对本次导入的全部文件（目录/文件）生效 */}
          <div style={{ marginTop: 8 }}>
            <label className="ki-form-label">Tags（可选，对全部导入文件生效）</label>
            <div className="ki-combobox" ref={tagRef} style={{ width: '100%' }}>
              <div className="ki-combobox__input-wrap">
                <input
                  className={`ki-form-input${tagInputErr ? ' ki-form-input--error' : ''}`}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  placeholder="选择已有 tag 或输入新建，回车确认"
                  value={tagInput}
                  onChange={(e) => { setTagInput(e.target.value); if (tagInputErr) setTagInputErr(null); }}
                  onFocus={() => setTagOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
                  }}
                  autoComplete="off"
                  aria-invalid={tagInputErr ? true : undefined}
                />
                <button
                  type="button"
                  className={`ki-combobox__toggle${tagOpen ? ' ki-combobox__toggle--open' : ''}`}
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); setTagOpen((v) => !v); }}
                >
                  {tagOpen ? '▴' : '▾'}
                </button>
              </div>
              {tagOpen && (
                <div className="ki-combobox__panel ki-combobox__panel--open">
                  <div className="ki-combobox__tree" style={{ padding: '6px 8px', maxHeight: 180, overflowY: 'auto' }}>
                    {availableTags.length === 0 && !tagInput ? (
                      <div className="ki-cell-sub" style={{ padding: 6 }}>暂无已有 tag</div>
                    ) : (
                      <>
                        {availableTags
                          .filter((t) => !tagInput || t.includes(tagInput.toLowerCase()))
                          .map((t) => (
                            <span
                              key={t}
                              className={`ki-tag-option${selectedTags.includes(t) ? ' ki-tag-option--selected' : ''}`}
                              onClick={() => toggleTag(t)}
                            >
                              {selectedTags.includes(t) ? '✓ ' : '+ '}{t}
                            </span>
                          ))
                        }
                        {tagInput && !availableTags.some((t) => t === tagInput.toLowerCase()) && !selectedTags.includes(tagInput.toLowerCase()) && (
                          <span className="ki-tag-option" onClick={addTagFromInput} style={{ color: 'var(--ki-color-primary)' }}>
                            ✚ 新建：{tagInput.trim()}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="ki-combobox__footer">
                    <span className="ki-cell-sub">输入后按回车确认；新建 tag 将自动加入</span>
                  </div>
                </div>
              )}
            </div>
            {/* Tags 芯片（对齐 demo .chips：已有标签点击即选中/取消；新建的标签也在其中，点击移除） */}
            {(availableTags.length > 0 || selectedTags.length > 0) && (
              <div className="ki-chips" style={{ marginTop: 8 }} role="group" aria-label="文档标签">
                {availableTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`ki-chip${selectedTags.includes(t) ? ' ki-chip--on' : ''}`}
                    onClick={() => toggleTag(t)}
                    aria-pressed={selectedTags.includes(t)}
                  >
                    {t}
                  </button>
                ))}
                {selectedTags
                  .filter((t) => !availableTags.includes(t))
                  .map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="ki-chip ki-chip--on"
                      onClick={() => removeTag(t)}
                      title="移除此标签"
                      aria-pressed={true}
                    >
                      {t}
                      <span className="ki-chip__x" aria-hidden="true">✕</span>
                    </button>
                  ))}
              </div>
            )}
            {tagInputErr ? (
              <div className="ki-form-error">{tagInputErr}</div>
            ) : (
              <div className="ki-form-hint">选择后，本次导入（含上传目录与上传文件）的所有文档将带上这些标签，可在语义搜索按标签过滤。禁止包含 , / \ 和 ..</div>
            )}
          </div>

          {/* 文件清单 */}
          {selections.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="ki-import-summary">
                <span>待导入：<b>{selectedDocuments.length}</b> 个 Markdown</span>
                <span>附件：<b>{selectedAssets.length}</b> 个</span>
                {skippedFiles > 0 && (
                  <span className="ki-import-summary__skipped">
                    已跳过：<b>{skippedFiles}</b> 个（<b>{formatBytes(skippedBytes)}</b>）
                  </span>
                )}
                <span>大小：<b>{formatBytes(totalSelectedBytes)}</b></span>
              </div>
              {selections.map((selection) => {
                const totalSize = selection.files.reduce((sum, file) => sum + file.size, 0);
                return (
                  <div key={selection.id} className="ki-file-item">
                    <span
                      className={`ki-file-item__icon${selection.kind === 'directory' ? ' ki-file-item__icon--dir' : ''}`}
                    >
                      <Icon name={selection.kind === 'directory' ? 'folder' : 'file'} className="ki-icon ki-icon--sm" />
                    </span>
                    <div className="ki-file-item__meta">
                      <div className="ki-file-item__name">{selection.name}</div>
                      {selection.kind === 'directory' ? (
                        <div className="ki-file-item__size">
                          目录 · {selection.files.filter((file) => file.kind === 'document').length} 个 Markdown
                          {selection.files.some((file) => file.kind === 'asset') && ` · ${selection.files.filter((file) => file.kind === 'asset').length} 个附件`}
                          {selection.skippedFiles > 0 && ` · 跳过 ${selection.skippedFiles} 个`}
                          {' · '}{formatBytes(totalSize)}
                        </div>
                      ) : (
                        <div className="ki-file-item__size">{selection.files[0]?.kind === 'asset' ? '附件' : 'Markdown'} · {formatBytes(totalSize)}</div>
                      )}
                    </div>
                    {/* 任务在途时不许改清单：上传内容已冻结在 plan.batches，移除只会让
                        「画面上的文件」与「确认后真正导入的文件」不一致 */}
                    <button
                      className="ki-file-item__remove"
                      onClick={() => removeSelection(selection.id)}
                      disabled={busyPhase}
                      title={busyPhase ? '任务进行中，暂不可移除文件' : '移除'}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 高级选项 */}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="ki-adv-toggle" onClick={() => setAdvOpen((v) => !v)}>
              切分参数（高级）
            </button>
            {advOpen && (
              <div className="ki-adv-body">
                <div className="ki-form-row">
                  <div className="ki-form-group">
                    <label className="ki-form-label">Chunk Size（字符）</label>
                    <input
                      className="ki-form-input"
                      type="number"
                      value={chunkSize}
                      min={100}
                      max={4000}
                      onChange={(e) => setChunkSize(e.target.value)}
                    />
                  </div>
                  <div className="ki-form-group">
                    <label className="ki-form-label">Chunk Overlap（字符）</label>
                    <input
                      className="ki-form-input"
                      type="number"
                      value={chunkOverlap}
                      min={0}
                      max={500}
                      onChange={(e) => setChunkOverlap(e.target.value)}
                    />
                  </div>
                </div>
                <div className="ki-form-hint">切分规则：段落边界优先（\n\n → \n → 。 → ；），超过上限强制按长度切。</div>
              </div>
            )}
          </div>

          {/* 向量化开关 */}
          {vector && importConfig?.scope === scope && importConfig.vectorDimension?.compatible === false && (
            <div className="ki-form-error" role="alert" style={{ marginTop: 12 }}>
              当前 embedding 为 {importConfig.vectorDimension.configured} 维，旧向量集合为 {importConfig.vectorDimension.persisted} 维。
              请先执行 <code>ki restore {scope} --rebuild-vector --yes</code>；完成后刷新页面再导入。全文检索仍可使用。
            </div>
          )}
          <div className="ki-vec-switch" style={{ marginTop: 12 }}>
            <div className="ki-vec-switch__label">
              <span className="ki-vec-switch__title">向量化</span>
              <span className="ki-vec-switch__desc">生成 dense 向量，可被语义搜索；关闭则写入 FTS-only 全文索引，不调用 embedding</span>
            </div>
            <div
              className={`ki-switch${vector ? ' ki-switch--on' : ''}`}
              role="switch"
              aria-checked={vector}
              onClick={() => setVector((v) => !v)}
            >
              <div className="ki-switch__knob" />
            </div>
          </div>

          {/* R6：重复导入预检待确认（导入尚未开始 → 取消是零写入）
              2026-10-19 改版：原先是"一句长标题 + 5 条 ul + 一行说明"，信息平铺、行内塞 4 个字段、
              截断时还会吞掉后果说明。现改为：标题/副标题分层 + 两列对照表（可滚动、可展开）+
              常驻后果说明 + 动作文案带后果。 */}
          {preflightConfirm && phase === 'awaiting-confirm' && (
            <div
              ref={preflightRef}
              className="ki-preflight"
              role="alertdialog"
              aria-labelledby="ki-preflight-title"
              aria-describedby="ki-preflight-sub"
              tabIndex={-1}
            >
              <div className="ki-preflight__head">
                <span className="ki-preflight__icon" aria-hidden="true">
                  <Icon name="warn" className="ki-icon ki-icon--sm" />
                </span>
                <div className="ki-preflight__headtext">
                  <div className="ki-preflight__title" id="ki-preflight-title">
                    {preflightConfirm.matched} 篇内容与库中已有文档重复
                  </div>
                  <p className="ki-preflight__sub" id="ki-preflight-sub">
                    内容一致、来源路径不同；继续导入会按上方「同名文档处理」策略处理。
                  </p>
                </div>
                <span className="ki-preflight__count">重复 {preflightConfirm.matched}</span>
              </div>

              <div className="ki-preflight__list" id="ki-preflight-list">
                <div className="ki-preflight__cols" aria-hidden="true">
                  <span>本次文件</span>
                  <span />
                  <span>库中已有</span>
                </div>
                {(showAllPreflight ? preflightConfirm.duplicates : preflightConfirm.duplicates.slice(0, 5)).map((item) => (
                  <div className="ki-preflight__row" key={`${item.rel}\u0000${item.existingRelation}`}>
                    <span className="ki-preflight__file" title={item.rel}>{item.rel}</span>
                    <span className="ki-preflight__arrow" aria-hidden="true">→</span>
                    <span
                      className="ki-preflight__existing"
                      title={`${item.existingRelation}${item.existingGroup ? ` · ${item.existingGroup}` : ''}${item.existingSourcePath ? ` · 来源 ${item.existingSourcePath}` : ' · 来源未记录'}`}
                    >
                      <b>{item.existingRelation}</b>
                      {item.existingGroup ? <span className="ki-preflight__group">· {item.existingGroup}</span> : null}
                    </span>
                  </div>
                ))}
              </div>

              <div className="ki-preflight__meta">
                <span>
                  {preflightConfirm.duplicates.length < preflightConfirm.matched
                    ? `已列出 ${preflightConfirm.duplicates.length} 篇，另有 ${preflightConfirm.matched - preflightConfirm.duplicates.length} 篇未回传明细`
                    : `共 ${preflightConfirm.duplicates.length} 篇`}
                  {!showAllPreflight && preflightConfirm.duplicates.length > 5 ? ' · 仅显示前 5 条' : ''}
                </span>
                {preflightConfirm.duplicates.length > 5 && (
                  <button
                    type="button"
                    className="ki-preflight__toggle"
                    aria-expanded={showAllPreflight}
                    aria-controls="ki-preflight-list"
                    onClick={() => setShowAllPreflight((value) => !value)}
                  >
                    {showAllPreflight ? '收起' : `展开全部 ${preflightConfirm.duplicates.length} 条`}
                  </button>
                )}
              </div>

              <p className="ki-preflight__note">
                本批共 {preflightConfirm.scanned} 篇：其中 {preflightConfirm.matched} 篇疑似重复、
                其余 {newFileCount} 篇将按当前设置处理；取消不会写入任何内容。
              </p>

              <div className="ki-preflight__actions">
                <button
                  type="button"
                  className="ki-btn ki-btn--primary ki-btn--small"
                  onClick={skipDuplicateImport}
                  disabled={!canSkipDuplicates}
                  title={canSkipDuplicates
                    ? `跳过这 ${preflightConfirm.matched} 篇疑似重复，导入其余 ${newFileCount} 篇`
                    : '全部文件均为疑似重复，跳过将不导入任何文件；如需建副本请点「仍然导入」'}
                >
                  跳过重复文档
                </button>
                <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={confirmDuplicateImport}>
                  仍然导入（会新建副本）
                </button>
                {/* 退出动线用 ghost：三个动作里它最弱 */}
                <button type="button" className="ki-btn ki-btn--ghost ki-btn--small" onClick={cancelDuplicateImport}>
                  取消
                </button>
              </div>
              {!canSkipDuplicates && (
                <p className="ki-form-hint">
                  全部 {preflightConfirm.scanned} 篇均为疑似重复，跳过将不导入任何文件；如需建副本请点「仍然导入」。
                </p>
              )}
            </div>
          )}
          {/* 按钮行（2026-10-19）：右轨进度已常驻，但用户视线在按钮上——
              就地再给一条细进度条，避免「按钮灰着、不知道到底在动没动」。 */}
          <div className="ki-import-runrow">
            <button
              className="ki-btn ki-btn--primary"
              onClick={runClick}
              disabled={busyPhase}
              title={runBlockedReason
                ?? (phase === 'awaiting-confirm' ? '请先在上方「重复导入预检」中选择「仍然导入」或「取消」' : undefined)}
            >
              {/* 按钮用**短**文案（宽度受限）：与右轨 `busyPhaseLabelOf` 的长文案有意不同
                  （「等待确认」↔「上传完成，等待确认」），就地进度的 aria-label 用长文案。
                  改这里请同步 lib 单测，别让两处各自演化。 */}
              {phase === 'scanning' ? '读取目录中…' : phase === 'uploading' ? '上传中…' : phase === 'awaiting-confirm' ? '等待确认' : phase === 'importing' ? '导入中…' : '开始导入'}
            </button>
            {/* 忙阶段由这条就地进度接管：进度条与按钮**同一行**，避免按钮贴视口底时
                进度被顶到视口外；阶段文案已由按钮本身表达，这里只给百分比 + 数量，
                不再重复写一遍 progressText（否则会凑出三个「导入中…」）。 */}
            {showInlineProgress ? (
              <div className="ki-import-inline">
                <div
                  className="ki-progress ki-progress--inline"
                  role="progressbar"
                  aria-label={busyPhaseLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={activePercent ?? undefined}
                >
                  <div
                    className={`ki-progress__fill${activePercent === null ? ' ki-progress__fill--indeterminate' : ''}`}
                    style={activePercent === null ? undefined : { width: `${activePercent}%` }}
                  />
                </div>
                {/* 百分比未知（刚起步）时不写文案：阶段已由按钮表达，
                    再补一句「导入中…」就是同一个页面里的第三份。 */}
                {activePercent !== null && (
                  <span className="ki-import-inline__pct">{activePercent}%</span>
                )}
                {inlineDetail && <span className="ki-import-inline__detail">{inlineDetail}</span>}
              </div>
            ) : (
              <span
                className="ki-cell-sub"
                style={runBlockedReason ? { color: 'var(--ki-color-warning)' } : undefined}
              >
                {buttonStatus}
              </span>
            )}
            {doneClean && (
              <button type="button" className="ki-btn ki-btn--ghost ki-btn--small" onClick={showResultCard}>
                查看结果 →
              </button>
            )}
          </div>
        </div>
      </div>

      {/* data-phase 供 CSS 判断「是否还在进行中」：终态要让进度卡退出 sticky，
          否则它会常驻顶部、把下方结果摘要的长内容遮掉 107px（结果卡在它后面滑过）。 */}
      <aside className="ki-import-track" data-phase={phase} aria-label="当前任务">
        {/* 卡 1：导入进度（idle 也常显，对齐 demo） */}
        <div className="ki-progress-block">
          <div className="ki-track-head">
            <span className="ki-track-kicker">PROGRESS</span>
            <span className={`ki-task-state ki-task-state--${trackTone}`}>{trackLabel}</span>
          </div>
          <div className="ki-track-title">导入进度</div>
          {busyPhase ? (
          <>
          <div className="ki-progress-row">
            <span className="ki-progress-label">
              {/* 等待确认不是"进行中"：不转圈，避免用户以为还在跑。
                  文案与主区按钮行共用 `busyPhaseLabelOf`（唯一来源，见 lib/importPhase.ts） */}
              {phase !== 'awaiting-confirm' && <span className="ki-spinner" aria-hidden="true" />}
              {busyPhaseLabel}
            </span>
            <span className="ki-cell-sub">{progressText}</span>
          </div>
          <div className="ki-progress">
            <div
              className={`ki-progress__fill${activePercent === null ? ' ki-progress__fill--indeterminate' : ''}`}
              style={activePercent === null ? undefined : { width: `${activePercent}%` }}
            />
          </div>
          <div className="ki-progress-sub">
            {phase === 'uploading' && uploadStats
              ? `第 ${uploadStats.batch}/${uploadStats.totalBatches} 批 · ${uploadStats.filesDone}/${uploadStats.totalFiles} 个文件 · ${formatBytes(uploadStats.bytesDone)}/${formatBytes(uploadStats.totalBytes)}（${uploadPercent ?? 0}%）`
              : phase === 'awaiting-confirm'
                ? (uploadStats
                  ? `第 ${uploadStats.batch}/${uploadStats.totalBatches} 批 · ${uploadStats.filesDone}/${uploadStats.totalFiles} 个文件已上传（${uploadPercent ?? 0}%，尚未写入任何内容）`
                  : '上传已完成，尚未写入任何内容')
                : phase === 'importing' && job?.progress
                  ? `${job.progress.done}/${job.progress.total} 个处理单元（${importPercent ?? 0}%）`
                  : progressText}
          </div>
          <div className="ki-progress-actions">
            {phase === 'awaiting-confirm' ? (
              // 「取消导入」此刻必然是禁用态（job 未建立），显示它只会让用户以为能点
              <span className="ki-cell-sub">请在上方预检卡片中选择「仍然导入」或「取消」</span>
            ) : cancelState === 'requested' ? (
              <span className="ki-cell-sub">已请求取消：当前批次完成后停止后续写入</span>
            ) : (
              <button
                className="ki-btn ki-btn--secondary ki-btn--small"
                type="button"
                disabled={!job?.id || cancelState === 'pending'}
                title={job?.id ? '请求取消导入（当前批次完成后停止）' : '上传完成后、进入导入阶段即可取消'}
                onClick={() => void requestCancel()}
              >
                {cancelState === 'pending' ? '请求中…' : '取消导入'}
              </button>
            )}
            {cancelState === 'failed' && <span className="ki-cell-sub">取消失败：{cancelError}</span>}
          </div>
          </>
          ) : (
            <p className="ki-cell-sub" style={{ marginTop: 8 }}>
              {phase === 'idle' ? '等待开始：选择文件并确认 Scope 后点击「开始导入」。'
                : phase === 'done' ? '本次导入已结束，结果见下方「结果摘要」。'
                  : phase === 'cancelled' ? '导入已取消：未写入任何内容；可调整设置后重新点击「开始导入」。'
                    : isCancelledTrack(phase, failureStage) ? '导入已取消：已处理的内容可能已写入，请到目标 Scope 确认实际结果。'
                      : '本次导入未完成，可在主区修正后重试。'}
            </p>
          )}
        </div>

      {error && (
        <div className="ki-empty">
          <div>
            <h3>{errorStatus}</h3>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</p>
            {failureStage === 'upload' && failedUploadBatch !== null && retryUploadPlan && canRetryUpload() && (
              <div className="ki-empty__actions">
                <button className="ki-btn ki-btn--primary ki-btn--small" onClick={() => void retryUpload()}>
                  重试第 {failedUploadBatch + 1}/{retryUploadPlan.batches.length} 批
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {uploadErrors.length > 0 && (
        <div className="ki-import-errors" role="alert">
          <div className="ki-import-errors__title">部分文件未上传（{uploadErrors.length}）</div>
          <p className="ki-cell-sub" style={{ marginTop: 4 }}>
            这些文件没有到达服务端，不在「未完成清单」里——「重试未完成」不会覆盖它们，需重新选择后再导入。
          </p>
          <ul>
            {uploadErrors.map((item, index) => (
              <li key={`${item.name}-${index}`}>{item.name}：{item.error}</li>
            ))}
          </ul>
        </div>
      )}

        {/* 卡 2：结果摘要（对齐 demo LAST RUN）
            不参与 sticky：含冲突/错误长列表，长度不可控，限制在 100vh 内会读不全。
            `tabIndex` 只服务于「查看结果」入口的焦点移交。 */}
        <div className="ki-progress-block" ref={resultCardRef} tabIndex={-1}>
          <div className="ki-track-head">
            <span className="ki-track-kicker">LAST RUN</span>
            {phase === 'done' && !error && (
              <span className={`ki-task-state ki-task-state--${showPartial ? 'partial' : 'succeeded'}`}>
                {showPartial
                  ? `部分成功（完成 ${partialFiles?.completed ?? '?'} / 未完成 ${partialFiles?.incomplete ?? incompleteItems.length}）`
                  : importErrors.length > 0 || uploadErrors.length > 0 ? '完成（有错误）' : '已完成'}
              </span>
            )}
            {/* S-02/S-03（REQ-20261009-003）：索引整理（二级口径）——「文档可用」与「索引已优化」
                是两件事，必须分开呈现，且不得让用户把"整理中"误读成"导入没完成"。 */}
            {phase === 'done' && !error && job?.indexState && job.indexState !== 'skipped' && (
              <span
                className={`ki-task-state ki-task-state--${job.indexState === 'optimized' ? 'succeeded' : job.indexState === 'indexing' ? 'running' : 'partial'}`}
                title={job.indexMaintenanceDegraded?.reason ?? undefined}
              >
                {job.indexState === 'indexing'
                  ? '索引整理中…'
                  : job.indexState === 'optimized' ? '索引已优化' : '索引整理未完成（可重试）'}
              </span>
            )}
          </div>
          <div className="ki-track-title">结果摘要</div>
          {phase === 'done' && !error ? (
            <>
              <p className="ki-cell-sub" style={{ marginTop: 8 }}>
              {result?.stats
                ? `已处理 ${result.stats.total ?? 0} 个分片 / ${result.stats.vectorized ?? 0} 个向量化，错误 ${result.stats.errors ?? 0}${conflictSummary}`
                : '导入已完成，可前往搜索验证。'}
              {typeof partialFiles?.scanned === 'number'
                ? `　文件级：扫描 ${partialFiles.scanned}（完成 ${partialFiles.completed ?? 0} / 未完成 ${partialFiles.incomplete ?? 0} / 跳过 ${partialFiles.skipped ?? 0}${partialFiles.unchanged ? ` / 其中未变跳过重算 ${partialFiles.unchanged}` : ''}）`
                : ''}
            </p>
            {/* REQ-20261019-002：跳过重复的结果（与"文件级跳过"并存，不重复计数） */}
            {duplicatesSkippedCount > 0 && (
              <div className="ki-cell-sub" style={{ marginTop: 4 }}>
                已跳过 {duplicatesSkippedCount} 篇疑似重复（未写入知识库）。
                {result?.duplicatesSkippedTruncated
                  ? ` 仅展示前 ${duplicatesSkippedList.length} 条，共 ${duplicatesSkippedCount} 条。`
                  : ''}
                {duplicatesSkippedList.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary>查看跳过的 {duplicatesSkippedList.length} 篇</summary>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0, overflowWrap: 'anywhere' }}>
                      {duplicatesSkippedList.map((item) => (
                        <li key={item.path}>
                          {item.path} ↔ 已有「{item.existingRelation}」（{item.existingGroup}）
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {/* S-02/S-03：两级完成口径的说明文案（整理期文档照常可用；失败只降级、不谎报导入失败） */}
            {job?.indexState === 'indexing' && (
              <p className="ki-cell-sub" style={{ marginTop: 4 }}>
                ⏳ 引擎正在后台整理索引（限核执行）：文档已可用，浏览与检索不受影响；整理完成后此处会显示「索引已优化」。
              </p>
            )}
            {job?.indexState === 'available' && (
              <p className="ki-cell-sub" style={{ marginTop: 4 }}>
                文档已可用；索引整理未完成（{job.indexMaintenanceDegraded?.degraded ?? 'error'}）——可在服务端执行
                {' '}<code>ki index-optimize -s {job.scope}</code> 重试（不需要重新导入）。
              </p>
            )}
            {showPartial && (
              <div className="ki-import-errors" role="alert">
                <div className="ki-import-errors__title">
                  部分成功：已完成 {partialFiles?.completed ?? '?'} 篇，未完成 {partialFiles?.incomplete ?? incompleteItems.length} 篇
                </div>
                <p className="ki-cell-sub" style={{ marginTop: 4 }}>
                  已完成的部分已提交，可正常浏览与检索；未完成的部分未写入。
                  {result?.stopReason?.reason ? `停止原因：${result.stopReason.reason}。` : ''}
                </p>
                <ul>
                  {incompleteItems.slice(0, 10).map((item, index) => (
                    <li key={`${item.path ?? 'incomplete'}-${index}`}>
                      {item.path ?? '文件'}{item.group ? `（${item.group}）` : ''}：{item.reason ?? '未完成'}
                    </li>
                  ))}
                  {incompleteItems.length > 10 && <li>…另有 {incompleteItems.length - 10} 个未完成文件</li>}
                </ul>
                {result?.retryFilter && (result.retryFilter.missing?.length || result.retryFilter.invalid?.length) ? (
                  <p className="ki-cell-sub" style={{ marginTop: 6 }}>
                    {/* 子集清单有两条来源：重试未完成、仅导入不重复；措辞保持中性 */}
                    本次只处理了清单中可用的文件
                    {typeof result.retryFilter.matched === 'number' ? `（命中 ${result.retryFilter.matched} 篇）` : ''}
                    {result.retryFilter.missing?.length ? `；${result.retryFilter.missing.length} 篇在当前暂存目录已找不到（已跳过）` : ''}
                    {result.retryFilter.invalid?.length ? `；${result.retryFilter.invalid.length} 条非法路径已忽略` : ''}
                    。
                  </p>
                ) : null}
                <div className="ki-track-actions">
                  <button
                    type="button"
                    className="ki-btn ki-btn--primary ki-btn--small"
                    onClick={() => void startRetry()}
                    disabled={retrying || scopeBusyImports > 0}
                  >{retrying ? '重试启动中…' : `重试未完成 ${incompleteItems.length} 篇`}</button>
                  {scopeBusyImports > 0 ? (
                    <span className="ki-cell-sub">
                      该知识库已有导入任务在跑（{scopeBusyImports} 个排队 / 进行中）：完成后再重试，避免重复处理同一批文件。
                    </span>
                  ) : null}
                </div>
                {retryError && <p className="ki-field-error" role="alert" style={{ marginTop: 6 }}>{retryError}</p>}
              </div>
            )}
            {result?.conflicts && result.conflicts.length > 0 && (
              <div className="ki-import-errors" role="status">
                <div className="ki-import-errors__title">同名处理结果（{result.conflicts.length}）</div>
                <ul>
                  {result.conflicts.slice(0, 10).map((item, index) => (
                    <li key={`${item.path ?? 'conflict'}-${index}`}>
                      {item.path ?? '文件'}：{item.unchanged
                        ? '内容未变，跳过重算（原文未改动）'
                        : item.action === 'skip' && item.skipReason === 'already-imported'
                          ? '已存在，跳过（不重算）'
                          : `${item.originalRelation ?? '文档'} → ${item.relation ?? '未命名'}（${item.action === 'skip' ? '同名，已跳过' : item.action === 'overwrite' ? '已覆盖' : '已加后缀'}）`}
                    </li>
                  ))}
                  {result.conflicts.length > 10 && <li>…另有 {result.conflicts.length - 10} 条</li>}
                </ul>
              </div>
            )}
            {importErrors.length > 0 && (
              <div className="ki-import-errors" role="alert">
                <div className="ki-import-errors__title">具体错误（{importErrors.length}）</div>
                <ul>
                  {/* 与同页冲突列表同口径截断：个别批次失败（如坏文本逐条隔离）也能上千条，
                      全量渲染既撑爆 DOM 也淹没真正要看的那几条。 */}
                  {importErrors.slice(0, 10).map((item, index) => (
                    <li key={`${item.path ?? 'error'}-${index}`}>
                      {item.path ? `${item.path}：` : ''}{item.error ?? '未知错误'}
                    </li>
                  ))}
                  {importErrors.length > 10 && <li>…另有 {importErrors.length - 10} 条</li>}
                </ul>
              </div>
            )}
            <div className="ki-track-actions">
              <Link
                className="ki-btn ki-btn--secondary ki-btn--small"
                to={{ pathname: '/browse', search: `?scope=${encodeURIComponent(completedScope)}` }}
              >查看目标 Scope →</Link>
              <Link
                className="ki-btn ki-btn--primary ki-btn--small"
                to={{ pathname: '/search', search: `?scope=${encodeURIComponent(completedScope)}` }}
              >
                前往搜索验证 →
              </Link>
            </div>
            </>
          ) : (
            <p className="ki-cell-sub" style={{ marginTop: 8 }}>完成一次导入后，这里显示处理分片、向量化、同名冲突与错误数。</p>
          )}
        </div>
      </aside>
      </div>
    </>
  );
}
