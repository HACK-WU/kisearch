# ai-codekb-memory AI 知识与记忆管理规则

> **对话开始时首先检查本规则**。指导 AI 如何管理知识索引和记忆：禁用内置记忆、加载 skill、选择存储与检索策略。

---

## 📋 已知 Scope 清单（请填写）

> **告诉 Agent 当前项目有哪些 scope，避免每次对话都执行 `ki manage-index --action list-scopes` 重复查询。**
>
> 如果以下清单为空或已过期，Agent 会自动执行 `list-scopes` 获取最新列表。

```
# 请在此处列出项目当前的 scope（每行一个），例如：
# monitor          — BK-Monitor 代码知识库
# monitor-memory   — BK-Monitor 项目记忆
# user-profile     — 用户画像（全局固定）
#
# TODO: 请填写你项目当前的 scope →
#
```

---

## 🔴 强制规则：禁用平台原生内置记忆

**禁止使用 AI 平台原生自带的内置记忆系统存储任何信息。**

### 什么是"平台原生内置记忆"？

指 AI 平台自身捆绑的、非用户配置的简单 KV 记忆机制。不同平台名称不同：
CodeBuddy 的 `update_memory`、Cursor 的 `memory_store`、Claude 的 `remember`、
Qoder 的 `search_memory`（读接口）/ `update_memory`（写接口）等。

特征：**平台内置、非用户配置、无语义检索、无结构化组织、不可备份恢复**。

### ✅ 允许使用的记忆系统（不在禁止范围内）

| 系统 | 说明 | 接口示例 |
|------|------|---------|
| **memory MCP 服务** | 用户自行配置的 memory-lancedb-mcp 服务 | `memory_recall`、`memory_store` |
| **ki 命令** | knowledge-indexer CLI | `ki sync-relation`、`ki query-group` |
| **mem CLI** | memory-lancedb-mcp 命令行 | `mem search`、`mem store`、`mem bulk-store` |

> 以上三套系统本质是同一套 memory-lancedb-mcp 体系，**均可正常使用**。

### 禁止 vs 允许对照

| 禁止（平台原生） | 允许（用户配置的 memory 体系） |
|---------|---------|
| ❌ `search_memory`（Qoder 内置读接口） | ✅ `memory_recall`（MCP）/ `mem search`（CLI）/ `ki query-group` |
| ❌ `update_memory`（Qoder/CodeBuddy 内置写接口） | ✅ `memory_store`（MCP）/ `mem store`（CLI）/ `ki sync-relation` |
| ❌ 平台原生记忆接口更新（update/modify） | ✅ `memory_update`（MCP）/ `ki sync-relation` 覆盖更新 |
| ❌ 平台原生记忆接口删除（delete/remove/forget） | ✅ `memory_forget`（MCP）/ `ki manage-index --action delete` |
| ❌ 依赖平台自动注入的记忆上下文（`<memory_overview>`） | ✅ `memory_recall`（MCP）/ `mem search`（CLI）/ `ki query-group` 主动检索 |

> 原因：平台原生记忆无语义检索、无结构化组织、无 Scope 隔离、不可备份恢复。用户配置的 memory 体系提供向量检索、Group 树、冷热分级、批量操作等完整能力。

---

## 加载流程

```
对话开始
  └─ 已加载过 ki-foundation？
      ├─ 是（当前会话）→ 直接用，跳过
      └─ 否 → Skill(skill="ki-foundation")  ← 无条件加载，不管是否涉及项目
          └─ Skill 不存在？→ 停止，提示用户安装

ki-foundation 加载后，按需选择 ↓
  ├─ 涉及代码详细知识（函数、类、API、架构）→ Skill(skill="codekb-skill")
  └─ 涉及简单项目知识、用户记忆、偏好 → Skill(skill="memory-skill")
```

**加载顺序（严格顺序，不可跳过）**：

| 步骤 | Skill | 加载方式 | 触发条件 |
|------|-------|----------|----------|
| ① | `ki-foundation` | `Skill(skill="ki-foundation")` | **无条件加载**，对话开始即执行 |
| ②a | `codekb-skill` | `Skill(skill="codekb-skill")` | 涉及代码/架构/API **详细**知识时加载 |
| ②b | `memory-skill` | `Skill(skill="memory-skill")` | 涉及项目背景/进度/偏好/用户记忆等上下文时加载 |

