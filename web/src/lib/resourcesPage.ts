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
  // CodeBuddy 与其它三家同一档：`skills` 原生支持（agent 标识 codebuddy，
  // 落到 .codebuddy/skills/ 或 ~/.codebuddy/skills/）——本页就跑在它里面，不该藏进「更多工具」
  { id: 'codebuddy', label: 'CodeBuddy', agent: 'codebuddy' },
  { id: 'cursor', label: 'Cursor', agent: 'cursor' },
  { id: 'qoder', label: 'Qoder', agent: 'qoder' },
  { id: 'qoder-cn', label: 'Qoder CN', agent: 'qoder-cn' },
  // 字节 Trae：国际版 trae / 国内版 trae-cn（项目路径同为 .trae/skills/，全局路径不同）
  { id: 'trae', label: 'Trae', agent: 'trae' },
  { id: 'trae-cn', label: 'Trae CN', agent: 'trae-cn' },
];

/** `npx skills` 当前支持的 agent 数量（`docs/agents.md` 的表格口径，用于页面提示不要以为只有列出的几家） */
export const SKILL_AGENT_COUNT_HINT = 'npx skills 目前支持 70+ 种 agent（-a \'*\' 可一次装到全部）';

export const PRIMARY_SKILL_TOOLS = SKILL_TOOLS.slice(0, 4);
export const MORE_SKILL_TOOLS = SKILL_TOOLS.slice(4);

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
      { name: 'ki_scope_list', purpose: '列出所有 scope 及 KB / 向量状态、只读标记与 wiki 写回可用性' },
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
  | 'mcp' | 'skill' | 'llm' | 'embedding'
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
  /** 常用参数说明（只列关键的几条，完整参数表在 docs） */
  params?: TopicParam[];
}

