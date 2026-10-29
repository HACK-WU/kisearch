# 知识库验证

确认一次导入或写入后，数据真的落到该落的地方。按「scope → 结构 → Relation → 原文 → 检索」逐层往下查，哪一层先空就从那里排。

## 1. scope 层

```bash
ki scope list
```

看目标 scope 的 `kb` / `vector` / `registered` 三个标记：

- `kb: true` —— 本地 KB 目录存在
- `vector: true` —— 向量层有该 scope 的 collection
- `registered: true` —— 已在 `config.scopes` 注册（`scopeMode: default` 下未注册也能自动创建）

## 2. 结构层

```bash
ki group list --scope <scope> --mode full
```

预期：出现导入时指定的 Group 路径；节点带 score 与分区标签（`[热]` / `[常温]` / `[冷]` / `[新兴热]` / `[📥]`）。`full` 模式每区最多渲染 50 条，超出会提示「还有 N 个未展示」，属正常。

## 3. Relation 层

```bash
ki group list --scope <scope> --groups "项目/API"
```

预期：列出该组的 Relation、评分与分区。若组存在但列表为空，通常是导入时没有写 relations 元数据（检查导入是否真的执行成功）。

## 4. 原文层

```bash
# 单条
ki get-module-info --scope <scope> --group "项目/API" --relation "用户登录接口"

# 批量（逗号分隔，≤10 条且须同 Group）
ki get-module-info --scope <scope> --group "项目/API" --relation "用户登录接口,鉴权中间件"
```

预期：输出 Markdown 原文，内容与导入/写入时一致，无乱码与截断。

## 5. 检索层

```bash
# 语义 + 全文
ki search "用户登录流程" -s <scope>

# 只查全文（不调用 embedding，可用于排查向量层）
ki search "用户登录流程" -s <scope> --mode fulltext
```

预期：

- `hybrid` 与 `fulltext` 都能命中同一条内容；
- 结果带 `group` / `relation` 定位字段；
- 若 `hybrid` 结果里出现 `degraded: true`，说明查询 embedding 超时已降级，分数是 BM25 量级，不代表索引坏了。

## 6. 向量层计数

```bash
ki doc list --scope <scope> --limit 5    # 向量文档（示例：取前 5 条）
ki tag list --scope <scope>              # 该 scope 出现过的 tag 及文档数
```

> `ki doc list` 只反映向量层，不含 `--no-vector` 导入的文档；后者用 `ki search --mode fulltext` 验证。

## 一次性验证脚本

```bash
#!/bin/bash
set -e
SCOPE=$1; GROUP=$2; RELATION=$3; QUERY=$4

echo "=== 1. scope ===";      ki scope list
echo "=== 2. 结构 ===";       ki group list --scope "$SCOPE" --mode full
echo "=== 3. Relation ===";   ki group list --scope "$SCOPE" --groups "$GROUP"
echo "=== 4. 原文 ===";       ki get-module-info --scope "$SCOPE" --group "$GROUP" --relation "$RELATION"
echo "=== 5. 检索 ===";       ki search "$QUERY" -s "$SCOPE"
echo "=== 6. 向量层 ===";     ki doc list --scope "$SCOPE" --limit 5
```

## 检查清单

首次导入后：

- [ ] `ki scope list` 中目标 scope 的 `kb` 为 true
- [ ] Group 树包含预期的目录结构
- [ ] 目标 Group 下的 Relation 数量与文件数一致
- [ ] 抽 1~2 篇 `ki get-module-info` 内容完整
- [ ] `ki search` 能命中刚导入的内容
- [ ] 没有预期之外的同名副本（同名冲突策略见 [import.md](./import.md)）

增量更新后：

- [ ] 修改的文件内容已更新
- [ ] 新增的文件出现在 Relation 列表
- [ ] 删除的文件不再出现在列表与检索结果
- [ ] 内容未变的文件没有被重复向量化（导入结果 `stats.files.unchanged`）

## 常见问题

| 现象 | 可能原因 | 排查 |
|---|---|---|
| Group 树为空 | scope 写错 / 导入失败 | 看导入命令的 `ok` 与 `errors`；确认 `--scope` 拼写 |
| Relation 列表为空 | 元数据未写入 | 检查导入是否带 `--no-vector`（该模式只写全文索引） |
| 原文缺失 | 本地 KB 未写入 | 检查导入日志；用 `ki sync-relation` 补写 |
| 检索无结果 | 只用了语义路 | 加 `--mode fulltext`；或降低 `--threshold` |
| 检索命中但无原文 | 未传 `--original` | 加 `--original` |
| 增量更新没生效 | 文件内容未变 / 冲突策略为 skip | 看导入结果的 `unchanged` 与 `conflicts` |

## 相关文档

- [import.md](./import.md) —— 导入参数与幂等语义
- [query-kb.md](./query-kb.md) —— 查询的三条路径
- [error-handling.md](./error-handling.md) —— 完整报错清单
- [backup-restore.md](./backup-restore.md) —— 数据损坏时的恢复方式
