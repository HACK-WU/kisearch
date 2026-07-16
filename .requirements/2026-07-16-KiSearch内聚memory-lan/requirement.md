---
id: REQ-20260716-001
feature: KiSearch内聚memory-lancedb-mcp向量引擎
status: 已确认
created: 2026-07-16
updated: 2026-07-16
version: 1
tags: [refactor, integration]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析：KiSearch 内聚 memory-lancedb-mcp 向量引擎

## 1. 需求理解

### 1.1 需求形态（表层 → 本质）

- **表层**：把 KiSearch 的底层向量引擎从「外部 `mem` CLI 进程」换成「直接 `import memory-lancedb-pro` 这个 npm 包」。
- **本质**：**消灭对外部 `mem` CLI 进程的部署与运行期依赖**——把"装一个全局命令并 spawn 它"变成"装一个 npm 包并 import 它"。真实需求不是换引擎算法，而是**把向量化/检索能力内聚进 KiSearch 进程**。

### 1.2 功能本质

KiSearch 的向量写入/查询，从"跨进程调用 `mem` 命令并解析其 stdout"改为"进程内调用 `memory-lancedb-mcp` 的 `createMemoryRuntime()` → `runtime.callTool(...)`"。

### 1.3 已确认的两点决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 壳子形态 | **(b)** 直接把 `memory-lancedb-mcp` 作为依赖，调用其已封装好的 `createMemoryRuntime()`；不自行仿写 `FakeOpenClawApi` |
| Embedder 配置 | 沿用并简化 mem 的 `config.yaml`（embedding 段），KiSearch 自己持有 Embedder 并透传 |

### 1.4 使用场景

- **场景 1（部署）**：CI/用户 `npm i` 后开箱即用，**不再需要**单独执行 `install-latest.sh` 或 `npm i -g @anthropic/mem` 全局装壳。
- **场景 2（写入）**：KiSearch 跑 `ki store` / `bulk_store` / `sync-relation`，原流程 spawn `mem store`，新流程走 `runtime.callTool("memory_store")`。
- **场景 3（查询）**：`ki search` / path 检索，原流程 spawn `mem search` 再正则洗 stdout，新流程走 `runtime.callTool("memory_recall" | "memory_list")`，直接吃结构化 `details`。
- **场景关联性**：写入与查询共用同一个 `createMemoryRuntime()` 实例（同 config、同 scope/标签空间），互斥于旧 spawn 路径——重构期必须**两条路径不能同时存在**，否则双写会冲突。

### 1.5 用户角色

- **KiSearch 开发者**（你）：负责重构、配置、测试。
- **终端用户**：使用 KiSearch 命令的人，受益于免装 `mem`、开箱即用。

### 1.6 核心痛点

当前 `mem-client.ts` 对全局 `mem` CLI 的安装状态、PATH、stdout 格式高度耦合：
- `buildEnhancedPath` 注入 nvm / homebrew / npm 路径；
- `/Memory ID:\s*(\S+)/` 正则提取 ID（该字符串来自 `mem` 的 `cli.ts:455` 的 `console.log("Memory ID: ...")`）；
- `{details:{memories}}` / `{results}` 多格式兼容。

任何一处 `mem` 版本漂移都会让 KiSearch **静默失效**。

### 1.7 期望体验

`npm i` 即具备向量能力；store 后直接拿回 `details.id`，search 直接拿结构化结果，无 shell 解析黑魔法。

### 1.8 深层动机

把"向量引擎"从**外部不确定依赖**变为**可锁版本、可 tree-shake、可单测的内部依赖**，提升可维护性与部署确定性。

## 2. 非功能性需求

| 维度 | 需求 |
|---|---|
| 部署 | 去掉全局 `mem` 安装步骤，纯 npm 依赖 |
| 性能 | 去掉每次操作的进程 spawn + stdout 序列化开销（in-process 调用） |
| 兼容性 | 沿用 `memory-lancedb-mcp` 的 Node≥18 / ESM 约定 |
| 可用性 | 配置缺失/加载失败时给出清晰报错（复用 mcp 的 `loadPlugin` 失败提示） |

## 3. 关键假设

| 假设 ID | 假设内容 | 验证难度 | 验证建议 |
|---|---|---|---|
| H-01 | `memory-lancedb-mcp` 的 `createMemoryRuntime` 暴露的 `callTool("memory_store"\|"memory_recall"\|"memory_list"\|"memory_forget")` 接口与 KiSearch 现有调用语义对齐 | 低 | 对照 `cli.ts` 的调用名与 `mem-client.ts` 的现有语义 |
| H-02 | Embedder 配置可照搬 mem 的 `config.yaml`（embedding 段）简化而来，KiSearch 只需持有并透传 | 低 | 比对 `config.ts` 的 `MemConfig.embedding` 与 KiSearch 现有 config |
| H-03 | 三层标签 `ki-search`/`ki-path`/`ki-relation` 映射到 memory-lancedb-pro 的 `scope` 或 `tags` 前缀，不丢失隔离语义 | 中 | 核对 mcp 的 `normalizeTags` + 前缀注入逻辑能否直接复用 |
| H-04 | 最新版 `memory-lancedb-pro@beta` 的 `register`/`createMemoryRuntime` 接口与 mcp 锁定的 `v1.1.0-beta.10` 兼容 | 中 | 拉取 @beta 入口核对 API 差异 |