/** 一条参数说明 */
export interface TopicParam {
  /** 参数写法（`--source <dir>` / `<scope>`）；位置参数用尖括号 */
  flag: string;
  /** 含义 + 默认值 + 容易踩的点 */
  desc: string;
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
  {
    id: 'embedding', group: 'access', label: '向量模型', title: '配置向量模型', kicker: '04 · EMBED',
    summary: '导入 / 检索 / 写入的向量化都用它（embedding）；不配置会降级为纯全文检索。',
  },
  // ── 功能：对数据做的操作 ──
  {
    id: 'search', group: 'feature', label: '检索', title: '语义 / 全文检索', kicker: '01 · SEARCH',
    summary: '页面检索够日常用；CLI 多了按 tag 过滤、阈值、只走全文这几项，写脚本与排查时更顺手。',
    docAnchor: 'search',
    params: [
      { flag: '<query>', desc: '查询文本（位置参数；--query / -q 保留兼容）' },
      { flag: '--limit <n>', desc: '整次检索返回的总条数上限，默认 10；引擎单次候选上限 1000' },
      { flag: '--tags t1,t2', desc: '只在这些 tag 内检索（OR 组合）；不传=搜全部 tag' },
      { flag: '--threshold <score>', desc: '融合得分阈值，过滤低分命中；默认 0 不过滤' },
      { flag: '--mode hybrid|fulltext', desc: 'fulltext 不调用 embedding，可与 --no-vector 导入的文档对上' },
      { flag: '--timeout <s>', desc: '查询 embedding 超时（秒，0.001–60）；不传用配置值' },
      { flag: '--original', desc: '额外返回 KB 文件级原文（默认只返回向量匹配片段）' },
    ],
  },
  {
    id: 'import', group: 'feature', label: '导入', title: '导入外部 Wiki', kicker: '02 · IMPORT',
    summary: '把外部 Markdown 目录导入指定 Group。幂等追加：重复执行即增量（内容未变跳过重算），同名不同来源默认覆盖。',
    docAnchor: 'import',
    params: [
      { flag: '<scope>', desc: '目标库，也可写作 -s；strict 模式必填' },
      { flag: '--source <dir>', desc: 'Markdown 目录或文件；--retry-incomplete 时可省略，沿用上次记录的源' },
      { flag: '--group <path>', desc: '落点 Group，不存在时自动建（含父路径）。缺省：目录导入按顶层子目录各建根，单文档用 scope 名' },
      { flag: '--conflict-mode', desc: '同名策略，默认 incremental（内容未变跳过重算、同名不同来源覆盖）；另有 overwrite / skip / suffix' },
      { flag: '--tags t1,t2', desc: '给导入文件打标签。注意：不带 --tags 重导会清除该文件已有标签（导入是覆盖语义）' },
      { flag: '--chunk-size', desc: '切分块大小（字符），默认 1000' },
      { flag: '--chunk-overlap', desc: '相邻块重叠（字符），默认 150' },
      { flag: '--no-vector', desc: 'FTS-only：不调用 embedding，只进全文索引；hybrid 检索召不回它' },
    ],
  },
  {
    id: 'datasource', group: 'feature', label: '数据源', title: '数据源登记与同步', kicker: '03 · DATASOURCE',
    summary: '登记本地目录或 Git 源后按需同步。同步只「导入 + 计算待删候选」，永不自动删除 —— 删除必须另行确认。',
    docAnchor: 'datasource',
    params: [
      { flag: '--source <dir> / --git-url <url>', desc: '源类型：本地目录，或 Git 源（可配 --branch / --subdir）' },
      { flag: '--group <g>', desc: '落点 Group，不存在时自动建' },
      { flag: 'sync --dry-run', desc: '只算不写：预览将导入/将变化的文件' },
      { flag: 'sync --full', desc: '忽略增量基线，全量重扫' },
      { flag: 'prune [--group] --yes', desc: '删除「待删候选」；不带 --yes 只预览，每次 ≤500 篇' },
      { flag: 'remove [--yes] [--purge]', desc: '只取消登记；--purge 连托管 clone 一起删' },
    ],
  },
  {
    id: 'rebuild', group: 'feature', label: '向量重建', title: '向量重建', kicker: '04 · REBUILD',
    summary: '换过 embedding 模型 / 维度，或索引损坏时重建。会**全库重算**，耗时与文档量成正比。',
    docAnchor: 'restore',
    params: [
      { flag: '--rebuild-vector', desc: '重建向量；可配 --group 只重建子树（幂等，不清其它向量）、--tags 给重建范围打标' },
      { flag: '--group <path>', desc: '局部重建：只重算该 Group 子树' },
      { flag: '--tags t1,t2', desc: '为重建范围内的文档附加标签（与已有标签合并去重）' },
    ],
  },
  {
    id: 'deleteDoc', group: 'feature', label: '删除文档', title: '删除文档', kicker: '05 · DELETE',
    summary: '按 Group + 文档名删一条知识文档，连带清理 KB 原文、wiki 源文件、向量与全文索引 —— 不可恢复，没有回收站。',
    docAnchor: 'delete-relation',
    params: [
      { flag: '--group <g>', desc: '文档所在 Group（与 --relation 一起用，文档级删除）' },
      { flag: '--relation <r>', desc: '文档（Relation）名' },
      { flag: '--input items.json', desc: '批量删除：{"items":[{"group":"…","relation":"…"}]}，逐条返回结果' },
      { flag: '（无 --yes）', desc: 'delete-relation 不做二次确认，执行即删；删除范围含 wiki 源文件，不可撤销' },
    ],
  },
  {
    id: 'export', group: 'feature', label: '导出为 Wiki', title: '导出为 Wiki', kicker: '06 · EXPORT',
    summary: '把知识库反向导出成 Markdown Wiki，便于迁移或对外发布。',
    docAnchor: 'export',
    params: [
      { flag: '<scope>', desc: '要导出的库（必填）' },
      { flag: '--output <dir>', desc: '输出目录（必填）' },
      { flag: '--group <path>', desc: '只导某个 Group 子树；缺省全量，顶层目录名 = scope 名' },
      { flag: '--yes', desc: '输出目录已存在且非空时确认覆盖；缺省会拒绝' },
    ],
  },
  {
    id: 'backup', group: 'feature', label: '备份与还原', title: '备份与还原', kicker: '07 · BACKUP',
    summary: '备份 scope 目录快照；还原可指定快照文件，也可顺带重建向量。',
    docAnchor: 'backup',
    params: [
      { flag: '<scope>', desc: '要备份的库（必填）' },
      { flag: '--list', desc: '只列已有备份，不执行备份' },
      { flag: '--from-snapshot', desc: '从 tar.gz 快照覆盖还原（破坏性，需 --yes）' },
      { flag: '--timestamp <ts>', desc: '指定快照；缺省用最新一个' },
      { flag: '--rebuild-vector', desc: '还原后再重建向量（内容 + 关系 + 路径）' },
    ],
  },
  {
    id: 'group', group: 'feature', label: 'Group 操作', title: 'Group 操作', kicker: '08 · GROUP',
    summary: 'Group 是知识目录的层级路径（如 `项目/API`）。创建可带父路径，删除不写 `--yes` 只预览。',
    docAnchor: 'group',
    params: [
      { flag: '<path>', desc: 'Group 路径，支持多级（如 项目/API）；create 要求父级已存在' },
      { flag: '--yes', desc: 'delete 时确认删除；不写则只预览将删内容并拒绝执行' },
      { flag: '--scope <s>', desc: '所属库；缺省 default（strict 模式必填）' },
    ],
  },
  {
    id: 'scopeOps', group: 'feature', label: 'Scope 数据操作', title: 'Scope 数据操作', kicker: '09 · SCOPE OPS',
    summary: '清空或删除某个 scope 实际存的数据（KB 目录 + 向量两层）。破坏性操作，都需 --yes 且不可撤销。',
    docAnchor: 'scope',
    params: [
      { flag: 'list [--json]', desc: '列出 scope 及 kb / vector / registered / readonly / wikiCount / topGroups 等字段' },
      { flag: 'readonly <name> [--off]', desc: '设为 / 解除只读：禁止逐条写入（Web/MCP/CLI），但 ki import 与数据源同步仍可更新' },
      { flag: 'clear <name> [--tags] --yes', desc: '清内容（KB + 向量），保留目录与配置；带 --tags 只清该 tag 的向量；只读库需额外 --force-readonly' },
      { flag: 'delete <name> --yes', desc: '连目录与配置条目一起删；default 不可删；不带 --yes 只预览；只读库需额外 --force-readonly' },
    ],
  },

