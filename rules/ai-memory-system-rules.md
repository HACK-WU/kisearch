# ai-memory-system-rules 记忆系统行为规则

> **面向所有项目**。本规则指导 AI 利用 `ki` 命令构建跨会话的持久化记忆能力。
> 覆盖两大领域：**项目记忆**（项目上下文）和**用户画像**（个人偏好与习惯）。
> 与 `ai-codekb-memory-rules` 互补，不重叠。

---

## 0. 速览：什么时候做什么

```
对话开始?
  ├─ scope 已知 → 自动召回
  │   ├─ ki query-group --scope ${scope}-memory --mode full   → 项目记忆全景
  │   └─ ki query-group --scope user-profile --mode full     → 用户画像全景
  │
  └─ scope 未知 → 暂停，问用户

对话中发现关键信息?
  ├─ 项目信息（背景/技术栈/进度/踩坑/需求...）  → 项目记忆
  │   └─ ki sync-relation --scope ${scope}-memory ...
  │
  └─ 用户偏好（沟通/代码风格/工具/习惯...）      → 用户画像
      └─ ki sync-relation --scope user-profile ...

查询记忆（三步走）:
  ① 定位 Group  → 从全景缓存中锁定目标 Group
  ② 查热区      → ki query-group --groups <G> --mode hot,emerging
  ③ 取原文      → 命中 → ki get-module-info → 提炼回答
                  未命中 → 回问用户 / 使用默认行为

访问"最近需求"或"进度"时?
  → 检查过期条目，超过 7 天的移动到 archive.md（归档，不删除）
```

---

## 1. Scope 约定

本规则使用两个 scope：

| scope | 用途 | 命名规则 |
|-------|------|----------|
| `${scope}-memory` | 项目记忆 | 代码知识库 scope + `-memory` 后缀 |
| `user-profile` | 用户画像 | 固定值，全局唯一 |

**示例**：代码知识库 scope 为 `monitor` → 项目记忆 scope 为 `monitor-memory`

**前提条件**：`${scope}` 必须已知（来自代码知识库规则或用户指定）。若未知，暂停问用户。

> 当 `${scope}` 仍是字面量时，禁止执行任何 ki 命令。必须先确认 scope。

---

## 2. 与代码知识库的边界

| 维度 | ai-codekb-memory-rules | ai-memory-system-rules |
|------|------------------------|------------------------|
| scope | `${scope}` | `${scope}-memory` / `user-profile` |
| 内容类型 | 代码知识（模块、API、设计） | 项目上下文 + 用户偏好 |
| 查询兜底 | `memory_recall` 语义兜底 | 无语义兜底，未命中则回问 |

**代码知识库已覆盖**（不要写入记忆系统）：
- 模块/组件职责、API 接口、架构约束、bug 模式、重构策略、依赖版本、测试策略

**记忆系统覆盖**：
- 项目背景、技术栈选型、团队约定、项目历史、当前状态、需求进度、踩坑点
- 用户沟通偏好、代码风格、工具链、技术背景、工作/对话习惯

**判断口诀**：能用代码引用回答的 → 代码知识库；需要项目背景/个人偏好的 → 记忆系统。

---

## 3. Group 结构定义

### 3.1 项目记忆（scope: `${scope}-memory`）

```
${scope}-memory/
├── 背景与目标/          # 项目目标、业务领域、当前阶段、里程碑
├── 技术栈选型/          # 框架版本、选型原因、技术债务
├── 团队约定/            # 代码风格、分支策略、发布流程、Commit 规范
├── 项目历史/            # 重大变更记录、架构演进决策
├── 当前状态/            # 进行中任务、待解决问题、阻塞项
├── 外部依赖/            # 第三方服务、API 配置、环境变量
├── 最近需求/            # ⚡ 动态 Group，见 §3.3
├── 进度/                # ⚡ 动态 Group，见 §3.3
├── 项目踩坑点/          # 常见问题、解决方案、注意事项
├── 项目架构/            # 整体架构、模块关系、数据流
└── ...                  # 🔄 AI 可自行扩展（见 §8）
```

