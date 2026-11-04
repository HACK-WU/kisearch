/**
 * 编辑数据源（2026-10-30）：同步参数 + 定时同步，单按钮保存。
 *
 * 语义边界：
 *  - 身份字段只读（scope / 仓库来源 / 分支 / 子目录 / 源目录 / 落点 Group）——换源需移除后重加
 *  - 参数自**下次同步**起生效；历史文档不回填（勾「保存后立即全量同步」才会重建）
 *  - 配置与定时是两个写接口：先配置后定时，任一步失败都会明确"哪部分已保存"
 */
import { useEffect, useRef, useState } from 'react';
import {
  saveDataSourceSchedule,
  syncDataSource,
  updateDataSourceConfig,
  type DataSourceRecordView,
  type DataSourceScheduleView,
} from '@/api/httpApi';
import { useVectorAvailability } from '@/lib/hooks';
import {
  formatDateTime,
  formFromSchedule,
  isSameForm,
  SYNC_STATE_LABEL,
  toScheduleInput,
  validateScheduleForm,
  type ScheduleFormState,
} from '@/lib/datasourceSchedule';
import {
  CONFLICT_OPTIONS,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_OVERLAP,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  SUGGESTED_CHUNK_SIZE_MAX,
  SUGGESTED_CHUNK_SIZE_MIN,
  buildConfigPatch,
  chunkRangeNotice,
  formFromRecord,
  isConfigDirty,
  validateChunkFields,
  type EditConfigForm,
} from '@/lib/datasourceEdit';
import {
  mappingRowsEqual,
  rowsFromMappings,
  toMappingPayload,
  validateMappingRows,
  type MappingRow,
} from '@/lib/datasourceMappings';
import { DatasourceMappingsEditor } from './DatasourceMappingsEditor';
import { DatasourceScheduleFields } from './DatasourceScheduleFields';

export interface DatasourceEditDialogProps {
  record: DataSourceRecordView;
  schedulerDisabled?: boolean;
  onClose: () => void;
  onSaved: (message: string, tone?: 'info' | 'warn') => void;
}

function apiError(err: unknown, fallback: string): string {
  const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
  const code = e.body?.code;
  if (code === 'DATASOURCE_STALE') return '配置已在别处修改，请关闭后重新打开';
  if (code === 'SYNC_IN_PROGRESS' || code === 'SCOPE_OPERATION_BUSY') return '该知识库正在同步，完成后再保存';
  if (code === 'DATASOURCE_NOT_FOUND' || e.status === 404) return '数据源不存在（可能已被移除）';
  return e.body?.error ?? e.message ?? fallback;
}

