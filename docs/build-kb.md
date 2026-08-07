# 知识库构建 SKILL

> 首次将外部知识库完整导入知识索引系统的完整流程。基于 S-04 统一导入流程，2 步完成全部操作。

## 触发场景

- 为新项目首次导入外部知识库（如 Wiki、文档站）
- 用户要求"构建知识索引"、"导入外部文档"、"初始化知识库"
- 外部知识库目录结构变化较大，需要重新全量导入

## 前置条件

### 1. 配置初始化

首次使用前，需生成配置文件：

```bash
ki config init
```

配置文件默认生成在 `~/.ki/config.yaml`（YAML 格式，含注释），包含 `dataDir`（数据存储目录）、`vectorDir`（向量库目录）、`embedding`（向量提供方）和 `scopes`（scope 配置），同时自动创建 `dataDir` / `backupDir` / `vectorDir` 目录。

> 配置格式以 YAML 为主，保留对旧版 `config.json` 的读取兼容；生成后可执行 `ki doctor` 校验配置与向量环境是否就绪。

如需隔离测试数据，可修改 `dataDir` 指向独立目录：

```bash
# 生成配置到指定目录
ki config init --dir /path/to/test

# 或手动编辑 ~/.ki/config.yaml 中的 dataDir 字段
# dataDir: /path/to/data
```

### 2. 配置嵌入 API

确保 `~/.ki/config.yaml` 中已配置嵌入 API 密钥（SiliconFlow 或其他 OpenAI 兼容 API）：

```yaml
embedding:
  provider: openai-compatible
  apiKey: ${OPENAI_API_KEY}
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096
```

### 3. 注册 scope

首次使用某个 scope 前，需在配置文件中注册该 scope：

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

### 5. 确定 KB 存储位置

不同 scope 的 KB 数据可以独立配置存储目录。在确定 scope 后，需要询问用户选择存储位置（例如："KB 数据存储位置使用默认路径还是自定义路径？"）；若用户选择自定
义，引导其编辑 `~/.ki/config.yaml` 添加 `kbDir` 字段。

- **默认位置**：使用 `~/.ki/config.yaml` 中 `dataDir` 配置的全局默认目录
- **自定义位置**：为该 scope 单独指定存储路径

自定义方式如下，在 `~/.ki/config.yaml` 的 scope 配置中添加 `kbDir` 字段：

```yaml
dataDir: $HOME/.ki-data
backupDir: $HOME/.ki-backup
scopes:
  your-scope:
    kbDir: /path/to/custom/data
    wikiSync:
      enabled: true
      sourceDir: /path/to/wiki-output
```

| 字段 | 说明 |
|------|------|
| `dataDir` | 全局默认存储目录，未配置 `kbDir` 的 scope 数据放在 `dataDir/{scope}/` 下 |
| `backupDir` | 备份快照目录 |
| `kbDir` | scope 级自定义 KB 存储路径，覆盖全局 `dataDir` |
| `wikiSync.enabled` | 是否在 `sync-relation` 写入后同步到外部 Wiki 目录 |
| `wikiSync.sourceDir` | Wiki 写回目标目录（source 块导入后优先使用 source 目录） |

> **注意**：如果 scope 已有数据，修改 `kbDir` 后需要手动迁移或重新导入。

## 执行流程

### 原文直导（--source，无 AI 依赖）

> **REQ-01/04（批次 3）**：ai-results.json 输入契约已删除，首次导入统一走 `--source` 原文直导（无 AI 依赖，大文档自动切分）。

```
外部知识库目录（Markdown）
     │
     ▼
[Step 1] scan-kb import --source <dir> --root-name <root>
     │  （内部：递归扫描 .md → 逐文件切分 → 向量化 → 写 cache + local KB）
     ▼
知识索引构建完成
```

---

### Step 1: 执行统一直导

**命令**：
```bash
ki scan-kb import \
  --scope <scope> \
  --source <外部知识库目录> \
  --root-name <根节点名称>
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识（字母、数字、连字符、下划线） | 是 |
| `--source` | 外部 Markdown 目录（递归扫描含子目录） | 是 |
| `--root-name` | 导入根节点名称（= groupPath 首段） | 是 |
| `--chunk-size` | 切分目标长度（字符，默认 1000） | 否 |
| `--chunk-overlap` | 切分重叠字符数（默认 150） | 否 |

**自动行为**：

1. **递归扫描**：遍历 `--source` 下所有 `.md` 文件（跳过隐藏目录 / node_modules）
2. **自动切分**：超过 `chunk-size` 的文件按"固定长度 + 段落边界优先"切分为多 chunk，relation 名 = `文件名-N`（如 `deploy-01`），sourcePath = `文件#N`
3. **批量向量化**：调用 zvec 引擎批量向量化（content = chunk 原文）
4. **Group 树创建**：自动创建 Group 目录结构（groupPath 从目录结构推导）
5. **Relations 缓存写入**：写入 `relations-cache.json`，包含 `memoryId` 和 `sourcePath`
6. **group-index.source 记录**：记录导入元信息（含 git HEAD commit + 切分参数持久化）
7. **sourceDir 写入**：scope 未配置 sourceDir 时写入绝对路径（供增量免传 `--source`）

