# 资源页 · 界面布局方案（v2 双栏）

> 状态：已实现（生产页面 + 真机走查通过，2026-10-27）
> 日期：2026-10-27（v1 单栏 2026-10-27 上午；v2 双栏当日晚间）
> 页面：`/resources`、`/resources/:topic`
> 视觉基线：[ui-tools/design-reference](../../ui-tools/design-reference/INDEX.md) v1.2.0（brownfield，`inherit-existing`）
> 需求关联：本次未创建 REQ ID；按默认路径落盘

---

## 1. 概述

「资源」页解决两类事：

1. **接入**：MCP（本机 / 其他设备 Token / stdio）、Agent Skill 安装、对话模型（LLM）配置。
2. **日常功能手册**：导入 / 数据源 / 备份还原 / 注册 scope / 导出 / 向量重建 / Group 操作 —— 给一句话说明 + 可复制示例。

设计原则：

- **命令优先**：来这里的用户目标是「复制一条能直接跑的命令」，不是读长文。
- **scope 实填**：示例命令里的 `--scope` 由顶栏当前 scope 注入，**不留 `<scope>` 占位符**。
- **不重复证明服务在运行**：页面由 `ki mcp --web` 提供，本身即证据；不展示启动命令。
- **端口不写死**：MCP 地址由 `window.location` 推导。
- **只读**：页面不写用户配置、不执行命令、不展示 Token / apiKey 明文。
  - 唯一例外：`POST /api/chat/config/ack`（隐私确认，UI 上是一次点选），LLM 模型参数**不可改**。
- **不复制文档**：只摘常用项；完整用法外链官方文档 —— 命令项 → `docs/cli.md`，配置项（注册 scope）→ `docs/configuration.md`。**每个功能项最多 1 个外链，不放仓库主页或其他外链。**

**v1 → v2 的关键变更**

| 项 | v1 | v2 | 原因 |
|---|---|---|---|
| 布局 | 单列，max-width 1120 左对齐 | **双栏**：左目录 240 + 右详情 | 单列在 1440 下左 16 / 右 108（1920 右 588）留白过大，用户反馈"空" |
| 滚动 | 页面滚动（1440×900 内容 1140 ⇒ 滚动条 thumb 占 79%） | **页面不滚**，右栏卡片内滚 | 用户反馈"滚动条太长" |
| 内容 | 只有 MCP + Skill 两卡 | 接入 3 + 功能 9 + 配置 4，共 16 项 | 项目已跑起来，缺"日常怎么用"的入口 |
| Skill | 只给安装命令 | 列清 2 个 Skill 与生效方式（含**手动触发**提示）+ 记忆闭环 | 用户装完不知道装了什么 |
| LLM | 无 | 只读诊断 + 可复制片段 + 隐私确认 | 未配置模型时用户不知道去哪改 |

---

## 2. 信息架构

左栏 16 项分三组 —— **分组的依据是「这件事属于哪一类」**：接进来（接入）/ 对数据做什么（功能）/ 改配置与管凭据（配置）。

```
资源
├─ 接入（3）            ← 把外部工具接进来
│  ├─ 01 MCP 接入      （本机 / 其他设备 / stdio + **可用工具清单 13 个**）
│  ├─ 02 Agent Skill   （2 个 Skill + 生效方式 + 记忆闭环 + 9 家工具命令）
│  └─ 03 对话模型      （协议前提 / 状态 / configPath / 已配置看真实值 · 未配置看片段 / 隐私确认）
├─ 功能（9）            ← 对知识数据做的操作；顺序按用户 2026-10-28 指定
│  ├─ 01 检索          （最高频，tag 过滤 / 阈值 / 只走全文）
│  ├─ 02 导入          （幂等追加）
│  ├─ 03 数据源        （登记 + 同步 + 待删候选）
│  ├─ 04 向量重建      （修复）
│  ├─ 05 删除文档      （销毁：delete-relation 四层一起清）
│  ├─ 06 导出为 Wiki
│  ├─ 07 备份与还原
│  ├─ 08 Group 操作
│  └─ 09 Scope 数据操作（销毁：clear / delete，破坏性最大）
└─ 配置（4）            ← 诊断、改配置、管凭据
   ├─ 01 配置诊断      （ki doctor —— 放首位：配置问题先诊断，而不是先改）
   ├─ 02 注册 scope    （已注册清单 / 好处 / scopes 段配置方式）
   ├─ 03 MCP Token 管理（generate / list / update / delete）
   └─ 04 并发与资源配置（scheduler / maxOpenCollections / optimize）
```