export function DatasourceEditDialog({
  record,
  schedulerDisabled,
  onClose,
  onSaved,
}: DatasourceEditDialogProps): JSX.Element {
  const [base, setBase] = useState<DataSourceRecordView>(record);
  /**
   * 向量可用性（2026-11-02）：只用于**说明**，不置灰开关 ——
   * 「向量化」是持久配置，开关置灰会把用户唯一的自救路径（关掉它改走仅全文）锁死；
   * 与导入页不同，那里的开关只作用于"本次导入"，所以可以置灰。
   */
  const vectorAvailability = useVectorAvailability();
  const vectorAvailable = vectorAvailability.status === 'available';
  const [configForm, setConfigForm] = useState<EditConfigForm>(() => formFromRecord(record));
  const [scheduleBase, setScheduleBase] = useState<DataSourceScheduleView | null | undefined>(record.schedule);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(() => formFromSchedule(record.schedule));
  const [syncAfterSave, setSyncAfterSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** 配置已落盘、定时写失败：关闭确认要说明"丢的只是定时修改" */
  const [partialSaved, setPartialSaved] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  /** 映射（REQ-20261104-002）：旧 daemon 不下发 mappings ⇒ 只读展示，不提供编辑（不做假功能） */
  const mappingEditable = record.mappings !== undefined;
  const legacyMapping = { relativeRoot: record.git?.relativeRoot ?? '', group: record.group };
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(
    () => rowsFromMappings(record.mappings, legacyMapping),
  );
  const mappingError = mappingEditable ? validateMappingRows(mappingRows) : null;
  const mappingsDirty = mappingEditable
    && !mappingRowsEqual(mappingRows, record.mappings, legacyMapping);
  const configDirty = isConfigDirty(base, configForm) || mappingsDirty;
  const scheduleDirty = !isSameForm(scheduleForm, formFromSchedule(scheduleBase));
  const dirty = configDirty || scheduleDirty;
  // 传存量基准：值未改动时跳过范围校验，避免历史超界值把"只改同名策略"也拦住
  const chunkBase = formFromRecord(base);
  const chunkValidation = validateChunkFields(
    configForm.chunkSize,
    configForm.chunkOverlap,
    chunkBase,
  );
  // 存量超界值仍要看得见（放行 ≠ 合规），但不阻塞保存
  const chunkRangeWarn = chunkValidation.ok
    ? chunkRangeNotice(configForm.chunkSize, configForm.chunkOverlap, chunkBase)
    : null;
  const scheduleValidation = validateScheduleForm(scheduleForm);
  const canSave = dirty
    && chunkValidation.ok
    && mappingError === null
    && (!scheduleDirty || scheduleValidation.ok)
    && !saving;

  // 焦点落在弹窗容器，不落到首个字段：否则一打开就是一整圈主色光晕，
  // 视觉重心错位（用户会以为要改「同名策略」）。键盘 Tab 一次即到首个字段。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (dirty) setDiscardOpen(true);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, onClose]);

  const requestClose = (): void => {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const patchConfig = (next: Partial<EditConfigForm>): void => {
    setConfigForm((prev) => ({ ...prev, ...next }));
    setError(null);
    setDiscardOpen(false);
  };

  const patchSchedule = (next: Partial<ScheduleFormState>): void => {
    setScheduleForm((prev) => ({ ...prev, ...next }));
    setError(null);
    setDiscardOpen(false);
  };

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const notes: string[] = [];
    const didConfig = configDirty;
    try {
      if (configDirty) {
        const patch = {
          ...buildConfigPatch(base, configForm),
          ...(mappingsDirty ? { mappings: toMappingPayload(mappingRows) } : {}),
        };
        const response = await updateDataSourceConfig({
          scope: base.scope,
          baseRevision: base.revision ?? 0,
          patch,
        });
        setBase(response.record);
        // 服务端会归一（去空白 / 空 Group→null），按返回值回填，避免"看起来改了但没生效"
        setMappingRows(rowsFromMappings(response.record.mappings, {
          relativeRoot: response.record.git?.relativeRoot ?? '',
          group: response.record.group,
        }));
        notes.push(`同步参数已保存（${response.changed.length} 项）`);
      }
      if (scheduleDirty) {
        try {
          const response = await saveDataSourceSchedule({
            scope: base.scope,
            schedule: toScheduleInput(scheduleForm, scheduleBase?.revision),
          });
          setScheduleBase(response.schedule);
          notes.push('定时同步已更新');
        } catch (err) {
          if (notes.length > 0) setPartialSaved(true);
          setError(`${notes.length > 0 ? `${notes.join('；')}；` : ''}定时未保存：${apiError(err, '保存失败')}`);
          return;
        }
      }
      if (didConfig && syncAfterSave) {
        try {
          const sync = await syncDataSource({ scope: base.scope, full: true });
          notes.push(`已触发全量同步（任务 ${sync.taskId.slice(0, 8)}）`);
        } catch (err) {
          onSaved(`${notes.join('；')}；全量同步触发失败：${apiError(err, '请稍后手动同步')}`, 'warn');
          return;
        }
      }
      onSaved(notes.join('；') || '没有变更');
    } catch (err) {
      setError(apiError(err, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  const git = base.type === 'git' ? base.git : undefined;
  const lastSync = base.lastSync
    ? `${formatDateTime(base.lastSync.at)} · ${SYNC_STATE_LABEL[base.lastSync.state] ?? base.lastSync.state}`
    : '尚未同步过';

  return (
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog ki-dialog--form ki-ds-edit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ki-ds-edit-title"
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <div>
            <h3 className="ki-dialog__title" id="ki-ds-edit-title">编辑数据源 · {base.scope}</h3>
            <p className="ki-ds-add__sub">同步参数自下次同步起生效；历史文档不回填</p>
          </div>
          <button type="button" className="ki-dialog__close" aria-label="关闭编辑" onClick={requestClose}>✕</button>
        </header>

        <div className="ki-dialog__body ki-ds-edit__body">
          {/* ① 基本信息（只读） */}
          <section className="ki-ds-edit__section">
            <div className="ki-ds-edit__title">基本信息</div>
            <dl className="ki-ds-edit__facts">
              <div>
                <dt>知识库</dt>
                <dd>{base.scope}</dd>
              </div>
              {git ? (
                <>
                  <div>
                    <dt>仓库来源</dt>
                    <dd className="ki-ds-edit__mono" title={git.remoteUrl ?? ''}>{git.remoteUrl ?? '本地仓库'}</dd>
                  </div>
                  <div>
                    <dt>分支</dt>
                    <dd>{git.branch ?? 'detached'}</dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt>源目录</dt>
                  <dd className="ki-ds-edit__mono" title={base.dir}>{base.dir}</dd>
                </div>
              )}
              <div>
                <dt>上次同步</dt>
                <dd>{lastSync}</dd>
              </div>
            </dl>

            {/* ④ 目录 → 落点 Group（REQ-20261104-002）：自本需求起**可编辑**（旧 daemon 无 mappings → 只读） */}
            <div className="ki-ds-edit__title" style={{ marginTop: 14 }}>目录 → 落点 Group</div>
            {mappingEditable ? (
              <>
                <DatasourceMappingsEditor
                  idPrefix="ki-ds-edit"
                  scope={base.scope}
                  rows={mappingRows}
                  onChange={setMappingRows}
                  disabled={saving}
                  error={mappingError}
                  hint="保存后**下次同步**生效。"
                />
                {mappingsDirty ? (
                  <p className="ki-form-hint ki-ds-edit__hint--warn" role="status">
                    改 Group：旧组文档会保留并产生重复，需在「待删除的文档」里手动清理；
                    删除某条映射：该子目录的文档本次不会自动列入待删候选（下次同步后按新的映射重算）。
                  </p>
                ) : null}
              </>
            ) : (
              <p className="ki-form-hint">
                当前 daemon 不支持多映射（旧版本）：这里只读显示
                「{git?.relativeRoot || '（仓库根）'} → {base.group ?? '自动：按顶层子目录'}」。
                升级并重启 daemon 后可在此增删映射。
              </p>
            )}
          </section>

          {/* ② 同步参数 */}
          <section className="ki-ds-edit__section">
            <div className="ki-ds-edit__title">同步参数</div>

            <div className="ki-ds-edit__row">
              <span className="ki-ds-edit__label">同名策略</span>
              <div className="ki-ds-edit__control">
                <select
                  className="ki-form-select"
                  value={configForm.conflictMode}
                  aria-label="同名策略"
                  onChange={(event) => patchConfig({ conflictMode: event.target.value })}
                >
                  {CONFLICT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {configForm.conflictMode === 'suffix' ? (
                  <input
                    type="text"
                    className="ki-form-input"
                    value={configForm.conflictSuffix}
                    aria-label="同名后缀模板"
                    placeholder="_{n}"
                    onChange={(event) => patchConfig({ conflictSuffix: event.target.value })}
                  />
                ) : null}
                <p className="ki-form-hint">遇到同名文档时的处理方式；后缀模式用 {'{n}'} 代表序号</p>
              </div>
            </div>

            <div className="ki-ds-edit__row">
              <span className="ki-ds-edit__label">向量化</span>
              <div className="ki-ds-edit__control">
                <button
                  type="button"
                  className={`ki-switch${configForm.vector ? ' ki-switch--on' : ''}`}
                  role="switch"
                  aria-checked={configForm.vector}
                  aria-label="向量化"
                  onClick={() => patchConfig({ vector: !configForm.vector })}
                >
                  <span className="ki-switch__knob" />
                </button>
                <span className="ki-ds-sched-hint">{configForm.vector ? '开启（写入向量层）' : '关闭（仅全文）'}</span>
              </div>
            </div>
            {/* 向量不可用时的说明（2026-11-02 用户定稿）：**不置灰开关**，只说明后果与出路。
                开关在此处是持久配置 —— 置灰等于把用户唯一的自救路径（关掉它改走仅全文）锁死。 */}
            {vectorAvailable ? null : (
              <p className="ki-ds-vector-hint" role="status">
                {configForm.vector ? '⚠ 当前向量服务不可用' : '当前按「仅全文」同步'}
                {configForm.vector && vectorAvailability.reason ? `（${vectorAvailability.reason}）` : ''}
                {configForm.vector
                  ? '：保持开启时同步会整体失败；关闭后按「仅全文」同步，正文与全文索引正常写入，'
                    + '之后可用 ki restore <scope> --rebuild-vector 补齐向量。'
                  : '：不生成向量，全文检索可用（修好 embedding 后可 ki restore <scope> --rebuild-vector 补齐）。'}
              </p>
            )}

            <div className="ki-ds-edit__row">
              <span className="ki-ds-edit__label">切分参数</span>
              <div className="ki-ds-edit__control">
                <div className="ki-ds-edit__chunk">
                  <input
                    type="number"
                    min={MIN_CHUNK_SIZE}
                    max={MAX_CHUNK_SIZE}
                    step={1}
                    className="ki-form-input"
                    value={configForm.chunkSize}
                    aria-label="每段目标字符数"
                    aria-invalid={!chunkValidation.ok && chunkValidation.field === 'chunkSize' ? true : undefined}
                    placeholder="1000"
                    onChange={(event) => patchConfig({ chunkSize: event.target.value })}
                  />
                  <span aria-hidden="true">/</span>
                  <input
                    type="number"
                    min={0}
                    max={MAX_CHUNK_OVERLAP}
                    step={1}
                    className="ki-form-input"
                    value={configForm.chunkOverlap}
                    aria-label="相邻两段重叠字符数"
                    aria-invalid={!chunkValidation.ok && chunkValidation.field === 'chunkOverlap' ? true : undefined}
                    placeholder="150"
                    onChange={(event) => patchConfig({ chunkOverlap: event.target.value })}
                  />
                </div>
                <p
                  className={`ki-form-hint${chunkValidation.ok ? '' : ' ki-ds-edit__hint--warn'}`}
                  role={chunkValidation.ok ? undefined : 'alert'}
                >
                  {chunkValidation.ok
                    ? `每段 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE}（建议 ${SUGGESTED_CHUNK_SIZE_MIN}–${SUGGESTED_CHUNK_SIZE_MAX}）`
                      + ` · 重叠 0–${MAX_CHUNK_OVERLAP} · 留空取默认 ${DEFAULT_CHUNK_SIZE} / ${DEFAULT_CHUNK_OVERLAP}`
                    : chunkValidation.message}
                </p>
                {chunkRangeWarn && (
                  // `.ki-ds-edit__control .ki-form-hint` 把 margin 归零了，两条提示会紧贴，
                  // 这里补 2px 保持"一行常规 + 一行告警"的层级可读
                  <p className="ki-form-hint ki-ds-edit__hint--warn" style={{ marginTop: 2 }}>{chunkRangeWarn}</p>
                )}
              </div>
            </div>

            {/* 落点 Group 已上移到「基本信息 → 目录 → 落点 Group」（2026-11-04 多映射），
                这里不再重复一份只读值 —— 两处显示同一个配置会让人以为有两套设置。 */}

            <label className={`ki-ds-edit__check${configDirty ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                checked={syncAfterSave && configDirty}
                disabled={!configDirty || saving}
                onChange={(event) => setSyncAfterSave(event.target.checked)}
              />
              保存后立即全量同步（历史文档按新参数重新切分/向量化）
            </label>
            {!configDirty && (
              <p className="ki-ds-edit__check-hint">修改上面任一项后可勾选</p>
            )}
          </section>

          {/* ③ 定时同步（启用开关 + 设置） */}
          <section className="ki-ds-edit__section">
            <div className="ki-ds-edit__title">定时同步</div>
            <DatasourceScheduleFields
              form={scheduleForm}
              onChange={patchSchedule}
              schedule={scheduleBase}
              schedulerDisabled={schedulerDisabled}
              dirty={scheduleDirty}
            />
          </section>

          {error ? <p className="ki-write-error" role="alert">{error}</p> : null}
        </div>

        <footer className="ki-dialog__foot">
          {discardOpen ? (
            <>
              <span className="ki-ds-sched-discard">
                {partialSaved ? '同步参数已保存；丢弃未保存的定时修改？' : '放弃未保存的修改？'}
              </span>
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => setDiscardOpen(false)}>继续编辑</button>
              <button type="button" className="ki-btn ki-btn--danger ki-btn--small" onClick={onClose}>放弃</button>
            </>
          ) : (
            <>
              <button type="button" className="ki-btn ki-btn--secondary" disabled={saving} onClick={requestClose}>取消</button>
              <button
                type="button"
                className="ki-btn ki-btn--primary"
                disabled={!canSave}
                onClick={() => { void save(); }}
              >{saving ? '保存中…' : '保存'}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
