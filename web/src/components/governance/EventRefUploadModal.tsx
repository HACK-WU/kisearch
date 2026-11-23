/**
 * 事件参考文档上传弹窗（REQ-20261118-001）
 *
 * 三条硬口径（勿回退）：
 *   1. **只收文件、不收目录**：只用原生 `<input type="file" multiple>`，绝不挂 `webkitdirectory`；
 *      服务端对带 `/` 或 `\` 的名字仍会拒（接口是公开的，前端拦不住直调）。
 *   2. **单次 ≤10 且不截断**：选超了整体拦下并说清"本次 N 个"，不默默只取前 10 个
 *      —— 截断会让用户以为全传了。
 *   3. **名额先判**：`当前篇数 + 本次 > 上限` 时禁用提交并说明还能加几篇；
 *      真正的兜底在服务端（`REF_LIMIT_EXCEEDED`），前端只是别让人白等一次导入。
 *
 * 上传是异步 job：提交拿到 `jobId` 后轮询 `/api/import/status`，
 * 绑定结果在 `job.refsBinding`（**晚于** `state='done'` 写入，故需要短轮询宽限）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { getImportConfig, getImportStatus, type ImportJob } from '../../api/httpApi';
import { GroupPathSelect } from '../GroupPathSelect';
import {
  uploadEventRefDocs,
  GovernanceApiError,
  type EventRefUploadResponse,
} from '../../api/governanceApi';
import { fileToBase64 } from '../../lib/fileBase64';

/** 单次上传上限（与后端 `EVENT_REF_UPLOAD_MAX_FILES` 同口径） */
const MAX_FILES = 10;
/** 绑定结果宽限轮数：job 已 done 但 refsBinding 还没写时，最多再等约 10s */
const BIND_GRACE_TICKS = 15;
/**
 * 同一宽限的「索引整理中」档位：`indexState === 'indexing'` 时 job 还活着在等整理，
 * 最多再等约 10min（600 × 1.5s），与 `indexMaintenance` 的 timeout 同量级。
 */
const BIND_GRACE_TICKS_INDEXING = 600;
/**
 * 单次请求体的安全水位（base64 后约 12MB，服务端硬闸是 16MB）。
 *
 * 为什么前端要管：`maxFileSize` 是**按 scope 配**的（默认 1MB，可配到几十 MB），
 * 10 个 5MB 文件 base64 后 ≈ 66MB —— 直接撞 16MB 硬闸，用户只会看到
 * 「请求体无法解析」这种毫无出路的报错。这里提前拦住并让他分批。
 */
const UPLOAD_BODY_BUDGET_BYTES = 12 * 1024 * 1024;

export interface EventRefUploadModalProps {
  scope: string;
  eventId: string;
  /** 当前参考文档篇数（名额显示与前端预检） */
  refCount: number;
  /** 单事件参考文档上限（服务端 REF_LIMIT，由页面传入） */
  refLimit: number;
  /**
   * 缺省落点的**展示文案**（`事件参考/{短号}-{标题}`）。
   *
   * 只用于提示：真正的缺省值由服务端算（标题截断/净化只应有一份实现），
   * 上传成功后弹窗改用回执里的 `group` 显示实际落点。
   */
  defaultGroupHint?: string;
  onClose: () => void;
  /** 导入结束（含部分失败）或用户在结束后关闭：父级据此刷新列表并提示 */
  onFinished: (text: string, tone: 'ok' | 'err') => void;
}

interface PickedRow {
  file: File;
  error?: string;
}

type Phase = 'idle' | 'submitting' | 'running' | 'settled' | 'failed';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 把绑定结果翻成一句人话（成功/跳过/失败都要说清，静默即失败） */
function summarize(binding: NonNullable<ImportJob['refsBinding']>): { text: string; tone: 'ok' | 'err' } {
  const parts = [`已加入参考文档 ${binding.added} 篇`];
  if (binding.skipped.length > 0) parts.push(`跳过 ${binding.skipped.length} 篇（已在参考文档中）`);
  if (binding.skippedConflicts.length > 0) {
    parts.push(`${binding.skippedConflicts.length} 篇同名已存在未覆盖（${binding.skippedConflicts.join('、')}）`);
  }
  if (binding.failed.length > 0) {
    parts.push(`${binding.failed.length} 篇未加入：${binding.failed.map((f) => `${f.name}（${f.error}）`).join('；')}`);
  }
  return { text: parts.join('；'), tone: binding.failed.length > 0 ? 'err' : 'ok' };
}

