/**
 * RulesPanel —— AI 设置 ·「AI 规则」分区（S-03）
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S03_MANAGE_DESIGN.md` §5（界面已在阶段 2.4 确认）
 * 交互基线：`demo/scope-rules/index.html`（同布局 / 同状态 / 同文案）
 *
 * 边界：本组件只做展示与调用 API；字数、配额、视图只读等判定以服务端为准，
 * 前端预校验仅用于即时反馈。导入导出按钮保留位置，S-05 上线后接线。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ChatApiError,
  createRule,
  deleteRule,
  exportRules,
  getRules,
  getRulesMeta,
  importRules,
  promoteRule,
  updateRule,
} from '@/api/chatApi';
import type {
  RuleView,
  RulesImportResult,
  RulesListView,
  RulesMetaView,
} from '@/api/chatContract';

import '@/styles/ai-rules.css';

type ExpiryChoice = 'permanent' | '1' | '7' | '30' | 'custom';

interface FormState {
  id?: string;
  scope: string;
  text: string;
  expiry: ExpiryChoice;
  date: string;
}

type ModalState =
  | { kind: 'form'; form: FormState }
  | { kind: 'delete'; rule: RuleView }
  | { kind: 'import' }
  | { kind: 'export' };

interface ImportState {
  fileName: string;
  pkg: unknown | null;
  preview: RulesImportResult | null;
  mode: 'merge' | 'replace';
  error: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_MAX = 200;

function errText(err: unknown): string {
  if (err instanceof ChatApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS));
}

function toExpiresAt(form: FormState): string | null {
  if (form.expiry === 'permanent') return null;
  if (form.expiry === 'custom') {
    if (!form.date) throw new Error('请选择到期日期');
    const at = new Date(`${form.date}T23:59:59`);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      throw new Error('到期日期必须晚于今天');
    }
    return at.toISOString();
  }
  return new Date(Date.now() + Number(form.expiry) * DAY_MS).toISOString();
}

function metaText(rule: RuleView): string {
  if (rule.source === 'ai') return `${relTime(rule.createdAt)} · AI 写入`;
  if (rule.expired) return `${fmtDate(rule.createdAt)} 创建`;
  if (rule.expiresAt) return `剩余 ${daysLeft(rule.expiresAt)} 天 · ${fmtDate(rule.expiresAt)} 到期`;
  return `永久 · ${fmtDate(rule.createdAt)} 创建`;
}

export function RulesPanel({ readOnly, locked }: { readOnly: boolean; locked: boolean }): JSX.Element {
  const [meta, setMeta] = useState<RulesMetaView | null>(null);
  const [scope, setScope] = useState('');
  const [list, setList] = useState<RulesListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [importState, setImportState] = useState<ImportState>({
    fileName: '',
    pkg: null,
    preview: null,
    mode: 'merge',
    error: '',
  });
  const [exportState, setExportState] = useState<{ target: 'current' | 'all'; includeAi: boolean }>({
    target: 'current',
    includeAi: false,
  });
  const [ioBusy, setIoBusy] = useState(false);

  const flash = useCallback((msg: string): void => {
    setNotice(msg);
    window.setTimeout(() => setNotice(''), 2200);
  }, []);

  const loadRules = useCallback(async (target: string): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setList(await getRules(target));
    } catch (err) {
      setList(null);
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const m = await getRulesMeta();
        if (!alive) return;
        setMeta(m);
        const initial = m.scopes[0] ?? Object.keys(m.views)[0] ?? m.orphans[0]?.scope ?? '';
        setScope(initial);
        if (!initial) setLoading(false);
      } catch (err) {
        if (!alive) return;
        setError(errText(err));
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (scope) void loadRules(scope);
  }, [scope, loadRules]);

  const isView = list?.isView ?? (!!meta && Object.prototype.hasOwnProperty.call(meta.views, scope));
  const isOrphan = !!meta && meta.orphans.some((o) => o.scope === scope);
  const rules = list?.rules ?? [];
  const human = rules.filter((r) => r.source === 'human');
  const ai = rules.filter((r) => r.source === 'ai');
  const usage = list?.usage ?? null;
  const humanChars = usage?.humanChars ?? human.reduce((n, r) => n + r.text.length, 0);
  const aiLimit = usage?.aiLimit ?? 20;
  const over = ai.length > aiLimit;
  const canWrite = !locked && !isView && !isOrphan;

  const updateForm = (patch: Partial<FormState>): void => {
    setModal((prev) => (prev && prev.kind === 'form'
      ? { ...prev, form: { ...prev.form, ...patch } }
      : prev));
  };

  const openForm = (rule?: RuleView): void => {
    if (!canWrite) return;
    const future = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);
    const exp = rule?.expiresAt ? new Date(rule.expiresAt) : null;
    const form: FormState = rule
      ? {
        id: rule.id,
        scope: rule.scope,
        text: rule.text,
        expiry: rule.expiresAt ? 'custom' : 'permanent',
        date: exp && exp.getTime() > Date.now() ? fmtDate(rule.expiresAt!) : future,
      }
      : { scope, text: '', expiry: 'permanent', date: future };
    setError('');
    setModal({ kind: 'form', form });
  };

  const save = async (): Promise<void> => {
    if (!modal || modal.kind !== 'form') return;
    const form = modal.form;
    const text = form.text.trim();
    if (!text) { setError('规则内容不能为空。'); return; }
    if (text.length > RULE_MAX) { setError(`规则 ${text.length} 字，超过 ${RULE_MAX} 字上限。`); return; }

    let expiresAt: string | null;
    try {
      expiresAt = toExpiresAt(form);
    } catch (err) {
      setError(errText(err));
      return;
    }

    setBusy(true);
    setError('');
    try {
      if (form.id) await updateRule(form.id, { text, expiresAt });
      else await createRule({ scope: form.scope, text, expiresAt });
      setModal(null);
      await loadRules(scope);
      flash(form.id ? '规则已更新' : '规则已新增');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: RuleView): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await deleteRule(rule.id);
      setModal(null);
      await loadRules(scope);
      flash('已删除规则');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const promote = async (rule: RuleView): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await promoteRule(rule.id);
      await loadRules(scope);
      flash('已转为人工规则（永久）');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const runImportPreview = async (pkg: unknown, mode: 'merge' | 'replace'): Promise<void> => {
    setIoBusy(true);
    try {
      const preview = await importRules(pkg, mode, true);
      setImportState((prev) => ({ ...prev, preview, error: '' }));
    } catch (err) {
      setImportState((prev) => ({ ...prev, preview: null, error: errText(err) }));
    } finally {
      setIoBusy(false);
    }
  };

  const openImport = (): void => {
    setError('');
    setImportState({ fileName: '', pkg: null, preview: null, mode: 'merge', error: '' });
    setModal({ kind: 'import' });
  };

  const openExport = (): void => {
    setError('');
    setExportState({ target: 'current', includeAi: false });
    setModal({ kind: 'export' });
  };

  const onImportFile = async (file: File | null): Promise<void> => {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setImportState((prev) => ({
        ...prev, fileName: file.name, pkg: null, preview: null, error: '文件超过 1MB，整单拒绝。',
      }));
      return;
    }
    try {
      const pkg = JSON.parse(await file.text()) as unknown;
      setImportState((prev) => ({ ...prev, fileName: file.name, pkg, preview: null, error: '' }));
      await runImportPreview(pkg, importState.mode);
    } catch (err) {
      setImportState((prev) => ({
        ...prev, fileName: file.name, pkg: null, preview: null, error: errText(err),
      }));
    }
  };

  const changeImportMode = (mode: 'merge' | 'replace'): void => {
    setImportState((prev) => ({ ...prev, mode, preview: null }));
    if (importState.pkg) void runImportPreview(importState.pkg, mode);
  };

  const applyImport = async (): Promise<void> => {
    if (!importState.pkg) return;
    setIoBusy(true);
    setError('');
    try {
      const res = await importRules(importState.pkg, importState.mode, false);
      setModal(null);
      const m = await getRulesMeta();
      setMeta(m);
      await loadRules(scope);
      flash(`已导入 ${res.imported} 条规则`);
    } catch (err) {
      setImportState((prev) => ({ ...prev, error: errText(err) }));
    } finally {
      setIoBusy(false);
    }
  };

  const doExport = async (): Promise<void> => {
    setIoBusy(true);
    setError('');
    try {
      const label = exportState.target === 'current' ? scope : 'all';
      const blob = await exportRules(label, exportState.includeAi);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'all';
      a.href = url;
      a.download = `ai-rules-${safe}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setModal(null);
      flash('已导出规则');
    } catch (err) {
      setError(errText(err));
    } finally {
      setIoBusy(false);
    }
  };


  const scopeSelect = (
    <select
      className="ai-rules__select"
      aria-label="规则所属知识库"
      value={scope}
      onChange={(e) => setScope(e.target.value)}
    >
      <optgroup label="知识库">
        {(meta?.scopes ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
      </optgroup>
      {meta && Object.keys(meta.views).length > 0 && (
        <optgroup label="视图">
          {Object.keys(meta.views).map((s) => <option key={s} value={s}>{s}（视图）</option>)}
        </optgroup>
      )}
      {meta && meta.orphans.length > 0 && (
        <optgroup label="已不存在的库">
          {meta.orphans.map((o) => <option key={o.scope} value={o.scope}>{o.scope}（库不存在）</option>)}
        </optgroup>
      )}
    </select>
  );

  const counter = isView
    ? `人工 ${human.length} 条 · AI ${ai.length} 条 · 只读`
    : `人工 ${humanChars} / ${usage?.humanLimit ?? 2000} 字 · AI ${ai.length} / ${aiLimit} 条`;

  const row = (rule: RuleView): JSX.Element => (
    <div key={rule.id} className={`ai-rules__rule${rule.expired ? ' is-expired' : ''}`}>
      <div className="ai-rules__rule-main">
        <div className="ai-rules__text">{rule.text}</div>
        <div className="ai-rules__meta">
          <span>{metaText(rule)}</span>
          {rule.source === 'ai' && <span className="ai-rules__tag is-ai">AI</span>}
          {isOrphan && <span className="ai-rules__tag is-danger">库不存在</span>}
          {rule.expired && <span className="ai-rules__tag is-warn">已过期</span>}
        </div>
      </div>
      <div className="ai-rules__rule-acts">
        {rule.source === 'ai' ? (
          <>
            <button type="button" className="ai-rules__btn is-sm" disabled={!canWrite || busy} onClick={() => void promote(rule)}>转永久</button>
            <button type="button" className="ai-rules__btn is-sm is-danger" disabled={!canWrite || busy} onClick={() => { setError(''); setModal({ kind: 'delete', rule }); }}>删除</button>
          </>
        ) : (
          <>
            <button type="button" className="ai-rules__btn is-sm" disabled={!canWrite || busy} onClick={() => openForm(rule)}>{rule.expired ? '编辑并续期' : '编辑'}</button>
            <button type="button" className="ai-rules__btn is-sm is-danger" disabled={!canWrite || busy} onClick={() => { setError(''); setModal({ kind: 'delete', rule }); }}>删除</button>
          </>
        )}
      </div>
    </div>
  );

  const empty = (title: string, hint: string): JSX.Element => (
    <div className="ai-rules__empty">
      <div className="ai-rules__empty-title">{title}</div>
      <div className="ai-rules__empty-hint">{hint}</div>
    </div>
  );

  return (
    <div className="ai-rules">
      {readOnly && (
        <div className="ai-rules__banner is-warn">
          当前账号为只读：可以查看规则，修改需要管理员写权限（ops.write）。
        </div>
      )}
      {isView && meta && (
        <div className="ai-rules__banner is-info">
          视图「{scope}」= {meta.views[scope]?.join(' + ')}。规则取成员并集，只读；要编辑请切到具体知识库。
        </div>
      )}
      {isOrphan && (
        <div className="ai-rules__banner is-warn">
          这个知识库已被删除。规则保留但不会生效，也不会再被 AI 读取；可以删除。
        </div>
      )}
      {over && (
        <div className="ai-rules__banner is-warn">
          AI 添加 {ai.length}/{aiLimit}，超出 {ai.length - aiLimit} 条：满 1 天的规则会在下次读取时按最早优先淘汰，不满 1 天的保留。
        </div>
      )}
      {error && !modal && <div className="ai-rules__banner is-danger">{error}</div>}

      <div className="ai-rules__card">
        <div className="ai-rules__scope-row">
          <label className="ai-rules__scope-label" htmlFor="ai-rules-scope">作用域</label>
          {scopeSelect}
          <span className="ai-rules__counter">{counter}</span>
        </div>
      </div>

      {loading ? (
        <div className="ai-rules__card">{empty('读取规则…', '正在加载当前知识库的规则。')}</div>
      ) : !scope ? (
        <div className="ai-rules__card">{empty('还没有知识库', '先导入一个知识库，再为它配置规则。')}</div>
      ) : (
        <>
          <div className="ai-rules__card">
            <div className="ai-rules__head">
              <div className="ai-rules__title">
                我的规则 <span className="ai-rules__muted">({human.length})</span>
                {isOrphan && <span className="ai-rules__tag is-danger">库不存在</span>}
              </div>
              <div className="ai-rules__acts">
                <button type="button" className="ai-rules__btn is-sm" disabled={!canWrite} onClick={openImport}>导入</button>
                <button type="button" className="ai-rules__btn is-sm" onClick={openExport}>导出</button>
                <button type="button" className="ai-rules__btn is-sm is-primary" disabled={!canWrite} onClick={() => openForm()}>+ 新增规则</button>
              </div>
            </div>
            {human.length === 0
              ? empty('还没有人工规则', '人工规则默认永久，可设置有效期。')
              : <div className="ai-rules__list">{human.map(row)}</div>}
          </div>

          <div className="ai-rules__card">
            <div className="ai-rules__head">
              <div className="ai-rules__title">
                AI 添加 <span className="ai-rules__muted">({ai.length}{isView ? '' : `/${aiLimit}`})</span>
              </div>
              <span className="ai-rules__hint">临时 · 超 {aiLimit} 条才淘汰；满 1 天后才可被淘汰</span>
            </div>
            {ai.length === 0
              ? empty('还没有 AI 规则', 'agent 通过 MCP 写工具沉淀；默认临时，每库上限 20 条。')
              : <div className="ai-rules__list">{ai.map(row)}</div>}
          </div>
        </>
      )}

      {modal?.kind === 'form' && (
        <div className="ai-rules__mask" onClick={() => setModal(null)}>
          <div className="ai-rules__modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ai-rules__modal-head">
              <b>{modal.form.id ? '编辑规则' : '新增规则'}</b>
              <span className="ai-rules__muted">{modal.form.scope}</span>
            </div>
            <div className="ai-rules__modal-body">
              <label className="ai-rules__field">
                <span>规则内容</span>
                <textarea
                  className="ai-rules__textarea"
                  maxLength={RULE_MAX}
                  placeholder="例如：查部署问题优先「部署运维」组。"
                  value={modal.form.text}
                  onChange={(e) => updateForm({ text: e.target.value })}
                />
                <small className="ai-rules__hint">{modal.form.text.trim().length}/{RULE_MAX} 字 · 中文按 1 字计</small>
              </label>
              <label className="ai-rules__field">
                <span>有效期</span>
                <select
                  className="ai-rules__select is-full"
                  value={modal.form.expiry}
                  onChange={(e) => updateForm({ expiry: e.target.value as ExpiryChoice })}
                >
                  <option value="permanent">永久</option>
                  <option value="1">1 天</option>
                  <option value="7">7 天</option>
                  <option value="30">30 天</option>
                  <option value="custom">自定义日期</option>
                </select>
                {modal.form.expiry === 'custom' && (
                  <input
                    type="date"
                    className="ai-rules__input"
                    value={modal.form.date}
                    onChange={(e) => updateForm({ date: e.target.value })}
                  />
                )}
                <small className="ai-rules__hint">到期后规则不再参与注入，但保留在列表里，可续期或删除。</small>
              </label>
              {error && <div className="ai-rules__err">{error}</div>}
            </div>
            <div className="ai-rules__modal-foot">
              <button type="button" className="ai-rules__btn" onClick={() => setModal(null)}>取消</button>
              <button type="button" className="ai-rules__btn is-primary" disabled={busy} onClick={() => void save()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {modal?.kind === 'delete' && (
        <div className="ai-rules__mask" onClick={() => setModal(null)}>
          <div className="ai-rules__modal is-sm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ai-rules__modal-head"><b>删除规则</b></div>
            <div className="ai-rules__modal-body">
              <div className="ai-rules__text">{modal.rule.text}</div>
              <div className="ai-rules__hint">删除后不可恢复；AI 规则删除后，下次同类任务需要重新沉淀。</div>
              {error && <div className="ai-rules__err">{error}</div>}
            </div>
            <div className="ai-rules__modal-foot">
              <button type="button" className="ai-rules__btn" onClick={() => setModal(null)}>取消</button>
              <button type="button" className="ai-rules__btn is-danger" disabled={busy} onClick={() => void remove(modal.rule)}>删除</button>
            </div>
          </div>
        </div>
      )}

      {modal?.kind === 'import' && (
        <div className="ai-rules__mask" onClick={() => setModal(null)}>
          <div className="ai-rules__modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ai-rules__modal-head">
              <b>导入规则</b>
              <span className="ai-rules__muted">JSON · 整单事务</span>
            </div>
            <div className="ai-rules__modal-body">
              <div className="ai-rules__field">
                <span>选择文件</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)}
                />
                <div className="ai-rules__hint">
                  {importState.fileName || '未选择文件'} · 文件 ≤1MB、≤500 条、单条 ≤200 字、每库 ≤2000 字
                </div>
              </div>

              {importState.preview && (
                <div className="ai-rules__counts">
                  <div><b>{importState.preview.scopes}</b> 个库</div>
                  <div>新增 <b>{importState.preview.imported}</b> 条</div>
                  <div>跳过 <b>{importState.preview.skippedDuplicate}</b> 条（同库同文本已存在）</div>
                  <div>跳过 AI 规则 <b>{importState.preview.skippedAi}</b> 条（不导入）</div>
                  <div>已过期 <b>{importState.preview.expired}</b> 条（保留并标注）</div>
                  {importState.preview.orphanScopes.length > 0 && (
                    <div>
                      库不存在 <b>{importState.preview.orphanScopes.reduce((n, o) => n + o.count, 0)}</b> 条（含在新增内）
                    </div>
                  )}
                </div>
              )}

              <div className="ai-rules__field">
                <span>导入方式</span>
                <label className="ai-rules__radio">
                  <input
                    type="radio"
                    checked={importState.mode === 'merge'}
                    onChange={() => changeImportMode('merge')}
                  />
                  合并（推荐）
                </label>
                <label className="ai-rules__radio">
                  <input
                    type="radio"
                    checked={importState.mode === 'replace'}
                    onChange={() => changeImportMode('replace')}
                  />
                  覆盖目标库人工规则
                </label>
                <div className="ai-rules__hint">覆盖只清包内出现的库的人工规则，AI 规则不动。</div>
              </div>

              {importState.error && <div className="ai-rules__err">{importState.error}</div>}
            </div>
            <div className="ai-rules__modal-foot">
              <button type="button" className="ai-rules__btn" onClick={() => setModal(null)}>取消</button>
              <button
                type="button"
                className="ai-rules__btn is-primary"
                disabled={!importState.preview || ioBusy}
                onClick={() => void applyImport()}
              >
                确认导入{importState.preview ? ` ${importState.preview.imported} 条` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal?.kind === 'export' && (
        <div className="ai-rules__mask" onClick={() => setModal(null)}>
          <div className="ai-rules__modal is-sm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ai-rules__modal-head">
              <b>导出规则</b>
              <span className="ai-rules__muted">JSON</span>
            </div>
            <div className="ai-rules__modal-body">
              <div className="ai-rules__field">
                <span>范围</span>
                <label className="ai-rules__radio">
                  <input
                    type="radio"
                    checked={exportState.target === 'current'}
                    onChange={() => setExportState((prev) => ({ ...prev, target: 'current' }))}
                  />
                  当前库 {scope}
                </label>
                <label className="ai-rules__radio">
                  <input
                    type="radio"
                    checked={exportState.target === 'all'}
                    onChange={() => setExportState((prev) => ({ ...prev, target: 'all' }))}
                  />
                  全部库
                </label>
              </div>
              <div className="ai-rules__field">
                <span>内容</span>
                <label className="ai-rules__radio">
                  <input
                    type="checkbox"
                    checked={exportState.includeAi}
                    onChange={(e) => setExportState((prev) => ({ ...prev, includeAi: e.target.checked }))}
                  />
                  包含 AI 临时规则
                </label>
              </div>
              <div className="ai-rules__hint">
                {exportState.target === 'current'
                  ? `预计 ${(list?.rules ?? []).filter((r) => exportState.includeAi || r.source === 'human').length} 条`
                  : '全部库'}
              </div>
              {error && <div className="ai-rules__err">{error}</div>}
            </div>
            <div className="ai-rules__modal-foot">
              <button type="button" className="ai-rules__btn" onClick={() => setModal(null)}>取消</button>
              <button type="button" className="ai-rules__btn is-primary" disabled={ioBusy} onClick={() => void doExport()}>
                导出 JSON
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && <div className="ai-rules__toast">{notice}</div>}
    </div>
  );
}
