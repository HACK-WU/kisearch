/**
 * 对话配置层（提示词 / Skill / 工具开关）—— 对话配置层 · 批次 1
 *
 * 定位：**面板内层**（`position:absolute; inset:0` 覆盖对话面板），不是 app 级抽屉 ——
 * 常驻面板宽 380px，任何"比面板还宽"的抽屉都装不下（见 docs/ui-design §7-7）。
 * 编辑动作则**跳出面板**：走 `PromptConfigModal`（portal 到 body），与 demo 的最终口径一致。
 *
 * 数据流：`usePromptConfig` 拉配置 → 层内持有**草稿** → 底栏「保存」整体替换提交。
 * 因此「取消」= 直接关闭并丢弃草稿，天然是回滚（无需快照对比）。
 *
 * ⚠️ 工具开关**批次 2 起真实生效**：保存后下一次提问即按开关暴露工具给 AI；
 *   写入/删除组开启需二次确认（开启 = 授权 AI 直接执行该类操作）。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import type { PromptConfig, PromptSkill } from '@/api/chatContract';
import { PromptConfigModal, type PromptEditDraft } from '@/chat/PromptConfigModal';
import { usePromptConfig } from '@/chat/usePromptConfig';

interface ConfirmState {
  title: string;
  text: string;
  onYes: () => void;
}

type ModalState =
  | { kind: 'prompt' }
  | { kind: 'new-skill' }
  | { kind: 'skill'; id: string };

/** 条目类型图标（与 demo 同一套，纯装饰） */
const ITEM_IC: Record<'prompt' | 'skill', ReactElement> = {
  prompt: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3" />
    </svg>
  ),
  skill: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 2.2l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.6l-3.3 1.8.7-3.7L2.7 6.1l3.7-.5z" />
    </svg>
  ),
};

const cloneConfig = (c: PromptConfig): PromptConfig => ({
  version: c.version,
  prompt: { ...c.prompt },
  skills: c.skills.map((s) => ({ ...s })),
  tools: { ...c.tools },
});

/** 新增 skill 的 id：符合服务端 `SKILL_ID_RE`（小写字母/数字开头，允许连字符） */
const newSkillId = () => `skill-${Date.now().toString(36)}`;

