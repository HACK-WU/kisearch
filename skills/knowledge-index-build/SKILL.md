# 知识库构建 SKILL

> 首次将外部知识库完整导入知识索引系统的完整流程。基于 S-04 统一导入流程，2 步完成全部操作。

## 触发场景

- 为新项目首次导入外部知识库（如 Wiki、文档站）
- 用户要求"构建知识索引"、"导入外部文档"、"初始化知识库"
- 外部知识库目录结构变化较大，需要重新全量导入

## 前置条件

1. **全局安装 `mem` 命令**：知识索引的所有向量化操作都依赖 `mem` 命令
   ```bash
   npm install -g https://github.com/HACK-WU/memory-lancedb-mcp/releases/download/v0.1.0/memory-lancedb-mcp-0.1.0.tgz
   ```

2. **配置嵌入 API**：确保 `~/.config/memory-mcp/config.yaml` 中已配置嵌入 API 密钥。

3. **注册 scope**：首次使用某个 scope 前，需在配置文件中注册该 scope。
   ```yaml
   scopes:
     default: global
     definitions:
       your-scope:
         description: your scope description
         acl:
           - global
           - your-scope
   ```

## 执行流程

### S-04 统一导入流程（2 步）

```
外部知识库目录
     │
     ▼
[Step 1] AI 扫描目录，生成 ai-results.json
     │
     ▼
[Step 2] scan-kb import 命令完成全部操作
     │
     ▼
知识索引构建完成
```

---

### Step 1: AI 生成 `ai-results.json`

**任务**：扫描外部知识库目录，为每个文件生成结构化条目。

**⚠️ 重要提醒**：不要读取所有知识库文件的完整内容。应优先使用文件路径、文件名、文档开头（前 10-20 行）等轻量信息生成摘要和关键词。避免加载整个文档内容到内存中。

**输入**：
- 外部知识库目录路径（如 `.qoder/repowiki/zh/content`）
- 根节点名称（如 `QoderWiki`）

**输出**：`ai-results.json` 文件

**生成规则**：

**重要提示**：不要读取所有知识库文件的完整内容。应优先使用以下轻量信息源：

1. **扫描目录**：递归扫描指定目录，识别所有 Markdown 文件
2. **分析文件**：按以下优先级获取信息（避免读取全文）：
   - **文件路径**：从目录结构推导分组和主题
   - **文件名**：推导 Relation 文本
   - **文档开头**：仅读取前 10-20 行，提取标题、摘要或目录
   - **YAML 前置元数据**：如有 `title`、`description`、`tags` 等字段
3. **生成摘要**：基于上述轻量信息，用 1-2 句话概括核心内容
4. **提取关键词**：从标题、路径、前几行中提取 3-5 个自然语言关键词
5. **推导分组路径**：根据目录结构推导 Group 路径
6. **生成条目**：为每个文件创建一个 entry

**执行示例**：

假设知识库目录结构如下：
```
content/
├── README.md
├── getting-started/
│   ├── installation.md
│   └── quick-start.md
└── advanced/
    ├── configuration.md
    └── performance.md
```

**轻量信息获取策略**：
1. **`README.md`**：读取前 10 行，找到标题和简介
2. **`getting-started/installation.md`**：从文件名推导主题，读取前 5 行确认
3. **`advanced/configuration.md`**：从目录名 "advanced" 推导分组，从文件名推导主题

**生成结果**：
```json
{
  "path": "README.md",
  "groupPath": "ProjectDocs",
  "relation": "README",
  "summary": "项目总览文档，包含项目简介和目录结构。",
  "keywords": ["项目", "简介", "目录"],
  "action": "add"
}
```

**`ai-results.json` 格式规范**：

```json
{
  "meta": {
    "sourceDir": ".qoder/repowiki/zh/content",
    "rootName": "QoderWiki"
  },
  "entries": [
    {
      "path": "核心概念/Scope 隔离机制.md",
      "groupPath": "QoderWiki/核心概念",
      "relation": "Scope 隔离机制",
      "summary": "Scope 隔离通过服务端 scope 注入、agentId 绕过与 wrapper 层 ACL 检查三段式实现。",
      "keywords": ["Scope", "隔离", "访问控制", "ACL", "agentId"],
      "action": "add"
    }
  ]
}
```

**字段说明**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `meta.sourceDir` | 是 | 外部知识库目录（相对项目根或绝对路径） |
| `meta.rootName` | 是 | 导入根节点名称，需与首次导入一致 |
| `entries[].path` | 是 | 相对 `meta.sourceDir` 的 posix 路径 |
| `entries[].groupPath` | 否 | Group 完整路径（含 rootName 前缀）；缺失时从 `path` 推导 |
| `entries[].relation` | 否 | Relation 文本；缺失时从文件名推导 |
| `entries[].summary` | 否 | 3~5 句摘要 |
| `entries[].keywords` | 否 | 自然语言关键词数组 |
| `entries[].action` | 否 | 操作语义：`add`（默认）/ `modify` / `delete` |
| `entries[].memoryId` | 条件 | `modify`/`delete` 时必填；首次导入由系统填充 |

