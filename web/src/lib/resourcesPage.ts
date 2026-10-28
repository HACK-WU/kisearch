/**
 * resourcesPage.ts —— 「资源」页的纯逻辑
 *
 * 为什么集中在这里：
 *   1) MCP 地址与端口必须跟随当前页面（用户明确要求，不得硬编码 7423）；
 *   2) Skill / CLI 安装与用法命令容易随上游 CLI 变化 —— 集中一处便于单测与发版前核对；
 *   3) 页面组件只负责呈现，不自己拼 JSON / 命令 / 目录。
 *
 * 权威源：`docs/cli.md`（命令语法）与 `docs/agent-integration.md`（Skill 清单）。
 * 本文件只摘录**常用**项，完整用法一律外链 docs/cli.md，不在此重复全文。
 */

export type McpTab = 'local' | 'remote' | 'stdio';

export interface SkillTool {
  id: string;
  label: string;
  /** `npx skills add ... -a <agent>` 的 agent 标识 */
  agent: string;
}

/** 常见工具直出；其余收在「更多工具」折叠 */
export const SKILL_TOOLS: SkillTool[] = [
  { id: 'claude-code', label: 'Claude Code', agent: 'claude-code' },
  { id: 'codex', label: 'Codex', agent: 'codex' },
  { id: 'opencode', label: 'OpenCode', agent: 'opencode' },
  { id: 'cursor', label: 'Cursor', agent: 'cursor' },
  { id: 'qoder', label: 'Qoder', agent: 'qoder' },
  { id: 'qoder-cn', label: 'Qoder CN', agent: 'qoder-cn' },
];

export const PRIMARY_SKILL_TOOLS = SKILL_TOOLS.slice(0, 3);
export const MORE_SKILL_TOOLS = SKILL_TOOLS.slice(3);

export const TOKEN_COMMAND = 'ki mcp token generate --scope all';
export const STATUS_COMMAND = 'ki mcp --status';
export const SKILLS_LIST_COMMAND = 'npx skills list';
export const NODE_REQUIREMENT = 'Node ≥ 22.20';

export const GENERIC_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/HACK-WU/skills/master/scripts/skill-install.sh | \\\n'
  + '  bash -s -- --repo HACK-WU/kisearch -t /path/to/your-project';

// ─── 文档外链（页面内**唯一**允许的 GitHub 链接，见设计稿 §1） ───────────────

export const REPO_DOCS_BASE = 'https://github.com/HACK-WU/kisearch/blob/master/docs';

/** `docs/cli.md` 的某个章节（anchor 不带 `#`） */
export function cliDocUrl(anchor?: string): string {
  return anchor ? `${REPO_DOCS_BASE}/cli.md#${anchor}` : `${REPO_DOCS_BASE}/cli.md`;
}

/** `docs/configuration.md` 的某个章节（配置项说明；与 CLI 命令文档分开） */
export function configDocUrl(anchor?: string): string {
  return anchor ? `${REPO_DOCS_BASE}/configuration.md#${anchor}` : `${REPO_DOCS_BASE}/configuration.md`;
}

/** `docs/mcp-tools.md`（MCP 工具全表；与 CLI 文档分开） */
export function mcpToolsDocUrl(): string {
  return `${REPO_DOCS_BASE}/mcp-tools.md`;
}

// ─── MCP 工具清单（接入后能用什么） ────────────────────────────────────────

export interface McpToolItem {
  /** 工具名（与 `src/lib/mcp-tools/` 注册名一致） */
  name: string;
  /** 一句话作用（摘 docs/mcp-tools.md，不复制参数表） */
  purpose: string;
}

export interface McpToolGroup {
  label: string;
  /** 语义色调：读=安全 / 写=变更 / 删除=危险（页面用它给组标题上色，不是纯装饰） */
  tone: 'read' | 'write' | 'danger';
  items: McpToolItem[];
}

