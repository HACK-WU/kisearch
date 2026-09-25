# SR-02 契约快照（`contract_base` = `{FROZEN}`）

> 只声明"哪些面被冻结"，不复制内容（避免第三份真相）。冻结含义：实现期**只读**。

## 1. 冻结的代码面

| 文件 | 冻结内容 |
|------|---------|
| `web/src/api/chatContract.ts` | **字段形状**（`ChatMessage` / `ConversationFile` / `SourceRef` / `ChatEvent` / `ChatConfigOk` / `DEGRADED_LABELS`）——与 `src/lib/chat/chat-contract.ts` 一致，由 `contract-parity.test.ts` 机械保证 |
| `web/src/chat/chatStore.ts` | `ChatUiState` / `StreamingState` / `ChatAction` / `ChatStore` 的**类型形状**（实现可填，形状不可改） |
| `web/src/chat/format.ts` | 三个导出的**签名与语义**（`formatLineRange` / `DEGRADED_LABELS` / `sourceRefTitle`）——`acceptance-sr02.test.ts` 依赖它们 |
| `web/src/layouts/AppShell.tsx` | 挂载位**位置**（store 创建 / 顶部开关 / `<ChatPanel/>`）——不得移动或重构 |

## 2. 冻结的接口面（消费）

| 接口 | 契约 |
|------|------|
| `GET /api/chat/config` | `ChatConfigOk`（含 `supportsTools` / `retrievalEnabled` / `ackRequired` / `maxToolRounds`）；**未就绪时仍 200**（`enabled:false`） |
| `POST /api/chat/conversations/:id/messages` | SSE 事件流；**11 类事件**与顺序规则见 `chat-contract.ts` |
| `POST /api/chat/config/ack` | 幂等；`ack!==true` → 400 |
| `POST .../regenerate`、`PATCH .../messages/:msgId` | 语义见 `api/retrieval.md` §2/§3 |

> **`retrievalEnabled` 与 `supportsTools` 正交**（`retrievalEnabled = !ackRequired`）——前端最容易写错处，见 `api/config.md` 的对照表。

## 3. 冻结的测试面

| 文件 | 冻结 |
|------|------|
| `test/chat/acceptance-sr02.test.ts` | 全部断言（**不得修改**） |
| `test/chat/contract-parity.test.ts` | 共享，本窗口**必须让它保持绿** |
| `test/chat/data-flow.test.ts` | 共享（跨砖头），只跑不改 |

## 4. 不是契约（可自由改动）

- 组件内部实现（hooks 用法、CSS class、渲染结构）
- 桩的注释措辞
- `web/src/chat/` 下**新增**的内部私有文件（不改已冻结导出签名）

## 5. 修订流程（**不在本窗口就地做**）

```text
发现契约缺口 → 写阻塞 → 批次结束 → 回 design-craft → 更新 contract/BASE 与各包 contract_base → 下一批
```

**代价**：受影响砖头已完成实现作废重做。
