---
description: 指导 AI 管理知识索引和记忆。平台内置记忆用于简洁通用偏好，ki 记忆用于详细项目知识。对话开始时加载 agents-md-init 缓存索引，按需加载 codekb-skill/memory-skill/snippet-memory。覆盖首次引导、自动记录、会话收尾。
alwaysApply: true
enabled: true
updatedAt: 2026-06-23T10:00:00.000Z
provider:
---
# ai-codekb-memory AI 知识与记忆管理规则

> **对话开始时首先检查本规则**。

---

## 📋 AGENTS.md 缓存机制

> **AGENTS.md 是 AI AGENT 的项目记忆文件，位于项目根目录。首次对话时自动缓存索引信息，避免重复查询。**

### 缓存内容

1. **知识库索引**：代码知识库的 scope 列表、Group 结构、热门 Relation
2. **项目记忆索引**：项目记忆的 scope、Group 结构（含通用记忆片段）、热门 Relation
3. **用户画像索引**：用户画像的 Group 结构、热门 Relation
4. **近期工作**：7 天内的工作摘要（从项目记忆中提取）
5. **新需求记录**：简要记录新需求（详细内容存入项目记忆）

> AGENTS.md 的完整格式模板和初始化流程见 `agents-md-init` skill。

---

## 🆕 首次使用引导

> **当 ki 中无任何 scope 或 AGENTS.md 不存在时，AI 应主动引导用户完成初始化。**

```
① ki_manage_index_list → 检测是否有 scope
    ├── 有 scope → 正常走 agents-md-init 初始化 AGENTS.md
    └── 无 scope → 主动提示用户：
        "检测到项目尚未配置知识库索引。是否需要我帮你初始化？"
        用户确认后：
          ② 确定 scope 名称（默认为项目名的小写简写，用户可自定义）
          ③ ki_manage_index_create(scope, name: "项目概述") → 创建代码KB scope
          ④ ki_manage_index_create(scope: "${scope}-memory", name: "背景与目标") → 创建项目记忆 scope
          ⑤ ki_manage_index_create(scope: "user-profile", name: "沟通偏好") → 创建用户画像 scope
          ⑥ 执行 agents-md-init 完整初始化
```

> 若用户暂时不需要，跳过初始化，后续对话中可按需再触发。

---

## 自动缓存规则

### 对话开始时自动执行

> **步骤0：必须加载 `agents-md-init` skill（格式模板和初始化流程）。**
> 若 skill 文件不存在 → 提示用户 "检测到 `agents-md-init` skill 未安装，请先安装 KiSearch"，然后跳过 AGENTS.md 初始化。

1. **检查 AGENTS.md 是否需要初始化**（详见 `agents-md-init` skill）
   - 不存在 → 执行完整初始化
   - 存在但索引章节缺失 → 执行完整初始化
   - 存在且完整 → 检查一致性，不一致则增量更新

2. **检查索引缓存**
   - 若 AGENTS.md 中无"知识库索引"章节 → 执行索引缓存
   - 若已缓存 → 跳过，直接使用缓存

3. **索引缓存流程**（详见 `agents-md-init` skill）
   ```
   ① ki_manage_index_list → 获取所有 scope
   ② 对每个 scope 执行 ki_query_group(mode: "full") → Group 结构
   ③ 对每个 scope 执行 ki_query_group(mode: "hot") → 热门 Relation
   ④ 写入 AGENTS.md（真实数据优先，无数据用示例格式兜底）
   ```

4. **近期工作记录**（详见 `agents-md-init` skill 第5章）
   - 从项目记忆中提取 7 天内工作
   - 超过 1 天未更新则自动刷新

### 索引不一致时自动更新

> **每次创建新索引后，必须自动更新 AGENTS.md 中的缓存。**

触发条件：
- 执行 `ki_manage_index_create` 创建新 Group 后
- 执行 `ki_sync_relation` 写入新 Relation 后
- 发现 AGENTS.md 中的 scope 列表与实际不一致时

更新流程：
```
① 重新执行 ki_manage_index_list → 获取最新 scope 列表
② 对变更的 scope 执行 ki_query_group(mode: "full,hot")
③ 更新 AGENTS.md 中对应的章节
```

### 新需求自动记录

> **当 AI 接受到新需求时，必须自动记录到项目记忆（详细）和 AGENTS.md（简要）。**

触发信号：
- 用户明确说"我需要..."、"帮我实现..."、"做一个...功能"
- 用户提出功能改进、bug 修复、优化建议
- 用户描述工作计划、待办事项

记录流程：
```
① 提取需求描述（1-2句话）
② 写入项目记忆（详细）：
   ki_sync_relation(
     scope: "${scope}-memory",
     group: "最近需求",
     relation: "[YYYY-MM-DD] 需求描述（详细）",
     keywords: ["关键词1", "关键词2"]
   )
③ 写入 AGENTS.md（简要）：
   在"近期工作"章节追加：
   - [YYYY-MM-DD] 需求描述（简要）
④ 刷新 AGENTS.md 缓存
```

