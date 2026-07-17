---
id: REQ-20260717-001
feature: KiSearch基于zvec(Node)构建常驻MCP向量服务
status: 已确认
created: 2026-07-17
updated: 2026-07-17
version: 1
tags: [refactor, engine-swap, mcp, performance]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析：KiSearch 基于 zvec（Node）构建常驻 MCP 向量服务

## 0. 与前序需求的继承关系

- 前序需求 `REQ-20260716-001`（KiSearch 内聚 memory-lancedb-mcp 向量引擎）已 **`已取消`**，其决策文档 `decision-no-refactor.md` 选择 **Option B（保留 `mem` spawn 架构、不重构底层）**，前提是"KiSearch 是一次性 CLI，常驻复用收益为 0"。
- 该决策文档 **§5 明确列出推翻条件**：
  - (a) KiSearch 演进为**常驻 server / daemon**；
  - (b) 真实目标是**完全内包 / 控制引擎**（fork、单测、锁版本）。
- **本需求同时满足 (a)+(b)**：用户拍板 KiSearch 将作为**常驻 MCP 服务一直运行**，且底层引擎从 `memory-lancedb-pro`(lancedb) **替换为 `zvec`**。因此前序"不重构"决策的前提已失效，本需求为其**取代者（supersede）**，前序文档仅作历史保留。

## 1. 需求理解

### 1.1 需求形态（表层 → 本质）

- **表层**：把 KiSearch 的向量引擎从 `memory-lancedb-pro`(lancedb) 换成 `zvec`，并把 `ki` 的检索/写入能力以**常驻 MCP 服务**形态提供。
- **本质**：**彻底消灭 lancedb 的进程 spawn + 锁文件卡死 + 冷启动延迟痛点**，把向量引擎变成 KiSearch 自己**可控制、可单测、常驻复用**的内部能力。真实需求不是"再包一层 mem"，而是**换掉引擎内核 + 改为常驻服务**。

### 1.2 功能本质

KiSearch 的向量写入/查询，从"spawn `mem` CLI 再正则洗 stdout"（或 in-process 导入 memory-lancedb-pro）改为"常驻 Node 进程内直接调用 `@zvec/zvec` 的 Rust 引擎"，并以 MCP 协议对外暴露 `store`/`search`/`list`/`stats` 等工具。

### 1.3 已确认的三点决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 引擎 | **`zvec`**（`@zvec/zvec` 官方 Node 绑定，Rust 内核），替换 lancedb |
| 语言 | **Node/TypeScript**——`ki` 当前已是 Node 环境（`knowledge-indexer/bin/ki.mjs`），可复用现有代码，不重写 |
| 形态 | **常驻 MCP 服务（一直运行）**——消除每次 `ki search` 的 4s 冷启动 |

### 1.4 使用场景

- **场景 1（部署）**：`npm i` 后具备向量能力；引擎是 npm 依赖（非全局 `mem`），版本可锁。
- **场景 2（常驻）**：KiSearch 以 MCP server 常驻，多请求共享同一 zvec 实例与 embedding 连接池，无 per-call spawn。
- **场景 3（写入）**：`ki store` / `bulk_store` / `sync-relation` 走 zvec `insert`（带 metadata: tags/scope/doc_id）。
- **场景 4（查询）**：`ki search` / path 检索走 zvec 原生混合检索（dense + FTS），返回结构化结果。
- **场景关联性**：写入与查询共用同一常驻 zvec 实例（同 db 文件、同 scope/tag 空间），无双写冲突。

### 1.5 用户角色

- **KiSearch 开发者**（你）：负责集成 zvec、实现 MCP server、迁移现有逻辑。
- **终端用户 / Agent**：通过 MCP 协议或 `ki` 命令使用检索，受益于常驻低延迟、免装 `mem`、无 lancedb 锁。

### 1.6 核心痛点（驱动换引擎）

| 痛点 | 来源 | zvec 是否解决 |
|---|---|---|
| 每次 `ki search` 冷启动 ~4s（node 冷起 + 打开 lancedb + SiliconFlow 嵌入） | memory-lancedb-pro / `mem` CLI | ✅ 常驻进程，查询 <5ms |
| lancedb 锁文件导致 300s 卡死（demo 已证实） | lancedb | ✅ zvec 无此类文件锁 |
| `mem` 版本漂移让 KiSearch 静默失效 | 全局 `mem` CLI 依赖 | ✅ 引擎变为 npm 依赖，版本可锁 |
| Recall@1 仅 12.5%（长文档短查询排名靠后） | lancedb 加权融合 | ✅ zvec 实测 Recall@1 85% |

