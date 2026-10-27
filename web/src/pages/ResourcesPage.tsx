/**
 * ResourcesPage.tsx —— 资源（接入 + 常用功能手册，双栏）
 *
 * 设计稿：docs/ui-design/resources-page.md
 * 约束：
 *   · MCP 地址/端口由 window.location 推导，不硬编码 7423；
 *   · 页面只给参考命令与示例，不执行命令、不展示真实 Token / apiKey；
 *   · 页面内**唯一** GitHub 外链是 docs/cli.md（用户 2026-10-27 放宽原「不跳 GitHub」约束）；
 *   · 示例命令的 scope 由顶栏当前 scope 实填，不留 `<scope>` 占位符。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { copyText } from '@/lib/clipboard';
import { Icon } from '@/components/icons';
import { Notice } from '@/components/Notice';
import { useScopeValue } from '@/lib/scopeContext';
import { ackDisclosure, getChatConfig } from '@/api/chatApi';
import { kiScopeList, type ScopeInfo } from '@/api/mcpClient';
import {
  AGENTS_MD_TRIGGER,
  buildConcurrencyConfigSnippet,
  buildLlmConfigSnippet,
  buildLocalMcpConfig,
  buildMcpEndpoint,
  buildRemoteMcpConfig,
  buildRemoteMcpEndpoint,
  buildScopeConfigSnippet,
  buildStdioMcpConfig,
  chooseDefaultMcpTab,
  cliDocUrl,
  CONCURRENCY_CONFIG_NOTES,
  configDocUrl,
  describeLlmStatus,
  describeWikiSync,
  GENERIC_INSTALL_COMMAND,
  GROUP_LABEL,
  LLM_RELOAD_HINT,
  MEMORY_RULE_COMMAND,
  MEMORY_RULE_FILE,
  MEMORY_SKILLS,
  MEMORY_SKILLS_COMMAND,
  MORE_SKILL_TOOLS,
  NODE_REQUIREMENT,
  PRIMARY_SKILL_TOOLS,
  resolveTopic,
  SCOPE_CONFIG_BENEFITS,
  SCOPE_CONFIG_NOTES,
  SKILL_ITEMS,
  SKILLS_LIST_COMMAND,
  skillInstallCommand,
  STATUS_COMMAND,
  STDIO_ENV_NOTE,
  TOKEN_COMMAND,
  TOPIC_GROUPS,
  topicExamples,
  topicsByGroup,
  type McpTab,
  type ResourceTopic,
  type ResourceTopicId,
} from '@/lib/resourcesPage';

const MCP_TABS: Array<{ id: McpTab; label: string; suffix?: string }> = [
  { id: 'local', label: '本机', suffix: ' · 免鉴权' },
  { id: 'remote', label: '其他设备', suffix: ' · 需 Token' },
  { id: 'stdio', label: 'stdio' },
];

/** 功能项的破坏性 / 耗时提醒（只用于右栏提示，不参与命令生成） */
const FEATURE_CAUTION: Partial<Record<ResourceTopicId, { tone: 'warn' | 'info'; title: string; body: string }>> = {
  backup: {
    tone: 'warn',
    title: '还原会覆盖当前 KB 内容',
    body: '不带 --yes 时只预览；确认后才真正落盘。建议先 ki backup 再还原。',
  },
  rebuild: {
    tone: 'warn',
    title: '重建会全库重算，耗时与文档量成正比',
    body: '执行期间检索可能变慢；换过 embedding 模型或维度不一致时才需要重建。',
  },
  group: {
    tone: 'info',
    title: '删除 Group 请先预览',
    body: 'ki group delete 不写 --yes 时只打印将要删除的内容，确认无误后再加 --yes。',
  },
  scope: {
    tone: 'warn',
    title: 'ki scope clear 会清空该 scope 的 KB 与向量',
    body: '保留目录与配置，但文档内容不可恢复（scope delete 更彻底，会连目录一起删）。执行前建议先 ki backup。',
  },
  deleteDoc: {
    tone: 'warn',
    title: '删除不可恢复，也没有回收站',
    body: 'delete-relation 会同时删 relations-cache、本地 KB 原文、wiki 源文件（物理 unlink）、向量与全文索引，删完只能靠备份或重新导入恢复。'
      + '⚠ 别用 ki doc delete 删知识文档：它只清向量层，KB 里的 memoryId 会变成悬空引用。执行前建议先 ki backup。',
  },
  scopeOps: {
    tone: 'warn',
    title: '清空 / 删除都不可撤销',
    body: 'clear 保留目录与配置、只清内容；delete 连配置条目一起删（default 不可删）。两者都要 --yes，执行前建议先 ki backup。',
  },
  token: {
    tone: 'warn',
    title: 'Token 等于跨机访问凭据',
    body: '生成后只显示一次，请立即保存；不再需要时用 delete 立即失效，不要提交到仓库或截图外发。'
      + '⚠ 这里的 --scope 是「这个 Token 被授权访问哪些 scope」，不是你要检索的库 —— update 改错会直接放大或缩小它的权限。',
  },
  concurrency: {
    tone: 'info',
    title: '并发不是越大越快',
    body: '上游 embedding 服务常有 QPS 限制，打满后表现为超时与重试，比串行更慢。改前先 ki doctor 确认当前状态。',
  },
};

