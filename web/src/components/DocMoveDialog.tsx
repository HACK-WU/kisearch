/**
 * DocMoveDialog.tsx —— 移动文档到其他 Group（REQ-20261112-002）
 *
 * 三个刻意的设计（用户 2026-11-12 拍板）：
 * - **目标 Group 复用上传导入页的 `GroupPathSelect`**（不传 selectOnly）：可下拉选已有，
 *   也可直接输入新路径回车新建 —— 与导入页一份实现、一份校验（`groupError`）。
 * - **文档名称可改**（Q2）：目标组已有同名文档时不覆盖、不加后缀，而是提示用户改名后重来。
 * - 后果写在弹窗里而不是提交后弹 toast：会不会动源文件、索引要不要重建、是不是数据源管辖的。
 *
 * ⚠️ 弹窗 body **不设 overflow:auto**：`GroupPathSelect` 的下拉面板是常规流定位，
 * 祖先一旦裁剪就会被切掉（Token 弹窗里 ScopeMultiPicker 踩过四层 overflow 的坑，见 ki 错误库）。
 * 本弹窗内容短、定高即可，宁可整体略高也不裁面板。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { moveDocument, type MoveDocumentResponse } from '@/api/httpApi';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { useDocList } from '@/lib/hooks';
import { groupError, relationError } from '@/lib/validators';
// 当前路径用 groupPathSegment（根不贡献路径段），不用 groupDisplayName —— 见 root-group-display 守卫
import { groupPathSegment, ROOT_GROUP_FIELD_LABEL, ROOT_GROUP_KEY } from '@/lib/groupTree';

export interface DocMoveDialogProps {
  scope: string;
  group: string;
  relation: string;
  /** 打开编辑器时拿到的 revision（有则带上做乐观锁；没有就只做服务端重名/存在校验） */
  expectedRevision?: string;
  onClose: () => void;
  onMoved: (result: MoveDocumentResponse) => void;
}

/** 把后端的 code 翻成用户能照着做的动作，服务端文案只作兜底 */
function describeMoveError(error: unknown): { message: string; nameConflict: boolean } {
  const status = (error as { status?: number }).status;
  const body = (error as { body?: { code?: string; error?: string } }).body;
  const code = body?.code;
  const fallback = body?.error ?? (error as Error)?.message ?? '移动失败';
  switch (code) {
    case 'TARGET_EXISTS':
      return { message: '目标 Group 已有同名文档，请修改上方「文档名称」后重试', nameConflict: true };
    case 'SOURCE_EXISTS':
      return { message: fallback, nameConflict: true };
    case 'DATASOURCE_BLOCKED':
      return {
        message: '这篇文档由「数据源」同步维护：移动后下次同步会在原 Group 再导入一份。'
          + '请到数据源页调整目录结构后重新同步，或改为手动写入一份。',
        nameConflict: false,
      };
    case 'DOC_EDIT_IN_PROGRESS':
      return { message: '该文档有未结束的编辑草稿，请先在编辑器里保存或取消后再移动', nameConflict: false };
    case 'REVISION_CONFLICT':
      return { message: '正文已发生变化，请重新打开文档后再移动', nameConflict: false };
    case 'SCOPE_READONLY':
      return { message: '当前知识库为只读，无法移动文档', nameConflict: false };
    case 'SOURCE_MOVE_FAILED':
    case 'MOVE_INDEX_FAILED':
    case 'MOVE_PARTIAL':
      return { message: fallback, nameConflict: false };
    default:
      if (status === 403) return { message: '当前知识库为只读，无法移动文档', nameConflict: false };
      return { message: fallback, nameConflict: false };
  }
}