### 1.7 期望体验

`npm i` 即具备向量能力；常驻 MCP 服务下 `ki search` 毫秒级返回结构化结果；store 后直接拿回 id；无 shell 解析、无外部 `mem` 依赖、无锁卡死。

### 1.8 深层动机

把"向量引擎"从**外部不确定依赖（lancedb + 全局 mem）**变为**可锁版本、可单测、常驻复用的内部依赖**，同时**换用检索质量更高的引擎内核（zvec）**。

## 2. 非功能性需求

| 维度 | 需求 |
|---|---|
| 部署 | 引擎为 npm 依赖（`@zvec/zvec`），去除全局 `mem` 安装步骤 |
| 性能 | 常驻进程内查询 <5ms（基准实测 0.8ms 均值）；reopen/冷启动 <100ms（基准实测 ~50ms） |
| 检索质量 | Recall@5 ≥ 90%（基准实测 95%）；代码符号/函数名精确召回为刚需 |
| 形态 | 作为 MCP server 常驻，支持多请求共享 runtime |
| 兼容性 | 沿用 `ki` 现有 Node≥18 / ESM 约定；复用现有 embedding 配置与 SiliconFlow 调用 |
| 可用性 | 配置缺失/加载失败清晰报错；db 文件损坏可重建 |

## 3. 关键假设

| 假设 ID | 假设内容 | 验证难度 | 验证建议 |
|---|---|---|---|
| H-01 | `@zvec/zvec` Node 绑定提供 `insert` / `query` / 原生混合检索 / metadata 过滤接口，满足 KiSearch 语义 | 低 | 写最小 demo 调用 Node binding API 核对 |
| H-02 | zvec 持久化 db 文件可在"构建（ki store）"与"服务（MCP server）"间安全共享，或统一由 MCP server 持有 | 中 | 核对 zvec 文件锁/并发读写语义 |
| H-03 | zvec v0.5.0 原生 FTS 对**中文 + 代码符号（英文函数名/路径）**均有效；BM25 对中文弱，但 KiSearch 主场景为代码符号 | 中 | 用 bk-monitor wiki + 代码符号语料实测 |
| H-04 | Node binding 性能与 Python PoC 基准一致（同 Rust core） | 低 | Node 侧重跑相同 benchmark |
| H-05 | 现有 `mem-client.ts` 的 store/search 调用语义可映射到 zvec API，无需重写 ki 上层逻辑 | 中 | 对照现有 `mem-client.ts` 与 zvec API |

## 4. 关键背景（来自实测与源码调研）

### 4.1 引擎选型实证（2026-07-17 基准，真实 embedding）

- 语料：40 篇 bk-monitor wiki（中文，每篇截断 6000 字）
- Embedding：Qwen/Qwen3-Embedding-8B（SiliconFlow，4096 维，两引擎共用同一向量空间，公平对比）
- 评测：self-retrieval（用文档标题/首句查询，验证能否召回自身）

| 指标 | zvec | memory-lancedb-pro (`mem`) |
|---|---|---|
| 建库（创建+嵌+插+opt） | **8.3 s** | 24.5 s |
| 冷启动 reopen | **49.9 ms** | —（CLI 每次冷起） |
| 查询首条 | **3.6 ms** | 4.25 s |
| 查询平均 | **0.8 ms** | 4.08 s |
| Recall@1 | **85.0%** | 12.5% |
| Recall@3 | **92.5%** | 65.0% |
| Recall@5 | **95.0%** | 82.5% |

→ zvec 在延迟（~5000×）与召回质量（@1 约 7×）上全面胜出。

### 4.2 zvec 事实

- `alibaba/zvec`：嵌入式（进程内）向量数据库，Rust 内核，生产验证。
- 官方 Node 绑定 `@zvec/zvec`（npm）；官方 Python 绑定 `pip install zvec`。
- **v0.5.0（2026-06-12）起原生支持全文检索（FTS）+ 混合查询**——比 Python PoC 里"分别跑 vector/FTS 两路再 RRF 融合"更省事，Node 绑定可直接用原生混合检索。
- 混合检索 = 稠密向量 + 稀疏/BM25 + 标量过滤（tag/scope）。

### 4.3 `ki` 运行环境

- `ki` → `/root/.nvm/.../bin/ki` → `knowledge-indexer/bin/ki.mjs`（Node）。
- `knowledge-indexer/package.json` 为 Node/ESM 项目；现有 `mem-client.ts` 已封装 spawn `mem` 的逻辑，可改造为调用 zvec。
- 前序决策文档已记录 memory-lancedb-pro 的 lancedb 锁死、ACL 绕过、`Memory ID` 正则脆弱等痛点，本需求通过**换引擎**一并消除。