/**
 * `ki mcp` 暴露的全部 13 个工具，按「读 / 写 / 组织与删除」分组。
 *
 * 权威源：`docs/mcp-tools.md`（工具定义以 `src/lib/mcp-tools/` 为准）。
 * 页面只给"叫什么、干什么"，参数细节走文档外链 —— 否则就是第二份会漂移的参数表。
 */
export const MCP_TOOLS: McpToolGroup[] = [
  {
    label: '读',
    tone: 'read',
    items: [
      { name: 'ki_search', purpose: '语义检索（hybrid 混合 / fulltext 只查全文）' },
      { name: 'ki_group_list', purpose: 'Group 树与 Relations，支持 hot / full 等分区与向量兜底' },
      { name: 'ki_get_module_info', purpose: '读取本地 KB 原文（同 Group 批量 ≤10 条）' },
      { name: 'ki_scope_list', purpose: '列出所有 scope 及 KB / 向量状态与 wiki 写回可用性' },
      { name: 'ki_tag_list', purpose: '列出 scope 下用过的 tag 及文档数' },
    ],
  },
  {
    label: '写',
    tone: 'write',
    items: [
      { name: 'ki_sync_relation', purpose: '写入 / 更新单条 Relation + 本地 KB（自动补建 Group）' },
      { name: 'ki_bulk_sync_relation', purpose: '批量写入（一次 embedding + 一次向量写入，单次 ≤50 条）' },
      { name: 'ki_edit_relation', purpose: '对大 Relation 多轮按行编辑，finish 后一次性更新索引' },
      { name: 'ki_store', purpose: '只写向量层单条文本（不写 KB，易产生孤儿向量）' },
      { name: 'ki_bulk_store', purpose: '只写向量层批量文本（同上）' },
    ],
  },
  {
    label: '组织与删除',
    tone: 'danger',
    items: [
      { name: 'ki_group_create', purpose: '创建 Group 节点（父级须已存在，scope 不存在时自动创建）' },
      { name: 'ki_group_delete_empty', purpose: '删除空 Group（非空请用 CLI ki group delete --yes）' },
      { name: 'ki_delete_relation', purpose: '删除单条 Relation（cache + KB + wiki + 向量四层）' },
    ],
  },
];

/** MCP 工具数量的口径（与 docs/mcp-tools.md 的「共 13 个」一致，单测锁） */
export const MCP_TOOL_COUNT = MCP_TOOLS.reduce((sum, group) => sum + group.items.length, 0);

/** 工具清单的边界说明：MCP 刻意不暴露的能力 */
export const MCP_TOOLS_NOTE =
  'MCP 刻意不暴露 scope / doc 级联删除与 --force 类操作 —— 需要级联或强制操作时用 CLI（左侧「Scope 数据操作」）。';

// ─── 目录（左栏） ────────────────────────────────────────────────────────

export type TopicGroup = 'access' | 'feature' | 'config';

export type ResourceTopicId =
  // 接入
  | 'mcp' | 'skill' | 'llm'
  // 功能（对数据做的操作）
  | 'import' | 'datasource' | 'search' | 'backup' | 'export' | 'rebuild' | 'group' | 'deleteDoc' | 'scopeOps'
  // 配置（改配置 / 管凭据 / 诊断）
  | 'scope' | 'token' | 'doctor' | 'concurrency';

export interface ResourceTopic {
  id: ResourceTopicId;
  group: TopicGroup;
  /** 左栏文字 */
  label: string;
  /** 右栏标题 */
  title: string;
  /** 右栏 kicker（`01 · MCP`） */
  kicker: string;
  /** 一句话定位（功能项必有；接入项由各自卡片自述，可为空） */
  summary: string;
  /** `docs/cli.md` 的章节锚点（功能项必有） */
  docAnchor?: string;
  /** `docs/configuration.md` 的章节锚点（配置类功能项才有） */
  configAnchor?: string;
}

export const GROUP_LABEL: Record<TopicGroup, string> = {
  access: '接入',
  feature: '功能',
  config: '配置',
};

/** 左栏分组顺序（渲染与单测共用，避免两处硬编码） */
export const TOPIC_GROUPS: TopicGroup[] = ['access', 'feature', 'config'];

