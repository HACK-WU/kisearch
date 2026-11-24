/**
 * 知识地图页（REQ-20261120-003 · S-04 只读壳 + S-06 上传）
 *
 * 定位：图集由本地 `project-atlas` 生成、`ki atlas upload` 或本页上传装机，本页只做**容器**
 * ——状态栏 + iframe + 三态 + 上传/卸载。图集的渲染、点击、代码抽屉、导出全在包内。
 *
 * 三条硬约束（来自 demo-verify 实测，违反会直接坏）：
 * 1. **先查 status 再建 iframe**：/api/atlas/view 的失败态是 JSON，iframe 直接加载会把
 *    401/403/404 渲染成一屏文字。
 * 2. **sandbox 四件套**：缺 allow-scripts 图不渲染，缺 allow-downloads 会拦包内「导出 ↓」。
 * 3. **上传分片**：整包 base64 一次 POST 会同时压垮请求体上限与前端内存。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/styles/atlas.css';
import { useScopeValue } from '@/lib/scopeContext';
import {
  deleteAtlasPackage,
  getAtlasStatus,
  uploadAtlasPackage,
  type AtlasStatusResponse,
} from '@/api/httpApi';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'empty' }
  | { kind: 'ready'; data: AtlasStatusResponse };

/** 上传弹窗状态：同一时刻只有一个动作，用单对象表达比多个 useState 更好守 */
interface UploadState {
  file: File;
  busy: boolean;
  sent: number;
  total: number;
  error?: string;
  code?: string;
}

