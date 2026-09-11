# 代码调研：按 scope 拆分 Zvec Collection

> 调研来源：项目记忆 ✓ | 资产复用（专家） ✓ | 代码搜索 ✓ | 语义检索 ✗（ki-search 本轮请求超时，已用现有记忆与代码核对）
> 调研范围：代码路径、架构模式、数据存储、跨模块影响、测试与迁移

## 1. 当前架构

- **现状**：KB 已按 `kb/{scope}` 物理隔离；向量层仍是 `config.vectorDir` 下固定名称 `kisearch` 的单 Collection，scope 仅作为 indexed scalar 字段过滤。
- **生命周期**：`src/lib/vector-client.ts` 用模块级 `_enginePromise` 管理单个 `ZvecEngine`；一个 `ZvecEngineProxy` 对应一个 worker 和一个 native Collection 句柄。
- **调用链**：CLI、MCP、导入、关系回写、检索均经 `vector-client`，适合在适配层集中做 scope 路由；当前 CLI 子进程不会复用 HTTP daemon。

## 2. 按 scope 拆分的改造点

- 将全局单例改为 `Map<scope, EngineEntry>`，为每个 scope 计算稳定路径（建议 `vectorDir/collections/{validated-scope}`），并为每个 scope 建立独立队列。
- `vectorSearch/vectorStore/vectorBulkStore/vectorDelete/vectorListDocs/vectorListTags/vectorCountScope/vectorDeleteScope/vectorFetchDocs` 都必须显式路由到目标 Collection；当前 `vectorFetchDocs(ids)` 无 scope 参数，需要补充 `(scope, ids)` 或先按 scope 分组。
- `vectorListScopes()` 从扫描全局文档字段改为枚举 Collection 目录并合并 KB/config 状态；`ensureVectorAvailable`、`closeEngine`、`health-check`、`doctor` 需支持单 scope 与全部 scope。
- 保持所有 Collection schema 版本一致；Collection 内可暂时保留 `scope` 字段用于迁移自检，但隔离主键改为 dbPath。

## 3. 检索与性能影响

- 当前多 scope 检索是单 Collection 的 scope-OR filter，并且 query embedding 只执行一次。
- Zvec 不支持跨 Collection 的 join/union/search；拆分后必须执行“每个 scope 查询 → 应用层合并/全局 top-k”。应先 embedding 一次，再向各 Collection 传预计算向量，避免 scope 数量放大 embedding 请求。
- 不同 scope 可在 daemon 内使用不同 worker/handle 并行；同一 scope 仍遵守 Zvec 单写者。多 scope 搜索需设置 fan-out 并发上限、候选 oversampling 和统一排序策略。
- Collection 数量较多时，常驻 worker、mmap、文件句柄和索引缓存会放大；建议按需打开、LRU/空闲回收，并记录打开/查询/排队耗时。

## 4. 数据、生命周期与迁移

- `group-index.json`、`relations-cache.json`、local KB、assets、wiki 回写已按 scope 隔离，数据模型基本可复用；但 memoryId 回写、删除和重建必须绑定同一个 scope handle。
- `scope delete` 可从“按 scope filter 删除文档”改为关闭并销毁对应 Collection；`clear --tags` 仍在该 Collection 内按 tag 删除。所有破坏性操作必须经过 daemon 的 scope 队列。
- 现有快照只包含 KB，向量通过 `rebuild-vector` 恢复。旧的单 Collection 位于 `vectorDir` 根，不能静默解释为新布局；需要显式迁移命令或显式重建，保留 memoryId 并校验 relations-cache。
- 建议新布局使用 `vectorDir/collections/{scope}`，让旧根 Collection 与新布局可并存；禁止迁移时自动覆盖或删除旧根数据。

## 5. 测试重点

- 不同 scope 的并行写入；同一 scope 的写写串行与数据守恒。
- 单 scope 查询、多 scope fan-out 查询、全局 top-k/排序与只做一次 embedding。
- scope 枚举、删除、清空、导入覆盖、关系回写、restore/rebuild-vector、备份恢复。
- 旧单 Collection → per-scope 迁移、重复迁移、失败重试、残留目录与 schema 版本不匹配。
- 资源上限：大量 scope 的 worker/mmap/文件句柄、LRU 回收与 daemon 重启后的锁释放。

## 6. 结论

按 scope 一 Collection 是可行的性能优化，但它优化的是**锁粒度和跨 scope 并行度**，不是同一 scope 的并行写入。若业务经常跨多个 scope 搜索，fan-out 和结果合并可能抵消收益；应先用真实 scope 数量、单 scope 写入比例和跨 scope 查询比例做基准，再决定是否进入设计阶段。

参考的现有资产：向量引擎专家、存储与配置基础专家、MCP 服务专家；详细子调研见同目录 `.codebuddy/task-dispatch/code-survey-scope-collections/subtasks/`。

外部参考：[Zvec 数据建模（明确不支持跨 Collection 查询）](https://zvec.org/en/docs/db/concepts/data-modeling/)、[Zvec 全局配置（查询线程数）](https://zvec.org/en/docs/db/config/)。
