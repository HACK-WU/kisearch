# skill-load-guide SKILL 加载引导规则

> **对话开始时首先检查本规则**。指导 AI 何时、以何种顺序加载 knowledge-indexer 的 SKILL 文件。

---

## 1. 加载时机

**每次新对话开始时**，AI 必须执行以下检查：

```
当前会话是否已加载 ki-foundation.md？
  ├─ 否 → 执行 §2 加载流程
  └─ 是 → 跳过加载，直接使用已缓存的知识
```

> "已加载" 指的是：AI 在当前会话上下文中已经读取并理解了 `ki-foundation.md` 的内容。
> 如果会话上下文因长度限制被截断，视为"未加载"，需重新执行。

---

## 2. 加载流程

### Step 0: 判断是否需要加载

以下情况**不需要**加载任何 SKILL：

- 用户问题与项目代码/知识库无关（闲聊、纯通用问题）
- 用户明确表示不使用知识索引功能

以下情况**必须**加载：

| 触发信号 | 需要加载的 Skill |
|----------|------------------|
| 用户提到项目代码、模块、架构、API 等 | `ki-foundation` → `codekb-skill` |
| 用户提到项目背景、进度、偏好等上下文信息 | `ki-foundation` → `memory-skill` |
| 无法确定但可能涉及项目知识 | 至少加载 `ki-foundation` |

### Step 1: 加载前置知识（必读）

```bash
# 读取文件
knowledge-indexer/skills/ki-foundation.md
```

**加载后确认**：AI 必须在内部确认已理解以下内容：

- [ ] ki 的三层架构（Group 树 → Relations 缓存 → 本地 KB）
- [ ] 核心命令语法（query-group / get-module-info / sync-relation / manage-index）
- [ ] Scope 替换表（codekb 用 `${scope}`，memory 用 `${scope}-memory` / `user-profile`）
- [ ] Keywords 规则（自然语言词汇、3~5 个、必须在原文中出现）

### Step 2: 按场景加载行为规则

根据对话内容选择其一或两者：

```
涉及代码知识？
  ├─ 是 → 加载 knowledge-indexer/skills/codekb-skill.md
  └─ 否 → 跳过

涉及项目记忆/用户画像？
  ├─ 是 → 加载 knowledge-indexer/skills/memory-skill.md
  └─ 否 → 跳过
```

**两者可并行加载**，无先后依赖关系。

---

## 3. Scope 确认

加载任何 SKILL 前的**硬性前提**：

```
${scope} 已知？
  ├─ 是 → 继续加载
  └─ 否 → 暂停，询问用户：
      > 我需要操作知识库，请指定本次使用的 scope。
      > （如 monitor、my-project 等项目标识符）
```

> **禁止**在 `${scope}` 未确认时读取任何 SKILL 或执行任何 ki 命令。

Scope 来源优先级：

1. 用户在对话中明确指定
2. 项目配置 / 环境变量
3. 向用户询问获取

---

## 4. 加载后动作

SKILL 加载完成后，按各 SKILL 内部定义的触发条件自动执行：

| SKILL | 加载后自动动作 |
|-------|---------------|
| `codekb-skill` | 若为理解级查询 → 自动拉取全景 (`ki query-group --mode full`) |
| `memory-skill` | 若 scope 已知 → 自动召回项目记忆 + 用户画像全景 |

---

## 5. 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | 跳过 `ki-foundation` 直接加载 `codekb-skill` / `memory-skill` |
| 🔴 2 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 3 | 在无关对话中强制加载 SKILL（造成不必要的上下文开销） |
| 🔴 4 | 加载 SKILL 后未执行其定义的初始化动作（如拉取全景） |

---

## 6. 快速判定速查

```
用户消息 → 是否涉及项目？
  ├─ 否 → 不加载
  └─ 是 → scope 已知？
      ├─ 否 → 问用户 → 得到 scope → 加载 ki-foundation → 按场景加载 skill
      └─ 是 → 加载 ki-foundation → 按场景加载 skill
```

---

> 本规则是所有 SKILL 的入口调度层。AI 在首次接触 knowledge-indexer 功能时应最先读取此文件。
