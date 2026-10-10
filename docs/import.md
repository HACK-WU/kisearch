## `ki import` 使用说明

`src/import.ts` 实现外部 Markdown Wiki 导入（幂等追加）。**扁平命令，无子命令层级**。

> 历史（2026-09-07）：由 `ki scan-kb import` 扁平化为 `ki import`——scan-kb 壳下仅存 `import` 一个子命令，层级冗余；且 `bin/ki.mjs` 的命令映射是单级扁平结构（会剥掉子命令名），与 commander 嵌套子命令不兼容。**scan-kb 已移除、不保留兼容别名**，旧调用 `ki scan-kb import ...` 会 fail-loud 报「未知命令」并列出全部可用命令。
>
> 历史（更早）：`--mode incremental`（git diff 驱动）与 `diff` 子命令已废弃移除。增量更新由「幂等追加」语义天然承载——重复执行 `ki import` 即同步变更（同文件覆盖更新、新文件导入、同名文件按冲突策略处理），不再依赖 git。

---

## 用法

### 幂等追加导入

```bash
ki import \
  --scope my-project \
  --source /path/to/wiki \
  --group wiki \
  [--chunk-size 1000] \
  [--chunk-overlap 150] \
  [--tags t1,t2] \
  [--conflict-mode suffix] \
  [--conflict-suffix _{n}] \
  [--no-vector]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 否 | 项目隔离标识（default 模式缺省；strict 模式必填） |
| `--source` | 是（`--retry-incomplete` 时可省略） | Markdown 目录绝对路径；重试模式下缺省沿用上次导入记录的源目录 |
| `--group` | 否 | 目标 Group 落点（不存在时自动新建，含父路径，支持多级如 `wiki/部署运维`）。缺省时：目录导入按顶层子目录名各建根节点，单文档导入用 scope name |
| `--chunk-size` | 否 | 切分块大小（字符，默认 1000） |
| `--chunk-overlap` | 否 | 相邻 chunk 重叠（字符，默认 150） |
| `--tags` | 否 | 文档级自定义标签（逗号分隔）：为导入文件附加标签，每个 tag 各写一条内容向量，可被 `ki search -t <tag>` 召回；`--no-vector` 时仅持久化到 `relation.tags`（后续 `restore --rebuild-vector` 可恢复） |
| `--conflict-mode` | 否 | 同名文档处理策略，默认 **`incremental`**（增量导入：同 `sourcePath` 且内容未变则跳过重算；同名不同 `sourcePath` 与同批重复 rel 一律**直接覆盖**）；另有 `overwrite` 覆盖、`skip` 跳过、`suffix` 自动后缀 |
| `--conflict-suffix` | 否 | 自动后缀模板，必须包含且只能包含一个 `{n}`，默认 `_{n}`；例如 `-副本_{n}` |
| `--no-vector` | 否 | FTS-only 模式：不调用 embedding、不写 dense 向量；清洗后的 chunk 写入独立全文 Collection，`ki search --mode fulltext` 可召回；local KB 文件原文照写 |
| `--no-clean` | 否 | 关闭全部数据清洗（含外部 hooks，等价 config `clean.enabled:false`） |
| `--no-assets` | 否 | 关闭本地图片附件收集（等价 config `import.assets:false`；关闭后前端对图片引用显示占位块） |
| `--clean-rules` | 否 | 覆盖内置清洗规则开关：`bom,frontmatter,htmlComment,mermaid,codePath,codeBlock` |
| `--retry-incomplete` | 否 | **只重试上次未完成的文件**：读 `<scope>/.ki-import-incomplete.json`（上次部分成功时写入），只处理清单内文件——已完成文件不重传、不重算 embedding、不产生 `_1` 副本。可省略 `--source`（沿用记录的源目录）与切分/向量化/标签/冲突参数（命令行显式传参优先）|

### 幂等语义（重复执行 = 增量）

`import` 以 `(groupPath, relation名)` 为主键做幂等判定：

- **同 sourcePath 重导 + 内容未变**（默认 `incremental`）：**跳过重算**——不重切分、不调 embedding、不写向量、不重写原文；附件仍复制（同名先删后写）。判定全部本地计算：由本次清洗+切分结果推导的 dense docId 与全文 id 集合须与库中 `memoryIds`/`ftsIds` 完全一致（切分参数或清洗规则变化会被自动识别为「变了」）；不校验向量是否真实存在（丢失时用 `ki restore --rebuild-vector` 兜底）
- **同 sourcePath 重导 + 内容已变**：覆盖更新（local KB + 向量重建）
- **同名但 sourcePath 不同**（不同文件同名）：按 `--conflict-mode` 处理——默认（`incremental`）与 `overwrite` 都是**直接覆盖**（后者胜出，不留副本）；`suffix` 生成 `foo_1`、`foo_2`（目标名已占用时继续递增）；`skip` 跳过后者
- **新文件**：正常导入

> **入口路径口径**：Web 导入页（拖拽 / 目录选择器 / 目录回退）在上传前会**剥离被选目录的顶层段**，使 `sourcePath` 与 CLI `--source <目录>` 保持一致——同一目录无论从哪个入口导入，都是同一次幂等更新（否则会被当作全新文档，实测出现过文档翻倍）。

同一 `sourcePath` 始终优先命中已有 relation，因此即使该文档此前通过自动后缀导入，重复导入也会覆盖原逻辑 relation，不会继续产生新后缀。自动后缀只改变逻辑 relation 名，不改写 `sourcePath`。

向量更新为文档级增量：先写新内容/标签向量，确认成功后再清理受影响 relation 的旧向量；无关文档不参与删除。若本批导入的某个文件向量化失败，该文件回滚 local KB 并保留旧 relation/向量；全部文件失败时导入 fail-loud。（系统性故障下的整批提交语义见下节「部分成功可用与只重试未完成」。）

### 部分成功可用与「只重试未完成」（REQ-20261009-001）

**提交粒度 = 文件级**。系统性向量故障（provider 不可用、配额耗尽、维度不匹配等）不再把整批一起回滚：

- **已成功的文件**照常提交（local KB + 向量 + 元数据三处一致），导入结束后即可 `ki search` / `ki query-group` / Web 文档列表看到；
- **失败或未处理的文件**不写元数据、不留在文档列表，进入「未完成清单」；
- **全部文件都未完成**时仍是 fail-loud（`ok:false`），不做"零提交假成功"；
- 结果里新增 `partial`、`stats.files{total,completed,incomplete,scanned,skipped,unchanged}`（`unchanged` 是增量导入下「内容未变、跳过重算」的文件数，属 `completed` 的子集，恒等式不变）（恒等式 `completed + incomplete + skipped = scanned`）、`incomplete[]{path,group,relation,reason}`、`stopReason`（取消时 `cancelled:true`）；只重试子集时另有 `retryFilter{requested,matched,missing,invalid}`（`requested`=净化去重后的清单条数、`matched`=源目录命中并纳入本轮处理的条数、`missing`=源文件已删除/改名、`invalid`=被拒绝的非法路径：绝对路径 / 含 `..` / 空值或超长）；
- **CLI 部分成功 = 退出码 0 + stderr 警告块**（与 Web 任务 `partial` 同口径）；脚本要严格判定可读 JSON 的 `partial` 字段。

**未完成清单落盘**：部分成功时写入 `<scope>/.ki-import-incomplete.json`（含源目录、原批次参数、未完成项与停止原因）；全部完成时自动删除。它让「重试」跨进程/跨会话可用。

清单是 **scope 级单文件**：同一 scope 先后导入不同源目录时，覆盖/清除前会先把上一份备份为 `<scope>/.ki-import-incomplete.prev.json` 并打印告警（不静默丢弃上一批的未完成项）；`--retry-incomplete` 在「没有主清单但存在备份」时会提示备份的来源与条数，便于人工改名回收。清单写入失败（磁盘/权限）会**显式告警**——此时重试入口实际不可用，不能假设还有清单可读。

**辅助向量失败 = 降级，不进未完成清单**（标签向量、关系/路径导航向量）：这类向量可由 `ki rebuild-vector` 重建，且不影响文档正文的浏览与检索，因此它们失败**不会**把文件标为未完成，也不会回滚已写入的正文向量：

- 标签（`--tags`）向量阶段系统性停止 → 文件照常提交，`errors[]` 给出「标签向量写入失败…（不影响正文，可用 ki rebuild-vector 重建标签向量）」；`stopReason` 仍带回停止原因，`partial`/`files.incomplete` 不受影响；
- 关系/路径辅助向量停止 → 未写入的关系沿用**旧索引**（已存在文档的导航不出现空洞；本次新增的文档此时没有旧索引可沿用，语义兜底会缺失，可 `ki rebuild-vector` 补建），`errors[]` 记一条 `<ki-path/ki-relation>` 汇总；
- 只有**正文 chunk** 的成功与否决定文件级完成（守 Q1 拍板口径）。

**FTS-only（`--no-vector`）的口径**：文件级完成度只覆盖 dense 向量阶段。全文索引写入失败只体现在 `stats.errors` 与 `errors[]` 明细（关系标记 `ftsIndexComplete:false`），**不**产生 `partial` / `files.incomplete`，也**不**写未完成清单——修复后重新导入（幂等追加）即可。

**重试只处理未完成部分**（三端同源）：

```bash
# CLI：沿用上次导入记录的源目录与参数，只处理清单内文件
ki import --scope my-project --retry-incomplete

