/**
 * 知识地图页（REQ-20261120-003 · S-04，一期只读）
 *
 * 定位：图集由本地 `project-atlas` 生成、`ki atlas upload` 装机，本页只做**容器**——
 * 状态栏 + iframe + 三态切换。图集的渲染、点击、代码抽屉、导出全在包内，产品侧零实现。
 *
 * 两条硬约束（来自 demo-verify 实测，违反会直接坏）：
 * 1. **先查 status 再建 iframe**：/api/atlas/view 的失败态是 JSON，iframe 直接加载会把
 *    401/403/404 渲染成一屏文字。
 * 2. **sandbox 四件套**：缺 allow-scripts 图不渲染，缺 allow-downloads 会拦包内的「导出 ↓」。
 *
 * 一期没有上传入口（页面上传是二期）：空态只给命令，不放假按钮。
 */

import { useCallback, useEffect, useState } from 'react';
import '@/styles/atlas.css';
import { useScopeValue } from '@/lib/scopeContext';
import { getAtlasStatus, type AtlasStatusResponse } from '@/api/httpApi';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; status?: number }
  | { kind: 'empty' }
  | { kind: 'ready'; data: AtlasStatusResponse };

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
            <li><code>ki atlas upload --scope {scope} --file dist/atlas.zip</code></li>
            <li>上传后刷新本页</li>
          </ol>
          <span className="atlas-hint__sub">
            图集由 project-atlas 生成：先出「拟画清单」确认，再画图、抽快照、打包。
            装好返回 <code>/atlas</code> 即可查看。
          </span>
          <button type="button" className="ki-btn ki-btn--ghost" onClick={retry}>已上传，刷新</button>
        </div>
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
        <button type="button" className="ki-btn ki-btn--ghost atlas-bar__retry" onClick={retry}>刷新</button>
      </div>
      <iframe
        key={scope}
        className="atlas-frame"
        title={`${scope} 知识地图`}
        src={`/api/atlas/view?scope=${encodeURIComponent(scope)}`}
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
      />
    </div>
  );
}