  // ── 配置：诊断 / 改配置 / 管凭据 ──
  {
    // 放第一位：配置类问题的入口应该是「先诊断」，而不是先改配置
    id: 'doctor', group: 'config', label: '配置诊断', title: '配置诊断', kicker: '01 · DOCTOR',
    summary: '一条命令校验配置语法与字段、目录、API 密钥、向量维度 —— 「改了怎么没生效」的第一站。',
    docAnchor: 'doctor',
  },
  {
    id: 'scope', group: 'config', label: '注册 scope', title: '注册 scope 与配置方式', kicker: '02 · SCOPE',
    summary: '把 scope 写进配置能换来什么（白名单护栏、独立目录、Wiki 写回），以及 scopes 段怎么配。',
    docAnchor: 'scope',
    configAnchor: 'scopes',
  },
  {
    id: 'token', group: 'config', label: 'MCP Token 管理', title: 'MCP Token 管理', kicker: '03 · TOKEN',
    summary: '跨机访问 MCP 时要 Token。每个 Token 限定授权 scope，可设为只读（只用来看，不显示写工具），也可立即失效。',
    docAnchor: 'mcp',
    params: [
      { flag: '--scope <s|all>', desc: '生成时必填：具体 scope / 逗号分隔多个 / all。也是 Token 的授权范围' },
      { flag: '--read-only', desc: '生成时加即为只读：远程 AI 连上后只看到读工具，构造调用写工具也会被拒' },
      { flag: 'update <id> --read-only', desc: '只切访问模式，不动授权范围（--read-write 切回读写）；两项也可一起改' },
      { flag: 'update <id> --scope', desc: '改授权范围（id 从 list 拿）；改错会直接放大或缩小该 Token 的权限' },
      { flag: 'delete <id>', desc: '立即失效；已连接的客户端下次请求即被拒' },
    ],
  },
  {
    id: 'concurrency', group: 'config', label: '并发与资源配置', title: '并发与资源配置', kicker: '04 · CONCURRENCY',
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
        { label: '强制覆盖同名文档（默认 incremental：内容没变就跳过重算）', command: `ki import --scope ${s} --source ./wiki --group wiki --conflict-mode overwrite` },
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
        { label: '生成只读 Token（AI 看不到写工具）', command: `ki mcp token generate --scope ${s} --read-only` },
        { label: '列出所有 Token、授权范围与访问模式', command: 'ki mcp token list' },
        { label: '改授权 scope（id 从 list 拿）', command: `ki mcp token update <id> --scope ${s}` },
        { label: '切换只读 / 读写', command: 'ki mcp token update <id> --read-only' },
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
    '  # 只支持 OpenAI 兼容协议：请求发往 ${baseURL}/chat/completions（SSE 流式）',
    '  baseURL: https://your-host/v1',
    '  model: your-model',
    `  apiKey: \${${envName}}          # 支持 \${ENV_VAR} 引用，避免明文落盘`,
    '',
    '  # 可选（不写即用默认值）',
    '  contextChars: 1000000        # 面板上下文占比的分母（字符），默认 1000K',
    '  requestTimeoutMs: 300000     # 单次请求总超时，默认 5 分钟',
    '  maxTokens: 4096              # 默认不下发；设了才有上限（设小有截断风险）',
    '  temperature: 0.7             # 默认不传，原样透传给上游',
    '  supportsTools: true          # 模型是否支持 function calling；false 走预检索降级',
  ].join('\n');
}