### 3.2 用户画像（scope: `user-profile`）

```
user-profile/
├── 沟通偏好/            # 简洁/详细、中/英文、是否举例
├── 代码风格/            # 命名习惯、注释偏好、格式化规则
├── 工具链/              # 编辑器、终端、Git 客户端、常用命令
├── 技术背景/            # 擅长领域、技术栈熟悉度、学习方向
├── 工作习惯/            # 工作时间段、文档风格偏好、反馈方式
└── 对话习惯/            # 对 AI 的要求、回复风格偏好
```

### 3.3 动态 Group（归档机制）

以下 Group 有时效性，使用 `active.md` + `archive.md` 双文件结构：

| Group | 活跃文件 | 归档文件 | 保留规则 |
|-------|----------|----------|----------|
| 最近需求 | Relation（`ki` 管理） | `archive.md`（追加文件） | 只保留最近 7 天，超期移入归档 |
| 进度 | 分 `进行中` 和 `已完成` 两类 Relation（`ki` 管理） | `archive.md`（追加文件） | 进行中永久保留；已完成保留 7 天，超期移入归档 |

**归档文件的本质**：`archive.md` 是独立于 ki 的纯文本追加文件，由 AI 直接读写。ki 管理的 Relation 内容只保留活跃条目。归档内容永久追加到 `archive.md` 用于历史查阅。

**其他 Group** 均使用单文件 `index.json`，无归档机制。

---

## 4. 对话开始：自动召回

**触发条件**：检测到 `${scope}` 后自动执行（无需用户触发）。

```mermaid
flowchart LR
    A[检测到 scope] --> B[ki query-group<br/>--scope $scope-memory<br/>--mode full]
    A --> C[ki query-group<br/>--scope user-profile<br/>--mode full]
    B --> D[缓存项目记忆全景]
    C --> E[缓存用户画像全景]
    D --> F[后续查询直接用缓存]
    E --> F
```

**执行命令**：

```bash
# 1. 加载项目记忆全景
ki query-group --scope ${scope}-memory --mode full

# 2. 加载用户画像全景
ki query-group --scope user-profile --mode full
```

**缓存策略**：首次查询后，索引信息在当前会话中有效。写入操作后需刷新。

**静默失败**：scope 不存在或树为空时不报错，记录"无记忆索引"后继续。

---

## 5. 查询记忆：三步走

```mermaid
flowchart TD
    A([需要记忆信息]) --> Q{信息类型?}
    Q -- 项目记忆 --> S1[从项目记忆缓存<br/>定位目标 Group]
    Q -- 用户画像 --> S2[从用户画像缓存<br/>定位目标 Group]
    
    S1 --> P{全景中已明确<br/>Relation 名称?}
    S2 --> P
    
    P -- 是 --> F[取原文<br/>ki get-module-info]
    P -- 否 --> D[查该 Group 热区<br/>ki query-group --groups G<br/>--mode hot,emerging]
    
    D --> E{命中 relation?}
    E -- 是 --> F
    F --> G[提炼回答 / 应用偏好]
    G --> H([结束])
    E -- 否 --> L[回问用户 / 使用默认行为]
    L --> H
```

### 第①步：定位目标 Group

基于 §4 已缓存的全景索引，判断信息属于哪个 Group。

- **项目记忆**：根据用户问题锁定 `${scope}-memory` 下的某个 Group
- **用户画像**：根据需求锁定 `user-profile` 下的某个 Group
- **若缓存中无明确匹配**，重新执行对应全景查询确认
- **若定位到多个候选 Group**，优先选择得分最高的；不确定时可依次排查

### 第②步：查热门 + 新兴热区

对目标 Group 执行：

```bash
# 项目记忆
ki query-group --scope ${scope}-memory --groups "目标Group路径" --mode hot,emerging

# 用户画像
ki query-group --scope user-profile --groups "目标Group路径" --mode hot,emerging
```