export function DocMoveDialog({
  scope, group, relation, expectedRevision, onClose, onMoved,
}: DocMoveDialogProps): JSX.Element {
  const [targetGroup, setTargetGroup] = useState('');
  const [name, setName] = useState(relation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 服务端判到的重名（本地用 doc list 只能尽力提示：列表可能被 500 条截断） */
  const [serverConflict, setServerConflict] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const { data: docData } = useDocList(scope);
  const groupErr = targetGroup.trim() ? groupError(targetGroup.trim()) : null;
  const nameErr = relationError(name);

  /**
   * 本地的同名预判：`/api/doc/list` 可能被截断（大库 500 条），所以这里只用来「提前提示 + 禁用按钮」，
   * 真正的否决权在服务端 409 TARGET_EXISTS（漏判的代价是多点一次提交，不是覆盖）。
   */
  const localConflict = useMemo(() => {
    if (!targetGroup.trim() || !name.trim()) return false;
    if (targetGroup.trim() === group && name.trim() === relation) return false;
    return (docData?.docs ?? []).some((doc) => doc.group === targetGroup.trim() && doc.name === name.trim());
  }, [docData, group, name, relation, targetGroup]);

  const sameTarget = targetGroup.trim() === group && name.trim() === relation;
  const conflict = serverConflict || localConflict;
  const blocked = busy || !targetGroup.trim() || Boolean(groupErr) || Boolean(nameErr) || sameTarget || conflict;

  /** 改任何输入都清掉上一轮的服务端结论：那是针对旧值的，留着会让人以为改名没生效 */
  const resetServerConflict = useCallback(() => { setServerConflict(false); setError(null); }, []);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  /**
   * Esc 关闭（**捕获阶段**）：阅读器的 Esc 链在 window 冒泡阶段，且靠 `moveOpen` 早退；
   * 如果这里不接住，打开弹窗后按 Esc 会「毫无反应」——弹窗不动、阅读器也不退，最差的一种。
   * 用 capture 保证先于阅读器执行并阻断传播，未来那边删掉 `moveOpen` 判断也不会误伤。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return;
    if (!targetGroup.trim() || groupErr || nameErr) return;
    setBusy(true);
    setError(null);
    try {
      const result = await moveDocument({
        scope,
        group,
        relation,
        targetGroup: targetGroup.trim(),
        ...(name.trim() !== relation ? { targetRelation: name.trim() } : {}),
        ...(expectedRevision ? { expectedRevision } : {}),
      });
      onMoved(result);
      onClose();
    } catch (err) {
      const described = describeMoveError(err);
      setError(described.message);
      if (described.nameConflict) {
        setServerConflict(true);
        window.setTimeout(() => nameRef.current?.focus(), 0);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, expectedRevision, group, groupErr, name, nameErr, onClose, onMoved, relation, scope, targetGroup]);

  return createPortal(
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog ki-dialog--form ki-move"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ki-move-title"
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <div>
            <h3 className="ki-dialog__title" id="ki-move-title">移动文档</h3>
            <p className="ki-move__sub">换个 Group 归属；目标组有同名文档时改个名称即可</p>
          </div>
          <button type="button" className="ki-dialog__close" aria-label="关闭移动弹窗" disabled={busy} onClick={onClose}>✕</button>
        </header>
        <div className="ki-dialog__body ki-move__body">
          <div className="ki-move__ident">
            <span className="ki-move__ident-label">当前</span>
            <span className="ki-move__ident-path" title={[groupPathSegment(group), relation].filter(Boolean).join(' / ')}>
              {[groupPathSegment(group), relation].filter(Boolean).join(' / ')}
            </span>
          </div>

          <div className="ki-move__field">
            <label className="ki-form-label" htmlFor="ki-move-name">文档名称</label>
            <input
              ref={nameRef}
              id="ki-move-name"
              className={`ki-form-input${conflict ? ' ki-form-input--error' : ''}`}
              value={name}
              disabled={busy}
              autoComplete="off"
              aria-invalid={conflict || Boolean(nameErr) ? true : undefined}
              onChange={(event) => { setName(event.target.value); resetServerConflict(); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !blocked) void submit(); }}
            />
            {nameErr ? (
              <div className="ki-form-error">{nameErr}</div>
            ) : conflict ? (
              <div className="ki-form-error">目标 Group 已有同名文档，请换一个名称</div>
            ) : (
              <div className="ki-form-hint">默认沿用原名；改名后旧名称不再保留</div>
            )}
          </div>

          <div className="ki-move__field">
            <label className="ki-form-label">目标 Group 路径</label>
            <GroupPathSelect
              scope={scope}
              value={targetGroup}
              onChange={(value) => { setTargetGroup(value); resetServerConflict(); }}
              placeholder="选择或输入 Group 路径，如：wiki/我的文档"
              hint="下拉来自当前 Scope；选择已有路径，或输入新路径回车新建"
              error={groupErr}
              disabled={busy}
              // 通用「根目录」选项（2026-11-12 用户要求）：不分组，直接落在库根
              rootOption={{ value: ROOT_GROUP_KEY, label: `${ROOT_GROUP_FIELD_LABEL}（不分组）` }}
            />
          </div>

          <ul className="ki-move__notes">
            <li>会重建这篇文档的全文与向量索引（Group 参与索引标识）。</li>
            <li>已配置 wiki 回写时，仓库里的源文件会一起搬走；搬不动就整体不移动。</li>
            <li>正文里指向它的历史链接仍指向旧位置，不会自动改写。</li>
            <li>数据源同步下来的文档不允许移动（下次同步会再导入一份）。</li>
          </ul>

          {sameTarget && !error ? (
            <p className="ki-move__hint">目标 Group 与名称都没变，无需移动。</p>
          ) : null}
          {error ? <p className="ki-write-error" role="alert">{error}</p> : null}
        </div>
        <footer className="ki-dialog__foot ki-move__foot">
          <button type="button" className="ki-btn ki-btn--secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="ki-btn ki-btn--primary" disabled={blocked} onClick={() => void submit()}>
            {busy ? '移动中…' : '移动'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
