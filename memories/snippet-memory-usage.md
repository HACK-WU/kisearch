# snippet-memory 调用时机

## 何时加载 `snippet-memory` skill

### 必须加载的场景

| 场景 | 触发信号 | 说明 |
|------|----------|------|
| 编码前查询 | AI 准备写代码 | 先查是否有可复用的工具函数或已知流程 |
| 用户问"有没有现成的" | "有没有XX工具"、"XX怎么实现的" | 从通用记忆片段中快速定位 |
| 构建记忆 | "根据这些代码构建记忆"、"把XX记录下来" | 批量或单个录入代码要点 |
| 阅读代码发现要点 | AI 读代码时遇到通用工具/关键流程/重要模式 | 自动记录到对应分类 |

### 不加载的场景（走其他 skill）

| 场景 | 走哪个 | 原因 |
|------|--------|------|
| 模块架构、API设计 | `codekb-skill` | 架构级知识 |
| 项目背景、进度、偏好 | `memory-skill` | 项目上下文 |
| 定位具体文件/符号 | 直接用 grep/SearchSymbol | 定位级查询 |

### 一句话判断

> 问自己：这段信息是"一句话就能说清楚的代码要点（函数/流程/模式）"还是"需要段落描述的架构知识"？
> 前者 → `snippet-memory`，后者 → `codekb-skill`。

### 记忆归类原则

> **禁止全部放入"通用记忆片段"。** 写入前先思考最适合的 Group 分类。

| 内容类型 | 优先归类到 | 示例 |
|----------|-----------|------|
| 工具函数、helper、脚本 | `工具库` | `formatDate()`、`retryRequest()` |
| 已踩过的坑、注意事项 | `项目踩坑点` | "XX 库 v2 不兼容 v1 的 YY API" |
| 构建/调试/部署命令 | `常用命令` | `npm run build:prod -- --sourcemap` |
| 部署流程、环境配置 | `部署运维` | "生产环境需先执行 XX 脚本" |
| 无法归类的通用要点 | `通用记忆片段` | 仅当以上分类都不匹配 |

**没有合适的现存 Group 时，自己创建**：

```bash
# 先确认目标 scope
ki query-group --scope ${scope}-memory --mode full

# 创建新 Group
ki manage-index create --scope ${scope}-memory --name "你的新分类名"

# 再写入记忆
ki sync-relation --scope ${scope}-memory --group "你的新分类名" \
  --relation "记忆标题" \
  --module-info "记忆内容..." \
  --keywords "关键词"
```

> **记住**：先归类 → 无匹配则新建 → 实在不行才用"通用记忆片段"。

---

## 需求与进度记录

> 获取需求或完成部分工作后，必须通过 ki 写入对应 Group。

| 时机 | 写入 Group | 说明 |
|------|-----------|------|
| 收到新需求 | `最近需求` | 记录需求描述和时间 |
| 完成部分任务 | `进度` | 记录完成内容和状态 |

**写入方式**：调用 `ki_sync_relation`：

```bash
# 收到新需求时
ki sync-relation --scope ${scope}-memory --group "最近需求" \
  --relation "[2026-06-24] 新增xxx功能" \
  --module-info "用户希望实现xxx，用于xxx场景。" \
  --keywords "需求,xxx,功能"

# 完成部分任务时
ki sync-relation --scope ${scope}-memory --group "进度" \
  --relation "进行中: [2026-06-24] 🔨 正在开发xxx模块" \
  --module-info "已完成xxx部分，剩余xxx。" \
  --keywords "进度,xxx,开发"
```

**写入后同步 AGENTS.md**：

1. 将新增的需求/进度追加到 AGENTS.md 的"近期工作"段落
   - 需求格式：`[YYYY-MM-DD] {需求描述（1-2句话）}`
   - 进度格式：`进行中/已完成: [YYYY-MM-DD] {状态图标} {描述}`
2. 清理 AGENTS.md 中超过 7 天的旧条目（删除过期内容）

---

## 代码/功能疑问排查优先级

> 对代码用法或功能存在疑问时，按以下顺序查找，优先走本地缓存和记忆索引，减少搜索成本。

| 优先级 | 方式 | 命令/工具 | scope | 说明 |
|--------|------|-----------|-------|------|
| 1 | 查项目记忆索引 | `ki_query_group` (mode: hot/full) | `${scope}-memory` | 先看项目维度的 Group 树和热门 Relation |
| 2 | 查知识库记忆索引 | `ki_query_group` (mode: hot/full) | `${scope}` | 再看知识库维度的 Group 树和 Relation |
| 3 | 代码搜索 | grep / SearchSymbol | - | 项目中直接定位代码 |
| 4 | 语义检索 | `ki_search` | `${scope}` / `${scope}-memory` | 向量召回相关记忆 |

> **原则**：先 ki 记忆索引（项目 → 知识库），再代码搜索，最后语义兜底。scope 规则：项目记忆用 `${scope}-memory`，知识库记忆用 `${scope}`。


## 会话结束收尾

> **检测到以下信号时，AI 应主动执行记忆更新，表示当前阶段即将结束、进入下一阶段。**

**触发信号**（用户说）：
- "好"、"OK"、"可以"、"没问题" — 确认当前讨论结果
- "记录到文档"、"写入文档"、"保存" — 明确要求记录
- "开始实施"、"开始做"、"开始写代码" — 进入实施阶段
- "下一个"、"继续" — 切换到新话题

**收尾动作**：
```
□ 是否有未记录的新需求？→ 写入项目记忆 + AGENTS.md
□ 是否有未记录的代码要点？→ 写入 snippet-memory
□ 是否有进度变化？→ 更新项目记忆的"进度" Group
□ 索引是否有变更？→ agents-md-init 增量更新
□ 近期工作是否超过 7 天？→ 触发归档（见 memory-skill 第8章）
```

> 不需要等用户说"结束"才执行，而是**在对话自然转折点主动执行**。

## 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | **将详细项目知识存入平台内置记忆**（代码知识、架构决策等必须走 ki） |
| 🔴 2 | **将简洁通用偏好存入 ki**（沟通语言、通用规则等用平台记忆） |
| 🔴 3 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 4 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 5 | Skill 不存在时仍继续执行 ki 命令（应提示用户安装 knowledge-indexer） |
| 🔴 6 | **对 ki scope 使用 memory MCP 存取**（`user-profile`/`${scope}-memory`/`${scope}` 禁止 `memory_store`/`memory_recall`/`memory_update`/`memory_forget`，统一用 ki MCP 工具） |
| 🔴 7 | **忽略 AGENTS.md 缓存机制**（对话开始时必须检查并更新缓存，索引变更后必须同步更新） |
| 🔴 8 | **依赖人工提示记录需求**（AI 必须主动识别新需求信号并自动记录，不得等待用户提醒） |
| 🔴 9 | **索引变更后不更新缓存**（创建新 Group 或 Relation 后必须立即更新 AGENTS.md） |
| 🔴 10 | **近期工作记录超过 7 天**（超期内容必须归档，保持 AGENTS.md 简洁） |


## AGENTS.md 维护规范

> 完整维护流程见 `agents-md-init` skill，归档机制见 `memory-skill` 第8章。

### 核心约束
- **文件大小**：控制在 10KB 以内，超过时清理过期内容
- **更新时机**：首次对话 / 索引变更 / 新需求 / 每日检查
- **一致性**：发现不一致自动更新，无需用户确认
- **归档**：超过 7 天的工作记录移动到项目记忆的 archive.md
