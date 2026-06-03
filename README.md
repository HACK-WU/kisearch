# knowledge-indexer

AI Agent 知识索引整理工具 - 对外部知识进行结构化索引和导航

## 特性

- **零耦合设计**：不依赖父项目源码，仅通过 `mem` CLI 命令调用向量存储
- **本地知识目录层**：在向量数据库之上提供结构化导航和热关系缓存
- **TypeScript 直接执行**：使用 jiti 运行时，无需编译步骤
- **CLI 驱动**：所有操作通过命令行接口完成

## 前置条件

- Node.js >= 18.0.0
- `mem` CLI 命令（来自 `memory-lancedb-mcp` 项目）

```bash
# 安装 mem CLI（从 GitHub Release 安装）
npm install -g https://github.com/HACK-WU/memory-lancedb-mcp/releases/download/v0.1.0/memory-lancedb-mcp-0.1.0.tgz
```

## 安装

```bash
# 克隆项目
git clone git@github.com:HACK-WU/knowledge-indexer.git
cd knowledge-indexer

# 安装依赖
npm install

# 创建全局链接（支持任意路径执行）
npm link
```

## 使用

### 命令列表

| 命令 | 说明 |
|------|------|
| `scan-kb` | 统一入口：import / diff / scan / vectorize |
| `manage-index` | Group 树 CRUD |
| `query-group` | 查询 Group + 词云 + 分区 |
| `get-module-info` | 读取本地 KB 原文 |
| `sync-relation` | 写入 Relation + 关键词校验 |
| `import-kb` | @deprecated 旧导入 |
| `migrate-keywords` | 数据迁移 |

### 示例

```bash
# 扫描并导入知识库
knowledge-indexer scan-kb import --scope my-project --results ai-results.json

# 创建 Group 根节点
knowledge-indexer manage-index --scope my-project --action create-root --root-name "我的项目"

# 查询 Group 信息
knowledge-indexer query-group --scope my-project

# 获取模块详情
knowledge-indexer get-module-info --scope my-project --group "我的项目/API" --relation "用户登录"
```

### 增量更新

```bash
# 扫描差异
knowledge-indexer scan-kb diff --scope my-project

# 增量导入
knowledge-indexer scan-kb import --scope my-project --mode incremental --results ai-results.json
```

## 目录结构

```
knowledge-indexer/
├── package.json        # 项目配置
├── tsconfig.json       # TypeScript 配置
├── README.md           # 本文档
├── bin/                # CLI 入口脚本
├── _template/          # 新 scope 初始化模板
├── docs/               # 说明文档
├── kb/                 # 运行时数据（按 scope 隔离）
├── scripts/            # CLI 脚本
│   ├── lib/            # 内部共享模块
│   └── *.ts            # CLI 入口脚本
├── skills/             # AI Agent SKILL 定义
└── test/               # 测试文件
```

## 开发

```bash
# 运行单个测试
npm test

# 运行所有测试
npm run test:all

# 直接执行脚本
npx jiti scripts/scan-kb.ts --help
```

## License

MIT