export function PromptConfigLayer({ onClose }: { onClose: () => void }) {
  const { loading, loadError, data, saving, saveError, fieldErrors, savedAt, reload, save } =
    usePromptConfig(true);

  const [draft, setDraft] = useState<PromptConfig | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [showSavedBar, setShowSavedBar] = useState(false);

  // 载入 / 保存成功后（服务端回传了新基线）都重置草稿，保证"内容 = 磁盘"
  useEffect(() => {
    if (data) setDraft(cloneConfig(data.config));
  }, [data]);

  // "已保存"顶部细条：1.2s 自隐
  useEffect(() => {
    if (savedAt == null) return;
    setShowSavedBar(true);
    const t = setTimeout(() => setShowSavedBar(false), 1200);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Esc 分层退出：确认卡 → 模态（模态自带未保存确认）→ 配置层
  // ⚠️ 真机走查修正：原实现遇到 confirm 直接 return 且**没人在关卡**，
  //    导致"危险确认卡打开时 Esc 完全无效"（demo 有分层，落地时漏了）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modal) return; // 模态框自己处理（它还有一层未保存确认）
      if (confirm) {
        setConfirm(null);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, confirm, onClose]);

  const groups = data?.toolGroups ?? [];
  /** 只读组默认开，危险组默认关 —— 但以配置里的实际值为准 */
  const toolEntries = useMemo(
    () => groups.map((g) => ({ ...g, rows: g.names.map((n) => ({ name: n, on: draft?.tools[n] === true })) })),
    [groups, draft],
  );

  const isDefault = (content: string): boolean => {
    const def = data?.defaults;
    if (!def) return false;
    return (
      def.prompt.content === content ||
      def.skills.some((s) => s.content === content)
    );
  };

  const patchSkill = (id: string, patch: Partial<PromptSkill>) => {
    setDraft((d) => (d ? { ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d));
  };

  const handleSave = () => {
    if (!draft) return;
    void save(draft);
  };

  const modalItem: PromptEditDraft | null = (() => {
    if (!modal || !draft) return null;
    if (modal.kind === 'prompt') {
      return { id: 'prompt', name: '基础提示词', content: draft.prompt.content, builtin: true };
    }
    if (modal.kind === 'new-skill') {
      return { id: newSkillId(), name: '', content: '', builtin: false };
    }
    const s = draft.skills.find((x) => x.id === modal.id);
    return s ? { id: s.id, name: s.name, content: s.content, builtin: s.builtin } : null;
  })();

  return (
    <section className="ki-chat-cfg" data-open="true" role="dialog" aria-modal="true" aria-label="对话配置">
      <div className="ki-chat-cfg__savedbar" data-open={showSavedBar} />

      <header className="ki-chat-cfg__head">
        <span className="ki-chat-cfg__title">对话配置</span>
        <span className="ki-chat-cfg__spacer" />
        <button type="button" className="ki-chat-iconbtn" aria-label="关闭配置" onClick={onClose}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </header>

      <div className="ki-chat-cfg__body">
        {loading && <p className="ki-chat-cfg__hint">读取配置…</p>}
        {loadError && (
          <p className="ki-chat-cfg__warn">
            {loadError}
            <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={reload}>重试</button>
          </p>
        )}
        {/* 配置源损坏已回退默认：必须可见（fail-loud），否则用户会以为"我的改动没保存上" */}
        {data?.issue && <p className="ki-chat-cfg__warn">配置文件有问题，已回退默认：{data.issue}</p>}

        {draft && data && (
          <>
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">基础提示词</span>
              <div className="ki-chat-cfg__list">
                <ItemCard
                  group="prompt"
                  name="基础提示词"
                  content={draft.prompt.content}
                  isDefault={isDefault(draft.prompt.content)}
                  onClick={() => setModal({ kind: 'prompt' })}
                />
              </div>
            </div>

            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                Skill
                <em className="ki-chat-cfg__badge">{draft.skills.filter((s) => s.enabled).length} / {data.limits.maxSkills} 启用</em>
              </span>
              <div className="ki-chat-cfg__list">
                {draft.skills.map((s) => (
                  <ItemCard
                    key={s.id}
                    group="skill"
                    name={s.name}
                    content={s.content}
                    isDefault={isDefault(s.content)}
                    disabled={!s.enabled}
                    onClick={() => setModal({ kind: 'skill', id: s.id })}
                  />
                ))}
              </div>
              <button
                type="button"
                className="ki-chat-cfg__add"
                disabled={draft.skills.length >= data.limits.maxSkills}
                onClick={() => setModal({ kind: 'new-skill' })}
              >
                ＋ 新增 skill
              </button>
            </div>

            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                工具与权限
              </span>
              <p className="ki-chat-cfg__hint">保存后下一次提问生效：开启的工具将真实暴露给 AI。默认只开只读工具；写入 / 删除开启即授权 AI 执行，请谨慎。</p>
              {toolEntries.map((g) => (
                <div key={g.key}>
                  <p className={`ki-chat-cfg__group${g.danger ? ' ki-chat-cfg__group--danger' : ''}`}>
                    <span className="ki-chat-cfg__group-dot" aria-hidden="true" />
                    {g.label}
                    <span className="ki-chat-cfg__group-n">
                      {g.rows.length} 个{g.danger ? ' · 危险 · 默认关' : ' · 默认开'}
                    </span>
                  </p>
                  {g.rows.map((r) => (
                    <div className="ki-chat-cfg__tool" key={r.name}>
                      <span className="ki-chat-cfg__tool-main">
                        <span className="ki-chat-cfg__tool-name" title={r.name}>{r.name}</span>
                        {g.descs?.[r.name] ? <span className="ki-chat-cfg__tool-desc">{g.descs[r.name]}</span> : null}
                      </span>
                      <span className="ki-chat-cfg__tool-sp" />
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.on}
                        aria-label={r.name}
                        className={`ki-chat-cfg__sw${g.danger ? ' ki-chat-cfg__sw--danger' : ''}`}
                        onClick={() => {
                          const next = !r.on;
                          const apply = () => setDraft((d) => (d ? { ...d, tools: { ...d.tools, [r.name]: next } } : d));
                          if (next && g.danger) {
                            setConfirm({
                              title: '开启危险工具',
                              text: `${r.name} 会改动当前 scope 的知识库内容。开启后 AI 可在对话中直接执行该操作，请谨慎。`,
                              onYes: apply,
                            });
                            return;
                          }
                          apply();
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <footer className="ki-chat-cfg__bar">
        {saveError && <span className="ki-chat-cfg__err">{saveError}</span>}
        <span className="ki-chat-cfg__spacer" />
        <span className="ki-chat-cfg__scope">作用域：全局 · 下一次提问生效</span>
        <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={onClose}>取消</button>
        <button
          type="button"
          className="ki-chat-btn"
          disabled={saving || !draft}
          data-busy={saving}
          onClick={handleSave}
        >
          {saving ? '保存中' : '保存'}
        </button>
      </footer>

      {fieldErrors.length > 0 && (
        <div className="ki-chat-cfg__toast" data-open="true" role="status">
          {fieldErrors.map((f) => `${f.field}：${f.message}`).join('；')}
        </div>
      )}

      {modalItem && modal && (
        <PromptConfigModal
          mode={modal.kind === 'new-skill' ? 'new' : 'edit'}
          group={modal.kind === 'prompt' ? 'prompt' : 'skill'}
          item={modalItem}
          maxChars={modal.kind === 'prompt' ? data!.limits.promptMaxChars : data!.limits.skillMaxChars}
          nameMaxChars={data!.limits.skillNameMaxChars}
          canRename={modal.kind !== 'prompt' && !modalItem.builtin}
          canReset={modal.kind !== 'new-skill' && modalItem.builtin}
          canDelete={modal.kind !== 'new-skill' && !modalItem.builtin}
          checkName={(name) =>
            draft && draft.skills.some((s) => s.id !== modalItem.id && s.name === name)
              ? '已有同名 skill，请换一个名字'
              : null
          }
          onCancel={() => setModal(null)}
          onSubmit={({ name, content }) => {
            setDraft((d) => {
              if (!d) return d;
              if (modal.kind === 'prompt') return { ...d, prompt: { ...d.prompt, content } };
              if (modal.kind === 'new-skill') {
                return {
                  ...d,
                  skills: [...d.skills, { id: modalItem.id, name, content, builtin: false, enabled: true, at: new Date().toISOString() }],
                };
              }
              return { ...d, skills: d.skills.map((s) => (s.id === modal.id ? { ...s, name, content } : s)) };
            });
            setModal(null);
          }}
          onReset={() => {
            if (modal.kind === 'prompt') {
              setDraft((d) => (d ? { ...d, prompt: { ...d.prompt, content: data!.defaults.prompt.content } } : d));
              setModal(null);
              return;
            }
            if (modal.kind === 'skill') {
              const def = data!.defaults.skills.find((s) => s.id === modal.id);
              patchSkill(modal.id, { content: def?.content ?? '' });
              setModal(null);
            }
          }}
          onDelete={() => {
            if (modal.kind !== 'skill') return;
            const id = modal.id;
            setConfirm({
              title: '删除 skill',
              text: '该 skill 将被移除，保存后不可撤销。',
              onYes: () => setDraft((d) => (d ? { ...d, skills: d.skills.filter((s) => s.id !== id) } : d)),
            });
            setModal(null);
          }}
        />
      )}

      {confirm && (
        <div className="ki-chat-cfg__mask" role="presentation">
          <div className="ki-chat-cfg__card" role="alertdialog" aria-modal="true">
            <h4>{confirm.title}</h4>
            <p>{confirm.text}</p>
            <div className="ki-chat-cfg__card-acts">
              <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={() => setConfirm(null)}>取消</button>
              <button
                type="button"
                className="ki-chat-btn ki-chat-btn--danger"
                onClick={() => { confirm.onYes(); setConfirm(null); }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 条目卡片（提示词 / skill 共用） */
function ItemCard(props: {
  group: 'prompt' | 'skill';
  name: string;
  content: string;
  isDefault: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { group, name, content, isDefault, disabled, onClick } = props;
  const mod = !isDefault;
  return (
    <button type="button" className="ki-chat-cfg__item" onClick={onClick} data-disabled={disabled}>
      <span className={`ki-chat-cfg__item-ic ki-chat-cfg__item-ic--${group}`}>{ITEM_IC[group]}</span>
      <span className="ki-chat-cfg__item-main">
        <span className="ki-chat-cfg__item-name">{name}</span>
        <span className="ki-chat-cfg__item-prev">{content.slice(0, 42) || '（空）'}</span>
      </span>
      <span className={`ki-chat-cfg__item-meta${mod ? ' ki-chat-cfg__item-meta--mod' : ''}`}>
        {content.length} 字 · {mod ? '已修改' : '默认'}
      </span>
      <svg className="ki-chat-cfg__chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M6.5 4 10.5 8 6.5 12" />
      </svg>
    </button>
  );
}
