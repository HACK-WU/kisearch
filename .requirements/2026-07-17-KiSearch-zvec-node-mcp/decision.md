# 决策记录：KiSearch 采用 zvec（Node）+ 常驻 MCP 服务

- 关联需求：REQ-20260717-001（KiSearch 基于 zvec(Node) 构建常驻 MCP 向量服务）
- 决策日期：2026-07-17
- 决策状态：**已拍板（换引擎 + 常驻 MCP）**
- 取代对象：REQ-20260716-001（已取消）及其决策 `decision-no-refactor.md` 的 Option B

---

## 1. 决策结论

**放弃前序"不重构底层、沿用 mem"的 Option B，改为：(1) 引擎内核从 `memory-lancedb-pro`(lancedb) 换成 `zvec`；(2) 以 Node 实现；(3) 形态为常驻 MCP 服务。**

---

## 2. 为什么推翻前序决策（触发其 §5 条件）

前序 `decision-no-refactor.md` §5 明列"唯一会推翻本决策的条件"：
- (a) KiSearch 明确演进为**常驻 server / daemon**；
- (b) 真实目标是**完全内包 / 控制引擎**（fork、单测、锁版本、tree-shake）。

**本决策同时满足 (a)+(b)**：
- (a) 用户拍板 KiSearch 作为 **MCP 服务一直运行**——spawn 开销与 runtime 复用从"无所谓"变为"核心瓶颈"，Option B 的"一次性 CLI 收益为 0"前提崩塌；
- (b) 引擎从 lancedb **换成 zvec**——这正是"完全内包 / 控制引擎"的意愿表达。

⇒ 前序决策的前提已失效，新需求 `REQ-20260717-001` 为其合法取代者。

---

## 3. 关键事实（决策依据）

### 3.1 引擎实证对比（2026-07-17 基准，共用 Qwen3-Embedding-8B / 4096 维）

| 指标 | zvec | memory-lancedb-pro (`mem`) | 结论 |
|---|---|---|---|
| 建库 | 8.3 s | 24.5 s | zvec 快 ~3× |
| 查询平均 | 0.8 ms | 4.08 s | zvec 快 ~5000× |
| Recall@1 | 85% | 12.5% | zvec 高 ~7× |
| Recall@5 | 95% | 82.5% | zvec 更优 |

### 3.2 常驻形态消除冷启动

`mem search` 的 4s 主因是每次冷启动 node + 打开 lancedb + 调 SiliconFlow 嵌入。常驻 MCP 进程内查询 <1ms（基准实测），冷启动仅发生在服务启动一次（reopen ~50ms）。

### 3.3 zvec 事实

- Rust 内核嵌入式向量库，`@zvec/zvec` 官方 Node 绑定（npm）。
- v0.5.0 起**原生支持 FTS + 混合查询**，无需像 Python PoC 那样手动 RRF 两路融合。
- 无 lancedb 式文件锁，规避前序 demo 已证实的 300s 锁死风险。

### 3.4 语言选择 = Node

`ki` 当前即 Node 环境（`knowledge-indexer/bin/ki.mjs`），可复用现有 `mem-client.ts` 上层逻辑，仅需替换引擎层，不重写代码。zvec 引擎质量与语言无关（同 Rust core），故 Node 在"零重写 + 生态匹配（OpenClaw/Claude Code 均为 Node）"上胜出。

---

## 4. 收益对比（相对前序 Option B）

| 目标收益 | Option B（沿用 mem） | 本决策（zvec + Node MCP） |
|---|---|---|
| 免全局 `mem` 安装 | ✅（本地 bin） | ✅（npm 依赖） |
| 去 spawn 冷启动（4s→ms） | ❌（一次性 CLI 固有） | ✅（常驻进程） |
| 换用更优引擎（Recall@1 85%） | ❌（仍是 lancedb 12.5%） | ✅ |
| 去 lancedb 锁死风险 | ❌（锁在子进程仍偶发） | ✅（zvec 无此锁） |
| 常驻复用 runtime | ❌ | ✅ |
| 引擎可锁版本 / 单测 / 内包 | ❌ | ✅ |

---

## 5. 主要风险与对策

| 风险 | 对策 |
|---|---|
| `@zvec/zvec` Node API 与预期不符（H-01） | 先写最小 Node demo 核对 API 再设计 |
| zvec db 文件在"构建/服务"间共享的并发语义（H-02） | 由常驻 MCP server 统一持有 db，CLI 写入走 MCP 或独占模式 |
| 中文 FTS 弱（BM25 对中文不友好） | KiSearch 主场景为代码符号（英文），中文走向量；实测验证 |
| 现有 `mem-client.ts` 语义映射成本（H-05） | 仅替换引擎层，保留 ki 上层命令与标签语义 |

---

## 6. 落地动作（下一步）

1. Node 最小 demo 接通 `@zvec/zvec`，核对 `insert`/`query`/原生混合/metadata 过滤；
2. Node 侧重跑 Python PoC 基准（REQ-07 验收）；
3. `design-craft` 技术设计：MCP server 常驻架构、zvec 引擎层接口、db 文件共享策略；
4. 迁移 `mem-client.ts` → zvec 引擎层，保持 `ki store`/`ki search` CLI 行为不变。

---

## 7. 关联产物

- 需求文档：`requirement.md`
- 基准实证：`reference/benchmark-zvec-vs-mem.md`
- 历史（已取代）：`../2026-07-16-KiSearch内聚memory-lan/`（REQ-20260716-001，已取消）