**输出示例**：

```
=== monitor-memory/背景与目标 ===

🔥 热门知识 (Top 3):
├── 项目简介 (score: 8.5) [热]
├── 技术选型原因 (score: 6.2) [热]
└── 业务领域 (score: 4.8) [常温]

🏷️ 关键词词云:
└── 监控, 告警, 运维, 蓝鲸, SaaS
```

**操作**：
- 从热门知识中选择最匹配的 relation
- 记下关键词词云（后续扩展查询时备用）
- **命中** → 进入第③步取原文
- **未命中** → 先检查 Group 是否定位正确（可换 Group 重试一次），确认无误后回问用户或使用默认行为

**快捷路径（跳过②）**：如果全景索引中已经能看到与用户问题直接匹配的 Relation 名称，可跳过第②步，直接进入第③步 `get-module-info`。

### 第③步：取原文

```bash
# 项目记忆
ki get-module-info --scope ${scope}-memory --group "目标Group路径" --relation "Relation名称"

# 用户画像
ki get-module-info --scope user-profile --group "目标Group路径" --relation "Relation名称"
```

返回完整 Markdown 原文。**Agent 必须提炼后回答**，不要全文转储。

**各 Group 的典型 Relation 名称示例**：

| Group | 典型 Relation |
|-------|--------------|
| 背景与目标 | "项目简介"、"业务领域"、"里程碑节点" |
| 团队约定 | "分支策略"、"Commit 规范"、"发布流程" |
| 技术栈选型 | "技术栈清单"、"选型原因" |
| 沟通偏好 | "回复风格"、"语言偏好" |
| 代码风格 | "命名习惯"、"格式化规则" |
| 对话习惯 | "对 AI 的要求" |

---

## 6. 自动沉淀：写入记忆

### 6.1 触发条件

AI 在对话中识别到以下信息时，**自动沉淀**（无需用户指示）：

| 信息类型 | 触发信号 | 目标 scope | 示例 Group |
|----------|----------|------------|------------|
| 项目信息 | 用户明确陈述项目事实 | `${scope}-memory` | 背景与目标、技术栈选型、团队约定... |
| 需求/进度 | 用户提到要做的事或完成情况 | `${scope}-memory` | 最近需求、进度 |
| 踩坑经验 | 用户提及问题与解决方案 | `${scope}-memory` | 项目踩坑点 |
| 用户偏好 | 用户表达个人倾向 | `user-profile` | 沟通偏好、代码风格、对话习惯... |

### 6.2 写入方式

**所有写入统一使用 `ki sync-relation`**：

```bash
# 项目记忆
ki sync-relation \
  --scope ${scope}-memory \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容" \
  --keywords "关键词1,关键词2,关键词3"

# 用户画像
ki sync-relation \
  --scope user-profile \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容" \
  --keywords "关键词1,关键词2,关键词3"
```

**写入后刷新**：每次写入完成后，必须重新执行对应全景查询更新缓存：

```bash
# 写入项目记忆后刷新
ki query-group --scope ${scope}-memory --mode full

# 写入用户画像后刷新
ki query-group --scope user-profile --mode full
```

### 6.3 keywords 规则

- 必须是**自然语言词汇**，禁止代码符号（类名、方法名、路径）
- 必须真实出现在 `module-info` 原文中
- 3~5 个为宜

### 6.4 最近需求与进度的写入格式

**最近需求**：每条只需 1-2 句话，必须带日期前缀：

```
[YYYY-MM-DD] 需求描述
```

示例：
```
[2026-06-12] 实现用户登录功能
[2026-06-12] 优化搜索性能，目标响应时间 < 200ms
```

**进度**：区分进行中与已完成：

```
进行中：
[YYYY-MM-DD] 🔄 重构告警引擎（预计 6/15 完成）

已完成：
[2026-06-12] ✅ 修复登录页面样式问题
```

---

## 7. 记忆更新

当用户纠正旧信息或信息发生变化时：

