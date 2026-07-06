---
name: agents-md-init
description: 初始化或更新项目根目录的 AGENTS.md 文件。自动查询 ki 获取真实索引数据填充三类索引（知识库/项目记忆/用户画像），无真实数据时用示例格式兜底。支持首次使用引导创建 scope。同步近期工作记录。对话开始时必须加载。
---

# agents-md-init AGENTS.md 初始化

> **前置条件**：AI 已了解 ki MCP 工具（ki-foundation）。AGENTS.md 位于项目根目录。

---

## 1. 概述

**目的**：自动维护 AGENTS.md 文件，确保其中的索引信息与实际 ki 数据保持一致。解决规则文件中嵌入模板导致的内容混乱问题。

**功能**：
- 首次对话时自动创建/更新 AGENTS.md
- 查询 ki 获取真实索引数据填充三类索引
- 无真实数据时用示例格式兜底（标注 ⚠️）
- 同步近期工作记录（7 天内）
- 索引变更后自动刷新

**使用场景**：
- 首次对话，AGENTS.md 不存在或索引为空
- 索引变更后需要刷新缓存
- 手动触发"初始化 AGENTS.md"、"刷新缓存"
- ki 中无任何 scope 时引导用户创建

---

## 1.5 首次使用引导

> **当 `ki_manage_index_list` 返回空列表时，AI 应主动引导。**

```
① ki_manage_index_list → 无任何 scope
    ↓
② 主动提示用户：
    "检测到项目尚未配置知识库索引。是否需要我帮你初始化？"
    ↓ 用户确认
③ 确定 scope 名称（默认取项目目录名的小写简写）
④ ki_manage_index_create(scope, name: "项目概述")
⑤ ki_manage_index_create(scope: "${scope}-memory", name: "背景与目标")
⑥ ki_manage_index_create(scope: "user-profile", name: "沟通偏好")
⑦ 执行完整初始化（步骤 2.1）
```

> 用户拒绝则跳过，后续按需触发。

### 异常处理

若本 skill 文件不存在（如新克隆项目）：`ai-codekb-memory` 规则的步骤0 会提示用户安装 knowledge-indexer，然后跳过 AGENTS.md 初始化，后续按需触发。此流程也记录在 `ai-codekb-memory` 规则的"首次使用引导"中。

---

## 2. 初始化流程

```
对话开始
    │
    ├── AGENTS.md 不存在？
    │       └── 是 → 执行完整初始化（步骤 2.1）
    │
    ├── AGENTS.md 存在但无"知识库索引"章节？
    │       └── 是 → 执行完整初始化
    │
    └── AGENTS.md 存在且完整？
            └── 检查索引一致性 → 不一致则增量更新
```

### 2.1 完整初始化

```
① ki_manage_index_list → 获取所有 scope
② 对获取到的 scope 分类：
   - 代码知识库 scope → 知识库索引
   - ${scope}-memory scope → 项目记忆索引
   - user-profile scope → 用户画像索引
③ 对每个 scope 执行 ki_query_group(mode: "full,depth=4") → Group 结构
④ 对每个 scope 执行 ki_query_group(mode: "hot,hot_count=3") → 热门 Relation
⑤ 从项目记忆中提取近期工作：ki_query_group(groups: "最近需求,进度")
⑥ 写入 AGENTS.md
```

### 2.2 增量更新

当 AGENTS.md 已存在但部分过期时：

```
① 读取 AGENTS.md，提取已有的 scope 列表
② ki_manage_index_list → 获取最新 scope 列表
③ 对比差异：
   - 新增 scope → 补充对应章节
   - 删除 scope → 移除对应章节
   - Group 结构变更 → 更新对应章节
④ 检查项目记忆预定义 Group 是否存在，缺失则初始化（见 §项目记忆索引）
⑤ 检查用户画像预定义 Group 是否存在，缺失则初始化（见 §用户画像索引）
⑥ 检查"近期工作"时间戳 → 超过 1 天则刷新
```

---

## 3. AGENTS.md 格式模板

```markdown
# AGENTS.md - AI AGENT 项目记忆文件

> **本文件由 AI AGENT 自动维护，用于缓存索引信息、记录近期工作、跟踪新需求。**

---

## 知识库索引

### Scope 列表
- {scope}: {描述}
- {scope}-memory: {scope}项目记忆
- user-profile: 用户画像（全局固定）

### {scope} 索引
#### Group 结构
- {Group1}
- {Group2}
- ...

#### 热门 Relation
- {Relation1} (热度: {score})
- {Relation2} (热度: {score})

---

## 项目记忆索引

### {scope}-memory 索引

#### Group 初始化检查

首次或 Group 缺失时，先查询当前实际 Group，再补建缺少的：

```bash
# 1. 查询当前 Group 全貌
ki query-group --scope ${scope}-memory --mode full

