---
id: REQ-20260722-001
feature: ki管理命令系列-scope与doc
status: 已确认
created: 2026-07-22
updated: 2026-07-22
version: 1
tags: [feature, cli, management]
depends_on: []
author: AI
document_type: requirement
---

# 需求挖掘报告：ki 管理命令系列（scope / doc）

## 1. 原始需求描述

> ki 新增一个 CLI 系列命令：
> - `ki scope list`
> - `ki scope delete <name> [--yes]`（default 无法删除）
> - `ki scope clear <name> [--yes]`
> - `ki list [--scope <name>] [--limit <n>] [--tags tag1,tag2]`（显示指定 scope 下文档，默认 10 条，tag 默认 ki-search；显示 tag、docid、文档内容等）
> - `ki delete <docid> [--scope] [--yes]`（删除记忆）
>
> 其中 `ki scope list` 需要同步到 MCP 工具，其他的不用。
> "你看看还有什么可以补充的。"

## 2. 需求澄清（已确认决策）

经代码调研与多轮确认，以下决策已全部拍板：

| 决策项 | 结论 |
|--------|------|
| 命名 | 采用名词分组：`ki scope list/delete/clear` + `ki doc list/delete`（原 `ki list`→`ki doc list`，`ki delete`→`ki doc delete`） |
| scope 统一方向 | 不做存储物理合并；`ki scope *` 命令统一作用于 **KB 目录层 + 向量语义层** 两层，成为统一的 scope 生命周期入口 |
| doc list 排序 | 不做排序/范围查询，`--limit N` 返回引擎内部任意顺序的前 N 条 |
| scope 文档数 | 引擎无原生 count，`ki scope list` **不显示**文档数 |
| 内容展示 | `ki doc list` 默认截断预览（前 ~200 字）+ `--full` 看全文 |
| 危险操作护栏 | `doc delete`/`scope delete`/`scope clear` 强制 `--yes`，缺失则拒绝并回显预览 |
| default 保护 | `scope delete default` 拒绝；`scope clear default` 允许 |
| strict 模式 | 允许删除"未注册但向量层有数据"的 scope |
| MCP 同步 | 仅 `ki scope list` 同步为 MCP 工具（`ki_scope_list`），其余不进 MCP |

## 3. 根因分析

### 核心问题
KiSearch 目前只有**写入面**（`store`/`scan-kb`/`sync-relation`）和**检索面**（`search`），缺少**管理/可观测面**——用户无法列举 scope、无法在不写查询词的情况下查看某 scope 存了什么、无法批量清理。

### 根因链
同一个 scope 标识落在**两个存储层**（KB 目录层 + 向量语义层，二者用 `memoryId`/docId 关联），但**没有统一的 scope 生命周期入口** → 两层会漂移（`ki store` 造出无目录的 scope；删目录不删向量）→ 产生孤儿数据且不可见。

### 两层关系（代码事实）
| 层 | 存储内容 | 写入者 |
|----|----------|--------|
| **KB 结构层** `dataDir/{scope}/` | group 树、relations-cache、wiki、原文（供 query-group / get-module-info / wiki-sync） | `scan-kb import`、`sync-relation`、`manage-index` |
| **向量语义层** `kisearch` collection 的 `scope` 字段 | embedding，供语义检索 | `scan-kb import`、`sync-relation`、`store` |

- `scan-kb import` 与 `sync-relation` **两层都写**，且 KB 层 relations-cache 存 `memoryId` 指向向量层 docId——它们是**用 docId 关联的两层**，非独立数据库。
- 仅底层 `ki store` 会"只建向量层"，是漂移的主要来源。

### 方案评估
**判定：对症**。这套命令正是缺失的管理面；约定 `ki scope *` 同时作用两层，恰好成为"统一 scope 生命周期"的落点，从根上治理漂移，且无需冒险合并存储形态。