> **「注册 scope」（改配置）与「Scope 数据操作」（改数据）必须分开**：前者答"怎么配才有白名单与写回"，
> 后者答"怎么清空/删除既有数据"。混在一项里，用户会在找配置说明时点进破坏性命令。

**刻意不收**（Agent 侧用法，人类用 Web 已有页面，避免误操作）：`ki store` / `bulk-store`、
`ki sync-relation` / `edit-relation` / `delete-relation`、`ki doc delete`、`ki migrate-relation-cache`。

**不做**：接入进度条、收起目录（用户拍板"不需要，默认展开"）、左栏项序号（用户 2026-10-27："感觉丑"）。

---

## 3. 布局

**模式**：CSS Grid 双栏，左 240px 固定、右 `minmax(0,1fr)`；页面层不滚动，两栏各自内滚。

### 3.1 桌面 ≥1101

```
资源                    ———————————————— 接入 MCP · Agent Skill · 对话模型 · 常用功能
┌────── 240 ──────┐ ┌────────────── ≥960 ──────────────────────┐
│ 接入                 │ │ 04 · SCOPE                               │
│  MCP 接入            │ │ 注册 scope 与配置方式                      │
│  Agent Skill         │ │ ──────────────────────────────────────── │
│  对话模型             │ │ 把 scope 写进配置能换来什么…（一句话说明）   │
│ ──────────────────── │ │                                          │
│ 功能                 │ │ 当前已注册的 scope                        │
│  导入                │ │ ┌────────────────────────────────────┐  │
│  数据源              │ │ │ default        Wiki 写回：✓ /w/wiki │  │
│  备份与还原           │ │ │ raw            Wiki 写回：⚠ 已开启但…│  │
│  注册 scope          │ │ └────────────────────────────────────┘  │
│  导出为 Wiki         │ │ 另有 N 个 scope 只有目录或向量、未注册     │
│  向量重建            │ │                                          │
│  Group 操作          │ │ 注册有什么好处                            │
│                      │ │ · 白名单护栏  · 独立 KB 目录              │
│                      │ │ · Wiki 写回的前提  · 按 scope 定制导入清洗 │
│                      │ │                                          │
│                      │ │ 怎么配置（config.yaml）                   │
│                      │ │ scopes: / default: / kbDir / wikiSync: … │
│                      │ │ · 3 条口径提醒（kbDir 不带 scope 名…）    │
│                      │ │                                          │
│                      │ │ 常用示例  这两条不需要 scope 参数          │
│                      │ │ ki scope list / ki doctor        [ 复制 ] │
│                      │ │ ⓘ 配置项说明 ↗（docs/configuration.md）   │
└──────────────────────┘ └──────────────────────────────────────────┘
```

> 「注册 scope」页**不再显示 KB / 向量层运行态表格**：那属 `ki scope list` 的职责。
> 本页只保留 `registered` 的清单 + Wiki 写回状态（它决定 `sync_relation` 能否落盘），
> 其余篇幅给「好处 + 配置方式」。用户 2026-10-27 拍板：右边要的是配置方式与说明。

### 3.2 平板 / 窄屏 ≤1100

左栏转为**横向 chips 并换行**（`flex-wrap: wrap`，16 项在 1024 排 3 行、375 排约 6 行），详情在下方，**页面本身滚动**（`overflow-y:auto`）。
> 不用横向滚动：16 项排成一行时点末项（并发与资源）要拖半屏，窄屏基本不可用（执行中发现，已记入护栏 #7 / E7）。

```
┌───────────────────────────────────────────┐
│ 接入 │MCP 接入│Agent Skill│对话模型│功能│导入…│ ← 横向 chips
├───────────────────────────────────────────┤
│ 01 · MCP                                  │
│ …                                         │
└───────────────────────────────────────────┘
```

### 3.3 变更点

| 变更点 | 现状 | 预期 | 类型 |
|---|---|---|---|
| 路由 | `/resources` | `/resources` + `/resources/:topic`（深链可刷新） | 新增 |
| 页面结构 | 单列两卡 | 双栏，左目录 10 项 | 改版 |
| 滚动 | 页面滚 | 页面不滚 + 右栏内滚 | 改版 |
| 外链 | 无 | 官方文档页：`docs/cli.md`（命令）/ `docs/configuration.md`（配置），每个功能项最多 1 个 | 新增（约束放宽） |
| 后端 | `ki_scope_list` 无 wikiSync | 每条含 `wikiSync{enabled,writableDir,writableFrom,rejectReason?}` | 契约新增（只增字段） |