export function EventRefUploadModal(props: EventRefUploadModalProps): JSX.Element {
  const { scope, eventId, refCount, refLimit, defaultGroupHint, onClose, onFinished } = props;

  /** 落点 Group（留空 = 服务端缺省 `事件参考/{短号}-{标题}`；D1 要求「可见可改」） */
  const [groupDraft, setGroupDraft] = useState('');
  const [policy, setPolicy] = useState<{ extensions: string[]; maxFileSize: number } | null>(null);
  const [policyErr, setPolicyErr] = useState<string | null>(null);
  const [rows, setRows] = useState<PickedRow[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<EventRefUploadResponse | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 结果只通知父级一次（轮询与关闭都会走到这里） */
  const notifiedRef = useRef(false);

  const busy = phase === 'submitting' || phase === 'running';
  const remaining = Math.max(0, refLimit - refCount);

  useEffect(() => {
    let alive = true;
    void getImportConfig(scope)
      .then((r) => {
        if (!alive) return;
        setPolicy({ extensions: r.extensions, maxFileSize: r.maxFileSize });
        setPolicyErr(null);
      })
      .catch((e: Error) => {
        if (alive) setPolicyErr(e.message);
      });
    return () => { alive = false; };
  }, [scope]);

  /** 逐文件本地预检（与后端同一套判据，减少白跑一次上传） */
  const validate = (file: File): string | undefined => {
    if (!policy) return undefined;
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!policy.extensions.some((e) => e.toLowerCase() === ext)) {
      return `不支持的格式（仅 ${policy.extensions.join(' / ')}）`;
    }
    if (file.size > policy.maxFileSize) return `超过单文件上限 ${Math.round(policy.maxFileSize / 1024)}KB`;
    if (file.name.includes('/') || file.name.includes('\\')) return '文件名含路径分隔符，无法上传';
    return undefined;
  };

  const addFiles = (list: FileList | null): void => {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    // 需求 D5：选择即限制 —— 超了整体拒绝，不截断
    if (rows.length + incoming.length > MAX_FILES) {
      setErr(`单次最多 ${MAX_FILES} 个文件（本次 ${incoming.length} 个，已选 ${rows.length} 个），请分批上传`);
      return;
    }
    const seen = new Set(rows.map((r) => r.file.name));
    const accepted: PickedRow[] = [];
    for (const file of incoming) {
      if (seen.has(file.name)) {
        setErr(`「${file.name}」已在本次选择中，请勿重复添加`);
        continue;
      }
      seen.add(file.name);
      accepted.push({ file, error: validate(file) });
    }
    if (accepted.length > 0) {
      setErr(null);
      setRows((prev) => [...prev, ...accepted]);
    }
  };

  const removeRow = (index: number): void => setRows((prev) => prev.filter((_, i) => i !== index));

  /** base64 后的估算体积（与 `uploadFiles` 同算式：字节 × 4/3） */
  const estimatedBytes = rows.reduce((sum, r) => sum + Math.ceil(r.file.size / 3) * 4, 0);
  const tooLarge = estimatedBytes > UPLOAD_BODY_BUDGET_BYTES;

  const canSubmit = !busy
    && policy !== null
    && rows.length > 0
    && rows.every((r) => !r.error)
    && rows.length <= remaining
    && !tooLarge;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setPhase('submitting');
    setErr(null);
    try {
      const files = await Promise.all(rows.map(async (r) => ({
        name: r.file.name,
        content: await fileToBase64(r.file),
      })));
      const resp = await uploadEventRefDocs(scope, eventId, files, groupDraft ? { group: groupDraft } : {});
      setResult(resp);
      setPhase('running');
      if (resp.rejected.length > 0) {
        setErr(`${resp.rejected.length} 个文件未通过服务端校验：${resp.rejected.map((r) => `${r.name}（${r.error}）`).join('；')}`);
      }
    } catch (e) {
      setPhase('idle');
      const code = e instanceof GovernanceApiError && e.code ? `[${e.code}] ` : '';
      setErr(`${code}${(e as Error).message}`);
    }
  };

  // 轮询导入进度；落定后等 refsBinding（它晚于 state=done 写入）
  useEffect(() => {
    if (phase !== 'running' || !result) return;
    let alive = true;
    let grace = 0;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const r = await getImportStatus(result.jobId);
        if (!alive) return;
        const next = r.job;
        if (!next) {
          setErr('导入任务不存在（服务可能已重启，请重新上传）');
          setPhase('failed');
          return;
        }
        setJob(next);
        if (next.state === 'running') {
          timer = window.setTimeout(() => void tick(), 1500);
          return;
        }
        /**
         * `state === 'done'` 之后 job 仍可能在等索引整理（`indexState === 'indexing'`），
         * 而 `refsBinding` 要等 `runImportJob` 整体返回才写 —— 此时必须先等整理落定。
         * 固定 15 次宽限（≈10s）不够：整理最长可到 indexMaintenance 的 timeout，
         * 提前放弃会把「稍后就挂上」误报成「没挂上」。
         */
        const graceLimit = next.indexState === 'indexing' ? BIND_GRACE_TICKS_INDEXING : BIND_GRACE_TICKS;
        if (!next.refsBinding && grace < graceLimit) {
          grace += 1;
          timer = window.setTimeout(() => void tick(), next.indexState === 'indexing' ? 1500 : 700);
          return;
        }
        setPhase(next.state === 'failed' || next.state === 'cancelled' ? 'failed' : 'settled');
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
        setPhase('failed');
      }
    };
    timer = window.setTimeout(() => void tick(), 600);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [phase, result]);

  // 成功后立刻通知父级刷新（不等用户关窗）
  useEffect(() => {
    if (phase !== 'settled' && phase !== 'failed') return;
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    if (job?.refsBinding) {
      const s = summarize(job.refsBinding);
      onFinished(s.text, s.tone);
      return;
    }
    const reason = job?.error ?? err ?? '导入未完成，参考文档未加入';
    onFinished(`上传已提交，但${reason}`, 'err');
  }, [phase, job, err, onFinished]);

  const close = (): void => {
    // 后端仍在跑时关窗：任务不会中断，只是不再展示进度（列表到点会自己刷新）
    if (busy && !window.confirm('导入仍在进行，关闭后不会中断（稍后刷新列表即可看到结果）。确定关闭？')) return;
    onClose();
  };

  const progressText = ((): string => {
    if (phase === 'submitting') return '上传中…';
    if (!job) return '已提交，等待导入…';
    const PHASE_TEXT: Record<string, string> = {
      scan: '扫描',
      vectorize: '向量化',
      persist: '写入元数据',
      indexing: '索引整理中',
      optimized: '索引已优化',
      available: '可用',
    };
    const phaseName = PHASE_TEXT[job.phase ?? ''] ?? '处理中';
    const total = job.progress?.total ?? 0;
    const done = job.progress?.done ?? 0;
    return total > 0 ? `${phaseName} ${done}/${total}` : `${phaseName}…`;
  })();

  const acceptedCount = result?.accepted.length ?? rows.length;
  const extensionHint = useMemo(
    () => (policy ? `支持 ${policy.extensions.join(' / ')}，单个 ≤ ${Math.round(policy.maxFileSize / 1024)}KB` : '正在读取本库的上传限制…'),
    [policy],
  );

  return (
    <div className="gov-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="gov-modal">
        <div className="gov-modal__head gov-modal__head--stack">
          <div>上传文件并加入参考文档</div>
          <div className="gov-hint">
            {extensionHint}；一次最多 {MAX_FILES} 个 · 不支持上传目录
            （需要整个目录请走「知识写入 → 上传导入」）
          </div>
        </div>

        <div className="gov-modal__body">
          <div className="gov-hint">
            参考文档 {refCount} / {refLimit} 篇
            {remaining > 0 ? `，本次最多还能加 ${remaining} 篇` : '（已达上限，请先移除部分再上传）'}
          </div>

          {phase === 'idle' || phase === 'submitting' ? (
            <>
              {/* 落点必须可见可改（D1/R5）：留空走服务端缺省，选了就以选的为准 */}
              <div className="gov-upload-group">
                <span className="gov-hint">落点 Group</span>
                <GroupPathSelect
                  scope={scope}
                  value={groupDraft}
                  onChange={setGroupDraft}
                  placeholder={defaultGroupHint ? `留空 = ${defaultGroupHint}` : '留空 = 服务端缺省落点'}
                  disabled={busy}
                />
              </div>

              <div className="gov-upload-pick">
                <button
                  className="gov-btn gov-btn--sm"
                  disabled={busy || policy === null || rows.length >= MAX_FILES}
                  title={policy === null ? policyErr ?? '正在读取上传限制' : undefined}
                  onClick={() => inputRef.current?.click()}
                >
                  选择文件
                </button>
                <span className="gov-hint">已选 {rows.length} / {MAX_FILES}</span>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={policy?.extensions.join(',')}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    addFiles(e.target.files);
                    // 允许再次选同一个文件重试（不清空的话 change 不会触发）
                    e.target.value = '';
                  }}
                />
              </div>

              {rows.length > 0 ? (
                <div className="gov-upload-list">
                  {rows.map((row, index) => (
                    <div key={`${row.file.name}-${index}`} className="gov-upload-row" data-bad={row.error ? '' : undefined}>
                      <span className="gov-upload-row__name" title={row.file.name}>{row.file.name}</span>
                      <span className="gov-upload-row__meta">{formatSize(row.file.size)}</span>
                      <span className={row.error ? 'gov-error' : 'gov-hint'}>{row.error ?? '待上传'}</span>
                      <button
                        className="gov-btn gov-btn--danger-ghost gov-btn--sm"
                        disabled={busy}
                        title="移除"
                        onClick={() => removeRow(index)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gov-empty">还没有选择文件：点「选择文件」挑本地文档，上传后自动成为本事件的参考文档。</div>
              )}

              {tooLarge ? (
                <p className="gov-error">
                  本次合计约 {formatSize(estimatedBytes)}，超过单次上传上限（约 {formatSize(UPLOAD_BODY_BUDGET_BYTES)}），请分批上传
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="gov-upload-progress">
                <span className="gov-dchip gov-dchip--run">{phase === 'settled' ? '导入完成' : phase === 'failed' ? '导入失败' : '导入中 ◐'}</span>
                <span className="gov-hint">{phase === 'running' ? progressText : ''}</span>
              </div>
              {phase === 'running' ? (
                <div className="gov-hint">
                  已提交 {acceptedCount} 个文件，导入完成后自动加入参考文档；可以关掉这个窗口，导入不会中断。
                </div>
              ) : null}
              {job?.refsBinding ? (
                <>
                  {result ? <div className="gov-hint">落点：{result.group}</div> : null}
                  <div className="gov-hint">
                    已加入 {job.refsBinding.added} 篇
                    {job.refsBinding.skipped.length > 0 ? ` · 跳过 ${job.refsBinding.skipped.length} 篇（已存在）` : ''}
                  </div>
                  {job.refsBinding.skippedConflicts.length > 0 ? (
                    <>
                      <div className="gov-hint">
                        {job.refsBinding.skippedConflicts.length} 篇同 Group 同名已存在，未覆盖（引用指向库中旧内容）：
                        {job.refsBinding.skippedConflicts.join('、')}
                      </div>
                    </>
                  ) : null}
                  {job.refsBinding.failed.length > 0 ? (
                    <div className="gov-upload-list">
                      {job.refsBinding.failed.map((f) => (
                        <div key={f.name} className="gov-upload-row" data-bad="">
                          <span className="gov-upload-row__name">{f.name}</span>
                          <span className="gov-error">{f.error}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : phase === 'failed' ? (
                <p className="gov-error">{job?.error ?? err ?? '导入失败'}</p>
              ) : null}
            </>
          )}

          {err && (phase === 'idle' || phase === 'submitting') ? <p className="gov-error">{err}</p> : null}
          {policyErr ? <p className="gov-error">读取上传限制失败：{policyErr}</p> : null}
        </div>

        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={close} disabled={phase === 'submitting'}>
            {phase === 'running' ? '后台继续' : '关闭'}
          </button>
          {phase === 'idle' || phase === 'submitting' ? (
            <button
              className="gov-btn gov-btn--sm gov-btn--primary"
              disabled={!canSubmit}
              title={rows.length > remaining ? `本次最多还能加 ${remaining} 篇` : undefined}
              onClick={() => void submit()}
            >
              {phase === 'submitting' ? '上传中…' : rows.length === 0 ? '未选择' : `上传 ${rows.length} 个文件`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