**流程**：查找现有内容 → 确认 → 覆盖写入

**项目记忆更新**：

```bash
# 1. 查找现有 Relation
ki query-group --scope ${scope}-memory --groups "目标Group路径" --mode hot,emerging

# 2. 取现有内容确认
ki get-module-info --scope ${scope}-memory --group "目标Group路径" --relation "Relation名称"

# 3. 覆盖写入新内容
ki sync-relation \
  --scope ${scope}-memory \
  --group "目标Group路径" \
  --relation "同一Relation名称" \
  --module-info "更新后的Markdown内容" \
  --keywords "更新后的关键词"

# 4. 刷新缓存
ki query-group --scope ${scope}-memory --mode full
```

**用户画像更新**：

```bash
# 1. 查找现有 Relation
ki query-group --scope user-profile --groups "目标Group路径" --mode hot,emerging

# 2. 取现有内容确认
ki get-module-info --scope user-profile --group "目标Group路径" --relation "Relation名称"

# 3. 覆盖写入新内容
ki sync-relation \
  --scope user-profile \
  --group "目标Group路径" \
  --relation "同一Relation名称" \
  --module-info "更新后的Markdown内容" \
  --keywords "更新后的关键词"

# 4. 刷新缓存
ki query-group --scope user-profile --mode full
```

**`sync-relation` 同名覆盖**：Relation 名称相同时，自动覆盖原有内容。

---

## 8. 归档机制

### 8.1 归档策略

| Group | 保留规则 | 归档方式 |
|-------|----------|----------|
| 最近需求 | 只保留最近 7 天，每条必须带日期 | AI 发现超过 7 天的需求移动到 `archive.md` |
| 进度（已完成） | 只保留最近 7 天 | AI 发现超过 7 天的已完成进度移动到 `archive.md` |
| 进度（未完成） | 永久保留 | 不归档 |
| 当前状态 | 超过 30 天自动标记过期 | AI 定期检查并归档到 `archive.md` |
| 其他 Group | 永久保留 | 不归档 |

### 8.2 归档时机

**每次访问"最近需求"或"进度" Group 时**，AI 必须检查并归档过期条目。

### 8.3 归档操作

**核心原理**：动态 Group 的活跃内容仍由 ki 的 `sync-relation` 管理（写 `index.json`）。`archive.md` 是独立于 ki 的纯文本追加文件，由 AI 直接读写。归档 = 从 ki Relation 中移除过期条目 + 追加到 `archive.md`。

**操作步骤**：

```
1. ki get-module-info → 获取当前 Group 的 Relation 完整内容
2. AI 解析内容 → 识别所有 [YYYY-MM-DD] 条目
3. AI 判断过期 → 距今超过 7 天的条目标记为过期
4. ki sync-relation → 将活跃条目（≤7天）写回 ki（覆盖原 Relation）
5. 文件写入工具 → 将过期条目追加到 archive.md（按日期分组）
6. ki query-group --mode full → 刷新缓存
```

**最近需求归档示例**：

```bash
# 1. 读取当前内容
ki get-module-info --scope ${scope}-memory --group "最近需求" --relation "最近需求"

# 返回示例：
# [2026-06-12] 实现用户登录功能
# [2026-06-12] 优化搜索性能
# [2026-06-05] 添加数据导出功能        ← 超过 7 天，需归档
# [2026-06-04] 重构告警引擎            ← 超过 7 天，需归档

# 2-3. AI 在脑中完成：识别 [2026-06-05] 和 [2026-06-04] 已过期

# 4. 写回活跃条目（只保留 7 天内的）
ki sync-relation \
  --scope ${scope}-memory \
  --group "最近需求" \
  --relation "最近需求" \
  --module-info "[2026-06-12] 实现用户登录功能
[2026-06-12] 优化搜索性能" \
  --keywords "登录,搜索,性能"

# 5. 追加过期条目到 archive.md
# （使用文件写入工具，向 最近需求/archive.md 追加以下内容）
# ## 2026-06-05
# - [2026-06-05] 添加数据导出功能
# ## 2026-06-04
# - [2026-06-04] 重构告警引擎

# 6. 刷新缓存
ki query-group --scope ${scope}-memory --mode full
```