**校验规则**：

1. `meta.sourceDir` 和 `meta.rootName` 必填
2. `groupPath` 首段必须等于 `rootName`
3. `action='delete'` 必须携带 `memoryId`
4. `action` 缺失时默认 `'add'`

**关键词规则**：

- ✅ 自然语言词汇（如"登录"、"认证"、"token"）
- ❌ 代码符号（如类名、方法名、路径）
- 关键词必须从以下轻量信息中提取：
  - 文件名（如 `installation.md` → "安装"）
  - 目录名（如 `getting-started/` → "入门"、"快速开始"）
  - 文档标题（如 `# 配置指南` → "配置"、"指南"）
  - 前几行内容中的高频词汇

---

### Step 2: 执行统一导入

**命令**：
```bash
ki scan-kb import \
  --scope <scope> \
  --results ai-results.json
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识（字母、数字、连字符、下划线） | 是 |
| `--results` | AI 生成的 `ai-results.json` 文件路径 | 是 |

**内部 5 阶段流水线**：

1. **格式校验**：验证 `ai-results.json` 格式和字段完整性
2. **批量向量化**：调用 `mem store` 批量向量化所有条目，解析 `Memory ID`
3. **Group 树创建**：自动创建 Group 目录结构
4. **Relations 缓存写入**：写入 `relations-cache.json`，包含 `memoryId` 和 `sourcePath`
5. **group-index.source 记录**：记录导入元信息（含 git HEAD commit）

**输出示例**：
```json
{
  "ok": true,
  "action": "import",
  "scope": "my-project",
  "mode": "full",
  "stats": {
    "total": 25,
    "added": 25,
    "modified": 0,
    "deleted": 0,
    "errors": 0
  }
}
```

---

## 验证步骤

导入完成后，执行以下验证：

1. **Group 树结构**：
   ```bash
   ki query-group --scope <scope> --mode full
   ```
   预期：显示完整的 Group 目录结构

2. **Relations 列表**：
   ```bash
   ki query-group --scope <scope> --groups <group>
   ```
   预期：显示 Group 下的 Relation 列表和关键词

3. **本地 KB 内容**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <group> \
     --relation <relation>
   ```
   预期：输出 Markdown 格式的模块信息

4. **语义检索**：
   ```json
   // MCP memory_recall
   {
     "query": "测试关键词",
     "limit": 3,
     "tags": "knowledge-index,<scope>"
   }
   ```
   预期：返回相关记忆条目

---

## 错误处理

| 错误 | 原因 | 修复 |
|------|------|------|
| `Access denied to scope: <scope>` | scope 未注册 | 在 `~/.config/memory-mcp/config.yaml` 注册 scope |
| `ai-results.json 格式错误` | JSON 格式不合法 | 检查 JSON 语法 |
| `meta.sourceDir 不存在` | 源目录路径错误 | 确认目录存在且路径正确 |
| `groupPath 首段必须等于 rootName` | Group 路径格式错误 | 确保 `groupPath` 以 `rootName` 开头 |
| `mem store 失败` | mem 命令未安装或配置错误 | 安装 mem 命令，检查 API 密钥配置 |

---

## 与其他 Skill 的关系

| Skill | 使用场景 | 依赖关系 |
|------|---------|----------|
| knowledge-index-update | 增量更新 | 依赖首次构建的 `group-index.source` 块 |
| knowledge-index-verify | 验证构建结果 | 在构建完成后执行 |
| knowledge-index-query | 查询知识 | 构建完成后使用 |
| knowledge-index-manage | 管理索引结构 | 构建过程中自动创建 Group |

**knowledge-index-build 是首次导入的入口**，后续更新使用 knowledge-index-update。

---

## 注意事项

### 轻量信息获取最佳实践

1. **避免全文读取**：不要使用 `readFile` 读取整个文档内容
2. **使用目录列表**：使用 `listDir` 或 `glob` 获取文件列表
3. **读取前 N 行**：使用 `readFile` 的 `offset` 和 `limit` 参数，只读取前 10-20 行
4. **利用文件元数据**：
   - 文件名：`installation.md` → "安装"
   - 目录名：`getting-started/` → "入门"
   - 文件大小：大文件可能是详细文档，小文件可能是概览
5. **提取 YAML 前置元数据**：如有 `title`、`description`、`tags` 等字段
6. **批量处理**：并行读取多个文件的开头部分，提高效率

### 性能优化

- 对于大型知识库（>100 个文件），建议分批处理
- 使用并行读取，但避免同时打开过多文件
- 优先处理重要文件（如 README、index 等）

### 质量保证

- 摘要应简洁明了，1-2 句话概括核心内容
- 关键词应具有代表性，避免过于宽泛或过于具体
- 分组路径应反映知识库的逻辑结构