# 2. 对比预定义列表，缺失则逐个创建
ki manage-index create --scope ${scope}-memory --name "背景与目标"
ki manage-index create --scope ${scope}-memory --name "技术栈选型"
ki manage-index create --scope ${scope}-memory --name "团队约定"
ki manage-index create --scope ${scope}-memory --name "项目历史"
ki manage-index create --scope ${scope}-memory --name "当前状态"
ki manage-index create --scope ${scope}-memory --name "外部依赖"
ki manage-index create --scope ${scope}-memory --name "最近需求"
ki manage-index create --scope ${scope}-memory --name "进度"
ki manage-index create --scope ${scope}-memory --name "项目踩坑点"
ki manage-index create --scope ${scope}-memory --name "项目架构"
ki manage-index create --scope ${scope}-memory --name "工具库"
ki manage-index create --scope ${scope}-memory --name "常用命令"
ki manage-index create --scope ${scope}-memory --name "部署运维"
ki manage-index create --scope ${scope}-memory --name "通用记忆片段"
ki manage-index create --scope ${scope}-memory --name "专题记忆"
```

#### Group 结构
- 背景与目标
- 技术栈选型
- 团队约定
- 项目历史
- 当前状态
- 外部依赖
- 最近需求
- 进度
- 项目踩坑点
- 项目架构
- 工具库
- 常用命令
- 部署运维
- 专题记忆
  > **注意**：专题记忆组下必须创建子索引（子组）后才能写入记忆片段，禁止直接向专题记忆组写入 relation。
- 通用记忆片段
  - {列出实际分类，按功能或类型}

#### 热门 Relation
- {Relation1} (热度: {score})
- ...

---

## 用户画像索引

### user-profile 索引

#### Group 初始化检查

首次或 Group 缺失时，查询当前实际 Group，补建缺少的：

```bash
# 1. 查询当前 Group 全貌
ki query-group --scope user-profile --mode full

# 2. 对比预定义列表，缺失则逐个创建
ki manage-index create --scope user-profile --name "沟通偏好"
ki manage-index create --scope user-profile --name "代码风格"
ki manage-index create --scope user-profile --name "工具链"
ki manage-index create --scope user-profile --name "技术背景"
ki manage-index create --scope user-profile --name "工作习惯"
ki manage-index create --scope user-profile --name "对话习惯"
```

#### Group 结构
- 沟通偏好
- 代码风格
- 工具链
- 技术背景
- 工作习惯
- 对话习惯

#### 热门 Relation
- {Relation1} (热度: {score})
- ...

---

## 近期工作 (7天内)

### 最近需求
- [YYYY-MM-DD] {需求描述}

### 进度
- 进行中: [YYYY-MM-DD] 🔄 {描述}
- 已完成: [YYYY-MM-DD] ✅ {描述}

---

## 更新日志

| 日期 | 更新内容 |
|------|----------|
| YYYY-MM-DD | {更新说明} |
```

---

## 4. 真实数据 vs 示例数据

> **优先使用 ki 中的真实数据。仅当 ki 中无对应 scope 时，才使用示例格式兜底。**

### 有真实数据时

- Scope 列表 → 来自 `ki_manage_index_list`
- Group 结构 → 来自 `ki_query_group(mode: "full")`
- 热门 Relation → 来自 `ki_query_group(mode: "hot")`
- 近期工作 → 来自 `ki_query_group(groups: "最近需求,进度")`

### 无真实数据时（示例兜底）

在对应章节使用 ⚠️ 标注：

```markdown
## 知识库索引

> ⚠️ 知识库索引为空，尚未创建任何代码知识库 scope。
> 执行 `ki_manage_index_create` 创建 scope 后自动更新。

## 项目记忆索引

> ⚠️ 项目记忆索引为空，尚未创建任何项目记忆。
> 执行 `ki_manage_index_create` 创建 scope 后自动更新。

## 用户画像索引

> ⚠️ 用户画像索引为空，尚未创建任何用户画像。
> 执行 `ki_manage_index_create` 创建 scope 后自动更新。
```

---

## 5. 近期工作提取

从项目记忆的"最近需求"和"进度" Group 中提取：

```
ki_query_group(scope: "${scope}-memory", groups: "最近需求,进度", mode: "hot")
```

**格式**：
- 需求：`[YYYY-MM-DD] {需求描述（1-2句话）}`
- 进度：`进行中/已完成: [YYYY-MM-DD] {状态图标} {描述}`

**过期处理**：超过 7 天的条目不写入 AGENTS.md。

---

## 6. 更新日志维护

每次修改 AGENTS.md 后，在更新日志中追加一条记录：

```markdown
| YYYY-MM-DD | {变更说明，如"初始化索引缓存"、"新增 scope: xxx"} |
```

保留最近 10 条日志，超出删除最早的。

---

## 7. 协同

- **与 `ai-codekb-memory` 规则**：本 skill 负责 AGENTS.md 的创建和格式维护，规则文件负责行为决策（何时缓存、何时更新）
- **与 `ki-foundation`**：本 skill 依赖 ki MCP 工具获取索引数据
- **与 `memory-skill`**：近期工作数据从项目记忆中提取

---

## 8. 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | 用固定示例数据覆盖真实 ki 索引 |
| 🔴 2 | AGENTS.md 存在且完整时仍执行完整初始化（应增量更新） |
| 🔴 3 | 不检查 ki 数据直接写入示例格式 |
| 🔴 4 | 写入后不记录更新日志 |
| 🔴 5 | 近期工作记录超过 7 天不清理 |