**archive.md 格式**：

```markdown
# 最近需求归档

## 2026-06-05
- [2026-06-05] 添加数据导出功能

## 2026-06-04
- [2026-06-04] 重构告警引擎
```

**进度归档的特殊处理**：由于"进度" Group 同时包含进行中和已完成内容，归档时：
1. `ki get-module-info` 读取"进度"的 Relation 原文
2. AI 解析出「进行中」和「已完成」两部分
3. 保留所有「进行中」条目 + 最近 7 天的「已完成」条目
4. 超过 7 天的已完成条目追加到 `archive.md`
5. `ki sync-relation` 写回保留的内容

> **关键原则**：过期条目归档（移到 archive.md），不是删除。历史信息有参考价值。
>
> **若 archive.md 不存在**：首次归档时自动创建。

---

## 9. AI 自主扩展

> AI 在对话过程中，如果发现当前 Group 结构无法覆盖新信息，可以**自行创建新的 Group**，无需用户确认。

**示例**：对话中发现"部署流程"相关信息，但现有 Group 无此分类 → 自动创建"部署流程" Group。

```bash
# 项目记忆
ki manage-index --scope ${scope}-memory --action create --parent "" --name "部署流程"

# 用户画像
ki manage-index --scope user-profile --action create --parent "" --name "新维度"
```

**创建后刷新**：创建 Group 后重新执行对应全景查询：

```bash
# 项目记忆
ki query-group --scope ${scope}-memory --mode full

# 用户画像
ki query-group --scope user-profile --mode full
```

---

## 10. 协同：结合代码知识库和项目记忆

当用户问题同时涉及代码知识和项目上下文时：

```
1. 先查代码知识库 ${scope} → 找到模块/架构信息
2. 再查项目记忆 ${scope}-memory → 找到相关项目上下文
3. 综合两方信息回答
```

**示例**：用户问"告警引擎为什么这样设计？"
- 代码知识库 → 告警引擎的架构实现
- 项目记忆 → 技术栈选型原因、历史决策背景

---

## 11. 禁忌清单

| # | 红线 |
|---|------|
| 🔴 1 | `${scope}` 仍是字面量时，执行任何 ki 命令 |
| 🔴 2 | 把代码知识（模块、API、设计）写入记忆系统 scope |
| 🔴 3 | 把用户偏好/项目上下文写入代码知识库 scope |
| 🔴 4 | `keywords` 使用代码符号或未出现在原文中的词 |
| 🔴 5 | 跨 scope 串数据（项目记忆写入 `user-profile`，反之亦然） |
| 🔴 6 | 删除过期的 Relation 条目而非归档（必须移到 `archive.md`） |
| 🔴 7 | 在"最近需求"中记录超过 1-2 句话的详细描述 |
| 🔴 8 | "最近需求"或"进度"条目不带日期前缀 `[YYYY-MM-DD]` |

**写前自检三问**：scope 对了吗？是项目上下文/用户偏好吗？归档检查做了吗？

---

## 12. 快速命令速查

### 12.1 全部命令

```bash
# ===== 查询 =====

# 拉项目记忆全景
ki query-group --scope ${scope}-memory --mode full

# 拉用户画像全景
ki query-group --scope user-profile --mode full

# 查某 Group 热区（项目记忆）
ki query-group --scope ${scope}-memory --groups "路径" --mode hot,emerging

# 查某 Group 热区（用户画像）
ki query-group --scope user-profile --groups "路径" --mode hot,emerging

# 取原文（项目记忆）
ki get-module-info --scope ${scope}-memory --group "路径" --relation "名称"

# 取原文（用户画像）
ki get-module-info --scope user-profile --group "路径" --relation "名称"

# ===== 写入 =====

# 写入项目记忆
ki sync-relation --scope ${scope}-memory --group "路径" --relation "名称" --module-info "内容" --keywords "k1,k2"

# 写入用户画像
ki sync-relation --scope user-profile --group "路径" --relation "名称" --module-info "内容" --keywords "k1,k2"

# ===== 管理 =====

# 创建 Group（项目记忆）
ki manage-index --scope ${scope}-memory --action create --parent "父" --name "子"

# 创建 Group（用户画像）
ki manage-index --scope user-profile --action create --parent "父" --name "子"

# 删除 Group
ki manage-index --scope <scope> --action delete --parent "父" --name "子" --force
```