**输出示例**：
```json
{
  "ok": true,
  "action": "import",
  "scope": "my-project",
  "mode": "full",
  "stats": {
    "total": 25,
    "vectorized": 25,
    "errors": 0
  },
  "errors": [],
  "groups": ["MyProject", "MyProject/API", "MyProject/前端"],
  "source": {
    "dir": "/path/to/wiki",
    "rootName": "MyProject",
    "commit": "abc123..."
  }
}
```

> **自动备份**：导入成功后，系统会自动创建 scope 快照备份（输出到 stderr）。备份文件保存在 `~/.ki-backup/<scope>/snapshots/` 目录下，格式为 `.tar.gz`，可用于后续还原。

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
   // MCP ki_search
   {
     "scope": "<scope>",
     "query": "测试关键词",
     "limit": 3
   }
   ```
   预期：返回相关记忆条目

---

## 错误处理

| 错误 | 原因 | 修复 |
|------|------|------|
| `Access denied to scope: <scope>` | scope 未注册 | 在 `~/.ki/config.yaml` 注册 scope |
| `sourceDir 不存在或不是目录` | `--source` 路径错误 | 确认目录存在且路径正确 |
| `目录下未发现 .md 文件` | 目录无 Markdown 文件 | 确认目录含 `.md` 文件 |
| `rootName 不能为空` | 缺 `--root-name` | 补充 `--root-name <name>` |
| `向量化失败` | Embedding API 配置错误或网络问题 | 检查 `~/.ki/config.yaml` 中的 embedding 配置，确认 API 密钥有效 |
| `文件过大已跳过` | 超过单文件大小上限（默认 2MB） | 手动切分后导入或调整上限 |

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

### 直导特性

1. **原文直导**：向量 content = chunk 原文（无 AI 摘要），语义检索直接索引原文
2. **自动切分**：超过 `chunk-size`（默认 1000 字符）的文件按"固定长度 + 段落边界优先"切分，relation 名 = `文件名-N`（`deploy-01`），sourcePath = `文件#N`
3. **大文件上限**：单文件默认上限 2MB，超限跳过并告警（可手动切分后导入）
4. **groupPath 推导**：从文件目录结构推导（`dir/sub/file.md` → `rootName/dir/sub`）

### 性能优化

- 对于大型知识库（>100 个文件），复用现有批量向量化 + 断点续跑（文件级跳过粒度）
- 切分参数影响向量数量：chunk 越小向量越多；建议默认 1000 字符平衡检索粒度与规模

### 质量保证

- 切分粒度决定检索精度：过大 → 语义稀释；过小 → 向量爆炸（建议不调小默认值）
- 分组路径反映知识库的逻辑结构（目录层级）
- 增量更新用 `--mode incremental`（git diff 驱动），保证与首次直导的切分参数一致（source 块持久化）

---

## Wiki 同步写回

当配置了 `wikiSync` 时，通过 `sync-relation` 写入的知识条目会自动同步到外部 Wiki 目录。

### 配置方式

> `wikiSync` 与 `kbDir` 均在同一个 `~/.ki/config.yaml` 的 scope 配置中设置，完整配置文件结构参见[前置条件第 5 步](#5-确定-kb-存储位置)。

在 scope 配置中添加 `wikiSync`：

```yaml
dataDir: /path/to/data
scopes:
  my-project:
    wikiSync:
      enabled: true
      sourceDir: /path/to/wiki-output
```

### 同步行为

- **写入时机**：每次 `sync-relation` 成功写入后，自动触发 Wiki 同步
- **输出格式**：生成 Markdown 文件，包含 YAML frontmatter（group、relation；keywords 已移除）
- **目录结构**：按 Group 路径创建子目录，如 `wiki-output/我的项目/API/用户登录接口.md`
- **优先级**：如果 scope 有 `source` 块（通过 scan-kb import 导入），Wiki 写回会直接写入 source 目录，而非 wikiSync.sourceDir
- **直导不触发写回**：`scan-kb import --source` 只写本地 KB + 向量层，不写回外部 Wiki（避免 chunk 的 `{relation}.md` 污染源目录）

### Wiki 文件示例

```markdown
---
group: 我的项目/API
relation: 用户登录接口
---
# 用户登录接口

POST /api/v1/users/login

请求体：{ email, password }

返回：{ token, expiresIn }
```