/**
 * 左栏目录（顺序即呈现顺序）。
 *
 * 「配置 / 检索」刻意不收：项目已经跑起来了（`ki config init` / `ki doctor` 用过），
 * 且本页自身就能检索 —— 见用户 2026-10-27 拍板。
 */
export const RESOURCE_TOPICS: ResourceTopic[] = [
  {
    id: 'mcp', group: 'access', label: 'MCP 接入', title: '接入 MCP', kicker: '01 · MCP',
    summary: '让 AI 工具通过 MCP 读写这个知识库：本机免鉴权 / 其他设备需 Token / stdio。',
  },
  {
    id: 'skill', group: 'access', label: 'Agent Skill', title: '安装 Agent Skill', kicker: '02 · SKILL',
    summary: '把 ki 的行为规则装进 AI 工具，让它知道什么时候查、怎么查。',
  },
  {
    id: 'llm', group: 'access', label: '对话模型', title: '配置对话模型', kicker: '03 · LLM',
    summary: '侧边栏「AI 对话」使用的模型；不配置不影响其它功能。',
  },
  // ── 功能：对数据做的操作 ──
  {
    id: 'import', group: 'feature', label: '导入', title: '导入外部 Wiki', kicker: '01 · IMPORT',
    summary: '把外部 Markdown 目录导入指定 Group。幂等追加：同路径覆盖更新、同名不同来源跳过，重复执行即增量。',
    docAnchor: 'import',
  },
  {
    id: 'datasource', group: 'feature', label: '数据源', title: '数据源登记与同步', kicker: '02 · DATASOURCE',
    summary: '登记本地目录或 Git 源后按需同步。同步只「导入 + 计算待删候选」，永不自动删除 —— 删除必须另行确认。',
    docAnchor: 'datasource',
  },
  {
    id: 'search', group: 'feature', label: '检索', title: '语义 / 全文检索', kicker: '03 · SEARCH',
    summary: '页面检索够日常用；CLI 多了按 tag 过滤、阈值、只走全文这几项，写脚本与排查时更顺手。',
    docAnchor: 'search',
  },
  {
    id: 'backup', group: 'feature', label: '备份与还原', title: '备份与还原', kicker: '04 · BACKUP',
    summary: '备份 scope 目录快照；还原可指定快照文件，也可顺带重建向量。',
    docAnchor: 'backup',
  },
  {
    id: 'export', group: 'feature', label: '导出为 Wiki', title: '导出为 Wiki', kicker: '05 · EXPORT',
    summary: '把知识库反向导出成 Markdown Wiki，便于迁移或对外发布。',
    docAnchor: 'export',
  },
  {
    id: 'rebuild', group: 'feature', label: '向量重建', title: '向量重建', kicker: '06 · REBUILD',
    summary: '换过 embedding 模型 / 维度，或索引损坏时重建。会**全库重算**，耗时与文档量成正比。',
    docAnchor: 'restore',
  },
  {
    id: 'group', group: 'feature', label: 'Group 操作', title: 'Group 操作', kicker: '07 · GROUP',
    summary: 'Group 是知识目录的层级路径（如 `项目/API`）。创建可带父路径，删除不写 `--yes` 只预览。',
    docAnchor: 'group',
  },
  {
    id: 'deleteDoc', group: 'feature', label: '删除文档', title: '删除文档', kicker: '08 · DELETE',
    summary: '按 Group + 文档名删一条知识文档，连带清理 KB 原文、wiki 源文件、向量与全文索引 —— 不可恢复，没有回收站。',
    docAnchor: 'delete-relation',
  },
  {
    id: 'scopeOps', group: 'feature', label: 'Scope 数据操作', title: 'Scope 数据操作', kicker: '09 · SCOPE OPS',
    summary: '清空或删除某个 scope 实际存的数据（KB 目录 + 向量两层）。破坏性操作，都需 --yes 且不可撤销。',
    docAnchor: 'scope',
  },

  // ── 配置：改配置 / 管凭据 / 诊断 ──
  {
    id: 'scope', group: 'config', label: '注册 scope', title: '注册 scope 与配置方式', kicker: '01 · SCOPE',
    summary: '把 scope 写进配置能换来什么（白名单护栏、独立目录、Wiki 写回），以及 scopes 段怎么配。',
    docAnchor: 'scope',
    configAnchor: 'scopes',
  },
  {
    id: 'token', group: 'config', label: '生成 Token', title: 'MCP Token 管理', kicker: '02 · TOKEN',
    summary: '跨机访问 MCP 时要 Token。每个 Token 限定授权 scope，可改权限，也可立即失效。',
    docAnchor: 'mcp',
  },
  {
    id: 'doctor', group: 'config', label: '配置诊断', title: '配置诊断', kicker: '03 · DOCTOR',
    summary: '一条命令校验配置语法与字段、目录、API 密钥、向量维度 —— 「改了怎么没生效」的第一站。',
    docAnchor: 'doctor',
  },
  {
    id: 'concurrency', group: 'config', label: '并发与资源', title: '并发与资源配置', kicker: '04 · CONCURRENCY',
    summary: '导入/重建时的 embedding 并发、daemon 同时持有的 collection 句柄数、索引整理线程数。改错会拖慢或打满 CPU。',
    configAnchor: 'embedding',
  },
];