### 3.4 响应式

| 断点 | 左栏 | 右栏 | 变化 |
|---|---|---|---|
| ≥1101 | 240px 纵向目录 | 填充，内滚 | 双栏 |
| ≤1100 | 横向 chips（**换行**，不横滚） | 单栏，页面滚 | 单栏 |
| ≤959 | 同上 | 代码块允许换行 | 防横向滚动不可发现 |
| ≤760 | 同上 | 卡片内距 16px、tab 均分且隐藏后缀 | 窄屏密度 |

**无横向页面溢出**：≥960 长命令在代码块内部横向滚动；≤959 代码块换行；≤760 工具命令也换行（复制取原文）。

---

## 4. 组件与状态

| 组件 | 类名 | 变体 / 状态 |
|---|---|---|
| 页面网格 | `.res-page` | `grid 240px + 1fr`；≤1100 转 `flex column` + 自身滚动 |
| 列容器 | `.res-col` / `.res-col.ki-card` | ⚠️ 列**本身就是卡片**，必须用 `.res-col.ki-card` 复合选择器（写成 `.res-col > .ki-card` 永不匹配，右栏会失去 `overflow-y:auto`） |
| 目录项 | `.res-nav__item` | 默认 / hover / `[aria-current=page]` / focus-visible |
| 目录分组 | `.res-nav__group` + `.res-nav__grouplabel` | 桌面纵向分组；≤1100 `display:contents` 拉平成 chips |
| 服务条 | `.res-service` | 静态 |
| 接入方式 tabs | `.res-tabs` | 复用 `.ki-segmented`；`[aria-selected=true]` 主色底 |
| 代码块 | `.res-code` | 默认 / 横向溢出；bar 左 mono 标签 + 右复制 |
| 复制按钮 | `.res-copy` | 默认 / hover / focus / 成功（1.6s）/ 失败（2.4s + `aria-live`） |
| Skill 卡 | `.res-skills` / `.res-skill` | 徽标 `--auto`（绿，装完即生效）/ `--manual`（黄，需手动触发） |
| 折叠块 | `.res-more` / `.res-more--block` | 工具行内折叠 / 独立成块（记忆闭环） |
| LLM 状态 | `.res-llm-status` | `--ok`（绿点）/ `--warn`（黄点） |
| LLM 两态 | — | **已配置**：显示真实 `model` / `baseURLHost` / `contextChars` / `supportsTools` / 超时，片段收进折叠「查看完整配置示例」；**未配置**：直接给含可选字段的片段 + 3 条字段口径。⚠️ 已配置时**不得**再展示 `your-host` / `your-model` 占位模板（标题写"当前生效配置"却给模板＝误导） |
| MCP 工具清单 | `.res-mcp-tools` + `[data-tone=read\|write\|danger]` | 三组各自成块（描边 + 表头浅底）；组标题左侧 5px 语义色点：读=中性灰 / 写=主色 / 组织与删除=警告黄。**只做纯文字两栏时 13 行连成一片，看不出哪几条会改数据** |
| 已注册 scope | `.res-registered` + `.res-wikisync--{ok,warn,muted}` | 轻量行内列表（scope 名 + Wiki 写回三态）；不用表格 —— 运行态诊断归 `ki scope list`，本页重心是「注册 + 怎么配」 |
| 好处与口径 | `.res-benefits` / `.res-notes` | 主色圆点列表（标题 + 说明）/ disc 列表（配置口径提醒） |
| 示例块 | `.res-examples` / `.res-example` | 每条 = 小标题 + 代码块 |
| 参数说明 | `.res-params`（`dl` + `dt/dd`） | flag 列 210px（mono 600）+ 含义列自适应；≤760 单列。放在示例**之后**（先看怎么用，再看每个参数啥意思）；只列常用几条，完整表走文档外链 |
| 外链 | `.res-link` | 主色 + 下划线；`target=_blank rel="noopener noreferrer"` |

**加载 / 空 / 错误态**：

- LLM 段：`isLoading` → 「正在读取对话配置…」；`error` → warn notice + 原错误；`enabled:false` → warn 状态 + 可复制片段。
- Scope 段：`isLoading` → 提示；`error` → warn notice；空列表 → 引导用 `ki import` 创建；向量层降级 → info notice 说明「向量列已降级为仅 KB 层」。

**左栏目录的秩序感规则**（用户 2026-10-27 反馈"看起来随意"后的定稿口径）：