### 4.4 评测踩坑（务必规避，已写入参考文档）

基准过程中踩过的坑（详见 `reference/benchmark-zvec-vs-mem.md`）：
- `mem bulk-store` 缺 `scopes.default` 会静默存 0 → 与 zvec 无关，仅基线侧。
- SiliconFlow API 偶发抖动会让 `mem bulk-store` 整批静默存 0 → 入库需加重试+计数校验。
- `mem search` 配置参数用 `--config` 而非 `-c`，否则静默返回空。
- 检索阈值 `hardMinScore` 会把长文档短查询过滤掉，对比时需降到 0 隔离排序质量。

## 5. 正向需求清单草案

| 优先级 | 需求 ID | 需求描述 | 预期效果 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| P0 | REQ-01 | 引入 `@zvec/zvec` 为 npm 依赖，封装 zvec 引擎层（open/insert/query/hybrid/metadata-filter），替换 `mem-client.ts` 的 lancedb/`mem` 依赖 | KiSearch 不再依赖全局 `mem` / lancedb | — | `which mem` 缺失时 `ki store`/`ki search` 仍正常工作 |
| P0 | REQ-02 | 实现**常驻 MCP server**：启动即 open zvec db + 建 embedding 连接池，暴露 `store`/`search`/`list`/`stats` 等工具 | 多请求共享同一 runtime，查询毫秒级 | REQ-01 | MCP server 启动后，`search` 单次 <5ms（含 reopen 验证） |
| P0 | REQ-03 | Embedding 集成沿用 SiliconFlow Qwen3-Embedding-8B（4096 维），复用现有 embedding 配置与调用 | 向量空间与现有记忆体系一致 | REQ-01 | 缺 `apiKey` 时清晰报错 |
| P0 | REQ-04 | 原生混合检索：稠密向量 + FTS（zvec v0.5.0 原生），替换 Python PoC 的手动 RRF | 代码符号精确召回 + 语义召回兼顾 | REQ-01 | 代码符号查询精确命中（参考首轮 `syncRelation` demo） |
| P1 | REQ-05 | 三层标签 / scope 隔离（`ki-search`/`ki-path`/`ki-relation`）映射为 zvec metadata（tags/scope），检索用 metadata 过滤 | 向量空间隔离语义不丢失 | REQ-03 | 不同标签检索互不串扰 |
| P1 | REQ-06 | 写入流水线迁移：`ki store` / `bulk_store` / `sync-relation`(memoryId 回写) 基于 zvec `insert`（带 doc_id metadata） | 批量与回写能力不退化 | REQ-01 | 与现有 bulk-store 行为一致（ok/errors/skipped 汇总） |
| P1 | REQ-07 | 性能验收：Node 侧重跑 Python PoC 基准，确认 Recall@5≥90%、查询<5ms | 性能达标可量化 | REQ-02,REQ-04 | 输出对比报告，zvec 优于或等于基准 |
| P2 | REQ-08 | path-search 兜底：复用标签扫描/匹配逻辑（zvec metadata 检索）替代原 path 检索 | 路径兜底能力保留 | REQ-05 | 标签检索缺失时静默降级不报错 |
| P2 | REQ-09 | MCP 生命周期/监管：常驻保活、异常重启、db 损坏可重建 | 服务健壮性 | REQ-02 | 进程崩溃后自动恢复，不影响 `ki` 调用 |
| P2 | REQ-10 | 向后兼容：现有 `ki store`/`ki search` CLI 命令行为不变，仅底层换引擎 | 用户体验无缝 | REQ-01 | CLI 回归测试通过 |

## 6. 依赖图

```
REQ-01 → REQ-02 → REQ-04 → REQ-07
REQ-01 → REQ-03 → REQ-05 → REQ-06 / REQ-08
REQ-02 → REQ-09
REQ-01 → REQ-10
```

## 7. 下一步建议

1. 先核 H-01/H-04：写最小 Node demo 调用 `@zvec/zvec`，核对 `insert`/`query`/原生混合检索/metadata 过滤 API，并在 Node 侧重跑基准（REQ-07 前置）。
2. 确认需求清单后，进入 `work-breakdown` 拆工作项，或直接 `design-craft` 做技术设计（MCP server 架构、zvec 引擎层接口、db 文件共享策略）。
3. 参考 `reference/benchmark-zvec-vs-mem.md` 规避评测踩坑。
