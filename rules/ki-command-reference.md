# ki 命令参考

> 本文件是 `ai-codekb-memory-rules` 和 `ai-memory-system-rules` 的公共命令参考。
> 各规则文件通过引用本文件获取命令语法，自身专注行为逻辑。

---

## 公共命令

以下命令的 `<scope>` 为占位符，各规则替换为实际 scope 值：

| 规则 | scope 值 |
|------|----------|
| ai-codekb-memory-rules | `${scope}` |
| ai-memory-system-rules（项目记忆） | `${scope}-memory` |
| ai-memory-system-rules（用户画像） | `user-profile` |

### 1. 拉取全景索引

```bash
ki query-group --scope <scope> --mode full
```

**用途**：获取 scope 下所有 Group 的索引树和热度信息。

**输出示例**：

```
=== 知识索引 [scope: my-project] ===

📁 完整索引树:
my-project/ (score: 25.2) [热]
├── API/ (score: 15.5) [热]
│   ├── 用户管理/ (score: 8.5) [热]
│   └── 文件操作/ (score: 4.8) [常温]
├── 前端/ (score: 6.2) [热]
└── 部署/ (score: 3.2) [常温]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

---

### 2. 查 Group 热区

```bash
ki query-group --scope <scope> --groups "目标Group路径" --mode hot,emerging
```

**用途**：查看指定 Group 下的热门知识和新兴热区（近 48 小时内频繁使用的知识）。

**输出示例**：

```
=== my-project/API ===

🔥 热门知识 (Top 3):
├── 用户登录接口 (score: 8.5) [热]
├── 数据查询接口 (score: 6.2) [热]
└── 文件上传接口 (score: 4.8) [常温]

🏷️ 关键词词云:
└── 登录, 认证, token, 查询, 上传
```

---

### 3. 取原文

```bash
ki get-module-info --scope <scope> --group "目标Group路径" --relation "Relation名称"
```

**用途**：获取指定 Relation 的完整 Markdown 原文。

**注意**：Agent 必须提炼后回答，不要全文转储。

---

### 4. 单条写入

```bash
ki sync-relation \
  --scope <scope> \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容" \
  --keywords "关键词1,关键词2,关键词3"
```

**用途**：向指定 Group 写入一条知识条目。

**真实输出示例**：

```json
{
  "ok": true,
  "relation": "agent-rule-体验测试条目",
  "keywords": ["测试", "agent-rule", "体验"],
  "invalid_keywords": [],
  "evicted": null
}
```

**`sync-relation` 同名覆盖**：Relation 名称相同时，自动覆盖原有内容。

---

### 5. 管理 Group

```bash
# 创建 Group
ki manage-index --scope <scope> --action create --parent "父Group路径" --name "新Group名"

# 删除 Group（含子数据）
ki manage-index --scope <scope> --action delete --parent "父Group路径" --name "目标Group名" --force
```

**输出示例**：

```json
{ "ok": true, "path": "父Group路径/新Group名" }
```

**`--force` 会删除 Group 以及所有子 Relation。**

---

## Keywords 规则

所有 `ki sync-relation` 写入时必须遵守：

- 必须是**自然语言词汇**，禁止代码符号（类名、方法名、路径）
- 必须真实出现在 `module-info` 原文中
- 3~5 个为宜

---

## 常见错误与修复

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope not found` | scope 尚未创建 | 先执行 `ki sync-relation` 写入任意一条数据自动创建 scope |
| Group 不存在 | 尚未创建该 Group | 执行 `ki manage-index --action create` 创建 |
| `keywords` 被拒绝 | 包含代码符号或未出现在原文中 | 改用自然语言词，确认词在 module-info 中真实存在 |
| `${scope}` 仍是字面量 | 用户未指定 scope | 暂停，先问用户确认 scope |
| Relation 名称与预期不符 | 使用了错误的名称 | 用 `ki query-group --mode full` 确认实际名称 |
| 写入到错误的 scope | 混淆了 scope | 确认写入目标 scope 是否正确 |

---

## 写入后刷新缓存

每次写入操作（`sync-relation` / `scan-kb import` / `manage-index create`）完成后，必须重新拉取全景：

```bash
ki query-group --scope <scope> --mode full
```

> 本文件仅定义命令语法和通用规则。各命令的使用时机、判断流程、禁忌清单等行为逻辑由各规则文件（`ai-codekb-memory-rules.md` / `ai-memory-system-rules.md`）定义。
