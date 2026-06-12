# 记忆系统数据流图

> 状态：草案
> 创建时间：2026-06-12

## 1. 场景类型

```
📊 场景类型
━━━━━━━━━━━━━━━━

主要场景：简单 CRUD

涉及的数据操作：
| 操作 | 数据实体 | 场景类型 | 说明 |
|------|----------|----------|------|
| 写入项目记忆 | Relation + KB | 简单 CRUD | ki sync-relation 单条写入 |
| 批量导入项目记忆 | Relation + KB | 简单 CRUD | ki scan-kb import 批量写入 |
| 读取项目记忆 | Relation + KB | 简单 CRUD | ki get-module-info 读取原文 |
| 写入用户画像 | Relation + KB | 简单 CRUD | ki sync-relation 单条写入 |
| 读取用户画像 | Relation + KB | 简单 CRUD | ki get-module-info 读取原文 |
| 更新记忆 | Relation + KB | 简单 CRUD | 重新 sync-relation 覆盖 |
| 删除记忆 | Relation + KB | 简单 CRUD | ki manage-index delete |
```

**说明**：单用户操作，无并发冲突，单机部署，数据量级低。

---

## 2. 实体清单

```
📦 核心实体
━━━━━━━━━━━━━━━━

| 实体 | 说明 | 存储位置 | 来源 |
|------|------|----------|------|
| Scope | 作用域，区分项目/用户画像 | group-index.json | 系统定义 |
| Group | 知识分组，树形结构 | group-index.json | 用户/AI 创建 |
| Relation | 知识条目，挂在 Group 下 | relations-cache.json + KB | AI 沉淀 |
```

---

## 3. ER 图

```mermaid
erDiagram
    SCOPE ||--o{ GROUP : "包含"
    GROUP ||--o{ RELATION : "包含"

    SCOPE {
        string name PK "作用域名称（如 monitor-memory）"
        string type "类型：project-memory / user-profile"
        datetime created_at "创建时间"
    }

    GROUP {
        string id PK "Group 唯一标识"
        string scope FK "所属 scope"
        string path "完整路径（如 背景与目标）"
        string parent_path "父 Group 路径"
        float score "热度分数"
        datetime updated_at "最后更新时间"
    }

    RELATION {
        string id PK "Relation 唯一标识"
        string group_id FK "所属 Group"
        string name "Relation 名称"
        string summary "一句话摘要"
        string keywords "关键词（逗号分隔）"
        int use_count "使用次数"
        datetime last_used "最后使用时间"
    }
```

---

## 4. 数据流图

### 4.1 整体数据流

```mermaid
flowchart TB
    User[用户] -->|对话| AI[AI Agent]
    
    AI -->|写入项目记忆| KI_SYNC[ki sync-relation]
    AI -->|写入用户画像| KI_SYNC
    
    KI_SYNC -->|创建| RC[Relations 缓存]
    KI_SYNC -->|创建| KB[本地 KB]
    KI_SYNC -->|创建| GI[Group 索引]
    
    AI -->|查询热区| KI_QUERY[ki query-group]
    KI_QUERY -->|读取| GI
    KI_QUERY -->|读取| RC
    
    AI -->|取原文| KI_GET[ki get-module-info]
    KI_GET -->|读取| KB
```

### 4.2 数据流说明

| 流向 | 触发条件 | 操作 | 数据变化 | 备注 |
|------|----------|------|----------|------|
| AI → ki sync-relation | 对话中发现项目知识/用户偏好 | C | 新增 Relation + KB 原文 | 自动沉淀或用户明确告知 |
| AI → ki query-group | 对话开始或需要查询 | R | 读取 Group 树 + 热区 | 优先本地热区 |
| AI → ki get-module-info | 热区命中后取原文 | R | 读取 KB 原文 | 提炼后回答 |

---

## 5. 自动沉淀流程

```mermaid
flowchart LR
    D[对话内容] --> P{AI 识别<br/>关键信息?}
    P -- 否 --> E[继续对话]
    P -- 是 --> T{信息类型}
    T -- 项目记忆 --> S1[ki sync-relation<br/>scope: ${scope}-memory]
    T -- 用户画像 --> S2[ki sync-relation<br/>scope: user-profile]
    S1 --> E
    S2 --> E
```

---

## 6. 查询流程

### 6.1 项目记忆查询流程

```mermaid
flowchart TD
    A[用户提问] --> B{能否从缓存<br/>定位 Group?}
    B -- 否 --> C[ki query-group --mode full<br/>scope: ${scope}-memory]
    C --> B
    B -- 是 --> D[ki query-group --groups G<br/>--mode hot,emerging]
    D --> E{命中 relation?}
    E -- 是 --> F[ki get-module-info<br/>取原文]
    F --> G[提炼回答]
    G --> H[结束]
    E -- 否 --> L[回问用户或使用默认回答]
    L --> H
```

### 6.2 用户画像查询流程

```mermaid
flowchart TD
    A[需要用户偏好] --> B[ki query-group --scope user-profile<br/>--groups 相关Group --mode hot,emerging]
    B --> C{命中 relation?}
    C -- 是 --> D[ki get-module-info<br/>取原文]
    D --> E[应用偏好]
    E --> F[结束]
    C -- 否 --> J[使用默认行为]
    J --> F
```

---

## 7. 存储结构

### 7.1 文件结构

```
knowledge-indexer/kb/
├── ${scope}/                    # 代码知识库
│   ├── group-index.json
│   ├── relations-cache.json
│   └── {Group}/index.json
│
├── ${scope}-memory/             # 项目记忆
│   ├── group-index.json
│   ├── relations-cache.json
│   └── {Group}/
│       ├── index.json           # 内容稳定的 Group（单文件）
│       ├── active.md            # 内容动态的 Group（当前活跃内容）
│       └── archive.md           # 内容动态的 Group（归档内容）
│
└── user-profile/                # 用户画像
    ├── group-index.json
    ├── relations-cache.json
    └── {Group}/index.json       # 所有用户画像 Group 使用单文件
```

---

## 8. 关键字段

### 8.1 relation-cache.json 中的 Relation

```json
{
  "id": "rel_xxx",
  "text": "Relation 名称",
  "score": 0,
  "useCount": 0,
  "lastUsedTime": null,
  "isImported": false,
  "sourcePath": null
}
```

**字段说明**：
- `id`：Relation 唯一标识
- `text`：Relation 名称（显示文本）
- `score`：热度分数
- `useCount`：使用次数
- `lastUsedTime`：最后使用时间
- `isImported`：是否为导入的数据
- `sourcePath`：源文件路径（可选）

**注意**：在新的纯 ki 命令架构中，不再使用 `memoryId` 字段，因为不再依赖 `memory_store`/`memory_recall`。

### 8.2 归档文件格式

`archive.md` 文件格式示例：

```markdown
# 最近需求归档

## 2026-06-05
- [2026-06-05] 实现用户登录功能
- [2026-06-05] 优化搜索性能

## 2026-06-04
- [2026-06-04] 添加数据导出功能
```

**格式要求**：
- 按日期分组，最新日期在前
- 每条记录格式：`[YYYY-MM-DD] 简短描述`
- 保持简洁，便于后续查阅
