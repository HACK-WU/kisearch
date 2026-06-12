# 知识索引 Skills

> Agent 行为规则与操作指南，按需加载。

## Skills 列表

| Skill | 场景 | 核心能力 |
|-------|------|---------|
| **ki-foundation** | 前置知识（必读） | ki 架构心智模型 + 命令参考 |
| **codekb-skill** | 代码知识库检索/写入 | 四步走查询 + 白名单/黑名单 |
| **memory-skill** | 项目记忆/用户画像读写 | 归档机制 + 自动沉淀 + Group 结构 |

## 使用方式

Agent 加载顺序：

```
1. ki-foundation.md          → 先建立 ki 心智模型
2. codekb-skill.md / memory-skill.md → 按场景加载行为规则
```

```
涉及代码知识 → 加载 codekb-skill
涉及项目记忆/用户偏好 → 加载 memory-skill
```

## 文档总览

### 操作指南（操作流程）

| 文档 | 场景 |
|------|------|
| `docs/build-kb.md` | 首次构建知识索引 |
| `docs/update-kb.md` | 增量更新知识索引 |
| `docs/query-kb.md` | 知识库查询 |
| `docs/manage-index.md` | 索引结构管理 |
| `docs/verify-index.md` | 验证操作结果 |
| `docs/restore-data.md` | 数据恢复 / 重新初始化 |

### Agent 行为规则（决策逻辑）

| 文档 | 覆盖范围 |
|------|----------|
| `docs/codekb-agent-guide.md` | 代码知识库：四步走、白名单/黑名单、memory_recall 兜底、写入 KB 规则 |
| `docs/memory-agent-guide.md` | 记忆系统：归档机制、自动沉淀、Group 结构、用户画像 |
| `docs/ki-command-guide.md` | 公共命令参考：query-group / get-module-info / sync-relation / manage-index |

> `codekb-agent-guide` 和 `memory-agent-guide` 以 `ki-command-guide` 为前置依赖。

### 设计文档（架构与需求）

| 文档 | 内容 |
|------|------|
| `docs/architecture.md` | ki 三层架构、数据结构、运行时链路 |
| `docs/memory-system-requirements.md` | 记忆系统 REQ-01~16 |
| `docs/memory-system-dataflow.md` | 数据流图 |
| `docs/workflows.md` | 工作流设计 |
| `docs/error-handling.md` | 错误处理策略 |
| `docs/import-kb.md` | 批量导入规范 |
| `docs/cli.md` | CLI 接口文档 |
| `docs/scan-kb.md` | scan-kb 子命令详解 |
| `docs/backup-restore.md` | 备份与恢复 |

## 三层架构基础

所有 skill 共享的三层文件系统：

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Group 树索引 (group-index.json)          │
│  - 层级导航：项目根 → 子Group → ...                 │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Relations 缓存 (relations-cache.json)    │
│  - 热门 Relation 列表 + 评分 + 冷热分区             │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: 本地 KB (index.json)                     │
│  - Markdown 模块信息全文                            │
└─────────────────────────────────────────────────────┘
```

## MCP 工具配合

所有 skill 需要配合父项目的 MCP 工具：

| MCP 工具 | 使用场景 |
|---------|---------|
| `memory_recall` | 检索路径：语义检索 |
| `memory_store` | 向量化摘要 |
| `memory_forget` | 删除记忆 |

## 相关目录

| 目录 | 用途 |
|------|------|
| `skills/` | 本目录，Agent 加载的 skill 文件 |
| `docs/` | 所有文档（操作指南 + 行为规则 + 设计文档） |
| `scripts/` | 辅助脚本 |
| `test/` | 测试覆盖 |
