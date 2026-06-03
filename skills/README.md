# 知识索引 Skills

> 按场景拆分的知识索引操作指南，Agent 按需加载。

## Skills 列表

| Skill | 场景 | 频率 | 核心能力 |
|-------|------|------|---------|
| **knowledge-index-build** | 首次构建知识索引 | 低（项目初始化） | S-04 统一 2 步导入流程 |
| **knowledge-index-update** | 增量更新知识索引 | 中（文档迭代） | diff 检测 → 3 步增量更新 |
| **knowledge-index-query** | 知识库查询 | 高（日常） | 快速路径 + 检索路径 + 知识缺失路径 |
| **knowledge-index-manage** | 索引结构管理 | 低（手动操作） | Group/Relation CRUD |
| **knowledge-index-verify** | 验证操作结果 | 中（操作后） | 结构/内容/检索验证 |
| **knowledge-index-restore** | 数据恢复 | 低（异常时） | 从备份恢复 / 重新初始化 |

## 使用方式

Agent 根据用户请求自动加载对应的 skill：

```
首次构建知识库 → 加载 knowledge-index-build
增量更新知识库 → 加载 knowledge-index-update
用户提问 → 加载 knowledge-index-query
用户请求创建/删除Group → 加载 knowledge-index-manage
验证操作结果 → 加载 knowledge-index-verify
数据恢复/重新初始化 → 加载 knowledge-index-restore
```

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

| MCP 工具 | 使用场景 | Skill |
|---------|---------|-------|
| `memory_recall` | 检索路径：语义检索 | query |
| `memory_store` | 向量化摘要 | build, update |
| `memory_forget` | 删除记忆 | update |

## 目录结构

```
knowledge-indexer/skills/
  ├── knowledge-index-build/
  │   └── SKILL.md
  ├── knowledge-index-update/
  │   └── SKILL.md
  ├── knowledge-index-query/
  │   └── SKILL.md
  ├── knowledge-index-manage/
  │   └── SKILL.md
  ├── knowledge-index-verify/
  │   └── SKILL.md
  ├── knowledge-index-restore/
  │   └── SKILL.md
  └── README.md
```

## 相关文档

- 设计文档：`docs/`（S-01~S-06）
- 脚本目录：`scripts/`
- 测试覆盖：`test/`
- 知识索引总览：`README.md`
- scan-kb 子命令详解：`docs/scan-kb.md`