export const DEFAULT_TOPIC: ResourceTopicId = 'mcp';

/** 目录项分组（保持声明顺序，用于渲染两组） */
export function topicsByGroup(group: TopicGroup): ResourceTopic[] {
  return RESOURCE_TOPICS.filter((topic) => topic.group === group);
}

/** URL 段 → 目录项（未知段回退默认项，避免刷新后白屏） */
export function resolveTopic(id: string | undefined): ResourceTopic {
  return RESOURCE_TOPICS.find((topic) => topic.id === id)
    ?? RESOURCE_TOPICS.find((topic) => topic.id === DEFAULT_TOPIC)!;
}

// ─── 功能项的示例命令（scope 实填，不留占位符） ───────────────────────────

export interface TopicExample {
  /** 这条示例演示什么（右栏作为小标题，让用户知道该抄哪条） */
  label: string;
  command: string;
}

/** scope 缺省值：与 CLI 一致（未指定时落到 default） */
const FALLBACK_SCOPE = 'default';

function scopeOr(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_SCOPE;
}

/**
 * 功能项的常用示例。
 *
 * ⚠️ scope **实填**（用户 2026-10-27 要求）：复制即可执行，不留 `<scope>` 占位符。
 * 命令语法以 `ki --help` + `docs/cli.md` 为准，不得臆造参数。
 */