### 预期效果
- **可观测**：`scope list` 让两层漂移一眼可见；`doc list` 让内容可查。
- **可治理**：`scope delete/clear` 两层原子清理，不再产生孤儿；`doc delete` 精准删单条。
- **副作用可控**：所有破坏性操作强制 `--yes` + 删前预览。

## 4. 需求清单

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|--------|---------|----------|----------|------|----------|
| **P0** | REQ-01 | **scope 统一枚举底座 + `ki scope list`** | 一条命令列出所有 scope，标注每个存在于 KB 层✓/向量层✓ | - | 输出两层并集；每 scope 标注所在层；不显示文档数 |
| **P0** | REQ-02 | **`ki_scope_list` MCP 工具** | AI 经 MCP 获取 scope 清单 | REQ-01 | MCP 返回结构与 CLI 一致 |
| **P0** | REQ-03 | **`ki doc list`** | 无需查询词，列出指定 scope 下文档 | - | `--scope`（default 模式可省）；`--limit`(默认 10)；`--tags`(默认 ki-search，逗号多值→OR)；默认截断预览(~200 字)+`--full`；输出含 docid/tag/内容；顺序不保证 |
| **P1** | REQ-04 | **`ki doc delete <docid...>`** | 精准删一/多条记忆 | - | 支持多 docid；强制 `--yes`；删前 `fetch` 回显 tag+内容预览；缺 `--yes` 拒绝并回显将删项 |
| **P1** | REQ-05 | **`ki scope clear <name>`** | 清空 scope 两层内容、保留 scope | REQ-01 | 强制 `--yes`；两层（KB 目录内容 + 向量文档）一起清；`clear default` **允许**；可选 `--tags` 只清指定 tag；缺 `--yes` 拒绝+预览"将删 N 条" |
| **P1** | REQ-06 | **`ki scope delete <name>`** | 彻底移除 scope（两层 + 配置） | REQ-01 | 强制 `--yes`；删向量文档 + KB 目录 + `config.scopes[name]` 条目；`delete default` **拒绝**；未注册但有数据的 scope 也可删；缺 `--yes` 拒绝+预览 |

### 依赖图
```
REQ-01 (scope 枚举底座 + scope list)
 ├── REQ-02 (MCP: ki_scope_list)
 ├── REQ-05 (scope clear ← 复用枚举+预览)
 └── REQ-06 (scope delete ← 复用枚举+预览)
REQ-03 (doc list)   —— 独立
REQ-04 (doc delete) —— 独立（复用 vectorDelete/fetch）
```

## 5. 关键技术约束（实现须知）
- **向量层 scope 发现**：引擎无 distinct/count API，枚举向量层 scope 需 `listIds(全量)` + `fetch` 读 `scope` 字段去重，受 `listIds` 上限（10000）约束——大库下为"已扫描范围内"的 scope。设计阶段需定策略（全扫 vs 仅校验已知 scope 的向量存在性）。
- **doc list 无序**：引擎无 orderBy / 时间字段，`--limit N` 为任意顺序前 N 条。
- **多 tag 过滤**：filter 支持 `or`，多 tag 编译为 `or(tag==t1, tag==t2)`。
- **向量原语已具备**：`vectorDelete(ids)`、`engine.fetch(ids)`、`engine.listIds(filter,limit)` 均已存在，可直接复用。

## 6. 潜在风险
- ⚠️ **`ki doc delete` 只删向量层**：若该 docid 来自 `scan-kb`/`sync-relation`，KB 层 relations-cache 里的 `memoryId` 会变悬空引用。→ 文档须明确："删关系用 `delete-relation`（联动清理），删裸记忆用 `doc delete`"。
- ⚠️ **`scope delete/clear` 爆炸半径大**：强制 `--yes` + 预览是唯一防线，实现须保证"先预览统计、再执行"，且 default 保护不可绕过。
- ⚠️ **向量库被 MCP 常驻进程持锁**：这些命令走 per-call engine，若 `ki mcp` 在跑会撞锁——复用现有 `ensureVectorAvailable` 的锁提示即可。