/** LLM 配置的协议前提（用户 2026-10-28 要求：baseURL 必须说明只支持 OpenAI 协议） */
export const LLM_PROTOCOL_NOTE =
  'baseURL 只支持 OpenAI 兼容协议：客户端请求 `${baseURL}/chat/completions`（SSE 流式），'
  + '不做任何厂商适配。非 OpenAI 协议的厂商需要自建兼容网关。';

/** LLM 字段口径提醒（写错最典型的三个） */
export const LLM_FIELD_NOTES: string[] = [
  'contextChars 是面板「已用多少」的分母（字符数），不截断内容 —— 模型真实窗口按 token 计，别拿它当上限。',
  'maxTokens 默认不下发：部分上游的 reasoning token 与 max_tokens 关系不确定，设小值有截断答案的风险。',
  'supportsTools 默认 true；上游确实不支持 function calling 时设 false，会走「预检索 + degraded 明示」降级，不是禁用检索。',
];

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

// ─── 接入：向量模型（embedding，REQ-20261030-001） ───────────────────────────

/**
 * Embedding API Key 的获取地址。
 *
 * ★ 权威源：`README.md`「Embedding API 密钥获取」。同一地址还出现在
 *   `src/config.ts`（`config init` 模板与输出）、`docs/configuration.md`、
 *   `docs/cli.md`、`docs/build-kb.md` —— 改地址时必须同步本常量
 *   （`web/test/resource-embedding.test.mjs` 有一条读 README 的守卫断言）。
 * ★ 只对**默认 DashScope 兼容端点**成立：`embedding.baseURL` 可配任意 OpenAI 兼容端点，
 *   `provider` 只是错误文案里的显示名（`docs/configuration.md#embedding`）⇒ 必须带限定语。
 */
export const EMBEDDING_API_KEY_URL = 'https://platform.qianwenai.com/home/api-keys';

/** 链接文字（带 ↗ 由页面补，与既有 `configDocUrl` 的外链写法一致） */
export const EMBEDDING_API_KEY_URL_LABEL = '获取 DashScope 密钥';

export const EMBEDDING_API_KEY_URL_NOTE =
  '上面是「默认 DashScope 兼容端点」的获取地址；若你把 baseURL 换成了别家厂商，请向对应厂商索取密钥。';