> ⚠️ 重点待核：H-03（标签/scope 映射方式）与 H-04（@beta 接口兼容性）。建议在进入 `design-craft` 前先拉取 `@beta` 源码核对接口差异。

## 4. 关键背景（来自源码调研）

- `memory-lancedb-mcp` 是 `mem` 命令的实现壳子，已把 `memory-lancedb-pro@v1.1.0-beta.10` 包成可 import 的库（不是 spawn CLI）。
- 其 `index.ts` 用 jiti 直接 `import "memory-lancedb-pro"` 取 `plugin.register(api)`，再用 `FakeOpenClawApi` 模拟 OpenClaw 运行时，把 14 个工具捕获到内存；最终通过 `api.emitEvent("gateway_start")` + `api.callTool(...)` 读写记忆。
- 写操作统一传 `{agentId:"system"}` 绕过 ACL；store 无 scope 时回退 `config.scopes.default`（默认 `global`）。这是三层标签映射到 scope 时必须保留的语义。
- mcp 的 `index.ts:320-322` 已验证：store 时把 `【标签:...】` 前缀拼进 text，检索时用 BM25 召回。本重构可直接复用 `normalizeTags` + 前缀注入逻辑，不必重新发明。
- KiSearch 当前 `package.json:50` 写死 `memory-lancedb-pro#v1.1.0-beta.10`；重构按用户要求改装 `memory-lancedb-pro@beta`（最新）。

## 5. 正向需求清单草案

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| P0 | REQ-01 | 引入 `memory-lancedb-mcp` 为 npm 依赖，用 `createMemoryRuntime()` 替换 `mem-client.ts` 的 spawn 调用，封装 `memStore`/`memSearch`/`memList`/`memForget` | KiSearch 不再依赖全局 `mem` 进程 | — | `which mem` 缺失时 `ki store`/`ki search` 仍正常工作 |
| P0 | REQ-02 | 删除 `mem-client.ts` 的 stdout 解析：`Memory ID` 正则、bulk `ok/errors/skipped`、search 双格式兼容，改为直接消费 `runtime.callTool` 返回的 `details` | 去掉所有 shell 输出耦合 | REQ-01 | 单测覆盖 store 拿回 id、search 拿回结构化结果 |
| P0 | REQ-03 | Embedder/连接配置管理：沿用并简化 mem 的 `config.yaml`（embedding 段），启动时加载并传给 `createMemoryRuntime` | 配置链路从"给 mem 用"变为"给 runtime 用" | REQ-01 | 缺失 `apiKey` 时给出与 mcp 一致的清晰报错 |
| P1 | REQ-04 | 保留三层标签与 scope 隔离：store 拼 `【标签:...】` 前缀进 text，search 用 tags 过滤，复用 mcp 的 `normalizeTags` | 向量空间隔离语义不丢失 | REQ-03 | 不同标签/scope 检索互不串扰 |
| P1 | REQ-05 | 批量写入：将现有写临时 JSON + `mem bulk-store` 改为基于 `runtime.callTool("memory_store")` 的串行/批量循环，保留 ok/errors/skipped 汇总 | 批量能力不退化 | REQ-01 | 与现有 bulk-store 行为一致（含 `--stop-on-error`/`--dry-run`） |
| P1 | REQ-06 | 异步双写 + `memoryId` 回写（sync-relation）：改为 `runtime.callTool` 异步触发并回写 `memoryId` | sync-relation 行为不变 | REQ-01 | 回写后本地索引含 `memoryId` |
| P2 | REQ-07 | path-search 兜底：复用 mcp 的 tag 扫描/匹配逻辑（0.75 阈值、静默降级）替代原 path 检索 | 路径兜底能力保留 | REQ-04 | 标签检索缺失时静默降级不报错 |
| P2 | REQ-08 | 可用性检测与降级：移除对 `mem` CLI 的检测，改为检测 `memory-lancedb-mcp` 可加载 / `createMemoryRuntime` 可创建 | 启动健壮性保持 | REQ-01 | 依赖缺失时明确提示 `npm i memory-lancedb-mcp` |

## 6. 依赖图

```
REQ-01 → REQ-02
REQ-01 → REQ-03 → REQ-04 → REQ-05 / REQ-06 / REQ-07
REQ-01 → REQ-05 / REQ-06 / REQ-08
```

## 7. 下一步建议

1. 先核 H-04：拉取 `memory-lancedb-pro@beta` 入口，核对 `register` / `createMemoryRuntime` 接口差异（影响 H-03 标签/scope 映射实现）。
2. 确认需求清单后，进入 `work-breakdown` 拆工作项，或直接 `design-craft` 做技术设计。