1. **层级靠字号/字重，不靠缩进**：分组标题是 10.5px mono + `letter-spacing .14em`（独立层级）；**分组标题与条目文字同一左基线（`padding-left: 12px`）** —— 差几像素整列看起来"没对齐"，是目录显得随手排的主因。条目统一 `padding 7px`（32px 等高）。
   > 试过并**已否决**：给条目加 `01/02` 序号栅格（用户 2026-10-27：感觉丑）。
2. **选中要有两个锚点**：浅底 + 左侧 2px 主色竖条（`::before`）。只有底色时扫视找不到"我在哪一项"；窄屏 chips 里竖条会贴字显得脏，**≤1100 隐藏竖条**（chip 底色已足够）。
3. **行距收紧**：条目 `padding: 6px 8px 6px 12px`、`font-size: 12.5px`、`gap: 1px`；组间 `margin-top: 14px + 分隔线`。原先 7px/13px/2px 的密度让 10 项看起来散。

**切换目录项的两处「看得见」修正**（`ResourcesPage` effect，依赖 `topic.id`）：

- 右栏滚动位置归零：卡片 body 是同一 DOM 节点，React 复用后 `scrollTop` 会留在上一项位置；从长内容（Scope 表）切到短内容会停在半空，看起来像空白。
- 窄屏（≤1100）纵向单栏时 `scrollIntoView` 到详情：否则点目录后详情在视口外，用户以为没反应。首屏挂载不滚。

---

## 5. 视觉 Token

全部复用现有 token，不新增颜色。

| 类别 | Token | 用途 |
|---|---|---|
| 背景 | `--ki-color-bg` / `--ki-color-surface` / `--ki-color-bg-secondary` | 页面 / 卡片 / 服务条与代码 bar |
| 文本 | `--ki-color-text` / `--ki-color-text-muted` / `--ki-color-text-subtle` | 主文 / 说明 / 辅助 |
| 品牌 | `--ki-color-primary` / `--ki-color-primary-soft` | 目录选中 / 复制 hover / 步骤号 / 外链 |
| 语义 | `--ki-color-success` / `--ki-color-warning` / `--ki-color-danger` | 状态点 / 需手动触发 / 复制失败 |
| 字体 | `--ki-font-family` / `--ki-font-mono` | 正文 / 命令与 scope 名 |
| 间距 | 4 / 8 / 12 / 16 / 20 | 组件内 / 卡内 / 卡间 |
| 圆角 | 6 / 10 / 14 | 代码与按钮 / 服务条与折叠块 / 卡片 |

页面级布局常量：`--res-nav-w: 240px`、`--res-card-pad: var(--ki-space-5)`、`--res-code-size: 12.5px`、`--res-row-h: 46px`。

---

## 6. 实现映射

| 位置 | 改动 |
|---|---|
| [AppShell.tsx](../../web/src/layouts/AppShell.tsx) | `NAV_MAIN` 增 `{ to:'/resources', label:'资源', icon:'compass' }` |
| [routes.tsx](../../web/src/router/routes.tsx) | `resources` + `resources/:topic` |
| `web/src/pages/ResourcesPage.tsx` | 双栏页面：目录 / MCP / Skill / LLM / Scope 表 / 功能示例 |
| `web/src/lib/resourcesPage.ts` | 目录定义、命令模板（scope 实填）、LLM 片段、Skill 清单、`describe*` 文案、外链常量 |
| `web/src/api/mcpClient.ts` | `ScopeInfo.wikiSync?: ScopeWikiStatusInfo` |
| [ki.css](../../web/src/styles/ki.css) | `.res-*` 段（v2 整体重写） |
| [src/scope.ts](../../src/scope.ts) | `ScopeEntry.wikiSync: ScopeWikiStatus` + `executeScopeListLocal` 填充（复用 `resolveWikiRootDir`） |
| [README.md](../../README.md) / [mcp-tools.md](../mcp-tools.md) | 页面描述 / `ki_scope_list` 新字段 |

**运行期取值**

- `origin = window.location.origin`；`mcpUrl = origin + '/mcp'`
- 默认接入 tab：`127.0.0.1 / localhost / ::1 → 本机`，否则 `其他设备`
- 示例 scope：`useScopeValue()`（顶栏当前 scope）；空 → `default`
- LLM 状态：`GET /api/chat/config`（`enabled / model / baseURLHost / configPath / reason / ackRequired`）
- Scope 状态：MCP 工具 `ki_scope_list`（`scopes[].wikiSync`）

**安全**