/** `buildEmbeddingConfigSnippet` 的取值来源（不传则用内置默认，与 `ki config init` 模板一致） */
export interface EmbeddingSnippetValues {
  provider?: string;
  baseURL?: string;
  model?: string;
  dimension?: number;
  queryTimeoutMs?: number;
}

/**
 * 可复制的 `embedding` 段片段。
 *
 * ★ **必须用「当前生效值」而不是硬编码默认值**（本次评审修正）：维度的代价远大于对话模型 ——
 *   用户若照抄一段写死 `dimension: 1024` 的示例去覆盖自己 768 维的配置，
 *   **所有已建库的语义检索会立刻不可用**。所以片段给的是「复制即当前状态」。
 * ★ 用 `${DASHSCOPE_API_KEY}` 而不是明文：配置层对 `apiKey` 支持 `${ENV_VAR}` 引用
 *   （与 `llm.apiKey` 同款解析），避免把密钥明文写进 config.yaml。
 */
export function buildEmbeddingConfigSnippet(values: EmbeddingSnippetValues = {}): string {
  const provider = values.provider?.trim() || 'dashscope';
  const baseURL = values.baseURL?.trim() || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
  const model = values.model?.trim() || 'qwen3.7-text-embedding-flash';
  const dimension = typeof values.dimension === 'number' && Number.isFinite(values.dimension)
    ? values.dimension
    : 1024;
  const timeoutMs = typeof values.queryTimeoutMs === 'number' && Number.isFinite(values.queryTimeoutMs)
    ? values.queryTimeoutMs
    : 3000;
  return [
    'embedding:',
    `  provider: ${provider}            # 仅错误文案里的显示名，实际厂商由 baseURL 决定`,
    `  baseURL: ${baseURL}`,
    `  model: ${model}`,
    `  dimension: ${dimension}                # 必须与已建库一致；改了要重建向量`,
    '  apiKey: ${DASHSCOPE_API_KEY}   # 支持 ${ENV_VAR} 引用，避免明文落盘',
    `  queryTimeoutMs: ${timeoutMs}           # 查询 embedding 超时（ms），范围 1-60000`,
  ].join('\n');
}

/** 字段口径提醒（写错代价最大的三个） */
export const EMBEDDING_FIELD_NOTES: string[] = [
  'dimension 必须与已建库的集合维度一致：改大改小都会让旧库的语义检索直接不可用。',
  'provider 只是错误文案里的显示名、不切换实现 —— 换厂商只改 baseURL（必须是 OpenAI 兼容的 /embeddings 端点）。',
  'apiKey 支持 ${ENV_VAR} 引用；引用的变量不存在时等同未配置，导入会直接报错（不做隐式回退）。',
];

/**
 * 「改模型 / 改维度」的后果预告。
 *
 * ★ Q1 = 纯只读、不做参数试算，所以这些代价必须写在页面上，
 *   否则用户会「改完才发现在建库全废」。第 2 条尤其重要 ——
 *   现有产品任何位置都没讲过「换模型不换维度 = 静默劣化」。
 */
export const EMBEDDING_CONSEQUENCE_NOTES: string[] = [
  '改维度 → 所有已建库的集合维度不再匹配，语义检索直接不可用，必须逐个执行 ki restore <scope> --rebuild-vector --yes 重建。',
  '只换模型、维度不变 → 系统不会报错（集合只记维度、不记模型名），但新旧向量不在同一语义空间，检索质量会静默劣化 —— 同样必须重建。',
  '改前先跑 ki doctor：它会真发一次 embedding 请求，报出上游实际返回的维度，能提前发现「声明 1024、实际 4096」这类错配。',
];

/** 改完是否需要重启（与 llm 同判据：`loadConfig` 按 mtime/size 指纹热加载） */
export const EMBEDDING_RELOAD_HINT = '改完保存即可，无需重启服务 —— 下一次导入 / 检索就会用新配置。';

/** 字段来源角标：`configured` 不显示（避免噪声），`builtin-default` 才提醒 */
export function embeddingSourceLabel(source: string | undefined): string {
  return source === 'builtin-default' ? '内置默认' : '';
}