> ②a 和 ②b 可按需选其一或两者并行，但都必须在 ① 之后。
>
> **选择依据**：
> - 需要**看代码、理解函数调用、查 API 签名** → `codekb-skill`
> - 需要**记一条偏好、查项目决策、找历史背景** → `memory-skill`
>
> "已加载过"指当前会话上下文中 AI 已通过 Skill 工具加载该 skill。会话截断后视为未加载。
>
> **跨平台 Skill 加载工具对照**：
> - **Qoder**：`Skill(skill="ki-foundation")`
> - **CodeBuddy**：`use_skill("ki-foundation")`
>
> AI 应根据当前运行平台选择对应工具，无需从文件路径读取。

## SKILL 缺失处理

**调用 Skill 工具前必须确认 skill 已安装**（Qoder 用 `Skill`，CodeBuddy 用 `use_skill`）。若 skill 不存在：

1. **立即停止加载流程**
2. **提示用户**安装 knowledge-indexer：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/HACK-WU/knowledge-indexer/master/scripts/install.sh | bash -s -- "$(pwd)" --skills --rules
   ```
3. **不执行任何 ki 命令**（无行为规则指导时禁止操作）

> `ki-foundation` 是所有 skill 的前置依赖。若此 skill 不存在，整个知识索引功能不可用。

## 加载后自动动作

SKILL 加载完成后，按其内部定义的触发条件执行：

- `codekb-skill` → 若为理解级查询，自动拉取全景 (`ki query-group --mode full`)
- `memory-skill` → 若 scope 已知，自动召回项目记忆 + 用户画像全景

## 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | **使用平台原生内置记忆**（非用户配置的 KV 记忆，统一用 memory MCP / ki / mem 替代） |
| 🔴 2 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 3 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 4 | Skill 不存在时仍继续执行 ki 命令 |
| 🔴 5 | **对用户画像和项目记忆使用 memory MCP 存取**（`memory_store`/`memory_recall`/`memory_update`/`memory_forget`） |

---

## 🔴 规则 5 详解：用户画像 & 项目记忆 — 仅用 ki，禁用 memory MCP

**适用范围**：`user-profile`（用户画像）和 `${scope}-memory`（项目记忆）两个 scope。

**禁止行为**：

| 禁止 | 说明 |
|------|------|
| ❌ `memory_store` → `user-profile` / `${scope}-memory` | 禁止通过 MCP 写入用户画像或项目记忆 |
| ❌ `memory_recall` → `user-profile` / `${scope}-memory` | 禁止通过 MCP 查询用户画像或项目记忆 |
| ❌ `memory_update` → `user-profile` / `${scope}-memory` | 禁止通过 MCP 更新这两类 scope |
| ❌ `memory_forget` → `user-profile` / `${scope}-memory` | 禁止通过 MCP 删除这两类 scope |
| ❌ `mem store/search` → 上述 scope | 同样禁止 mem CLI 操作这两类 scope |

**必须使用 ki 命令代替**：

| 操作 | memory MCP（禁止） | ki 命令（必须） |
|------|-------------------|----------------|
| 查询全景 | ❌ `memory_recall` | ✅ `ki query-group --scope user-profile --mode full` |
| 查热门/热区 | ❌ `memory_recall` | ✅ `ki query-group --scope user-profile --groups "G" --mode hot` |
| 读取原文 | ❌ `memory_recall` | ✅ `ki get-module-info --scope user-profile --group "G" --relation "R"` |
| 写入/更新 | ❌ `memory_store` | ✅ `ki sync-relation --scope user-profile --group "G" --relation "R" --module-info "..."` |
| 删除条目 | ❌ `memory_forget` | ✅ `ki manage-index --scope user-profile --action delete --force` |

**原因**：用户画像和项目记忆是**纯文本结构化知识**，不依赖向量检索。ki 的 Group 树 + 热区分级 + 关键词词云足以高效命中。使用 memory MCP 反而引入不必要的语义搜索开销，且容易与代码知识库的向量数据混淆。

> ⚠️ **代码知识库**（如 `monitor`）不受此限制：`memory_recall` 仍可作为四步走流程中的语义兜底步骤使用。