- 不展示任何真实 Token / apiKey；LLM 段只显示 `configPath` 与 `baseURLHost`（后端本就只回传 host）。
- 不在页面内执行命令；不放仓库主页或其他外链。

---

## 7. 待确认 / 已知限制

| # | 项 | 处理 |
|---|---|---|
| 1 | `npx skills` 的 agent 名随上游变化 | 集中在 `resourcesPage.ts`；发版前核对 |
| 2 | 示例命令随 CLI 演进漂移 | `docs/cli.md` 是权威源；本页只摘常用 + 外链；单测锁住"无占位符 / 子命令在白名单内" |
| 3 | `agents-md-init` 的手动触发话术 | 页面直接给出「初始化 AGENTS.md」，用户照说即可 |
| 4 | wiki 写回目录可能是**临时上传暂存**（`~/.ki/import-uploads/*`） | 页面如实展示真实解析结果；暂存目录被清理后自然转为"无可用目录"，不做额外推断 |
| 5 | 非 `--web` 打开（如 Vite dev）时 MCP 地址可能不准 | 页面提示以 `ki mcp --status` 的实监听为准 |
| 6 | 页面不校验客户端配置是否生效 | 只给验证命令，不假装已连接 |
| 7 | stdio 示例**不带 `env`** | 桥接 daemon 时 Token / API Key 都在 daemon 侧，配置层也"不做隐式回退"（`docs/cli.md`）；页面用 `STDIO_ENV_NOTE` 说明唯一例外（IDE 直接拉起引擎 + 配置用 `${ENV_VAR}` 引用）。在示例里塞 `env` 会让人误以为必须填密钥（用户 2026-10-27 指出） |
| 8 | Agent 清单只列 7 家 | `npx skills` 官方支持 70+ 种 agent（`docs/agents.md` 表格）；页面列高频 4 家直出 + 5 家折叠（Cursor / Qoder / Qoder CN / Trae / Trae CN），并提示 `-a '*'` 可装全部。CodeBuddy 的标识是 `codebuddy`（落 `.codebuddy/skills/`），已实跑 `-a codebuddy -l` 验证可用 |

---

## 8. 验证证据（2026-10-27）

| 项 | 结果 |
|---|---|
| 真机走查（Playwright + chrome-headless-shell） | **48/48 PASS** |
| 双栏几何 | 左栏 240 / 右栏 960（1440）；两栏同行；`scrollHeight 900 == clientHeight 900`（页面不滚） |
| 目录 | 10 项、两组、默认 MCP；点击切 `/resources/import`；刷新仍在导入 |
| scope 实填 | `ki import --scope default …`（无占位符） |
| Skill | 列出 `ki-search` / `agents-md-init`，徽标「装完即生效 / 需手动触发」，含「初始化 AGENTS.md」触发话术与记忆闭环折叠 |
| LLM | 状态区 / 环境变量片段 / 「无需重启」/ `configPath` |
| 注册 scope 页 | 已注册清单（default / kisearch / kisearch-memory / xpert-memory）、4 条好处、`config.yaml` 片段（scope 实填）、3 条口径提醒、外链指向 `configuration.md#scopes` |
| 外链 | 页面内 GitHub 链接只有官方文档页：`docs/cli.md`（命令）/ `docs/configuration.md`（配置）/ `docs/mcp-tools.md`（工具） |
| 视口 | 1920 / 1280 双栏、1024 / 375 单栏，四档均无横向溢出；无控制台错误 |
| 路由切换 | 离开资源页后 `ki-content--noscroll` 已移除（不污染其它页面） |
| 单测 | `web` 全量 **578/578**（资源页 42 例）；后端 `scope-wikisync-status` **6/6** |
| 构建 | 后端 `tsc -p tsconfig.src.json` 0；`web tsc --noEmit` 0；`vite build` 0 |
| 截图 | `temp/shots/res-v2-{1920,1280,1024,375}.png`、`res-v2-1440-import.png` |

**约束变更记录**

1. **原「页面内不放 GitHub 外链」（v1 设计原则）已放宽**：允许官方文档页外链 —— 命令项指 `docs/cli.md`，配置项（注册 scope）指 `docs/configuration.md`，每个功能项最多 1 个（用户 2026-10-27 要求"更多用法链接到 GitHub 文档"）。命令文本里的 `raw.githubusercontent.com` 仍只作可复制文本，不作为链接。
2. **`demo/resources-page/index.html` 不再跟进 v2**：v2 的视觉以生产页面 + Playwright 截图为准，避免 demo 与生产出现第二份漂移。v1 demo 保留作历史参考。