/** 只读诊断所需的向量模型状态子集（来自 `GET /api/embedding/summary`） */
export interface EmbeddingStatusView {
  apiKeyConfigured?: boolean;
  model?: string;
  dimension?: number;
  warning?: string;
  /**
   * 顶栏同源的向量可用性（`lib/vectorAvailability.ts` 的 `VectorAvailability`）。
   * ★ 本页只读配置文件、**不验证** key 有效性与上游连通性，所以必须由它补这一半：
   *   否则会出现「页面绿色已配置 / 顶栏黄色向量不可用」同屏矛盾（评审质疑 #1）。
   *   缺省（undefined）= 未评估，按原样展示不做断言。
   */
  availability?: { status: string; reason?: string };
}

export interface EmbeddingStatusCopy {
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
}

/**
 * 状态条文案。
 *
 * ★ 未配置时**必须说明「当前显示的是内置默认值」**：否则用户会把
 *   `qwen3.7-text-embedding-flash / 1024` 当成自己配好过的东西（既有缺陷 D-1 的根源）。
 * ★ 已配置时**不得只凭配置文件就说可用**：key 存在但 401 / 上游挂掉时，
 *   页面必须跟着顶栏的可用性一起降级。
 */
export function describeEmbeddingStatus(view: EmbeddingStatusView | null | undefined): EmbeddingStatusCopy {
  if (!view) {
    return { tone: 'warn', title: '状态未知', detail: '暂时读不到向量模型配置，请确认服务可用后重试。' };
  }
  if (!view.apiKeyConfigured) {
    return {
      tone: 'warn',
      title: '尚未配置 API Key',
      detail: '导入、检索、写入都会降级为纯全文。当前显示的是内置默认值，不是你的配置。',
    };
  }
  const model = view.model?.trim() || '已配置模型';
  const dim = typeof view.dimension === 'number' && Number.isFinite(view.dimension)
    ? ` · ${view.dimension} 维`
    : '';
  const title = `${model}${dim}`;
  const reason = view.availability?.reason ? `：${view.availability.reason}` : '';

  if (view.availability?.status === 'unavailable') {
    return {
      tone: 'warn',
      title,
      detail: `配置已就绪，但上游当前不可用${reason} —— 向量化会失败，检索降级为全文。`,
    };
  }
  if (view.availability?.status === 'unknown') {
    return {
      tone: 'warn',
      title,
      detail: `配置已就绪，但暂时无法确认上游是否可用${reason}；完整诊断见顶栏服务状态或 ki doctor。`,
    };
  }
  return {
    tone: 'ok',
    // 只说「已配置」，不说「可用」：本页没有发过任何 embedding 请求
    title,
    detail: view.warning
      ?? '已配置。上游连通性与密钥有效性看顶栏服务状态（或 ki doctor）；改模型或维度前先看下面「改动后果」。',
  };
}

export interface EmbeddingConsistencyInput {
  apiKeyConfigured?: boolean;
  state?: string;
  configured?: number;
  persisted?: number;
  /** 整个 query 失败（网络 / 越权 / 旧 daemon） */
  hasError?: boolean;
  /** 后端 `status.error`（探测失败的具体原因，脱敏后） */
  statusError?: string;
  scope: string;
}

export interface EmbeddingConsistencyCopy {
  tone: 'ok' | 'warn' | 'off';
  /** 一句话结论（页面主行） */
  text: string;
  /** 副行说明（可为空） */
  detail: string;
  /** 需要用户去 CLI 执行时的命令（仅失配时给） */
  command?: string;
}

/**
 * 当前 scope 的向量一致性文案。
 *
 * ★ 判定顺序不可换（每步都对应一条负向需求）：
 *   1. 未配 API Key → 不判（否则会出现「未配置但集合一致」的绿色错觉，缺陷 D-2）；
 *   2. 请求/探测失败 → 「无法确认」。**必须排在「无 persisted」之前**：探测失败时
 *      `persisted` 本来就没有，先判会把它说成「尚未建索引」，把故障伪装成正常；
 *   3. mismatch → 给可复制的 rebuild 命令；
 *   4. `persisted` 缺失但 `state === 'compatible'` → 后端**确实**这么返回（无集合分支），
 *      文案要写「尚未建向量索引」，**不能**因为 state 是 compatible 就显示「一致」；
 *   5. 其余 → 未确认（快照缺失 / 已过期）。
 */
