# knowledge-indexer

> AI Agent 知识索引整理工具 - 对外部知识进行结构化索引和导航

基于 [memory-lancedb-mcp](https://github.com/HACK-WU/memory-lancedb-mcp) 项目的知识索引模块独立而来。

## 这是什么

`knowledge-indexer` 是一个独立的 AI Agent 知识索引工具，解决的是一个更贴近 Agent 使用体验的问题：

- **向量数据库**擅长语义召回、长期持久化、跨会话记忆治理
- **知识索引**擅长把项目知识组织成 AI 更容易浏览和落地使用的结构化视图

两者组合后，形成一个完整系统：

- **发现层**：向量数据库负责语义检索、长期存储、冷热治理
- **交付层**：`knowledge-indexer` 负责 Group 导航、热门 Relation 缓存、原文交付

换句话说，向量数据库更像"**长期记忆引擎**"，而 `knowledge-indexer` 更像"**面向 Agent 的知识目录与本地交付层**"。

## 特性

- **本地知识目录层**：在向量数据库之上提供结构化导航和热关系缓存
- **TypeScript 直接执行**：使用 jiti 运行时，无需编译步骤
- **CLI 驱动**：所有操作通过命令行接口完成
- **独立部署**：可独立安装和使用，通过 `mem` CLI 命令调用向量存储

## 文档导航

- **架构与协作关系**：[`docs/architecture.md`](./docs/architecture.md)
- **CLI 参考**：[`docs/cli.md`](./docs/cli.md)
- **scan-kb 子命令详解**（含 `import`、`diff`）：[`docs/scan-kb.md`](./docs/scan-kb.md)
- **外部导入与 `mapping` 示例**：[`docs/import-kb.md`](./docs/import-kb.md)
- **异常处理与恢复建议**：[`docs/error-handling.md`](./docs/error-handling.md)
- **典型工作流**：[`docs/workflows.md`](./docs/workflows.md)

如果你现在最关心 `scan-kb import` 的 `ai-results.json` 格式，请直接看：[`docs/scan-kb.md`](./docs/scan-kb.md)

## 核心概念

| 概念 | 含义 |
|------|------|
| `scope` | 项目隔离标识，不同 scope 物理隔离 |
| `Group` | 知识分组路径，例如 `项目/API`、`项目/前端/状态管理` |
| `Relation` | 某个 Group 下可被检索和命中的知识条目 |
| `module-info` | Relation 对应的 Markdown 原文说明 |
| 热门 Relation | 被频繁访问、优先展示的本地知识 |
| 关键词词云 | 为 AI 组装检索语句提供的自然语言提示 |

## 快速开始

### 前置条件

1. **全局安装 `mem` 命令**：知识索引的所有向量化操作都依赖 `mem` 命令，请先通过全局安装确保 `mem` 可用：
   ```bash
   npm install -g https://github.com/HACK-WU/memory-lancedb-mcp/releases/download/v0.1.0/memory-lancedb-mcp-0.1.0.tgz
   ```

2. **配置嵌入 API**：确保 `~/.config/memory-mcp/config.yaml` 中已配置嵌入 API 密钥。

3. **注册 scope**：首次使用某个 scope 前，需在配置文件中注册该 scope（详见下方"外部知识库导入"部分）。

### 安装

```bash
# 克隆项目
git clone git@github.com:HACK-WU/knowledge-indexer.git
cd knowledge-indexer

# 安装依赖
npm install

# 创建全局链接（支持任意路径执行）
npm link
```

### 使用示例

所有脚本使用 `ki` 命令执行（已通过 `npm link` 创建全局链接）。

```bash
# 1. 初始化索引（创建根节点）
ki manage-index \
  --scope my-project \
  --action create-root \
  --root-name "我的项目"

# 2. 创建分组
ki manage-index \
  --scope my-project \
  --action create \
  --parent "我的项目" \
  --name "API"

# 3. 写入一条知识
ki sync-relation \
  --scope my-project \
  --group "我的项目/API" \
  --relation "用户登录接口" \
  --module-info "## 登录流程\n用户输入账号密码后进入认证流程，服务端校验成功后返回 token。" \
  --keywords "登录,认证,token"

# 4. 查询 Group 视图
ki query-group \
  --scope my-project \
  --groups "我的项目/API"

# 5. 读取模块原文
ki get-module-info \
  --scope my-project \
  --group "我的项目/API" \
  --relation "用户登录接口"
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `scan-kb` | 统一入口：import / diff / scan / vectorize |
| `manage-index` | Group 树 CRUD |
| `query-group` | 查询 Group + 词云 + 分区 |
| `get-module-info` | 读取本地 KB 原文 |
| `sync-relation` | 写入 Relation + 关键词校验 |
| `import-kb` | @deprecated 旧导入 |
| `migrate-keywords` | 数据迁移 |

## `ai-results.json` 最小示例

如果你只想先知道 `ai-results.json` 长什么样，可以先看这个最小示例：

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

更完整的字段说明、校验规则和导入建议见：[`docs/scan-kb.md`](./docs/scan-kb.md)

## 典型工作流

### 本地知识沉淀

1. `manage-index.ts` 创建 Group
2. `sync-relation.ts` 写入模块说明
3. `query-group.ts` 查看导航与热点
4. `get-module-info.ts` 读取原文回答

### 外部知识库导入（推荐：S-04 统一流程）

> 前置条件：**首次使用某个 `scope` 前**，需在 `~/.config/memory-mcp/config.yaml` 注册该 scope，否则 `mem store` 会提示 `Access denied to scope: <scope>`。
>
> **配置结构说明：**
>
> - `scopes.default`：默认 scope 名称，未指定 scope 时使用，通常设为 `global`。
> - `scopes.definitions`：所有 scope 的定义，每个 key 即 scope 名称，包含：
>   - `description`：该 scope 的用途说明，便于识别。
>   - `acl`：访问控制列表，声明该 scope **允许读取哪些 scope 的数据**。例如 `["global", "mcp-test"]` 表示该 scope 可访问 `global` 和自身的记忆。通常至少包含 `global` 和自身 scope 名。
>
> **示例：多 scope 配置**
>
> ```yaml
> scopes:
>   default: global
>   definitions:
>     mcp-test:
>       description: knowledge-indexer test scope
>       acl:
>         - global
>         - mcp-test
>     qoder-wiki:
>       description: qoder repowiki external KB scope
>       acl:
>         - global
>         - qoder-wiki
> ```
>
> 上面定义了两个 scope：`mcp-test` 用于知识库测试，`qoder-wiki` 用于外部 Wiki 导入。每个 scope 的 `acl` 都包含 `global` 和自身，确保能读取公共记忆与自身数据。

#### 首次导入（2 步）

1. AI 生成 `ai-results.json`（顶层 `meta: { sourceDir, rootName }` + `entries[]`）
2. 一条命令完成：

```bash
ki scan-kb import \
  --scope my-project \
  --results ai-results.json
```

CLI 内部完成：格式校验 → 批量 `mem store` 向量化 → Group 树创建 → `relations-cache` 写入（含 `memoryId`） → `local KB` 写入 → `group-index.source` 块记录（含 git HEAD commit）。

#### 增量更新（3 步）

1. `scan-kb diff --scope my-project` 输出变更文件列表（含已导入条目的 `memoryId`）
2. AI 根据 diff 处理变更，生成增量 `ai-results.json`（每条带 `action: 'add' | 'modify' | 'delete'`）
3. `scan-kb import --scope my-project --mode incremental --results ai-results.json`

增量语义：

- `add`：新增 → 向量化 + 写入索引
- `modify`：更新 → `mem delete <oldId>` + 重新向量化（拿新 id）+ 替换索引
- `delete`：删除 → `mem delete <oldId>` + 移除索引

### 外部知识库导入（旧流程，仍可用）

旧的 7 步流程仍保留兼容：`scan` → `scan --results` → `vectorize` → `memory_store` → `vectorize --complete` → `import-kb`。`vectorize` 子命令已标记 DEPRECATED，建议迁移到 `import` 子命令。

## 数据目录

```text
knowledge-indexer/
├── kb/{scope}/                    # 运行时数据（自动创建）
│   ├── group-index.json           # Group 树索引 + source 块（dir/rootName/commit）
│   ├── relations-cache.json       # Relations 缓存 + 评分/分区（含 memoryId/sourcePath）
│   ├── scan-index.json            # [旧流程] 预扫描索引
│   ├── scan-pending.json          # [旧流程] 待处理文件列表
│   ├── {Group}/
│   │   └── index.json             # 本地 KB 模块信息原文
│   ├── archive/                   # 归档数据
│   └── backup/                    # 增量备份
├── _template/                     # 新 scope 初始化模板
├── docs/                          # 拆分后的说明文档
│   ├── architecture.md
│   ├── cli.md
│   ├── import-kb.md
│   ├── scan-kb.md
│   ├── error-handling.md
│   └── workflows.md
├── scripts/                       # CLI 脚本
│   ├── scan-kb.ts                 # 统一入口（import / diff / scan / vectorize）
│   ├── import-kb.ts               # [旧流程] @deprecated
│   ├── manage-index.ts
│   ├── query-group.ts
│   ├── get-module-info.ts
│   ├── sync-relation.ts
│   └── lib/                       # 内部模块
│       ├── ai-results.ts          # ai-results.json 解析与校验
│       ├── batch-vectorize.ts     # 批量 mem store + Memory ID 解析
│       ├── import.ts              # 统一导入 5 阶段流水线
│       ├── diff.ts                # 增量 diff（git diff -z）
│       ├── incremental.ts         # 增量导入（add/modify/delete）
│       ├── scope.ts               # scope 路径与 source 块管理
│       ├── scoring.ts             # 评分/分区/词云
│       └── store.ts               # JSON 读写工具
├── test/                          # 测试文件
└── skills/                        # SKILL 定义
```

## 约束与边界

- **Scope 隔离**：仅允许字母、数字、连字符、下划线；禁止路径遍历 `../`；不同 scope 物理隔离
- **关键词规则**：仅自然语言词汇，禁止代码符号（类名、方法名、路径等）；关键词必须真实出现在 `module-info` 原文中，避免随意指定关键词
- **数据版本**：所有 JSON 文件包含 `version` 字段，当前版本 1
- **WAL 写入**：所有 JSON 写入采用临时文件 → 原子 rename
- **默认根节点**：`项目根` 不可删除
- **幂等安全**：重复操作不产生副作用（重复导入覆盖更新）
- **快速失败**：输入校验失败立即退出，不静默降级
- **异常恢复**：运行时数据损坏自动从 `_template/` 恢复

## 开发

```bash
# 运行单个测试
npm test

# 运行所有测试
npm run test:all

# 直接执行脚本
npx jiti scripts/scan-kb.ts --help
```

## 一句话总结

`knowledge-indexer` 和向量数据库不是二选一关系，而是上下分层关系：

- **向量数据库**负责"记得住、搜得到、管得住"
- **knowledge-indexer** 负责"看得见、找得快、交付原文"

两者配合后，AI 才同时具备：

- **长期记忆能力**
- **项目结构化导航能力**
- **本地快速命中能力**
- **可直接回答的原文交付能力**

## License

MIT