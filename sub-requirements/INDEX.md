# 砖头索引与进度看板

> 需求：`REQ-20260924-001` Web 侧边栏 AI 对话模块
> 骨架基线（**冻结 commit**）：`{FROZEN}` ← **待骨架提交后填入**
> 契约基线 `contract_base`：`{FROZEN}`（= 骨架 commit；未修订时不变）
> 串行预估：**约 4 天**（粗估，本阶段给出）　｜　批次数：**1**
> 创建：2026-09-25

## 1. 批次表

| 批次 | 砖头 | 代码基线 `code_base` | 契约基线 `contract_base` | 状态 |
|:---:|---|---|---|---|
| 第 1 批 | SR-01 · SR-02 | `{FROZEN}`（单批 = 冻结点） | `{FROZEN}` | 待开工 |

> 单批次场景：`code_base` = `contract_base` = 冻结点 commit。
> 若未来分多批：第 N 批 `code_base` = 上一批合入后的 commit，`contract_base` 不变（见 `delivery-slicing` 阶段 3.2b）。

## 2. 进度看板

| 砖头 | 类型 | 独占写（前缀） | 状态 | 开工 | 完成 |
|------|------|--------------|:---:|:---:|:---:|
| **SR-01** 后端检索与生成链 | 新增型 + 挂载型 | `src/lib/chat/` · `src/lib/config.ts` · `src/lib/mcp-http-api.ts` · `test/chat/contract-sr01.test.ts` · `test/chat/acceptance-sr01.test.ts` | 待开始 | — | — |
| **SR-02** 前端对话面板 | 新增型 + 挂载型 | `web/src/chat/` · `web/src/api/chatApi.ts` · `web/src/api/chatContract.ts` · `web/src/layouts/AppShell.tsx` · `test/chat/acceptance-sr02.test.ts` | 待开始 | — | — |

> **并发写风险**：本表可能被覆盖——它是**可读看板不是权威来源**。权威状态在各包 `slice.md` 顶部的状态标记。批次边界**重扫各包 slice.md 重建本表**。

## 3. 时间戳（周期度量）

| 时点 | 日期 | 备注 |
|------|------|------|
| 需求确认 | 2026-09-24 | v7 |
| 设计修订（D13 后） | 2026-09-25 | S07 新增 + S01/S02/S03/S05 修订 + api 补 3 接口 |
| 并行判定 | 2026-09-25 | **3 条判据不过（边界放行）**，见 `design/parallel-decision.md` |
| 骨架生成 | 2026-09-25 | 11 项齐备；前后端 `tsc` 退出码 0 |
| 前置门① 验证 | 2026-09-25 | **通过**（长流 48.5s / 工具往返 3 轮），见 `design/gate1-verification.md` |
| 冻结点 | （待提交） | — |
| SR-01 完成 | — | — |
| SR-02 完成 | — | — |
| 拼接完成 | — | — |

**串行预估对照**：约 4 天（粗估）。拼接期按实际耗时对比，写入拼接报告「周期对比」节。

## 4. 允许依赖矩阵

**新砖头之间：零边**（互不 import）。

| 从 \ 到 | SR-01 | SR-02 |
|:---:|:---:|:---:|
| **SR-01** | — | ❌ |
| **SR-02** | ❌ | — |

> 两端靠**接口契约**解耦（`chat-contract.ts` 的形状 + SSE 事件协议），不靠代码依赖。
> SR-02 在 SR-01 未完成时用 `.delivery/mocks/mock-sse.mjs` 开发。

## 5. 共享只读资产（两片都不得修改）

| 资产 | 说明 |
|------|------|
| `src/lib/chat/chat-contract.ts` | 契约 SSOT（形状） |
| `web/src/api/chatContract.ts` | 前端契约副本（形状一致性由 `test/chat/contract-parity.test.ts` 保证） |
| `test/chat/contract-parity.test.ts` | 契约对齐测试 |
| `test/chat/data-flow.test.ts` | 数据走向预演（跨砖头，不归任何一片） |
| `.delivery/mocks/` | mock 套件（脚手架） |

## 6. 禁止事项

- 任一砖头**不得**修改另一砖头的独占写
- 任一砖头**不得**修改 `cross-cutting.md` 定稿的横切约定与权限模型（骨架期冻结）
- **不得修改片级验收测试的断言**（认为判据写错 → 写阻塞上报）
- 不得让生产代码引用 `.delivery/mocks/`
