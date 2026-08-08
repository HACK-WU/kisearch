/**
 * ImportPage.tsx —— 上传导入（对齐 demo：拖拽区 + 文件清单 + 切分高级选项 + 向量化 switch + 进度条）
 *
 * scope 必选（default 兜底）→ 选文件/目录 → upload → run → 轮询 status → 进度/结果
 */

import { useEffect, useRef, useState } from 'react';
import { useScopeValue } from '@/lib/scopeContext';
import { getImportStatus, runImport, uploadFiles, type ImportJob } from '@/api/httpApi';
import { GroupPathSelect } from '@/components/GroupPathSelect';

interface PendingFile {
  name: string;
  size: number;
  /** File 引用缓存（上传时读取内容） */
  file?: File;
}

export function ImportPage(): JSX.Element {
  const scope = useScopeValue();
  const fileInput = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<PendingFile[]>([]);
  const [mode, setMode] = useState<'full' | 'incremental'>('full');
  const [advOpen, setAdvOpen] = useState(false);
  const [chunkSize, setChunkSize] = useState('1000');
  const [chunkOverlap, setChunkOverlap] = useState('150');
  const [vector, setVector] = useState(true);
  const [group, setGroup] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [phase, setPhase] = useState<'idle' | 'uploading' | 'importing' | 'done' | 'failed'>('idle');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState('');

  // 进度轮询（导入中每 2s）
  useEffect(() => {
    if (phase !== 'importing' || !job) return;
    const timer = setInterval(async () => {
      try {
        const res = await getImportStatus(job.id);
        if (!res.ok || !res.job) {
          clearInterval(timer);
          setPhase('failed');
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
          setError(res.job.error ?? '导入失败');
        }
      } catch (e) {
        setProgressText(`轮询出错：${(e as Error).message}`);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, job?.id]);

  const collectFiles = async (list: FileList, basePath = ''): Promise<void> => {
    const loaded: PendingFile[] = [];
    for (const f of Array.from(list)) {
      const webkitRel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      const rel = basePath ? `${basePath}/${f.name}` : webkitRel || f.name;
      loaded.push({ name: rel, size: f.size, file: f });
    }
    setFiles((prev) => [...prev, ...loaded]);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) void collectFiles(e.target.files);
    e.target.value = '';
  };

  /** 打开目录选择器：动态创建原生 input 绕开 React DOM 管理，解决 macOS webkitdirectory 被覆盖导致"打开"按钮不可点的问题 */
  const openDirPicker = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files) void collectFiles(input.files);
      input.remove();
    });
    // 取择也清理 DOM
    input.addEventListener('cancel', () => { input.remove(); });
    document.body.appendChild(input);
    input.click();
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    // 拖拽目录（webkitGetAsEntry 递归）——V1 简化：仅处理文件
    const files: File[] = [];
    for (const item of Array.from(items)) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    if (dt.files.length > 0) void collectFiles(dt.files);
  };

  const removeFile = (name: string): void => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  const start = async (): Promise<void> => {
    if (files.length === 0) {
      setError('请先选择文件或目录');
      return;
    }
    setError(null);
    setProgressText('上传中…');
    setPhase('uploading');
    try {
      // 逐文件读取内容 → base64 上传
      const uploads: { name: string; content: string }[] = [];
      for (const f of files) {
        if (!f.file) continue;
        const text = await f.file.text();
        uploads.push({ name: f.name, content: btoa(unescape(encodeURIComponent(text))) });
      }
      if (uploads.length === 0) {
        setPhase('failed');
        setError('无有效文件可上传');
        return;
      }
      const up = await uploadFiles(scope, uploads);
      if (!up.ok || !up.uploadId) {
        setPhase('failed');
        setError(up.error ?? '上传失败');
        return;
      }
      if (up.errors && up.errors.length > 0) {
        setError(`部分文件被拒绝：${up.errors.map((e) => `${e.name}（${e.error}）`).join('; ')}`);
      }
      setProgressText(`已上传 ${up.total ?? uploads.length} 个文件，触发导入…`);

      const run = await runImport({
        scope,
        uploadId: up.uploadId,
        mode,
        group: group.trim() || undefined,
        chunkSize: chunkSize ? Number(chunkSize) : undefined,
        chunkOverlap: chunkOverlap ? Number(chunkOverlap) : undefined,
        vector,
      });
      if (!run.ok || !run.jobId) {
        setPhase('failed');
        setError(run.error ?? '导入触发失败');
        return;
      }
      setJob({ id: run.jobId, scope, mode, state: 'running', startedAt: Date.now() });
      setProgressText('导入中…');
      setPhase('importing');
    } catch (e) {
      setPhase('failed');
      setError((e as Error).message);
    }
  };

  const result = job?.result as
    | { stats?: { total?: number; imported?: number; vectorized?: number; errors?: number } }
    | undefined;

  return (
    <>
      <div className="ki-page-head">
        <div>
          <h1>上传导入</h1>
          <p>目标：{scope} · 直导无需 AI · 无第三方依赖</p>
        </div>
        <select
          className="ki-form-select"
          style={{ width: 'auto', minWidth: 140 }}
          value={mode}
          onChange={(e) => setMode(e.target.value as 'full' | 'incremental')}
        >
          <option value="full">全量导入</option>
          <option value="incremental">增量导入</option>
        </select>
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
            <div className="ki-dropzone__title">拖拽 Markdown 文件到此处，或点击选择</div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              支持 .md / .markdown / .mdx，单个文件 ≤ 1MB
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".md,.markdown,.mdx"
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <label className="ki-form-label">Group 路径（可选，导入根目录）</label>
            <GroupPathSelect
              scope={scope}
              value={group}
              onChange={setGroup}
              placeholder="选择或输入 Group 路径，如：wiki/我的文档"
              hint="留空则使用 scope 名称作为根路径；选择后导入的文件将写入该路径下，并保留其相对目录结构。"
            />
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
          {files.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {files.map((f) => (
                <div key={f.name} className="ki-file-item">
                  <span className="ki-file-item__icon">📄</span>
                  <div className="ki-file-item__meta">
                    <div className="ki-file-item__name">{f.name}</div>
                    <div className="ki-file-item__size">{Math.round(f.size / 1024)}KB</div>
                  </div>
                  <button className="ki-file-item__remove" onClick={() => removeFile(f.name)} title="移除">
                    ✕
                  </button>
                </div>
              ))}
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
              <span className="ki-vec-switch__desc">生成向量写入 zvec 集合，可被语义搜索；关闭则仅写入 KB 文本</span>
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
              disabled={phase === 'importing' || files.length === 0}
            >
              {phase === 'importing' ? '导入中…' : '开始导入'}
            </button>
            <span className="ki-cell-sub">{progressText || '直导无需 AI · 无第三方依赖'}</span>
          </div>
        </div>
      </div>

      {/* 进度 */}
      {phase === 'importing' && (
        <div className="ki-progress-block" style={{ marginTop: 16 }}>
          <div className="ki-progress-row">
            <span className="ki-progress-label">{job?.state === 'done' ? '完成' : '导入中…'}</span>
            <span className="ki-cell-sub">{progressText}</span>
          </div>
          <div className="ki-progress">
            <div className="ki-progress__fill" style={{ width: job?.state === 'done' ? '100%' : '50%' }} />
          </div>
          <div className="ki-progress-sub">{progressText}</div>
        </div>
      )}

      {error && (
        <div className="ki-empty" style={{ marginTop: 16 }}>
          <div>
            <h3>导入失败</h3>
            <p>{error}</p>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="ki-empty" style={{ marginTop: 16 }}>
          <div>
            <h3>导入完成</h3>
            <p>
              {result?.stats
                ? `共导入 ${result.stats.imported ?? 0} 文件 / ${result.stats.vectorized ?? 0} 向量化，错误 ${result.stats.errors ?? 0}`
                : '导入已完成，可前往搜索验证。'}
            </p>
            <div className="ki-empty__actions">
              <a className="ki-btn ki-btn--primary ki-btn--small" href="#/search">
                前往搜索验证 →
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
