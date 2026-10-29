# Agent 集成：Skill 与 Rule

kisearch 面向 AI Agent 提供三类资产：**检索 Skill**、**记忆行为规则**、**外部配套 Skill**。

| 资产 | 位置 | 作用 |
|---|---|---|
| `ki-search` | [`skills/ki-search/SKILL.md`](../skills/ki-search/SKILL.md) | 代码知识库检索/写入：四步走查询 + 白名单/黑名单 |
| 记忆行为总控 | [`rules/ai-codekb-memory.md`](../rules/ai-codekb-memory.md) | 自动沉淀 + 查询三步走 + 归档 + 代码片段记忆 + 禁忌 |
| `ki-search-first` | [HACK-WU/skills](https://github.com/HACK-WU/skills/tree/master/skills/ki-search-first) | 所有任务的记忆前置：先查项目记忆，再进入代码/专家/解决方案路径 |
| `ki-memory-lookup` | [HACK-WU/skills](https://github.com/HACK-WU/skills/tree/master/skills/ki-memory-lookup) | 只读查询 SSOT，按记忆类型选择目录导航或语义检索 |
| `ki-memory-write` | [HACK-WU/skills](https://github.com/HACK-WU/skills/tree/master/skills/ki-memory-write) | 统一查重、格式校验、双写、刷新、校验与结账删除 |

> 加载顺序与使用规则见 [`rules/ai-codekb-memory.md`](../rules/ai-codekb-memory.md)。

## 工作流：先查、再判断、后写入

```text
ki-search-first
        ↓
ki-memory-lookup（按需查询既有记忆）
        ↓
完成分析或提炼记忆内容
        ↓
ki-memory-write（查重后写入并校验）
```

1. **`ki-search-first`：任何任务先查记忆**
   - 先查项目已有记忆，再决定是否需要读代码、查专家资产或查解决方案。
   - 已定位到要修改的代码时，额外查强关联，确认改动会牵动哪些模块。
   - 记忆不可用或没有命中时降级继续，不阻塞主任务；但「没有命中」不等于「项目中不存在」。

2. **`ki-memory-lookup`：查询只读，按记忆类型选路径**
   - 专题记忆、接口信息、数据流、错误库优先用语义检索；查询带上功能模块名与关键代码符号。
   - 强关联、决策记忆、待生效变更优先用 `ki_group_list` 目录导航；要列全量时用 `mode="full"`。
   - 同一 Group 读多条时用 `ki_get_module_info` 的 `relations` 数组（≤10 条），逐条核对返回。
   - 只负责查询；与代码实际不一致时，以代码为准。

3. **`ki-memory-write`：统一写入，避免记忆退化**
   - 写入前先查重：同一 Group 下已有相同 Relation 时更新，不重复创建。
   - 持久化记忆统一用 `ki_sync_relation` / `ki_bulk_sync_relation`，不要用只写向量层的 `ki_store` / `ki_bulk_store`。
   - 内容用纯文本描述与列表，不放 YAML frontmatter、Markdown 标题或表格；需要语义召回时，关键词必须是正文中真实出现的自然语言词汇。
   - 写入后刷新 Group 视图并抽查落盘结果；`vector=false` 只用于待生效变更台账（经目录查询，不依赖语义检索）。
   - `ki_delete_relation` 仅在明确要求遗忘时使用；其余情况优先覆盖更新。待生效变更在正式落地后再结账删除。

> 建议写入：稳定的项目约定、历史决策、接口信息、数据流、错误解法、跨模块关联。不要写入：一次性诊断、短期上下文、未经确认的推测。

## 安装

**本仓库的 Skill**（基于 [`HACK-WU/skills`](https://github.com/HACK-WU/skills) 的 `skill-install.sh`，用 `--repo` 指定本仓库）：

```bash
# 安装本仓库全部 skill
curl -fsSL https://raw.githubusercontent.com/HACK-WU/skills/master/scripts/skill-install.sh | \
  bash -s -- --repo HACK-WU/kisearch -t /path/to/your-project

# 只安装指定 skill（如 ki-search）
curl -fsSL https://raw.githubusercontent.com/HACK-WU/skills/master/scripts/skill-install.sh | \
  bash -s -- --repo HACK-WU/kisearch -n ki-search -t /path/to/your-project
```

**三个 ki 配套 Skill**：

```bash
curl -fsSL https://raw.githubusercontent.com/HACK-WU/skills/master/scripts/skill-install.sh | \
  bash -s -- --repo HACK-WU/skills \
  -n ki-search-first,ki-memory-lookup,ki-memory-write \
  -t /path/to/your-project
```

> 安装器基于 `npx skills`（需 Node.js ≥ 22），使用管理源 `~/.hackwu-skills/` 持续跟踪，支持 `update` / `remove` / `list`。

**Rules**（安装器目前只支持 Skills，Rules 需手动放置）：

```bash
mkdir -p /path/to/your-project/rules
curl -fsSL https://raw.githubusercontent.com/HACK-WU/kisearch/master/rules/ai-codekb-memory.md \
  -o /path/to/your-project/rules/ai-codekb-memory.md
```

> 存量用户迁移：旧版 `ki setup` 使用 `~/.ki-targets`，现已由安装器的 `~/.skill-targets`（或当前目录 `./.skill-targets`）取代，旧配置不再生效；如需保留原目标列表，请迁移到新文件。

## 相关文档

- [mcp-tools.md](./mcp-tools.md) —— 工具参数
- [mcp-http.md](./mcp-http.md) —— 接入方式与鉴权
- [codekb-agent-guide.md](./codekb-agent-guide.md) —— Agent 检索/写入行为规则
- [ki-command-guide.md](./ki-command-guide.md) —— Agent 常用命令语法
