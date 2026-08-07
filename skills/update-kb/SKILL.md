---
name: update-kb
description: 增量更新外部知识库的变更内容。基于 git diff 驱动的增量直连流程，无 AI 依赖，高效处理新增、修改、删除操作。当外部知识库发生变更（新增/修改/删除文件）或用户要求"更新知识库"、"增量导入"、"同步变更"时使用。
---

# 知识库更新 SKILL

> 增量更新外部知识库的变更内容。基于 git diff 驱动的增量直连，无 AI 依赖（REQ-04/06 批次 3）。

## 触发场景

- 外部知识库发生变更（新增、修改、删除文件）
- 用户要求"更新知识库"、"增量导入"、"同步变更"
- 定期同步外部文档站的最新内容

## 前置条件

1. **已完成首次直导**：必须先使用 `scan-kb import --source` 完成首次全量直导（记录 `source.commit` 增量基线）
2. **外部知识库目录存在**：确保外部知识库目录可访问
3. **Git 仓库**：增量更新依赖 `git diff` 检测变更，外部知识库需在 Git 仓库中；**非 git 仓库跑增量会明确报错**

## 执行流程

### 一步增量直连（git diff 驱动）

```
外部知识库变更 → git commit
     │
     ▼
ki scan-kb import --source <dir> --mode incremental
     │  （内部：git diff 检测变更 → 按文件处理）
     ▼
add    → 读原文 → 切分 → 向量化 → 写 cache + local KB
modify → 先写新全 chunk → 成功后再删旧全 chunk（覆盖更新）
delete → 按文件关联全 chunk memoryId 清理（向量 + cache + local KB）
     ▼
全部成功 → 更新 source.commit 到 HEAD
```

> **REQ-04/06（批次 3）**：ai-results.json 输入契约已删除，增量由 git diff 直连驱动，无需 AI 生成增量文件。

---

### Step 1: 检测变更（可选，仅查看）

**命令**：
```bash
ki scan-kb diff --scope <scope>
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识 | 是 |

**输出示例**：
```json
{
  "ok": true,
  "action": "diff",
  "scope": "my-project",
  "baseCommit": "b945303...",
  "headCommit": "dbde3a8...",
  "sourceDir": "/path/to/source",
  "rootName": "QoderWiki",
  "added": [
    { "path": "新增文件.md", "absPath": "/path/to/source/新增文件.md" }
  ],
  "modified": [
    { "path": "核心概念/Scope 隔离机制.md", "absPath": "..." }
  ],
  "deleted": [
    { "path": "已删除文件.md" }
  ],
  "stats": { "added": 1, "modified": 1, "deleted": 1, "total": 3 }
}
```

**输出字段说明**：

| 字段 | 说明 |
|------|------|
| `baseCommit` | 上次导入时的 git commit |
| `headCommit` | 当前 git commit |
| `sourceDir` | 外部知识库目录 |
| `rootName` | 根节点名称 |
| `added` | 新增文件列表 |
| `modified` | 修改文件列表（文件级） |
| `deleted` | 删除文件列表（文件级） |
| `stats` | 变更统计 |

**特殊情况**：
- 如果 `group-index.source` 块不存在，返回 `status: 'first_import'` 提示
- `modified`/`deleted` 的 chunk memoryId 由导入器从 `relations-cache` 按文件前缀（`文件#N`）自动聚合，diff 输出本身不展开

---

### Step 2: 执行增量导入（增量直连）

**命令**：
```bash
ki scan-kb import \
  --scope <scope> \
  --source <sourceDir> \
  --mode incremental
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识 | 是 |
| `--source` | 外部知识库目录（缺省用 `source.commit` 记录的 dir；全量直导时已写入 scope sourceDir） | 否 |
| `--mode` | 导入模式：`incremental` | 是 |

> **切分参数（D-8）**：增量永远使用 `source` 块持久化的 `chunkSize/chunkOverlap`，命令行传参忽略；缺省回退默认（1000 / 150）。

**增量语义**：

| 变更 | 执行操作 |
|------|----------|
| `added` | 读原文 → 切分 → 向量化 → 写 cache + local KB |
| `modified` | **先写新全 chunk → 全部成功后再删旧全 chunk**（写序保证中断不丢数据） |
| `deleted` | 按文件关联全 chunk memoryId → 删向量 + cache + local KB + 路径向量 |

**输出示例**：
```json
{
  "ok": true,
  "action": "import",
  "scope": "my-project",
  "mode": "incremental",
  "stats": {
    "total": 3,
    "added": 1,
    "modified": 1,
    "deleted": 1,
    "errors": 0
  }
}
```

---

## 验证步骤

增量更新完成后，执行以下验证：

1. **变更统计**：检查 `stats` 字段，确认 added/modified/delete 数量符合预期

2. **新增条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <新增条目的group> \
     --relation <新增条目的relation>
   ```
   预期：输出新增的模块信息

3. **修改条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <修改条目的group> \
     --relation <修改条目的relation>
   ```
   预期：输出更新后的模块信息

4. **删除条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <删除条目的group> \
     --relation <删除条目的relation>
   ```
   预期：报错"本地 KB 中未找到"

5. **Relations 缓存验证**：
   ```bash
   ki query-group --scope <scope> --groups <group>
   ```
   预期：确认 Relation 列表已更新

---

## 错误处理

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope 尚未首次导入` | 未完成首次直导 | 先执行 `scan-kb import --source` 全量直导 |
| `source 目录不在 git 仓库中` | 增量依赖 git diff | `git init` 或将 `--source` 指向 git 仓库内目录；或改用 `--mode full` |
| `memoryId 关联失败` | cache 中无对应 chunk memoryId | 检查 `relations-cache.json` 或重新全量直导 |
| `向量化删除失败` | zvec 引擎问题 | 检查嵌入 API 配置和 zvec 引擎状态 |
| `文件过大已跳过` | 超过单文件大小上限（默认 2MB） | 手动切分后导入或调整上限 |

---

## 与其他 Skill 的关系

| Skill | 使用场景 | 依赖关系 |
|------|---------|----------|
| knowledge-index-build | 首次构建（`scan-kb import --source`） | 必须先完成首次直导 |
| knowledge-index-verify | 验证更新结果 | 在更新完成后执行 |
| knowledge-index-query | 查询知识 | 更新完成后使用 |
| knowledge-index-manage | 管理索引结构 | 更新过程中自动维护 Group |

**knowledge-index-update 是增量更新的入口**，首次导入使用 knowledge-index-build。