export function topicExamples(id: ResourceTopicId, scope: string): TopicExample[] {
  const s = scopeOr(scope);
  switch (id) {
    case 'import':
      return [
        { label: '导入整个目录', command: `ki import --scope ${s} --source ./wiki --group wiki` },
        { label: '文件名冲突时覆盖（默认跳过同名不同来源）', command: `ki import --scope ${s} --source ./wiki --group wiki --conflict-mode overwrite` },
      ];
    case 'datasource':
      return [
        { label: '登记数据源', command: `ki datasource add --scope ${s} --source ./wiki --group wiki` },
        { label: '同步（导入 + 算待删候选，不删除）', command: `ki datasource sync --scope ${s}` },
        { label: '查看已登记的数据源', command: 'ki datasource list --json' },
      ];
    case 'backup':
      return [
        { label: '备份 scope 快照', command: `ki backup ${s}` },
        { label: '从快照还原', command: `ki restore ${s} --from-snapshot --yes` },
      ];
    case 'search':
      return [
        { label: '语义检索', command: `ki search --scope ${s} --query "用户登录流程"` },
        { label: '按 tag 过滤并限制条数', command: `ki search --scope ${s} --query "超时" --tags api --limit 20` },
        { label: '只走全文（不走向量，排查精确匹配时用）', command: `ki search --scope ${s} --query "ENOTDIR" --mode fulltext` },
      ];
    case 'deleteDoc':
      return [
        {
          label: '删一条文档（group / relation 换成实际路径）',
          command: `ki delete-relation --scope ${s} --group "项目/API" --relation "登录流程"`,
        },
        {
          label: '批量删（items.json：{"items":[{"group":"…","relation":"…"}]}）',
          command: `ki delete-relation --scope ${s} --input items.json`,
        },
        { label: '先看看有哪些文档', command: `ki doc list --scope ${s} --limit 10` },
      ];
    case 'scopeOps':
      return [
        { label: '查看 scope 存在于哪一层', command: 'ki scope list' },
        { label: '清空内容（保留目录与配置）', command: `ki scope clear ${s} --yes` },
        { label: '连目录与配置一起删（default 不可删）', command: `ki scope delete ${s} --yes` },
      ];
    case 'token':
      return [
        { label: '生成 Token（只授权这个 scope）', command: `ki mcp token generate --scope ${s}` },
        { label: '列出所有 Token 与授权范围', command: 'ki mcp token list' },
        { label: '改授权 scope（id 从 list 拿）', command: `ki mcp token update <id> --scope ${s}` },
        { label: '立即失效', command: 'ki mcp token delete <id>' },
      ];
    case 'doctor':
      return [
        { label: '校验配置、目录、密钥与向量维度', command: 'ki doctor' },
      ];
    case 'scope':
      return [
        { label: '查看已注册 / 已存在的 scope', command: 'ki scope list' },
      ];
    case 'export':
      return [
        { label: '导出为 Markdown Wiki', command: `ki export ${s} --output ./wiki-output` },
      ];
    case 'rebuild':
      return [
        { label: '重建该 scope 的全部向量', command: `ki restore ${s} --rebuild-vector --yes` },
        { label: '仅整理 dense 索引（导入收尾会自动做）', command: `ki index-optimize -s ${s}` },
      ];
    case 'group':
      return [
        { label: '创建 Group（可带父路径）', command: `ki group create "API" --scope ${s}` },
        { label: '列出 Group', command: `ki group list --scope ${s}` },
        { label: '删除 Group（不写 --yes 只预览）', command: `ki group delete "API" --yes --scope ${s}` },
      ];
    default:
      return [];
  }
}

// ─── Agent Skill：装的是什么、什么时候生效 ────────────────────────────────

export interface SkillItem {
  name: string;
  purpose: string;
  /** 生效方式：装完即生效 / 需手动触发 */
  activation: 'auto' | 'manual';
  activationLabel: string;
}

/**
 * 本仓库（`HACK-WU/kisearch`）`skills/` 下的全部 Skill —— 只有这两个。
 *
 * `agents-md-init` 是**手动触发**（其 SKILL.md 明写「手动触发」）：装完不会自动生成
 * AGENTS.md，必须由用户对 AI 说一句触发话术。此前页面完全没提，用户装完以为已经生成。
 */
export const SKILL_ITEMS: SkillItem[] = [
  {
    name: 'ki-search',
    purpose: '代码知识库检索行为规则：先查项目记忆，再做定位级 / 理解级检索',
    activation: 'auto',
    activationLabel: '装完即生效',
  },
  {
    name: 'agents-md-init',
    purpose: '初始化 / 重建项目根目录的 AGENTS.md 结构与索引缓存',
    activation: 'manual',
    activationLabel: '需手动触发',
  },
];

/** `agents-md-init` 的触发话术（用户必须知道这句，否则文件永远不会生成） */
export const AGENTS_MD_TRIGGER = '初始化 AGENTS.md';

// ─── 记忆闭环（安装器只装 Skills，Rules 需手动放置） ──────────────────────

export const MEMORY_SKILLS = ['ki-search-first', 'ki-memory-lookup', 'ki-memory-write'];

export const MEMORY_RULE_FILE = 'rules/ai-codekb-memory.md';

export const MEMORY_SKILLS_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/HACK-WU/skills/master/scripts/skill-install.sh | \\\n'
  + `  bash -s -- --repo HACK-WU/skills -n ${MEMORY_SKILLS.join(',')} -t /path/to/your-project`;