### 12.2 常见错误与修复

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope not found` | scope 尚未创建 | 先执行 `ki sync-relation` 写入任意一条数据自动创建 scope |
| Group 不存在 | 尚未创建该 Group | 执行 `ki manage-index --action create` 创建 |
| 归档时找不到 Relation | Relation 名称与预期不符 | 用 `ki query-group --mode full` 确认实际名称 |
| `keywords` 被拒绝 | 包含代码符号或未出现在原文中 | 改用自然语言词，确认词在 module-info 中真实存在 |
| `${scope}` 仍是字面量 | 用户未指定 scope | 暂停，先问用户确认 scope |
| 写入到错误的 scope | 混淆了权限和 scope | 检查：项目记忆 → `${scope}-memory`，用户画像 → `user-profile` |

---

## 13. 数据存储位置

```
<ki安装路径>/kb/
├── ${scope}-memory/                    # 项目记忆
│   ├── group-index.json                # Group 树索引（ki 自动管理）
│   ├── relations-cache.json            # Relations 缓存（ki 自动管理）
│   │
│   ├── 背景与目标/index.json           # 内容稳定的 Group：仅 index.json
│   ├── 技术栈选型/index.json
│   ├── 团队约定/index.json
│   ├── 项目历史/index.json
│   ├── 当前状态/index.json
│   ├── 外部依赖/index.json
│   ├── 项目踩坑点/index.json
│   ├── 项目架构/index.json
│   │
│   ├── 最近需求/                       # 动态 Group
│   │   ├── index.json                  # ki 管理：仅保留最近 7 天的条目
│   │   └── archive.md                  # AI 管理：归档超过 7 天的条目
│   │
│   └── 进度/                           # 动态 Group
│       ├── index.json                  # ki 管理：进行中 + 最近 7 天已完成
│       └── archive.md                  # AI 管理：归档超过 7 天的已完成条目
│
└── user-profile/                       # 用户画像
    ├── group-index.json
    ├── relations-cache.json
    └── {Group}/index.json              # 所有用户画像 Group 仅 index.json
```

> 当前环境实际路径：`/root/.npm/node_modules/lib/node_modules/knowledge-indexer/kb/`
>
> **文件管理权责**：`index.json` / `group-index.json` / `relations-cache.json` 由 ki 命令自动管理；`archive.md` 由 AI 通过文件读写工具直接操作。

---

## 14. 测试阶段反馈

`knowledge-index` 正处于测试验证阶段。使用过程中遇到以下情况时，请进行反馈报告：

### 需要反馈的场景

| 类型 | 示例 |
|------|------|
| **非使用错误的异常** | 命令执行崩溃、返回格式异常、数据不一致 |
| **可优化点** | 归档流程繁琐、Group 结构不合理、沉淀时机不准 |
| **文档/规则问题** | 描述与实际行为不符、遗漏边界场景、术语歧义 |
| **其他错误** | scope 隔离失效、归档数据丢失、关键词匹配偏差 |

### 反馈方式

向项目维护者报告时，尽量提供：
- 复现步骤（具体命令 + 参数）
- 实际输出 vs 期望输出
- scope 名称、Group 路径等上下文

---

> 本规则覆盖 REQ-01~16。与 `ai-codekb-memory-rules` 互补，各管各的 scope，互不重叠。
