/**
 * ImportPage.tsx —— 上传导入（对齐 demo：拖拽区 + 文件清单 + 切分高级选项 + 向量化 switch + 进度条）
 *
 * scope 必选（default 兜底）→ 选文件/目录 → upload → run → 轮询 status → 进度/结果
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useScopeValue } from '@/lib/scopeContext';
import { getImportConfig, getImportStatus, runImport, uploadFiles, fetchTags, type ImportConfigResponse, type ImportJob, type ImportConflictMode } from '@/api/httpApi';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { ScopePathSelect } from '@/components/ScopePathSelect';
import { groupError, scopeError, tagError } from '@/lib/validators';

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
  batches: PendingFile[][];
  nextBatch: number;
  currentBatch: number;
  uploadId?: string;
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

export function ImportPage(): JSX.Element {
  const currentScope = useScopeValue();
  const [scope, setScope] = useState(currentScope);
  useEffect(() => setScope(currentScope), [currentScope]);
  const fileInput = useRef<HTMLInputElement>(null);

  const [importConfig, setImportConfig] = useState<ImportConfigResponse | null>(null);
  const importConfigOrFallback = importConfig ?? FALLBACK_IMPORT_CONFIG;
  const [selections, setSelections] = useState<PendingSelection[]>([]);
  const selectionSeq = useRef(0);
  const files = selections.flatMap((selection) => selection.files);
  const selectedDocuments = files.filter((file) => file.kind === 'document');
  const selectedAssets = files.filter((file) => file.kind === 'asset');
  const skippedFiles = selections.reduce((sum, selection) => sum + selection.skippedFiles, 0);
  const skippedBytes = selections.reduce((sum, selection) => sum + selection.skippedBytes, 0);
  const totalSelectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const importPolicy = importConfigOrFallback;
  const [advOpen, setAdvOpen] = useState(false);
  const [chunkSize, setChunkSize] = useState('1000');
  const [chunkOverlap, setChunkOverlap] = useState('150');
  const [vector, setVector] = useState(true);
  const [group, setGroup] = useState('');
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>('suffix');
  const [conflictSuffix, setConflictSuffix] = useState('_{n}');
  const [dragOver, setDragOver] = useState(false);

  // tag 选择器状态（复用 WritePage 实现：combobox 选择已有 / 输入新建）
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagInputErr, setTagInputErr] = useState<string | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const tagRef = useRef<HTMLDivElement>(null);

  // 实时校验 group（空字符串不报错，避免初次进入显示错误）
  const groupErr = group.trim() ? groupError(group) : null;
  const scopeErr = scope.trim() ? scopeError(scope) : 'Scope 不能为空';
  const conflictSuffixErr = conflictMode === 'suffix' ? conflictSuffixError(conflictSuffix) : null;

  // 加载可用 tag 列表（当前 scope）
  useEffect(() => {
    let cancelled = false;
    fetchTags(scope).then((res) => {
      if (!cancelled && res.ok) setAvailableTags(res.tags.map((t) => t.tag));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
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

  const [phase, setPhase] = useState<'idle' | 'scanning' | 'uploading' | 'importing' | 'done' | 'failed'>('idle');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failureStage, setFailureStage] = useState<'scan' | 'upload' | 'import' | null>(null);
  const [uploadErrors, setUploadErrors] = useState<{ name: string; error: string }[]>([]);
  const [progressText, setProgressText] = useState('');
  const [uploadStats, setUploadStats] = useState<UploadStats | null>(null);
  const [failedUploadBatch, setFailedUploadBatch] = useState<number | null>(null);
  const uploadPlanRef = useRef<UploadPlan | null>(null);

  // 进度轮询（导入中每 2s）
  useEffect(() => {
    if (phase !== 'importing' || !job) return;
    const timer = setInterval(async () => {
      try {
        const res = await getImportStatus(job.id);
        if (!res.ok || !res.job) {
          clearInterval(timer);
          setPhase('failed');
          setFailureStage('import');
          setError(res.error ?? '任务已失效，请重新导入');
          return;
        }
        setJob(res.job);
        if (res.job.state === 'done') {
          clearInterval(timer);
          setPhase('done');
        } else if (res.job.state === 'failed') {
          clearInterval(timer);
          setPhase('failed');
          setFailureStage('import');
          setError(res.job.error ?? '导入失败');
        } else if (res.job.state === 'cancelled') {
          clearInterval(timer);
          setPhase('failed');
          setFailureStage('import');
          setError('导入已取消');
        }
      } catch (e) {
        clearInterval(timer);
        setPhase('failed');
        setFailureStage('import');
        setError(`查询导入状态失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, job?.id]);

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
   * webkitRelativePath 是后端推导默认 Group 所需的相对路径，不能丢失。
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
    if (phase === 'scanning' || phase === 'uploading' || phase === 'importing') return;
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
    if (phase === 'scanning' || phase === 'uploading' || phase === 'importing') return;
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
    if (phase === 'scanning' || phase === 'uploading' || phase === 'importing') return;
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

  const triggerImport = async (uploadId: string): Promise<void> => {
    try {
      const run = await runImport({
        scope,
        uploadId,
        group: group.trim() || undefined,
        chunkSize: chunkSize ? Number(chunkSize) : undefined,
        chunkOverlap: chunkOverlap ? Number(chunkOverlap) : undefined,
        vector,
        tags: selectedTags.length > 0 ? selectedTags.join(',') : undefined,
        conflictMode,
        conflictSuffix: conflictMode === 'suffix' ? conflictSuffix : undefined,
      });
      if (!run.ok || !run.jobId) {
        setFailureStage('import');
        setPhase('failed');
        setError(run.error ?? '导入触发失败');
        return;
      }
      setJob({ id: run.jobId, scope, state: 'running', startedAt: Date.now() });
      setProgressText('导入中…');
      setFailureStage(null);
      setPhase('importing');
    } catch (error) {
      setFailureStage('import');
      setPhase('failed');
      setError(getErrorDetails(error));
    }
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
          encoded.push({ name: file.name, content: await fileToBase64(file.file) });
        }
        const response = await uploadFiles(scope, encoded, plan.uploadId);
        if (!response.ok || !response.uploadId) throw new Error(response.error ?? '上传失败');
        plan.uploadId = response.uploadId;
        plan.nextBatch = index + 1;
        plan.uploadedFiles += response.total ?? batch.length;
        if (response.errors && response.errors.length > 0) {
          setUploadErrors((previous) => [...previous, ...response.errors!]);
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
      return plan.uploadId ?? null;
    } catch (error) {
      setFailedUploadBatch(plan.currentBatch);
      setFailureStage('upload');
      setPhase('failed');
      setError(`上传第 ${plan.currentBatch + 1}/${plan.batches.length} 批失败：${getErrorDetails(error)}`);
      return null;
    }
  };

  const start = async (): Promise<void> => {
    if (scopeErr) {
      setError(scopeErr);
      return;
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
    const batches = toUploadBatches(files, importPolicy.maxRequestBody);
    const plan: UploadPlan = {
      batches,
      nextBatch: 0,
      currentBatch: 0,
      uploadedFiles: 0,
      totalFiles: files.length,
      totalBytes: totalSelectedBytes,
    };
    uploadPlanRef.current = plan;
    setUploadStats({ batch: 0, totalBatches: batches.length, filesDone: 0, totalFiles: files.length, bytesDone: 0, totalBytes: totalSelectedBytes });
    const uploadId = await continueUpload(0);
    if (uploadId) await triggerImport(uploadId);
  };

  const retryUpload = async (): Promise<void> => {
    if (failedUploadBatch === null) return;
    const uploadId = await continueUpload(failedUploadBatch);
    if (uploadId) await triggerImport(uploadId);
  };

  const result = job?.result as
    | {
        stats?: { total?: number; vectorized?: number; errors?: number; conflicts?: number };
        errors?: { path?: string; error?: string }[];
        conflicts?: { path?: string; originalRelation?: string; relation?: string; action?: string }[];
      }
    | undefined;
  const importErrors = result?.errors ?? [];
  const importPercent = job?.progress && job.progress.total > 0
    ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
    : null;
  const uploadPercent = uploadStats && uploadStats.totalFiles > 0
    ? Math.min(100, Math.round((uploadStats.filesDone / uploadStats.totalFiles) * 100))
    : null;
  const activePercent = phase === 'uploading' ? uploadPercent : importPercent;

  return (
    <>
      <div className="ki-page-head">
        <div>
          <h1>上传导入</h1>
          <p>目标：{scope} · 直导无需 AI · 无第三方依赖 · 幂等追加（重复导入即增量）</p>
        </div>
      </div>

      <div className="ki-card">
        <div className="ki-card__body" style={{ padding: 20 }}>
          {/* 拖拽区 */}
          <div
            className={`ki-dropzone${dragOver ? ' ki-dropzone--over' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="ki-dropzone__icon">⇪</div>
            <div className="ki-dropzone__title">拖拽 Markdown 文件或目录到此处，或点击选择</div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              文档：{importPolicy.extensions.join(', ')}；Markdown 引用的图片附件会一并处理，其他文件自动跳过
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
          <div style={{ marginTop: 8 }}>
            <label className="ki-form-label">Scope（目标知识库）</label>
            <ScopePathSelect
              value={scope}
              onChange={(value) => setScope(value.trim())}
              placeholder="选择或输入 Scope 名称，如：kafka"
              hint="默认使用当前 Scope；输入不存在的合法名称并回车确认，提交导入时自动新建。"
              error={scopeErr}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <label className="ki-form-label">Group 路径（可选，导入根目录）</label>
            <GroupPathSelect
              scope={scope}
              value={group}
              onChange={setGroup}
              placeholder="选择或输入 Group 路径，如：wiki/我的文档"
              hint="留空则使用 scope 名称作为根路径；选择后导入的文件将写入该路径下，并保留其相对目录结构。禁止包含 \\ 和 .."
              error={groupErr}
            />
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
                  <option value="suffix">自动添加后缀（推荐）</option>
                  <option value="overwrite">覆盖已有文档</option>
                  <option value="skip">跳过同名文件</option>
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
                />
                {conflictSuffixErr && <div className="ki-form-error">{conflictSuffixErr}</div>}
              </div>
            </div>
            <div className="ki-form-hint">
              同一 sourcePath 重复导入始终幂等覆盖；不同 sourcePath 的同名文档按此策略处理。后缀中的 {'{n}'} 会从 1 递增。
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
            {/* 已选 tag pills（独立行） */}
            {selectedTags.length > 0 && (
              <div className="ki-tag-pills" style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedTags.map((t) => (
                  <span key={t} className="ki-tag-pill">
                    {t}
                    <span className="ki-tag-pill__x" onClick={() => removeTag(t)}>✕</span>
                  </span>
                ))}
              </div>
            )}
            {tagInputErr ? (
              <div className="ki-form-error">{tagInputErr}</div>
            ) : (
              <div className="ki-form-hint">选择后，本次导入（含上传目录与上传文件）的所有文档将带上这些标签，可在语义搜索按标签过滤。禁止包含 , / \ 和 ..</div>
            )}
          </div>

          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="ki-btn ki-btn--secondary ki-btn--small" onClick={openDirPicker}>
              上传目录
            </button>
            <button
              className="ki-btn ki-btn--secondary ki-btn--small"
              onClick={() => {
                if (fileInput.current) {
                  fileInput.current.value = '';
                  fileInput.current.click();
                }
              }}
            >
              上传文件
            </button>
          </div>

          {/* 文件清单 */}
          {selections.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="ki-import-summary">
                <span>待导入：{selectedDocuments.length} 个 Markdown</span>
                <span>附件：{selectedAssets.length} 个</span>
                {skippedFiles > 0 && <span className="ki-import-summary__skipped">已跳过：{skippedFiles} 个（{formatBytes(skippedBytes)}）</span>}
                <span>大小：{formatBytes(totalSelectedBytes)}</span>
              </div>
              {selections.map((selection) => {
                const totalSize = selection.files.reduce((sum, file) => sum + file.size, 0);
                return (
                  <div key={selection.id} className="ki-file-item">
                    <span className="ki-file-item__icon">{selection.kind === 'directory' ? '📁' : '📄'}</span>
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
                    <button className="ki-file-item__remove" onClick={() => removeSelection(selection.id)} title="移除">
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

          <div style={{ display: 'flex', gap: 8, marginTop: 20, alignItems: 'center' }}>
            <button
              className="ki-btn ki-btn--primary"
              onClick={() => void start()}
              disabled={phase === 'scanning' || phase === 'uploading' || phase === 'importing' || files.length === 0}
            >
              {phase === 'scanning' ? '读取目录中…' : phase === 'uploading' ? '上传中…' : phase === 'importing' ? '导入中…' : '开始导入'}
            </button>
            <span className="ki-cell-sub">{progressText || '直导无需 AI · 无第三方依赖'}</span>
          </div>
        </div>
      </div>

      {/* 进度 */}
      {(phase === 'scanning' || phase === 'uploading' || phase === 'importing') && (
        <div className="ki-progress-block" style={{ marginTop: 16 }}>
          <div className="ki-progress-row">
            <span className="ki-progress-label">
              <span className="ki-spinner" aria-hidden="true" />
              {phase === 'scanning' ? '读取目录中…' : phase === 'uploading' ? '上传中…' : '导入中…'}
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
              : phase === 'importing' && job?.progress
                ? `${job.progress.done}/${job.progress.total} 个处理单元（${importPercent ?? 0}%）`
                : progressText}
          </div>
        </div>
      )}

      {error && (
        <div className="ki-empty" style={{ marginTop: 16 }}>
          <div>
            <h3>{failureStage === 'upload' ? '上传失败' : failureStage === 'scan' ? '读取失败' : '导入失败'}</h3>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</p>
            {failedUploadBatch !== null && uploadPlanRef.current && (
              <div className="ki-empty__actions">
                <button className="ki-btn ki-btn--primary ki-btn--small" onClick={() => void retryUpload()}>
                  重试第 {failedUploadBatch + 1}/{uploadPlanRef.current.batches.length} 批
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {uploadErrors.length > 0 && (
        <div className="ki-import-errors" style={{ marginTop: 16 }} role="alert">
          <div className="ki-import-errors__title">部分文件未上传（{uploadErrors.length}）</div>
          <ul>
            {uploadErrors.map((item, index) => (
              <li key={`${item.name}-${index}`}>{item.name}：{item.error}</li>
            ))}
          </ul>
        </div>
      )}

      {phase === 'done' && (
        <div className="ki-empty" style={{ marginTop: 16 }}>
          <div>
            <h3>{importErrors.length > 0 ? '导入完成，但有部分错误' : '导入完成'}</h3>
            <p>
              {result?.stats
                ? `已处理 ${result.stats.total ?? 0} 个分片 / ${result.stats.vectorized ?? 0} 个向量化，错误 ${result.stats.errors ?? 0}${result.stats.conflicts ? `，同名冲突 ${result.stats.conflicts} 个` : ''}`
                : '导入已完成，可前往搜索验证。'}
            </p>
            {result?.conflicts && result.conflicts.length > 0 && (
              <div className="ki-import-errors" role="status">
                <div className="ki-import-errors__title">同名处理结果（{result.conflicts.length}）</div>
                <ul>
                  {result.conflicts.map((item, index) => (
                    <li key={`${item.path ?? 'conflict'}-${index}`}>
                      {item.path ?? '文件'}：{item.originalRelation ?? '文档'} → {item.relation ?? '未命名'}（{
                        item.action === 'skip' ? '已跳过' : item.action === 'overwrite' ? '已覆盖' : '已加后缀'
                      }）
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {importErrors.length > 0 && (
              <div className="ki-import-errors" role="alert">
                <div className="ki-import-errors__title">具体错误（{importErrors.length}）</div>
                <ul>
                  {importErrors.map((item, index) => (
                    <li key={`${item.path ?? 'error'}-${index}`}>
                      {item.path ? `${item.path}：` : ''}{item.error ?? '未知错误'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="ki-empty__actions">
              <Link
                className="ki-btn ki-btn--primary ki-btn--small"
                to={{ pathname: '/search', search: `?scope=${encodeURIComponent(scope)}` }}
              >
                前往搜索验证 →
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