const kbText = (n?: number): string => {
  if (n === undefined || n === null) return '-';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`;
};

const dayText = (iso?: string): string => (iso ? iso.slice(0, 10) : '-');

export function AtlasPage(): JSX.Element {
  const scope = useScopeValue();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  /** 递增序号：快速切库时丢弃在途响应，避免「B 库状态 + A 库图」串数据 */
  const [reloadSeq, setReloadSeq] = useState(0);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * 图集要占满主区，必须让 `.ki-content` 从「按内容滚动」切成「容器不滚动、内部填满」
   * （与浏览页 / 对话页同一手法；否则 iframe 只有内容高度、下方一片空白）。
   */
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (el) el.classList.add('ki-content--noscroll');
    return () => { el?.classList.remove('ki-content--noscroll'); };
  }, []);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    getAtlasStatus(scope)
      .then((data) => {
        if (!alive) return;
        setState(data.exists ? { kind: 'ready', data } : { kind: 'empty' });
      })
      .catch((err: { message?: string; status?: number }) => {
        if (!alive) return;
        setState({ kind: 'error', message: err?.message ?? '无法读取图集状态', status: err?.status });
      });
    return () => { alive = false; };
  }, [scope, reloadSeq]);

  const retry = useCallback(() => setReloadSeq((n) => n + 1), []);

  /** 选文件：只接 zip，且立刻给出体积（服务端还会再校验一次包内形状） */
  const pickFile = (file: File | undefined): void => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setUpload({ file, busy: false, sent: 0, total: 0, error: '只接受 .zip（用 pack_atlas.py … --zip 打包）' });
      return;
    }
    setUpload({ file, busy: false, sent: 0, total: 0 });
  };

  const startUpload = async (): Promise<void> => {
    if (!upload || upload.busy) return;
    setUpload({ ...upload, busy: true, sent: 0, total: 0, error: undefined, code: undefined });
    try {
      await uploadAtlasPackage(scope, upload.file, (sent, total) => {
        setUpload((cur) => (cur ? { ...cur, sent, total } : cur));
      });
      setUpload(null);
      retry();
    } catch (err) {
      const e = err as { message?: string; body?: { code?: string; hint?: string } };
      setUpload((cur) => (cur ? {
        ...cur,
        busy: false,
        error: [e.message ?? '上传失败', e.body?.hint].filter(Boolean).join(' · '),
        code: e.body?.code,
      } : cur));
    }
  };

  const removeAtlas = async (): Promise<void> => {
    if (!window.confirm(`卸载 ${scope} 的图集？当前版本会删除，archive/ 里的备份保留。`)) return;
    try {
      await deleteAtlasPackage(scope);
      retry();
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message ?? '卸载失败' });
    }
  };

  const uploadButton = (label = '上传图集包'): JSX.Element => (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <button type="button" className="ki-btn ki-btn--primary" onClick={() => fileRef.current?.click()}>{label}</button>
    </>
  );

  const dialog = upload ? (
    <div className="atlas-dialog" role="dialog" aria-modal="true">
      <div className="atlas-dialog__box">
        <div className="atlas-dialog__head">
          <strong>上传图集包</strong>
          <button type="button" className="ki-btn ki-btn--ghost" onClick={() => setUpload(null)} disabled={upload.busy}>×</button>
        </div>
        <div className="atlas-dialog__row">
          文件：<code>{upload.file.name}</code> {kbText(upload.file.size)}
        </div>
        {upload.error ? (
          <div className="atlas-dialog__err">
            {upload.code ? <code>{upload.code}</code> : null} {upload.error}
          </div>
        ) : (
          <div className="atlas-dialog__tip">会覆盖当前版本，上一版进 archive/（可用同一命令回滚）。</div>
        )}
        {upload.busy ? (
          <div className="atlas-dialog__progress">
            分片 {upload.sent}/{upload.total || '?'} 上传中…
          </div>
        ) : null}
        <div className="atlas-dialog__actions">
          <button type="button" className="ki-btn ki-btn--ghost" onClick={() => setUpload(null)} disabled={upload.busy}>取消</button>
          <button type="button" className="ki-btn ki-btn--primary" onClick={() => void startUpload()} disabled={upload.busy || !!upload.error}>
            {upload.error ? '重新选择' : '开始上传'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (state.kind === 'loading') {
    return <div className="atlas-page"><div className="atlas-hint">正在读取图集…</div></div>;
  }

  if (state.kind === 'error') {
    return (
      <div className="atlas-page">
        <div className="atlas-hint atlas-hint--err">
          <strong>无法读取图集状态</strong>
          <span>{state.message}{state.status ? `（HTTP ${state.status}）` : ''}</span>
          <span className="atlas-hint__sub">
            {state.status === 403
              ? `当前账号无权查看 ${scope} 的知识地图，可在左上角切换知识库。`
              : state.status === 401
                ? '会话已过期，请重新登录。'
                : '服务可能未启动或网络中断。'}
          </span>
          <button type="button" className="ki-btn ki-btn--ghost" onClick={retry}>重试</button>
        </div>
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div className="atlas-page">
        <div className="atlas-hint">
          <strong>这个库还没有知识地图</strong>
          <ol className="atlas-steps">
            <li><code>pack_atlas.py &lt;图集目录&gt; dist/ --zip</code></li>
            <li>选上面的包上传，或命令行 <code>ki atlas upload --scope {scope} --file dist/atlas.zip</code></li>
            <li>上传后本页自动显示</li>
          </ol>
          <span className="atlas-hint__sub">
            图集由 project-atlas 生成：先出「拟画清单」确认，再画图、抽快照、打包。
          </span>
          <div className="atlas-hint__actions">
            {uploadButton()}
            <button type="button" className="ki-btn ki-btn--ghost" onClick={retry}>刷新</button>
          </div>
        </div>
        {dialog}
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="atlas-page">
      {/* 状态栏：基线 commit + 生成时间恒显，图集内容是「生成时快照」，不能让读者以为实时 */}
      <div className="atlas-bar">
        <span className="atlas-bar__title">{data.title || scope}</span>
        <span className="atlas-bar__meta">
          {data.branch || '-'}@{data.baseline || '-'} · 生成 {dayText(data.generatedAt)}
          {data.viewCount !== undefined ? ` · ${data.viewCount} 图` : ''}
          {' · '}{kbText(data.size)}
        </span>
        {data.sha256 ? <span className="atlas-bar__sha" title="内容 sha256（前 8 位）">sha {data.sha256.slice(0, 8)}</span> : null}
        <span className="atlas-bar__note">代码为生成时快照，不代表当前 HEAD</span>
        <span className="atlas-bar__actions">
          {uploadButton('重新上传')}
          <button type="button" className="ki-btn ki-btn--ghost" onClick={() => void removeAtlas()}>卸载</button>
        </span>
      </div>
      <iframe
        key={`${scope}-${data.sha256 ?? ''}`}
        className="atlas-frame"
        title={`${scope} 知识地图`}
        src={`/api/atlas/view?scope=${encodeURIComponent(scope)}`}
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
      />
      {dialog}
    </div>
  );
}
