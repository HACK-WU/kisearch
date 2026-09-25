# SR-01 契约快照（`contract_base` = `{FROZEN}`）

> **本文件只声明"哪些面被冻结"，不复制内容**——内容以源文件为准，避免第三份真相。
> 冻结含义：实现期**只读**；改动须回 `design-craft` 并在批次边界统一修订。

## 1. 冻结的代码面

| 文件 | 冻结内容 |
|------|---------|
| `src/lib/chat/chat-contract.ts` | 全部：数据模型（`ChatMessage` / `ConversationFile` / `SourceRef` / `ConversationSummary`）、SSE 事件协议（11 类 + 顺序规则）、`ChatConfigOk`（含 4 个 v2 字段）、`CHAT_BUDGET`、错误码 |
| `web/src/api/chatContract.ts` | 前端副本（与上者形状一致，由 `test/chat/contract-parity.test.ts` 机械保证） |

## 2. 冻结的设计面

| 文档 | 冻结内容 |
|------|---------|
| `design/S07_检索与工具调用_DESIGN.md` | 工具 schema（3 参数）、检索 skill 正文、工具循环流程与 4 条硬约束、两种投影的字段、排队口径（§3.6）、降级路径（§3.7）、隐私确认（§3.8） |
| `design/S01_..._DESIGN.md` §9 | `LlmConfig` v2 字段、超时预算（300s / 30s）、`llm-client` 的工具支持契约 |
| `design/S02_..._DESIGN.md` §9 | `ChatMessage.sources`、4 个新接口的语义、原子截断伪代码 |
| `design/cross-cutting.md` | 横切约定（时区/精度/ID/分页/错误码前缀/日志/trace 决策）+ 权限矩阵 + P1–P7 越权用例 |
| `api/retrieval.md` | API-11~14 与 API-08 事件扩展的字段级契约 |
| `api/config.md` | API-01 的 4 个 v2 字段与 `resolveLlmStatus` 形状 |
| `api/INDEX.md` §1 | OperationCoordinator 的**分层口径**（CRUD 不入队 / 生成不入队 / **检索入队**） |

## 3. 冻结的骨架面

| 面 | 内容 |
|----|------|
| 挂载点 | `src/lib/mcp-http-api.ts` 的 `handleChatRoutes(req, res, url, ctx)` 调用签名；`ctx` 形状 `{ authScopes, configSnapshot, configPath? }` |
| 桩签名 | `chat-store.ts` / `llm-client.ts` / `chat-routes.ts` / `retrieval/*` 的**全部导出签名**（参数名可去掉 `_`，但**参数个数、类型、返回类型不变**） |
| 测试契约 | 4 个测试文件的**断言**（`contract-sr01` / `acceptance-sr01` / `contract-parity` / `data-flow`） |
| 脚手架 | `.delivery/mocks/*` 与 `.delivery/stub-pattern` |

## 4. 不是契约（可自由改动）

- 桩的**实现体**（`throw new Error('STUB:...')` → 真实实现）
- 桩内注释的措辞（语义不变即可）
- `src/lib/chat/` 下**新增**的内部私有文件（如 `retrieval/parse-args.ts`）——只要不改变已冻结的导出签名

## 5. 修订流程（**不在本窗口就地做**）

```text
发现契约缺口 → 写阻塞 → 当前批次结束 → 回 design-craft 改骨架
            → 更新 contract/BASE 与所有包的 contract_base → 下一批开工
```

**代价提示**：契约修订会让**受影响砖头已完成的实现作废重做**（不是"改个签名"）。
