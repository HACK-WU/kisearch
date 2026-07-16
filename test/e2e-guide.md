# ki 端到端测试验证指南

本指南提供 KiSearch 所有功能的真实环境测试流程，使用 `test/fixtures/mock-wiki` 作为模拟外部 wiki，无需依赖真实 wiki 仓库即可完整验证。

---

## 目录

1. [前置准备](#1-前置准备)
2. [测试数据说明](#2-测试数据说明)
3. [初始化配置](#3-初始化配置)
4. [manage-index：Group 树管理](#4-manage-indexgroup-树管理)
5. [scan-kb import：全量导入](#5-scan-kb-import全量导入)
6. [query-group：索引查询](#6-query-group索引查询)
7. [get-module-info：读取本地 KB](#7-get-module-info读取本地-kb)
8. [sync-relation：关系写入](#8-sync-relation关系写入)
9. [search：语义搜索](#9-search语义搜索)
10. [export：反向导出](#10-export反向导出)
11. [scan-kb diff：增量差异检测](#11-scan-kb-diff增量差异检测)
12. [scan-kb import --mode incremental：增量导入](#12-scan-kb-import---mode-incremental增量导入)
13. [backup / restore：备份还原](#13-backup--restore备份还原)
14. [清理](#14-清理)
15. [测试检查清单](#15-测试检查清单)

---

## 1. 前置准备

### 环境要求

- Node.js >= 18
- 项目已安装依赖：`npm install`（在 KiSearch 根目录执行）
- 可选：memory 服务已启动（向量化依赖，无服务时 import 阶段会报错但不影响 Group 树和元数据验证）

### 确认 ki 可用

```bash
cd /root/knowledge-indexer
node bin/ki.mjs --version
```

### 确认 mock-wiki 已初始化

```bash
ls test/fixtures/mock-wiki/.git/HEAD
# 应存在，mock-wiki 是一个 git 仓库
```

---

## 2. 测试数据说明

### mock-wiki 目录结构

```
test/fixtures/mock-wiki/
├── README.md                  ← 根级文档（无子目录）
├── 核心概念/
│   ├── Scope 隔离机制.md       ← scope 隔离说明
│   └── Group 树结构.md         ← Group 树格式说明
├── API 参考/
│   ├── 用户认证.md             ← JWT 认证流程
│   ├── 数据查询.md             ← RESTful 查询规范
│   └── 权限管理.md             ← RBAC 权限（增量测试用，全量时未导入）
├── 部署指南/
│   └── Docker 部署.md          ← Docker 部署文档
└── 常见问题/
    └── 安装问题.md             ← 安装排查指南
```

### ai-results 文件

| 文件 | 用途 | 说明 |
|------|------|------|
| `test/fixtures/ai-results-full.json` | 全量导入 | 7 个条目，覆盖 4 个目录 |
| `test/fixtures/ai-results-incremental.json` | 增量导入 | modify 1 条 + delete 1 条 + add 1 条 |

> **注意**：ai-results 文件中的 `meta.sourceDir` 是占位路径，实际测试时需通过 `--source-dir` 参数覆盖为 mock-wiki 的绝对路径。

---

## 3. 初始化配置

### 3.1 生成配置文件

```bash
# 在临时目录生成配置
mkdir -p /tmp/ki-e2e-test
node bin/ki.mjs config init --dir /tmp/ki-e2e-test
```

**预期输出**：在 `/tmp/ki-e2e-test/.ki/config.json` 生成配置文件模板

### 3.2 修改 dataDir 路径

> **重要**：`config init` 生成的 `dataDir` 是全局默认路径（如 `/root/.ki-data`），需要手动修改为隔离的临时目录。

```bash
# 修改 dataDir 为测试专用目录
sed -i 's|"dataDir": "/root/.ki-data"|"dataDir": "/tmp/ki-e2e-test/kb"|' /tmp/ki-e2e-test/.ki/config.json
```

**验证要点**：
- [ ] 文件已生成
- [ ] `dataDir` 指向 `/tmp/ki-e2e-test/kb`
- [ ] 包含 `scopes` 对象

```bash
cat /tmp/ki-e2e-test/.ki/config.json
```

---

## 4. manage-index：Group 树管理

使用 `--config` 指定临时配置，隔离测试数据。

### 4.1 查看 scope 列表

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  manage-index --action list-scopes
```

**预期**：空列表（尚未有任何 scope）

### 4.2 全量导入后查看 scope 列表

> 需先完成 [第 5 步全量导入](#5-scan-kb-import全量导入)

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  manage-index --action list-scopes
```

**预期**：包含 `e2e-test` scope

### 4.3 创建子 Group

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  manage-index --scope e2e-test --action create --parent "TestWiki/API 参考" --name "WebSocket"
```

**预期输出**：`ok: true`，`path: "TestWiki/API 参考/WebSocket"`

**验证要点**：
- [ ] 返回 `ok: true`
- [ ] 新节点已写入 group-index.json

### 4.4 创建顶层 Group

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  manage-index --scope e2e-test --action create --name "架构设计"
```

**预期输出**：`ok: true`，`path: "架构设计"`

### 4.5 删除 Group

```bash
# 删除空节点
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  manage-index --scope e2e-test --action delete --name "架构设计"
```

**预期输出**：`ok: true`

**验证要点**：
- [ ] 空节点可正常删除
- [ ] 删除后 group-index.json 中该节点已移除

---

## 5. scan-kb import：全量导入

核心链路：AI 结果校验 → 批量向量化 → Group 树构建 → 元数据写入 → source 块记录

### 5.1 执行全量导入

```bash
MOCK_WIKI=$(realpath test/fixtures/mock-wiki)

node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  scan-kb import \
  --scope e2e-test \
  --results test/fixtures/ai-results-full.json \
  --source-dir "$MOCK_WIKI"
```

**预期输出**：

```json
{
  "ok": true,
  "action": "import",
  "mode": "full",
  "scope": "e2e-test",
  "stats": {
    "total": 7,
    "vectorized": 7,
    "errors": 0
  },
  "errors": [],
  "groups": [
    "TestWiki",
    "TestWiki/API 参考",
    "TestWiki/常见问题",
    "TestWiki/核心概念",
    "TestWiki/部署指南"
  ],
  "source": {
    "dir": "/absolute/path/to/mock-wiki",
    "rootName": "TestWiki",
    "commit": "dade327..."
  }
}
```

**验证要点**：

- [ ] `ok: true`
- [ ] `stats.total` = 7
- [ ] `stats.vectorized` = 7（或部分成功，取决于 memory 服务状态）
- [ ] `groups` 包含 5 个 Group 路径
- [ ] `source.commit` 非空

### 5.2 验证生成的数据文件

```bash
KB_DIR="/tmp/ki-e2e-test/kb/e2e-test"

# group-index.json
cat "$KB_DIR/group-index.json" | python3 -m json.tool

# relations-cache.json
cat "$KB_DIR/relations-cache.json" | python3 -m json.tool
```

**group-index.json 验证要点**：

- [ ] `version` 存在
- [ ] `scope` = "e2e-test"
- [ ] `groups` 包含 "TestWiki" 及其子节点
- [ ] `source.dir` 指向 mock-wiki 绝对路径
- [ ] `source.rootName` = "TestWiki"
- [ ] `source.commit` = mock-wiki HEAD

**relations-cache.json 验证要点**：

- [ ] `groups` 下每个导入的 Group 都有 `hot_relations` 条目
- [ ] 每个 relation 含 `id`、`text`、`isImported: true`
- [ ] Group 级 `keywords` 非空

### 5.3 验证 local KB 文件

```bash
# 列出 local KB 目录结构
find "$KB_DIR" -name "index.json" | head -10

# 检查某个 local KB
cat "$KB_DIR/TestWiki/API 参考/index.json" | python3 -m json.tool
```

**验证要点**：

- [ ] 每个导入的 Group 路径下都有 `index.json`
- [ ] index.json 内容为 `{ "relation文本": "文件原文内容" }`

---

## 6. query-group：索引查询

### 6.1 基础查询

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  query-group --scope e2e-test --groups "TestWiki"
```

**预期输出**：返回 TestWiki 及其子 Group 的索引结构

**验证要点**：
- [ ] 返回结构包含 TestWiki 根级的 `hot_relations`（如 README）
- [ ] 包含 `keywords` 字段

> **注意**：query-group 只返回指定 Group 的直接 relations，不递归显示子 Group。要查看子 Group 需单独查询。

### 6.2 查询子 Group

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  query-group --scope e2e-test --groups "TestWiki/API 参考"
```

**验证要点**：
- [ ] 返回 API 参考组的 relations（用户认证、数据查询等）

### 6.3 多 Group 查询

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  query-group --scope e2e-test --groups "TestWiki/API 参考,TestWiki/部署指南"
```

**验证要点**：
- [ ] 同时返回两个 Group 的数据

### 6.4 词云展示

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  query-group --scope e2e-test --groups "TestWiki" --mode full
```

**验证要点**：
- [ ] `mode=full` 展示完整分区（hot/warm/cold/emerging）

### 6.5 深度限制

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  query-group --scope e2e-test --groups "TestWiki" --depth 1
```

**验证要点**：
- [ ] `depth=1` 只返回一级子节点

---

## 7. get-module-info：读取本地 KB

### 7.1 查询已有 Relation

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  get-module-info --scope e2e-test \
  --group "TestWiki/API 参考" \
  --relation "用户认证"
```

**预期输出**：

查询已存在的 Relation 时，输出为纯文本格式的 module-info 内容，而非 JSON。

**验证要点**：
- [ ] 输出包含完整的 Markdown 原文
- [ ] 内容与 mock-wiki 中的源文件一致

### 7.2 查询不存在的 Relation

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  get-module-info --scope e2e-test \
  --group "TestWiki/API 参考" \
  --relation "不存在的模块"
```

**预期输出**：`ok: false`，提示未找到

**验证要点**：
- [ ] 返回错误信息，不崩溃

---

## 8. sync-relation：关系写入

### 8.1 单条写入

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  sync-relation \
  --scope e2e-test \
  --group "TestWiki/部署指南" \
  --relation "Kubernetes 部署" \
  --keywords "K8s,容器编排,Deployment" \
  --module-info "# Kubernetes 部署\n\n使用 kubectl apply 部署应用到 K8s 集群。"
```

**预期输出**：

```json
{
  "ok": true,
  "group": "TestWiki/部署指南",
  "relation": "Kubernetes 部署",
  "keywords": ["K8s", "容器编排", "Deployment"]
}
```

**验证要点**：
- [ ] 返回 `ok: true`
- [ ] 新 relation 已写入 relations-cache.json
- [ ] 新关键词已合并到 Group keywords

### 8.2 批量写入

创建批量输入文件：

```bash
cat > /tmp/ki-batch-input.json << 'EOF'
{
  "scope": "e2e-test",
  "items": [
    {
      "group": "TestWiki/常见问题",
      "relation": "性能优化",
      "keywords": ["性能", "优化", "缓存"],
      "moduleInfo": "# 性能优化\n\n常见性能问题及优化策略。"
    },
    {
      "group": "TestWiki/常见问题",
      "relation": "日志排查",
      "keywords": ["日志", "排查", "debug"],
      "moduleInfo": "# 日志排查\n\n如何通过日志定位问题。"
    }
  ]
}
EOF
```

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  sync-relation --input /tmp/ki-batch-input.json
```

**预期输出**：批量结果，2 条均成功

**验证要点**：
- [ ] 2 条均返回 `ok: true`
- [ ] relations-cache.json 中"常见问题"组新增 2 条 relation

### 8.3 Wiki 写回（需配置 wikiSync）

wikiSync 是 **scope 级配置**，需要在 `scopes.{scope}.wikiSync` 中设置：

```bash
cat > /tmp/ki-e2e-test/.ki/config.json << 'EOF'
{
  "dataDir": "/tmp/ki-e2e-test/kb",
  "scopes": {
    "e2e-test": {
      "wikiSync": {
        "enabled": true,
        "sourceDir": "/tmp/ki-e2e-test/wiki-output"
      }
    }
  }
}
EOF
```

> **注意**：如果 scope 已有 `source` 块（通过 scan-kb import 导入），wikiSync 不会生效，写回会直接写入 source 目录。wikiSync 仅对无 source 块的 scope（如纯 sync 场景）生效。

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  sync-relation \
  --scope e2e-test \
  --group "TestWiki/部署指南" \
  --relation "Helm Charts" \
  --keywords "Helm,Charts,K8s" \
  --module-info "# Helm Charts\n\n使用 Helm 管理 K8s 应用部署。"
```

**验证要点**：
- [ ] 返回中 `wikiSynced: true`
- [ ] `wikiFile` 路径非空
- [ ] `/tmp/ki-e2e-test/wiki-output/TestWiki/部署指南/Helm Charts.md` 文件已生成
- [ ] 文件包含 YAML frontmatter（group、relation、keywords）
- [ ] 文件包含正文内容

### 8.4 路径注入防护

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  sync-relation \
  --scope e2e-test \
  --group "TestWiki/部署指南" \
  --relation "../escape/hack" \
  --keywords "test" \
  --module-info "test"
```

**验证要点**：
- [ ] 返回 `wikiSynced: false`
- [ ] reason 包含"非法路径字符"

### 8.5 纯 sync-relation 场景（无外部 wiki 导入）

此场景模拟**不通过 scan-kb import 导入外部 wiki**，而是直接使用 sync-relation 从零构建知识库。覆盖两个子场景：先建节点再写入 vs 直接写入自动建节点。

> 使用独立 scope `e2e-pure-sync`，与前面的 `e2e-test` 隔离。

#### 8.5.1 子场景 A：先创建 Group 节点，再写入 Relation

```bash
CONFIG=/tmp/ki-e2e-test/.ki/config.json

# 先配置 wikiSync（方便观察写回效果）
cat > $CONFIG << 'EOF'
{
  "dataDir": "/tmp/ki-e2e-test/kb",
  "scopes": {
    "e2e-pure-sync": {
      "wikiSync": {
        "enabled": true,
        "sourceDir": "/tmp/ki-e2e-test/wiki-output"
      }
    }
  }
}
EOF

# 1. 手动创建根节点和子节点
node bin/ki.mjs --config $CONFIG \
  manage-index --scope e2e-pure-sync --action create --name "我的项目"

node bin/ki.mjs --config $CONFIG \
  manage-index --scope e2e-pure-sync --action create --parent "我的项目" --name "后端"

node bin/ki.mjs --config $CONFIG \
  manage-index --scope e2e-pure-sync --action create --parent "我的项目" --name "前端"

# 2. 写入第一条 Relation
node bin/ki.mjs --config $CONFIG \
  sync-relation \
  --scope e2e-pure-sync \
  --group "我的项目/后端" \
  --relation "用户注册接口" \
  --keywords "注册,用户,POST,邮箱" \
  --module-info "# 用户注册接口\n\nPOST /api/v1/users/register\n\n请求体：{ email, password, name }\n\n返回：{ userId, token }"

# 3. 写入第二条 Relation
node bin/ki.mjs --config $CONFIG \
  sync-relation \
  --scope e2e-pure-sync \
  --group "我的项目/后端" \
  --relation "数据库设计" \
  --keywords "数据库,PostgreSQL,表结构" \
  --module-info "# 数据库设计\n\n使用 PostgreSQL，核心表：users、orders、products。"

# 4. 写入前端组的 Relation
node bin/ki.mjs --config $CONFIG \
  sync-relation \
  --scope e2e-pure-sync \
  --group "我的项目/前端" \
  --relation "组件库" \
  --keywords "组件,React,UI" \
  --module-info "# 组件库\n\n基于 React + Ant Design 的通用组件库。"
```

**观察与验证**：

```bash
PURE_DIR="/tmp/ki-e2e-test/kb/e2e-pure-sync"

# 查看 Group 树
cat "$PURE_DIR/group-index.json" | python3 -m json.tool

# 查看 Relations 缓存
cat "$PURE_DIR/relations-cache.json" | python3 -m json.tool

# 查看 local KB
cat "$PURE_DIR/我的项目/后端/index.json" | python3 -m json.tool

# 查看 Wiki 写回文件
find /tmp/ki-e2e-test/wiki-output -name "*.md" | sort
```

**验证要点**：
- [ ] 返回 `ok: true`（3 条均成功）
- [ ] 每条返回 `wikiSynced: true`
- [ ] group-index.json 中 groups 树包含 `我的项目 → {后端, 前端}`
- [ ] relations-cache.json 中 "我的项目/后端" 组有 2 条 hot_relations
- [ ] relations-cache.json 中 "我的项目/前端" 组有 1 条 hot_relation
- [ ] 关键词已正确合并到各 Group 的 keywords 中
- [ ] local KB `我的项目/后端/index.json` 包含 "用户注册接口" 和 "数据库设计" 两个 key
- [ ] Wiki 目录下生成 3 个 .md 文件，路径分别为 `我的项目/后端/用户注册接口.md` 等
- [ ] Wiki 文件包含 YAML frontmatter（group、relation、keywords）
- [ ] Wiki 文件正文为模块信息原文

#### 8.5.2 子场景 B：不创建根节点，直接 sync-relation（自动补建）

```bash
CONFIG=/tmp/ki-e2e-test/.ki/config.json

# 不做任何 manage-index 操作，直接写入一个全新 scope
node bin/ki.mjs --config $CONFIG \
  sync-relation \
  --scope e2e-auto-create \
  --group "运维手册/监控告警" \
  --relation "Prometheus 配置" \
  --keywords "Prometheus,监控,告警,指标" \
  --module-info "# Prometheus 配置\n\n使用 Prometheus + Alertmanager 搭建监控告警体系。\n\n## 指标采集\n\n- CPU / 内存 / 磁盘\n- HTTP 请求延迟\n- 业务自定义指标"
```

**观察与验证**：

```bash
AUTO_DIR="/tmp/ki-e2e-test/kb/e2e-auto-create"

# 查看 Group 树（应自动创建了 "运维手册" 和 "监控告警" 两个节点）
cat "$AUTO_DIR/group-index.json" | python3 -m json.tool

# 查看 Relations 缓存
cat "$AUTO_DIR/relations-cache.json" | python3 -m json.tool

# 查看 local KB
cat "$AUTO_DIR/运维手册/监控告警/index.json" | python3 -m json.tool

# 查看 Wiki 写回
find /tmp/ki-e2e-test/wiki-output -path "*/运维手册*" -name "*.md"
```

**验证要点**：
- [ ] 返回 `ok: true`（即使从未 manage-index，也能成功）
- [ ] group-index.json 自动创建了 "运维手册" 和 "运维手册/监控告警" 节点
- [ ] relations-cache.json 包含 "运维手册/监控告警" 组及 "Prometheus 配置" relation
- [ ] local KB `运维手册/监控告警/index.json` 包含模块信息
- [ ] Wiki 写回文件已生成在 `/tmp/ki-e2e-test/wiki-output/运维手册/监控告警/Prometheus 配置.md`

#### 8.5.3 对比观察总结

| 观察维度 | 子场景 A（先建节点） | 子场景 B（自动补建） |
|----------|---------------------|---------------------|
| group-index.json | 节点预先存在，sync 只写入 relation | 节点由 sync-relation 自动创建 |
| relations-cache.json | 正常写入 | 正常写入（与 A 一致） |
| local KB | 正常写入 | 正常写入（与 A 一致） |
| Wiki 写回 | 正常写回 | 正常写回（与 A 一致） |
| source 块 | 无（非 scan-kb import 不会写 source） | 无 |

**关键结论**：sync-relation 不依赖 scan-kb import 预先初始化，可独立从零构建知识库。两种方式产出的数据结构完全一致，唯一区别是 source 块（仅 scan-kb import 写入）。

## 9. search：语义搜索

> 需要 memory 服务可用，否则跳过此测试

### 9.1 基础搜索

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  search --scope e2e-test --query "用户怎么登录系统"
```

**验证要点**：
- [ ] 返回结果中应包含与"用户认证"相关的条目
- [ ] 结果含 `score`、`text`、`scope` 等字段

### 9.2 带阈值搜索

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  search --scope e2e-test --query "Docker 容器部署" --threshold 0.5
```

**验证要点**：
- [ ] 结果的 `score` 均 >= 0.5

### 9.3 限制返回数量

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  search --scope e2e-test --query "API 接口" --limit 3
```

**验证要点**：
- [ ] 结果最多 3 条

---

## 10. export：反向导出

将 KB 数据反向导出为 Wiki Markdown 文件。

### 10.1 导出全部

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  export e2e-test --output /tmp/ki-e2e-export
```

**预期输出**：

```json
{
  "ok": true,
  "action": "export",
  "scope": "e2e-test",
  "outputDir": "/tmp/ki-e2e-export",
  "stats": {
    "total": 12,
    "exported": 12,
    "empty": 0
  },
  "skipped": []
}
```

**验证要点**：
- [ ] `ok: true`
- [ ] `stats.total` 等于 relations-cache 中的总 relation 数
- [ ] `stats.exported` 等于 total（local KB 中有内容的条目）
- [ ] `/tmp/ki-e2e-export/` 下生成 Markdown 文件
- [ ] 目录结构与 Group 树一致
- [ ] 每个文件包含 YAML frontmatter（group、relation、keywords、exportedAt）
- [ ] 正文为 local KB 中的原文内容

### 10.2 检查导出文件格式

```bash
ls -R /tmp/ki-e2e-export/
head -20 "/tmp/ki-e2e-export/TestWiki/API 参考/用户认证.md"
```

**验证要点**：
- [ ] frontmatter 含 `group`、`relation`、`keywords`、`exportedAt`
- [ ] keywords 为 YAML 数组格式
- [ ] 正文与 mock-wiki 原文一致

---

## 11. scan-kb diff：增量差异检测

> 此步骤需在全量导入后、mock-wiki 有新 commit 时才能产生 diff

### 11.1 在 mock-wiki 中制造变更

```bash
MOCK_WIKI=$(realpath test/fixtures/mock-wiki)

# 新增一个文件
echo "# API 网关\n\n网关层统一入口管理。" > "$MOCK_WIKI/API 参考/API 网关.md"

# 修改一个文件
echo "\n\n## 限流策略\n\n支持令牌桶和滑动窗口两种限流算法。" >> "$MOCK_WIKI/API 参考/数据查询.md"

# 提交变更
cd "$MOCK_WIKI" && git add -A && git -c commit.gpgsign=false commit -m "add: API 网关 + 限流策略" && cd -
```

### 11.2 执行 diff

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  scan-kb diff --scope e2e-test
```

**预期输出**：

```json
{
  "ok": true,
  "action": "diff",
  "scope": "e2e-test",
  "baseCommit": "dade327...",
  "headCommit": "5d860f...",
  "sourceDir": "/absolute/path/to/mock-wiki",
  "rootName": "TestWiki",
  "added": [
    { "path": "API 参考/API 网关.md", "absPath": "..." },
    ...
  ],
  "modified": [
    { "path": "API 参考/数据查询.md", "absPath": "...", "memoryId": "unknown" }
  ],
  "deleted": [],
  "stats": {
    "added": 6,
    "modified": 1,
    "deleted": 0,
    "total": 7
  }
}
```

> **注意**：实际输出中 `added` 和 `modified` 数组的元素是对象 `{ path, absPath }`，不是纯字符串。`stats.added` 可能大于手动新增的文件数，因为它包含 source commit 之后所有新增的文件。

**验证要点**：
- [ ] `ok: true`
- [ ] `added` 数组包含新增的文件路径
- [ ] `modified` 数组包含修改的文件路径
- [ ] `deleted` 为空

---

## 12. scan-kb import --mode incremental：增量导入

### 12.1 准备增量 ai-results

增量导入需要全量导入返回的真实 memoryId。从全量导入结果中提取：

```bash
# 方法一：从 relations-cache.json 中提取
KB_DIR="/tmp/ki-e2e-test/kb/e2e-test"

# 查看数据查询的 memoryId
python3 -c "
import json
data = json.load(open('$KB_DIR/relations-cache.json'))
for g in data['groups'].values():
    for r in g.get('hot_relations', []):
        if r['text'] == '数据查询':
            print(r.get('memoryId', 'N/A'))
"
```

将提取到的 memoryId 填入 `ai-results-incremental.json`（替换 `PLACEHOLDER_FULL_IMPORT`）：

```bash
MEMORY_ID="<上一步提取的值>"

# 复制模板并替换占位符
cp test/fixtures/ai-results-incremental.json /tmp/ki-ai-results-inc.json
sed -i "s/PLACEHOLDER_FULL_IMPORT/$MEMORY_ID/g" /tmp/ki-ai-results-inc.json

# 为 delete 条目提取"安装问题"的 memoryId
DELETE_ID=$(python3 -c "
import json
data = json.load(open('$KB_DIR/relations-cache.json'))
for g in data['groups'].values():
    for r in g.get('hot_relations', []):
        if r['text'] == '安装问题':
            print(r.get('memoryId', ''))
            break
")
# 如果两个条目 memoryId 不同，手动处理第二个
# 此处简化处理：使用同一个值（实际场景中每个条目有独立 memoryId）
```

> **注意**：实际测试中 modify 和 delete 条目的 memoryId 各不相同，需分别提取。上面是简化流程。

### 12.2 执行增量导入

```bash
MOCK_WIKI=$(realpath test/fixtures/mock-wiki)

node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  scan-kb import \
  --scope e2e-test \
  --results /tmp/ki-ai-results-inc.json \
  --mode incremental \
  --source-dir "$MOCK_WIKI"
```

**预期输出**：

```json
{
  "ok": true,
  "action": "import",
  "mode": "incremental",
  "stats": {
    "added": 1,
    "modified": 1,
    "deleted": 1,
    "unchanged": 7
  }
}
```

**验证要点**：
- [ ] `ok: true`
- [ ] `stats.added` = 1（权限管理.md）
- [ ] `stats.modified` = 1（数据查询.md 摘要更新）
- [ ] `stats.deleted` = 1（安装问题.md 移除）
- [ ] group-index.json 中"常见问题"组无"安装问题"子节点
- [ ] "API 参考"组新增"权限管理"节点
- [ ] relations-cache.json 中"数据查询"的 summary 已更新

---

## 13. backup / restore：备份还原

### 13.1 备份

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  backup e2e-test
```

**预期输出**：`ok: true`，含 snapshot 路径

**验证要点**：
- [ ] 返回 `ok: true`
- [ ] 备份目录下生成 `.tar.gz` 文件

### 13.2 列出备份

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  backup e2e-test --list
```

**验证要点**：
- [ ] 列出刚才创建的备份记录

### 13.3 还原

```bash
node bin/ki.mjs --config /tmp/ki-e2e-test/.ki/config.json \
  restore e2e-test --from-snapshot --yes
```

**验证要点**：
- [ ] 返回成功
- [ ] scope 数据已恢复到备份时的状态

---

## 14. 清理

测试完成后清理临时数据：

```bash
rm -rf /tmp/ki-e2e-test
rm -rf /tmp/ki-e2e-export
rm -f /tmp/ki-batch-input.json
rm -f /tmp/ki-ai-results-inc.json

# 恢复 mock-wiki 到初始状态（移除测试中新增的文件）
MOCK_WIKI=$(realpath test/fixtures/mock-wiki)
cd "$MOCK_WIKI" && git checkout . && git clean -fd && cd -

# 清理纯 sync 场景的 wiki 输出
rm -rf /tmp/ki-e2e-test/wiki-output
```

---

## 15. 测试检查清单

### 完整功能矩阵

| # | 命令 | 场景 | 状态 |
|---|------|------|------|
| 1 | `config init` | 生成配置模板 | [ ] |
| 1a | 手动修改 dataDir | 隔离测试数据目录 | [ ] |
| 2 | `manage-index --action list-scopes` | 空列表 | [ ] |
| 3 | `scan-kb import --mode full` | 全量导入 7 条 | [ ] |
| 4 | `manage-index --action list-scopes` | 包含 e2e-test | [ ] |
| 5 | `manage-index --action create` | 创建子 Group | [ ] |
| 6 | `manage-index --action delete` | 删除空 Group | [ ] |
| 7 | `query-group --groups` | 单 Group 查询 | [ ] |
| 8 | `query-group --groups` | 多 Group 查询 | [ ] |
| 9 | `query-group --mode full` | 完整分区 | [ ] |
| 10 | `query-group --depth 1` | 深度限制 | [ ] |
| 11 | `get-module-info` | 读取已有 Relation | [ ] |
| 12 | `get-module-info` | 读取不存在的 Relation | [ ] |
| 13 | `sync-relation` | 单条写入 | [ ] |
| 14 | `sync-relation --input` | 批量写入 | [ ] |
| 15 | `sync-relation` + wikiSync | Wiki 写回 | [ ] |
| 16 | `sync-relation` | 路径注入防护 | [ ] |
| 16a | `manage-index create` + `sync-relation` | 纯 sync：先建节点再写入（3 条） | [ ] |
| 16b | `sync-relation`（无前置操作） | 纯 sync：自动补建节点 + Wiki 写回 | [ ] |
| 17 | `search` | 语义搜索 | [ ] |
| 18 | `search --threshold` | 带阈值搜索 | [ ] |
| 19 | `export` | 反向导出为 Markdown | [ ] |
| 20 | `scan-kb diff` | 增量差异检测 | [ ] |
| 21 | `scan-kb import --mode incremental` | 增量导入（add/modify/delete） | [ ] |
| 22 | `backup` | 创建备份快照 | [ ] |
| 23 | `backup --list` | 列出备份 | [ ] |
| 24 | `restore --from-snapshot` | 从快照还原 | [ ] |

### 数据完整性检查点

| 检查点 | 文件 | 关键字段 |
|--------|------|----------|
| Group 树完整 | group-index.json | groups 层级正确 |
| source 块记录 | group-index.json | source.{dir,rootName,commit} |
| Relation 写入 | relations-cache.json | hot_relations 含 isImported/memoryId |
| 关键词合并 | relations-cache.json | keywords 去重且非空 |
| local KB 存在 | kb/{scope}/**/index.json | 每个 Group 有 index.json |
| local KB 内容 | kb/{scope}/**/index.json | 内容为原始 Markdown |
| Wiki 写回文件 | wikiSync.dir | frontmatter 格式正确 |
| 自动补建节点 | group-index.json | 无前置操作时 sync-relation 自动创建 Group 路径 |
| 纯 sync 无 source | group-index.json | sync-relation 创建的 scope 无 source 块 |

---

## 附录：快速一键验证脚本

如果只想快速跑一遍核心流程（非逐项验证），可执行：

```bash
#!/bin/bash
set -e
cd /root/knowledge-indexer

MOCK_WIKI=$(realpath test/fixtures/mock-wiki)
CONFIG=/tmp/ki-e2e-test/.ki/config.json

# 初始化
mkdir -p /tmp/ki-e2e-test
node bin/ki.mjs config init --dir /tmp/ki-e2e-test

# 修改 dataDir 为隔离目录
sed -i 's|"dataDir": "/root/.ki-data"|"dataDir": "/tmp/ki-e2e-test/kb"|' $CONFIG

# 全量导入
node bin/ki.mjs --config $CONFIG scan-kb import \
  --scope e2e-test --results test/fixtures/ai-results-full.json \
  --source-dir "$MOCK_WIKI"

# 查询
node bin/ki.mjs --config $CONFIG query-group --scope e2e-test --groups "TestWiki"

# 读取 KB
node bin/ki.mjs --config $CONFIG get-module-info --scope e2e-test \
  --group "TestWiki/API 参考" --relation "用户认证"

# 写入 relation
node bin/ki.mjs --config $CONFIG sync-relation --scope e2e-test \
  --group "TestWiki/部署指南" --relation "CI/CD" \
  --keywords "CI,CD,自动化" --module-info "# CI/CD\n持续集成持续部署。"

# 导出
node bin/ki.mjs --config $CONFIG export e2e-test --output /tmp/ki-e2e-export

echo "=== 快速验证完成 ==="
echo "临时数据目录: /tmp/ki-e2e-test"
echo "导出目录: /tmp/ki-e2e-export"
```