export function embeddingConsistencyView(input: EmbeddingConsistencyInput): EmbeddingConsistencyCopy {
  const configured = typeof input.configured === 'number' && Number.isFinite(input.configured)
    ? `配置 ${input.configured} 维`
    : '配置维度未知';

  if (!input.apiKeyConfigured) {
    return { tone: 'off', text: '未配置 API Key，暂不校验', detail: '填入 API Key 后再回来看这一项。' };
  }
  if (input.hasError || input.statusError) {
    const reason = input.statusError ? `：${input.statusError}` : '';
    return {
      tone: 'off',
      text: '无法确认',
      detail: `维度状态读取失败${reason}；可点「重新检查」重试，或执行 ki doctor 排查。`,
    };
  }
  if (input.state === 'mismatch' && input.persisted !== undefined) {
    const scope = input.scope || '<scope>';
    return {
      tone: 'warn',
      text: `集合 ${input.persisted} 维，与${configured}不一致`,
      detail: '该知识库的语义检索不可用（全文检索仍可用）；重建后回本页点「重新检查」。',
      command: `ki restore ${scope} --rebuild-vector --yes`,
    };
  }
  if (input.persisted === undefined) {
    if (input.state === 'compatible') {
      return {
        tone: 'off',
        text: '该知识库尚未建向量索引',
        detail: '首次导入或重建后会写入集合维度，之后再回来看。',
      };
    }
    return { tone: 'off', text: '未确认', detail: '尚未取到集合维度（快照缺失或已过期）。' };
  }
  if (input.state === 'compatible') {
    return { tone: 'ok', text: `集合 ${input.persisted} 维，与${configured}一致`, detail: '' };
  }
  return { tone: 'off', text: '未确认', detail: '维度状态与预期不符；可点「重新检查」重试。' };
}

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
 * 刻意把「开关」「配置」「实际落点」分开表达：
 *   · `enabled:true` 但目录不可用 → 必须说清「开了但写不进去」；
 *   · **没配 wikiSync 时不算"已配置"** —— 此时 `writableDir` 来自 group-index 的 source 块
 *     （导入源目录，Web 上传的多为一次性暂存目录），只是"若发生写回会落到哪"，
 *     不能写成 ✓ 让用户以为配对过（2026-10-28 用户反馈 default / kisearch 误显示 ✓）。
 */
export function describeWikiSync(ws: WikiSyncLike | null | undefined): WikiSyncCopy {
  if (!ws) {
    return { tone: 'muted', label: '—', title: '当前 daemon 未提供该信息（旧版本）' };
  }
  // ① 显式配置了 wikiSync.sourceDir —— 只有这一种才算「已配置 wiki 回写」
  if (ws.writableFrom === 'wiki-sync' && ws.writableDir) {
    return {
      tone: 'ok',
      label: `✓ ${ws.writableDir}`,
      title: '可写回（来源：wikiSync.sourceDir）',
    };
  }
  if (ws.writableDir) {
    if (ws.enabled) {
      // ② 开了 wikiSync，但实际落点来自 group-index 的 source 块（优先级 1，压过配置）
      return {
        tone: 'ok',
        label: `✓ ${ws.writableDir}`,
        title: '可写回（实际落点来自导入源目录，优先级高于 wikiSync.sourceDir）',
      };
    }
    // ③ 没配 wikiSync：source 块只是导入源，不等于"配置了写回"
    return {
      tone: 'muted',
      label: '未配置',
      title: `未配置 wikiSync（或已显式关闭）；若未关闭，写回会落到导入源目录：${ws.writableDir}`,
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
    '      enabled: true            # 开启 wiki 回写；缺省视为开启，显式 false 才关闭',
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
