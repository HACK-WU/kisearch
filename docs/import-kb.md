## `import-kb` 使用说明

`import-kb.ts` 是旧版外部知识库导入脚本，**已被 `scan-kb import` 统一流程替代**（S-04）。

> **@deprecated** 请使用 `scan-kb.ts import` 子命令。`import-kb.ts` 保留兼容但不再推荐。

---

## 新流程（推荐）

### 首次导入（2 步）

1. AI 生成 `ai-results.json`（含 `meta: { sourceDir, rootName }` + `entries[]`）
2. 执行：

```bash
npx jiti scripts/scan-kb.ts import \
  --scope my-project \
  --results ai-results.json
```

### 增量更新（3 步）

1. `scan-kb diff --scope my-project` → 输出变更文件列表（含 `memoryId`）
2. AI 根据 diff 生成增量 `ai-results.json`（每条带 `action: 'add' | 'modify' | 'delete'`）
3. `scan-kb import --scope my-project --mode incremental --results ai-results.json`

详见：[`scan-kb.md`](./scan-kb.md)

---

## 旧流程（仍可用）

### 约定模式

```bash
npx jiti scripts/import-kb.ts \
  --scope <scope> --source <dir> --root-name <name>
```

目录 → Group，文件名 → Relation，文件内容 → `module-info`。

### 配置模式

```bash
npx jiti scripts/import-kb.ts \
  --scope <scope> --source <dir> \
  --mapping <jsonFile> --root-name <name>
```

#### `mapping.json` 格式

```json
{
  "root_name": "项目知识库",
  "groups": [
    {
      "path": "API/认证",
      "sources": [
        {
          "file": "docs/api/login.md",
          "relation": "用户登录接口",
          "code_refs": ["src/api/auth.ts"]
        }
      ]
    }
  ]
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `root_name` | string | 可选，覆盖 `--root-name` |
| `groups[].path` | string | 相对根节点的 Group 路径（不含根名） |
| `groups[].sources[].file` | string | 相对 `--source` 的文件路径 |
| `groups[].sources[].relation` | string | 导入后的 Relation 名称 |
| `groups[].sources[].code_refs` | string[] | 可选，追加到 `module-info` 末尾 |

### 重要说明

- `groups[].path` 不要重复写根名
- `root_name` 会覆盖命令行 `--root-name`
- `code_refs` 以"代码定位"小节追加到原文末尾
- 关键词需通过 `--scan-index` 从 `scan-index.json` 复用，`import-kb.ts` 自身不生成关键词

---

## 相关文档

- 新流程详细说明：[`scan-kb.md`](./scan-kb.md)
- 典型工作流：[`workflows.md`](./workflows.md)