export const MEMORY_RULE_COMMAND =
  'mkdir -p /path/to/your-project/rules\n'
  + 'curl -fsSL https://raw.githubusercontent.com/HACK-WU/kisearch/master/rules/ai-codekb-memory.md \\\n'
  + '  -o /path/to/your-project/rules/ai-codekb-memory.md';

// ─── LLM 配置（只读诊断 + 可复制片段） ───────────────────────────────────

/** 环境变量名占位：引导用户用引用而非明文落盘（`${ENV_VAR}` 已被配置层解析） */
export const LLM_ENV_PLACEHOLDER = 'KI_LLM_API_KEY';

/**
 * 可复制的 `llm` 段片段（必填三项即可启用）。
 *
 * 用 `${KI_LLM_API_KEY}` 而不是 `sk-xxx`：配置层对 `apiKey` 支持 `${ENV_VAR}` 引用
 * （与 `embedding.apiKey` 同款解析），避免明文写进 config.yaml。
 */
export function buildLlmConfigSnippet(envName: string = LLM_ENV_PLACEHOLDER): string {
  return [
    'llm:',
    '  baseURL: https://your-host/v1',
    '  model: your-model',
    `  apiKey: \${${envName}}`,
  ].join('\n');
}

/** 只读诊断所需的 LLM 状态子集（来自 `GET /api/chat/config`） */
export interface LlmStatusView {
  enabled: boolean;
  model?: string | null;
  baseURLHost?: string | null;
  configPath?: string;
  reason?: string | null;
  ackRequired?: boolean;
}

export interface LlmStatusCopy {
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
}

/** 把后端 `LlmStatus` 翻译成页面文案（未配置时直接透出后端的人话原因） */
export function describeLlmStatus(status: LlmStatusView | null | undefined): LlmStatusCopy {
  if (!status) {
    return { tone: 'warn', title: '状态未知', detail: '暂时读不到对话配置，请确认服务可用后重试。' };
  }
  if (!status.enabled) {
    return {
      tone: 'warn',
      title: '未配置',
      detail: status.reason ?? '未配置模型：请在配置文件的 llm 段填写 baseURL / model / apiKey',
    };
  }
  const model = status.model?.trim() || '已配置模型';
  const host = status.baseURLHost?.trim();
  return {
    tone: 'ok',
    title: host ? `${model} @ ${host}` : model,
    detail: status.ackRequired
      ? '模型已就绪，但尚未确认「知识库内容会发送给模型」—— 确认后才启用检索。'
      : '模型已就绪，对话与检索均可用。',
  };
}

/**
 * 改完配置是否需要重启：**不需要**。
 *
 * `loadConfig` 每次调用用 mtime/size 指纹校验源文件（`src/lib/config.ts:313-350`），
 * 改动后下一次请求即读到新值；这条信息此前没有任何界面告诉用户。
 */
export const LLM_RELOAD_HINT = '改完保存即可，无需重启服务 —— 下一次 AI 对话就会用新配置。';

// ─── Scope 与 Wiki 同步 ─────────────────────────────────────────────────

/** `ki_scope_list` 的 wikiSync 子集（旧版 daemon 不返回 ⇒ undefined） */
export interface WikiSyncLike {
  enabled: boolean;
  writableDir: string | null;
  writableFrom: 'source' | 'wiki-sync' | null;
  rejectReason?: string;
}

export interface WikiSyncCopy {
  tone: 'ok' | 'warn' | 'muted';
  label: string;
  /** 悬停说明（成功给目录，失败给原因） */
  title: string;
}

/**
 * 把 wikiSync 状态翻译成一句人话。
 *
 * 刻意把「开关」与「可用」分开表达：`enabled:true` 但目录不可用时必须说清
 * 「开了但写不进去」—— 只说"已开启"会让用户以为写回正常。
 */
