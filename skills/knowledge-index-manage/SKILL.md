# 索引结构管理 SKILL

> 知识索引的底层 CRUD 能力，管理 Group 树结构和 Relation 条目。

## 触发场景

- 用户显式请求创建/删除 Group
- 知识缺失路径中需要创建新 Group
- 手动调整索引结构（非高频场景）

## 三层架构基础

知识索引系统在记忆系统上层构建三层文件系统：

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Group 树索引 (group-index.json)          │
│  - 层级导航：项目根 → 子Group → ...                 │
│  - 物理隔离：每个 scope 独立目录                    │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Relations 缓存 (relations-cache.json)    │
│  - 热门 Relation 列表 + 评分                        │
│  - 冷热分区：hot / warm / cold / emerging         │
└─────────────────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: 本地 KB (index.json)                     │
│  - Markdown 模块信息全文                            │
│  - 按 Group 物理隔离                               │
└─────────────────────────────────────────────────────┘
```

---

## Group 管理

### 创建根节点

```bash
ki manage-index \
  --scope <scope> \
  --action create-root \
  --root-name <name>
```

**输出**：
```json
{ "ok": true, "path": "设计文档" }
```

**注意**：
- 根节点名称不能重复（重复会输出 warning，幂等覆盖）
- 默认根节点 "项目根" 不可删除

### 创建子节点

```bash
ki manage-index \
  --scope <scope> \
  --action create \
  --parent <父节点路径> \
  --name <子节点名称>
```

**示例**：
```bash
# 在 "设计文档" 下创建 "API" 子节点
ki manage-index \
  --scope my-project \
  --action create \
  --parent "设计文档" \
  --name "API"
```

**输出**：
```json
{ "ok": true, "path": "设计文档/API" }
```

### 删除节点

```bash
ki manage-index \
  --scope <scope> \
  --action delete \
  --parent <父节点路径> \
  --name <子节点名称> \
  [--force]
```

**注意**：
- 非空节点需要 `--force` 参数
- 删除节点会同时删除：
  - Relations 缓存中的相关条目
  - 本地 KB 中的 Markdown 内容
  - 子节点（递归删除）

---

## Relation 管理

### 手动写入 Relation

```bash
# 单条模式
ki sync-relation \
  --scope <scope> \
  --group <group> \
  --relation <relationText> \
  --module-info "<markdown内容>" \
  --keywords <k1,k2,k3>
```

**示例**：
```bash
ki sync-relation \
  --scope my-project \
  --group "设计文档/API" \
  --relation "用户登录" \
  --module-info "# 用户登录\n\n## 流程\n1. 输入账号密码\n2. 验证\n3. 返回token" \
  --keywords "登录,认证,token"
```

### 批量写入 Relation

```bash
ki sync-relation \
  --scope <scope> \
  --input <jsonFile>
```

**输入格式**：
```json
{
  "items": [
    {
      "group": "设计文档/API",
      "relation": "用户登录",
      "module_info": "# 用户登录\n...",
      "keywords": ["登录", "认证", "token"]
    },
    {
      "group": "设计文档/API",
      "relation": "用户注册",
      "module_info": "# 用户注册\n...",
      "keywords": ["注册", "邮箱", "验证"]
    }
  ]
}
```

---

## 查询索引结构

### 完整索引树

```bash
ki query-group --scope <scope>
```

**输出**：
```
项目根/
  设计文档/
    API/
      [hot] 用户登录 (score: 8.5) [登录, 认证]
      [hot] 用户注册 (score: 7.2) [注册, 验证]
    knowledge-index/
      [hot] 01-overview (score: 6.0) [概述, 架构]
```

### 完整索引树

```bash
ki query-group --scope <scope> --mode full
```

**输出**（含评分和分区标签）：
```
📁 完整索引树:
  项目根/ (score: 15.3) [热]
    设计文档/ (score: 13.2) [热]
      API/ (score: 7.2) [热]
        [热] 用户登录 (score: 8.5) [登录, 认证]
      knowledge-index/ (score: 6.0) [常温]
        [热] 01-overview (score: 6.0) [概述, 架构]
```

### 指定 Group 的 Relations

```bash
ki query-group --scope <scope> --groups <group>
```

**输出**：
```json
{
  "group": "设计文档/API",
  "hot_relations": [
    { "id": "rel_001", "text": "用户登录", "score": 8.5 }
  ],
  "keywords": ["登录", "认证", "token", "注册", "验证"]
}
```

---

## 参数速查

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识（字母、数字、连字符、下划线） | 是 |
| `--action` | create / delete / create-root | 否（默认 create） |
| `--parent` | 父节点路径 | create/delete 时必填 |
| `--name` | 节点名称 | create 时必填 |
| `--root-name` | 根节点名称 | create-root 时必填 |
| `--force` | 强制删除非空节点 | 否 |
| `--group` | Group 路径 | sync-relation 时必填 |
| `--relation` | Relation ID 或描述文本 | sync-relation 时必填 |
| `--module-info` | Markdown 格式模块信息 | sync-relation 时必填 |
| `--keywords` | 逗号分隔关键词 | sync-relation 时必填 |
| `--input` | 批量输入 JSON 文件 | 批量模式必填 |

---

## Scope 隔离规则

### 合法字符

- ✅ 字母（a-z, A-Z）
- ✅ 数字（0-9）
- ✅ 连字符（-）
- ✅ 下划线（_）
- ❌ 禁止路径遍历字符（`../`）

### 物理隔离

每个 scope 独立目录：

```
knowledge-index/kb/
  ├── my-project/          # scope: my-project
  │   ├── group-index.json
  │   ├── relations-cache.json
  │   └── 设计文档/API/
  │       └── index.json
  ├── another-project/     # scope: another-project
  │   ├── group-index.json
  │   └── ...
```

---

## 验证建议

管理操作后验证：

1. **Group 树结构**
   ```bash
   ki query-group --scope <scope> --mode full
   ```

2. **Relations 列表**
   ```bash
   ki query-group --scope <scope> --groups <group>
   ```

3. **本地 KB 内容**
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <group> \
     --relation <relationText>
   ```

4. **幂等性验证**
   - 重复执行创建操作，确认不产生重复数据
   - 重复执行写入操作，确认覆盖更新而非新增

---

## 常见错误

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope "XXX" 不合法` | scope 含非法字符 | 仅使用字母、数字、连字符、下划线 |
| `scope 含路径遍历字符` | scope 包含 `../` | 移除路径遍历字符 |
| `父节点不存在` | `--parent` 路径错误 | 先创建父节点 |
| `节点非空，需 --force` | 删除非空节点未加 `--force` | 添加 `--force` 参数 |
| `默认根节点 "项目根" 不可删除` | 尝试删除默认根节点 | 不删除，或创建新根节点 |

---

## 与其他 Skill 的关系

| Skill | 使用场景 | 依赖 manage-index |
|------|---------|------------------|
| knowledge-index-query | 知识缺失路径 | 创建 Group（如需要） |
| knowledge-index-build | 首次构建 | 自动创建 Group 树 |
| knowledge-index-update | 增量更新 | 自动更新 Group 树 |
| knowledge-index-verify | 验证操作 | 查询 Group 结构 |

**knowledge-index-manage 是底层能力**，其他 skill 在特定场景下会间接调用。