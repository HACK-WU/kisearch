/**
 * 知识地图页（REQ-20261120-003 · S-04 只读壳）
 *
 * 定位：图集由本地 `project-atlas` 生成、`ki atlas upload` 或顶栏按钮装机，本页只做**容器**
 * ——三态 + iframe。图集的渲染、点击、代码抽屉、导出全在包内。
 *
 * 三条硬约束（来自 demo-verify 实测，违反会直接坏）：
 * 1. **先查 status 再建 iframe**：/api/atlas/view 的失败态是 JSON，iframe 直接加载会把
 *    401/403/404 渲染成一屏文字。
 * 2. **sandbox 四件套**：缺 allow-scripts 图不渲染，缺 allow-downloads 会拦包内「导出 ↓」。
 * 3. **上传 / 卸载不在本页**：动作在顶栏（components/AtlasHeaderActions，只在知识地图页显示）。
 *    本页只订阅共享缓存 `['atlasStatus', scope]`，那边上传成功后 invalidate，这里自动换新版本
 *    —— 于是页面里不再画状态行：图集包自带的信息条已经写明「基于 master @ … 生成」，
 *    页面再写一遍就是同一句话说两遍（2026-11-25 用户拍板）。
 */

import { useEffect } from 'react';
import '@/styles/atlas.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAtlasStatus } from '@/lib/hooks';

export function AtlasPage(): JSX.Element {
  const scope = useScopeValue();
  const status = useAtlasStatus(scope);

  /**
   * 图集要占满主区，必须让 `.ki-content` 从「按内容滚动」切成「容器不滚动、内部填满」
   * （与浏览页 / 对话页同一手法；否则 iframe 只有内容高度、下方一片空白）。
   *
   * `--atlas` 额外去掉主区 16px 内边距：图集包自己是整幅画布（内含 248px 目录栏 + 正文），
   * 外面再套一层留白会在左/右各留一条背景色通道，看起来「没贴边」（2026-11-25 用户反馈）。
   * 页头由 CSS 单独还原全站内距，规则与对话页同一手法（见 atlas.css 同段注释）。
   */
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (el) el.classList.add('ki-content--noscroll', 'ki-content--atlas');
    return () => { el?.classList.remove('ki-content--noscroll', 'ki-content--atlas'); };
  }, []);

  /** `req()` 抛出的错误带 `status`（见 api/httpApi 的 req），三态文案按它分流 */
  const err = status.error as (Error & { status?: number }) | null;
  const retry = (): void => { void status.refetch(); };

  if (status.isPending) {
    return <div className="atlas-page"><div className="atlas-hint">正在读取图集…</div></div>;
  }

  // 先判 isError：react-query 会保留上次成功的 data，只按 data 分流会把失败的刷新显示成旧图集
  if (status.isError || !status.data) {
    const code = err?.status;
    return (
      <div className="atlas-page">
        <div className="atlas-hint atlas-hint--err">
          <strong>无法读取图集状态</strong>
          <span>{err?.message ?? '无法读取图集状态'}{code ? `（HTTP ${code}）` : ''}</span>
          <span className="atlas-hint__sub">
            {code === 403
              ? `当前账号无权查看 ${scope} 的知识地图，可在左上角切换知识库。`
              : code === 401
                ? '会话已过期，请重新登录。'
                : '服务可能未启动或网络中断。'}
          </span>
          <div className="atlas-hint__actions">
            <button type="button" className="ki-btn ki-btn--ghost" onClick={retry}>重试</button>
          </div>
        </div>
      </div>
    );
  }

  if (!status.data.exists) {
    return (
      <div className="atlas-page">
        <div className="atlas-hint">
          <strong>这个库还没有知识地图</strong>
          <ol className="atlas-steps">
            <li><code>pack_atlas.py &lt;图集目录&gt; dist/ --zip</code></li>
            <li>
              点右上角「上传图集包」，或命令行
              {' '}<code>ki atlas upload --scope {scope} --file dist/atlas.zip</code>
            </li>
            <li>上传后本页自动显示</li>
          </ol>
          <span className="atlas-hint__sub">
            图集由 project-atlas 生成：先出「拟画清单」确认，再画图、抽快照、打包。
          </span>
          <div className="atlas-hint__actions">
            <button type="button" className="ki-btn ki-btn--ghost" onClick={retry}>刷新</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="atlas-page">
      <iframe
        key={`${scope}-${status.data.sha256 ?? ''}`}
        className="atlas-frame"
        title={`${scope} 知识地图`}
        src={`/api/atlas/view?scope=${encodeURIComponent(scope)}`}
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
      />
    </div>
  );
}
