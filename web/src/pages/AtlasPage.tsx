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
 *    本页只订阅共享缓存 `['atlasStatus', <库名>]`，那边上传成功后 invalidate，这里自动换新版本
 *    —— 于是页面里不再画状态行：图集包自带的信息条已经写明「基于 master @ … 生成」，
 *    页面再写一遍就是同一句话说两遍（2026-11-25 用户拍板）。
 *
 * 视图（2026-11-25 用户拍板布局）：图集是整幅 HTML 画布，**多库合并不了**，也不给视图单独
 * 装一份（`/open/v1/atlas/*` 显式拒绝视图名）。所以视图下不是"合并图集"，而是
 * **从成员库里挑一份来看**：只配了一个就直接出图（不摆切换器）、两个以上才需要切。
 * 取数见 `lib/hooks` 的 `useAtlasTargets`，选中判定见 `lib/atlasTargets`（页面与顶栏共用）。
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import '@/styles/atlas.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAtlasTargets } from '@/lib/hooks';
import { resolveAtlasView, toAtlasProbes } from '@/lib/atlasTargets';

export function AtlasPage(): JSX.Element {
  const scope = useScopeValue();
  const targets = useAtlasTargets(scope);
  const [params] = useSearchParams();
  const queryClient = useQueryClient();

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

  /**
   * 视图下的重试必须打**全部成员**：单库那套 `status.refetch()` 在这里只覆盖一个库。
   * 按前缀 invalidate 而不是逐个 refetch —— 请求由 `useAtlasTargets` 内部装配，
   * 页面拿不到每一条的 refetch 句柄，前缀失效不依赖那个句柄。
   */
  const retryAll = (): void => { void queryClient.invalidateQueries({ queryKey: ['atlasStatus'] }); };

  // scopeList 未就绪 / 成员状态还在查：先不判分支（否则会闪一次「还没有知识地图」）
  if (!targets.ready || targets.isPending) {
    return <div className="atlas-page"><div className="atlas-hint">正在读取图集…</div></div>;
  }

  // ─── 视图分支 ───────────────────────────────────────
  if (targets.isView) {
    const shape = resolveAtlasView(toAtlasProbes(targets.targets), params.get('member'));

    // ① 视图定义的成员库全都不在了（目录被删 / 移走）：这不是"没装图集"，得说清区别
    if (targets.targets.length === 0) {
      return (
        <div className="atlas-page">
          <div className="atlas-hint atlas-hint--err">
            <strong>{targets.memberCount === 0 ? '这个视图还没有成员库' : '这个视图的成员库都不存在'}</strong>
            <span className="atlas-hint__sub">
              {targets.memberCount === 0
                ? <>视图「{scope}」没有定义任何成员库，加成员后再回来：<code>ki view add {scope} &lt;库名&gt;</code></>
                : <>视图「{scope}」定义的 {targets.memberCount} 个成员库当前都读不到。请检查库目录是否被移走（<code>ki view list</code> 可查成员）。</>}
            </span>
            <div className="atlas-hint__actions">
              <button type="button" className="ki-btn ki-btn--ghost" onClick={retryAll}>刷新</button>
            </div>
          </div>
        </div>
      );
    }

    // ② 至少一份可看：直接出图（顶栏负责 ≥2 时的切换器，本页不重复摆）
    if (shape.members.length > 0) {
      const member = shape.selected ?? shape.members[0];
      const picked = targets.targets.find((item) => item.scope === member);
      return (
        <div className="atlas-page">
          <iframe
            key={`${member}-${picked?.status?.sha256 ?? ''}`}
            className="atlas-frame"
            title={`${member} 知识地图${shape.members.length > 1 ? `（视图 ${scope}）` : ''}`}
            src={`/api/atlas/view?scope=${encodeURIComponent(member)}`}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
          />
        </div>
      );
    }

    // ③ 一个都没装，但有成员**读取失败**：先报失败，不能显示成「都没装」（R5）
    if (shape.failed.length > 0) {
      const broken = targets.targets.find((item) => item.isError && item.error);
      const code = broken?.error?.status;
      return (
        <div className="atlas-page">
          <div className="atlas-hint atlas-hint--err">
            <strong>无法读取成员库的图集状态</strong>
            <span>
              {broken?.error?.message ?? '读取失败'}{code ? `（HTTP ${code}）` : ''}
            </span>
            <span className="atlas-hint__sub">
              {code === 403
                ? `当前账号无权查看 ${shape.failed.join('、')}，可在左上角切换知识库。`
                : code === 401
                  ? '会话已过期，请重新登录。'
                  : '服务可能未启动或网络中断。这是「没读到」，不代表成员库没装图集。'}
            </span>
            <div className="atlas-hint__actions">
              <button type="button" className="ki-btn ki-btn--ghost" onClick={retryAll}>重试</button>
            </div>
          </div>
        </div>
      );
    }

    // ④ 确实都没有：给成员清单 + 「先切到具体库再上传」，**不再给视图名的命令**
    //   （`ki atlas upload --scope <视图名>` 必被 /open/v1 拒，旧空态正是这么误导的）
    return (
      <div className="atlas-page">
        <div className="atlas-hint">
          <strong>这个视图还没有可显示的知识地图</strong>
          <span className="atlas-hint__sub">
            视图「{scope}」的 {targets.memberCount} 个成员库都没装图集：{shape.absent.join('、')}
          </span>
          <ol className="atlas-steps">
            <li>先在左上角把知识库切到具体成员库，再点右上角「上传图集包」</li>
            <li>或命令行 <code>ki atlas upload --scope &lt;成员库&gt; --file dist/atlas.zip</code></li>
            <li>上传后本页自动显示该成员库的图集</li>
          </ol>
          <span className="atlas-hint__sub">
            图集由 project-atlas 生成：先出「拟画清单」确认，再画图、抽快照、打包。
          </span>
          <div className="atlas-hint__actions">
            <button type="button" className="ki-btn ki-btn--ghost" onClick={retryAll}>刷新</button>
          </div>
        </div>
      </div>
    );
  }

  // ─── 单库分支（渲染逻辑与改造前一致；取数改由 useAtlasTargets 统一装配，
  //     因此多了一层「等 scopeList 就绪」的前置等待 —— 它同时也是判断"是不是视图"的唯一来源）
  const single = targets.targets[0];
  /** `req()` 抛出的错误带 `status`（见 api/httpApi 的 req），三态文案按它分流 */
  const err = single?.error ?? null;
  const code = err?.status;
  const retry = (): void => { void queryClient.invalidateQueries({ queryKey: ['atlasStatus', scope] }); };

  // 先判 isError：react-query 会保留上次成功的 data，只按 data 分流会把失败的刷新显示成旧图集
  if (single?.isError || !single?.status) {
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

  if (!single.status.exists) {
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
        key={`${scope}-${single.status.sha256 ?? ''}`}
        className="atlas-frame"
        title={`${scope} 知识地图`}
        src={`/api/atlas/view?scope=${encodeURIComponent(scope)}`}
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
      />
    </div>
  );
}