# 显式指定当前源目录（上次的目录已改名/移动时）
ki import --scope my-project --source /new/path/to/wiki --retry-incomplete
```

- CLI：`--retry-incomplete`；无清单 / 清单为空 / 记录的源目录已不存在时 fail-loud 并给出下一步。
- HTTP / Web：`POST /api/import/run` 接受可选 `onlyRelPaths: string[]`（相对源目录路径）。导入页在部分成功时显示「部分成功（完成 N / 未完成 M）」+ 清单 + 「重试未完成 M 篇」，**复用同一 `uploadId`**（暂存目录仍在服务端），不重新上传。
- 幂等保证：清单内文件此前的半成品向量已在上次失败时清理，重试不会产生 `_1` 副本、已完成文件的 `memoryId` 不变、**已完成文件的 chunk 不会被重新向量化**（不重复计费）。

因此：
- 首次导入用 `--group <name>` 建根
- 后续向同一 group 追加新文档，重复执行同命令即可
- 修改已有文档，重新导入即覆盖更新

### 数据模型（方案 D，REQ-20260807-001）

local KB 存**文件级原文**（一个文件一条，key=文件级 relation，basename 去扩展名）；relation-cache 文件级 relation 挂 **`memoryIds` 多值**（该文件全部 chunk 的向量 docId）；`sourcePath` 存文件路径（无 `#N`）。清洗只作用于**向量化输入**（local KB 保留原文，未被清洗）。