export function describeWikiSync(ws: WikiSyncLike | null | undefined): WikiSyncCopy {
  if (!ws) {
    return { tone: 'muted', label: '—', title: '当前 daemon 未提供该信息（旧版本）' };
  }
  if (ws.writableDir) {
    const via = ws.writableFrom === 'source' ? '跟随导入源目录' : 'wikiSync.sourceDir';
    return {
      tone: 'ok',
      label: `✓ ${ws.writableDir}`,
      title: `可写回（来源：${via}）`,
    };
  }
  if (ws.enabled) {
    return {
      tone: 'warn',
      label: '⚠ 已开启但无可用目录',
      title: ws.rejectReason
        ? `${ws.rejectReason}；配置 wikiSync.sourceDir 后可写回`
        : '未配置 wikiSync.sourceDir，也无法从 source 块推导目录',
    };
  }
  if (ws.rejectReason) {
    return { tone: 'muted', label: '未开启', title: ws.rejectReason };
  }
  return { tone: 'muted', label: '未开启', title: '未配置 wikiSync，且无导入源目录' };
}

/**
 * `config.yaml` 的 `scopes` 段：注册一个 scope + 打开 wiki 写回。
 *
 * 字段与默认值以 `docs/configuration.md` 的 `scopes` / `scopes.<scope>.wikiSync` 两节为准。
 */
export function buildScopeConfigSnippet(scope: string = 'my-project'): string {
  const name = scope.trim() || 'my-project';
  return [
    'scopes:',
    `  ${name}:`,
    '    kbDir: /data/kb            # 可选：KB 基础目录（程序自动拼 kb/<scope>）',
    '    wikiSync:',
    '      enabled: true            # 开关；缺省视为开启，显式 false 才关闭',
    '      sourceDir: ./wiki        # wiki 写回目录（不配则写不回去）',
    '      autoBackfill: true       # 目标目录为空时自动补齐历史关系',
  ].join('\n');
}

/** 注册 scope 能带来什么 —— 每条都对得上代码/文档的既有行为，不写"可能" */
export interface ScopeBenefit {
  title: string;
  detail: string;
}

export const SCOPE_CONFIG_BENEFITS: ScopeBenefit[] = [
  {
    title: '白名单护栏',
    detail: 'scopeMode: strict 时只认 scopes 里的 key；未注册的 scope 传参会直接报错（fail-loud，而不是悄悄落到别的目录）。',
  },
  {
    title: '独立 KB 目录',
    detail: '配 kbDir 可把该 scope 的文档放到任意位置；不配则回退 dataDir/<scope>。',
  },
  {
    title: 'Wiki 写回的前提',
    detail: 'sync_relation 想写回 Markdown，就得有地方配 wikiSync.sourceDir —— 只有注册后才能在配置里给它。',
  },
  {
    title: '按 scope 定制导入与清洗',
    detail: 'clean（清洗规则 / 外部 hooks）与 import（导入行为）都是 per-scope 配置，互不影响。',
  },
];

/** 配置口径提醒（写错的三种典型） */
export const SCOPE_CONFIG_NOTES: string[] = [
  'kbDir 是基础目录：程序自动拼 kb/<scope>，不要在里面带上 scope 名。',
  'Wiki 写回目录必须写在 wikiSync.sourceDir；顶层 scopes.<scope>.sourceDir 已废弃（旧值会被忽略，ki doctor 会提示迁移）。',
  '改完保存即生效，不用重启服务（配置按文件 mtime 热加载）。',
];

// ─── 并发与资源 ─────────────────────────────────────────────────────────

/**
 * 并发与资源相关的配置片段。
 *
 * 只给**最常需要调**的三个：embedding 并发 / collection 句柄上限 / 索引整理线程。
 * 其余（batchSize、缓冲字节、失败阈值等）见 `docs/configuration.md#embedding`，不在此罗列。
 */
export function buildConcurrencyConfigSnippet(): string {
  return [
    'embedding:',
    '  scheduler:',
    '    maxConcurrency: 25      # 单请求内并发批次数（默认 25）',
    '    batchSize: 16          # 每批文本条数（默认 16）',
    'vector:',
    '  maxOpenCollections: 8     # daemon 同时保留的 collection 句柄上限（默认 8）',
    '  optimize:',
    '    concurrency: 1          # 导入收尾整理索引的线程数（默认 1，避免打满 CPU）',
  ].join('\n');
}

