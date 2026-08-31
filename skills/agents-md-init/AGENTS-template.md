---
name: agents-md-template
description: AGENTS.md 的标准格式模板。包含项目记忆索引（${scope}-memory）、团队约定（同步 ${scope}-memory「团队约定」Group，空则写"无"）、用户画像与近期工作（均直接存储）、更新日志等章节的结构与占位说明。当初始化或更新 AGENTS.md 文件、需要确认 AGENTS.md 章节结构时使用。
---

# AGENTS.md - AI AGENT 项目记忆文件

> **本文件由 AI AGENT 自动维护，用于缓存项目记忆索引（`${scope}-memory`）、存储用户画像、记录近期工作与进度、跟踪新需求。**
>
> **代码知识库（`${scope}`）索引不写入本文件**，查询代码知识时直接使用 `ki-search` 访问 ki。

---

## 项目记忆索引

> 从 ki 的 `${scope}-memory` scope 获取真实数据填充；Group 缺失时按下方清单补建。代码知识库 `${scope}` 的索引不缓存于此。

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

## 团队约定

> **同步源**：ki `${scope}-memory` → 「团队约定」Group（`ki_query_group(scope: "${scope}-memory", groups: "团队约定", mode: "full")`）。
> **本节为缓存**：权威数据在 ki，此处只做占位同步，便于 agent 免查询直接获取。
> **无内容时必须写 `无`**，禁止留空或删除本节；写入 ki 后须回刷本节。
> **写入方向**：先 `ki_sync_relation(scope: "${scope}-memory", group: "团队约定", ...)`，再把要点回刷到本节。

- 无

<!-- 有约定时逐条列：`- {Relation 名}: {一句话要点}`；最后同步日期: YYYY-MM-DD -->

---

## 用户画像

> **用户画像直接存储于本文件，不写入 ki 记忆。**
> 按维度维护，每个维度一个小节，内容为用户偏好的事实描述（1-3 条，简洁明确）。

### 沟通偏好

- 回复风格: {如"简洁直接"、"结构化输出"}
- 语言偏好: {如"中文"}

### 代码风格

- {如"命名用 camelCase"、"偏好函数式写法"}

### 工具链

- {如"编辑器 VSCode"、"包管理 pnpm"}

### 技术背景

- {如"熟悉 TypeScript/React"、"擅长后端架构"}

### 工作习惯

- {如"先设计后编码"、"要求单测覆盖"}

### 对话习惯

- {如"喜欢列点回答"、"对 AI 的要求"}

> **新增维度**：发现以上维度无法覆盖的偏好时，直接新增小节，命名保持"4-8 字名词短语"。

---

## 近期工作 (7天内)

> **近期工作（最近需求/进度）直接存储于本文件，不写入 ki 记忆（不使用"最近需求"/"进度" Group）。**
> 超过 7 天的已完成条目移入项目根目录 `archive.md`（进行中进度永久保留）。

### 最近需求

- [YYYY-MM-DD] {需求描述（1-2 句话）}

### 进度

- 进行中: [YYYY-MM-DD] 🔄 {描述}
- 已完成: [YYYY-MM-DD] ✅ {描述}

---

## 更新日志

> 每次修改本文件后追加一条记录，保留最近 10 条。

| 日期 | 更新内容 |
|------|----------|
| YYYY-MM-DD | {更新说明} |