> `restore --rebuild-vector` 与此**同构**：读取 local KB 原文后走同一套清洗 + 切分（切分参数取 `group-index.source` 快照，缺失时回退 1000/150），按 chunk 级重建向量，因此 docId 与首次导入一致、可幂等重跑。

### 清洗

默认开启：内置规则（BOM/frontmatter/mermaid/代码块先剥→路径/空行折叠）→ 外部 hooks（config `scopes.<scope>.clean.hooks`，stdin→stdout 管道，超时 10s，失败跳过）。hook 全部失败 → 文件跳过 + local KB 回滚（P-7）。

### 格式与大小限制（REQ-08）

格式白名单默认 `.md`（config `scopes.<scope>.import.extensions`，非白名单跳过 + 汇总提示）；单文件上限默认 **1MB**（config `scopes.<scope>.import.maxFileSize`，超限跳过）；chunk 超限兜底 500。

### 中断防护（REQ-01/02）

导入捕获 SIGINT/SIGTERM 写中断标记；`SIGKILL`（kill -9）不可捕获由 probe residue 兜底（双路径）。中断后任意向量命令给出恢复引导（`ki restore <scope> --rebuild-vector` 或 `ki restore <scope> --from-snapshot --rebuild-vector`）；重建/成功导入后标记自动清除。并发导入拒绝（`import.lock`，残留自动清理）。

### 切分格式说明

- 固定长度切分（默认 1000 字符），overlap 150
- 段落边界优先：`\n\n` → `\n` → `。` → `；`
- 超大文件上限 1MB（config 可调）；单文件 chunk 上限 500
- 向量化 content 为**清洗后** chunk 文本；local KB 存**文件原文**（未清洗）

---

## 与其他文档的关系

- 错误与恢复建议：[`error-handling.md`](./error-handling.md)
- 完整工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