/** 并发配置的口径提醒 */
export const CONCURRENCY_CONFIG_NOTES: string[] = [
  '往上调并发不一定更快：上游 embedding 服务常有 QPS 限制，打满后表现为超时与重试（比串行更慢）。',
  'optimize.concurrency 默认 1 是刻意保守（实测 1 ≈ 1.0 核）；调高会与导入抢 CPU。',
  '这些值只在「导入 / 重建 / 整理索引」时起作用，检索不受影响。改完保存即生效。',
];

// ─── 既有：MCP 端点与配置 ────────────────────────────────────────────────

/** `window.location.hostname` 是否为本机回环 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** 默认选中哪个 tab：本机访问 → 本机；其他设备访问 → 远程 */
export function chooseDefaultMcpTab(hostname: string): McpTab {
  return isLoopbackHost(hostname) ? 'local' : 'remote';
}

/** 当前页面的 MCP 端点（端口/协议跟随当前页面） */
export function buildMcpEndpoint(origin: string): string {
  return `${origin.trim().replace(/\/+$/, '')}/mcp`;
}

/**
 * 其他设备使用的 MCP 端点。
 * 端口取自当前页面；主机保留占位符，由用户替换为其他设备可达的地址。
 */
export function buildRemoteMcpEndpoint(protocol: string, port: string): string {
  const proto = protocol.endsWith(':') ? protocol : `${protocol}:`;
  const suffix = port ? `:${port}` : '';
  return `${proto}//<服务器IP>${suffix}/mcp`;
}

/** 本机免鉴权配置（紧凑 JSON，保持设计稿行数） */
export function buildLocalMcpConfig(endpoint: string): string {
  return [
    '{',
    '  "mcpServers": {',
    `    "ki": { "url": ${JSON.stringify(endpoint)} }`,
    '  }',
    '}',
  ].join('\n');
}

/** 其他设备配置：必须带 Authorization */
export function buildRemoteMcpConfig(endpoint: string, tokenPlaceholder = '<你的Token>'): string {
  return [
    '{',
    '  "mcpServers": {',
    '    "ki": {',
    `      "url": ${JSON.stringify(endpoint)},`,
    `      "headers": { "Authorization": ${JSON.stringify(`Bearer ${tokenPlaceholder}`)} }`,
    '    }',
    '  }',
    '}',
  ].join('\n');
}

/**
 * stdio 配置：command 桥接到本机 daemon。
 *
 * ⚠️ **不带 `env`**（用户 2026-10-27 指出）：stdio 只是把请求桥给已在运行的 daemon，
 * 向量化与密钥都在 daemon 进程内完成；配置层也明确"不做隐式回退到 SILICONFLOW_API_KEY"
 * （`docs/cli.md`）。在这里塞 env 会让人误以为"必须填密钥"，反而误导。
 *
 * 唯一例外见 {@link STDIO_ENV_NOTE}：daemon 未运行、由 IDE 直接拉起引擎，且配置文件用
 * `${ENV_VAR}` 引用密钥（IDE 不继承 shell 环境）时才需要补 `env`。
 */
export function buildStdioMcpConfig(): string {
  return [
    '{',
    '  "mcpServers": {',
    '    "ki": {',
    '      "command": "ki",',
    '      "args": ["mcp"]',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

/** stdio 不需要密钥的说明 + 唯一例外 */
export const STDIO_ENV_NOTE =
  'stdio 桥接到本机 daemon，Token 与 API Key 都在 daemon 侧，这里不用填。'
  + '只有「daemon 未运行、由 IDE 直接拉起引擎」且配置里用 ${ENV_VAR} 引用密钥时，'
  + '才需要给 IDE 补上对应环境变量（它不继承 shell 环境）。';

export function skillInstallCommand(agent: string): string {
  return `npx skills add HACK-WU/kisearch -a ${agent}`;
}
