---
description: 指导 AI 管理知识索引和记忆。平台内置记忆用于简洁通用偏好，ki 记忆用于详细项目知识。强制加载 ki-foundation，按需选择 codekb-skill / memory-skill。
alwaysApply: true
enabled: true
updatedAt: 2026-06-13T17:10:00.000Z
provider:
---
# ai-codekb-memory AI 知识与记忆管理规则

> **对话开始时首先检查本规则**。指导 AI 如何选择记忆存储位置、加载 skill、执行检索策略。

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
```

---

## 记忆系统分工策略

AI 拥有两套记忆系统，各有适用场景，**根据信息特征选择存储位置**：

### 平台内置记忆（update_memory / search_memory）

**适用：简洁、通用、跨项目、每次对话都需要的信息。**

| 特征 | 说明 |
|------|------|
| **简洁** | 一两句话能表达清楚 |
| **通用** | 不依赖特定项目，跨项目适用 |
| **高频** | 几乎每次对话都需要 |
| **稳定** | 很少变化，一旦记住长期有效 |

**典型内容**：
- 用户沟通偏好（"用中文回复"、"简洁直接"）
- 通用行为规则（"不要擅自提交代码"）
- 工具使用习惯（"使用 vim 键位"）

**优势**：自动注入上下文（`<memory_overview>` / `<user_preference_memory>`），零查询成本。

### ki 记忆（memory-skill / codekb-skill）

**适用：详细、项目特定、结构化、有时效性的信息。**

| 系统 | 说明 | 接口 |
|------|------|------|
| **ki 命令** | knowledge-indexer CLI | `ki sync-relation`、`ki query-group`、`ki search`、`ki store` |
| **memory MCP 服务** | memory-lancedb-mcp | `memory_recall`、`memory_store` |
| **mem CLI** | memory-lancedb-mcp 命令行 | `mem search`、`mem store` |

> 以上三套本质是同一套 memory-lancedb-mcp 体系，**均可正常使用**。

**典型内容**：
- 项目背景、技术栈选型、架构决策（详细、项目特定）
- 需求进度、踩坑经验（有时效性、需要归档）
- 代码知识：模块职责、API 接口、设计约束（结构化、需要 Group 树组织）

**优势**：Group 树结构化组织、热区/语义检索、Scope 隔离、归档机制。

### 选择判断

```
需要记住一条信息？
  ├─ 简洁 + 通用 + 跨项目 + 每次都需要 → 平台内置记忆
  └─ 详细 / 项目特定 / 有时效 / 需结构化 → ki 记忆
      ├─ 代码知识（模块/API/架构）→ codekb-skill（scope: ${scope}）
      └─ 项目上下文/用户偏好（详细）→ memory-skill（scope: ${scope}-memory / user-profile）
```

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
| 🔴 1 | **将详细项目知识存入平台内置记忆**（代码知识、架构决策、项目背景等必须走 ki） |
| 🔴 2 | **将简洁通用偏好存入 ki**（沟通语言、通用行为规则等应该用平台内置记忆） |
| 🔴 3 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 4 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 5 | Skill 不存在时仍继续执行 ki 命令 |
| 🔴 6 | **对用户画像和项目记忆使用 memory MCP 存取**（`memory_store`/`memory_recall`/`memory_update`/`memory_forget`） |

---

## 🔴 规则 6 详解：ki scope 禁用 memory MCP

`user-profile`、`${scope}-memory`、`${scope}` 三个 scope 由 ki 管理，**禁止通过 memory MCP / mem CLI 直接操作**（写入、查询、更新、删除均不可）。统一使用 `ki query-group` / `ki get-module-info` / `ki sync-relation` / `ki manage-index` 代替。

> 例外：`codekb-skill` 四步走第④步的 `ki_search` 语义兜底不受此限制（`ki_search` 是 ki MCP 内置向量工具，非 memory MCP）。平台内置记忆（`update_memory`）不写入 ki scope，也不受此限制。
