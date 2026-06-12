# skill-load-guide SKILL 加载引导规则

> **对话开始时首先检查本规则**。指导 AI 何时、以何种顺序加载 knowledge-indexer 的 SKILL。

---

## 加载流程

```
对话涉及项目？
  ├─ 否 → 不加载
  └─ 是 → 已加载过 ki-foundation？
      ├─ 是（当前会话）→ 直接用，跳过
      └─ 否 → scope 已知？
          ├─ 否 → 问用户 → 得到后继续
          └─ 是 → 按顺序加载 ↓
              └─ SKILL 文件不存在？→ 停止，提示用户 ↓
```

**加载顺序（严格顺序，不可跳过）**：

| 步骤 | 文件 | 触发条件 |
|------|------|----------|
| ① | `skills/ki-foundation.md` | **必读前置**，涉及项目知识时必须先读 |
| ② | `skills/codekb-skill.md` | 涉及代码/架构/API 等代码知识时加载 |
| ③ | `skills/memory-skill.md` | 涉及项目背景/进度/偏好等上下文时加载 |

> ② 和 ③ 可按需选其一或两者并行，但都必须在 ① 之后。
>
> "已加载过"指当前会话上下文中 AI 已读取并理解该文件。会话截断后视为未加载。

## SKILL 文件缺失处理

**加载前必须确认文件存在**。若目标 SKILL 文件不存在：

1. **立即停止加载流程**
2. **提示用户**：
   > 未找到 `{文件名}`，请确认 knowledge-indexer/skills/ 目录下是否已创建该文件。
3. **不执行任何 ki 命令**（无行为规则指导时禁止操作）

> `ki-foundation.md` 是所有 skill 的前置依赖。若此文件缺失，整个知识索引功能不可用。

## 加载后自动动作

SKILL 加载完成后，按其内部定义的触发条件执行：

- `codekb-skill` → 若为理解级查询，自动拉取全景 (`ki query-group --mode full`)
- `memory-skill` → 若 scope 已知，自动召回项目记忆 + 用户画像全景

## 禁忌

| # | 红线 |
|---|------|
| 🔴 1 | 跳过 ki-foundation 直接加载 codekb-skill / memory-skill |
| 🔴 2 | `${scope}` 未确认就加载 SKILL 或执行 ki 命令 |
| 🔴 3 | 无关对话中强制加载 SKILL（浪费上下文） |
| 🔴 4 | SKILL 文件不存在时仍继续执行 ki 命令 |
