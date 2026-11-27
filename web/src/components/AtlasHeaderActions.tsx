/**
 * AtlasHeaderActions.tsx —— 知识地图的顶栏动作（上传 / 卸载图集包）
 *
 * 位置由用户 2026-11-25 拍板：从页内状态行提到顶栏、放在「AI 对话」左侧，且**只在知识地图页**
 * 渲染（AppShell 按路由判定）。起因是那条状态行与图集包自带的信息条
 * （「基于 master @ 071afab 生成 · …」）说的是同一件事，页面里等于同一句话说两遍；
 * 动作上移后页面只剩图集本体，纵向上还省掉一整条。
 *
 * ★ 状态走共享缓存 `['atlasStatus', <库名>]`（lib/hooks 的 `useAtlasTargets`）：上传/卸载成功后
 *   invalidate 一次，`AtlasPage` 那边自动换成新图集 —— 不需要额外的页面间消息通道。
 * ★ 皮肤复用顶栏 action（`ki-topbar__chat-toggle`）：与「AI 对话」「AI 设置」等高同为 32px，
 *   ≤1100px 断点会跟着收成图标按钮（label 在 `.ki-topbar__chat-label` 里）。
 * ★ 两个弹窗都用站内 `ki-dialog` 骨架（与「删除文档」「用户管理」同一套）：**不用
 *   `window.confirm`** —— 原生弹窗长着浏览器的样子，与全站视觉割裂（2026-11-25 用户当场指出）。
 * ★ 分片上传：整包 base64 一次 POST 会同时压垮请求体上限与前端内存（S-06 §3.4）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import '@/styles/atlas.css';
import { useAtlasTargets, useScopeList } from '@/lib/hooks';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import { deleteAtlasPackage, uploadAtlasPackage } from '@/api/httpApi';
import { Icon } from '@/components/icons';
import {
  atlasMemberNote, atlasScopeOf, collapseAtlasTargets, DEFAULT_ATLAS_MAP, displayNameOf,
  pickSingleTarget, resolveAtlasView, toAtlasProbes,
} from '@/lib/atlasTargets';

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

/**
 * 站内弹窗外壳（与 `DocDeleteDialog` / `UserDialog` 同一套 `ki-dialog` 骨架）。
 *
 * 四件事是刻意补齐的（原生 confirm 自带，手写弹窗最容易漏）：
 * ① 遮罩点击关闭、② Esc 关闭、③ 打开即把焦点移进弹窗、④ Tab 关在弹窗内且关闭后焦点归还触发按钮。
 * `busy` 时不响应 Esc / 遮罩，避免「上传/卸载进行中弹窗被关掉」后状态无处表达。
 * Esc 用捕获阶段接住：阅读器的 Esc 链在 window 冒泡阶段，冒泡期拦截会先被它吃掉。
 */
function AtlasDialog({
  title, children, footer, busy = false, onClose,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  // 渲染时抓触发元素：下面「聚焦弹窗」的 effect 会立刻改写 document.activeElement
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const target = returnFocusRef.current;
    dialogRef.current?.focus();
    return () => {
      // 触发按钮可能已随顶栏卸载，判存在再归还焦点。
      // ⚠️ 必须**同步**归还：写成 `setTimeout(…, 0)` 时，React 严格模式下
      // 「挂载→清理→再挂载」会让那个定时器在第二次挂载之后才跑，焦点被拽回顶栏按钮（实测复现）。
      if (target && document.contains(target)) target.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);

  /** 焦点陷阱：Tab / Shift+Tab 在弹窗内循环，别落到遮罩后面的页面上 */
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((el) => !el.closest('[hidden]') && (el.offsetWidth > 0 || el.offsetHeight > 0));
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // 挂在 window 而不是 root 上：焦点若已落到遮罩后面（点击非可聚焦区域等），
    // 挂在 root 上的监听收不到事件，Tab 就会一路走穿页面。window 版能把它拽回来。
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog atlas-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <h3 className="ki-dialog__title">{title}</h3>
          <button type="button" className="ki-dialog__close" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}>✕</button>
        </header>
        <div className="ki-dialog__body">{children}</div>
        <footer className="ki-dialog__foot">{footer}</footer>
      </section>
    </div>,
    document.body,
  );
}

