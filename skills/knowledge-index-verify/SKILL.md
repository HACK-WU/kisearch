# 知识库验证 SKILL

> 验证知识索引构建或更新操作的结果，确保数据完整性和一致性。

## 触发场景

- 完成首次构建（knowledge-index-build）后验证结果
- 完成增量更新（knowledge-index-update）后验证变更
- 用户要求"验证知识库"、"检查索引"、"测试导入结果"
- 排查知识库数据问题

## 验证类型

### 1. 结构验证

验证 Group 树结构是否正确创建。

**命令**：
```bash
ki query-group --scope <scope> --mode full
```

**预期结果**：
- 显示完整的 Group 目录结构
- 所有预期的 Group 节点都存在
- 无重复节点

**示例输出**：
```
📁 完整索引树:
  项目根/
    设计文档/
      API/
      knowledge-index/
    用户模块/
      登录/
      注册/
```

### 2. Relations 验证

验证 Relations 缓存是否正确写入。

**命令**：
```bash
ki query-group --scope <scope> --groups <group>
```

**预期结果**：
- 显示 Group 下的 Relation 列表
- 包含评分和关键词信息
- 热门 Relation 正确标记

**示例输出**：
```json
{
  "group": "设计文档/API",
  "hot_relations": [
    { "id": "rel_001", "text": "用户登录", "score": 8.5, "keywords": ["登录", "认证"] },
    { "id": "rel_002", "text": "API文档", "score": 7.2, "keywords": ["API", "接口"] }
  ],
  "keywords": ["登录", "认证", "token", "API", "接口"]
}
```

### 3. 本地 KB 验证

验证本地 KB 中的模块信息是否正确存储。

**命令**：
```bash
ki get-module-info \
  --scope <scope> \
  --group <group> \
  --relation <relation>
```

**预期结果**：
- 输出 Markdown 格式的模块信息
- 内容与导入时一致
- 无乱码或截断

**验证点**：
- 摘要内容完整
- 格式正确（标题、列表、代码块等）
- 关键信息无丢失

### 4. 语义检索验证

验证 MCP 记忆系统中的向量化数据是否可检索。

**MCP memory_recall 调用**：
```json
{
  "query": "测试关键词",
  "limit": 3,
  "tags": "knowledge-index,<scope>"
}
```

**预期结果**：
- 返回相关记忆条目
- `tags` 过滤生效
- 结果与导入内容相关

### 5. 增量更新验证

验证增量更新的特定操作。

**新增条目验证**：
```bash
ki get-module-info \
  --scope <scope> \
  --group <新增条目的group> \
  --relation <新增条目的relation>
```
预期：输出新增的模块信息

**修改条目验证**：
```bash
ki get-module-info \
  --scope <scope> \
  --group <修改条目的group> \
  --relation <修改条目的relation>
```
预期：输出更新后的模块信息

**删除条目验证**：
```bash
ki get-module-info \
  --scope <scope> \
  --group <删除条目的group> \
  --relation <删除条目的relation>
```
预期：报错"本地 KB 中未找到"

---

## 验证脚本

### 完整验证流程

```bash
#!/bin/bash
# 知识库完整验证脚本
SCOPE=$1
GROUP=$2
RELATION=$3

echo "=== 结构验证 ==="
ki query-group --scope $SCOPE --mode full

echo -e "\n=== Relations 验证 ==="
ki query-group --scope $SCOPE --groups $GROUP

echo -e "\n=== 本地 KB 验证 ==="
ki get-module-info --scope $SCOPE --group $GROUP --relation $RELATION

echo -e "\n=== 验证完成 ==="
```

### 批量验证

```bash
# 验证所有 Group 的结构
ki query-group --scope <scope>

# 验证特定 Group 的所有 Relation
ki query-group --scope <scope> --groups "设计文档/API"
```

---

## 验证检查清单

### 首次构建后验证

- [ ] Group 树结构完整
- [ ] 所有预期的 Group 节点存在
- [ ] Relations 列表正确
- [ ] 关键词质量良好
- [ ] 本地 KB 内容完整
- [ ] 语义检索可命中
- [ ] 无重复数据

### 增量更新后验证

- [ ] 新增条目已写入
- [ ] 修改条目已更新
- [ ] 删除条目已移除
- [ ] Relations 缓存已同步
- [ ] 本地 KB 内容正确
- [ ] 语义检索结果更新

---

## 常见问题排查

| 问题 | 可能原因 | 排查步骤 |
|------|----------|----------|
| Group 树为空 | 构建失败或 scope 错误 | 检查 scope 名称，查看构建日志 |
| Relations 列表为空 | 向量化失败 | 检查 mem 命令安装和 API 配置 |
| 本地 KB 内容缺失 | 写入失败 | 检查文件权限，查看错误日志 |
| 语义检索无结果 | 向量化未完成 | 等待向量化完成，检查 tags 格式 |
| 增量更新未生效 | diff 检测失败 | 检查 git 仓库状态，查看 diff 输出 |

---

## 与其他 Skill 的关系

| Skill | 使用场景 | 依赖关系 |
|------|---------|----------|
| knowledge-index-build | 首次构建后验证 | 依赖构建结果 |
| knowledge-index-update | 增量更新后验证 | 依赖更新结果 |
| knowledge-index-query | 查询功能验证 | 验证查询路径 |
| knowledge-index-manage | 管理操作验证 | 验证 CRUD 结果 |

**knowledge-index-verify 是验证能力**，在其他 skill 执行完成后使用。