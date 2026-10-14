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
import {
  CONTEXT_LIMIT_K_MAX,
  DEFAULT_CONTEXT_CHARS,
  contextLimitHint,
  contextLimitToKText,
  formatKUnit,
  parseContextLimitK,
} from '@/lib/contextUsage';

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
  // ★ 可选字段必须**显式搬运**：这是白名单式拷贝，漏掉它会让草稿静默丢掉用户覆盖值
  //   （表现为"改了 skill 保存一下，上下文上限就被清回默认了"）
  ...(c.contextChars !== undefined ? { contextChars: c.contextChars } : {}),
});

/** 新增 skill 的 id：符合服务端 `SKILL_ID_RE`（小写字母/数字开头，允许连字符） */
const newSkillId = () => `skill-${Date.now().toString(36)}`;

export interface PromptConfigLayerProps {
  onClose: () => void;
  /**
   * 保存成功后通知外层重拉 `GET /api/chat/config` —— 让上下文面板的分母 / 占比 / 预警档位
   * 立即跟着变（不刷新页面）。
   */
  onSaved: () => void;
}

export function PromptConfigLayer({ onClose, onSaved }: PromptConfigLayerProps) {
  const { loading, loadError, data, saving, saveError, fieldErrors, savedAt, reload, save } =
    usePromptConfig(true);

  const [draft, setDraft] = useState<PromptConfig | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [showSavedBar, setShowSavedBar] = useState(false);

  // ── 上下文窗口（REQ-20261014-001）：**随层主「保存」提交**，与其余项同一个文件 ──
  //    用户裁决（2026-10-14）：`config.yaml` 的 `llm.contextChars` 只作**部署默认**，
  //    界面上改的值单独存在 `prompt-config.json` 的 `contextChars`（**缺省 = 未覆盖**）。
  //    因此它与 skill / 工具开关同属一份配置、同一个保存动作 —— 不再需要独立「应用」按钮，
  //    也就不会再有"跨文件写入无法原子"的问题。
  //    输入单位是 **K**（与面板显示同口径），落盘前换算为字符数。
  const [ctxText, setCtxText] = useState('');

  /** 「恢复默认」的目标值 = 部署默认（config.yaml 的 llm.contextChars，缺省 1000K） */
  const ctxDefaultChars = data?.contextCharsDefault ?? DEFAULT_CONTEXT_CHARS;
  const ctxTextInvalid = ctxText.trim() !== '' && parseContextLimitK(ctxText) === null;
  /** 是否用了用户覆盖值（决定徽标显示"自定义"还是"默认"） */
  const ctxOverridden = draft?.contextChars !== undefined;
  /** 合法但会显著影响读数体验的值（过小 → 长期预警区；过大 → 预警失效）：只提示、不拦截（R6） */
  const ctxSizeHint = useMemo(() => {
    const parsed = parseContextLimitK(ctxText);
    return parsed === null ? null : contextLimitHint(parsed);
  }, [ctxText]);

  /** 输入 → 草稿：合法才写；**空串视为"未覆盖"**（与「恢复默认」等价，不报错） */
  const handleCtxInput = (v: string): void => {
    setCtxText(v);
    const parsed = parseContextLimitK(v);
    if (parsed !== null) {
      setDraft((d) => (d ? { ...d, contextChars: parsed } : d));
    } else if (v.trim() === '') {
      setDraft((d) => {
        if (!d) return d;
        const { contextChars: _drop, ...rest } = d;
        return rest;
      });
    }
    // 非法（如 "abc"）：草稿保持上一次的合法值，仅由保存按钮禁用 + 提示拦住
  };

  /** 恢复默认 = **删掉覆盖值**（回到部署默认），不是写死 1000K */
  const handleCtxReset = (): void => {
    setCtxText(contextLimitToKText(ctxDefaultChars));
    setDraft((d) => {
      if (!d) return d;
      const { contextChars: _drop, ...rest } = d;
      return rest;
    });
  };

  // 载入 / 保存成功后（服务端回传了新基线）都重置草稿，保证"内容 = 磁盘"；
  // 输入框文本只在此刻（基线变化）跟随，**不**随草稿逐字符同步 —— 否则用户输入
  // "5000" 的过程中会被归一化成 "500" 而打断输入。
  useEffect(() => {
    if (!data) return;
    const next = cloneConfig(data.config);
    setDraft(next);
    setCtxText(contextLimitToKText(next.contextChars ?? (data.contextCharsDefault ?? DEFAULT_CONTEXT_CHARS)));
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

  /**
   * "默认 / 已修改"判定。
   *
   * ★ 2026-10-13：skill 的**描述也是配置的一部分** —— 只比 content 会让"改了描述"显示成"默认"，
   *   用户以为没保存上（描述现在决定 AI 要不要加载它，改它比改正文更常见）。
   */
  const isDefaultSkill = (s: PromptSkill): boolean => {
    const def = data?.defaults.skills.find((d) => d.id === s.id);
    if (!def) return false;
    return def.content === s.content && (def.description ?? '') === (s.description ?? '');
  };
  const isDefaultPrompt = (content: string): boolean => data?.defaults.prompt.content === content;

  /** 启用/停用（本地草稿即时生效；落盘仍走"保存"按钮 —— 与其他字段同一语义） */
  const toggleSkill = (id: string): void => {
    setDraft((d) => (d ? { ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) } : d));
  };

  const patchSkill = (id: string, patch: Partial<PromptSkill>) => {
    setDraft((d) => (d ? { ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d));
  };

  const handleSave = () => {
    if (!draft || ctxTextInvalid) return;
    void save(draft).then((ok) => {
      // 保存成功 → 通知外层重拉 `GET /api/chat/config`（面板分母 / 占比 / 预警随之立即变化）
      if (ok) onSaved();
    });
  };

  const modalItem: PromptEditDraft | null = (() => {
    if (!modal || !draft) return null;
    if (modal.kind === 'prompt') {
      // 基础提示词没有描述（它不是"可被调用的能力"，而是恒定注入的规则）
      return { id: 'prompt', name: '基础提示词', description: '', content: draft.prompt.content, builtin: true };
    }
    if (modal.kind === 'new-skill') {
      return { id: newSkillId(), name: '', description: '', content: '', builtin: false };
    }
    const s = draft.skills.find((x) => x.id === modal.id);
    return s ? { id: s.id, name: s.name, description: s.description, content: s.content, builtin: s.builtin } : null;
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
              <span className="ki-chat-cfg__label">
                基础提示词
                <em className="ki-chat-cfg__badge">恒定生效</em>
              </span>
              <p className="ki-chat-cfg__hint">新建会话时注入一次并成为该会话的固定规则；此后改这里只对之后新建的会话生效。</p>
              <div className="ki-chat-cfg__list">
                <ItemCard
                  group="prompt"
                  name="基础提示词"
                  content={draft.prompt.content}
                  isDefault={isDefaultPrompt(draft.prompt.content)}
                  onClick={() => setModal({ kind: 'prompt' })}
                />
              </div>
            </div>

            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                Skill
                <em className="ki-chat-cfg__badge">{draft.skills.filter((s) => s.enabled).length} / {data.limits.maxSkills} 可调用</em>
              </span>
              <p className="ki-chat-cfg__hint">
                启用的 skill 只把「名称 + 描述」列给 AI（正文不常驻），由 AI 判断需要时加载；
                停用的不会出现在清单里，AI 也调不到。
              </p>
              <div className="ki-chat-cfg__list">
                {draft.skills.map((s) => (
                  <ItemCard
                    key={s.id}
                    group="skill"
                    name={s.name}
                    description={s.description}
                    content={s.content}
                    isDefault={isDefaultSkill(s)}
                    disabled={!s.enabled}
                    onToggleEnabled={() => toggleSkill(s.id)}
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

            {/* ── 上下文窗口（REQ-20261014-001）：与其余项同属对话配置，随下方「保存」提交 ──
                用户裁决：`config.yaml` 的 `llm.contextChars` 只作**部署默认**，界面改的值单独存
                （`prompt-config.json` 的 `contextChars`），**不写配置文件** */}
            <div className="ki-chat-cfg__field">
              <span className="ki-chat-cfg__label">
                上下文窗口
                <em className="ki-chat-cfg__badge">
                  {ctxOverridden ? '自定义' : `默认 ${formatKUnit(ctxDefaultChars)}`}
                </em>
              </span>
              <p className="ki-chat-cfg__hint">
                上下文占比与预警的字符口径上限（K = 1000 字符），不是模型 token 窗口 ——
                调整它只改变读数与预警时机，不改变 AI 实际能承载的内容量。
                配置文件（config.yaml）里的值是默认值，这里填的值单独保存、不修改该文件。
              </p>
              <div className="ki-chat-cfg__ctxrow">
                <input
                  type="text"
                  inputMode="decimal"
                  className="ki-chat-cfg__ctxinput"
                  aria-label="上下文上限（K）"
                  aria-invalid={ctxTextInvalid || undefined}
                  value={ctxText}
                  onChange={(e) => handleCtxInput(e.target.value)}
                />
                <span className="ki-chat-cfg__ctxunit">K</span>
                <span className="ki-chat-cfg__ctxsp" />
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  disabled={!ctxOverridden}
                  onClick={handleCtxReset}
                >
                  恢复默认
                </button>
              </div>
              <p className="ki-chat-cfg__hint">
                {ctxOverridden ? '当前：自定义 ' : '当前：默认 '}
                {formatKUnit(draft.contextChars ?? ctxDefaultChars)}
                （{(draft.contextChars ?? ctxDefaultChars).toLocaleString('en-US')} 字符）
                {ctxOverridden ? ` · 默认 ${formatKUnit(ctxDefaultChars)}` : ''}
              </p>
              {/**
                * 降级 fail-loud：旧版服务端不认识 `contextChars`，会**静默丢弃**（仍返回 200），
                * 表现为"保存成功但值没变"。这里前置告知，而不是等用户困惑 ——
                * 判据是响应里有没有 `contextCharsDefault`（新版本必有）。
                */}
              {data.contextCharsDefault === undefined && (
                <p className="ki-chat-cfg__warn">
                  服务端未返回上限的默认值：通常是后端尚未重启，本项的保存可能不会生效。
                </p>
              )}
              {ctxTextInvalid && (
                <p className="ki-chat-cfg__warn">
                  请输入正数（K）：如 500、1000；上限 {CONTEXT_LIMIT_K_MAX}K。
                </p>
              )}
              {/* R6：极小 / 极大但**合法**的值 —— 不拦截保存，只把"会发生什么"说清楚 */}
              {ctxSizeHint === 'small' && (
                <p className="ki-chat-cfg__warn">
                  值偏小：系统提示与检索规则本身约占 3~4K 字符，过小会让占比长期落在预警区
                  —— 只影响读数与预警，不影响 AI 实际能力。
                </p>
              )}
              {ctxSizeHint === 'large' && (
                <p className="ki-chat-cfg__warn">
                  值偏大：占比会长期接近 0，预警将失去意义（硬上界 {CONTEXT_LIMIT_K_MAX}K）。
                </p>
              )}
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
        {/* 生效范围**分开说**（2026-10-13）：提示词/skill 随会话快照冻结，只影响新建会话；
            工具开关是即时读取的，下一次提问即生效 —— 混成一句会让"改了 skill 没反应"看起来像坏了 */}
        <span className="ki-chat-cfg__scope">作用域：全局 · 提示词与 skill 对之后新建的会话生效，工具开关与上下文上限保存后生效</span>
        <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={onClose}>取消</button>
        <button
          type="button"
          className="ki-chat-btn"
          disabled={saving || !draft || ctxTextInvalid}
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
          descMaxChars={data!.limits.skillDescMaxChars}
          descSuggestedChars={data!.limits.skillDescSuggestedChars}
          canRename={modal.kind !== 'prompt' && !modalItem.builtin}
          canReset={modal.kind !== 'new-skill' && modalItem.builtin}
          canDelete={modal.kind !== 'new-skill' && !modalItem.builtin}
          checkName={(name) =>
            draft && draft.skills.some((s) => s.id !== modalItem.id && s.name === name)
              ? '已有同名 skill，请换一个名字'
              : null
          }
          onCancel={() => setModal(null)}
          onSubmit={({ name, content, description }) => {
            setDraft((d) => {
              if (!d) return d;
              if (modal.kind === 'prompt') return { ...d, prompt: { ...d.prompt, content } };
              if (modal.kind === 'new-skill') {
                return {
                  ...d,
                  skills: [...d.skills, { id: modalItem.id, name, description, content, builtin: false, enabled: true, at: new Date().toISOString() }],
                };
              }
              return { ...d, skills: d.skills.map((s) => (s.id === modal.id ? { ...s, name, content, description } : s)) };
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
              // ★ 恢复默认必须**一并恢复描述**：只回正文会让"描述已改"与"正文是默认"混在一起，
              //   用户看不出到底恢复没恢复（描述是 AI 选不选它的唯一依据）。
              const def = data!.defaults.skills.find((s) => s.id === modal.id);
              patchSkill(modal.id, { content: def?.content ?? '', description: def?.description ?? '' });
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
  /** skill 描述（恒注入目录里给 AI 看的"何时用"）；基础提示词没有 */
  description?: string;
  content: string;
  isDefault: boolean;
  disabled?: boolean;
  /** 提供即渲染启用开关（skill 专用：基础提示词是恒定规则，不可停用） */
  onToggleEnabled?: () => void;
  onClick: () => void;
}) {
  const { group, name, description, content, isDefault, disabled, onToggleEnabled, onClick } = props;
  const mod = !isDefault;
  const desc = (description ?? '').trim();
  return (
    // ★ 开关在**卡片内部**（用户裁决：不要单独漏在外面）—— 卡片本身是 div，
    //   内部两枚按钮并列（点击区 + 开关）；按钮不能嵌按钮，故不再让卡片整体是一个 button。
    <div className="ki-chat-cfg__item" data-disabled={disabled}>
      <button type="button" className="ki-chat-cfg__item-hit" onClick={onClick}>
        <span className={`ki-chat-cfg__item-ic ki-chat-cfg__item-ic--${group}`}>{ITEM_IC[group]}</span>
        <span className="ki-chat-cfg__item-main">
          <span className="ki-chat-cfg__item-name">{name}</span>
          {/* skill 的第二行显示**描述**（AI 的选择依据）而不是正文摘要：正文不进上下文，摘要无意义 */}
          <span className="ki-chat-cfg__item-prev">
            {group === 'skill'
              ? (desc || '未填写描述 —— AI 只能凭名称判断要不要加载它')
              : (content.slice(0, 42) || '（空）')}
          </span>
        </span>
        <span className={`ki-chat-cfg__item-meta${mod ? ' ki-chat-cfg__item-meta--mod' : ''}`}>
          {content.length} 字 · {mod ? '已修改' : '默认'}
        </span>
        <svg className="ki-chat-cfg__chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6.5 4 10.5 8 6.5 12" />
        </svg>
      </button>
      {onToggleEnabled ? (
        <button
          type="button"
          role="switch"
          aria-checked={!disabled}
          aria-label={`${disabled ? '启用' : '停用'} skill ${name}`}
          title={disabled ? '已停用：AI 的可用清单里没有它，也调不到' : '可被 AI 调用（清单里只有名称与描述，正文按需加载）'}
          // ★ 复用工具开关的既有类（`__sw`）：同一层里两个开关必须是同一种外观语言
          //   （auto-review 一致性问题，原先新造 `__switch` 会有两套样式）
          className="ki-chat-cfg__sw"
          onClick={onToggleEnabled}
        />
      ) : null}
    </div>
  );
}