/**
 * 顶栏「成员库切换」：只在**视图**下、且 ≥2 个成员装了图集时出现（0/1 个时页面直出，
 * 摆一个只有一项的下拉是纯噪音）。
 *
 * 为什么不复用全局 scope 选择器：那个换的是「看哪个库 / 视图」（会连带换掉浏览页、
 * 检索页的上下文），这里换的是「视图内看哪个成员库的图集」，范围小一层 —— 混用会让人
 * 以为自己切了知识库。选中态写 URL `?member=`（replace 不进历史），刷新与分享都停在同一份。
 *
 * ★ 只读账号也要能切（读操作）：本组件**不判** `knowledge.write`，上传/卸载才判。
 */
function AtlasMemberSwitch({ members, selected, note, displayName, onPick }: {
  members: string[];
  selected: string;
  note: string | null;
  /** 显示名：图集库显示其主库名（2026-11-27），真实库名只进 title */
  displayName: (member: string) => string;
  onPick: (member: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * 点外部收起：必须用 `mousedown`（与 ScopeSelect 同一坑）——用 `click` 时
   * 面板内的按钮会先触发重渲染，原节点脱离 DOM，`contains` 判 false 导致"刚点就关"。
   */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target || !target.isConnected) return;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="atlas-switch" ref={rootRef}>
      <button
        type="button"
        className="ki-topbar__chat-toggle atlas-switch__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`当前查看「${displayName(selected)}」的知识地图；本视图共 ${members.length} 个成员库已配置`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="map" />
        <span className="ki-topbar__chat-label atlas-switch__name">{displayName(selected)}</span>
        {/* 窄屏只留首字母：≤1100px 时全名会挤掉「AI 对话」等动作（见 atlas.css 断点） */}
        <span className="atlas-switch__initial" aria-hidden="true">{displayName(selected).slice(0, 1).toUpperCase()}</span>
        <span className="atlas-switch__caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="atlas-switch__panel" role="listbox" aria-label="选择成员库的知识地图">
          {members.map((member) => (
            <button
              key={member}
              type="button"
              role="option"
              aria-selected={member === selected}
              className={`atlas-switch__item${member === selected ? ' atlas-switch__item--active' : ''}`}
              onClick={() => { onPick(member); setOpen(false); }}
            >
              <span className="atlas-switch__item-name">{displayName(member)}</span>
              {member === selected ? <Icon name="check" className="ki-icon ki-icon--sm" /> : null}
            </button>
          ))}
          {note ? <p className="atlas-switch__note">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AtlasHeaderActions(): JSX.Element {
  const scope = useScopeValue();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const targets = useAtlasTargets(scope);
  const scopeList = useScopeList();
  const [params, setParams] = useSearchParams();
  const [upload, setUpload] = useState<UploadState | null>(null);
  /**
   * 卸载确认：替换原生 `window.confirm`（样式与全站不一致）。
   * 存的是**待卸载的 scope 本身**而不是布尔 —— 顶栏的 scope 选择器就在旁边，
   * 只存 true 的话「A 库点卸载 → 切到 B → 确认」会删掉 B 的图集。
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  /** 卸载失败：图集还在盘上，必须让用户看见原因（顶栏放不下长文案，用弹窗） */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 换库时丢弃进行中的弹窗：文件是按旧库选的，确认框里的库名也已经不是当前库 */
  useEffect(() => {
    setUpload(null);
    setConfirming(null);
    setRemoveError(null);
  }, [scope]);

  /**
   * 只读账号不摆这两个动作：上传 / 卸载都是**写库**动作，与侧栏对只读账号隐藏「知识写入」同一口径。
   * ⚠️ 服务端 `/api/atlas/package` 只判 scope 是否只读（`rejectIfScopeReadonly`），**不判角色能力**，
   * 因此前端不拦 = 真的给了入口。
   */
  const canWrite = can('knowledge.write');

  /**
   * 视图分支必须在 `canWrite` **之前**：切换成员是**读**操作，只读账号也要能切；
   * 上传 / 卸载才是写操作（单库分支才判）。
   *
   * 成员状态还在读时不摆：先短后长会让顶栏抖一下，也让「直出」看起来像「本来有个切换器」。
   */
  if (targets.isView) {
    if (!targets.ready || targets.isPending) return <></>;
    // 先按主库折叠（图集库优先），再交给选中逻辑 —— 否则同一主库会出现两项
    const probes = collapseAtlasTargets(toAtlasProbes(targets.targets));
    const shape = resolveAtlasView(probes, params.get('member'));
    /**
     * 0 份不摆；1 份且无读取失败也不摆（页面直出，摆一个只有一项的下拉是纯噪音，用户拍板）。
     *
     * 但「1 份 + 有成员读取失败」要摆：视图 [A 有图集, B 读失败] ⇒ 直出 A，若不摆，
     * B 的失败就**没有任何地方能看到**，用户会把「没读到」当成「没装」（R5 正是要防这个）。
     * members 为 0 时不摆 —— 那时页面已经整幅是错误卡，顶栏再摆个空标签只是噪音。
     */
    if (shape.members.length === 0) return <></>;
    if (shape.members.length === 1 && shape.failed.length === 0) return <></>;
    const selected = shape.selected ?? shape.members[0] ?? '';
    return (
      <AtlasMemberSwitch
        members={shape.members}
        selected={selected}
        note={atlasMemberNote(shape)}
        displayName={(member) => {
          const probe = probes.find((item) => item.scope === member);
          return probe ? displayNameOf(probe) : member;
        }}
        onPick={(member) => {
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('member', member);
            return next;
          }, { replace: true });
        }}
      />
    );
  }

  /**
   * 状态读不出来时不摆动作：此时页面显示的是「无法读取图集状态」错误卡片，
   * 顶栏却顶着一个「上传图集包」，会被读成「这个库没有图集」。
   */
  /*
   * 单库：图集在 `<主库>-atlas`，上传/卸载必须写**真实落点库**（2026-11-27）。
   * 折叠后图集库优先，所以 writeScope 可能就是当前 scope 本身（旧部署）。
   */
  const singleProbe = pickSingleTarget(toAtlasProbes(targets.targets));
  const single = singleProbe
    ? targets.targets.find((item) => item.scope === singleProbe.scope)
    : targets.targets[0];
  /*
   * 写入落点必须是**图集库**，而不是「当前库」：
   * 图集库还没装时 pickSingleTarget 会回落到主库，若直接拿它上传，就绕过了
   * 「主库不落图集产物」的红线（2026-11-27 质疑环节抓到的缺口）。
   */
  const writeScope = single?.kind === 'atlas'
    ? single.scope
    : atlasScopeOf(scope, scopeList.data?.atlas ?? DEFAULT_ATLAS_MAP);
  const exists = single?.exists === true;
  const statusUnavailable = single?.isError === true;
  if (!canWrite || statusUnavailable) return <></>;

  const refresh = (): void => {
    // 前缀失效：主库与图集库两个 key 一起刷新
    void queryClient.invalidateQueries({ queryKey: ['atlasStatus'] });
  };

  /** 选文件：只接 zip，且立刻给出体积（服务端还会再校验一次包内形状） */
  const pickFile = (file: File | undefined): void => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setUpload({ file, busy: false, sent: 0, total: 0, error: '只接受 .zip（用 pack_atlas.py … --zip 打包）' });
      return;
    }
    setUpload({ file, busy: false, sent: 0, total: 0 });
  };

  /** 失败后重新挑包：关掉当前弹窗再拉起系统文件选择框（隐藏 input 常驻在顶栏，不受弹窗影响） */
  const reopenPicker = (): void => {
    setUpload(null);
    fileRef.current?.click();
  };

  const startUpload = async (): Promise<void> => {
    if (!upload || upload.busy) return;
    setUpload({ ...upload, busy: true, sent: 0, total: 0, error: undefined, code: undefined });
    try {
      /*
       * 上传传**当前库**（主库或图集库均可）：服务端按映射推导真实落点，
       * 图集库不存在时会自动初始化。传 writeScope 反而会让服务端把图集库
       * 当成「待校验的主库」而 404（首次上传时图集库还不存在）。
       */
      await uploadAtlasPackage(scope, upload.file, (sent, total) => {
        setUpload((cur) => (cur ? { ...cur, sent, total } : cur));
      });
      setUpload(null);
      refresh();
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

  const removeAtlas = async (target: string): Promise<void> => {
    if (removing) return;
    setRemoving(true);
    try {
      await deleteAtlasPackage(target);
      setConfirming(null);
      refresh();
    } catch (err) {
      setConfirming(null);
      setRemoveError((err as Error).message ?? '卸载失败');
    } finally {
      setRemoving(false);
    }
  };

  const uploadDialog = upload ? (
    <AtlasDialog
      title="上传图集包"
      busy={upload.busy}
      onClose={() => setUpload(null)}
      footer={upload.error ? (
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setUpload(null)}>关闭</button>
          {/* 失败后必须能换一个包：上一版把「重新选择」做成 disabled，等于把用户关在死胡同里 */}
          <button type="button" className="ki-btn ki-btn--primary" onClick={reopenPicker}>重新选择文件</button>
        </>
      ) : (
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setUpload(null)} disabled={upload.busy}>取消</button>
          <button type="button" className="ki-btn ki-btn--primary" onClick={() => void startUpload()} disabled={upload.busy}>
            {upload.busy ? '上传中…' : '开始上传'}
          </button>
        </>
      )}
    >
      <p className="atlas-dialog__line">
        文件：<code>{upload.file.name}</code> {kbText(upload.file.size)}
      </p>
      {upload.error ? (
        <p className="ki-write-error" role="alert">
          {upload.code ? <code>{upload.code}</code> : null} {upload.error}
        </p>
      ) : (
        <p className="atlas-dialog__tip">会覆盖当前版本，上一版进 archive/（想回退就重新上传那份包）。</p>
      )}
      {upload.busy ? (
        <p className="atlas-dialog__progress">分片 {upload.sent}/{upload.total || '?'} 上传中…</p>
      ) : null}
    </AtlasDialog>
  ) : null;

  const confirmDialog = confirming !== null ? (
    <AtlasDialog
      title="卸载图集"
      busy={removing}
      onClose={() => setConfirming(null)}
      footer={(
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setConfirming(null)} disabled={removing}>取消</button>
          <button type="button" className="ki-btn ki-btn--danger" onClick={() => void removeAtlas(confirming)} disabled={removing}>
            {removing ? '卸载中…' : '确认卸载'}
          </button>
        </>
      )}
    >
      <p className="atlas-dialog__line">
        知识库：<code>{confirming}</code>
      </p>
      <p className="atlas-dialog__tip">
        当前版本会从页面移除，archive/ 里保留一份备份；之后想恢复，重新上传同一个包即可。
      </p>
    </AtlasDialog>
  ) : null;

  const removeErrorDialog = removeError ? (
    <AtlasDialog
      title="卸载失败"
      onClose={() => setRemoveError(null)}
      footer={<button type="button" className="ki-btn ki-btn--primary" onClick={() => setRemoveError(null)}>知道了</button>}
    >
      <p className="ki-write-error" role="alert">{removeError}</p>
    </AtlasDialog>
  ) : null;

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <button
        type="button"
        className="ki-topbar__chat-toggle"
        onClick={() => fileRef.current?.click()}
        title={exists ? `上传新的图集包到 ${writeScope}（覆盖当前版本）` : `上传图集包到 ${writeScope}（.zip）`}
        aria-label={exists ? `重新上传图集包到 ${writeScope}` : `上传图集包到 ${writeScope}`}
      >
        <Icon name="upload" />
        <span className="ki-topbar__chat-label">{exists ? '重新上传' : '上传图集包'}</span>
      </button>
      {exists ? (
        <button
          type="button"
          className="ki-topbar__chat-toggle"
          onClick={() => setConfirming(writeScope)}
          title={`卸载 ${writeScope} 的图集（旧版本保留在 archive/，可重新上传回滚）`}
          aria-label={`卸载 ${writeScope} 的图集`}
        >
          <Icon name="x" />
          <span className="ki-topbar__chat-label">卸载</span>
        </button>
      ) : null}
      {uploadDialog}
      {confirmDialog}
      {removeErrorDialog}
    </>
  );
}