type CopyState = 'idle' | 'success' | 'error';

function CopyButton({ text, label, small = false }: {
  text: string;
  label: string;
  small?: boolean;
}): JSX.Element {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleClick = async (): Promise<void> => {
    let next: CopyState = 'success';
    let duration = 1600;
    try {
      await copyText(text);
    } catch {
      next = 'error';
      duration = 2400;
    }
    setState(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState('idle'), duration);
  };

  const visible = state === 'success' ? '已复制' : state === 'error' ? '复制失败' : '复制';
  const ariaLabel = state === 'success'
    ? '已复制到剪贴板'
    : state === 'error'
      ? '复制失败，请手动选择文本'
      : `复制 ${label.trim()}`;

  return (
    <>
      <button
        type="button"
        className={`res-copy${small ? ' res-copy--inline' : ''}`}
        data-state={state === 'idle' ? undefined : state}
        aria-label={ariaLabel}
        onClick={() => { void handleClick(); }}
      >
        {visible}
      </button>
      <span className="res-sr-only" role="status" aria-live="polite">
        {state === 'success' ? '已复制到剪贴板' : state === 'error' ? '复制失败，请手动选择文本' : ''}
      </span>
    </>
  );
}

function CodeBlock({ code, label, ariaLabel }: {
  code: string;
  label: string;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="res-code">
      <div className="res-code__bar">
        <span className="res-code__label">{label}</span>
        <CopyButton text={code} label={label} />
      </div>
      <pre aria-label={ariaLabel}><code>{code}</code></pre>
    </div>
  );
}

/** 双栏工作台需要外层不滚动（与浏览页同款范式，卸载必须移除，否则污染其它页面） */
function useNoScroll(): void {
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (!el) return;
    el.classList.add('ki-content--noscroll');
    return () => { el.classList.remove('ki-content--noscroll'); };
  }, []);
}

// ─── 左栏目录 ───────────────────────────────────────────────────────────

