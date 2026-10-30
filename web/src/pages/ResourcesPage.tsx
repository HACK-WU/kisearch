/**
 * ResourcesPage.tsx —— 资源（接入 + 常用功能手册，双栏）
 *
 * 布局：左目录 240px 纵向 + 右详情内滚；≤1100 转横向 chips 单栏（页面自身滚动）。
 * 设计台账：.plans/2026-10-27-resources-page-v2/（本地目录，不入库）。
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
import { useVectorAvailability, useVectorDimensionStatus } from '@/lib/hooks';
import { ackDisclosure, getChatConfig } from '@/api/chatApi';
import { getEmbeddingSummary } from '@/api/embeddingApi';
import { kiScopeList, type ScopeInfo } from '@/api/mcpClient';
import {
  AGENTS_MD_TRIGGER,
  buildConcurrencyConfigSnippet,
  buildEmbeddingConfigSnippet,
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
  describeEmbeddingStatus,
  describeLlmStatus,
  describeWikiWriteback,
  EMBEDDING_API_KEY_URL,
  EMBEDDING_API_KEY_URL_LABEL,
  EMBEDDING_API_KEY_URL_NOTE,
  EMBEDDING_CONSEQUENCE_NOTES,
  EMBEDDING_FIELD_NOTES,
  EMBEDDING_RELOAD_HINT,
  embeddingConsistencyView,
  embeddingSourceLabel,
  formatCharsK,
  formatDimensionCheckedAt,
  formatTimeoutSeconds,
  GENERIC_INSTALL_COMMAND,
  GROUP_LABEL,
  LLM_FIELD_NOTES,
  LLM_PROTOCOL_NOTE,
  LLM_RELOAD_HINT,
  MEMORY_RULE_COMMAND,
  MEMORY_RULE_FILE,
  MEMORY_SKILLS,
  MCP_TOOL_COUNT,
  MCP_TOOLS,
  MCP_TOOLS_NOTE,
  mcpToolsDocUrl,
  MEMORY_SKILLS_COMMAND,
  MORE_SKILL_TOOLS,
  NODE_REQUIREMENT,
  PRIMARY_SKILL_TOOLS,
  resolveTopic,
  SCOPE_CONFIG_BENEFITS,
  SCOPE_CONFIG_NOTES,
  SKILL_AGENT_COUNT_HINT,
  SKILL_ITEMS,
  SKILLS_LIST_COMMAND,
  skillInstallCommand,
  STATUS_COMMAND,
  STDIO_ENV_NOTE,
  TOKEN_COMMAND,
  TOPIC_GROUPS,
  topicExamples,
  topicsByGroup,
  WIKI_EDIT_SAVE_NOTE,
  WIKI_FILE_PATH_NOTE,
  WIKI_FILE_SAMPLE,
  WIKI_FLOW_NODES,
  WIKI_FLOW_NOTE,
  WIKI_FLOW_SOURCE,
  WIKI_NO_WRITE_ACTIONS,
  WIKI_WRITEBACK_CAVEAT,
  WIKI_WRITE_ACTIONS,
  wikiBackfillNotes,
  type McpTab,
  type ResourceTopic,
  type ResourceTopicId,
  type WikiActionLine,
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
          <CopyButton text={STATUS_COMMAND} label="ki mcp status" small />
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
              <CopyButton text={STATUS_COMMAND} label="ki mcp status" small />
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

      {/* 接入之后最常问的下一个问题：「接上了能干什么」 */}
      <h3 className="res-subhead">
        可用的 MCP 工具
        <span className="res-subhead__hint">{MCP_TOOL_COUNT} 个</span>
      </h3>
      <div className="res-mcp-tools">
        {MCP_TOOLS.map((group) => (
          <div className="res-mcp-tools__group" key={group.label} data-tone={group.tone}>
            <span className="res-mcp-tools__label" id={`res-mcp-tools-${group.tone}`}>{group.label}</span>
            <ul className="res-mcp-tools__list" aria-labelledby={`res-mcp-tools-${group.tone}`}>
              {group.items.map((item) => (
                <li className="res-mcp-tool" key={item.name}>
                  <code className="res-mcp-tool__name">{item.name}</code>
                  <span className="res-mcp-tool__purpose">{item.purpose}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="res-note res-mt-3">{MCP_TOOLS_NOTE}</p>
      <p className="res-foot res-mt-2">
        <Icon name="info" className="ki-icon res-foot__icon" />
        <span>
          参数与返回结构见
          <a
            className="res-link"
            href={mcpToolsDocUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            MCP 工具参考 ↗
          </a>
          （docs/mcp-tools.md）
        </span>
      </p>
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
        装完用 <code>{SKILLS_LIST_COMMAND}</code> 确认。{SKILL_AGENT_COUNT_HINT}。
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

      <h3 className="res-subhead">协议前提</h3>
      <p className="res-help">{LLM_PROTOCOL_NOTE}</p>

      {data?.enabled ? (
        <>
          {/* 已配置时**不再展示占位模板**：那段是「怎么配」，不是「现在是什么」，
              之前标题写「当前生效配置」却给 your-host / your-model，等于误导 */}
          <h3 className="res-subhead">当前生效配置（只读）</h3>
          {/* 字段卡（用户 2026-10-30 选定 B 方案：每字段一枚独立小卡）。
              原先是一行行 disc 灰字，六项等重、看不出主次；apiKey 那条本不是字段，
              降为卡下脚注，不再占一格。 */}
          <div className="res-kv">
            <div className="res-kv__cell">
              <div className="res-kv__label"><span>模型 <span className="res-kv__key">model</span></span></div>
              <div className="res-kv__value"><code>{data.model}</code></div>
            </div>
            <div className="res-kv__cell">
              <div className="res-kv__label"><span>上游 <span className="res-kv__key">baseURL</span></span></div>
              <div className="res-kv__value"><code>{data.baseURLHost}</code></div>
            </div>
            <div className="res-kv__cell">
              <div className="res-kv__label">
                <span>上下文刻度 <span className="res-kv__key">contextChars</span></span>
              </div>
              <div className="res-kv__value">
                <code>{formatCharsK(data.contextChars)}</code>
              </div>
              <div className="res-kv__hint">只作面板占比分母，不截断内容</div>
            </div>
            <div className="res-kv__cell">
              <div className="res-kv__label">
                <span>单次超时 <span className="res-kv__key">requestTimeoutMs</span></span>
              </div>
              <div className="res-kv__value">
                {data.requestTimeoutMs ? <code>{formatTimeoutSeconds(data.requestTimeoutMs)}</code> : '默认'}
              </div>
            </div>
            <div className="res-kv__cell">
              <div className="res-kv__label">
                <span>工具调用 <span className="res-kv__key">supportsTools</span></span>
              </div>
              <div className="res-kv__value">
                {data.supportsTools ? '支持' : '不支持（走预检索降级）'}
              </div>
            </div>
          </div>
          <p className="res-kv__foot">
            apiKey 不在页面展示；要改配置请编辑上面的文件后保存，可调项见配置文档。
          </p>
          {/* 已配置时也直接展开示例（用户 2026-10-28：不要折叠） */}
          <h3 className="res-subhead">完整配置示例（含可选字段）</h3>
          <CodeBlock code={snippet} label="config.yaml" ariaLabel="llm 完整配置示例" />
          <ul className="res-notes">
            {LLM_FIELD_NOTES.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      ) : (
        <>
          <h3 className="res-subhead">填入必填三项即可启用</h3>
          <p className="res-help">把下面这段合并进配置文件；未配置不影响导入、检索等其它功能。</p>
          <CodeBlock code={snippet} label="config.yaml" ariaLabel="llm 配置片段" />
          <ul className="res-notes">
            {LLM_FIELD_NOTES.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </>
      )}

      <p className="res-note res-mt-3">
        <Icon name="check" className="ki-icon res-foot__icon" />
        {LLM_RELOAD_HINT}
      </p>
      <p className="res-note res-mt-2">
        完整字段（<code>firstByteTimeoutMs</code> / <code>defaultSystemPrompt</code> /
        {' '}<code>kbDisclosureAck</code> / <code>reasoningEfforts</code> 等）见
        <a className="res-link" href={configDocUrl('llm')} target="_blank" rel="noopener noreferrer">配置文档 ↗</a>
      </p>
    </>
  );
}

// ─── 接入 4：向量模型（REQ-20261030-001） ─────────────────────────────────

/**
 * 字段来源角标：只有「内置默认」才提示。
 *
 * ★ 这是既有缺陷 D-1 的修法：总览页把内置默认值当「已配置」显示，用户会以为
 *   `qwen3.7-text-embedding-flash / 1024` 是自己配过的。这里把来源摊开写。
 */
function SourceTag({ source }: { source?: string }): JSX.Element | null {
  const label = embeddingSourceLabel(source);
  if (!label) return null;
  // 间距交给容器（`.res-kv__label` 的 gap）—— 内联 marginLeft 会和 gap 叠加成 12px
  return (
    <span className="ki-badge ki-badge--off" title="该字段没有写在配置文件里，当前用的是内置默认值">
      {label}
    </span>
  );
}

/**
 * 向量模型（embedding）只读页。
 *
 * ★ Q1 = 纯只读：没有表单、没有「测试连接」、不写 config.yaml。
 * ★ Q2 = 一致性只看当前 scope：复用 AppShell/总览同一 queryKey，不产生额外请求。
 * ★ 一致性区块**没有重查按钮**（用户 2026-10-30 要求去掉）：
 *   · Web 任务中心触发的 `rebuild-vector` 完成后，AppShell 的失效钩子会重取同一 queryKey；
 *   · 但本页给的是 **CLI** 命令，CLI 重建不产生 Web 任务记录 ⇒ 不会自动更新，必须刷新页面
 *     （全站同口径，见 SearchPage / ImportPage 的「完成后刷新页面」）；
 *   · 异常态顶栏 banner 仍有「重新检查」兜底，所以入口没有全部消失。
 */
function EmbeddingSection(): JSX.Element {
  const currentScope = useScopeValue();
  const summaryQuery = useQuery({ queryKey: ['embeddingSummary'], queryFn: getEmbeddingSummary, retry: false });
  const dimensionQuery = useVectorDimensionStatus(currentScope);
  /**
   * 顶栏同源的向量可用性：本页只读配置、不发 embedding 请求，
   * 只有接上它才不会出现「页面绿色已配置 / 顶栏黄色向量不可用」的同屏矛盾。
   */
  const vectorAvailability = useVectorAvailability();
  // 片段用「当前生效值」（不是硬编码默认）——复制即现状，不会把用户 768 维的库写成 1024
  const snippet = useMemo(() => {
    const v = summaryQuery.data;
    return buildEmbeddingConfigSnippet({
      provider: v?.provider?.value,
      baseURL: v?.baseURL?.value,
      model: v?.model?.value,
      dimension: v?.dimension?.value,
      queryTimeoutMs: v?.queryTimeoutMs?.value,
    });
  }, [summaryQuery.data]);

  if (summaryQuery.isLoading) {
    return <p className="res-help">正在读取向量模型配置…</p>;
  }
  if (summaryQuery.error) {
    return (
      <Notice tone="warn" title="读取向量模型配置失败">
        {(summaryQuery.error as Error).message}。导入、检索等其它功能不受影响。
      </Notice>
    );
  }

  const s = summaryQuery.data;
  const status = describeEmbeddingStatus({
    apiKeyConfigured: s?.apiKeyConfigured,
    model: s?.model?.value,
    dimension: s?.dimension?.value,
    warning: s?.warning,
    availability: vectorAvailability,
  });
  const dim = dimensionQuery.data?.status;
  const consistency = embeddingConsistencyView({
    apiKeyConfigured: s?.apiKeyConfigured,
    state: dim?.state,
    configured: dim?.configured ?? s?.dimension?.value,
    persisted: dim?.persisted,
    hasError: Boolean(dimensionQuery.error),
    statusError: dim?.error,
    scope: currentScope,
  });
  const timeoutMs = s?.queryTimeoutMs?.value;
  /**
   * 检查时刻：按钮去掉后这块右侧的空白由它填，同时回答「这个结果多新」。
   * ★ 未配置 API Key 时不显示：那种态的主行写的是「暂不校验」，旁边再挂一个「18:41 检查」
   *   会自相矛盾（既然没校验，时刻从哪来）。其余态（含读取失败 / 尚未建索引）都显示 ——
   *   它表示快照里上次检查的时间，与顶栏 banner 同口径。
   */
  const checkedAtLabel = s?.apiKeyConfigured ? formatDimensionCheckedAt(dim?.checkedAt) : '';
  /**
   * 首屏加载中不得渲染 detail：`dim` 为空时 `embeddingConsistencyView` 会判成
   * 「未确认 / 尚未取到集合维度（快照缺失或已过期）」—— 那是「还没读到」，
   * 直接显示等于把加载态说成故障（与 D-2 同一类错误）。
   */
  const dimensionLoading = dimensionQuery.isLoading;

  return (
    <>
      <div className={`res-llm-status res-llm-status--${status.tone}`}>
        <span className="res-llm-status__dot" aria-hidden="true" />
        <div className="res-llm-status__body">
          <strong>{status.title}</strong>
          <span>{status.detail}</span>
        </div>
      </div>

      <p className="res-help res-mt-3">
        即 embedding：导入、检索、写入的向量化都靠它。未配置时这些功能降级为纯全文检索，
        文件管理、全文搜索等其它能力不受影响。
      </p>

      <div className="res-service__line res-service__line--endpoint res-mt-3">
        <span className="res-service__label">配置位置</span>
        <code className="res-service__endpoint">
          {s?.configPath ?? '（没有配置文件，当前全部使用内置默认值）'}
        </code>
        {s?.configPath ? <CopyButton text={s.configPath} label="配置文件路径" /> : null}
      </div>

      <h3 className="res-subhead">当前生效配置（只读）</h3>
      {/* 同对话模型：字段卡（B 方案），6 个字段排 3 行 2 列；密钥那格的链接放 hint 行 */}
      <div className="res-kv">
        <div className="res-kv__cell">
          <div className="res-kv__label">
            <span>provider <span className="res-kv__key">显示名</span></span>
            <SourceTag source={s?.provider?.source} />
          </div>
          <div className="res-kv__value"><code>{s?.provider?.value ?? '—'}</code></div>
          <div className="res-kv__hint">仅错误文案里的显示名，不切换实现</div>
        </div>
        <div className="res-kv__cell">
          <div className="res-kv__label">
            <span>上游 <span className="res-kv__key">baseURL</span></span>
            <SourceTag source={s?.baseURL?.source} />
          </div>
          <div className="res-kv__value"><code>{s?.baseURL?.value ?? '—'}</code></div>
        </div>
        <div className="res-kv__cell">
          <div className="res-kv__label">
            <span>模型 <span className="res-kv__key">model</span></span>
            <SourceTag source={s?.model?.source} />
          </div>
          <div className="res-kv__value"><code>{s?.model?.value ?? '—'}</code></div>
        </div>
        <div className="res-kv__cell">
          <div className="res-kv__label">
            <span>维度 <span className="res-kv__key">dimension</span></span>
            <SourceTag source={s?.dimension?.source} />
          </div>
          <div className="res-kv__value"><code>{s?.dimension?.value ?? '—'}</code></div>
        </div>
        <div className="res-kv__cell">
          <div className="res-kv__label">
            <span>查询超时 <span className="res-kv__key">queryTimeoutMs</span></span>
            <SourceTag source={s?.queryTimeoutMs?.source} />
          </div>
          <div className="res-kv__value">
            {typeof timeoutMs === 'number' ? <code>{formatTimeoutSeconds(timeoutMs)}</code> : '—'}
          </div>
          <div className="res-kv__hint">检索页可按请求单独覆盖</div>
        </div>
        <div className="res-kv__cell">
          <div className="res-kv__label"><span>API Key</span></div>
          <div className="res-kv__value">
            {s?.apiKeyConfigured ? '已设置（不在页面展示明文）' : '未配置'}
          </div>
          <div className="res-kv__hint">
            <a className="res-link" href={EMBEDDING_API_KEY_URL} target="_blank" rel="noopener noreferrer">
              {EMBEDDING_API_KEY_URL_LABEL} ↗
            </a>
          </div>
        </div>
      </div>
      <p className="res-kv__foot">{EMBEDDING_API_KEY_URL_NOTE}</p>

      <h3 className="res-subhead">当前知识库（{currentScope}）的向量一致性</h3>
      {/* 结论块：主行短词 + 集合/配置维度对比（原先是一枚 11px 药丸，两个关键数字几乎看不见）。
          `text` 是同一分支产出的完整句，用 sr-only 给屏幕阅读器，避免视觉与朗读两套口径。 */}
      <div className={`res-dim res-dim--${consistency.tone}`} aria-busy={dimensionLoading || undefined}>
        <div className="res-dim__head">
          <span className="res-dim__dot" aria-hidden="true" />
          <span className="res-dim__title">
            {dimensionLoading ? '读取中…' : consistency.headline}
          </span>
          <span className="res-sr-only">{dimensionLoading ? '正在读取向量维度状态' : consistency.text}</span>
          {checkedAtLabel ? <span className="res-dim__meta">{checkedAtLabel}</span> : null}
        </div>
        {consistency.compare ? (
          <div className="res-dim__cmp">
            <span className={`res-dim__side${consistency.compare.relation === 'ne' ? ' res-dim__side--bad' : ''}`}>
              <span>集合维度</span>
              <b>{consistency.compare.collection}</b>
              <span>维</span>
            </span>
            <span className="res-dim__op" aria-hidden="true">
              {consistency.compare.relation === 'eq' ? '=' : '≠'}
            </span>
            <span className="res-dim__side">
              <span>配置维度</span>
              <b>{consistency.compare.configured}</b>
              <span>维</span>
            </span>
          </div>
        ) : null}
        {consistency.detail && !dimensionLoading ? (
          <p className="res-dim__detail">{consistency.detail}</p>
        ) : null}
        {consistency.command ? (
          <div className="res-dim__cmd">
            <code>{consistency.command}</code>
            <CopyButton text={consistency.command} label="重建命令" small />
          </div>
        ) : null}
      </div>

      <h3 className="res-subhead">完整配置示例</h3>
      <CodeBlock code={snippet} label="config.yaml" ariaLabel="embedding 配置示例" />
      <ul className="res-notes">
        {EMBEDDING_FIELD_NOTES.map((note) => <li key={note}>{note}</li>)}
      </ul>

      <h3 className="res-subhead">改动后果（改之前先看）</h3>
      <ul className="res-notes">
        {EMBEDDING_CONSEQUENCE_NOTES.map((note) => <li key={note}>{note}</li>)}
      </ul>

      <p className="res-note res-mt-3">
        <Icon name="check" className="ki-icon res-foot__icon" />
        {EMBEDDING_RELOAD_HINT}
      </p>
      <p className="res-note res-mt-2">
        并发数 / 批大小 / 失败阈值等调参见
        {' '}
        <a className="res-link" href={configDocUrl('embedding')} target="_blank" rel="noopener noreferrer">配置文档 ↗</a>
      </p>
    </>
  );
}

// ─── 功能项：说明 + 示例 + 更多说明 ─────────────────────────────────────

// ─── 配置项：注册 scope 与 Wiki 回写 ─────────────────────────────────────
//
// 该页是「Wiki 回写」唯一的说明入口（2026-10-30 用户定稿：这是核心能力，
// 不是注册收益之一），因此结构与文案全部集中在 resourcesPage.ts，这里只做渲染。
// 文案/判定为什么这么写，见该文件「Wiki 回写（本页核心区）」段的事实来源注释。

/** 落点图：AI 写一次 → KB / 向量 / 你的 Wiki（第三处高亮） */
function WikiFlow(): JSX.Element {
  return (
    <div className="res-wiki">
      <div className="res-flow">
        <div className="res-flow__src">
          <span className="res-flow__src-title">{WIKI_FLOW_SOURCE.title}</span>
          <span className="res-flow__src-code">{WIKI_FLOW_SOURCE.code}</span>
        </div>
        <div className="res-flow__stem" aria-hidden="true" />
        <div className="res-flow__nodes">
          {WIKI_FLOW_NODES.map((node) => (
            <div
              className={node.key ? 'res-flow__node res-flow__node--key' : 'res-flow__node'}
              key={node.title}
            >
              <span className="res-flow__node-title">{node.title}</span>
              <span className="res-flow__node-desc">{node.desc}</span>
              <span className="res-flow__node-state">{node.state}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="res-wiki__note">
        <span>
          {WIKI_FLOW_NOTE}
          {' '}
          <code className="res-inline-cmd">{WIKI_FILE_PATH_NOTE}</code>
        </span>
      </p>
    </div>
  );
}

/** 带句末命令 chip 的说明列表 */
function WikiLines({ lines }: { lines: WikiActionLine[] }): JSX.Element {
  return (
    <ul className="res-notes">
      {lines.map((line) => (
        <li key={line.text}>
          {line.text}
          {line.code ? <> <code className="res-inline-cmd">{line.code}</code></> : null}
        </li>
      ))}
    </ul>
  );
}

/** 会 / 不会 回写的单列 */
function WikiActionBox({ tone, title, items }: {
  tone: 'yes' | 'no';
  title: string;
  items: WikiActionLine[];
}): JSX.Element {
  return (
    <div className={`res-colbox res-colbox--${tone}`}>
      <span className="res-colbox__head">{title}</span>
      <ul className="res-colbox__list">
        {items.map((item) => (
          <li key={item.text}>
            {item.text}
            {item.code ? <> <code>{item.code}</code></> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 已注册 scope 的回写状态表（四列：scope / 状态 / 落点目录 / 来源）。
 *
 * 为什么多出「来源」列：回写优先落到 group-index 的 source 块（导入源），
 * wikiSync.sourceDir 反而只是兜底。少了这列，用户配完发现"写到了别的地方"
 * 在页面上找不到任何解释（2026-10-30 之前就是这样）。
 */
function WikiWritebackTable(): JSX.Element {
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
    // 页面变长后「下面」指向模糊（状态表与配置片段之间还隔着 4 个小节），改为点名章节
    return <p className="res-help">配置里还没有注册任何 scope —— 按「怎么配置（config.yaml）」一节加一个即可。</p>;
  }

  return (
    <>
      {/* 语义：这不是可点的数据表（.ki-table 的 td 是 nowrap + 行 hover + 手型，且不能换行），
          但仍是表格关系 —— 用 ARIA role 补语义；窄屏折单列时表头隐藏，
          改由每个单元格的 data-label 由 CSS 补出标签（视觉可达，读屏按行线性播报）。 */}
      <div className="res-wslist" role="table" aria-label="已注册 scope 的 Wiki 回写状态">
        <div className="res-wslist__row res-wslist__row--head" role="row">
          <span role="columnheader">scope</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">落点目录</span>
          <span role="columnheader">来源</span>
        </div>
        {registered.map((item) => {
          const row = describeWikiWriteback(item.wikiSync);
          return (
            <div className="res-wslist__row" role="row" key={item.scope}>
              <code className="res-wslist__name" role="cell" data-label="scope">{item.scope}</code>
              <span
                className={`res-wslist__state res-wslist__state--${row.tone}`}
                role="cell"
                data-label="状态"
                title={row.title}
              >
                {row.state}
              </span>
              <code className="res-wslist__dir" role="cell" data-label="落点目录">{row.dir}</code>
              <span
                className={row.sourceWarn ? 'res-wslist__from res-wslist__from--warn' : 'res-wslist__from'}
                role="cell"
                data-label="来源"
              >
                {row.source}
              </span>
            </div>
          );
        })}
      </div>
      <p className="res-note res-mt-2">{WIKI_WRITEBACK_CAVEAT}</p>
      {all.length > registered.length ? (
        <p className="res-note res-mt-2">
          另有 {all.length - registered.length} 个 scope 只有目录或向量数据、但未写进配置（未注册）。
        </p>
      ) : null}
    </>
  );
}

function ScopeSection({ scope }: { scope: string }): JSX.Element {
  return (
    <>
      <h3 className="res-subhead">
        AI 改一次，三处同时生效
        <span className="res-subhead__hint">Wiki 回写就是第三处落点</span>
      </h3>
      <WikiFlow />

      <h3 className="res-subhead">
        当前 scope 的回写状态
        <span className="res-subhead__hint">来源决定实际写到哪</span>
      </h3>
      <WikiWritebackTable />

      <h3 className="res-subhead">什么会回写 / 什么不会</h3>
      <div className="res-cols2">
        <WikiActionBox tone="yes" title="会回写 ✔" items={WIKI_WRITE_ACTIONS} />
        <WikiActionBox tone="no" title="不会回写 ✘" items={WIKI_NO_WRITE_ACTIONS} />
      </div>
      {/* 网页编辑是第三种情况：写入源文件、不走上面这条目录规则 —— 单独说，不混进清单 */}
      <p className="res-note res-mt-2">{WIKI_EDIT_SAVE_NOTE}</p>

      <h3 className="res-subhead">
        写出来的文件长什么样
        <span className="res-subhead__hint">YAML 头由程序生成</span>
      </h3>
      <CodeBlock code={WIKI_FILE_SAMPLE} label="markdown" ariaLabel="Wiki 回写文件示例" />

      <h3 className="res-subhead">
        历史关系怎么办
        <span className="res-subhead__hint">开启后只写「之后」的，历史要补</span>
      </h3>
      <WikiLines lines={wikiBackfillNotes(scope)} />

      <h3 className="res-subhead">怎么配置（config.yaml）</h3>
      <CodeBlock
        code={buildScopeConfigSnippet(scope)}
        label="config.yaml"
        ariaLabel="scopes 段配置示例"
      />
      <ul className="res-notes">
        {SCOPE_CONFIG_NOTES.map((note) => <li key={note}>{note}</li>)}
      </ul>

      <h3 className="res-subhead">注册还能拿到什么</h3>
      <ul className="res-benefits">
        {SCOPE_CONFIG_BENEFITS.map((benefit) => (
          <li className="res-benefit" key={benefit.title}>
            <strong>{benefit.title}</strong>
            <span>{benefit.detail}</span>
          </li>
        ))}
      </ul>
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

      {topic.id === 'scope' ? <ScopeSection scope={scope} /> : null}

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

      {topic.params && topic.params.length > 0 ? (
        <>
          <h3 className="res-subhead">
            参数
            <span className="res-subhead__hint">只列常用；完整参数表见文档</span>
          </h3>
          <dl className="res-params">
            {topic.params.map((param) => (
              <div className="res-params__item" key={param.flag}>
                <dt><code>{param.flag}</code></dt>
                <dd>{param.desc}</dd>
              </div>
            ))}
          </dl>
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
          {topic.id === 'embedding' ? <EmbeddingSection /> : null}
          {/* 功能组与配置组共用同一套「说明 + 示例 / 配置片段」渲染 */}
          {topic.group !== 'access' ? <FeatureSection topic={topic} /> : null}
        </div>
      </section>
    </div>
  );
}
