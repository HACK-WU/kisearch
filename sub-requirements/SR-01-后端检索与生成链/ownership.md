# 文件所有权 · SR-01 后端检索与生成链

> 代码基线 code_base：`freeze/REQ-20260924-001`　｜　契约基线 contract_base：`freeze/REQ-20260924-001`　｜　批次：第 1 批
> 类型：新增型 + 挂载型

## 机器可读块（供预检脚本直接读取，**勿手抄进脚本**）

```yaml
slice: SR-01
branch: feat/sr-01-backend
code_base: freeze/REQ-20260924-001
contract_base: freeze/REQ-20260924-001
exclusive:
  - src/lib/chat/
  - src/lib/config.ts
  - src/lib/config-schema.ts
  - src/lib/mcp-http-api.ts
  - test/chat/contract-sr01.test.ts
  - test/chat/acceptance-sr01.test.ts
interface:
  - src/lib/chat/chat-contract.ts
  - src/lib/chat/chat-routes.ts
  - src/lib/chat/llm-client.ts
readonly:
  - src/search.ts
  - src/lib/store.ts
  - src/lib/wal.ts
  - src/lib/scope.ts
  - src/lib/operation-coordinator.ts
  - web/src/api/chatContract.ts
forbidden:
  - web/
  - test/chat/acceptance-sr02.test.ts
  - test/chat/contract-parity.test.ts
  - test/chat/data-flow.test.ts
  - .delivery/mocks/
```

## 1. 独占写（只有本窗口能改）

| 路径 | 说明 |
|------|------|
| `src/lib/chat/**` | **骨架期已生成全部桩**，本窗口填充实现（含 `retrieval/` 四个模块） |
| `src/lib/config.ts` | 新增 `LlmConfig` 段（**接线例外**，见 `design/cross-cutting.md` 三） |
| `src/lib/config-schema.ts` | 新增 llm 段校验（同上） |
| `src/lib/mcp-http-api.ts` | **只改挂载行**（已预留 `handleChatRoutes` 调用）——不得动既有 13 条路由分支 |
| `test/chat/contract-sr01.test.ts` | SR-01 契约测试（**不实现不会被改成绿的——改断言 = 违规**） |
| `test/chat/acceptance-sr01.test.ts` | SR-01 片级验收测试（断言由上游派生，**不得修改**） |

## 2. 只读（复用，改一字即拒收）

| 路径 | 复用什么 |
|------|---------|
| `src/search.ts` | `executeSearch()` —— **R18：检索必须复用，不新建链路** |
| `src/lib/store.ts` | `readJson` / `writeJson`（WAL 原子写） |
| `src/lib/wal.ts` | 跨进程文件锁 |
| `src/lib/scope.ts` | `validateScope` |
| `src/lib/operation-coordinator.ts` | `getSharedOperationCoordinator().submit()` —— 检索入队入口 |
| `web/src/api/chatContract.ts` | 前端契约副本（若发现形状不一致 → 报阻塞，**不自行改**） |

## 3. 禁碰（改了必冲突）

| 路径 | 归属 |
|------|------|
| `web/**` | **SR-02**（前端） |
| `test/chat/acceptance-sr02.test.ts` | SR-02 |
| `test/chat/contract-parity.test.ts` | 共享（骨架产出，双方只读） |
| `test/chat/data-flow.test.ts` | 共享（跨砖头，不归任何一片） |
| `.delivery/mocks/` | 脚手架（不应修改；需新 mock 场景 → 报阻塞） |

## 4. 越界了怎么办

| 情况 | 处理 |
|------|------|
| 发现必须改 `src/search.ts` 才能实现 | **停下来写阻塞**——它意味着 R18 的"复用"前提不成立，属设计问题，不在本窗口就地解决 |
| 发现必须改 `web/**` | 写阻塞（那是 SR-02 的独占区，即便只是"加个类型"） |
| 发现需要新 mock 场景 | 写阻塞（mock 属脚手架，由切片阶段统一生成） |
| 发现契约有缺口（缺字段 / 语义不明） | 写阻塞 → 批次边界回 `design-craft` 修订（**不得就地改契约**） |
