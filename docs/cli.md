## CLI 参考

所有脚本都位于 `scripts/`，通过 `npx jiti` 执行。

---

## `scan-kb.ts`（统一入口）

### `import` 子命令（推荐）

统一导入外部知识库，首次全量或增量更新。

```bash
npx jiti scripts/scan-kb.ts import \
  --scope <scope> \
  --results <ai-results.json> \
  [--mode full|incremental] \
  [--source-dir <dir>] \
  [--root-name <name>] \
  [--mapping <jsonFile>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 是 | 项目隔离标识 |
| `--results` | 是 | `ai-results.json` 路径 |
| `--mode` | 否 | `full`（默认）或 `incremental` |
| `--source-dir` | 否 | 覆盖 `meta.sourceDir` |
| `--root-name` | 否 | 覆盖 `meta.rootName` |
| `--mapping` | 否 | mapping 文件（配置模式） |

首次全量：5 阶段流水线（校验 → 向量化 → Group 树 → 缓存写入 → source 记录）。

增量更新：按 `action` 分三类处理：
- `add`：新增 → 向量化 + 写入索引
- `modify`：`mem delete <oldId>` + 重新向量化 + 替换索引
- `delete`：`mem delete <oldId>` + 移除索引

### `diff` 子命令

检测自上次导入以来的变更。

```bash
npx jiti scripts/scan-kb.ts diff \
  --scope <scope> \
  [--output <file>]
```

输出 `{ added, modified, deleted }` 列表，`modified`/`deleted` 条目携带 `memoryId`。

### `scan` 子命令（旧流程，保留兼容）

```bash
npx jiti scripts/scan-kb.ts scan \
  --scope <scope> --source <dir> --root-name <name> \
  [--results <ai-results.json>]
```

### `vectorize` 子命令（DEPRECATED）

```bash
npx jiti scripts/scan-kb.ts vectorize --scope <scope>
npx jiti scripts/scan-kb.ts vectorize \
  --scope <scope> --complete <vectorize-results.json>
```

> 已废弃。`import` 子命令内部集成批量向量化。

---

## `manage-index.ts`

管理 Group 树索引节点。

```bash
npx jiti scripts/manage-index.ts \
  --scope <scope> --action create-root --root-name <name>

npx jiti scripts/manage-index.ts \
  --scope <scope> --action create --parent <path> --name <name>

npx jiti scripts/manage-index.ts \
  --scope <scope> --action delete --parent <path> --name <name> [--force]
```

## `query-group.ts`

查询 Group 树、热门 Relation 和关键词词云。

```bash
npx jiti scripts/query-group.ts --scope <scope>
npx jiti scripts/query-group.ts --scope <scope> --groups "项目/API"
npx jiti scripts/query-group.ts --scope <scope> --mode hot
npx jiti scripts/query-group.ts --scope <scope> --partition warm
```

## `get-module-info.ts`

按 Group + Relation 读取本地 KB 中的 Markdown 原文。

```bash
npx jiti scripts/get-module-info.ts \
  --scope <scope> --group <group> --relation <relation>
```

## `sync-relation.ts`

把 Relation 和模块说明写入本地索引。

```bash
npx jiti scripts/sync-relation.ts \
  --scope <scope> --group <group> \
  --relation <text> --module-info <markdown> --keywords <k1,k2>

npx jiti scripts/sync-relation.ts \
  --scope <scope> --input <jsonFile>
```

### 关键词约束

- 关键词必须是自然语言词汇
- 关键词必须真实出现在 `module-info` 原文中
- 未出现在原文中的关键词会被判为无效

## `import-kb.ts`（@deprecated）

旧版外部知识库导入脚本，已被 `scan-kb import` 替代。

```bash
npx jiti scripts/import-kb.ts \
  --scope <scope> --source <dir> --root-name <name>

npx jiti scripts/import-kb.ts \
  --scope <scope> --source <dir> \
  --mapping <jsonFile> --root-name <name>
```

详见：[`import-kb.md`](./import-kb.md)

---

## 常用工作流

### 本地知识沉淀

1. `manage-index.ts` 创建 Group
2. `sync-relation.ts` 写入模块说明
3. `query-group.ts` 检查导航与热点
4. `get-module-info.ts` 验证原文可读性

### 外部知识库导入（推荐新流程）

1. AI 生成 `ai-results.json`
2. `scan-kb import --scope <s> --results <f>`

### 增量更新

1. `scan-kb diff --scope <s>`
2. AI 生成增量 `ai-results.json`
3. `scan-kb import --scope <s> --mode incremental --results <f>`