function ResourceNav({ active, onSelect }: {
  active: ResourceTopicId;
  onSelect: (topic: ResourceTopic) => void;
}): JSX.Element {
  return (
    <nav className="res-col res-nav ki-card" aria-label="资源目录">
      <div className="ki-card__body res-nav__body">
        {TOPIC_GROUPS.map((group) => (
          <div className="res-nav__group" key={group}>
            <span className="res-nav__grouplabel">{GROUP_LABEL[group]}</span>
            {topicsByGroup(group).map((topic) => (
              <button
                key={topic.id}
                type="button"
                className="res-nav__item"
                aria-current={active === topic.id ? 'page' : undefined}
                onClick={() => onSelect(topic)}
              >
                {topic.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

// ─── 接入 1：MCP ────────────────────────────────────────────────────────

function McpSection(): JSX.Element {
  const origin = window.location.origin;
  const mcpEndpoint = buildMcpEndpoint(origin);
  const remoteEndpoint = buildRemoteMcpEndpoint(window.location.protocol, window.location.port);
  const [tab, setTab] = useState<McpTab>(() => chooseDefaultMcpTab(window.location.hostname));

  const localConfig = buildLocalMcpConfig(mcpEndpoint);
  const remoteConfig = buildRemoteMcpConfig(remoteEndpoint);
  const stdioConfig = buildStdioMcpConfig();

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % MCP_TABS.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + MCP_TABS.length) % MCP_TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = MCP_TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = MCP_TABS[next];
    setTab(nextTab.id);
    document.getElementById(`res-tab-${nextTab.id}`)?.focus();
  };

  return (
    <>
      <div className="res-service">
        <div className="res-service__line">
          <span className="res-status" title="本页由 ki mcp --web 提供，说明 HTTP 服务正在运行">
            <span className="res-dot" aria-hidden="true" />
            服务运行中
          </span>
          <span className="res-service__addr">当前地址 <code>{origin}</code></span>
        </div>
        <div className="res-service__line res-service__line--endpoint">
          <span className="res-service__label">MCP 端点</span>
          <code className="res-service__endpoint">{mcpEndpoint}</code>
          <CopyButton text={mcpEndpoint} label="MCP 端点" />
        </div>
      </div>

      <div className="ki-segmented res-tabs" role="tablist" aria-label="接入方式">
        {MCP_TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`res-tab-${item.id}`}
            aria-controls={`res-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {item.label}
            {item.suffix ? <span className="res-tabs__suffix">{item.suffix}</span> : null}
          </button>
        ))}
      </div>

      <div className="res-panel" role="tabpanel" id="res-panel-local" aria-labelledby="res-tab-local" hidden={tab !== 'local'}>
        <p className="res-help">从本机连接不需要 Token。把下面的配置放进 AI 工具的 MCP 配置文件即可。</p>
        <CodeBlock code={localConfig} label="mcp.json" ariaLabel="本机 MCP 配置示例" />
        <div className="res-inline-hint">
          <span>不确定监听地址/端口？</span>
          <code className="res-inline-cmd">{STATUS_COMMAND}</code>
          <CopyButton text={STATUS_COMMAND} label="ki mcp --status" small />
        </div>
      </div>

      <div className="res-panel" role="tabpanel" id="res-panel-remote" aria-labelledby="res-tab-remote" hidden={tab !== 'remote'}>
        <div className="res-step">
          <span className="res-step__no" aria-hidden="true">1</span>
          <div className="res-step__body">
            <h3 className="res-step__title">生成 Token</h3>
            <p className="res-help"><code>--scope</code> 必填：具体 scope / 逗号分隔多个 / <code>all</code>（全部）；建议只授权需要的 scope。</p>
            <CodeBlock code={TOKEN_COMMAND} label="Terminal" ariaLabel="生成 Token 命令" />
          </div>
        </div>

        <div className="res-step">
          <span className="res-step__no" aria-hidden="true">2</span>
          <div className="res-step__body">
            <h3 className="res-step__title">客户端配置</h3>
            <p className="res-help">
              端口取自当前页面；只把 <code>&lt;服务器IP&gt;</code> 换成其他设备可达的地址。
            </p>
            <CodeBlock code={remoteConfig} label="mcp.json" ariaLabel="远程 MCP 配置示例" />
            <div className="res-inline-hint">
              <span>反向代理 / 非 --web 打开时，以实际监听为准：</span>
              <code className="res-inline-cmd">{STATUS_COMMAND}</code>
              <CopyButton text={STATUS_COMMAND} label="ki mcp --status" small />
            </div>
          </div>
        </div>

        <Notice tone="warn" title="Token 不要提交到仓库或截图外发">
          跨机访问请确认防火墙已放行该端口。
        </Notice>
      </div>

      <div className="res-panel" role="tabpanel" id="res-panel-stdio" aria-labelledby="res-tab-stdio" hidden={tab !== 'stdio'}>
        <p className="res-help">适合本机 IDE。stdio 会桥接到本机 daemon，不会另开向量库持锁进程。</p>
        <CodeBlock code={stdioConfig} label="mcp.json" ariaLabel="stdio 配置示例" />
        <p className="res-note">{STDIO_ENV_NOTE}</p>
      </div>
    </>
  );
}

// ─── 接入 2：Agent Skill ────────────────────────────────────────────────

function SkillSection(): JSX.Element {
  return (
    <>
      <p className="res-help">
        本仓库含 <b>2 个 Skill</b>，装完不会都自动生效 —— 下面标了各自什么时候起作用。
      </p>

      <div className="res-skills">
        {SKILL_ITEMS.map((item) => (
          <div className="res-skill" key={item.name}>
            <div className="res-skill__head">
              <code className="res-skill__name">{item.name}</code>
              <span className={`res-skill__badge res-skill__badge--${item.activation}`}>
                {item.activationLabel}
              </span>
            </div>
            <p className="res-skill__purpose">{item.purpose}</p>
            {item.activation === 'manual' ? (
              <p className="res-skill__trigger">
                装完<strong>不会自动生成</strong> AGENTS.md：对 AI 说一句
                <code className="res-inline-cmd">{AGENTS_MD_TRIGGER}</code>
                （或「刷新索引缓存」）才会执行。
              </p>
            ) : (
              <p className="res-skill__trigger">AI 遇到代码 / 架构 / 排查类问题时自动按规则先查 ki。</p>
            )}
          </div>
        ))}
      </div>

      <h3 className="res-subhead">安装到你的 AI 工具</h3>
      <p className="res-help res-mb-2">
        在项目根目录执行（会一次装上面 2 个 Skill）。
      </p>
      <div className="res-tools">
        {PRIMARY_SKILL_TOOLS.map((tool) => {
          const command = skillInstallCommand(tool.agent);
          return (
            <div className="res-tool" key={tool.id}>
              <span className="res-tool__name">{tool.label}</span>
              <code className="res-tool__cmd">{command}</code>
              <CopyButton text={command} label={`${tool.label} 安装命令`} />
            </div>
          );
        })}
        <details className="res-more">
          <summary>更多工具（{MORE_SKILL_TOOLS.map((tool) => tool.label).join(' / ')}）</summary>
          {MORE_SKILL_TOOLS.map((tool) => {
            const command = skillInstallCommand(tool.agent);
            return (
              <div className="res-tool" key={tool.id}>
                <span className="res-tool__name">{tool.label}</span>
                <code className="res-tool__cmd">{command}</code>
                <CopyButton text={command} label={`${tool.label} 安装命令`} />
              </div>
            );
          })}
        </details>
      </div>
      <p className="res-note res-mt-2">
        说明：加 <code>-g</code> 装到全局；加 <code>--skill ki-search</code> 只装检索规则。
        装完用 <code>{SKILLS_LIST_COMMAND}</code> 确认。
      </p>

      <details className="res-more res-more--block">
        <summary>记忆闭环（推荐）：还需 {MEMORY_SKILLS.length} 个配套 Skill + 1 条 Rules</summary>
        <div className="res-more__body">
          <p className="res-help">
            上面装的只是检索与 AGENTS.md 两条规则；要让 AI 具备「先查记忆 → 判断 → 写回记忆」的闭环，
            还需要下面这些。安装器只支持 Skills，
            <code>{MEMORY_RULE_FILE}</code> 必须手动放置。
          </p>
          <CodeBlock code={MEMORY_SKILLS_COMMAND} label="配套 Skill" ariaLabel="安装记忆闭环配套 Skill" />
          <CodeBlock code={MEMORY_RULE_COMMAND} label="Rules（手动放置）" ariaLabel="手动放置记忆规则文件" />
        </div>
      </details>

      <h3 className="res-subhead">其他工具 / 指定目录</h3>
      <p className="res-help res-mt-2">
        <code>-t</code> 指向 skills 的父目录，最终落到 <code>&lt;目录&gt;/skills/</code>。
      </p>
      <div className="res-mt-2">
        <CodeBlock code={GENERIC_INSTALL_COMMAND} label="skill-install.sh" ariaLabel="通用安装脚本命令" />
      </div>
    </>
  );
}

// ─── 接入 3：对话模型 ───────────────────────────────────────────────────

function LlmSection(): JSX.Element {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['chatConfig'], queryFn: getChatConfig, retry: false });
  const status = describeLlmStatus(configQuery.data ?? null);
  const snippet = useMemo(() => buildLlmConfigSnippet(), []);

  const ackMutation = useMutation({
    mutationFn: ackDisclosure,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['chatConfig'] }); },
  });

  if (configQuery.isLoading) {
    return <p className="res-help">正在读取对话配置…</p>;
  }
  if (configQuery.error) {
    return (
      <Notice tone="warn" title="读取对话配置失败">
        {(configQuery.error as Error).message}。AI 对话与其它功能不受影响。
      </Notice>
    );
  }

  const data = configQuery.data;

  return (
    <>
      <div className={`res-llm-status res-llm-status--${status.tone}`}>
        <span className="res-llm-status__dot" aria-hidden="true" />
        <div className="res-llm-status__body">
          <strong>{status.title}</strong>
          <span>{status.detail}</span>
        </div>
      </div>

      <div className="res-service__line res-service__line--endpoint res-mt-3">
        <span className="res-service__label">配置位置</span>
        <code className="res-service__endpoint">{data?.configPath}</code>
        <CopyButton text={data?.configPath ?? ''} label="配置文件路径" />
      </div>

      {data && data.enabled && data.ackRequired ? (
        <div className="res-llm-ack">
          <Notice tone="warn" title="还需确认一次才能用检索">
            对话会把你提问涉及的知识库内容发送给模型服务。确认后才会走检索路径。
          </Notice>
          <button
            type="button"
            className="ki-btn ki-btn--primary res-mt-2"
            disabled={ackMutation.isPending}
            onClick={() => ackMutation.mutate()}
          >
            {ackMutation.isPending ? '确认中…' : '确认并启用检索'}
          </button>
          {ackMutation.error ? (
            <p className="res-note res-error-text res-mt-2">
              确认失败：{(ackMutation.error as Error).message}
            </p>
          ) : null}
        </div>
      ) : null}

      <h3 className="res-subhead">{data?.enabled ? '当前生效配置（只读）' : '填入必填三项即可启用'}</h3>
      <p className="res-help">
        {data?.enabled
          ? '页面不展示 apiKey。要改配置请编辑上面的文件后保存。'
          : '把下面这段合并进配置文件即可；apiKey 支持 ${ENV_VAR} 引用，无需明文落盘。'}
      </p>
      <CodeBlock code={snippet} label="config.yaml" ariaLabel="llm 配置片段" />

      <p className="res-note res-mt-2">
        <Icon name="check" className="ki-icon res-foot__icon" />
        {LLM_RELOAD_HINT}
      </p>
      <p className="res-note res-mt-1">
        其余可选字段（<code>supportsTools</code> / <code>kbDisclosureAck</code> / <code>contextChars</code> /
        {' '}<code>requestTimeoutMs</code> 等）见
        <a className="res-link" href={cliDocUrl()} target="_blank" rel="noopener noreferrer">文档 ↗</a>
        ；未配置不影响导入、检索等其它功能。
      </p>
    </>
  );
}

// ─── 功能项：说明 + 示例 + 更多说明 ─────────────────────────────────────

/**
 * 已注册的 scope（只列 `registered` 的，附 wiki 写回状态）。
 *
 * 为什么是轻量列表而不是原来的四列表格：本项目的重心是「注册 + 怎么配」，
 * KB / 向量层是否存在的运行态诊断属 `ki scope list` 的职责，页面不重复。
 * 但 wiki 写回状态保留 —— 它直接决定 `sync_relation` 能不能落盘。
 */
function RegisteredScopes(): JSX.Element {
  const query = useQuery({ queryKey: ['scopeList'], queryFn: kiScopeList, retry: false });

  if (query.isLoading) return <p className="res-help">正在读取 scope 列表…</p>;
  if (query.error) {
    return (
      <Notice tone="warn" title="scope 列表读取失败">
        {(query.error as Error).message}
      </Notice>
    );
  }

  const all: ScopeInfo[] = query.data?.scopes ?? [];
  const registered = all.filter((item) => item.registered);

  if (registered.length === 0) {
    return <p className="res-help">配置里还没有注册任何 scope —— 按下面的方式加一个即可。</p>;
  }

  return (
    <>
      <ul className="res-registered">
        {registered.map((item) => {
          const wiki = describeWikiSync(item.wikiSync);
          return (
            <li className="res-registered__item" key={item.scope}>
              <code className="res-registered__name">{item.scope}</code>
              <span className={`res-wikisync res-wikisync--${wiki.tone}`} title={wiki.title}>
                Wiki 写回：{wiki.label}
              </span>
            </li>
          );
        })}
      </ul>
      {all.length > registered.length ? (
        <p className="res-note res-mt-2">
          另有 {all.length - registered.length} 个 scope 只有目录或向量数据、但未写进配置（未注册）。
        </p>
      ) : null}
    </>
  );
}

function FeatureSection({ topic }: { topic: ResourceTopic }): JSX.Element {
  const scope = useScopeValue();
  const examples = topicExamples(topic.id, scope);
  const caution = FEATURE_CAUTION[topic.id];

  return (
    <>
      <p className="res-help">{topic.summary}</p>

      {topic.id === 'scope' ? (
        <>
          <h3 className="res-subhead">当前已注册的 scope</h3>
          <RegisteredScopes />

          <h3 className="res-subhead">注册有什么好处</h3>
          <ul className="res-benefits">
            {SCOPE_CONFIG_BENEFITS.map((benefit) => (
              <li className="res-benefit" key={benefit.title}>
                <strong>{benefit.title}</strong>
                <span>{benefit.detail}</span>
              </li>
            ))}
          </ul>

          <h3 className="res-subhead">怎么配置（config.yaml）</h3>
          <CodeBlock
            code={buildScopeConfigSnippet(scope)}
            label="config.yaml"
            ariaLabel="scopes 段配置示例"
          />
          <ul className="res-notes">
            {SCOPE_CONFIG_NOTES.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      ) : null}

      {topic.id === 'concurrency' ? (
        <>
          <h3 className="res-subhead">怎么配置（config.yaml）</h3>
          <CodeBlock
            code={buildConcurrencyConfigSnippet()}
            label="config.yaml"
            ariaLabel="并发与资源配置示例"
          />
          <ul className="res-notes">
            {CONCURRENCY_CONFIG_NOTES.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      ) : null}

      {examples.length > 0 ? (
        <>
          <h3 className="res-subhead">
            常用示例
            {/* 只有真有 scope 参数时才说"已填好"：`ki scope list` / `ki doctor` 不吃 scope 参数，
                照旧提示会让人以为命令后面少了点什么 */}
            {examples.some((example) => example.command.includes(scope))
              ? (
                <span className="res-subhead__hint">
                  {examples.every((example) => example.command.includes(scope))
                    ? `参数已按当前 scope「${scope}」填好`
                    : `需要 scope 的已按「${scope}」填好`}
                </span>
              )
              : <span className="res-subhead__hint">这几条不需要 scope 参数</span>}
          </h3>
          <div className="res-examples">
            {examples.map((example) => (
              <div className="res-example" key={example.label}>
                <span className="res-example__label">{example.label}</span>
                <CodeBlock
                  code={example.command}
                  label="Terminal"
                  ariaLabel={`${topic.title}：${example.label}`}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}

      {caution ? (
        <Notice tone={caution.tone} title={caution.title}>{caution.body}</Notice>
      ) : null}

      <p className="res-foot res-mt-3">
        <Icon name="info" className="ki-icon res-foot__icon" />
        <span>
          这里只列常用部分。
          {topic.configAnchor ? (
            <>
              <a
                className="res-link"
                href={configDocUrl(topic.configAnchor)}
                target="_blank"
                rel="noopener noreferrer"
              >
                配置项说明 ↗
              </a>
              （docs/configuration.md）
            </>
          ) : (
            <>
              <a
                className="res-link"
                href={cliDocUrl(topic.docAnchor)}
                target="_blank"
                rel="noopener noreferrer"
              >
                更多用法与参数说明 ↗
              </a>
              （docs/cli.md）
            </>
          )}
        </span>
      </p>
    </>
  );
}

// ─── 页面 ──────────────────────────────────────────────────────────────

export function ResourcesPage(): JSX.Element {
  const params = useParams<{ topic?: string }>();
  const navigate = useNavigate();
  const topic = resolveTopic(params.topic);
  const detailRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useNoScroll();

  /**
   * 切换目录项后的两处「看得见」修正：
   *  ① 右栏滚动位置归零 —— 卡片 body 是同一个 DOM 节点，React 复用后 scrollTop 会留在
   *     上一项的位置；从长内容（如 Scope 表）切到短内容时会停在半空，看起来像空白。
   *  ② 窄屏（≤1100）为纵向单栏，详情在目录下方；不滚过去用户会以为点了没反应。
   *     首屏挂载不滚（否则一进页面就跳）。
   */
  useEffect(() => {
    const body = detailRef.current?.querySelector<HTMLElement>('.ki-card__body');
    if (body) body.scrollTop = 0;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (window.innerWidth <= 1100) {
      detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [topic.id]);

  return (
    <div className="res-page">
      <ResourceNav
        active={topic.id}
        onSelect={(next) => navigate(`/resources/${next.id}`)}
      />
      <section className="res-col res-detail ki-card" aria-labelledby="res-detail-title" ref={detailRef}>
        <div className="ki-card__head">
          <div className="ki-panel-heading">
            <span className="ki-panel-kicker">{topic.kicker}</span>
            <h2 className="ki-card__title" id="res-detail-title">{topic.title}</h2>
          </div>
          {topic.id === 'skill' ? <span className="ki-badge">{NODE_REQUIREMENT}</span> : null}
        </div>
        <div className="ki-card__body">
          {topic.id === 'mcp' ? <McpSection /> : null}
          {topic.id === 'skill' ? <SkillSection /> : null}
          {topic.id === 'llm' ? <LlmSection /> : null}
          {/* 功能组与配置组共用同一套「说明 + 示例 / 配置片段」渲染 */}
          {topic.group !== 'access' ? <FeatureSection topic={topic} /> : null}
        </div>
      </section>
    </div>
  );
}
