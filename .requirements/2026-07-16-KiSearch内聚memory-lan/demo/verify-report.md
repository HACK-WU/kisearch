# Demo 验证报告 — KiSearch 内聚 memory-lancedb-mcp 向量引擎

- 关联需求：`REQ-20260716-001`（KiSearch 内聚 memory-lancedb-mcp 向量引擎）
- 验证日期：2026-07-16
- 验证环境：Node v22.22.2；`memory-lancedb-mcp`（本地源码，jiti 相对导入）+ `memory-lancedb-pro@1.1.0-beta.10`（github tag，与 mcp 锁版一致）
- 验证方式：进程内 `createMemoryRuntime()` → `runtime.callTool(...)`，使用用户提供的 SiliconFlow embedding 配置，`dbPath` 改为临时目录不污染 `~`。

## 风险点结论

| 编号 | 风险点 | 结论 | 依据 |
|---|---|---|---|
| R-01 | 进程内 `createMemoryRuntime()` + `callTool` 能否跑通（H-01 + H-04: @beta 接口兼容） | ✅ 通过 | 注册 11 个工具，store/recall/list/stats 全部成功返回结构化结果 |
| R-02 | SiliconFlow `Qwen/Qwen3-Embedding-8B`（4096-dim）能否真实拉向量并写入（H-02） | ✅ 通过 | 直接 `createEmbedder` 与经 `memory_store` 全链路均返回 4096 维向量并入库；recall 能召回 |
| R-03 | 三层标签 `ki-search/ki-path/ki-relation` + scope 隔离在进程内路径下是否生效（H-03） | ⚠️ 有条件通过 | 前缀注入 + scope 隔离均生效；但 mcp 标签过滤为「近似过滤」，需保留客户端后置过滤 |

## 详细验证结果

### R-01 ✅ 进程内集成（H-01 / H-04）
- `createMemoryRuntime({ config })` 在 0.26s 内完成：加载 `pro@1.1.0-beta.10`、注册 11 个工具、emit `gateway_start`。
- 已注册工具：`memory_recall, memory_store, memory_forget, memory_update, memory_stats, memory_list, memory_promote, memory_archive, memory_compact, memory_explain_rank, list_scopes`。
- `memory_store` / `memory_recall` / `memory_list` / `memory_stats` 均正常返回 `details` 结构化对象。
- **结论**：`register` / `callTool` 接口与 mcp 锁定的 `v1.1.0-beta.10` 完全兼容，H-04 通过（注：npm registry 最新发布版仅 `beta.9`，`beta.10` 仅存在于 github tag，与 mcp `package.json` 一致）。

### R-02 ✅ Embedding 配置（H-02）
- 直接用插件 `createEmbedder({ apiKey, model:"Qwen/Qwen3-Embedding-8B", baseURL:"https://api.siliconflow.cn/v1", dimensions:4096 })`：`embedPassage` / `embedQuery` 均返回 4096 维向量，`test()` 成功。
- 经 `memory_store` 全链路：SiliconFlow 实时拉向量并写入 lancedb，store 返回 `details.id`（UUID）。
- **结论**：用户 config.yaml 的 embedding 段可原样（略去 `requestDimensions` 等可选字段）透传给 mcp/runtime，KiSearch 无需自行持有 Embedder。H-02 通过。

### R-03 ⚠️ 三层标签 + scope（H-03）
- ✅ **标签前缀注入**：`tags:"ki-search"` 写入时文本被注入 `【标签:ki-search】 ` 前缀；`tags:"ki-path,ki-relation"` 正确解析为逗号列表并注入 `【标签:ki-path,ki-relation】`。
- ✅ **scope 隔离**：写入 `other-scope` 的记忆，在 `test-scope` 的 recall 中不被命中（无泄漏）。
- ⚠️ **标签过滤为近似过滤**：按 `tags:"ki-search"` 召回时，除了命中 `ki-search` 目标条目，还**混入 1 条不含该前缀的额外条目**（`ki-path,ki-relation` 那条）。mcp 的标签过滤是 best-effort 预过滤，并非严格硬过滤。
  - **对 KiSearch 的启示**：必须**保留客户端 `content.includes('【标签:X】')` 后置过滤**——这与现有 `mem-client.ts:170` 的做法完全一致，重构时不可删除。

## 验证中新发现的关键集成契约与风险

1. **【集成契约】跨 scope 模式必须带 `agentId:"system"`**：在 `createMemoryRuntime()` 未设 `options.scope` 时，对「显式传 scope 的 write/read」调用，mcp **不会自动注入** `agentId:"system"`，而是透传调用方 ctx；scope 的 ACL（`acl:["global", <scope>]`）不包含默认 agent `"main"`，导致 `Access denied to scope: <x>`。所有 `callTool(name, params, { agentId:"system" })` 必须显式带该系统绕过上下文（与需求文档 §4 记载一致）。

2. **【运维风险·严重】lancedb 残留锁文件会导致后续运行永久挂死**：前几次验证中出现 300s 卡死，根因是**上一次被强杀的进程残留了 lancedb proper-lockfile 锁**，使后续 `table.add` 死锁。清掉 `dbPath` 目录后秒通（总耗时 ~1.1s）。KiSearch 上线后必须：
   - 保证进程优雅退出（释放锁）；
   - 启动时检测并清理 stale lock，或捕获 lock 超时给出清晰报错，避免用户侧「静默挂死」。

3. **【版本】** npm 公开版仅 `beta.9`；`beta.10` 须从 github tag 安装（`memory-lancedb-pro@github:CortexReach/memory-lancedb-pro#v1.1.0-beta.10`）。KiSearch 依赖 mcp 后，由 mcp 的 `package.json` 决定 pro 版本，无需 KiSearch 直接锁。

## 整体决策

- R-01、R-02：**通过**，可直接进入完整开发。
- R-03：**有条件通过**，开发时需保留「客户端标签后置过滤」（现有代码已有，勿删）。
- 两项新增风险（agentId 绕过契约、lancedb 锁死）已记录，须在 `design-craft` / 实现阶段纳入：

| 待办 | 类型 | 落地建议 |
|---|---|---|
| 所有 tool 调用带 `{ agentId:"system" }` | 集成契约 | 封装 `memStore/memSearch` 时统一注入，对应需求 REQ-01/02 |
| lancedb 锁清理 / 启动检测 | 运维健壮性 | 对应需求 REQ-08（可用性检测与降级）增加 lock 检测 |
| 保留客户端标签后置过滤 | 兼容性 | 对应需求 REQ-04，沿用 `mem-client.ts` 的 `includes('【标签:X】')` |

## 复现方式

```bash
# 依赖（不污染 package.json）
npm install --no-save --no-audit --no-fund \
  yaml "memory-lancedb-pro@github:CortexReach/memory-lancedb-pro#v1.1.0-beta.10"

# 运行验证
rm -rf /tmp/ki-demo-lancedb
timeout -s KILL 90 node_modules/.bin/jiti .demo-verify/verify.ts 2>&1
```

> 注：`.demo-verify/` 为临时原型目录，验证完成后已迁移至本 `demo/` 目录并删除。