### AI 自动记录行为规范

> **AI 必须主动识别并自动记录，不得依赖人工提示或确认。**
> 详细的触发条件表和写入流程见各 skill：`memory-skill`（项目记忆/用户偏好）、`snippet-memory`（代码片段）。

**记录决策速查**：

| 信息类型 | 走哪个 skill | 记录位置 |
|----------|-------------|----------|
| 项目信息/需求/进度/踩坑/用户偏好 | `memory-skill` | `${scope}-memory` 或 `user-profile` |
| 代码要点（工具函数/关键逻辑/核心流程等） | `snippet-memory` | `${scope}-memory` / `通用记忆片段/` |
| AGENTS.md 缓存刷新 | `agents-md-init` | 项目根目录 AGENTS.md |

**自动记录的触发时机**：
1. 对话中识别到上述信号时立即记录
2. 对话结束前检查是否有遗漏需要记录
3. 索引变更后自动更新缓存

**记录优先级**：
- 新需求 > 进度更新 > 项目信息 > 踩坑经验 > 用户偏好
- 同一信息只记录一次，避免重复

---

## 记忆系统分工

| 系统 | 适用 | 典型内容 | 优势 |
|------|------|----------|------|
| **平台内置记忆** (`update_memory`) | 简洁、通用、跨项目、高频、稳定 | 沟通偏好、通用行为规则、工具习惯 | 自动注入上下文，零查询成本 |
| **ki 记忆** (`ki_sync_relation` / MCP) | 详细、项目特定、结构化、有时效 | 项目背景、架构决策、需求进度、代码知识 | Group 树组织、热区/语义检索、归档机制 |

**选择判断**：简洁+通用+跨项目 → 平台记忆；详细/项目特定/有时效/需结构化 → ki 记忆

ki 记忆内部：代码知识 → `codekb-skill`（`${scope}`）；项目上下文/偏好 → `memory-skill`（`${scope}-memory` / `user-profile`）；可复用代码片段 → `snippet-memory` skill（`${scope}-memory` 下 `通用记忆片段/`）

---

## 加载流程

| 步骤 | Skill | 触发条件 |
|------|-------|----------|
| ① | `ki-foundation` | 当需要使用ki记忆工具但不确定用法时加载。不存在则提示安装并停止 |
| ②a | `codekb-skill` | 涉及代码/架构/API **详细**知识时 |
| ②b | `memory-skill` | 涉及项目背景/进度/偏好/用户记忆时 |
| ②c | `snippet-memory` | 涉及代码要点记忆时：工具函数、关键执行逻辑、核心流程、数据模型、API调用等 |

> **`agents-md-init` 为对话开始时必须加载**（见"自动缓存规则"步骤0），不纳入按需选择。

- ②a/②b/②c 可按需选择，但必须在 ① 之后
- 当前会话已加载过的 skill 不重复加载；会话截断后视为未加载

---

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

---

## 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | **将详细项目知识存入平台内置记忆**（代码知识、架构决策等必须走 ki） |
| 🔴 2 | **将简洁通用偏好存入 ki**（沟通语言、通用规则等用平台记忆） |
| 🔴 3 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 4 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 5 | Skill 不存在时仍继续执行 ki 命令（应提示用户安装 KiSearch） |
| 🔴 6 | **对 ki scope 使用 memory MCP 存取**（`user-profile`/`${scope}-memory`/`${scope}` 禁止 `memory_store`/`memory_recall`/`memory_update`/`memory_forget`，统一用 ki MCP 工具） |
| 🔴 7 | **忽略 AGENTS.md 缓存机制**（对话开始时必须检查并更新缓存，索引变更后必须同步更新） |
| 🔴 8 | **依赖人工提示记录需求**（AI 必须主动识别新需求信号并自动记录，不得等待用户提醒） |
| 🔴 9 | **索引变更后不更新缓存**（创建新 Group 或 Relation 后必须立即更新 AGENTS.md） |
| 🔴 10 | **近期工作记录超过 7 天**（超期内容必须归档，保持 AGENTS.md 简洁） |

> 例外：`codekb-skill` 的 `ki_search` 语义兜底不受规则6限制（ki MCP 内置向量工具）。平台内置记忆（`update_memory`）不写入 ki scope，也不受限。

---

## AGENTS.md 维护规范

> 完整维护流程见 `agents-md-init` skill，归档机制见 `memory-skill` 第8章。

### 核心约束
- **文件大小**：控制在 10KB 以内，超过时清理过期内容
- **更新时机**：首次对话 / 索引变更 / 新需求 / 每日检查
- **一致性**：发现不一致自动更新，无需用户确认
- **归档**：超过 7 天的工作记录移动到项目记忆的 archive.md
