# 知识库查询 SKILL

> Agent 日常查询项目知识的核心能力，按优先级走快速路径 → 检索路径 → 知识缺失路径。

## 触发场景

- 用户提问涉及项目知识（如"这个模块怎么工作"、"API 怎么调用"）
- 需要查找特定功能、模块、概念的相关信息
- 用户显式请求查询知识库

## 三层架构基础

知识索引系统在记忆系统上层构建三层文件系统：

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Group 树索引 (group-index.json)          │
│  - 层级导航：项目根 → 子Group → ...                 │
│  - 快速定位目标 Group                              │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Relations 缓存 (relations-cache.json)    │
│  - 热门 Relation 列表 + 评分                        │
│  - 关键词词云（冷门 Relation 的检索入口）           │
│  - 冷热分区：hot / warm / cold / emerging         │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: 本地 KB (index.json)                     │
│  - Markdown 模块信息全文                            │
│  - 按 Group 物理隔离                               │
└─────────────────────────────────────────────────────┘
```

## 执行流程

### 决策顺序

```
用户提问
  │
  ├─[1] 快速路径：热门 Relation 直接命中 → 获取模块信息 → 回答
  │
  ├─[2] 检索路径：关键词词云匹配 → MCP memory_recall → 回写 Relation
  │
  └─[3] 知识缺失路径：均未命中 → 暂停询问用户 → 双写
```

---

### 路径 1: 快速路径（热门命中）

**适用条件**：目标 Relation 在 `hot_relations` 中（评分高、近期使用过）

**执行步骤**：

1. **查询 Group 的热门 Relation**
   ```bash
   ki query-group --scope <scope> --groups <group> --mode hot
   ```
   
   输出示例：
   ```json
   {
     "group": "项目/API",
     "hot_relations": [
       { "id": "rel_001", "text": "用户登录", "score": 8.5, "keywords": ["登录", "认证"] },
       { "id": "rel_002", "text": "API文档", "score": 7.2, "keywords": ["API", "接口"] }
     ]
   }
   ```

2. **匹配 Relation**
   - 从 `hot_relations` 中选择与用户问题最匹配的 Relation
   - 匹配依据：`text` 字段语义相似度 + `keywords` 关键词命中

3. **获取模块信息**
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <group> \
     --relation <relationId或text>
   ```
   
   输出：Markdown 文本（直接输出到 stdout）

4. **回答用户问题**
   - 基于获取的 Markdown 内容回答
   - 引用来源：`[来源: <group>/<relation>]`

---

### 路径 2: 检索路径（冷门回退）

**适用条件**：快速路径未命中，但关键词词云中有匹配项

**执行步骤**：

1. **获取完整索引树 + 关键词词云**
   ```bash
   ki query-group --scope <scope>
   ```
   
   输出包含：
   - Group 树结构
   - 每个 Group 的 `keywords`（Group 级主题标签集合）

2. **组装语义查询**
   - 从 `keywords` 中提取相关关键词
   - 组装查询语句：`"<用户问题核心词> <关键词1> <关键词2>"`

3. **调用 MCP memory_recall**
   
   **重要参数**：
   ```json
   {
     "query": "<组装的查询语句>",
     "limit": 3,
     "tags": "knowledge-index,<scope>"
   }
   ```
   
   **常见错误**：
   - ❌ 使用 `"text"` 参数 → 报错 "Cannot read properties of undefined"
   - ✅ 必须使用 `"query"` 参数

4. **回写 Relation（提升后续访问速度）**
   
   命中后调用：
   ```bash
   ki sync-relation \
     --scope <scope> \
     --group <group> \
     --relation <relationText> \
     --module-info "<markdown内容>" \
     --keywords <k1,k2,k3>
   ```
   
   同时调用 MCP `memory_store` 双写：
   ```json
   {
     "content": "<markdown内容>",
     "tags": "knowledge-index,<scope>,<group>"
   }
   ```

---

### 路径 3: 知识缺失路径（双写）

**适用条件**：本地 KB 与记忆系统均未命中

**执行步骤**：

1. **暂停并询问用户**
   ```
   我在知识库中没有找到相关信息，请提供以下线索：
   - 模块名称或文件路径
   - 功能描述
   - 相关代码位置
   ```

2. **扫描代码并总结**
   - 根据用户提示扫描相关代码
   - 总结为 Relation 描述 + Markdown 模块信息

3. **创建 Group（如需要）**
   ```bash
   ki manage-index \
     --scope <scope> \
     --action create \
     --parent <parentPath> \
     --name <groupName>
   ```

4. **双写 Relation + 记忆系统**
   ```bash
   # 写入知识索引
   ki sync-relation \
     --scope <scope> \
     --group <group> \
     --relation <relationText> \
     --module-info "<markdown>" \
     --keywords <k1,k2>
   ```
   
   ```json
   // 写入 MCP 记忆系统
   {
     "content": "<markdown>",
     "tags": "knowledge-index,<scope>,<group>"
   }
   ```

---

## 参数速查

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识（字母、数字、连字符、下划线） | 是 |
| `--groups` | 逗号分隔的 Group 路径列表 | 否 |
| `--mode` | hot / warm / cold / emerging / full（支持逗号分隔多值，默认 hot） | 否 |
| `--hot-count` | 热门展示个数 | 否（默认 5） |
| `--depth` | 索引层级深度 | 否（默认 4） |
| `--relation` | Relation ID 或描述文本 | 是（get-module-info） |

---

## MCP 工具配合

### memory_recall（检索路径）

```json
{
  "query": "用户登录 认证 token",
  "limit": 3,
  "tags": "knowledge-index,my-project"
}
```

**注意**：
- 必须使用 `"query"` 参数（不是 `"text"`）
- `tags` 用于过滤 scope，格式：`knowledge-index,<scope>`

### memory_store（双写）

```json
{
  "content": "# 用户登录模块\n\n## 流程\n1. 用户输入账号密码\n2. 服务端验证\n3. 返回 token",
  "tags": "knowledge-index,my-project,API"
}
```

**注意**：
- MCP memory server 不支持自定义 scope，所有记忆默认存入 `global` scope
- 使用 `tags` 实现逻辑隔离

---

## 验证建议

执行查询后验证：

1. **索引结构**：`query-group.ts --mode full`
2. **关键词质量**：`query-group.ts --groups <group>`
3. **内容完整性**：`get-module-info.ts` 检索已写入的模块信息
4. **语义检索**：`memory_recall` 确认 tags 过滤生效

---

## 常见错误

| 错误 | 原因 | 修复 |
|------|------|------|
| `Cannot read properties of undefined (reading 'match')` | `memory_recall` 使用了 `"text"` 参数 | 改为 `"query"` 参数 |
| `Group "XXX" 在 relations-cache 中不存在` | Group 路径错误或未创建 | 先用 `manage-index.ts` 创建 Group |
| `本地 KB 中未找到 "XXX" 的内容` | Relation 存在但本地 KB 缺失 | 使用 `sync-relation.ts` 写入模块信息 |